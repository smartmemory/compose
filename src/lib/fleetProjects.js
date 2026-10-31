/**
 * fleetProjects.js — the Fleet room's PROJECTS list and the Process lane selection (COMP-COCKPIT-FLEET-PROJECTS-1).
 *
 * The saved order arrives with GET /api/process (`fleet: {known, projects}`, read by processPoller.js); this module
 * holds what the two consumers share on top of it: the lane picked for the KPI tiles (the sidebar row and the
 * comparison column header set the same value) and the optimistic order while a POST /api/fleet/projects is in
 * flight. A failed POST rolls back to the last confirmed order and leaves a visible error line.
 */
import { useEffect, useState } from 'react';
import { wsFetch } from './wsFetch.js';

export const FLEET_PROJECTS_URL = '/api/fleet/projects';

const subscribers = new Set();
const initial = () => ({ picked: null, override: undefined, confirmed: undefined, saveError: null });
let state = initial();
let chain = Promise.resolve();
let latest = 0;

function emit(patch) {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn(state);
}

/** The lanes to show, in order: `known` itself when no order is saved, else the saved names the builder still knows. */
export function orderLanes(known, saved) {
  const k = Array.isArray(known) ? known : [];
  return Array.isArray(saved) ? saved.filter((n) => k.includes(n)) : k;
}

/** The saved order in effect: the optimistic one while set, else the server's (null = no key = every lane). */
export function effectiveOrder(fleet, s = state) {
  return s.override !== undefined ? s.override : (Array.isArray(fleet?.projects) ? fleet.projects : null);
}

/** The lane the KPI tiles show: the picked one when it is a shown builder column, else the first shown. */
export function pickLane(shown, picked) {
  return shown.includes(picked) ? picked : shown[0] ?? null;
}

export function setPickedLane(name) {
  emit({ picked: name });
}

/**
 * Save a new order: shown at once, POSTed in sequence (a later click never overtakes an earlier one), rolled back
 * to the last confirmed order with `saveError` set when the POST fails.
 */
export function saveFleetProjects(projects) {
  emit({ override: projects, saveError: null });
  const seq = ++latest;
  chain = chain.then(async () => {
    try {
      const res = await wsFetch(FLEET_PROJECTS_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* no body */ }
      if (!res.ok) throw new Error(body?.error ?? `save failed (${res.status})`);
      emit(seq === latest ? { confirmed: projects, override: projects } : { confirmed: projects });
    } catch (error) {
      emit({ override: state.confirmed, saveError: `Not saved: ${String(error?.message ?? error)}` });
    }
  });
  return chain;
}

/** React hook: the shared `{picked, override, confirmed, saveError}`. */
export function useFleetProjects() {
  const [snap, setSnap] = useState(state);
  useEffect(() => {
    subscribers.add(setSnap);
    setSnap(state);
    return () => { subscribers.delete(setSnap); };
  }, []);
  return snap;
}

/** Test seam (called by resetProcessPoller): forget the selection and any unsaved order. */
export function resetFleetProjects() {
  state = initial();
  chain = Promise.resolve();
}
