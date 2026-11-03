/**
 * launch-events.js — every detached launch, gate refusal, retry-queue entry and hop-governor order as a Compose event
 * (COMP-DOGFOOD-LAUNCH-GATE-1, row C of COMP-DOGFOOD-1). Contract: contracts/launch-events.schema.json.
 *
 * Writers: smart-memory-ops `claude/scripts/launch_events.py` (called by detach_job.py) through lib/launch-events-cli.js,
 * and `ingestGovernorLog` below for hop_governor.py's tick log (the governor itself is not edited: its log is the record).
 * Both go through feature-events.js `appendEvent`, the one writer of `<workspace>/.compose/data/feature-events.jsonl`.
 * No model writes any of these states: `launch.running` is stored only after A's `process` re-check (lib/evidence.js) passed.
 *
 * Readers: the Day ribbon route (refused markers, the queue count, hop rows) and `GET /api/launch-queue`.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { appendEvent, readEvents } from './feature-events.js';

export const LAUNCH_EVENTS_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'launch-events.schema.json');
export const LAUNCH_TOOLS = ['launch.requested', 'launch.running', 'launch.refused', 'launch.failed', 'launch.queued', 'launch.dequeued'];
export const HOP_TOOLS = ['hop.order', 'hop.outcome'];
/** A queue entry whose meter freed this long ago with no relaunch is reported as expired, not counted. */
export const QUEUE_EXPIRE_MS = 6 * 3_600_000;
const GATE_PREFIX = 'WORK MODEL GATE (claude shim): ';
const SHORT_MAX = 90;

let _ajv = null;
let _id = null;
/**
 * `{ok, errors}` against contracts/launch-events.schema.json. A known `tool` is checked against its own definition, so the errors
 * name what that kind is missing: Ajv inlines the oneOf's `$ref`s, so the whole-schema errors carry no definition name to filter
 * by, and a refusal without its gate line would otherwise read as a launch.requested missing `engine` and `pid`.
 */
export function validateLaunchEvent(ev) {
  if (!_ajv) {
    _ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(_ajv);
    const schema = JSON.parse(readFileSync(LAUNCH_EVENTS_SCHEMA_PATH, 'utf8'));
    _ajv.addSchema(schema);
    _id = schema.$id;
  }
  const tool = ev && typeof ev === 'object' ? ev.tool : undefined;
  const known = LAUNCH_TOOLS.includes(tool) || HOP_TOOLS.includes(tool);
  const validate = _ajv.getSchema(known ? `${_id}#/definitions/${tool}` : _id);
  if (validate(ev)) return { ok: true, errors: [] };
  return { ok: false, errors: [...new Set((validate.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`))].slice(0, 8) };
}

/** The workspace's launch and hop events, oldest first. */
export function readLaunchEvents(root) {
  return readEvents(root).filter((e) => typeof e?.tool === 'string' && (e.tool.startsWith('launch.') || e.tool.startsWith('hop.')));
}

/**
 * Validate, de-duplicate on `idempotency_key` and append one event. A `launch.running` row with a `receipt` is re-checked first
 * (`deps.check(receipt)` -> `{evidence_id}` or throws with `reasons`): a refused re-check is not stored unless the row is a replay,
 * which is kept with `evidence_id: null` and `evidence_refused` (never dropped; readers do not count it as running).
 * -> `{status: 'written'|'duplicate'|'invalid'|'refused', row?, errors?}`.
 */
export function recordLaunchEvent(root, ev, deps = {}) {
  const v = validateLaunchEvent(ev);
  if (!v.ok) return { status: 'invalid', errors: v.errors };
  if (readEvents(root).some((r) => r?.idempotency_key === ev.idempotency_key)) return { status: 'duplicate' };
  let row = { ...ev, actor: ev.source };
  if (ev.tool === 'launch.running') {
    try {
      row = { ...row, evidence_id: deps.check(ev.receipt).evidence_id };
    } catch (e) {
      const reasons = e?.reasons || [String(e?.message ?? e)];
      if (!ev.replayed) return { status: 'refused', errors: reasons };
      row = { ...row, evidence_id: null, evidence_refused: reasons };
    }
  }
  return { status: 'written', row: appendEvent(root, row) };
}

// ---------------------------------------------------------------- hop-governor log ingest

const LOG_LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d),(\d{3}) INFO hop_governor: (DRY|LIVE) (.*)$/;

/**
 * hop_governor.py's tick log (`<local time>,<ms> INFO hop_governor: <DRY|LIVE> <line>`, hop_governor.py main) -> hop events.
 * Orders (`HOP`, `DRY HOP`) and outcomes (`HOPPED`, `HOP-UNCONFIRMED`, `HOP-FAILED`, `CANCEL`) only: STAY/WAIT/SKIP repeat
 * every 5 min and carry no state change; `DRY RUN-HOP` repeats every tick while a dry order stands, so it is left out too.
 */
export function parseGovernorLog(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = LOG_LINE.exec(raw);
    if (!m) continue;
    const at = new Date(`${m[1]}T${m[2]}.${m[3]}`); // the governor logs local time with no offset
    if (Number.isNaN(at.getTime())) continue;
    const mode = m[4] === 'LIVE' ? 'live' : 'dry';
    const line = m[5].replace(/^DRY (?=HOP )/, '');
    const iso = at.toISOString();
    const base = { source: 'hop-governor', ts: iso, at: iso, mode, line: m[5].slice(0, 2000) };
    let r;
    if ((r = /^HOP (\S+) -> (\S+) \((.*)\)$/.exec(line))) {
      out.push({ ...base, tool: 'hop.order', session: r[1], target: r[2], why: r[3].slice(0, 2000), lane: null, idempotency_key: `hop.order:${iso}:${r[1]}:${r[2]}` });
    } else if ((r = /^HOPPED (\S+) (\S+) -> (\S+) confirmed: (.*)$/.exec(line))) {
      const np = /new pid (\d+)/.exec(r[4]);
      const op = /old pid\(s\) ([\d, ]+) gone/.exec(r[4]);
      out.push({ ...base, tool: 'hop.outcome', outcome: 'hopped', session: r[1], from: r[2], target: r[3], new_pid: np ? Number(np[1]) : null,
        old_pids: op ? op[1].split(',').map((s) => Number(s.trim())).filter(Number.isInteger) : [], lane: null, idempotency_key: `hop.outcome:${iso}:${r[1]}:hopped` });
    } else if ((r = /^HOP-UNCONFIRMED (\S+) (\S+) -> (\S+): /.exec(line))) {
      out.push({ ...base, tool: 'hop.outcome', outcome: 'unconfirmed', session: r[1], from: r[2], target: r[3], lane: null, idempotency_key: `hop.outcome:${iso}:${r[1]}:unconfirmed` });
    } else if ((r = /^HOP-FAILED (\S+) -> (\S+): /.exec(line))) {
      out.push({ ...base, tool: 'hop.outcome', outcome: 'failed', session: r[1], from: null, target: r[2], lane: null, idempotency_key: `hop.outcome:${iso}:${r[1]}:failed` });
    } else if ((r = /^CANCEL (\S+) order -> (\S+) /.exec(line))) {
      out.push({ ...base, tool: 'hop.outcome', outcome: 'cancel', session: r[1], from: null, target: r[2], lane: null, idempotency_key: `hop.outcome:${iso}:${r[1]}:cancel` });
    }
  }
  return out;
}

/**
 * Append the governor log's new orders and outcomes since the last read. The cursor (`{ino, offset}`) lives in
 * `<root>/.compose/data/hop-governor.cursor.json`; a rotated or truncated log restarts at 0 and the idempotency keys keep it
 * from writing a row twice. Only whole lines are consumed. -> `{written, duplicate, invalid: [..]}`.
 */
export function ingestGovernorLog(root, logPath, { warn = console.warn } = {}) {
  const cursorPath = join(root, '.compose', 'data', 'hop-governor.cursor.json');
  let cursor = { ino: null, offset: 0 };
  try { cursor = { ...cursor, ...JSON.parse(readFileSync(cursorPath, 'utf8')) }; } catch { /* first run */ }
  const res = { written: 0, duplicate: 0, invalid: [] };
  if (!existsSync(logPath)) return res;
  const fd = openSync(logPath, 'r');
  let text;
  let ino;
  let size;
  try {
    const st = fstatSync(fd);
    ino = st.ino;
    size = st.size;
    if (cursor.ino !== ino || cursor.offset > size) cursor = { ino, offset: 0 };
    const buf = Buffer.alloc(size - cursor.offset);
    readSync(fd, buf, 0, buf.length, cursor.offset);
    text = buf.toString('utf8');
  } finally { closeSync(fd); }
  const end = text.lastIndexOf('\n') + 1;
  for (const ev of parseGovernorLog(text.slice(0, end))) {
    const r = recordLaunchEvent(root, ev);
    if (r.status === 'written') res.written += 1;
    else if (r.status === 'duplicate') res.duplicate += 1;
    else { res.invalid.push(`${ev.line.slice(0, 80)}: ${r.errors.join('; ')}`); warn(`[launch-events] WARNING governor line not stored (${r.errors.join('; ')}): ${ev.line.slice(0, 120)}`); }
  }
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, JSON.stringify({ ino, offset: cursor.offset + Buffer.byteLength(text.slice(0, end)) }));
  return res;
}

// ---------------------------------------------------------------- readers (pure)

const ms = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const evMs = (e) => ms(e.at) ?? ms(e.launched_at) ?? ms(e.ts);
const counted = (e) => e.tool !== 'launch.running' || (typeof e.evidence_id === 'string' && e.evidence_id.startsWith('ev:'));

/** The gate line without the shim prefix, parentheses or the advice after the first sentence: `SEAT CEILING GATE: seat4 5h used 86% >= its ceiling 70%, resets ...`. */
export function shortGate(line) {
  let s = String(line ?? '').replace(GATE_PREFIX, '');
  for (let i = 0; i < 4; i++) s = s.replace(/\s*\([^()]*\)/g, '');
  s = s.replace(/target account /g, '').replace(/\s+,/g, ',').split(/\.\s/)[0].trim();
  return s.length > SHORT_MAX ? `${s.slice(0, SHORT_MAX - 1)}…` : s;
}

/**
 * The retry queue: per launch mark, the newest `launch.queued` that nothing closed. Closed by a later counted `launch.running`
 * of the same mark, a `launch.dequeued`, a later `launch.requested` of the same label or of a `<label>-W<n>` reroute (job_wall), or
 * a newer `launch.queued` of the same mark (it replaces it). Open past its `frees_at` (else its `at`) + 6 h with no relaunch: expired.
 * -> `{count, labels, entries, expired}` (entries newest first).
 */
export function retryQueue(events, now) {
  const sorted = [...events].sort((a, b) => (evMs(a) ?? 0) - (evMs(b) ?? 0));
  const open = new Map();
  for (const e of sorted) {
    if (e.tool === 'launch.queued') { open.set(e.mark, e); continue; }
    if (e.tool === 'launch.dequeued' || (e.tool === 'launch.running' && counted(e))) { open.delete(e.mark); continue; }
    if (e.tool === 'launch.requested') {
      for (const [mark, q] of open) {
        if (mark !== e.mark && (e.label === q.label || new RegExp(`^${q.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-W\\d+$`).test(e.label))) open.delete(mark);
      }
    }
  }
  const entries = [];
  const expired = [];
  for (const q of open.values()) {
    const row = { label: q.label, mark: q.mark, session: q.session, unit: q.unit ?? null, seat: q.seat ?? null, meter: q.meter, at: q.at,
      frees_at: q.frees_at ?? null, frees_at_source: q.frees_at_source, retry: q.retry, attempt: q.attempt, retry_max: q.retry_max, gate_line: q.gate_line };
    const base = ms(q.frees_at) ?? ms(q.at);
    (base !== null && now - base > QUEUE_EXPIRE_MS ? expired : entries).push(row);
  }
  entries.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  return { count: entries.length, labels: entries.map((e) => e.label), entries, expired };
}

/**
 * Units whose newest launch outcome is a refusal or an early failure (no counted `launch.running` and no newer `launch.requested`
 * after it): `Map(unit -> refusal ms)`. The ribbon never draws such a unit as the lane's running one.
 */
export function blockedUnits(events) {
  const last = new Map();
  for (const e of [...events].sort((a, b) => (evMs(a) ?? 0) - (evMs(b) ?? 0))) {
    if (!e.unit || !['launch.requested', 'launch.running', 'launch.refused', 'launch.failed'].includes(e.tool) || !counted(e)) continue;
    last.set(e.unit, e);
  }
  const out = new Map();
  for (const [unit, e] of last) if (e.tool === 'launch.refused' || e.tool === 'launch.failed') out.set(unit, evMs(e));
  return out;
}

/** A lane for an event: its unit's lane, else a lane among the dash-separated words of its session (`forge-main` -> forge), else null. */
export function laneOfLaunch(e, { laneOfUnit, lanes }) {
  const byUnit = e.unit ? laneOfUnit.get(e.unit) : undefined;
  if (byUnit && lanes.includes(byUnit)) return byUnit;
  if (e.lane && lanes.includes(e.lane)) return e.lane;
  for (const tok of String(e.session ?? '').split('-')) if (lanes.includes(tok)) return tok;
  return null;
}

/**
 * Put the launch events on a built ribbon body (mutates and returns it): a `refused` mark per `launch.refused` in the window on
 * the job's lane (else the ops row, `laneGuess: true`), a `hops` list per lane (governor orders and outcomes), and
 * `body.launches = {queue}`. A lane with no unit row has nowhere to draw: such an event lands on ops, said in its `why`.
 */
export function applyLaunchFeed(body, events, { units = [], from, to, now }) {
  const lanes = body.lanes.map((l) => l.lane);
  const laneOfUnit = new Map(units.map((u) => [u.id, u.lane]));
  const fallback = lanes.includes('ops') ? 'ops' : (lanes[0] ?? null);
  const row = (lane) => body.lanes.find((l) => l.lane === lane);
  for (const l of body.lanes) l.hops = [];
  for (const e of events) {
    const t = evMs(e);
    if (t === null || t < from || t > to) continue;
    const named = laneOfLaunch(e, { laneOfUnit, lanes });
    const lane = named ?? fallback;
    if (lane === null) continue;
    if (e.tool === 'launch.refused') {
      const short = shortGate(e.gate_line);
      const r = row(lane);
      r.marks.push({ kind: 'refused', at: new Date(t).toISOString(), unit: e.unit ?? null, title: e.label, label: e.label, text: `refused: ${short}`,
        full: e.gate_line, reverse: null, source: 'launch-events', laneGuess: !named, attempt: e.attempt ?? 0 });
      r.marks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      r.idle = false;
    } else if (e.tool === 'hop.order' || e.tool === 'hop.outcome') {
      row(lane).hops.push({ kind: e.tool === 'hop.order' ? 'order' : e.outcome, at: new Date(t).toISOString(), session: e.session, target: e.target ?? null,
        mode: e.mode, line: e.line, laneGuess: !named });
    }
  }
  body.launches = { queue: retryQueue(events, now) };
  return body;
}
