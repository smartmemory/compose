/**
 * ledger-records.js — every line of smart-memory-ops `coordination/ledger.md` as a Compose record (COMP-DOGFOOD-CUTOVER-1, row I of
 * COMP-DOGFOOD-1). Contract: contracts/ledger-record.schema.json.
 *
 * Store: <workspace>/.compose/data/ledger-records/<YYYY-MM-DD>.jsonl, one file per Asia/Singapore day (the row's `day`), one JSON row
 * per ledger line, in the order the writer sent them. A row is unique on (day, id): a dedup reads one day file, never the whole history,
 * and the fleet's feature-events.jsonl readers never see these rows. Writes take a mkdir lock (atomic on POSIX), as live-state.js does.
 *
 * Writer: smart-memory-ops `claude/scripts/ledger_compose.py` (ledger.py append and the ledger_push tick) through
 * lib/ledger-records-cli.js. Readers: that CLI's `list` (cutover_parity.py) and lib/checkin-cli.js.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_RECORD_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'ledger-record.schema.json');
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 1_500; // the ops caller cuts the whole call at 2 s; a held lock means the rows stay in its backlog
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SGT_OFFSET_MS = 8 * 3_600_000;

export class LedgerRecordsError extends Error {
  constructor(message, code) { super(message); this.name = 'LedgerRecordsError'; this.code = code; }
}

export function recordsDir(root) { return join(root, '.compose', 'data', 'ledger-records'); }

let _schema = null;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/; // ajv-formats date-time: seconds required
/**
 * `{ok, errors}` against contracts/ledger-record.schema.json, plus `at` falling on `day`. The contract is read and applied by hand
 * (required, additionalProperties false, const, enum, string pattern/minLength/maxLength in code points, boolean, date-time): importing
 * Ajv costs ~150-200 ms per CLI start, and every fleet ledger append waits on this CLI. test/ledger-records.test.js checks this agrees
 * with Ajv on the contract's fixtures.
 */
export function validateLedgerRecord(rec) {
  if (!_schema) _schema = JSON.parse(readFileSync(LEDGER_RECORD_SCHEMA_PATH, 'utf8'));
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, errors: ['(root) must be object'] };
  const errors = [];
  for (const k of _schema.required) if (!(k in rec)) errors.push(`(root) must have required property '${k}'`);
  for (const [k, v] of Object.entries(rec)) {
    const p = _schema.properties[k];
    if (!p) { errors.push(`(root) must NOT have additional property '${k}'`); continue; }
    if ('const' in p && v !== p.const) { errors.push(`/${k} must be equal to constant`); continue; }
    if (p.enum && !p.enum.includes(v)) { errors.push(`/${k} must be equal to one of the allowed values`); continue; }
    if (p.type === 'boolean' && typeof v !== 'boolean') { errors.push(`/${k} must be boolean`); continue; }
    if (p.type !== 'string') continue;
    if (typeof v !== 'string') { errors.push(`/${k} must be string`); continue; }
    const n = [...v].length;
    if (p.minLength !== undefined && n < p.minLength) errors.push(`/${k} must NOT have fewer than ${p.minLength} characters`);
    if (p.maxLength !== undefined && n > p.maxLength) errors.push(`/${k} must NOT have more than ${p.maxLength} characters`);
    if (p.pattern && !new RegExp(p.pattern, 'u').test(v)) errors.push(`/${k} must match pattern "${p.pattern}"`);
    if (p.format === 'date-time' && (!ISO_RE.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`/${k} must match format "date-time"`);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 8) };
  if (rec.at.slice(0, 10) !== rec.day) return { ok: false, errors: [`/at ${rec.at} is not on day ${rec.day}`] };
  return { ok: true, errors: [] };
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const start = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new LedgerRecordsError('ledger-records store is locked by another writer', 'locked');
      sleepSync(20);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Rows of one day file, oldest first. An unreadable row is skipped with a WARNING (it is never rewritten). */
function readDay(dir, day, warn) {
  const file = join(dir, `${day}.jsonl`);
  if (!existsSync(file)) return [];
  const out = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch { warn(`[ledger-records] WARNING ${day}.jsonl line ${i + 1} is not JSON, skipped`); }
  });
  return out;
}

/**
 * Validate, de-duplicate on (day, id) and append the records in the order given, under the store's lock.
 * -> `[{status: 'written'|'duplicate'|'invalid', id, day, errors?}]`, one per record. Throws LedgerRecordsError('locked') when the lock
 * is held past LOCK_WAIT_MS (nothing written; the caller keeps the rows and sends them again).
 */
export function recordLedgerLines(root, records, { now = new Date(), warn = console.warn } = {}) {
  const dir = recordsDir(root);
  return withLock(dir, () => {
    const seen = new Map(); // day -> Set(id)
    const results = [];
    for (const rec of records) {
      const v = validateLedgerRecord(rec);
      if (!v.ok) { results.push({ status: 'invalid', id: rec?.id ?? null, day: rec?.day ?? null, errors: v.errors }); continue; }
      if (!seen.has(rec.day)) seen.set(rec.day, new Set(readDay(dir, rec.day, warn).map((r) => r?.id)));
      const ids = seen.get(rec.day);
      if (ids.has(rec.id)) { results.push({ status: 'duplicate', id: rec.id, day: rec.day }); continue; }
      appendFileSync(join(dir, `${rec.day}.jsonl`), `${JSON.stringify({ ...rec, stored_at: now.toISOString() })}\n`);
      ids.add(rec.id);
      results.push({ status: 'written', id: rec.id, day: rec.day });
    }
    return results;
  });
}

/** The Asia/Singapore date of an instant. */
export function sgtDay(ms) { return new Date(ms + SGT_OFFSET_MS).toISOString().slice(0, 10); }

/**
 * Records whose `at` is in [since, until) (either bound optional, ISO or ms), oldest day first, each day in stored order.
 * Reads only the day files that can hold such a row.
 */
export function readLedgerRecords(root, { since, until, warn = console.warn } = {}) {
  const dir = recordsDir(root);
  if (!existsSync(dir)) return [];
  const lo = since === undefined || since === null ? null : (typeof since === 'number' ? since : Date.parse(since));
  const hi = until === undefined || until === null ? null : (typeof until === 'number' ? until : Date.parse(until));
  if (Number.isNaN(lo) || Number.isNaN(hi)) throw new LedgerRecordsError('since/until must be ISO date-times', 'invalid');
  const days = readdirSync(dir).map((f) => DAY_FILE_RE.exec(f)?.[1]).filter(Boolean).sort()
    .filter((d) => (lo === null || d >= sgtDay(lo)) && (hi === null || d <= sgtDay(hi)));
  const out = [];
  for (const day of days) {
    for (const r of readDay(dir, day, warn)) {
      const t = Date.parse(r?.at);
      if (Number.isNaN(t) || (lo !== null && t < lo) || (hi !== null && t >= hi)) continue;
      out.push(r);
    }
  }
  return out;
}
