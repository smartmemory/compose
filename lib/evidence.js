/**
 * lib/evidence.js — COMP-DOGFOOD-EVIDENCE-GATE-1: no state claim without a
 * receipt the server can check (row A of COMP-DOGFOOD-1).
 *
 * The contract is contracts/evidence.schema.json, plus contracts/evidence-words.json
 * (which receipt kinds back which state word: the one table every resolver
 * reads, this module and the ops claim_check.py). This module is its three
 * verbs: `validateEvidence` (the shape), `verifyEvidence` (the server re-checks
 * the receipt against the machine and never trusts it) and the store
 * (`recordEvidence` / `readEvidence`, one JSON line per accepted receipt, each
 * with an `ev:<id>`).
 *
 * The incident it exists for (ops ledger 2026-11-03 21:30): a coordinator
 * reported two jobs RUNNING from the launch pid line, and both had already
 * exited 77 at the seat-ceiling gate. A `process` receipt is therefore refused
 * before launch + 120 s (the pid line proves nothing yet), and at +120 s a gone
 * pid or an exit file fails with the gate line quoted.
 *
 * The store is machine-global (`~/.compose/evidence.jsonl`, override
 * COMPOSE_EVIDENCE_STORE), not per workspace: the ops ledger and message bus
 * resolve an `ev:<id>` with a plain local read and do not know which workspace
 * minted it. Same home as `~/.compose/notify-state.json`.
 *
 * `capabilities.evidence` (default ON, absent = on) is the requirement flag for
 * the four state tools. A workspace that sets it false logs one WARNING per
 * process saying its claims are unchecked: an opt-out is allowed, a silent one
 * is not.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { gitCommitExists } from '../server/lifecycle-guard.js';
import { decodePng, pngSize } from './evidence-png.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_SCHEMA_PATH = resolve(__dirname, '../contracts/evidence.schema.json');
export const EVIDENCE_WORDS_PATH = resolve(__dirname, '../contracts/evidence-words.json');

/** A `process` receipt is checked at launch + this or later; before it the pid line proves nothing. */
export const PROCESS_MIN_AGE_MS = 120_000;
/** A pid whose start time is further than this from the claimed launch is a reused pid. */
export const PID_START_SKEW_MS = 120_000;
/** A file receipt's mtime may be this much older than its claimed `at` (and `at` this much in the future). */
export const FILE_MTIME_SKEW_MS = 120_000;
/**
 * A file-backed receipt (file, log, command, screenshot, pixel) claims an
 * observation at most this long before the server's check (review F2: `at`
 * was the caller's to choose, so a year-old file passed with an old `at`).
 */
export const OBSERVED_MAX_AGE_MS = 15 * 60_000;
/** Largest per-channel difference (0-255) a `pixel` sample may show from the expected colour. */
export const PIXEL_TOLERANCE = 8;
/** Exit codes that mean a launch gate refused the job (77: the claude shim's seat-ceiling gate). */
export const GATE_EXIT_CODES = new Set([77]);
/** Largest file a line check reads. */
const MAX_CHECK_BYTES = 64 * 1024 * 1024;
/** An uppercase `... GATE` phrase: `SEAT CEILING GATE`, `WORK MODEL GATE`. */
const GATE_LINE_RE = /\b[A-Z][A-Z-]+(?: [A-Z][A-Z-]+)* GATE\b/;
export const EVIDENCE_REF_RE = /^ev:[0-9a-f]{16}$/;

export function evidenceStorePath(env = process.env) {
  return env.COMPOSE_EVIDENCE_STORE || join(homedir(), '.compose', 'evidence.jsonl');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Named error codes, one per way a claim is refused. */
export const EVIDENCE_CODES = Object.freeze({
  REQUIRED: 'EVIDENCE_REQUIRED',       // no evidence object at all
  INVALID: 'EVIDENCE_INVALID',         // fails contracts/evidence.schema.json
  UNKNOWN_REF: 'EVIDENCE_UNKNOWN_REF', // an ev:<id> the store does not hold
  TOO_EARLY: 'EVIDENCE_TOO_EARLY',     // a process receipt before launch + 120 s
  REFUSED: 'EVIDENCE_REFUSED',         // the server's re-check failed
  WRONG_KIND: 'EVIDENCE_WRONG_KIND',   // the receipt's kind does not back the claim (contracts/evidence-words.json)
  SUBJECT_MISMATCH: 'EVIDENCE_SUBJECT_MISMATCH', // a cited id minted for another feature, unit, gate or session
  STALE: 'EVIDENCE_STALE',             // a cited receipt older than its word's max_age_s
});

export function evidenceError(code, toolName, reasons) {
  const e = new Error(`${toolName}: ${code}: ${reasons.join('; ')}`);
  e.code = code;
  e.reasons = reasons;
  return e;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

let _validate = null;
let _validateRecord = null;
function validator() {
  if (_validate) return _validate;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(EVIDENCE_SCHEMA_PATH, 'utf8'));
  _validate = ajv.compile(schema);
  _validateRecord = ajv.getSchema(`${schema.$id}#/definitions/record`);
  return _validate;
}

/** True when `rec` is a store line that satisfies `#/definitions/record` (review F1 (d): a bare `{"id"}` line is not a receipt). */
export function isValidRecord(rec) {
  validator();
  return _validateRecord(rec) === true;
}

/** @returns {{ok: boolean, errors: string[]}} */
export function validateEvidence(evidence) {
  const v = validator();
  if (v(evidence)) return { ok: true, errors: [] };
  // oneOf reports every branch's failure; the ones naming the caller's own kind are the useful ones.
  const kind = evidence && typeof evidence === 'object' ? evidence.kind : undefined;
  const all = (v.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
  const own = kind ? (v.errors || []).filter((e) => e.schemaPath.includes(`/definitions/${kind}/`))
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`) : [];
  return { ok: false, errors: [...new Set(own.length ? own : all)].slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Re-checks
// ---------------------------------------------------------------------------

/** `ps -p` for one pid: alive, (when readable) its start time, and its command line. */
export function psProbe(pid) {
  const env = { ...process.env, LC_ALL: 'C' };
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || !out) return { alive: false };
  const t = Date.parse(out);
  const c = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', env });
  return { alive: true, startedAt: Number.isFinite(t) ? t : null, command: c.status === 0 ? (c.stdout || '').trim() : null };
}

/**
 * Is `sha` on the repo's default branch (review F2: existence alone let the
 * repo's first commit, or any repo's commit, back a LANDED)? The default
 * branch is origin/HEAD's, else main, else master; the local branch or its
 * origin/ copy may hold it (a compose land is a local ff-only merge).
 * @returns {{ok: boolean, branch: string|null}}
 */
export function gitOnDefaultBranch(sha, repo) {
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  const head = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const named = head.status === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : null;
  for (const name of named ? [named] : ['main', 'master']) {
    const refs = [`refs/heads/${name}`, `refs/remotes/origin/${name}`].filter((r) => git('rev-parse', '--verify', '--quiet', r).status === 0);
    if (!refs.length) continue;
    return { ok: refs.some((r) => git('merge-base', '--is-ancestor', sha, r).status === 0), branch: name };
  }
  return { ok: false, branch: null };
}

/**
 * Is `sha` on the named land branch (COMP-DOGFOOD-EVIDENCE-BRANCH-1)? Same
 * check as the default branch: the local branch or its origin/ copy may hold it.
 * The caller has already checked `branch` against `land_branches`.
 * @returns {{ok: boolean, branch: string|null}} branch null = the repo has no such branch
 */
export function gitOnBranch(sha, repo, branch) {
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].filter((r) => git('rev-parse', '--verify', '--quiet', r).status === 0);
  if (!refs.length) return { ok: false, branch: null };
  return { ok: refs.some((r) => git('merge-base', '--is-ancestor', sha, r).status === 0), branch };
}

function readCapped(path) {
  const st = statSync(path);
  if (st.size > MAX_CHECK_BYTES) throw new Error(`${path} is ${st.size} bytes, over the ${MAX_CHECK_BYTES}-byte check limit`);
  return readFileSync(path, 'utf8');
}

function findLine(text, claimed) {
  return text.split(/\r?\n/).find((l) => l.includes(claimed)) ?? null;
}

function gateLine(logPath) {
  if (!logPath) return null;
  try { return findGateLine(readCapped(logPath)); } catch { return null; }
}

function findGateLine(text) {
  const line = text.split(/\r?\n/).find((l) => GATE_LINE_RE.test(l));
  return line ? line.slice(0, 300) : null;
}

/** Fresh-file check shared by file / log / screenshot / command / pixel. Pushes reasons; returns the stat or null. */
function checkFresh(path, at, now, reasons, checks) {
  if (!existsSync(path)) { reasons.push(`${path} does not exist`); return null; }
  const st = statSync(path);
  if (!st.isFile()) { reasons.push(`${path} is not a regular file`); return null; }
  const claimed = Date.parse(at);
  if (claimed > now + FILE_MTIME_SKEW_MS) {
    reasons.push(`claimed at ${at} is in the future (server time ${new Date(now).toISOString()})`);
  }
  if (now - claimed > OBSERVED_MAX_AGE_MS) {
    reasons.push(`observed at ${at}, more than ${OBSERVED_MAX_AGE_MS / 60_000} min before the check at ${new Date(now).toISOString()}: mint the receipt when you see the thing`);
  }
  if (st.mtimeMs < claimed - FILE_MTIME_SKEW_MS) {
    reasons.push(`${path} was last written ${new Date(st.mtimeMs).toISOString()}, older than the claimed at ${at} minus ${FILE_MTIME_SKEW_MS / 1000} s: to vouch for an older file's content now, record a command receipt of a fresh grep -H <pattern> <file>`);
  }
  checks.push(`file ${path} exists, mtime ${new Date(st.mtimeMs).toISOString()}`);
  return st;
}

function checkLine(path, claimed, reasons, checks) {
  let text;
  try { text = readCapped(path); } catch (e) { reasons.push(`cannot read ${path}: ${e.message}`); return; }
  const hit = findLine(text, claimed);
  if (hit === null) reasons.push(`${path} holds no line containing ${JSON.stringify(claimed.slice(0, 200))}`);
  else checks.push(`line present in ${path}`);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const rgbHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Re-check one receipt object (never a ref) against the machine.
 * @param {object} ev a schema-valid evidence object
 * @param {{now?: number, ps?: (pid:number) => {alive:boolean, startedAt?:number|null}, gitExists?: Function}} [o] test seams
 * @returns {{ok: boolean, code?: string, reasons: string[], checks: string[]}}
 */
export function verifyEvidence(ev, o = {}) {
  const now = o.now ?? Date.now();
  const ps = o.ps ?? psProbe;
  const gitExists = o.gitExists ?? gitCommitExists;
  const onDefault = o.onDefault ?? gitOnDefaultBranch;
  const reasons = [];
  const checks = [];
  switch (ev.kind) {
    case 'sha': {
      if (!existsSync(ev.repo)) reasons.push(`repo ${ev.repo} does not exist`);
      else if (!gitExists(ev.sha, ev.repo)) reasons.push(`commit ${ev.sha} not found in ${ev.repo} (git rev-parse --verify ${ev.sha}^{commit})`);
      else {
        const land = loadEvidenceWords().land_branches ?? [];
        const named = ev.branch !== undefined;
        const d = !named ? onDefault(ev.sha, ev.repo)
          : land.includes(ev.branch) ? gitOnBranch(ev.sha, ev.repo, ev.branch) : null;
        if (d === null) {
          reasons.push(`branch ${ev.branch} is not a declared land branch (land_branches in contracts/evidence-words.json: ${land.join(', ') || 'none'}): only a commit on the default branch or a declared land branch is landed`);
        } else if (!d.ok) {
          reasons.push(named && !d.branch ? `${ev.repo} has no branch ${ev.branch} (refs/heads or origin/) to check commit ${ev.sha} against`
            : named ? `commit ${ev.sha} is not on the land branch (${d.branch}) of ${ev.repo}: an unmerged commit is not landed`
            : d.branch
            ? `commit ${ev.sha} is not on the default branch (${d.branch}) of ${ev.repo}: an unmerged commit is not landed`
            : `${ev.repo} has no default branch (origin/HEAD, main or master) to check commit ${ev.sha} against`);
        } else checks.push(`commit ${ev.sha} is on ${d.branch} in ${ev.repo}`);
      }
      break;
    }
    case 'process': {
      const launched = Date.parse(ev.launched_at);
      const age = now - launched;
      if (age < PROCESS_MIN_AGE_MS) {
        return {
          ok: false, code: EVIDENCE_CODES.TOO_EARLY, checks,
          reasons: [`too early: checked at launch + ${Math.round(age / 1000)} s; a process receipt is checked at launch + ${PROCESS_MIN_AGE_MS / 1000} s or later (a launch pid line proves nothing yet)`],
        };
      }
      const gate = gateLine(ev.log);
      if (ev.exit_file && existsSync(ev.exit_file)) {
        let code = null;
        try { code = parseInt(readFileSync(ev.exit_file, 'utf8').trim().split(/\s+/)[0], 10); } catch { /* unread: reported below */ }
        if (Number.isInteger(code) && GATE_EXIT_CODES.has(code)) {
          reasons.push(`${ev.label} exited ${code} at a launch gate${gate ? `: ${gate}` : ' (no gate line found in the log)'}`);
        } else {
          reasons.push(`${ev.label} is not running: its exit file ${ev.exit_file} holds ${Number.isInteger(code) ? `exit ${code}` : 'an unreadable code'}`);
        }
      }
      const p = ps(ev.pid);
      if (!p.alive) {
        reasons.push(`pid ${ev.pid} (${ev.label}) is gone at launch + ${Math.round(age / 1000)} s${gate ? `; the log says: ${gate}` : ''}`);
      } else {
        const before = reasons.length;
        if (p.startedAt != null && Math.abs(p.startedAt - launched) > PID_START_SKEW_MS) {
          reasons.push(`pid ${ev.pid} started ${new Date(p.startedAt).toISOString()}, not at the claimed launch ${ev.launched_at}: a reused pid, not ${ev.label}`);
        }
        if (typeof p.command !== 'string' || !p.command.includes(ev.label)) {
          // review F2: pid 1 (launchd) with its real start time passed as `seat-equalize`
          reasons.push(`pid ${ev.pid} runs ${JSON.stringify(String(p.command ?? '(command unreadable)').slice(0, 200))}, which does not contain the label ${ev.label}`);
        }
        if (reasons.length === before) {
          checks.push(p.startedAt == null
            ? `pid ${ev.pid} alive, command contains ${ev.label}; start time unreadable, reuse not checked`
            : `pid ${ev.pid} alive at launch + ${Math.round(age / 1000)} s, command contains ${ev.label}`);
        }
      }
      break;
    }
    case 'file':
    case 'log': {
      if (checkFresh(ev.path, ev.at, now, reasons, checks) && ev.line) checkLine(ev.path, ev.line, reasons, checks);
      break;
    }
    case 'command': {
      if (checkFresh(ev.log, ev.at, now, reasons, checks)) checkLine(ev.log, ev.output_line, reasons, checks);
      break;
    }
    case 'screenshot': {
      if (checkFresh(ev.path, ev.at, now, reasons, checks)) {
        try {
          const { width, height } = pngSize(ev.path);
          const r = ev.region;
          if (r && (r.x + r.w > width || r.y + r.h > height)) {
            reasons.push(`region ${r.x},${r.y} ${r.w}x${r.h} lies outside the ${width}x${height} screenshot`);
          } else checks.push(`screenshot ${width}x${height}`);
        } catch (e) { reasons.push(`${ev.path}: ${e.message}`); }
      }
      break;
    }
    case 'pixel': {
      if (checkFresh(ev.path, ev.at, now, reasons, checks)) {
        try {
          const img = decodePng(ev.path);
          const { x, y } = ev.point;
          if (x >= img.width || y >= img.height) {
            reasons.push(`point ${x},${y} lies outside the ${img.width}x${img.height} screenshot`);
          } else {
            const got = img.pixel(x, y);
            const want = hexToRgb(ev.expected);
            const diff = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
            if (diff > PIXEL_TOLERANCE) {
              reasons.push(`pixel ${x},${y} is ${rgbHex(got)}, not ${ev.expected.toLowerCase()} (off by ${diff}, tolerance ${PIXEL_TOLERANCE})`);
            } else checks.push(`pixel ${x},${y} is ${rgbHex(got)} (within ${PIXEL_TOLERANCE} of ${ev.expected.toLowerCase()})`);
          }
        } catch (e) { reasons.push(`${ev.path}: ${e.message}`); }
      }
      break;
    }
    default:
      reasons.push(`unknown evidence kind ${ev.kind}`);
  }
  return reasons.length
    ? { ok: false, code: EVIDENCE_CODES.REFUSED, reasons, checks }
    : { ok: true, reasons, checks };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The stored record for an `ev:<id>`, or null. A plain scan: the store is
 * append-only JSONL. A line that does not satisfy `#/definitions/record` is
 * not a receipt (review F1 repro 3: a hand-appended `{"id":…}`), so an id
 * whose only line is invalid is unknown.
 */
export function readEvidence(id, { store = evidenceStorePath() } = {}) {
  if (!EVIDENCE_REF_RE.test(id || '') || !existsSync(store)) return null;
  const needle = `"id":"${id}"`;
  for (const line of readFileSync(store, 'utf8').split('\n')) {
    if (!line.includes(needle)) continue;
    try { const r = JSON.parse(line); if (r.id === id && isValidRecord(r)) return r; } catch { /* a torn line is skipped */ }
  }
  return null;
}

/** The cite side log beside the store: a cite appends here and never adds a record (so the id never changes). */
export function citesPath(store = evidenceStorePath()) {
  return join(dirname(store), `${basename(store).replace(/\.jsonl$/, '')}-cites.jsonl`);
}

/** Append one cite `{cites, at, tool, subject, by}` to the side log; returns the entry. */
export function recordCite(id, { tool, subject, store = evidenceStorePath(), now = Date.now(), env = process.env } = {}) {
  const entry = { cites: id, at: new Date(now).toISOString(), tool, subject, by: env.COMPOSE_SESSION_NAME || null };
  const path = citesPath(store);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}

/** Every stored record whose subject names `feature` (newest last). */
export function listEvidence({ feature, store = evidenceStorePath() } = {}) {
  if (!existsSync(store)) return [];
  const out = [];
  for (const line of readFileSync(store, 'utf8').split('\n')) {
    if (!line.trim() || (feature && !line.includes(JSON.stringify(feature)))) continue;
    try {
      const r = JSON.parse(line);
      if (!feature || r.subject?.feature === feature) out.push(r);
    } catch { /* a torn line is skipped */ }
  }
  return out;
}

/**
 * Append an accepted receipt; returns the record (with its new id). A record
 * every reader would treat as unknown (an unknown subject key, say) is refused
 * here, EVIDENCE_INVALID, and nothing is written.
 */
export function recordEvidence(evidence, { checks = [], subject, store = evidenceStorePath(), now = Date.now() } = {}) {
  const record = { id: `ev:${randomBytes(8).toString('hex')}`, evidence, checked_at: new Date(now).toISOString(), checks };
  if (subject) record.subject = subject;
  if (!isValidRecord(record)) {
    throw evidenceError(EVIDENCE_CODES.INVALID, 'recordEvidence', [
      `the record does not satisfy contracts/evidence.schema.json#/definitions/record: ${(_validateRecord.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).slice(0, 4).join('; ')}`,
    ]);
  }
  mkdirSync(dirname(store), { recursive: true });
  appendFileSync(store, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

// ---------------------------------------------------------------------------
// The words table (contracts/evidence-words.json): which kinds back which claim
// ---------------------------------------------------------------------------

let _words = null;
/** The table, read once per process. A missing or unparsable table throws: the gate never guesses a rule. */
export function loadEvidenceWords() {
  if (!_words) _words = JSON.parse(readFileSync(EVIDENCE_WORDS_PATH, 'utf8'));
  return _words;
}

/** The table row for a claim (a state word or a feature status), or null: a claim with no row takes any kind. */
export function claimRule(claim) {
  return (typeof claim === 'string' && Object.hasOwn(loadEvidenceWords().words, claim)) ? loadEvidenceWords().words[claim] : null;
}

/** True when a receipt of `kind` can back `claim`. */
export function kindBacks(claim, kind) {
  const row = claimRule(claim);
  return !row || row.kinds.includes('*') || row.kinds.includes(kind);
}

const kindsText = (row) => row.kinds.join(' or ');

/**
 * The checks a cited record must pass for `claim`, beyond being known and
 * valid: its kind backs the claim; a row with `max_age_s` bounds how long ago
 * the server checked it; a row with `recheck` re-verifies it now (RUNNING: the
 * pid is alive and runs the labelled command).
 * @returns {{ok: boolean, code?: string, reasons: string[], checks: string[]}}
 */
export function checkCite(rec, claim, o = {}) {
  const now = o.now ?? Date.now();
  const row = claimRule(claim);
  const kind = rec.evidence.kind;
  if (!kindBacks(claim, kind)) {
    return { ok: false, code: EVIDENCE_CODES.WRONG_KIND, checks: [], reasons: [`${rec.id} is a ${kind} receipt; ${claim} takes ${kindsText(row)}`] };
  }
  if (row?.max_age_s != null) {
    const age = now - Date.parse(rec.checked_at);
    if (!(age <= row.max_age_s * 1000)) {
      return { ok: false, code: EVIDENCE_CODES.STALE, checks: [], reasons: [
        `${rec.id} was checked ${Math.round(age / 60_000)} min ago; ${claim} takes a receipt checked within ${row.max_age_s / 60} min (mint a fresh one)`,
      ] };
    }
  }
  if (row?.recheck) {
    const v = verifyEvidence(rec.evidence, o);
    if (!v.ok) return { ok: false, code: EVIDENCE_CODES.REFUSED, checks: v.checks, reasons: v.reasons.map((r) => `${rec.id}: ${r}`) };
    return { ok: true, reasons: [], checks: [`cites ${rec.id}`, ...v.checks] };
  }
  return { ok: true, reasons: [], checks: [`cites ${rec.id}`] };
}

/** The code a subject binds a cite by: feature, else unit, else gate. */
function subjectKey(s) {
  if (!s || typeof s !== 'object') return null;
  return s.feature || s.unit || (s.gate ? `gate ${s.gate}` : null);
}

/**
 * Is this cite for the claim the record was minted for (review F1 (b))? A
 * record with a subject is cited only for the same feature (or unit, or gate).
 * A record with no subject (a CLI record) is cited only by its own `by`
 * session, named to this server by COMPOSE_SESSION_NAME.
 */
function checkSubject(rec, subject, env = process.env) {
  if (rec.subject) {
    const want = subjectKey(rec.subject);
    const got = subjectKey(subject);
    if (want !== got) return [`${rec.id} was minted for ${want ?? 'no feature'}; this claim is for ${got ?? 'no feature'}`];
    return [];
  }
  const caller = env.COMPOSE_SESSION_NAME;
  if (!caller) return [`${rec.id} has no subject, so only its own session (by ${rec.evidence.by}) may cite it, and COMPOSE_SESSION_NAME is unset: pass the evidence object, or mint the id with record_evidence and a subject`];
  if (caller !== rec.evidence.by) return [`${rec.id} has no subject and was minted by ${rec.evidence.by}; this caller is ${caller}`];
  return [];
}

/**
 * Validate and re-check a receipt (object or `ev:<id>`) for one claim. Throws a
 * coded error on any refusal; returns `{evidence, checks, cites}` for the
 * caller to store once its own action succeeded (so a claim the tool then
 * refuses leaves no receipt behind it). `o.claim` is the state the receipt
 * backs (its kind must fit, contracts/evidence-words.json); `o.subject` is the
 * claim's subject, which a cited id must match. A cite returns `cites: <id>`,
 * the SAME id: the caller logs the cite (recordCite) and mints nothing.
 */
export function checkEvidence(input, toolName, o = {}) {
  if (input === undefined || input === null) {
    throw evidenceError(EVIDENCE_CODES.REQUIRED, toolName, [
      'an `evidence` object is required (contracts/evidence.schema.json), or an ev:<id> from `node lib/evidence-cli.js record`',
    ]);
  }
  const shape = validateEvidence(input);
  if (!shape.ok) throw evidenceError(EVIDENCE_CODES.INVALID, toolName, shape.errors);
  if (typeof input === 'string') {
    const rec = readEvidence(input, o);
    if (!rec) throw evidenceError(EVIDENCE_CODES.UNKNOWN_REF, toolName, [`${input} is not a valid record in the evidence store`]);
    const mismatch = checkSubject(rec, o.subject, o.env);
    if (mismatch.length) throw evidenceError(EVIDENCE_CODES.SUBJECT_MISMATCH, toolName, mismatch);
    const c = checkCite(rec, o.claim, o);
    if (!c.ok) throw evidenceError(c.code, toolName, c.reasons);
    return { evidence: rec.evidence, checks: c.checks, cites: input };
  }
  if (!kindBacks(o.claim, input.kind)) {
    throw evidenceError(EVIDENCE_CODES.WRONG_KIND, toolName, [`${o.claim} takes ${kindsText(claimRule(o.claim))}, not ${input.kind}`]);
  }
  const v = verifyEvidence(input, o);
  if (!v.ok) throw evidenceError(v.code, toolName, v.reasons);
  return { evidence: input, checks: v.checks, cites: null };
}

// ---------------------------------------------------------------------------
// The requirement flag
// ---------------------------------------------------------------------------

let _warned = false;
/** @internal test seam */
export function _resetEvidenceWarning() { _warned = false; }

/**
 * True unless the workspace config sets `capabilities.evidence: false`. The
 * opt-out logs one WARNING per process (no silent degradation).
 */
export function evidenceRequired(config, root = '(this workspace)', warn = console.warn) {
  if (config?.capabilities?.evidence !== false) return true;
  if (!_warned) {
    _warned = true;
    warn(`[evidence] WARNING: capabilities.evidence is false in ${root}: state claims through record_completion, ` +
      'set_feature_status, complete_feature and approve_gate are UNCHECKED (no receipt is required or stored)');
  }
  return false;
}
