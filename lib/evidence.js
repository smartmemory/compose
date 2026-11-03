/**
 * lib/evidence.js — COMP-DOGFOOD-EVIDENCE-GATE-1: no state claim without a
 * receipt the server can check (row A of COMP-DOGFOOD-1).
 *
 * The contract is contracts/evidence.schema.json. This module is its three
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { gitCommitExists } from '../server/lifecycle-guard.js';
import { decodePng, pngSize } from './evidence-png.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_SCHEMA_PATH = resolve(__dirname, '../contracts/evidence.schema.json');

/** A `process` receipt is checked at launch + this or later; before it the pid line proves nothing. */
export const PROCESS_MIN_AGE_MS = 120_000;
/** A pid whose start time is further than this from the claimed launch is a reused pid. */
export const PID_START_SKEW_MS = 120_000;
/** A file receipt's mtime may be this much older than its claimed `at` (and `at` this much in the future). */
export const FILE_MTIME_SKEW_MS = 120_000;
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
function validator() {
  if (_validate) return _validate;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  _validate = ajv.compile(JSON.parse(readFileSync(EVIDENCE_SCHEMA_PATH, 'utf8')));
  return _validate;
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

/** `ps -p` for one pid: alive and (when readable) its start time. */
export function psProbe(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || !out) return { alive: false };
  const t = Date.parse(out);
  return { alive: true, startedAt: Number.isFinite(t) ? t : null };
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
  if (st.mtimeMs < claimed - FILE_MTIME_SKEW_MS) {
    reasons.push(`${path} was last written ${new Date(st.mtimeMs).toISOString()}, older than the claimed at ${at} minus ${FILE_MTIME_SKEW_MS / 1000} s`);
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
  const reasons = [];
  const checks = [];
  switch (ev.kind) {
    case 'sha': {
      if (!existsSync(ev.repo)) reasons.push(`repo ${ev.repo} does not exist`);
      else if (!gitExists(ev.sha, ev.repo)) reasons.push(`commit ${ev.sha} not found in ${ev.repo} (git rev-parse --verify ${ev.sha}^{commit})`);
      else checks.push(`commit ${ev.sha} exists in ${ev.repo}`);
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
      } else if (p.startedAt == null) {
        checks.push(`pid ${ev.pid} alive; start time unreadable, reuse not checked`);
      } else if (Math.abs(p.startedAt - launched) > PID_START_SKEW_MS) {
        reasons.push(`pid ${ev.pid} started ${new Date(p.startedAt).toISOString()}, not at the claimed launch ${ev.launched_at}: a reused pid, not ${ev.label}`);
      } else {
        checks.push(`pid ${ev.pid} alive at launch + ${Math.round(age / 1000)} s`);
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

/** The stored record for an `ev:<id>`, or null. A plain scan: the store is append-only JSONL. */
export function readEvidence(id, { store = evidenceStorePath() } = {}) {
  if (!EVIDENCE_REF_RE.test(id || '') || !existsSync(store)) return null;
  const needle = `"id":"${id}"`;
  for (const line of readFileSync(store, 'utf8').split('\n')) {
    if (!line.includes(needle)) continue;
    try { const r = JSON.parse(line); if (r.id === id) return r; } catch { /* a torn line is skipped */ }
  }
  return null;
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

/** Append an accepted receipt; returns the record (with its new id). */
export function recordEvidence(evidence, { checks = [], subject, store = evidenceStorePath(), now = Date.now() } = {}) {
  const record = { id: `ev:${randomBytes(8).toString('hex')}`, evidence, checked_at: new Date(now).toISOString(), checks };
  if (subject) record.subject = subject;
  mkdirSync(dirname(store), { recursive: true });
  appendFileSync(store, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

/**
 * Validate and re-check a receipt (object or `ev:<id>`). Throws a coded error
 * on any refusal; returns `{evidence, checks, cites}` for the caller to store
 * once its own action succeeded (so a claim the tool then refuses leaves no
 * receipt behind it).
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
    if (!rec) throw evidenceError(EVIDENCE_CODES.UNKNOWN_REF, toolName, [`${input} is not in the evidence store`]);
    return { evidence: rec.evidence, checks: [`cites ${input}`], cites: input };
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
