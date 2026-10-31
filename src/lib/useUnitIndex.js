/**
 * useUnitIndex.js — the shared hook over GET /api/units/index (COMP-COCKPIT-UNIT-INDEX-1).
 *
 * Same shape as processPoller.js: one request per interval however many components call the hook (a module-level
 * subscriber set), the loop runs only while a subscriber exists and pauses while the document is hidden. The server
 * caches 120 s, so a 120 s poll is the useful floor. `loading` stays true until the first response (or failure):
 * consumers must not draw a zero while it is true (RULE-FRESH).
 */
import { useEffect, useState } from 'react';
import { wsFetch } from './wsFetch.js';

export const UNIT_INDEX_POLL_MS = 120_000;

const subscribers = new Set();
let state = { data: null, error: null, loading: true, asOf: null };
let timer = null;
let inflight = false;

function emit(next) {
  state = next;
  for (const fn of subscribers) fn(state);
}

async function poll() {
  if (inflight) return;
  inflight = true;
  try {
    const res = await wsFetch('/api/units/index');
    if (!res.ok) throw new Error(`unit index route ${res.status}`);
    const data = await res.json();
    emit({ data, error: null, loading: false, asOf: data.asOf ?? null });
  } catch (error) {
    emit({ ...state, error: String(error?.message ?? error), loading: false });
  } finally {
    inflight = false;
  }
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function schedule() {
  clearInterval(timer);
  timer = null;
  if (subscribers.size === 0 || hidden()) return;
  timer = setInterval(poll, UNIT_INDEX_POLL_MS);
}

function onVisibility() {
  if (subscribers.size === 0) return;
  if (!hidden()) poll();
  schedule();
}

export function subscribeUnitIndex(fn) {
  subscribers.add(fn);
  fn(state);
  if (subscribers.size === 1) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (!hidden()) poll();
    schedule();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      clearInterval(timer);
      timer = null;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** Test seam: forget the last result so a fresh mount starts loading again. */
export function resetUnitIndex() {
  state = { data: null, error: null, loading: true, asOf: null };
}

/** React hook: `{data, error, loading, asOf}` from the shared loop. */
export function useUnitIndex() {
  const [snap, setSnap] = useState(state);
  useEffect(() => subscribeUnitIndex(setSnap), []);
  return snap;
}
