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
 *
 * COMP-COCKPIT-PROJECT-MODEL-1: when the server has the project model (GET /api/projects `configured: true`), the lists
 * show projects with their lanes and modules nested, and a lane opens its project's merged graph (`openProjectGraph`,
 * `?project=&lane=` in the URL) instead of switching the cockpit. Project reads use plain `fetch`, never `wsFetch`:
 * they carry no X-Compose-Workspace-Id and never call /api/project/switch. Writing rooms still bind one module through
 * the existing switch, and only on an explicit click (the selector's module rows). Unconfigured: everything as before.
 */
import { useEffect, useState } from 'react';
import { wsFetch } from './wsFetch.js';
import { PROJECT_ROOMS } from '../../lib/view-keys.js';

export const FLEET_PROJECTS_URL = '/api/fleet/projects';
export const FLEET_ROOTS_URL = '/api/fleet/roots';
export const PROJECTS_URL = '/api/projects';

/** The rooms whose data belongs to one Compose project: there the left bar switches the project. One home: lib/view-keys.js (RIBBON-TOP-1). */
export { PROJECT_ROOMS };

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

// ── COMP-COCKPIT-PROJECT-MODEL-1 ───────────────────────────────────────────────────────────────────────────────

let modelState = { model: null, error: null };
let modelLoad = null;
const modelSubscribers = new Set();

/** Plain fetch on purpose: a project read must not carry the workspace header (wsFetch adds it). */
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error ?? `${url} ${res.status}`);
  return body ?? {};
}

function loadModel() {
  modelLoad ??= (async () => {
    try {
      modelState = { model: await getJson(PROJECTS_URL), error: null };
    } catch (error) {
      modelState = { model: null, error: String(error?.message ?? error) };
      modelLoad = null;
    }
    for (const fn of modelSubscribers) fn(modelState);
  })();
  return modelLoad;
}

/** React hook: `{model, error}` from GET /api/projects, fetched once per page. `model.configured` false = legacy lists. */
export function useProjectModel(enabled = true) {
  const [snap, setSnap] = useState(modelState);
  useEffect(() => {
    if (!enabled) return undefined;
    modelSubscribers.add(setSnap);
    setSnap(modelState);
    if (modelState.model === null) loadModel();
    return () => { modelSubscribers.delete(setSnap); };
  }, [enabled]);
  return snap;
}

/** True when the server answered with the project model (not the legacy fleet path, not an old server). */
export const modelConfigured = (model) => model?.configured === true && Array.isArray(model.projects);

/** `?lane=ops:<opsLane>`: the shared ops row (every module of that ops lane), distinct from one lane's own id. */
export const OPS_PREFIX = 'ops:';

/** The project and lane an ops lane belongs to: `{project, lane, label}` or null (unassigned / no model). An ops lane
 *  shared by several lanes gets `ops:<opsLane>`; a single lane keeps its own id. */
export function laneTarget(laneIndex, opsLane) {
  const e = laneIndex?.[opsLane];
  if (!e) return null;
  const lane = (e.laneIds?.length ?? 0) > 1 ? `${OPS_PREFIX}${opsLane}` : e.laneIds?.[0] ?? null;
  return { project: e.project, lane, label: e.label ?? e.project };
}

/** `{opsLane: {project, lane, label}}` for the Day and Process lane chips; `{}` while the model is absent or unconfigured. */
export function laneChips(model) {
  if (!modelConfigured(model)) return {};
  return Object.fromEntries(Object.keys(model.laneIndex || {}).map((l) => [l, laneTarget(model.laneIndex, l)]));
}

const readFocus = () => {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const project = q.get('project');
  return project ? { project, lane: q.get('lane') || null } : null;
};
let focus = readFocus();
const focusSubscribers = new Set();

function writeFocusUrl(f) {
  if (typeof window === 'undefined') return;
  const q = new URLSearchParams(window.location.search);
  if (f) { q.set('project', f.project); if (f.lane) q.set('lane', f.lane); else q.delete('lane'); } else { q.delete('project'); q.delete('lane'); }
  const s = q.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`);
}

/** Open a project's merged graph, optionally focused on one lane. The App moves to the Roadmap graph when this changes. */
export function openProjectGraph(project, lane = null) {
  focus = project ? { project, lane: lane ?? null, at: Date.now() } : null;
  writeFocusUrl(focus);
  for (const fn of focusSubscribers) fn(focus);
}

export function closeProjectGraph() { openProjectGraph(null); }

/** React hook: the open project graph `{project, lane}` or null (the Roadmap graph shows the bound workspace). */
export function useProjectFocus() {
  const [snap, setSnap] = useState(focus);
  useEffect(() => {
    focusSubscribers.add(setSnap);
    setSnap(focus);
    return () => { focusSubscribers.delete(setSnap); };
  }, []);
  return snap;
}

/** One project's merged graph (GET /api/projects/:name/graph). Plain fetch: no workspace header, no switch. */
export function fetchProjectGraph(name, lane) {
  const q = lane ? `?lane=${encodeURIComponent(lane)}` : '';
  return getJson(`${PROJECTS_URL}/${encodeURIComponent(name)}/graph${q}`);
}

/** DOC-LINKS on the merged graph: the item's doc, read from its owning module. */
export function fetchProjectDoc(name, id) {
  return getJson(`${PROJECTS_URL}/${encodeURIComponent(name)}/doc?id=${encodeURIComponent(id)}`);
}

/** Test seam (called by resetProcessPoller): forget the selection, any unsaved order, the roots map and the model. */
export function resetFleetProjects() {
  state = initial();
  chain = Promise.resolve();
  rootsState = { roots: null, error: null };
  rootsLoad = null;
  modelState = { model: null, error: null };
  modelLoad = null;
  focus = readFocus();
}
