/**
 * owner-gates.js — COMP-DOGFOOD-OWNER-QUEUE-1 (row F of COMP-DOGFOOD-1): the owner's open questions as ONE list of gates
 * (contracts/owner-gate.schema.json). Every "waiting on you" surface reads this module, so they cannot disagree:
 *   - the MCP `get_pending_gates` tool (server/compose-mcp-tools.js), beside the Compose policy gates;
 *   - `GET /api/fleet/owner-gates` and the `queue` panel of `GET /api/fleet` (server/fleet-routes.js), which the cockpit's
 *     `ownerAsks` reads (chip, WHAT line, NOW drawer);
 *   - the day ribbon's `ownerWaits` (server/ribbon-routes.js), for its open list;
 *   - `node lib/owner-gates-cli.js list` (s1-chat's lane).
 *
 * The owner queue (ops `claude/scripts/owner_queue.py`, `coordination/owner-queue.jsonl`) stays the ONLY writer: phone,
 * chat, digest, the cockpit and MCP all answer the same record, first answer wins. This module reads the file (latest
 * record per id) and, for an answer through MCP, runs `owner_queue.py close --channel mcp --if-version` with argv only.
 * An owner gate never expires (a Compose gate does, `isComposeGateExpired`). A queue that cannot be read is
 * `unreadable: true` with a WARNING, never an empty list.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { groupOf, stripTag } from './owner-queue-class.js';
import { optionsOf, choiceText } from './ask-options.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OWNER_GATE_SCHEMA_PATH = resolve(__dirname, '../contracts/owner-gate.schema.json');
export const OWNER_GATE_PREFIX = 'owner:';
/** An open owner question older than this renders red (sm_status.py OWNER_RED_AFTER, the panel this list replaces). */
export const OWNER_RED_AFTER_S = 3600;
export const OWNER_CLOSE_TIMEOUT_MS = 15_000;
const OPS_REL = join('reg', 'my', 'SmartMemory', 'smart-memory-ops');
const QUEUE_REL = join('coordination', 'owner-queue.jsonl');

export const OWNER_GATE_CODES = Object.freeze({
  STALE: 'OWNER_GATE_STALE', // answered or re-asked since the caller read it (first answer wins)
  OPTION: 'OWNER_GATE_OPTION', // the option is not one of the record's keys, or the question has none
  UNKNOWN: 'OWNER_GATE_UNKNOWN', // no open ask or security row with that id
  UNREADABLE: 'OWNER_GATE_UNREADABLE', // the queue file cannot be read or the close could not run
  SCRATCH_UNGUARDED: 'OWNER_GATE_SCRATCH_UNGUARDED', // a non-live queue with the real notify spool and outbox reachable
  SESSION: 'OWNER_GATE_SESSION', // the calling session is not on the list that may speak for the owner
});

/** Sessions that may answer an owner question through MCP when `ownerGateSessions` is not set in .compose/compose.json. */
export const DEFAULT_OWNER_GATE_SESSIONS = Object.freeze(['s1-chat']);

/**
 * The allow list: `ownerGateSessions` of the workspace config (an array of session names), else the default. A malformed
 * value falls back to the default with a WARNING (never to "anyone"); non-string and empty entries are dropped with one.
 * An explicit empty array means nobody.
 */
export function ownerGateSessions(config, warn = (m) => console.warn(m)) {
  const raw = config?.ownerGateSessions;
  if (raw === undefined || raw === null) return [...DEFAULT_OWNER_GATE_SESSIONS];
  if (!Array.isArray(raw)) {
    warn(`[owner-gates] WARNING ownerGateSessions in .compose/compose.json is not an array of session names; using the default ${JSON.stringify(DEFAULT_OWNER_GATE_SESSIONS)}`);
    return [...DEFAULT_OWNER_GATE_SESSIONS];
  }
  const names = raw.filter((n) => typeof n === 'string' && n.length > 0);
  if (names.length !== raw.length) warn(`[owner-gates] WARNING ownerGateSessions had ${raw.length - names.length} entry(ies) that are not non-empty strings; they were dropped`);
  return names;
}

/** Throws OWNER_GATE_SESSION unless `session` (COMPOSE_SESSION_NAME) is on the allow list. Returns the session name. */
export function assertOwnerGateSession(session, config, warn) {
  const list = ownerGateSessions(config, warn);
  if (typeof session === 'string' && session && list.includes(session)) return session;
  throw gateError(OWNER_GATE_CODES.SESSION, `session ${session ? JSON.stringify(session) : 'unnamed (COMPOSE_SESSION_NAME is unset)'} may not answer an owner question; allowed: ${list.length ? list.join(', ') : '(none)'} (ownerGateSessions in .compose/compose.json)`);
}

function gateError(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.code = code;
  return e;
}

const expandHome = (p, env) => (p === '~' || p.startsWith('~/') ? join(env.HOME || homedir(), p.slice(1)) : p);

/**
 * The owner-queue file, resolved from `env` like the readers it replaces: Compose's own override, the ribbon's override, the
 * queue script's own `$SM_OWNER_QUEUE`, the ops root of `COMPOSE_PROCESS_QUEUES_DIR` (the ribbon's `opsRoot`), else
 * `$HOME/reg/my/SmartMemory/smart-memory-ops/coordination/owner-queue.jsonl` (owner_queue.py's DEFAULT). An env with none of
 * these (no HOME) resolves to null: the caller says so, it never guesses the live file.
 */
export function resolveOwnerQueueFile(env = process.env) {
  const direct = env.COMPOSE_OWNER_QUEUE_FILE || env.COMPOSE_RIBBON_OWNER_QUEUE || env.SM_OWNER_QUEUE;
  if (direct) return expandHome(direct, env);
  if (env.COMPOSE_PROCESS_QUEUES_DIR) return join(dirname(expandHome(env.COMPOSE_PROCESS_QUEUES_DIR, env)), QUEUE_REL);
  return env.HOME ? join(env.HOME, OPS_REL, QUEUE_REL) : null;
}

/** `{python, script}` for owner_queue.py, with the fleet route's overrides (COMPOSE_FLEET_PYTHON, COMPOSE_FLEET_OWNER_QUEUE). */
export function resolveOwnerQueueScript(env = process.env) {
  return {
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_FLEET_OWNER_QUEUE || join(env.HOME || homedir(), '.claude', 'scripts', 'owner_queue.py'),
  };
}

/**
 * The record's precondition token exactly as `notify_client.version_of` makes it: `json.dumps(rec['ts'])`. Python prints a
 * float `1790000000.0` with its `.0` and an int without, which JSON.parse cannot tell apart, so the raw `ts` token of the
 * line decides. Shortest round-trip digits are the same in both languages for any `time.time()` value.
 */
export function versionOf(rec, line = null) {
  const ts = rec?.ts;
  const token = (typeof line === 'string' ? /"ts":\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line)?.[1] : null) ?? null;
  if (token && !/[.eE]/.test(token)) return token;
  if (token && Number.isInteger(ts) && Math.abs(ts) < 1e16) return `${ts}.0`;
  return String(ts);
}

/** JSONL text -> `{records: Map<id, {rec, line}>, bad}` (latest record per id, like owner_queue.py `read`). */
export function foldQueueText(text) {
  const records = new Map();
  let bad = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { bad += 1; continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.id !== 'string') { bad += 1; continue; }
    records.set(rec.id, { rec, line });
  }
  return { records, bad };
}

/** Parsed records (the ribbon's reader) -> the same fold; with no raw line, `versionOf` falls back to `String(ts)`. */
export function foldQueueRecords(list) {
  const records = new Map();
  for (const rec of list ?? []) if (rec && typeof rec === 'object' && typeof rec.id === 'string') records.set(rec.id, { rec, line: null });
  return { records, bad: 0 };
}

/** True for a record that waits on the owner: open, a real time, text, and an `asks` or `security` row (`groupOf`). */
export function isOwnerGateRecord(rec) {
  if (!rec || rec.status !== 'open' || typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || typeof rec.text !== 'string') return false;
  const g = groupOf(rec.text);
  return g === 'asks' || g === 'security';
}

const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

/** One open record -> the contract object. */
export function ownerGateOf(rec, line = null, now = Date.now()) {
  return {
    id: `${OWNER_GATE_PREFIX}${rec.id}`,
    qid: rec.id,
    kind: 'owner',
    status: 'pending',
    group: groupOf(rec.text),
    summary: stripTag(rec.text),
    text: rec.text,
    by: strOrNull(rec.by),
    unit: strOrNull(rec.unit),
    severity: strOrNull(rec.severity),
    post_id: strOrNull(rec.post_id),
    options: optionsOf(rec).map((o) => ({ key: o.value, label: o.label })),
    recommended: strOrNull(rec.default),
    version: versionOf(rec, line),
    opened_at: new Date(rec.ts * 1000).toISOString(),
    age_s: Math.max(0, Math.round(now / 1000 - rec.ts)),
    source: 'owner-queue',
  };
}

/** A fold -> the open owner gates: security first, then oldest first (the `ownerAsks` order). */
export function ownerGatesOf(fold, now = Date.now()) {
  const out = [];
  for (const { rec, line } of fold.records.values()) if (isOwnerGateRecord(rec)) out.push(ownerGateOf(rec, line, now));
  const rank = (g) => (g.group === 'security' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.age_s - a.age_s);
}

let _validate = null;
/** Ajv validator for contracts/owner-gate.schema.json (compiled once). */
export function validateOwnerGate(gate) {
  if (!_validate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    _validate = ajv.compile(JSON.parse(readFileSync(OWNER_GATE_SCHEMA_PATH, 'utf8')));
  }
  const ok = _validate(gate);
  return { ok, errors: ok ? [] : (_validate.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
}

/**
 * THE list. `{file, count, gates, warnings?}`, or `{file, unreadable: true, error, count: null, gates: null}` with a WARNING
 * when the queue cannot be read (a missing file included: sm_status's rule, unknown is never zero). Unreadable lines are
 * skipped with a warning (they may hide an open question); a gate that fails the contract is dropped with a warning.
 */
export function readOwnerGates({ file, env = process.env, now = Date.now(), warn = console.warn } = {}) {
  const path = file ?? resolveOwnerQueueFile(env);
  const unreadable = (error) => {
    warn(`[owner-gates] WARNING ${error}: the owner's open questions are unknown, not zero`);
    return { file: path, unreadable: true, error, count: null, gates: null };
  };
  if (!path) return unreadable('no owner queue path (set COMPOSE_OWNER_QUEUE_FILE or HOME)');
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return unreadable(`owner queue ${path} unreadable (${e?.code ?? e?.message ?? e})`); }
  const fold = foldQueueText(text);
  const warnings = [];
  if (fold.bad) warnings.push(`owner queue ${path}: ${fold.bad} unreadable line(s) skipped, open owner questions may be missing`);
  const gates = [];
  for (const g of ownerGatesOf(fold, now)) {
    const v = validateOwnerGate(g);
    if (v.ok) gates.push(g);
    else warnings.push(`owner gate ${g.id} dropped, it fails contracts/owner-gate.schema.json: ${v.errors.slice(0, 3).join('; ')}`);
  }
  for (const w of warnings) warn(`[owner-gates] WARNING ${w}`);
  return { file: path, count: gates.length, gates, ...(warnings.length ? { warnings } : {}) };
}

/**
 * The list as the sm_status `queue` panel the cockpit reads (`{value: rows, error, ts}`; a row is
 * `{id, by, text, age, error, red, options?, default?, severity?, post_id?}`, sm_status.py `parse_queue`'s shape), so
 * `ownerAsks` and its callers read it unchanged. Unreadable -> `value: null` with the error (the cockpit shows unknown).
 */
export function panelOf(result, now = Date.now()) {
  const ts = new Date(now).toISOString();
  if (!result || result.unreadable) return { value: null, error: result?.error ?? 'owner queue unreadable', ts, source: 'owner-gates' };
  const rows = result.gates.map((g) => ({
    id: g.qid, by: g.by ?? '?', text: g.text, age: g.age_s, error: null, red: g.age_s > OWNER_RED_AFTER_S,
    ...(g.options.length ? { options: g.options.map((o) => ({ value: o.key, label: o.label })) } : {}),
    ...(g.recommended ? { default: g.recommended } : {}),
    ...(g.severity ? { severity: g.severity } : {}),
    ...(g.post_id ? { post_id: g.post_id } : {}),
  }));
  return { value: rows, error: null, ts, source: 'owner-gates', ...(result.warnings ? { warnings: result.warnings.slice(0, 5).map((w) => w.slice(0, 200)) } : {}) };
}

/**
 * The sm_status `queue` panel the cockpit reads, built from EVERY open record of the fold (what sm_status.py `parse_queue`
 * kept), not only the asks and security rows `panelOf` takes: the inbox drawer groups the same list into Security, Asks,
 * Decided for you and FYI, and `ownerAsks` filters the count itself. Oldest first. A record with no usable `ts` stays as a
 * red row with an error, never dropped (it may be an open question). Unreadable -> `value: null` with the error.
 */
export function readOpenQueuePanel({ file, env = process.env, now = Date.now(), warn = console.warn } = {}) {
  const path = file ?? resolveOwnerQueueFile(env);
  const ts = new Date(now).toISOString();
  const unreadable = (error) => {
    warn(`[owner-gates] WARNING ${error}: the owner's open questions are unknown, not zero`);
    return { value: null, error, ts, source: 'owner-gates' };
  };
  if (!path) return unreadable('no owner queue path (set COMPOSE_OWNER_QUEUE_FILE or HOME)');
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return unreadable(`owner queue ${path} unreadable (${e?.code ?? e?.message ?? e})`); }
  const fold = foldQueueText(text);
  const rows = [];
  for (const { rec } of fold.records.values()) {
    if (rec.status !== 'open') continue;
    const okTs = typeof rec.ts === 'number' && Number.isFinite(rec.ts);
    const age = okTs ? Math.max(0, Math.round(now / 1000 - rec.ts)) : null;
    const options = optionsOf(rec);
    rows.push({
      id: rec.id, by: strOrNull(rec.by) ?? '?', text: typeof rec.text === 'string' ? rec.text : '', age,
      error: okTs ? null : `ts ${JSON.stringify(rec.ts)} is not a time`, red: age === null || age > OWNER_RED_AFTER_S,
      ...(options.length ? { options: options.map((o) => ({ value: o.value, label: o.label })) } : {}),
      ...(strOrNull(rec.default) ? { default: rec.default } : {}),
      ...(strOrNull(rec.severity) ? { severity: rec.severity } : {}),
      ...(strOrNull(rec.post_id) ? { post_id: rec.post_id } : {}),
    });
  }
  rows.sort((a, b) => (b.age ?? Infinity) - (a.age ?? Infinity) || a.id.localeCompare(b.id));
  let warnings;
  if (fold.bad) {
    const w = `owner queue ${path}: ${fold.bad} unreadable line(s) skipped, open owner questions may be missing`;
    warn(`[owner-gates] WARNING ${w}`);
    warnings = [w];
  }
  return { value: rows, error: null, ts, source: 'owner-gates', ...(warnings ? { warnings } : {}) };
}

/** A Compose policy gate past the lazy-expiry timeout (the HTTP routes' rule). An owner gate never expires. */
export function isComposeGateExpired(gate, now, timeoutMs) {
  if (!gate || gate.kind === 'owner' || gate.status !== 'pending') return false;
  const created = Date.parse(gate.createdAt);
  return Number.isFinite(created) && now - created > timeoutMs;
}

/**
 * Answer one owner gate with one of its options, through the queue's own writer:
 * `owner_queue.py --file <queue> close <qid> --answer "OWNER (via mcp): (<key>) <label>" --channel mcp --if-version <v>`.
 * Refuses OWNER_GATE_UNKNOWN (no open ask/security row), OWNER_GATE_STALE (already answered, or `version` given and moved,
 * or the queue refused the close as stale or already answered), OWNER_GATE_OPTION (no options, or `option` not a key).
 * Returns `{gateId, qid, option, answer, file, line}`: `line` is the closed record's line the close wrote (for the receipt).
 */
export function closeOwnerGate({ gateId, option, version, file, env = process.env, now = Date.now() } = {}) {
  if (typeof gateId !== 'string' || !gateId.startsWith(OWNER_GATE_PREFIX) || gateId.length <= OWNER_GATE_PREFIX.length) {
    throw gateError(OWNER_GATE_CODES.UNKNOWN, `${JSON.stringify(gateId)} is not an owner gate id (owner:<qid>)`);
  }
  const qid = gateId.slice(OWNER_GATE_PREFIX.length);
  // argv only, but argparse would still read a leading `-` as a flag (the cockpit's answer route refuses it the same way)
  if (qid.startsWith('-') || qid.length > 200) throw gateError(OWNER_GATE_CODES.UNKNOWN, 'an owner gate id must be owner:<qid>, the qid 1 to 200 characters and not starting with -');
  const path = file ?? resolveOwnerQueueFile(env);
  if (!path) throw gateError(OWNER_GATE_CODES.UNREADABLE, 'no owner queue path (set COMPOSE_OWNER_QUEUE_FILE or HOME)');
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw gateError(OWNER_GATE_CODES.UNREADABLE, `owner queue ${path} unreadable (${e?.code ?? e?.message ?? e})`); }
  const hit = foldQueueText(text).records.get(qid);
  if (!hit) throw gateError(OWNER_GATE_CODES.UNKNOWN, `no owner question ${qid}`);
  if (hit.rec.status === 'closed') {
    throw gateError(OWNER_GATE_CODES.STALE, `${qid} was already answered${hit.rec.answer_channel ? ` in ${hit.rec.answer_channel}` : ''} (first answer wins): ${String(hit.rec.answer ?? '').slice(0, 160)}`);
  }
  if (!isOwnerGateRecord(hit.rec)) throw gateError(OWNER_GATE_CODES.UNKNOWN, `${qid} is not an open ask or security row`);
  const gate = ownerGateOf(hit.rec, hit.line, now);
  if (version !== undefined && version !== null && String(version) !== gate.version) {
    throw gateError(OWNER_GATE_CODES.STALE, `${qid} was re-asked since version ${version} (now ${gate.version}); read get_pending_gates again`);
  }
  if (!gate.options.length) {
    throw gateError(OWNER_GATE_CODES.OPTION, `${qid} has no options; it takes a written answer (chat, phone or the cockpit), not approve_gate`);
  }
  const chosen = gate.options.find((o) => o.key === option);
  if (!chosen) {
    throw gateError(OWNER_GATE_CODES.OPTION, `option ${JSON.stringify(option)} is not one of ${qid}'s keys: ${gate.options.map((o) => o.key).join(', ')}`);
  }
  const answer = `OWNER (via mcp): ${choiceText({ value: chosen.key, label: chosen.label })}`;
  const { python, script } = resolveOwnerQueueScript(env);
  if (!existsSync(script)) throw gateError(OWNER_GATE_CODES.UNREADABLE, `owner_queue.py not found at ${script}`);
  // `--file` skips owner_queue.py's scratch-queue guard, which keys on $SM_OWNER_QUEUE (the 2026-11-02 TEST-ASK leak): name the
  // queue there too, and refuse a non-live queue when the real notify spool and chat outbox are not redirected.
  const liveQueue = resolve(join(env.HOME || homedir(), OPS_REL, QUEUE_REL));
  if (resolve(path) !== liveQueue && !env.NOTIFY_SPOOL && !env.OWNER_QUEUE_OUTBOX) {
    throw gateError(OWNER_GATE_CODES.SCRATCH_UNGUARDED, `${path} is not the live owner queue and neither NOTIFY_SPOOL nor OWNER_QUEUE_OUTBOX is set, so this close could announce into the live owner channels; set both (or a scratch HOME) for a scratch queue`);
  }
  const run = spawnSync(python, [script, '--file', path, 'close', qid, '--answer', answer, '--channel', 'mcp', '--if-version', gate.version], {
    env: { ...env, SM_OWNER_QUEUE: path }, encoding: 'utf8', timeout: OWNER_CLOSE_TIMEOUT_MS, shell: false,
  });
  const why = String(run.stderr ?? '').trim().split('\n').filter((l) => !/WARNING/.test(l)).pop() ?? '';
  if (run.error || run.status !== 0) {
    if (run.status === 1 && /refused (stale|already_answered)/.test(why)) throw gateError(OWNER_GATE_CODES.STALE, why.slice(0, 300));
    throw gateError(OWNER_GATE_CODES.UNREADABLE, `owner_queue.py close failed (${run.error?.code ?? `exit ${run.status}`}${why ? `: ${why.slice(0, 200)}` : ''})`);
  }
  let line = null;
  try {
    for (const l of readFileSync(path, 'utf8').split('\n')) {
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (r?.id === qid && r.status === 'closed' && r.answer === answer && r.answer_channel === 'mcp') line = l;
    }
  } catch { line = null; }
  return { gateId, qid, option: chosen.key, answer, file: path, line };
}
