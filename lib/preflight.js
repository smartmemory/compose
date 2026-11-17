/**
 * COMP-SETUP-PREFLIGHT-1 — cheap setup checks before an expensive verification.
 *
 * Two own-use incidents motivated this (docs/features/COMP-SETUP-PREFLIGHT-1/):
 *  - I19: a Stratum build ran during Compose's full test gate. `npm run build` cleans
 *    `dist/` first, so two test files failed on a missing engine file, read as product
 *    reds, and cost a control rerun.
 *  - I13: two verification runs on the same repository raced; the leak gate blamed
 *    whichever run was alive for a worktree the other one created.
 *
 * Three callers share this module: `compose build` (before the first dispatch),
 * `compose preflight` (by hand), and the pre-push hook (`compose preflight --gate --
 * npm test`, which wraps the suite). Results are their own class, never a product red:
 *
 *   SETUP-FAIL     a check failed before the run; nothing expensive started (exit 78)
 *   SETUP-BUSY     another verification run holds the repository (exit 75)
 *   SETUP-INVALID  the engine changed during the run; reds that name it are setup,
 *                  not product (exit 79 when every red is one of those)
 *
 * Nothing here retries anything. A setup result prints what to run; a person runs it.
 * The built-in engine check is on by default (it only moves an unavoidable failure
 * earlier); project checks and the run lock are opt-in via `.compose/compose.json`
 * `verify.preflight` (contracts/verify-config.schema.json).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readComposeJson } from './compose-json.js';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

import { expectedStratumBin, probeStratumBin } from './stratum-engine.js';
import { acquireDirLock, DirLockTimeout } from './dir-lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** sysexits-style codes, chosen so none collides with `npm test`'s own exit 1. */
export const SETUP_EXIT = Object.freeze({ BUSY: 75, FAIL: 78, INVALID: 79 });
export const ENGINE_CHECK_ID = 'stratum-engine';
export const RUN_LOCK_REL = join('.compose', 'data', 'verify-run.lock');
const DEFAULT_CHECK_TIMEOUT_S = 10;
const ENGINE_KINDS = ['cli', 'mcp'];

/** A setup failure on the build path. `message` is the history `failureReason`. */
export class SetupFailure extends Error {
  constructor(id, detail) {
    super(`setup:${id}`);
    this.name = 'SetupFailure';
    this.code = 'SETUP_FAIL';
    this.checkId = id;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let validatePreflight = null;
function preflightValidator() {
  if (validatePreflight) return validatePreflight;
  const schema = JSON.parse(readFileSync(
    join(__dirname, '..', 'contracts', 'verify-config.schema.json'), 'utf8',
  ));
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(schema, 'verify-config');
  validatePreflight = ajv.getSchema('verify-config#/definitions/preflight');
  return validatePreflight;
}

/**
 * Read `verify.preflight`. An absent block or absent file is "not configured". A
 * file that exists but is not valid JSON throws (P-2: it used to read as "not
 * configured", silently dropping the run lock and every project check), and so does
 * a present but invalid block, so a typo cannot silently drop a check.
 */
export function readPreflightConfig(cwd) {
  const empty = { configured: false, checks: [], exclusive_runs: false, busy_wait_s: 0 };
  const raw = readComposeJson(cwd);
  if (raw === null) return empty;
  const block = raw?.verify?.preflight;
  if (block === undefined) return empty;
  const validate = preflightValidator();
  if (!validate(block)) {
    const why = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw new Error(`.compose/compose.json verify.preflight is invalid: ${why}`);
  }
  const ids = new Set();
  for (const c of block.checks ?? []) {
    if (ids.has(c.id)) throw new Error(`.compose/compose.json verify.preflight: duplicate check id "${c.id}"`);
    ids.add(c.id);
  }
  return {
    configured: true,
    checks: block.checks ?? [],
    exclusive_runs: block.exclusive_runs === true,
    busy_wait_s: block.busy_wait_s ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Built-in check: the Stratum engine
// ---------------------------------------------------------------------------

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Does this repository's own test run load the Stratum engine? Compose itself and
 * anything depending on @smartmemory/stratum or @smartmemory/compose do. For any
 * other repository the gate does not check Compose's engine: its tests never load
 * it, so a missing engine would block a push for a failure that cannot happen.
 */
export function repoUsesEngine(cwd) {
  const pkg = readJson(join(cwd, 'package.json'));
  if (!pkg) return false;
  if (pkg.name === '@smartmemory/compose' || pkg.name === '@smartmemory/stratum') return true;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  return Boolean(deps['@smartmemory/stratum'] || deps['@smartmemory/compose']);
}

function fingerprintFile(path) {
  try {
    const st = statSync(path);
    const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
    let real = path;
    try { real = realpathSync(path); } catch { /* keep path */ }
    return { exists: true, sha256: sha, mtimeMs: st.mtimeMs, ino: st.ino, size: st.size, realPath: real };
  } catch {
    return { exists: false };
  }
}

function fixFor(expected) {
  if (expected.source === 'env') {
    return `unset ${expected.envVar} or point it at a built engine`;
  }
  if (expected.source === 'installed') {
    const pkg = readJson(join(expected.packageRoot, 'package.json'));
    let root = expected.packageRoot;
    try { root = realpathSync(root); } catch { /* keep */ }
    return pkg?.scripts?.build
      ? `cd ${root} && npm run build (wait for any build already running to finish)`
      : 'reinstall @smartmemory/stratum (npm install)';
  }
  return 'install @smartmemory/stratum or place a built stratum checkout beside compose';
}

/**
 * The engine check. Resolves the engine file Compose SHOULD run (no fall-through:
 * see `expectedStratumBin`), requires it to exist, fingerprints it for the end-of-run
 * re-check, and (when `probe`) positively identifies the CLI with `probeStratumBin`.
 *
 * @param {object} opts
 * @param {string} [opts.requireFrom]  a file path whose node_modules resolve the package;
 *   omitted = Compose's own install (what `compose build` runs)
 * @param {boolean} [opts.probe]       run the CLI identity probe (~0.2 s warm)
 */
export function checkEngine({ requireFrom = null, probe = true, env = process.env } = {}) {
  const t0 = Date.now();
  const requireResolve = requireFrom
    ? createRequire(requireFrom).resolve
    : undefined;
  const fingerprint = {};
  for (const kind of ENGINE_KINDS) {
    const expected = expectedStratumBin(kind, { env, ...(requireResolve ? { requireResolve } : {}) });
    if (!expected.path) {
      return {
        id: ENGINE_CHECK_ID, ok: false, ms: Date.now() - t0,
        detail: `no ${kind} engine resolvable (not installed, no sibling checkout)`,
        fix: fixFor(expected),
      };
    }
    const fp = fingerprintFile(expected.path);
    if (!fp.exists) {
      return {
        id: ENGINE_CHECK_ID, ok: false, ms: Date.now() - t0,
        detail: `${expected.path} not found`,
        fix: fixFor(expected),
      };
    }
    fingerprint[kind] = { path: expected.path, source: expected.source, ...fp };
  }
  if (probe) {
    const res = probeStratumBin(fingerprint.cli.path);
    if (!res.ok) {
      return {
        id: ENGINE_CHECK_ID, ok: false, ms: Date.now() - t0,
        detail: `${fingerprint.cli.path} is present but does not run: ${res.reason}`,
        fix: fixFor({ source: fingerprint.cli.source, packageRoot: packageRootOf(fingerprint.cli.path), envVar: 'COMPOSE_STRATUM_TS_CLI_BIN' }),
      };
    }
  }
  return {
    id: ENGINE_CHECK_ID, ok: true, ms: Date.now() - t0,
    detail: `${fingerprint.cli.path} sha256 ${fingerprint.cli.sha256.slice(0, 12)}`,
    fingerprint,
  };
}

function packageRootOf(binPath) {
  let dir = dirname(binPath);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return dirname(binPath);
}

/** Re-fingerprint the same files a check recorded. */
export function refingerprint(before) {
  const after = {};
  for (const [kind, fp] of Object.entries(before ?? {})) {
    after[kind] = { path: fp.path, source: fp.source, ...fingerprintFile(fp.path) };
  }
  return after;
}

/**
 * Did the engine change between `before` and `after`? A rebuild that produces
 * byte-identical output still counts (new mtime/inode): the files were missing in
 * between, which is exactly when the I19 reds happened.
 */
export function engineDrift(before, after) {
  const changes = [];
  for (const [kind, b] of Object.entries(before ?? {})) {
    const a = after?.[kind];
    if (!a?.exists) {
      changes.push({ kind, path: b.path, before: b.sha256, after: null, sameContent: false });
    } else if (a.sha256 !== b.sha256 || a.mtimeMs !== b.mtimeMs || a.ino !== b.ino) {
      changes.push({ kind, path: b.path, before: b.sha256, after: a.sha256, sameContent: a.sha256 === b.sha256 });
    }
  }
  if (changes.length === 0) return { changed: false, changes, line: null };
  const parts = changes.map((c) => {
    const after = c.after ? c.after.slice(0, 12) : 'missing';
    const note = c.sameContent ? ', rewritten with the same content' : '';
    return `${c.kind} hash ${c.before.slice(0, 12)} -> ${after}${note}`;
  });
  return {
    changed: true,
    changes,
    line: `SETUP-INVALID ${ENGINE_CHECK_ID} changed during the run (${parts.join('; ')})`,
  };
}

/** Strings whose presence in a failure's output means it touched the engine. */
export function engineMarkers(fingerprint) {
  const out = new Set();
  for (const fp of Object.values(fingerprint ?? {})) {
    for (const p of [fp.path, fp.realPath]) {
      if (!p) continue;
      out.add(p);
      const i = p.lastIndexOf(`${sep}dist${sep}`);
      if (i >= 0) out.add(p.slice(0, i + 6)); // the whole dist/ tree the bin lives in
    }
  }
  out.add('@smartmemory/stratum/dist/');
  return [...out];
}

// ---------------------------------------------------------------------------
// Project checks
// ---------------------------------------------------------------------------

function firstLine(text, max = 100) {
  const line = String(text ?? '').trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** Run one declared check. Real process, bounded by its timeout. Never throws. */
export function runProjectCheck(check, cwd) {
  const t0 = Date.now();
  const timeoutS = check.timeout_s ?? DEFAULT_CHECK_TIMEOUT_S;
  const [cmd, ...args] = check.command;
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: timeoutS * 1000, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const base = { id: check.id, ms };
  if (r.error?.code === 'ENOENT') {
    return { ...base, ok: false, detail: `command not found: ${cmd}`, fix: `install ${cmd} or fix verify.preflight.checks[${check.id}].command` };
  }
  if (r.error?.code === 'ETIMEDOUT' || (r.signal && r.status === null)) {
    return { ...base, ok: false, detail: `timed out after ${timeoutS}s`, fix: 'start what the check depends on, or raise its timeout_s' };
  }
  if (r.error) {
    return { ...base, ok: false, detail: `could not run: ${r.error.message}` };
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (check.expect !== undefined) {
    if (output.includes(check.expect)) return { ...base, ok: true, detail: `got "${check.expect}"` };
    return {
      ...base, ok: false,
      detail: `expected "${check.expect}", got "${firstLine(output) || `(no output, exit ${r.status})`}"`,
    };
  }
  if (r.status === 0) return { ...base, ok: true, detail: 'exit 0' };
  return { ...base, ok: false, detail: `exited ${r.status}: ${firstLine(output) || '(no output)'}` };
}

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

/**
 * Run every cheap check for `mode`:
 *   'build'  Compose's own engine, existence + fingerprint (the build already talks
 *            to the engine, so no identity probe), then project checks.
 *   'gate'   the repository's engine (only if it uses one), probed, then project checks.
 *   'cli'    as 'gate', but Compose's own engine when the repository has none.
 *
 * `COMPOSE_SKIP_PREFLIGHT=1` skips every check with one WARNING naming them.
 * The run lock is not a check; see `acquireRunLock`.
 *
 * @returns {{ok, skipped, results, fingerprint, config, warning?}}
 */
export function runPreflight({ cwd, mode = 'cli', env = process.env } = {}) {
  let config;
  try {
    config = readPreflightConfig(cwd);
  } catch (err) {
    return {
      ok: false, skipped: false, fingerprint: null,
      config: { configured: false, checks: [], exclusive_runs: false, busy_wait_s: 0 },
      results: [{ id: 'config', ok: false, ms: 0, detail: err.message, fix: err.code === 'COMPOSE_CONFIG_UNREADABLE' ? 'fix the JSON syntax in .compose/compose.json' : 'fix the block (contracts/verify-config.schema.json)' }],
    };
  }

  const usesEngine = repoUsesEngine(cwd);
  const engineApplies = mode !== 'gate' || usesEngine;

  if (env.COMPOSE_SKIP_PREFLIGHT && env.COMPOSE_SKIP_PREFLIGHT !== '0') {
    const skippedIds = [...(engineApplies ? [ENGINE_CHECK_ID] : []), ...config.checks.map((c) => c.id)];
    return {
      ok: true, skipped: true, results: [], fingerprint: null, config,
      warning: `WARNING: COMPOSE_SKIP_PREFLIGHT is set: skipped setup checks ${skippedIds.join(', ') || '(none declared)'}; `
        + 'a broken setup will now surface as test or step failures, and the end-of-run engine re-check is off',
    };
  }

  const results = [];
  let fingerprint = null;
  if (engineApplies) {
    const requireFrom = mode === 'build' || !usesEngine ? null : join(cwd, 'package.json');
    const engine = checkEngine({ requireFrom, probe: mode !== 'build', env });
    results.push(engine);
    if (engine.ok) fingerprint = engine.fingerprint;
  } else {
    results.push({
      id: ENGINE_CHECK_ID, ok: true, ms: 0, skipped: true,
      detail: 'not checked: this repository does not depend on @smartmemory/stratum or @smartmemory/compose',
    });
  }
  for (const check of config.checks) results.push(runProjectCheck(check, cwd));

  return { ok: results.every((r) => r.ok), skipped: false, results, fingerprint, config };
}

/** One line per check (plus a `fix:` line under a failure). */
export function formatPreflight(pre) {
  const lines = [];
  if (pre.warning) lines.push(pre.warning);
  for (const r of pre.results) {
    const t = `${(r.ms / 1000).toFixed(2)}s`;
    if (r.ok) {
      lines.push(`SETUP-OK   ${r.id} (${t})${r.detail ? `: ${r.detail}` : ''}`);
    } else {
      lines.push(`SETUP-FAIL ${r.id}: ${r.detail} (${t})`);
      if (r.fix) lines.push(`  fix: ${r.fix}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Run lock (opt-in: verify.preflight.exclusive_runs)
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Stale iff the holder ran on this host and its pid is gone. A holder on another
 * host, or a token we cannot parse, is never judged stale: the lock refuses rather
 * than override something it cannot see (remove the dir by hand; the message says
 * where). Residual: a recycled pid keeps a dead holder looking alive (a false BUSY,
 * never a stolen lock).
 */
export function runLockIsStale(token) {
  let holder;
  try { holder = JSON.parse(token); } catch { return false; }
  if (holder?.host && holder.host !== hostname()) return false;
  return !pidAlive(holder?.pid);
}

/**
 * The lock is per REPOSITORY, not per checkout: I13 was a second run in another
 * worktree of the same repository, and `git worktree list` is repository-wide. So
 * the lock lives in the main checkout. Outside git, the cwd.
 */
export function runLockPath(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const common = r.status === 0 ? r.stdout.trim() : '';
  const root = common && common.endsWith(`${sep}.git`) ? dirname(common) : resolve(cwd);
  return { root, path: join(root, RUN_LOCK_REL) };
}

export function readRunLockHolder(lockPath) {
  try { return JSON.parse(readFileSync(join(lockPath, 'owner'), 'utf8')); } catch { return null; }
}

function busyLine(root, holder, lockPath) {
  if (!holder) return `SETUP-BUSY: another verification run holds ${root} (holder unreadable; if none is running, remove ${lockPath})`;
  return `SETUP-BUSY: another verification run holds ${root} (pid ${holder.pid}, started ${holder.started}, ${holder.command})`;
}

/**
 * Take the run lock or refuse. Waits up to `waitS` for a live holder. Never
 * overrides a live holder; takes over a dead one (with a line saying so).
 *
 * @returns {Promise<{ok: true, release: Function, lines: string[]} | {ok: false, lines: string[]}>}
 */
export async function acquireRunLock(cwd, { command, waitS = 0, pid = process.pid } = {}) {
  const { root, path } = runLockPath(cwd);
  const lines = [];
  const prior = readRunLockHolder(path);
  if (existsSync(path)) {
    if (prior && runLockIsStale(JSON.stringify(prior))) {
      lines.push(`SETUP-OK   run-lock: taking over a stale lock (pid ${prior.pid} is not running, started ${prior.started})`);
    } else {
      lines.push(busyLine(root, prior, path));
      if (waitS > 0) lines.push(`  waiting up to ${waitS}s for it to finish`);
    }
  }
  const owner = JSON.stringify({ pid, started: new Date().toISOString(), command, host: hostname() });
  try {
    const release = await acquireDirLock(path, {
      timeoutMs: waitS * 1000, owner, isStale: runLockIsStale, heartbeat: false,
    });
    lines.push(`SETUP-OK   run-lock: holding ${path}`);
    return { ok: true, release, lines, path };
  } catch (err) {
    if (!(err instanceof DirLockTimeout)) throw err;
    const holder = readRunLockHolder(path);
    if (!lines.some((l) => l.startsWith('SETUP-BUSY'))) lines.push(busyLine(root, holder, path));
    lines.push(`SETUP-BUSY: refused${waitS > 0 ? ` after waiting ${waitS}s` : ''}; rerun when it finishes`);
    return { ok: false, lines, path };
  }
}

// ---------------------------------------------------------------------------
// After the run: attribute reds that touched a changed engine
// ---------------------------------------------------------------------------

/**
 * Split a node --test TAP log into failed FILES, and mark the ones whose failure
 * output names the engine. Each top-level `not ok` carries its subtests' diagnostics
 * just above it and a YAML block with `location: '<file>:L:C'` just below. Reds this
 * cannot attribute (another reporter, vitest) stay in `other`, reported as today.
 */
export function classifyTapFailures(text, markers, cwd) {
  const lines = String(text).split('\n');
  const setupInvalid = new Set();
  const other = new Set();
  let chunkStart = 0;
  let i = 0;
  while (i < lines.length) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(lines[i]);
    if (!m) { i++; continue; }
    let end = i;
    let location = null;
    if (lines[i + 1] === '  ---') {
      end = i + 1;
      while (end + 1 < lines.length && lines[end] !== '  ...') {
        end++;
        const loc = /^ {2}location: '(.+?):\d+:\d+'$/.exec(lines[end]);
        if (loc) location = loc[1];
      }
    }
    if (m[1] === 'not ok') {
      const name = m[2].replace(/ # .*$/, '');
      let file = location ?? (/\.(m?js|cjs|ts)$/.test(name) ? name : null);
      if (file) {
        if (file.startsWith('file://')) file = fileURLToPath(file);
        if (isAbsolute(file) && cwd) file = relative(cwd, file);
        const chunk = lines.slice(chunkStart, end + 1).join('\n');
        if (markers.some((mk) => chunk.includes(mk))) setupInvalid.add(file);
        else other.add(file);
      }
    }
    chunkStart = end + 1;
    i = end + 1;
  }
  for (const f of setupInvalid) other.delete(f);
  return { setupInvalid: [...setupInvalid], other: [...other] };
}

/**
 * The command that reruns only `files`: the node --test invocation from the
 * repository's `test` script with its globs removed. Falls back to `node --test`.
 */
export function rerunCommand(cwd, files) {
  const script = readJson(join(cwd, 'package.json'))?.scripts?.test ?? '';
  const first = script.split('&&')[0].trim().split(/\s+/);
  let prefix = ['node', '--test'];
  if (first[0] === 'node' && first.includes('--test')) {
    prefix = ['node'];
    const takesValue = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
    for (let k = 1; k < first.length; k++) {
      const t = first[k];
      if (!t.startsWith('-')) continue;
      prefix.push(t);
      if (takesValue.has(t) && k + 1 < first.length) prefix.push(first[++k]);
    }
  }
  return `${prefix.join(' ')} ${files.join(' ')}`;
}

function readFrom(path, offset) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.max(0, size - offset);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, offset);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Gate: preflight, lock, run, re-check (the pre-push hook's wrapper)
// ---------------------------------------------------------------------------

/**
 * Wrap a verification command. Prints setup lines to `err`; the command's own
 * output goes to `logPath` (appended) or is inherited. Returns the exit code:
 * SETUP_EXIT.* for setup results, otherwise the command's own code.
 */
export async function runGate({ cwd, argv, logPath = null, env = process.env, err = (l) => process.stderr.write(`${l}\n`) }) {
  const pre = runPreflight({ cwd, mode: 'gate', env });
  for (const l of formatPreflight(pre)) err(l);
  if (!pre.ok) {
    err('SETUP-FAIL: a setup check failed; the run did not start (this is not a test failure).');
    return SETUP_EXIT.FAIL;
  }

  let lock = null;
  if (pre.config.exclusive_runs) {
    lock = await acquireRunLock(cwd, { command: argv.join(' '), waitS: pre.config.busy_wait_s });
    for (const l of lock.lines) err(l);
    if (!lock.ok) return SETUP_EXIT.BUSY;
  }

  let offset = 0;
  let fd = null;
  try {
    if (logPath) {
      fd = openSync(logPath, 'a');
      offset = fstatSync(fd).size;
    }
    const code = await new Promise((resolveCode) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd, env, stdio: ['ignore', fd ?? 'inherit', fd ?? 'inherit'],
      });
      const forward = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
      const onInt = () => forward('SIGINT');
      const onTerm = () => forward('SIGTERM');
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      child.on('error', (e) => { err(`SETUP-FAIL run: could not start ${argv[0]}: ${e.message}`); resolveCode(SETUP_EXIT.FAIL); });
      child.on('close', (c, sig) => {
        process.removeListener('SIGINT', onInt);
        process.removeListener('SIGTERM', onTerm);
        resolveCode(c ?? (sig ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9 })[sig] ?? 1) : 1));
      });
    });

    if (!pre.fingerprint) return code;
    const drift = engineDrift(pre.fingerprint, refingerprint(pre.fingerprint));
    if (!drift.changed) return code;
    if (code === 0) {
      err(`WARNING: ${drift.line}; the run passed anyway`);
      return 0;
    }
    err(drift.line);
    if (!logPath) {
      err('  (no log to attribute failures from; every red is reported as a test failure)');
      return code;
    }
    const { setupInvalid, other } = classifyTapFailures(readFrom(logPath, offset), engineMarkers(pre.fingerprint), cwd);
    if (setupInvalid.length > 0) {
      err(`  setup-invalid (their output names the engine; not product reds): ${setupInvalid.join(' ')}`);
      err(`  rerun only those: ${rerunCommand(cwd, setupInvalid)}`);
    }
    if (other.length > 0) err(`  test failures (reported as usual): ${other.join(' ')}`);
    err('  nothing was retried automatically.');
    return setupInvalid.length > 0 && other.length === 0 ? SETUP_EXIT.INVALID : code;
  } finally {
    if (fd !== null) closeSync(fd);
    lock?.release?.();
  }
}
