/**
 * notifyState.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: the pure rules over Compose's own notify list (`~/.compose/notify-state.json`,
 * served by server/notify-state-routes.js and carried on every GET /api/fleet body as `notify`). No React, no network.
 *
 * State: `{v: 1, entries: {<key>: {action, at, until?, title?, lane?, seat?, sinceAt?, textHash?, answer?, first?, was?}}}`.
 * Keys are the row keys already in use: `security:<id>`, `ask:<id>`, `queue:<id>` (inbox info rows), `ctx:<session>`,
 * `disk`, `outage`, `attention:<name>`.
 *
 * ONE predicate decides "cleared": `isCleared`. A security row is never cleared (it always counts and keeps the chip red);
 * its acknowledgement only hides the banner until the row's text changes (`escalated`).
 */
import { groupOf } from '../../../../lib/owner-queue-class.js';

export const NOTIFY_KEY_PREFIXES = ['security:', 'ask:', 'queue:', 'ctx:', 'attention:'];
export const NOTIFY_KEYS_EXACT = ['disk', 'outage'];
export const CLEAR_ACTIONS = ['ack', 'dismiss', 'snooze'];

/** FNV-1a 32-bit, hex, over the UTF-8 bytes of the full text. Change detection only: it makes no security claim. */
export function fnv1a(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const entryOf = (state, key) => (state && state.entries && Object.hasOwn(state.entries, key) ? state.entries[key] : null);
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };

/** True when the row is cleared: `ack`, `dismiss`, or `snooze` with `now < until`. Always false for a `security:` key. */
export function isCleared(key, _row, state, now = Date.now()) {
  if (String(key).startsWith('security:')) return false;
  const e = entryOf(state, key);
  if (!e) return false;
  if (e.action === 'ack' || e.action === 'dismiss') return true;
  if (e.action === 'snooze') { const u = ms(e.until); return u !== null && now < u; }
  return false;
}

/** `{action, at, until?}` for a cleared row, else null. */
export function clearedOf(key, row, state, now = Date.now()) {
  if (!isCleared(key, row, state, now)) return null;
  const e = entryOf(state, key);
  return { action: e.action, at: e.at, ...(e.until ? { until: e.until } : {}) };
}

/** Tolerance for a queue row's `age` being as old as the fleet cache (its opened time is `now - age`, never exact). */
export const REASK_SLACK_MS = 120_000;

/**
 * The `answered` entry for an owner-queue id (`ask:` or `security:` key), else null.
 * With `{age}` (the open queue row's age in seconds) the entry counts only while it answered THIS record: a re-ask under
 * the same id opens a new record, so it is not hidden by the old answer. An entry stores the answered record's `ts`
 * (epoch seconds): same record while the row's opened time (`now - age`) is within `REASK_SLACK_MS` of it. A legacy entry
 * with no `ts` hides only if it was answered after the row opened. No `age` (the opened time is unknown) keeps the entry.
 */
export function answeredOf(state, key, opts = {}) {
  const e = entryOf(state, key);
  return e && e.action === 'answered' && answerHolds(e, opts) ? e : null;
}

/** True when an answer (`{at, ts?}`: a notify entry or the page's accepted answer) is for the open row, per `answeredOf`. */
export function answerHolds(e, { age, now = Date.now() } = {}) {
  if (!Number.isFinite(age)) return true;
  const openedAt = now - age * 1000;
  if (Number.isFinite(e.ts)) return Math.abs(openedAt - e.ts * 1000) <= REASK_SLACK_MS;
  const at = ms(e.at);
  return at !== null && at >= openedAt - REASK_SLACK_MS;
}

/** A security row escalated since it was acknowledged: its text hash differs from the one stored at ack. Age never counts. */
export function escalated(row, entry) {
  if (!entry || !entry.textHash) return false;
  return (row?.textHash ?? null) !== entry.textHash;
}

/** The ack entry of a security row that still holds (not escalated), else null. */
export function securityAck(state, key, row) {
  const e = entryOf(state, key);
  if (!e || e.action !== 'ack') return null;
  return escalated(row, e) ? null : e;
}

/**
 * `security | ask | alert | info` for a chip row (`{key}`) or an inbox row (`{group}` from groupInbox). Owner-queue rows
 * classify by `groupOf`; every non-queue chip row is an alert.
 */
export function actionClassOf(row) {
  const key = String(row?.key ?? '');
  const group = row?.group ?? (row?.text != null && !key ? groupOf(row.text) : null);
  if (key.startsWith('security:') || group === 'security') return 'security';
  if (key.startsWith('ask:') || group === 'asks') return 'ask';
  if (key.startsWith('queue:') || group === 'decided' || group === 'fyi') return 'info';
  return 'alert';
}

/** The state key a row writes under. Inbox rows: `security:` / `ask:` / `queue:` by group. Chip rows: their own key. */
export function keyOf(row) {
  if (row?.key) return row.key;
  const id = row?.id ?? '';
  const cls = actionClassOf(row);
  return cls === 'security' ? `security:${id}` : cls === 'ask' ? `ask:${id}` : `queue:${id}`;
}

/** The seat window a wall name carries: `7d` reads the seven-day reset, anything else the five-hour one. */
const windowOf = (wall) => (/\b7d\b/i.test(String(wall ?? '')) ? 'seven_d' : 'five_h');

/** Next calendar day at 09:00 in local time, as epoch ms. */
export function tomorrowNine(now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/**
 * Snooze presets for a row: `[{id, label, until}]` (`until` ISO). "Until reset" only for an alert row naming a seat whose
 * matching window has a future `resets_at` in `seats` (the rows the cost meter already polls); hidden otherwise.
 */
export function snoozePresets(row, seats, now = Date.now()) {
  const out = [{ id: '1h', label: '1 hour', until: new Date(now + 3_600_000).toISOString() }];
  if (actionClassOf(row) === 'alert' && row?.seat && Array.isArray(seats)) {
    const seat = seats.find((s) => s && s.id === row.seat);
    const reset = ms(seat?.[windowOf(row.wall ?? row.key)]?.resets_at);
    if (reset !== null && reset > now) out.push({ id: 'reset', label: 'Until reset', until: new Date(reset).toISOString() });
  }
  out.push({ id: 'tomorrow', label: 'Until tomorrow 09:00', until: new Date(tomorrowNine(now)).toISOString() });
  return out;
}

/** Which collected-source label owns a key: the release flow only fires when that source answered. */
function sourceDown(key, unknown) {
  const has = (l) => unknown.includes(l);
  if (/^(security|ask|queue):/.test(key)) return has('sm_status') || has('sm_status queue');
  if (key.startsWith('ctx:')) return has('sm_status') || has('sm_status sessions');
  if (key === 'disk') return has('sm_status') || has('sm_status df');
  if (key === 'outage') return has('cadence outage');
  if (key.startsWith('attention:')) return has('cadence attention');
  return true;
}

/**
 * Keys whose `ack` / `dismiss` should be released: the owning source answered and no current row carries the key.
 * `queueRows` is the raw owner-queue panel (info rows are not chip rows). Snoozes expire, answers and tombstones stay.
 */
export function releaseKeys(collected, state, queueRows) {
  const entries = state?.entries ?? {};
  const unknown = collected?.unknown ?? [];
  const present = new Set([...(collected?.rows ?? []), ...(collected?.cleared ?? [])].map((r) => r.key));
  const ids = new Set((Array.isArray(queueRows) ? queueRows : []).map((q) => String(q?.id ?? '')));
  const out = [];
  for (const [key, e] of Object.entries(entries)) {
    if (e?.action !== 'ack' && e?.action !== 'dismiss') continue;
    if (sourceDown(key, unknown)) continue;
    if (/^(security|ask|queue):/.test(key)) {
      if (!Array.isArray(queueRows) || ids.has(key.slice(key.indexOf(':') + 1))) continue;
    } else if (present.has(key)) continue;
    out.push(key);
  }
  return out;
}

const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/** The meta a clearing write carries so the ribbon can draw the mark after the source drops it. Never owner-queue text. */
export function clearMeta(row, now = Date.now()) {
  const queue = /^(security|ask|queue):/.test(keyOf(row));
  const since = Number.isFinite(row?.since) ? iso(now - row.since * 1000) : Number.isFinite(row?.age) ? iso(now - row.age * 1000) : null;
  return {
    ...(!queue && row?.title ? { title: String(row.title).slice(0, 140) } : {}),
    ...(row?.lane ? { lane: row.lane } : {}),
    ...(row?.seat ? { seat: row.seat } : {}),
    ...(since ? { sinceAt: since } : {}),
    ...(row?.textHash ? { textHash: row.textHash } : row?.text != null && queue ? { textHash: fnv1a(row.text) } : {}),
  };
}

/**
 * The Day ribbon's alert marks: open rows, cleared rows (flagged `cleared`), and stored entries whose source row is gone
 * (the entry is what lets a cleared mark survive its source). `since` becomes an ISO time: a row's `since` is AGE IN
 * SECONDS (`collect`), so it is `now - since*1000`; else the stored `sinceAt`; else null (no mark, as before).
 */
export function ribbonAlerts(collected, state, now = Date.now()) {
  const entries = state?.entries ?? {};
  const at = (row) => (Number.isFinite(row.since) ? iso(now - row.since * 1000) : entries[row.key]?.sinceAt ?? null);
  const open = (collected?.rows ?? []).map((r) => ({ ...r, since: at(r) }));
  const cleared = (collected?.cleared ?? []).map((r) => ({ ...r, since: at(r) }));
  const seen = new Set([...open, ...cleared].map((r) => r.key));
  const stored = [];
  for (const [key, e] of Object.entries(entries)) {
    // Inbox info rows (`queue:`) and asks never drew a mark; a resolved security row keeps its mark as cleared.
    if (seen.has(key) || !e || key.startsWith('queue:') || key.startsWith('ask:')) continue;
    const action = e.action === 'released' ? e.was : e.action === 'answered' && key.startsWith('security:') ? 'resolved' : e.action;
    if (!CLEAR_ACTIONS.includes(action) && action !== 'resolved') continue;
    const id = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    stored.push({
      key,
      kind: 'stored',
      severity: 'warn',
      title: e.title ?? (/^(security|ask|queue):/.test(key) ? `owner queue row ${id}` : key),
      ...(e.lane ? { lane: e.lane } : {}),
      ...(e.seat ? { seat: e.seat } : {}),
      since: e.sinceAt ?? e.at ?? null,
      cleared: { action, at: e.at, ...(e.until ? { until: e.until } : {}) },
    });
  }
  return [...open, ...cleared, ...stored];
}

/** Past-tense word for a cleared action. */
export const CLEARED_WORD = { ack: 'acknowledged', dismiss: 'dismissed', snooze: 'snoozed', resolved: 'resolved' };

export const hhmm = (t) => {
  const v = typeof t === 'number' ? t : Date.parse(t ?? '');
  return Number.isFinite(v) ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
};

/** Answered entries of the last 24 h whose id the queue no longer holds: the drawer's "Answered (n)" fold, newest first. */
export function answeredFold(state, queueRows, now = Date.now()) {
  const ids = new Set((Array.isArray(queueRows) ? queueRows : []).map((q) => String(q?.id ?? '')));
  return Object.entries(state?.entries ?? {})
    .filter(([key, e]) => e?.action === 'answered' && /^(ask|security):/.test(key) && !ids.has(key.slice(key.indexOf(':') + 1)))
    .filter(([, e]) => { const t = ms(e.at); return t !== null && now - t <= 86_400_000; })
    .map(([key, e]) => ({ key, id: key.slice(key.indexOf(':') + 1), at: e.at, answer: e.answer ?? '', first: e.first ?? '' }))
    .sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
}
