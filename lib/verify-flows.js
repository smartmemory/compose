/**
 * lib/verify-flows.js — COMP-VERIFY-FLOW-1: a project can prove a user flow
 * before a feature is called done.
 *
 * A project declares flows in `.compose/compose.json` `verify.flows[]`
 * (contracts/verify-config.schema.json). A flow is the project's own command:
 * it starts the app, drives it the way a user does, prints what it saw, and
 * cleans up. Compose ships no browser driver and no exploring agent; it runs
 * the command and judges the output.
 *
 * The incidents it exists for: a pipeline edit that lost all 62 dependency
 * edges on save and reload (I17), and a builder Save that missed an edit
 * committed on blur (I18). Both passed their unit tests; only the user's own
 * sequence (open, edit, save, reload) showed the defect.
 *
 * The pass rule (judgeRun) is deliberately two-sided: exit 0 AND every
 * `expect` line present as a whole stdout line. The expected lines are the
 * answer; an exit code alone never passes a flow, and a failing exit never
 * passes one either. Three refusal codes, worded differently on purpose so
 * nobody fixes product code for a setup problem:
 *
 *   FLOW_FAILED       the flow ran and the product gave the wrong answer
 *   FLOW_SETUP_ERROR  the flow could not start (spawn error, or an exit code
 *                     in `setup_exit_codes`, default [127]); nothing was tested
 *   FLOW_TIMEOUT      the flow ran past `timeout_s`; its whole process group
 *                     (the server it started included) was killed
 *
 * Each flow runs in its own process group (spawn `detached`), so a timeout
 * kills the group, not just the leader, and leftovers of a flow that exited
 * without cleaning up are terminated too (with a WARNING line in its log: a
 * flow that leaks a server is a flow bug worth seeing, not a silent fix).
 *
 * Every run writes one log under `.compose/data/verify/<feature>/` and one line
 * to `runs.jsonl` beside it. A PASS also mints a `command` receipt in the
 * evidence store (lib/evidence.js recordEvidence, kind `command`): its
 * `output_line` is the last matched expect line and its `log` the run's log, so
 * the id re-verifies against the machine like every other receipt.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { readComposeJson } from './compose-json.js';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

import { evidenceStorePath, recordEvidence, verifyEvidence } from './evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERIFY_SCHEMA_PATH = path.resolve(__dirname, '../contracts/verify-config.schema.json');

export const VERIFY_CODES = Object.freeze({
  FAILED: 'FLOW_FAILED',
  SETUP: 'FLOW_SETUP_ERROR',
  TIMEOUT: 'FLOW_TIMEOUT',
  CONFIG: 'VERIFY_CONFIG_INVALID',
});

export const DEFAULT_TIMEOUT_S = 600;
export const DEFAULT_SETUP_EXIT_CODES = Object.freeze([127]);
/** After SIGTERM to a flow's group, how long before SIGKILL. */
export const KILL_GRACE_MS = 3000;
/** After the leader exits and the group is gone, how long to wait for the pipes to drain. */
const DRAIN_MS = 2000;
/** Largest stdout kept in memory for judging (the log holds everything). */
const MAX_JUDGE_BYTES = 32 * 1024 * 1024;
/** The folder for runs that are not bound to a feature (`compose verify` with no --feature). */
export const ADHOC_DIR = '_adhoc';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class VerifyConfigError extends Error {
  constructor(errors) {
    super(`${VERIFY_CODES.CONFIG}: ${errors.join('; ')}`);
    this.code = VERIFY_CODES.CONFIG;
    this.errors = errors;
  }
}

let _validate = null;
function validator() {
  if (!_validate) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    _validate = ajv.compile(JSON.parse(readFileSync(VERIFY_SCHEMA_PATH, 'utf8')));
  }
  return _validate;
}

/** `/flows/0/command` → `verify.flows[0].command`. */
function fieldName(instancePath) {
  return 'verify' + instancePath.split('/').slice(1)
    .map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`)).join('');
}

/**
 * Validate a `verify` block against the contract. Every error names its field.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateVerifyBlock(block) {
  const v = validator();
  const errors = [];
  if (!v(block)) {
    for (const e of v.errors || []) {
      const at = fieldName(e.instancePath || '');
      if (e.keyword === 'additionalProperties') errors.push(`${at} has unknown field "${e.params.additionalProperty}"`);
      else if (e.keyword === 'required') errors.push(`${at} is missing required field "${e.params.missingProperty}"`);
      else errors.push(`${at} ${e.message}`);
    }
  } else {
    const seen = new Set();
    (block.flows ?? []).forEach((f, i) => {
      if (seen.has(f.id)) errors.push(`verify.flows[${i}].id "${f.id}" is declared twice`);
      seen.add(f.id);
    });
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * The project's declared flows, with defaults filled, or null when
 * `.compose/compose.json` has no `verify` block (or no config file at all): opt-in
 * means no block, no behaviour. A file that exists but is not valid JSON throws.
 * A block that is present but invalid THROWS VerifyConfigError: a broken
 * declaration is never silently read as "no flows".
 */
export function loadVerifyConfig(workspaceRoot) {
  // P-2: an absent file is "no flows"; a file that exists but cannot be parsed is a
  // refusal naming the file, never "no flows" (that silently turned the gate off).
  let cfg;
  try {
    cfg = readComposeJson(workspaceRoot);
  } catch (err) {
    throw new VerifyConfigError([err.message]);
  }
  if (!cfg || cfg.verify === undefined) return null;
  const { ok, errors } = validateVerifyBlock(cfg.verify);
  if (!ok) throw new VerifyConfigError(errors);
  // A block holding only `preflight` (COMP-SETUP-PREFLIGHT-1) declares no flows:
  // the same as no block. Validated first, so a misspelled `flow` key is refused
  // (additionalProperties) rather than read as "no flows".
  if (cfg.verify.flows === undefined) return null;
  return {
    flows: cfg.verify.flows.map((f) => ({
      ...f,
      timeout_s: f.timeout_s ?? DEFAULT_TIMEOUT_S,
      setup_exit_codes: f.setup_exit_codes ?? [...DEFAULT_SETUP_EXIT_CODES],
    })),
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** A repo-relative glob as a RegExp: `**` any depth, `*` one segment, `?` one character. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob, file) {
  return globToRegExp(glob).test(file.replace(/^\.\//, ''));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Which flows a completion runs. No changed-file list (absent or empty): all of
 * them, because Compose cannot tell which are touched, and the line says so.
 * @returns {{flows: object[], mode: 'all'|'covered'|'none', line: string}}
 */
export function selectFlows(flows, filesChanged) {
  const n = flows.length;
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) {
    return { flows, mode: 'all', line: `verify: no changed-file list, running all ${plural(n, 'declared flow')}` };
  }
  const m = filesChanged.length;
  const chosen = flows.filter((f) => filesChanged.some((p) => f.covers.some((g) => matchGlob(g, p))));
  if (chosen.length === 0) {
    return { flows: [], mode: 'none', line: `verify: no declared flow covers the ${plural(m, 'changed file')}` };
  }
  return {
    flows: chosen, mode: 'covered',
    line: `verify: ${chosen.length} of ${plural(n, 'declared flow')} cover the ${plural(m, 'changed file')}: ${chosen.map((f) => f.id).join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Judging (pure)
// ---------------------------------------------------------------------------

const firstLine = (text) => (text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;

/** The stdout line nearest a missing expected line: same text up to its last word (`EDGES build 18` → `EDGES build 0`). */
function nearestLine(lines, expected) {
  const cut = expected.lastIndexOf(' ');
  if (cut <= 0) return null;
  const stem = expected.slice(0, cut + 1);
  return lines.find((l) => l.startsWith(stem)) ?? null;
}

/**
 * Decide one run. Pure: everything it needs is in `run`.
 * @param {{exitCode: number|null, signal: string|null, timedOut: boolean, spawnError: string|null, stdout: string, stderr: string, durationMs?: number}} run
 * @param {{id: string, expect: string[], timeout_s: number, setup_exit_codes: number[]}} flow
 * @returns {{verdict: 'PASS'|'FAIL', code: string|null, matched: string[], missing: string[], nearest: string|null, detail: string}}
 */
export function judgeRun(run, flow) {
  const lines = (run.stdout || '').split(/\r?\n/).map((l) => l.trim());
  const have = new Set(lines);
  const matched = flow.expect.filter((e) => have.has(e.trim()));
  const missing = flow.expect.filter((e) => !have.has(e.trim()));
  const base = { matched, missing, nearest: null };
  const setupCodes = flow.setup_exit_codes ?? DEFAULT_SETUP_EXIT_CODES;

  if (run.spawnError) {
    return { ...base, verdict: 'FAIL', code: VERIFY_CODES.SETUP, detail: `the flow could not start: ${run.spawnError}` };
  }
  if (run.timedOut) {
    return { ...base, verdict: 'FAIL', code: VERIFY_CODES.TIMEOUT, detail: `ran past ${flow.timeout_s} s; its process group was killed` };
  }
  if (run.exitCode !== null && setupCodes.includes(run.exitCode)) {
    const why = firstLine(run.stderr) ?? firstLine(run.stdout) ?? '(no output)';
    return { ...base, verdict: 'FAIL', code: VERIFY_CODES.SETUP, detail: `the flow could not start (exit ${run.exitCode}): ${why}` };
  }
  if (run.exitCode === 0 && missing.length === 0) {
    return { ...base, verdict: 'PASS', code: null, detail: `${matched.length} of ${flow.expect.length} expected lines` };
  }
  const exit = run.exitCode === null ? `killed by ${run.signal}` : `exit ${run.exitCode}`;
  if (missing.length === 0) {
    return { ...base, verdict: 'FAIL', code: VERIFY_CODES.FAILED,
      detail: `${exit} with all ${flow.expect.length} expected lines present: a failing exit is never a pass` };
  }
  const nearest = nearestLine(lines.filter(Boolean), missing[0]);
  return {
    ...base, nearest, verdict: 'FAIL', code: VERIFY_CODES.FAILED,
    detail: `missing expected line ${JSON.stringify(missing[0])}`
      + (nearest ? ` (output had ${JSON.stringify(nearest)})` : '')
      + (missing.length > 1 ? `, ${missing.length - 1} more missing` : '')
      + `, ${exit}`,
  };
}

/**
 * The one-line refusal reason a completion prints, code first so the kind of
 * failure is the first word anyone reads.
 */
export function refusalReason(r) {
  if (r.code === VERIFY_CODES.TIMEOUT) return `${VERIFY_CODES.TIMEOUT} ${r.id} after ${r.timeout_s} s: its process group was killed; log ${r.log}`;
  if (r.code === VERIFY_CODES.SETUP) return `${VERIFY_CODES.SETUP} ${r.id}: setup problem, nothing was tested (${r.detail}); log ${r.log}`;
  return `${VERIFY_CODES.FAILED} ${r.id}: ${r.detail}; log ${r.log}`;
}

/** Human lines for one result (CLI). */
export function describeResult(r) {
  const out = [];
  if (r.verdict === 'PASS') out.push(`PASS ${r.id} (${r.detail})${r.evidence_id ? ` ${r.evidence_id}` : ''}`);
  else if (r.code === VERIFY_CODES.SETUP) out.push(`SETUP-ERROR ${r.id}: ${VERIFY_CODES.SETUP}, nothing was tested: ${r.detail}`);
  else if (r.code === VERIFY_CODES.TIMEOUT) out.push(`TIMEOUT ${r.id}: ${VERIFY_CODES.TIMEOUT} ${r.id} after ${r.timeout_s} s, its process group was killed`);
  else out.push(`FAIL ${r.id}: ${VERIFY_CODES.FAILED}, ${r.detail}`);
  out.push(`  log: ${r.log}`);
  if (r.evidence_error) out.push(`  WARNING: evidence not recorded: ${r.evidence_error}`);
  return out;
}

// ---------------------------------------------------------------------------
// Running (real processes)
// ---------------------------------------------------------------------------

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the group, SIGKILL whatever is left after the grace. @returns {Promise<boolean>} true when the group is gone */
export async function killGroup(pgid, graceMs = KILL_GRACE_MS) {
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* raced to exit */ }
  for (let t = 0; t < graceMs && groupAlive(pgid); t += 50) await sleep(50);
  if (groupAlive(pgid)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* raced to exit */ }
    for (let t = 0; t < 2000 && groupAlive(pgid); t += 50) await sleep(50);
  }
  return !groupAlive(pgid);
}

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

/**
 * Run one flow's command to completion (or timeout) in its own process group,
 * teeing stdout and stderr into `logPath`.
 * @returns {Promise<{exitCode, signal, timedOut, spawnError, stdout, stderr, durationMs, leftovers}>}
 */
export function runCommand(flow, { cwd, logPath, env = process.env, graceMs = KILL_GRACE_MS }) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'w', 0o600);
  const t0 = Date.now();
  writeSync(fd, `# compose verify flow=${flow.id} command=${JSON.stringify(flow.command)} cwd=${cwd} started=${new Date(t0).toISOString()} timeout_s=${flow.timeout_s}\n`);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - t0;
      writeSync(fd, `# exit=${res.exitCode} signal=${res.signal} timed_out=${res.timedOut} duration_ms=${durationMs}${res.spawnError ? ` spawn_error=${JSON.stringify(res.spawnError)}` : ''}\n`);
      closeSync(fd);
      resolve({ stdout, stderr, durationMs, ...res });
    };
    try {
      child = spawn(flow.command[0], flow.command.slice(1), {
        cwd, env: { ...env, COMPOSE_VERIFY_FLOW: flow.id }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ exitCode: null, signal: null, timedOut: false, spawnError: e.message, leftovers: false });
      return;
    }
    const pgid = child.pid;
    child.stdout.on('data', (b) => { writeSync(fd, b); if (stdout.length < MAX_JUDGE_BYTES) stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { writeSync(fd, b); if (stderr.length < MAX_JUDGE_BYTES) stderr += b.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      writeSync(fd, `# FLOW_TIMEOUT after ${flow.timeout_s} s: SIGTERM to process group ${pgid}\n`);
      killGroup(pgid, graceMs);
    }, flow.timeout_s * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ exitCode: null, signal: null, timedOut: false, spawnError: e.message, leftovers: false });
    });
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      // The leader is gone; anything still in its group is the flow's leftovers
      // (a server it started and did not stop). Kill them so no orphan holds a port.
      let leftovers = false;
      if (pgid && groupAlive(pgid)) {
        leftovers = !timedOut;
        if (leftovers) writeSync(fd, `# WARNING: the flow exited and left processes in its group ${pgid}; terminating them (the flow should clean up after itself)\n`);
        const gone = await killGroup(pgid, graceMs);
        if (!gone) writeSync(fd, `# WARNING: process group ${pgid} survived SIGKILL\n`);
      }
      // Pipes close once every writer is dead; cap the wait in case one escaped the group.
      if (child.stdout && !child.stdout.closed) {
        await Promise.race([
          Promise.all([new Promise((r) => child.stdout.once('close', r)), new Promise((r) => child.stderr.once('close', r))]),
          sleep(DRAIN_MS),
        ]);
        child.stdout.destroy(); child.stderr.destroy();
      }
      finish({ exitCode: code, signal, timedOut, spawnError: null, leftovers });
    });
  });
}

function verifyDir(workspaceRoot, featureCode) {
  return path.join(workspaceRoot, '.compose', 'data', 'verify', featureCode || ADHOC_DIR);
}

/**
 * Run flows one after another (all of them, so one refusal names every failure),
 * judge each, append a line to runs.jsonl, and mint a `command` receipt for each PASS.
 *
 * @param {object[]} flows      normalized flows (loadVerifyConfig)
 * @param {object}   o
 * @param {string}   o.workspaceRoot   logs live here
 * @param {string}   [o.cwd]          where the command runs (the evidence root); defaults to workspaceRoot
 * @param {string}   [o.featureCode]   binds logs and the receipt's subject; absent ⇒ `_adhoc`
 * @param {string}   [o.commitSha]     recorded beside each run (what it ran against)
 * @param {Function} [o.onLine]        progress sink (CLI: stderr)
 * @param {string}   [o.store]         evidence store override
 * @returns {Promise<object[]>} one result per flow
 */
export async function runFlows(flows, { workspaceRoot, cwd = workspaceRoot, featureCode, commitSha = null, onLine = () => {}, store = evidenceStorePath(), env = process.env, graceMs } = {}) {
  const dir = verifyDir(workspaceRoot, featureCode);
  const results = [];
  for (const flow of flows) {
    onLine(`verify: running ${flow.id} (timeout ${flow.timeout_s} s)`);
    const startedAt = new Date();
    const log = path.join(dir, `${flow.id}-${stamp(startedAt)}.log`);
    const run = await runCommand(flow, { cwd, logPath: log, env, graceMs });
    const j = judgeRun(run, flow);
    const r = {
      id: flow.id, verdict: j.verdict, code: j.code, detail: j.detail, missing: j.missing,
      matched: j.matched.length, expected: flow.expect.length, exit_code: run.exitCode, signal: run.signal,
      timeout_s: flow.timeout_s, duration_ms: run.durationMs, log, commit_sha: commitSha,
      started_at: startedAt.toISOString(), evidence_id: null, leftovers: run.leftovers,
    };
    if (j.verdict === 'PASS') {
      // The receipt's line is the LAST matched expect line, re-checked against the log right now.
      const evidence = {
        kind: 'command',
        command: flow.command.join(' ').slice(0, 2000),
        output_line: j.matched[j.matched.length - 1],
        log,
        at: new Date().toISOString(),
        by: env.COMPOSE_SESSION_NAME || 'compose-verify',
      };
      const v = verifyEvidence(evidence);
      if (v.ok) {
        try {
          const subject = featureCode
            ? { tool: 'compose verify', feature: featureCode, claim: 'verify-flow', outcome: `PASS ${flow.id}` }
            : { tool: 'compose verify', gate: `verify-flow:${flow.id}`, outcome: 'PASS' };
          r.evidence_id = recordEvidence(evidence, { checks: v.checks, subject, store }).id;
        } catch (e) {
          r.evidence_error = e.message;
        }
      } else {
        r.evidence_error = v.reasons.join('; ');
      }
    }
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify({ feature: featureCode || null, ...r }) + '\n');
    for (const l of describeResult(r)) onLine(l);
    results.push(r);
  }
  return results;
}

/** The slice of a result the completion record keeps. */
export function recordEntry(r) {
  return { id: r.id, verdict: r.verdict, evidence_id: r.evidence_id, log: r.log, commit_sha: r.commit_sha, at: r.started_at };
}

/**
 * The completion gate's whole verify step. Returns null when the project
 * declares no `verify` block (the caller then takes exactly today's path).
 *
 * @returns {Promise<null | {ok: boolean, code?: string, reasons: string[], lines: string[], results: object[], mode: string, record: object[]}>}
 */
export async function verifyForCompletion({ workspaceRoot, cwd = workspaceRoot, featureCode, commitSha, filesChanged, onLine, store, env, graceMs }) {
  let cfg;
  try {
    cfg = loadVerifyConfig(workspaceRoot);
  } catch (e) {
    if (e instanceof VerifyConfigError) {
      return { ok: false, code: VERIFY_CODES.CONFIG, reasons: [e.message], lines: [], results: [], mode: 'none', record: [] };
    }
    throw e;
  }
  if (!cfg) return null;
  const lines = [];
  const say = (l) => { lines.push(l); if (onLine) onLine(l); };
  const sel = selectFlows(cfg.flows, filesChanged);
  say(sel.line);
  if (sel.flows.length === 0) return { ok: true, reasons: [], lines, results: [], mode: sel.mode, record: [] };
  const results = await runFlows(sel.flows, {
    workspaceRoot, cwd, featureCode, commitSha: commitSha || null, onLine: say,
    ...(store ? { store } : {}), ...(env ? { env } : {}), ...(graceMs ? { graceMs } : {}),
  });
  const failed = results.filter((r) => r.verdict !== 'PASS');
  if (failed.length) {
    return {
      ok: false, code: failed[0].code, reasons: failed.map(refusalReason), lines, results, mode: sel.mode,
      record: results.map(recordEntry),
    };
  }
  return { ok: true, reasons: [], lines, results, mode: sel.mode, record: results.map(recordEntry) };
}

/** Runs recorded for a feature (newest last), from runs.jsonl. */
export function readRuns(workspaceRoot, featureCode) {
  const p = path.join(verifyDir(workspaceRoot, featureCode), 'runs.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}
