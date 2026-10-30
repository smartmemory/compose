/**
 * fleetPoller.js — one shared poll of GET /api/fleet for every Fleet consumer on the page (COMP-COCKPIT-12).
 *
 * The Ops strip pills, the Sessions tab Fleet view and the mobile Status tab subscribe to the same loop, so
 * a page makes one request per interval however many consumers are mounted. The loop runs only while a
 * subscriber exists and pauses while the document is hidden; it fetches at once when the tab is shown
 * again. The server caches each reader on its own window, so polling faster than that buys nothing.
 */
import { useEffect, useState } from 'react';
import { wsFetch } from './wsFetch.js';

export const FLEET_POLL_MS = 15_000;

const subscribers = new Set();
let state = { data: null, error: null, loading: true };
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
    const res = await wsFetch('/api/fleet');
    if (!res.ok) throw new Error(`fleet route ${res.status}`);
    emit({ data: await res.json(), error: null, loading: false });
  } catch (error) {
    emit({ data: state.data, error: String(error?.message ?? error), loading: false });
  } finally {
    inflight = false;
  }
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function schedule() {
  clearInterval(timer);
  timer = null;
  if (subscribers.size === 0 || hidden()) return;
  timer = setInterval(poll, FLEET_POLL_MS);
}

function onVisibility() {
  if (subscribers.size === 0) return;
  if (!hidden()) poll();
  schedule();
}

export function subscribeFleet(fn) {
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
export function resetFleetPoller() {
  state = { data: null, error: null, loading: true };
}

/** React hook: `{data, error, loading}` from the shared loop. */
export function useFleet() {
  const [snap, setSnap] = useState(state);
  useEffect(() => subscribeFleet(setSnap), []);
  return snap;
}
