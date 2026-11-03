/**
 * processPoller.js — one shared poll of GET /api/process for the Process view (COMP-COCKPIT-13).
 *
 * Same shape as fleetPoller.js: one request per interval however many consumers are mounted, the loop runs
 * only while a subscriber exists, pauses while the document is hidden and fetches at once when the tab is
 * shown again. The builder source caches 60 s on the server, so a 60 s poll is the useful floor.
 */
import { useEffect, useState } from 'react';
import { wsFetch } from './wsFetch.js';
import { INITIAL_SOURCE, sourceOk, sourceFail } from './sourceState.js';
import { resetFleetProjects } from './fleetProjects.js';

export const PROCESS_POLL_MS = 60_000;

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
  try {
    const res = await wsFetch('/api/process');
    if (!res.ok) throw new Error(`process route ${res.status}`);
    emit(sourceOk(await res.json()));
  } catch (error) {
    emit(sourceFail(state, error)); // the last good data stays, marked stale (sourceState.js)
  } finally {
    inflight = false;
  }
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function schedule() {
  clearInterval(timer);
  timer = null;
  if (subscribers.size === 0 || hidden()) return;
  timer = setInterval(poll, PROCESS_POLL_MS);
}

function onVisibility() {
  if (subscribers.size === 0) return;
  if (!hidden()) poll();
  schedule();
}

export function subscribeProcess(fn) {
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

/** Test seam: forget the last result so a fresh mount starts loading again (and the shared lane selection). */
export function resetProcessPoller() {
  state = INITIAL_SOURCE;
  resetFleetProjects();
}

/** React hook: the shared loop's source state, `{data, error, stale, fetchedAt, errorSince, loading}` (sourceState.js). */
export function useProcess() {
  const [snap, setSnap] = useState(state);
  useEffect(() => subscribeProcess(setSnap), []);
  return snap;
}
