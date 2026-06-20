import { create } from 'zustand';
import YAML from 'yaml';
import { handleVisionMessage } from './visionMessageHandler.js';
import { wsFetch } from '../../lib/wsFetch.js';
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';
import {
  specToModel,
  flowSteps,
  listEditableFlows,
  validateFlow,
  renameStep as renameStepInModel,
  canDeleteStep,
  deleteStep as deleteStepInModel,
  addDependency as addDependencyInModel,
  removeDependency as removeDependencyInModel,
  wouldCreateCycle,
  addContract as addContractInModel,
  renameContract as renameContractInModel,
  deleteContract as deleteContractInModel,
  canDeleteContract,
  setContractField as setContractFieldInModel,
  removeContractField as removeContractFieldInModel,
  renameContractField as renameContractFieldInModel,
  collapseToSubflow,
} from '../../lib/pipeline-model.js';

// COMP-PIPE-EDIT-6: browser-safe basename (no node:path) for matching a watcher's
// prefixed path (<prefix>/<file>) against the bare editorSpecFile.
function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// COMP-PIPE-EDIT-1: v0.1 specs are not validated by Stratum (IR_UNKNOWN_VERSION);
// they load read-only with a banner. v0.2/v0.3 are fully editable.
function isReadOnlyVersion(version) {
  return String(version) === '0.1';
}

// Pick a unique step id for a newly added step within a flow.
function uniqueStepId(steps, base = 'new_step') {
  const taken = new Set((steps || []).map(s => s.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

// The editor mutates the model in place (single source of truth), but Zustand
// subscribers compare by reference — so after every mutation we must hand back
// fresh refs at the levels the canvas/inspector read (model → flows → flow →
// steps → step) or valid edits won't re-render. _doc/contracts are shared.
function reactiveModel(m) {
  if (!m) return m;
  return { ...m, flows: m.flows.map(f => ({ ...f, steps: f.steps.map(s => ({ ...s })) })) };
}

// COMP-PIPE-EDIT-6: a YAML-pane edit is spec-wide, so it can break ANY flow, not
// just the selected one. Validate every editable flow and aggregate into the
// single editorErrors shape (flat errors[] + per-step warnings keyed by step id).
//
// errors[] aggregates across ALL editable flows (it drives the global error count
// + banner). warningsByStepId, however, is populated ONLY from the currently
// selected flow: step ids are flow-local but not globally unique (e.g. `review`
// can exist in two flows), and the canvas/inspector key per-node badges by bare
// step id while rendering only the selected flow. Merging warnings across flows
// would bleed a non-selected flow's error onto a same-id node in the visible flow.
function validateSpecWide(model, flows, selectedFlow) {
  const errors = [];
  let warningsByStepId = {};
  for (const name of (flows || [])) {
    const r = validateFlow(model, name);
    for (const e of (r.errors || [])) errors.push(e);
    if (name === selectedFlow) warningsByStepId = { ...(r.warningsByStepId || {}) };
  }
  return { errors, warningsByStepId };
}

/**
 * useVisionStore — Zustand singleton store.
 *
 * Single WebSocket connection, single state atom, single set of intervals.
 * All components read from the same store via useVisionStore() selectors.
 *
 * COMP-STATE-1: Replaces the old React hook that created independent state
 * per component (12 WebSockets, 12 intervals, 12 state copies).
 */

// ─── DOM snapshot (for server snapshot requests) ─────────────────────────────

function collectDOMSnapshot() {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);
  const MAX_DEPTH = 12;
  const MAX_TEXT = 120;

  function walk(el, depth) {
    if (!el || depth > MAX_DEPTH) return null;
    if (el.nodeType === Node.TEXT_NODE) {
      const text = el.textContent.trim();
      return text ? text.slice(0, MAX_TEXT) : null;
    }
    if (el.nodeType !== Node.ELEMENT_NODE) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;

    const node = {};
    const role = el.getAttribute('role') || el.getAttribute('aria-label');
    const tag = el.tagName.toLowerCase();
    if (role) node.role = role;
    else node.tag = tag;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim();
      if (cls.length < 80) node.class = cls;
    }
    const children = [];
    for (const child of el.childNodes) {
      const c = walk(child, depth + 1);
      if (c) children.push(c);
    }
    if (children.length === 1 && typeof children[0] === 'string') {
      node.text = children[0];
    } else if (children.length > 0) {
      node.children = children;
    }
    if (!role && (tag === 'div' || tag === 'span') && !node.text && children.length === 1 && typeof children[0] === 'object') {
      return children[0];
    }
    return node;
  }

  const root = document.querySelector('[data-snapshot-root]') || document.body;
  return walk(root, 0);
}

// ─── Refs (mutable, shared across all subscribers) ───────────────────────────

const refs = {
  ws: null, // reconnect handle returned by createReconnectingWS (has .close())
  snapshotProvider: null,
  prevItemMap: null,
  changeTimer: null,
  sessionEndTimer: null,
  gates: [],
  pendingResolveIds: new Set(),
  buildPollInterval: null,
  recentErrorsInterval: null,
  connected: false,
};

const EMPTY_CHANGES = { newIds: new Set(), changedIds: new Set() };

// ─── Zustand store ───────────────────────────────────────────────────────────

export const useVisionStore = create((set, get) => {
  // ── REST helpers ─────────────────────────────────────────────────────────

  async function apiCall(url, options) {
    const res = await wsFetch(url, options);
    const data = await res.json();
    if (!res.ok) {
      console.error(`[vision] API error ${res.status}:`, data.error || data);
      return { error: data.error || `HTTP ${res.status}` };
    }
    return data;
  }

  // ── WebSocket connection ─────────────────────────────────────────────────

  function handleOpen() {
    set({ connected: true });
    // Hydrate build state on connect
    wsFetch('/api/build/state')
      .then(r => r.json())
      .then(data => set({ activeBuild: data.state ?? null }))
      .catch(() => {});
    // COMP-PIPE-1-3: Hydrate pipeline draft on connect
    wsFetch('/api/pipeline/draft')
      .then(r => r.json())
      .then(data => set({ pipelineDraft: data.draft ?? null }))
      .catch(() => {});
    // COMP-VIS-1: Hydrate spawned agents on connect (only if no live events yet)
    wsFetch('/api/agents/tree')
      .then(r => r.json())
      .then(data => {
        const current = get().spawnedAgents;
        if (current.length === 0) {
          set({ spawnedAgents: (data.agents || []).map(a => ({
            agentId: a.agentId, parentSessionId: a.parentSessionId,
            agentType: a.agentType, status: a.status || 'running',
            startedAt: a.startedAt, prompt: a.prompt,
          }))});
        }
      })
      .catch(() => {});
  }

  function handleMessage(event) {
    try {
      const msg = JSON.parse(event.data);
      // COMP-PIPE-EDIT-6: the pipelines watcher emits a dedicated specChanged on
      // the vision WS. The watcher path is prefixed (<prefix>/<file>) while
      // editorSpecFile is a bare filename — compare on the basename. Routed to the
      // editor slice (which owns loadSpecForEdit + the conflict state).
      if (msg.type === 'specChanged') {
        const open = get().editorSpecFile;
        if (open) {
          const changed = basename(msg.file || msg.path || '');
          if (changed && changed === basename(open)) {
            get().handleSpecChanged({ currentHash: msg.hash ?? msg.currentHash });
          }
        }
        return;
      }
      handleVisionMessage(msg, {
          prevItemMapRef: { get current() { return refs.prevItemMap; }, set current(v) { refs.prevItemMap = v; } },
          snapshotProviderRef: { get current() { return refs.snapshotProvider; }, set current(v) { refs.snapshotProvider = v; } },
          gatesRef: { get current() { return refs.gates; }, set current(v) { refs.gates = v; } },
          pendingResolveIdsRef: { get current() { return refs.pendingResolveIds; }, set current(v) { refs.pendingResolveIds = v; } },
          changeTimerRef: { get current() { return refs.changeTimer; }, set current(v) { refs.changeTimer = v; } },
          sessionEndTimerRef: { get current() { return refs.sessionEndTimer; }, set current(v) { refs.sessionEndTimer = v; } },
          wsRef: { get current() { return refs.ws?.socket || null; }, set current(_v) { /* managed by reconnect helper */ } },
          collectDOMSnapshot,
        }, {
          setItems: (updater) => set(s => ({ items: typeof updater === 'function' ? updater(s.items) : updater })),
          setConnections: (updater) => set(s => ({ connections: typeof updater === 'function' ? updater(s.connections) : updater })),
          setGates: (updater) => {
            set(s => {
              const next = typeof updater === 'function' ? updater(s.gates) : updater;
              refs.gates = next; // keep ref in sync
              return { gates: next };
            });
          },
          setGateEvent: (v) => set({ gateEvent: v }),
          setRecentChanges: (updater) => set(s => ({ recentChanges: typeof updater === 'function' ? updater(s.recentChanges) : updater })),
          setUICommand: (v) => set({ uiCommand: v }),
          setAgentActivity: (updater) => set(s => ({ agentActivity: typeof updater === 'function' ? updater(s.agentActivity) : updater })),
          setAgentErrors: (updater) => {
            set(s => {
              const next = typeof updater === 'function' ? updater(s.agentErrors) : updater;
              // P1 fix: immediately recompute recentErrors on every agentErrors change
              const cutoff = Date.now() - 60_000;
              const recent = next.filter(e => new Date(e.timestamp).getTime() > cutoff).slice(-5);
              return { agentErrors: next, recentErrors: recent };
            });
          },
          setSessionState: (updater) => set(s => ({ sessionState: typeof updater === 'function' ? updater(s.sessionState) : updater })),
          setSpawnedAgents: (updater) => set(s => ({ spawnedAgents: typeof updater === 'function' ? updater(s.spawnedAgents) : updater })),
          setAgentRelays: (updater) => set(s => ({ agentRelays: typeof updater === 'function' ? updater(s.agentRelays) : updater })),
          setSettings: (v) => set({ settings: v }),
          setPipelineDraft: (v) => set({ pipelineDraft: v }),
          setActiveBuild: (updater) => set(s => ({ activeBuild: typeof updater === 'function' ? updater(s.activeBuild) : updater })),
          setSessions: (updater) => set(s => ({ sessions: typeof updater === 'function' ? updater(s.sessions) : updater })),
          setFeatureTimeline: (updater) => set(s => ({ featureTimeline: typeof updater === 'function' ? updater(s.featureTimeline) : updater })),
          setIterationStates: (updater) => set(s => ({ iterationStates: typeof updater === 'function' ? updater(s.iterationStates) : updater })),
          // COMP-OBS-TIMELINE: decision event store setters
          appendDecisionEvent: (ev) => set(s => {
            if (!ev?.id) return s;
            if (s.decisionEvents.some(e => e.id === ev.id)) return s;
            return { decisionEvents: [...s.decisionEvents, ev] };
          }),
          setDecisionEventsSnapshot: (arr) => set({ decisionEvents: Array.isArray(arr) ? arr : [] }),
          // COMP-OBS-STATUS: status snapshot setter for WS handler
          setStatusSnapshot: (fc, snap) => set(s => ({
            statusSnapshots: { ...s.statusSnapshots, [fc]: snap },
          })),
          // COMP-OBS-STATUS: drop cached snapshots on hydrate so the selection-change
          // effect refetches against current server state after reconnect.
          clearStatusSnapshots: () => set({ statusSnapshots: {} }),
          EMPTY_CHANGES,
        });
    } catch {
      // ignore parse errors
    }
  }

  function connect() {
    if (refs.disposed) return;
    if (refs.ws) return; // already constructed; reconnect helper manages lifecycle
    refs.ws = createReconnectingWS({
      url: () => visionWsUrl(),
      onOpen: handleOpen,
      onMessage: handleMessage,
      onClose: () => set({ connected: false }),
    });
  }

  // ── Start connection + intervals on store creation ───────────────────────

  // Hydrate session
  wsFetch('/api/session/current')
    .then(r => r.json())
    .then(data => {
      if (data.session) {
        set(s => s.sessionState ? {} : {
          sessionState: {
            id: data.session.id, active: true, startedAt: data.session.startedAt,
            source: data.session.source || 'hydrated', toolCount: data.session.toolCount || 0,
            errorCount: data.session.errorCount || 0, summaries: data.session.summaries || [],
            featureCode: data.session.featureCode || null,
            featureItemId: data.session.featureItemId || null,
            phaseAtBind: data.session.phaseAtBind || null,
            boundAt: data.session.boundAt || null,
          },
        });
      }
    })
    .catch(() => console.warn('[vision] Failed to hydrate session state'));

  // Build state polling (5s fallback)
  refs.buildPollInterval = setInterval(() => {
    wsFetch('/api/build/state')
      .then(r => r.json())
      .then(data => set({ activeBuild: data.state ?? null }))
      .catch(() => {});
  }, 5_000);

  // Recent errors interval (10s, ages out old errors)
  refs.recentErrorsInterval = setInterval(() => {
    const { agentErrors } = get();
    const cutoff = Date.now() - 60_000;
    const recent = agentErrors
      .filter(e => new Date(e.timestamp).getTime() > cutoff)
      .slice(-5);
    set({ recentErrors: recent });
  }, 10_000);

  // Connect WebSocket
  connect();

  // ── Return initial state + actions ───────────────────────────────────────

  return {
    // State
    items: [],
    connections: [],
    connected: false,
    uiCommand: null,
    recentChanges: EMPTY_CHANGES,
    agentActivity: [],
    agentErrors: [],
    recentErrors: [],
    spawnedAgents: [],
    agentRelays: [],
    sessionState: null,
    gates: [],
    gateEvent: null,
    settings: null,
    pipelineDraft: null,
    activeBuild: null,
    iterationStates: new Map(),
    sessions: [],
    // COMP-COCKPIT-3: past-builds history (fetched on demand when the view opens)
    buildHistory: [],
    featureTimeline: [],
    selectedPhase: (() => {
      try { return localStorage.getItem('compose:selectedPhase') || null; } catch { return null; }
    })(),
    // COMP-OBS-BRANCH: per-feature [branchIdA, branchIdB] selection for the compare panel.
    // Session-local; never persisted.
    selectedBranches: {},

    // COMP-OBS-TIMELINE: decision events store slice (in-memory only, re-seeded on reconnect).
    decisionEvents: [],

    // COMP-OBS-STATUS: per-feature status snapshot map { [featureCode]: StatusSnapshot }
    // In-memory, populated by WS push + single GET on feature selection.
    statusSnapshots: {},

    // ── COMP-PIPE-EDIT-1/-2: visual pipeline editor slice ──────────────────
    // All in-memory; the model is the single source of truth, the canvas and
    // inspector are pure projections of it. saveSpec() persists to disk.
    editorSpecFile: null,      // selected pipelines/*.stratum.yaml filename
    editorSpecs: [],           // [{ file, version, flows[] }] from GET /api/pipeline/specs
    editorModel: null,         // specToModel() output ({ version, flows[], contracts{}, _doc })
    editorVersion: null,       // spec version string ('0.2' | '0.3' | '0.1' | …)
    editorSelectedFlow: null,  // name of the flow currently being edited
    editorSelectedStep: null,  // id of the selected step within the flow
    editorDirty: false,        // unsaved edits since last load/save
    editorErrors: { errors: [], warningsByStepId: {} },
    editorReadOnly: false,     // true for v0.1 specs (Stratum can't validate them)

    // ── COMP-PIPE-EDIT-6: YAML sync + conflict resolution ──────────────────
    editorSpecHash: null,      // sha-256 of the on-disk text at load (conflict base)
    editorSaveScope: 'flow',   // 'flow' | 'spec' — latched to 'spec' by any spec-wide
                               // mutation (YAML-pane edit or collapse); reset on load/save/reload
    editorConflict: null,      // null | { currentHash } — set on 409 or specChanged-while-dirty
    editorYamlBuffer: null,    // null when the pane isn't holding pending text; else raw buffer
    editorYamlError: null,     // last YAML parse error message (pane), or null

    // Actions
    clearUICommand: () => set({ uiCommand: null }),

    setSelectedBranches: (featureCode, pair) => set(s => ({
      selectedBranches: { ...s.selectedBranches, [featureCode]: pair },
    })),

    // COMP-OBS-STATUS: store snapshot for a featureCode (map-style merge)
    setStatusSnapshot: (featureCode, snap) => set(s => ({
      statusSnapshots: { ...s.statusSnapshots, [featureCode]: snap },
    })),

    // COMP-OBS-STATUS: clear all snapshots — called on WS reconnect so the
    // selection-change effect refetches against current server state.
    clearStatusSnapshots: () => set({ statusSnapshots: {} }),

    // COMP-OBS-TIMELINE: replace full decisionEvents slice from snapshot (on reconnect/hydrate)
    setDecisionEventsSnapshot: (arr) => set({ decisionEvents: Array.isArray(arr) ? arr : [] }),

    // COMP-OBS-TIMELINE: append single event, deduplicating by id (set-style merge)
    appendDecisionEvent: (ev) => set(s => {
      if (!ev?.id) return s;
      if (s.decisionEvents.some(e => e.id === ev.id)) return s;
      return { decisionEvents: [...s.decisionEvents, ev] };
    }),

    registerSnapshotProvider: (provider) => { refs.snapshotProvider = provider; },

    setActiveBuild: (v) => set({ activeBuild: v }),

    // COMP-COCKPIT-3: fetch past-builds history (read-only GET /api/builds).
    setBuildHistory: (v) => set({ buildHistory: Array.isArray(v) ? v : [] }),
    fetchBuildHistory: async () => {
      try {
        const res = await wsFetch('/api/builds');
        const data = await res.json();
        set({ buildHistory: Array.isArray(data.builds) ? data.builds : [] });
      } catch {
        set({ buildHistory: [] });
      }
    },

    setPipelineDraft: (v) => set({ pipelineDraft: v }),

    // ── COMP-PIPE-EDIT-1/-2: pipeline editor actions ───────────────────────

    // Re-run structural validation for the selected flow and store the result.
    // Internal helper, callable after any mutation; safe when nothing is loaded.
    _revalidateEditor: () => {
      const { editorModel, editorSelectedFlow } = get();
      if (!editorModel || !editorSelectedFlow) {
        set({ editorErrors: { errors: [], warningsByStepId: {} } });
        return;
      }
      set({ editorErrors: validateFlow(editorModel, editorSelectedFlow) });
    },

    // List the raw spec files on disk (filename-keyed; metadata-comment specs are
    // invisible to the template loader, so discovery is by filename).
    loadSpecList: async () => {
      const data = await apiCall('/api/pipeline/specs');
      const specs = Array.isArray(data?.specs) ? data.specs : [];
      set({ editorSpecs: specs });
      return specs;
    },

    // Load a spec's raw YAML, parse it, build the editable model, and select the
    // first editable flow. v0.1 specs load read-only with editorReadOnly=true.
    loadSpecForEdit: async (file) => {
      const data = await apiCall(`/api/pipeline/spec?file=${encodeURIComponent(file)}`);
      if (data?.error || typeof data?.text !== 'string') {
        set({ editorErrors: { errors: [data?.error || 'Failed to load spec'], warningsByStepId: {} } });
        return null;
      }
      const parsed = YAML.parse(data.text);
      const model = specToModel(parsed);
      const flows = listEditableFlows(parsed);
      const selectedFlow = flows[0] || null;
      const readOnly = isReadOnlyVersion(model.version);
      set({
        editorSpecFile: file,
        editorModel: model,
        editorVersion: model.version ?? null,
        editorSelectedFlow: selectedFlow,
        editorSelectedStep: null,
        editorDirty: false,
        editorReadOnly: readOnly,
        editorErrors: selectedFlow
          ? validateFlow(model, selectedFlow)
          : { errors: [], warningsByStepId: {} },
        // COMP-PIPE-EDIT-6: a fresh load is the conflict base; reset the latched
        // save scope and any buffered/erroring pane text and clear any conflict.
        editorSpecHash: typeof data.hash === 'string' ? data.hash : null,
        editorSaveScope: 'flow',
        editorConflict: null,
        editorYamlBuffer: null,
        editorYamlError: null,
      });
      return model;
    },

    selectFlow: (name) => {
      const { editorModel } = get();
      set({
        editorSelectedFlow: name,
        editorSelectedStep: null,
        editorErrors: editorModel && name
          ? validateFlow(editorModel, name)
          : { errors: [], warningsByStepId: {} },
      });
    },

    selectStep: (id) => set({ editorSelectedStep: id }),

    // Patch fields on the selected flow's step. Mutates the model in place
    // (the model is the single source of truth), marks dirty, revalidates.
    updateStep: (id, patch) => {
      const { editorModel, editorSelectedFlow, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return;
      const steps = flowSteps(editorModel, editorSelectedFlow);
      const step = steps.find(s => s.id === id);
      if (!step) return;
      Object.assign(step, patch);
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
    },

    // Rename a step id via the lib so all reference fields are rewritten and the
    // _renamedFrom hint is set (the save path needs it to match the disk node).
    renameStep: (oldId, newId) => {
      const { editorModel, editorSelectedFlow, editorSelectedStep, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return;
      if (!newId || oldId === newId) return;
      renameStepInModel(editorModel, editorSelectedFlow, oldId, newId);
      set({
        editorModel: reactiveModel(editorModel),
        editorDirty: true,
        editorSelectedStep: editorSelectedStep === oldId ? newId : editorSelectedStep,
      });
      get()._revalidateEditor();
    },

    // Append a fresh agent step with a unique id to the selected flow.
    addStep: () => {
      const { editorModel, editorSelectedFlow, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return null;
      const flow = editorModel.flows.find(f => f.name === editorSelectedFlow);
      if (!flow) return null;
      const id = uniqueStepId(flow.steps);
      const newStep = {
        id, kind: 'agent', agent: '', function: undefined, intent: '',
        inputs: {}, output_contract: undefined, ensure: [], retries: undefined,
        depends_on: [], on_fail: undefined, _extra: {},
      };
      flow.steps.push(newStep);
      set({ editorModel: reactiveModel(editorModel), editorDirty: true, editorSelectedStep: id });
      get()._revalidateEditor();
      return id;
    },

    // Delete a step. Blocked (surfaced in editorErrors, no mutation) when another
    // step still references it via any ref field (depends_on/on_fail/gate/source).
    deleteStep: (id) => {
      const { editorModel, editorSelectedFlow, editorSelectedStep, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return false;
      const check = canDeleteStep(editorModel, editorSelectedFlow, id);
      if (!check.ok) {
        set(s => ({
          editorErrors: {
            errors: [check.reason, ...(s.editorErrors?.errors || [])],
            warningsByStepId: {
              ...(s.editorErrors?.warningsByStepId || {}),
              [id]: [check.reason, ...((s.editorErrors?.warningsByStepId || {})[id] || [])],
            },
          },
        }));
        return false;
      }
      deleteStepInModel(editorModel, editorSelectedFlow, id);
      set({
        editorModel: reactiveModel(editorModel),
        editorDirty: true,
        editorSelectedStep: editorSelectedStep === id ? null : editorSelectedStep,
      });
      get()._revalidateEditor();
      return true;
    },

    // Persist the model back to its source file.
    //  - COMP-PIPE-EDIT-6: sends baseHash for optimistic-concurrency; omits
    //    flowName when the save scope is latched to 'spec' (server writes every
    //    flow). force:true bypasses the disk-hash check (overwrite). A pending or
    //    unparseable YAML-pane buffer BLOCKS the save (no POST) — saving then would
    //    persist the stale model instead of the visible buffer (data-loss path).
    //  - On a 409 conflict, dirty is preserved and editorConflict is set.
    //  - On success, editorSpecHash is updated and the scope is reset to 'flow'.
    saveSpec: async ({ force = false } = {}) => {
      const {
        editorModel, editorSpecFile, editorSelectedFlow, editorReadOnly,
        editorSaveScope, editorSpecHash, editorYamlBuffer, editorYamlError,
      } = get();
      if (!editorModel || !editorSpecFile || editorReadOnly) {
        return { error: 'No editable spec loaded' };
      }
      // Block while the YAML pane holds pending/unparseable text — it must flush
      // to the model first or the save would persist the stale model.
      if (editorYamlBuffer != null || editorYamlError) {
        const message = 'Resolve the YAML pane (let it parse) before saving';
        get()._surfaceEditorError(message);
        return { error: message };
      }
      const body = { file: editorSpecFile, model: editorModel };
      if (editorSaveScope !== 'spec') body.flowName = editorSelectedFlow;
      if (editorSpecHash != null) body.baseHash = editorSpecHash;
      if (force) body.force = true;
      const res = await wsFetch('/api/pipeline/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data;
      try { data = await res.json(); } catch { data = {}; }
      // 409 → disk diverged from baseHash. Keep dirty, record the conflict.
      if (res.status === 409 || data?.conflict) {
        set({ editorConflict: { currentHash: data?.currentHash ?? null } });
        return { error: data?.error || 'Spec changed on disk', conflict: true, currentHash: data?.currentHash };
      }
      if (!res.ok) {
        return { error: data?.error || `HTTP ${res.status}` };
      }
      if (data && data.ok) {
        // After persisting, the disk node ids now equal the model ids for the
        // saved flow, so drop its rename hints — a later rename must re-anchor to
        // the now-current id (else save→rename→save would miss the disk node).
        if (editorSaveScope === 'spec') {
          for (const f of editorModel.flows) for (const s of f.steps) delete s._renamedFrom;
        } else {
          const flow = editorModel.flows.find(f => f.name === editorSelectedFlow);
          if (flow) for (const s of flow.steps) delete s._renamedFrom;
        }
        set({
          editorModel: reactiveModel(editorModel),
          editorDirty: false,
          // A successful write is a new conflict base; un-latch the save scope.
          editorSpecHash: typeof data.hash === 'string' ? data.hash : get().editorSpecHash,
          editorSaveScope: 'flow',
          editorConflict: null,
        });
      }
      return data;
    },

    // ── COMP-PIPE-EDIT-6: YAML pane buffer + flush ─────────────────────────
    // Stash raw pane text as a pending buffer (text may diverge from the model
    // mid-type / on parse error). flushYaml() reconciles it into the model.
    setYamlBuffer: (text) => set({ editorYamlBuffer: text, editorYamlError: null }),

    // Parse the pending buffer → model. On success: replace the model, reconcile
    // the selected flow, validate SPEC-WIDE, latch the save scope to 'spec', and
    // clear the buffer. On parse error: keep the model, surface the message inline
    // and record editorYamlError (the buffer stays pending). No-op when nothing is
    // buffered or the spec is read-only.
    flushYaml: () => {
      const { editorModel, editorYamlBuffer, editorReadOnly, editorSelectedFlow } = get();
      if (editorModel == null || editorReadOnly) return false;
      if (editorYamlBuffer == null) return false;
      let parsed;
      try {
        parsed = YAML.parse(editorYamlBuffer);
      } catch (err) {
        const message = `YAML parse error: ${err?.message || err}`;
        set({ editorYamlError: message });
        get()._surfaceEditorError(message);
        return false;
      }
      const model = specToModel(parsed);
      const editableFlows = listEditableFlows(model._doc);
      // Reconcile the selected flow: if it vanished, re-point to the first editable.
      const selectedFlow = editableFlows.includes(editorSelectedFlow)
        ? editorSelectedFlow
        : (editableFlows[0] || null);
      set({
        editorModel: reactiveModel(model),
        editorSelectedFlow: selectedFlow,
        editorDirty: true,
        editorSaveScope: 'spec',
        editorYamlBuffer: null,
        editorYamlError: null,
        editorErrors: validateSpecWide(model, editableFlows, selectedFlow),
      });
      return true;
    },

    // ── COMP-PIPE-EDIT-6: conflict resolution ──────────────────────────────
    // 'reload'   → discard local edits, re-fetch the spec from disk.
    // 'overwrite'→ re-save with force:true (bypass the disk-hash check).
    // The banner is cleared ONLY after the resolution actually succeeds — a
    // blocked/failed overwrite (e.g. a pending YAML buffer) or a failed re-fetch
    // leaves the conflict unresolved, so keep the banner and surface the error.
    // (loadSpecForEdit resets editorConflict to null itself on a successful load.)
    resolveConflict: async (mode) => {
      const { editorSpecFile } = get();
      if (mode === 'reload') {
        if (!editorSpecFile) return null;
        return get().loadSpecForEdit(editorSpecFile); // clears conflict on success
      }
      if (mode === 'overwrite') {
        const res = await get().saveSpec({ force: true }); // clears conflict on ok
        return res;
      }
      return { error: `Unknown conflict resolution "${mode}"` };
    },

    // ── COMP-PIPE-EDIT-5: collapse / expand sub-flows ──────────────────────
    // Collapse the given step ids in the selected flow into a new sub-flow.
    // On reject ({ ok:false }) surface the reason; on success replace the model,
    // mark dirty, latch the save scope to 'spec' (a collapse touches two flows),
    // and revalidate. No-op when nothing is loaded or read-only.
    collapseSelectedToSubflow: (stepIds, newName) => {
      const { editorModel, editorSelectedFlow, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return false;
      const result = collapseToSubflow(editorModel, editorSelectedFlow, stepIds, newName);
      if (!result.ok) {
        get()._surfaceEditorError(result.reason || 'Cannot collapse the selected steps');
        return false;
      }
      set({
        editorModel: reactiveModel(editorModel),
        editorDirty: true,
        editorSaveScope: 'spec',
        editorSelectedStep: null,
      });
      get()._revalidateEditor();
      return true;
    },

    // Expand a sub-flow == open it for editing (reuse the flow switcher).
    expandSubflow: (flowName) => { if (flowName) get().selectFlow(flowName); },

    // ── COMP-PIPE-EDIT-6: external on-disk change ──────────────────────────
    // Reacts to a vision-WS specChanged for the OPEN spec. Auto-reload (refresh
    // model + hash) ONLY when the editor is truly clean. "Clean" means no model
    // edits AND no in-flight YAML-pane buffer: a pane edit doesn't set
    // editorDirty until flushYaml succeeds, so treating editorDirty alone as the
    // signal would discard a pending/unparseable buffer mid-debounce. Any pending
    // work (dirty OR a buffer OR a parse error) raises a conflict banner instead.
    handleSpecChanged: ({ currentHash } = {}) => {
      const { editorSpecFile, editorDirty, editorYamlBuffer, editorYamlError } = get();
      if (!editorSpecFile) return undefined;
      const clean = !editorDirty && editorYamlBuffer == null && !editorYamlError;
      if (clean) {
        return get().loadSpecForEdit(editorSpecFile);
      }
      set({ editorConflict: { currentHash: currentHash ?? null } });
      return undefined;
    },

    // ── COMP-PIPE-EDIT-3: dependency wiring ────────────────────────────────
    // Surface a transient editor error message (prepended; mirrors deleteStep).
    // The optional stepId pins the message to a node's inline-warning list.
    _surfaceEditorError: (message, stepId) => {
      set(s => {
        const prevWarn = s.editorErrors?.warningsByStepId || {};
        const warningsByStepId = stepId
          ? { ...prevWarn, [stepId]: [message, ...(prevWarn[stepId] || [])] }
          : prevWarn;
        return {
          editorErrors: {
            errors: [message, ...(s.editorErrors?.errors || [])],
            warningsByStepId,
          },
        };
      });
    },

    // Add `depId` to a step's depends_on. Guards with wouldCreateCycle FIRST;
    // if it would cycle (or the lib add returns false — self/dup/dangling) the
    // model is NOT mutated and a transient message is surfaced. Edge semantics:
    // the canvas draws source→target as "target depends_on source", so connecting
    // producer→consumer calls addDependency(consumerId, producerId).
    addDependency: (stepId, depId) => {
      const { editorModel, editorSelectedFlow, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return false;
      if (wouldCreateCycle(editorModel, editorSelectedFlow, stepId, depId)) {
        get()._surfaceEditorError(
          `Cannot add dependency "${stepId}" → "${depId}": would create a cycle`,
          stepId,
        );
        return false;
      }
      const added = addDependencyInModel(editorModel, editorSelectedFlow, stepId, depId);
      if (!added) {
        get()._surfaceEditorError(
          `Cannot add dependency "${stepId}" → "${depId}": invalid (self-edge, duplicate, or missing step)`,
          stepId,
        );
        return false;
      }
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    removeDependency: (stepId, depId) => {
      const { editorModel, editorSelectedFlow, editorReadOnly } = get();
      if (!editorModel || !editorSelectedFlow || editorReadOnly) return false;
      const removed = removeDependencyInModel(editorModel, editorSelectedFlow, stepId, depId);
      if (!removed) return false;
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    // ── COMP-PIPE-EDIT-4: contract editing ─────────────────────────────────
    // Each wraps a (throwing) lib helper; on throw the message is surfaced into
    // editorErrors and nothing mutates, mirroring the deleteStep blocked path.
    addContract: (name) => {
      const { editorModel, editorReadOnly } = get();
      if (!editorModel || editorReadOnly) return false;
      try {
        addContractInModel(editorModel, name);
      } catch (err) {
        get()._surfaceEditorError(err.message);
        return false;
      }
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    renameContract: (oldName, newName) => {
      const { editorModel, editorReadOnly } = get();
      if (!editorModel || editorReadOnly) return false;
      if (!newName || oldName === newName) return false;
      try {
        renameContractInModel(editorModel, oldName, newName);
      } catch (err) {
        get()._surfaceEditorError(err.message);
        return false;
      }
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    // Blocked (surfaced, no mutation) when any of the three ref sites still
    // names the contract — surfaces canDeleteContract's reason, like deleteStep.
    deleteContract: (name) => {
      const { editorModel, editorReadOnly } = get();
      if (!editorModel || editorReadOnly) return false;
      const check = canDeleteContract(editorModel, name);
      if (!check.ok) {
        get()._surfaceEditorError(check.reason);
        return false;
      }
      deleteContractInModel(editorModel, name);
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    setContractField: (name, fieldName, fieldSpec) => {
      const { editorModel, editorReadOnly } = get();
      if (!editorModel || editorReadOnly) return false;
      try {
        setContractFieldInModel(editorModel, name, fieldName, fieldSpec);
      } catch (err) {
        get()._surfaceEditorError(err.message);
        return false;
      }
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    removeContractField: (name, fieldName) => {
      const { editorModel, editorReadOnly } = get();
      if (!editorModel || editorReadOnly) return false;
      try {
        removeContractFieldInModel(editorModel, name, fieldName);
      } catch (err) {
        get()._surfaceEditorError(err.message);
        return false;
      }
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    renameContractField: (name, oldField, newField) => {
      const { editorModel, editorReadOnly } = get();
      if (!editorModel || editorReadOnly) return false;
      if (!newField || oldField === newField) return false;
      try {
        renameContractFieldInModel(editorModel, name, oldField, newField);
      } catch (err) {
        get()._surfaceEditorError(err.message);
        return false;
      }
      set({ editorModel: reactiveModel(editorModel), editorDirty: true });
      get()._revalidateEditor();
      return true;
    },

    // ── COMP-PIPE-EDIT-7: save-as-template ─────────────────────────────────
    // POST the current model as a NEW pipelines/<file>.stratum.yaml. Returns the
    // server response (incl. { error } on 409 id-collision / overwrite refusal).
    // Never clears editorDirty (the source file is unchanged by a template save).
    saveAsTemplate: async ({ filename, metadata }) => {
      const { editorModel, editorErrors } = get();
      if (!editorModel) return { error: 'No spec loaded' };
      // Never publish a template that fails validation (mirrors the saveSpec gate;
      // the UI also disables the button, this is the defense-in-depth backstop).
      if ((editorErrors?.errors?.length || 0) > 0) {
        return { error: 'Resolve validation errors before saving as a template' };
      }
      return apiCall('/api/pipeline/save-as-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, model: editorModel, metadata }),
      });
    },

    setFeatureTimeline: (updater) => set(s => ({
      featureTimeline: typeof updater === 'function' ? updater(s.featureTimeline) : updater,
    })),

    setSelectedPhase: (phase) => {
      set({ selectedPhase: phase });
      try {
        if (phase) localStorage.setItem('compose:selectedPhase', phase);
        else localStorage.removeItem('compose:selectedPhase');
      } catch { /* ignore */ }
    },

    updateItemPosition: (id, position) => {
      set(s => ({ items: s.items.map(item => item.id === id ? { ...item, position } : item) }));
    },

    // REST mutations
    createItem: (data) => apiCall('/api/vision/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),

    updateItem: (id, data) => apiCall(`/api/vision/items/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),

    deleteItem: (id) => apiCall(`/api/vision/items/${id}`, { method: 'DELETE' }),

    createConnection: (data) => apiCall('/api/vision/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),

    deleteConnection: (id) => apiCall(`/api/vision/connections/${id}`, { method: 'DELETE' }),

    resolveGate: async (gateId, outcome, comment) => {
      refs.pendingResolveIds.add(gateId);
      try {
        const data = await apiCall(`/api/vision/gates/${gateId}/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome, comment }),
        });
        if (data.error) refs.pendingResolveIds.delete(gateId);
        return data;
      } catch {
        refs.pendingResolveIds.delete(gateId);
        return { error: 'Network error' };
      }
    },

    updateSettings: (patch) => apiCall('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }),

    resetSettings: (section) => apiCall('/api/settings/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(section ? { section } : {}),
    }),
  };
});

// ─── HMR teardown ────────────────────────────────────────────────────────────
// P2 fix: clean up WebSocket, timers, and intervals on hot reload so the old
// module instance doesn't leak alongside the new one.

function teardown() {
  refs.disposed = true;
  if (refs.ws) { try { refs.ws.close(); } catch { /* ignore */ } refs.ws = null; }
  if (refs.changeTimer) { clearTimeout(refs.changeTimer); refs.changeTimer = null; }
  if (refs.sessionEndTimer) { clearTimeout(refs.sessionEndTimer); refs.sessionEndTimer = null; }
  if (refs.buildPollInterval) { clearInterval(refs.buildPollInterval); refs.buildPollInterval = null; }
  if (refs.recentErrorsInterval) { clearInterval(refs.recentErrorsInterval); refs.recentErrorsInterval = null; }
}

if (import.meta.hot) {
  import.meta.hot.dispose(teardown);
}
