/**
 * useNotifyState.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: ONE shared client view of Compose's notify list for every component
 * (chip, tray, banner, inbox drawer, WHAT line, NOW drawer, ops strip, Day ribbon).
 *
 * The read rides on the shared fleet poll: every GET /api/fleet body carries `notify: {v, entries}` (fleet-routes.js),
 * so there is no second loop and it already pauses while the document is hidden (`fleetPoller.js`). Each own write
 * POSTs /api/notify/state, which answers with the whole new list; that reply is used at once (the "refetch after a
 * write"), until a fleet body generated later arrives. Writes are optimistic: the row moves at once and moves back with
 * the reason shown when the POST fails. A phone and the desktop agree within one fleet poll.
 *
 * When the state cannot be read (`notify` missing or `{error}`), the state is `null`: nothing is hidden, the full count
 * stands, and `unavailable` is true so the tray can say so. Never hide anything on an unknown state.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useFleet } from '../../../lib/fleetPoller.js';
import { wsFetch } from '../../../lib/wsFetch.js';
import { withComposeToken } from '../../../lib/compose-api.js';

export const NOTIFY_STATE_URL = '/api/notify/state';
export const OWNER_ANSWER_URL = '/api/fleet/owner-answer';

const subscribers = new Set();
let version = 0;
let latest = null; // {state, generated} from the newest POST reply
const overlay = new Map(); // key -> entry | null (deleted), while a write is in flight or an answer is not yet on a fleet body
const errors = new Map(); // key -> reason of the last failed write
const answers = new Map(); // owner-queue id -> {phase, reason?, winning?, channel?, answer?, at?}
const released = new Set(); // keys already sent `release` this page life
let seats = null; // the seat rows the cost meter polls (published by DayView; never a second poll)
let warnedUnavailable = false;

const emit = () => { version += 1; for (const fn of subscribers) fn(); };
const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const snapshot = () => version;

/** Test seam: forget everything the module holds. */
export function resetNotifyState() {
  latest = null;
  overlay.clear();
  errors.clear();
  answers.clear();
  released.clear();
  seats = null;
  warnedUnavailable = false;
  emit();
}

/** DayView hands over the seat rows `useCostMeterProps` already polls, so "Until reset" needs no second read. */
export function publishSeats(rows) {
  const next = Array.isArray(rows) ? rows : null;
  if (next === seats) return;
  seats = next;
  emit();
}

const t = (iso) => { const v = Date.parse(iso ?? ''); return Number.isFinite(v) ? v : -Infinity; };

/** The base state from the fleet body and the newest POST reply, whichever the server generated later. */
function baseState(fleet) {
  const n = fleet?.notify;
  const fromFleet = n && typeof n.entries === 'object' && n.entries !== null && !n.error ? { v: 1, entries: n.entries } : null;
  if (latest && (!fromFleet || t(latest.generated) >= t(fleet?.generated))) return latest.state;
  return fromFleet;
}

/** Drop answered overlays once the fleet body carries the server's own answered entry. */
function settleOverlay(fleet) {
  const entries = fleet?.notify?.entries;
  if (!entries) return;
  for (const [key, e] of overlay) {
    if (e?.action === 'answered' && entries[key]?.action === 'answered') overlay.delete(key);
  }
}

async function post(url, body) {
  const res = await wsFetch(url, {
    method: 'POST',
    headers: withComposeToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { res, data };
}

/**
 * One state write. `action` is `ack | snooze | dismiss | restore | release`; `until` (ISO) for a snooze; `meta`
 * `{title, lane, seat, sinceAt, textHash}`. Resolves `{ok, reason?}`; never throws.
 */
export async function writeState(key, action, { until, meta } = {}) {
  const at = new Date().toISOString();
  overlay.set(key, action === 'restore' ? null
    : action === 'release' ? { action: 'released', at }
      : { action, at, ...(until ? { until } : {}), ...(meta ?? {}) });
  errors.delete(key);
  emit();
  try {
    const { res, data } = await post(NOTIFY_STATE_URL, { key, action, ...(until ? { until } : {}), ...(meta ? { meta } : {}) });
    if (!res.ok || !data?.ok) throw new Error(data?.error || `the state was not saved (HTTP ${res.status})`);
    latest = { state: { v: 1, entries: data.entries ?? {} }, generated: data.generated };
    overlay.delete(key);
    emit();
    return { ok: true };
  } catch (err) {
    const reason = String(err?.message ?? err);
    overlay.delete(key);
    errors.set(key, reason);
    console.warn(`[notify] ${action} ${key} failed: ${reason}`);
    emit();
    return { ok: false, reason };
  }
}

/**
 * Answer an ask (`{choice}` or `{text}`) or resolve a security row (`{resolve: true, text}`) through the owner-queue
 * answer route. The phase per id (`sending | accepted | conflict | rejected | error`) is shared by the tray and the drawer.
 */
export async function answerOwner(id, payload, { answerText } = {}) {
  answers.set(id, { phase: 'sending' });
  emit();
  try {
    const { res, data } = await post(OWNER_ANSWER_URL, { id, ...payload });
    if (!res.ok || !data?.reply) throw new Error(data?.error || `the answer route failed (HTTP ${res.status})`);
    if (data.reply === 'accepted') {
      const at = new Date().toISOString();
      const key = `${payload.resolve ? 'security' : 'ask'}:${id}`;
      overlay.set(key, { action: 'answered', at, answer: answerText ?? '' });
      answers.set(id, { phase: 'accepted', at, answer: answerText ?? '' });
    } else if (data.reply === 'conflict') {
      answers.set(id, { phase: 'conflict', winning: data.winning_value ?? '', channel: data.channel ?? null });
    } else {
      answers.set(id, { phase: 'rejected', reason: data.reason ?? 'rejected' });
    }
  } catch (err) {
    answers.set(id, { phase: 'error', reason: String(err?.message ?? err) });
  }
  emit();
  return answers.get(id);
}

/** Send `release` once per key per page life (the source answered and no longer carries the row). */
export function releaseOnce(keys) {
  for (const key of keys) {
    if (released.has(key)) continue;
    released.add(key);
    writeState(key, 'release');
  }
}

/** `{state, unavailable, errors, answers, seats}`; `state` is null while unknown (nothing hidden). */
export function useNotifyState() {
  const { data: fleet } = useFleet();
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    settleOverlay(fleet);
    const base = baseState(fleet);
    const loaded = fleet != null;
    const unavailable = loaded && !base;
    if (unavailable && !warnedUnavailable) {
      warnedUnavailable = true;
      console.warn('[notify] the notify state is unavailable (no `notify` on /api/fleet): showing everything');
    }
    if (!unavailable) warnedUnavailable = false;
    let state = base;
    if (base && overlay.size) {
      const entries = { ...base.entries };
      for (const [key, e] of overlay) {
        if (e === null) delete entries[key];
        else if (e.action === 'released') { if (entries[key]) entries[key] = { ...entries[key], action: 'released', was: entries[key].action, at: e.at }; }
        else entries[key] = e;
      }
      state = { v: 1, entries };
    }
    return { state, unavailable, errors: new Map(errors), answers: new Map(answers), seats };
  // `v` is the module store's version: every write, answer and published seat list re-derives the view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, v]);
}
