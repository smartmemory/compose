/**
 * useNotifySources.js — COMP-COCKPIT-NOTIFY-CHIP-1: the chip and the banner share ONE read. sm_status comes from the shared
 * `useFleet()` loop. Cadence's outage and attention screens are polled here every 60 s, paused while the document is
 * hidden (the fleet poller's rule), by one loop however many components are mounted. No other fetch.
 */
import { useEffect, useMemo, useState } from 'react';
import { useFleet } from '../../../lib/fleetPoller.js';
import { createCadenceDataClient } from '../../../lib/clients/cadence.js';
import { collect, chipState } from './notifyLogic.js';
import { smPanel } from '../fleetLogic.js';
import { releaseKeys } from './notifyState.js';
import { useNotifyState, releaseOnce } from './useNotifyState.js';

export const NOTIFY_POLL_MS = 60_000;

const idle = { outage: null, attention: null };
const subscribers = new Set();
let state = idle;
let timer = null;
let inflight = false;
let client = null;

const settle = (p) => p.then((value) => ({ value, error: null }), (e) => ({ value: null, error: String(e?.message ?? e) }));
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

async function poll() {
  if (inflight) return;
  inflight = true;
  try {
    client ??= createCadenceDataClient();
    const [outage, attention] = await Promise.all([settle(client.getOutage()), settle(client.getAttention())]);
    state = { outage, attention };
    for (const fn of subscribers) fn(state);
  } finally {
    inflight = false;
  }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (subscribers.size === 0 || hidden()) return;
  timer = setInterval(poll, NOTIFY_POLL_MS);
}

function onVisibility() {
  if (subscribers.size === 0) return;
  if (!hidden()) poll();
  schedule();
}

export function subscribeCadence(fn) {
  subscribers.add(fn);
  fn(state);
  if (subscribers.size === 1) {
    document.addEventListener('visibilitychange', onVisibility);
    if (!hidden()) poll();
    schedule();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** Test seam: forget the last cadence result so a fresh mount starts loading again. */
export function resetNotifyPoller() {
  state = idle;
  client = null;
}

/**
 * `{loading, collected, chip, notify}`; loading until the fleet loop and the cadence loop have each answered once.
 * NOTIFY-ACTIONS-1: `collect` runs over Compose's notify state (`useNotifyState`), so cleared rows sit in
 * `collected.cleared` and the chip counts open rows only; `collected.stateUnavailable` says the state could not be read.
 * Every mount also runs the release check: an ack or dismiss whose source answered without the row is released once.
 */
export function useNotifySources() {
  const { data: fleet, loading: fleetLoading } = useFleet();
  const [cad, setCad] = useState(state);
  useEffect(() => subscribeCadence(setCad), []);
  const notify = useNotifyState();
  const loading = (fleetLoading && !fleet) || cad.outage === null;
  const out = useMemo(() => {
    const collected = { ...collect({ fleet, outage: cad.outage, attention: cad.attention }, Date.now(), notify.state), stateUnavailable: notify.unavailable };
    return { loading, collected, chip: chipState(collected), notify };
  }, [fleet, cad, loading, notify]);
  useEffect(() => {
    if (out.loading || !notify.state) return;
    const keys = releaseKeys(out.collected, notify.state, smPanel(fleet, 'queue')?.value);
    if (keys.length) releaseOnce(keys);
  }, [out, notify.state, fleet]);
  return out;
}
