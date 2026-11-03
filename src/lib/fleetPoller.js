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
import { INITIAL_SOURCE, sourceFromBody, sourceFail } from './sourceState.js';

export const FLEET_POLL_MS = 15_000;
/** A fleet request still pending after this long is abandoned as a failure (COMP-COCKPIT-UNKNOWN-FU-1), well under the poll interval. */
export const FLEET_TIMEOUT_MS = 10_000;

const subscribers = new Set();
let state = INITIAL_SOURCE;
let timer = null;
let inflight = false;

function emit(next) {
  state = next;
  for (const fn of subscribers) fn(state);
}

async function poll() {
  if (inflight) return;
  inflight = true;
  const ctrl = new AbortController();
  let timer_;
  const deadline = new Promise((_, reject) => {
    timer_ = setTimeout(() => { ctrl.abort(); reject(new Error(`fleet request timed out after ${FLEET_TIMEOUT_MS / 1000}s`)); }, FLEET_TIMEOUT_MS);
  });
  try {
    // The race also covers a transport that ignores the abort signal: the loop must not hang on one request.
    const body = await Promise.race([
      (async () => {
        const res = await wsFetch('/api/fleet', { signal: ctrl.signal });
        if (!res.ok) throw new Error(`fleet route ${res.status}`);
        return res.json();
      })(),
      deadline,
    ]);
    emit(sourceFromBody(body));
  } catch (error) {
    emit(sourceFail(state, error)); // the last good data stays, marked stale (sourceState.js)
  } finally {
    clearTimeout(timer_);
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

/** Test seam: forget the last result (and any request still pending) so a fresh mount starts loading again. */
export function resetFleetPoller() {
  state = INITIAL_SOURCE;
  inflight = false;
}

/** React hook: the shared loop's source state, `{data, error, stale, fetchedAt, errorSince, loading}` (sourceState.js). */
export function useFleet() {
  const [snap, setSnap] = useState(state);
  useEffect(() => subscribeFleet(setSnap), []);
  return snap;
}
