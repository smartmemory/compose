/**
 * process-metrics.js — pure helpers for the Process view's one new derivation, the P6 time split (COMP-COCKPIT-13 U1).
 *
 * Nothing here is ported from the status builder (`OPS/status/parsers.py`): P1-P5 and P8 are read from its output
 * files. The only computation is the per-unit split of [ready_at, landed_at] into authoring, review, fix rounds,
 * gate, waiting on owner and waiting, from the lane stamp files written by `unit_stamps.py`.
 * No network, no spawn, no file access.
 */

const MIN_MS = 60_000;
export const STALE_AFTER_S = 1800; // two builder ticks (launchd StartInterval 900)
export const BUCKETS = ['authoring', 'review', 'fix_rounds', 'gate', 'waiting_owner', 'waiting'];
export const RULES = ['U-a', 'U-b', 'U-c', 'U-d', 'U-e'];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Epoch ms of a stamp, mirroring the builder's `to_local` + Python 3.9 `fromisoformat`: `Z` is UTC, `±HH:MM` that
 * offset, no offset is LOCAL wall time (a date alone is local midnight, unlike JS `new Date('2026-10-30')`, which
 * is UTC). Anything else, and any impossible date, is `null`.
 */
export function toLocal(text) {
  if (typeof text !== 'string') return null;
  const m = ISO_RE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((v) => (v === undefined ? 0 : Number(v)));
  const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  const tz = m[8];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  let t;
  if (tz) {
    t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    const check = new Date(t);
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    if (tz !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const oh = Number(tz.slice(1, 3));
      const om = Number(tz.slice(4, 6));
      if (oh > 23 || om > 59) return null;
      t -= sign * (oh * 60 + om) * MIN_MS;
    }
  } else {
    const dt = new Date(y, mo - 1, d, h, mi, s, ms);
    if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    t = dt.getTime();
  }
  return Number.isFinite(t) ? t : null;
}

/**
 * Rows of one stamp file: `{units: {id: row}}`, `{units: [row with id]}` or a bare list. Returns
 * `{rows: [{...row, id}], skipped}`; a non-object row is skipped and counted, never dropped silently.
 * A document of any other shape is `{rows: [], skipped: 0, error}`.
 */
export function laneRows(doc) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  let entries;
  if (Array.isArray(doc)) entries = doc.map((r) => [null, r]);
  else if (isObj(doc) && Array.isArray(doc.units)) entries = doc.units.map((r) => [null, r]);
  else if (isObj(doc) && isObj(doc.units)) entries = Object.entries(doc.units);
  else return { rows: [], skipped: 0, error: 'no units list or map' };
  const rows = [];
  let skipped = 0;
  for (const [key, r] of entries) {
    if (!isObj(r)) { skipped += 1; continue; }
    rows.push({ ...r, id: r.id ?? key });
  }
  return { rows, skipped };
}

function union(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

const length = (ivs) => ivs.reduce((n, [a, b]) => n + (b - a), 0);

/** The part of `ivs` (a union) not covered by `cover` (a union). */
function subtract(ivs, cover) {
  const out = [];
  for (const [a, b] of ivs) {
    let cur = a;
    for (const [ca, cb] of cover) {
      if (cb <= cur || ca >= b) continue;
      if (ca > cur) out.push([cur, ca]);
      cur = Math.max(cur, cb);
      if (cur >= b) break;
    }
    if (cur < b) out.push([cur, b]);
  }
  return out;
}

const present = (v) => v !== undefined && v !== null && v !== '';

/**
 * One interval from a start stamp and an end stamp, clipped to [lo, hi] (L1).
 * Returns `{iv}` (clipped, possibly null when empty), or `{rule}` when the interval cannot be bounded:
 *   U-a end without start (kept unless the end is after `hi`: a post-land entry is outside the window and ignored),
 *   U-b start without end (kept unless the start is at or after `hi`), U-e a stamp `toLocal` rejects or end before start.
 */
function interval(start, end, lo, hi) {
  const hasS = present(start);
  const hasE = present(end);
  if (!hasS && !hasE) return { iv: null };
  const s = hasS ? toLocal(start) : null;
  const e = hasE ? toLocal(end) : null;
  if ((hasS && s === null) || (hasE && e === null)) return { rule: 'U-e' };
  if (hasS && hasE) {
    if (e < s) return { rule: 'U-e' };
    const a = Math.max(s, lo);
    const b = Math.min(e, hi);
    return { iv: b > a ? [a, b] : null };
  }
  if (hasE) return e > hi ? { iv: null } : { rule: 'U-a' };
  return s >= hi ? { iv: null } : { rule: 'U-b' };
}

/**
 * The time split of one landed row, in minutes.
 *   `{status: 'known', minutes: {authoring, review, fix_rounds, gate, waiting_owner, waiting}}`
 *   `{status: 'unknown', rule}` — the first of U-e, U-d, U-a, U-b, U-c that fires; the unit adds to no bucket
 *   `{status: 'outside'}` — not landed, or no `ready_at` / `landed_at`
 * Every interval is clipped to [ready_at, landed_at]. Each job bucket sums its own intervals (jobs may overlap);
 * waiting on owner is the owner-wait time no job covers; waiting is the window no job and no owner wait covers.
 */
export function timeSplit(row) {
  if (!row || typeof row !== 'object' || !present(row.ready_at) || !present(row.landed_at)) return { status: 'outside' };
  const lo = toLocal(row.ready_at);
  const hi = toLocal(row.landed_at);
  if (lo === null || hi === null || hi < lo) return { status: 'unknown', rule: 'U-e' };
  const arr = (v) => (Array.isArray(v) ? v : []);
  const rules = new Set();
  const take = (start, end) => {
    const r = interval(start, end, lo, hi);
    if (r.rule) { rules.add(r.rule); return null; }
    return r.iv;
  };

  const jobs = { authoring: [], review: [], fix_rounds: [], gate: [] };
  if (!present(row.author_done_at)) rules.add('U-d');
  else { const iv = take(row.dispatched_at, row.author_done_at); if (iv) jobs.authoring.push(iv); }
  for (const r of arr(row.reviews)) { const iv = take(r?.dispatched_at, r?.at); if (iv) jobs.review.push(iv); }
  for (const r of arr(row.fix_runs)) { const iv = take(r?.dispatched_at, r?.done_at); if (iv) jobs.fix_rounds.push(iv); }
  for (const r of arr(row.gates)) { const iv = take(r?.started_at, r?.done_at); if (iv) jobs.gate.push(iv); }
  const owner = [];
  for (const r of arr(row.owner_waits)) { const iv = take(r?.start, r?.end); if (iv) owner.push(iv); }
  if (arr(row.fixes).length > 0 && arr(row.fix_runs).length === 0) rules.add('U-c');

  const order = ['U-e', 'U-d', 'U-a', 'U-b', 'U-c'];
  const rule = order.find((r) => rules.has(r));
  if (rule) return { status: 'unknown', rule };

  const jobUnion = union(Object.values(jobs).flat());
  const ownerUnion = union(owner);
  const minutes = {};
  for (const k of Object.keys(jobs)) minutes[k] = length(jobs[k]) / MIN_MS;
  minutes.waiting_owner = length(subtract(ownerUnion, jobUnion)) / MIN_MS;
  minutes.waiting = length(subtract(subtract([[lo, hi]], jobUnion), ownerUnion)) / MIN_MS;
  return { status: 'known', minutes };
}

/** Lane totals over known units only: `{known, unknown, outside, byRule, minutes}` ("M known, N unknown, K not in split"). */
export function laneTimeSplit(rows) {
  const byRule = Object.fromEntries(RULES.map((r) => [r, 0]));
  const minutes = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  let known = 0;
  let unknown = 0;
  let outside = 0;
  for (const row of rows) {
    const s = timeSplit(row);
    if (s.status === 'known') { known += 1; for (const b of BUCKETS) minutes[b] += s.minutes[b]; }
    else if (s.status === 'unknown') { unknown += 1; byRule[s.rule] += 1; }
    else outside += 1;
  }
  return { known, unknown, outside, byRule, minutes };
}

/**
 * Freshness of one builder file: `{ageS, stale, failed}`. Stale when older than `staleAfterS` (default two ticks).
 * `failedText` is the content of `BUILD-FAILED.txt` (line 1 the time, line 2 the reason) or null.
 */
export function freshness({ mtimeMs, now, failedText = null, staleAfterS = STALE_AFTER_S }) {
  const ageS = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  let failed = null;
  if (typeof failedText === 'string' && failedText.trim()) {
    const [time = '', reason = ''] = failedText.slice(0, 300).split('\n');
    failed = { time: time.trim(), reason: reason.trim() };
  }
  return { ageS, stale: ageS > staleAfterS, failed };
}
