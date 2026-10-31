/**
 * fleetProjects.js — the Fleet room's PROJECTS list and the Process lane selection (COMP-COCKPIT-FLEET-PROJECTS-1).
 *
 * The saved order arrives with GET /api/process (`fleet: {known, projects}`, read by processPoller.js); this module
 * holds what the two consumers share on top of it: the lane picked for the KPI tiles (the sidebar row and the
 * comparison column header set the same value) and the optimistic order while a POST /api/fleet/projects is in
 * flight. A failed POST rolls back to the last confirmed order and leaves a visible error line.
 *
 * COMP-COCKPIT-FLEET-PROJECTS-2: the list shows in every room. In the project rooms a row opens that lane's Compose
 * project (GET /api/fleet/roots, `useFleetRoots`) through the cockpit's one project switch; a lane with no project
 * opens nothing and the room says so (`selectProjectLane`).
 */
import { useEffect, useState } from 'react';
import { wsFetch } from './wsFetch.js';

export const FLEET_PROJECTS_URL = '/api/fleet/projects';
export const FLEET_ROOTS_URL = '/api/fleet/roots';

/** The rooms whose data belongs to one Compose project: there the left bar switches the project. */
export const PROJECT_ROOMS = ['home', 'ideas', 'roadmap', 'build', 'review'];

/** `project` in a project room (a row opens that lane's project), else `lane` (a row picks the Process lane). */
export function projectsModeFor(room) {
  return PROJECT_ROOMS.includes(room) ? 'project' : 'lane';
}

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

/**
 * A project-room row click: `{switchTo: root}` when the lane has a Compose project, else `{noProject: lane}` (the
 * room shows "No Compose project for <lane>", never the bound project's data). An unloaded roots map counts as none.
 */
export function selectProjectLane(lane, roots) {
  const r = roots?.[lane];
  return r?.root && r.hasCompose ? { switchTo: r.root, noProject: null } : { switchTo: null, noProject: lane };
}

let rootsState = { roots: null, error: null };
let rootsLoad = null;
const rootsSubscribers = new Set();

function loadRoots() {
  rootsLoad ??= (async () => {
    try {
      const res = await wsFetch(FLEET_ROOTS_URL);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `roots route ${res.status}`);
      rootsState = { roots: body.roots ?? {}, error: body.error ?? null };
    } catch (error) {
      rootsState = { roots: {}, error: String(error?.message ?? error) };
      rootsLoad = null; // the next mount tries again
    }
    for (const fn of rootsSubscribers) fn(rootsState);
  })();
  return rootsLoad;
}

/** React hook: `{roots, error}` from GET /api/fleet/roots, fetched once per page while `enabled`. */
export function useFleetRoots(enabled = true) {
  const [snap, setSnap] = useState(rootsState);
  useEffect(() => {
    if (!enabled) return undefined;
    rootsSubscribers.add(setSnap);
    setSnap(rootsState);
    if (rootsState.roots === null || rootsState.error) loadRoots();
    return () => { rootsSubscribers.delete(setSnap); };
  }, [enabled]);
  return snap;
}

/** Test seam (called by resetProcessPoller): forget the selection, any unsaved order and the roots map. */
export function resetFleetProjects() {
  state = initial();
  chain = Promise.resolve();
  rootsState = { roots: null, error: null };
  rootsLoad = null;
}
