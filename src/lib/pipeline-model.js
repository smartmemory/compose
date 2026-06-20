/**
 * pipeline-model.js — Pure, framework-free in-memory model for Stratum pipeline specs.
 *
 * COMP-PIPE-EDIT-1 / T1. This module receives an ALREADY-PARSED spec object
 * (the output of `YAML.parse`) and never touches the filesystem, the DOM, or
 * React. It powers the visual pipeline editor's load → edit → validate logic;
 * serialization back to disk (with comment/metadata preservation) is the
 * backend's job (server/pipeline-routes.js), which uses the YAML Document API.
 *
 * ## Flow-scoped model (design-gate correction)
 *
 * Real v0.3 specs are multi-flow: `build.stratum.yaml` has a `review_check`
 * subflow AND a main `build` flow, and the step id `review` exists in BOTH.
 * A flat steps[] keyed by id would collide ids and erase flow boundaries.
 * So step identity here is (flowName, id). The model carries every flow; the
 * editor edits one flow at a time.
 *
 * ## Steps location (all versions)
 *
 *   workflow.steps  (if present)  → one synthetic flow named `workflow.name`
 *   flows.<name>.steps            → one flow per key
 *
 * `functions:` holds reusable function DEFINITIONS, not steps. It is only a
 * last-resort fallback for function-only specs that define no flow steps.
 *
 * ## Normalized step shape (internal)
 *
 *   { id, kind, agent, function, intent, inputs, output_contract,
 *     ensure[], retries, depends_on[], on_fail, _extra{} }
 *
 * `_extra` carries every field this milestone does not surface for editing
 * (skip_if, skip_reason, type, gate routes on_approve/on_revise/on_kill,
 * parallel-dispatch source/max_concurrent/isolation/require/merge/intent_template,
 * reasoning_template, flow, validate, …) so they survive round-trip untouched.
 */

// Fields the model surfaces as first-class (everything else lands in _extra).
const SURFACED_KEYS = new Set([
  'id', 'agent', 'function', 'intent', 'inputs',
  'output_contract', 'ensure', 'retries', 'depends_on', 'on_fail',
]);

// Built-in contracts that are always valid as an output_contract, in addition
// to the contracts declared in the spec.
const BUILTIN_CONTRACTS = new Set(['TaskGraph', 'none']);

// Step-reference fields that must resolve to a step in the same flow.
// `depends_on` is an array; the rest are scalar id refs. `source` is a
// $.steps.<id>.output... jsonpath-ish ref (only when it targets a step).
const SCALAR_REF_FIELDS = ['on_fail', 'on_approve', 'on_revise', 'on_kill'];

/**
 * Extract `{ name, steps[] }` flow descriptors from a parsed spec, version-aware.
 * @returns {Array<{ name: string, rawSteps: object[] }>}
 */
function extractFlows(parsedDoc) {
  const flows = [];

  // workflow.steps → one synthetic flow.
  if (Array.isArray(parsedDoc?.workflow?.steps)) {
    const name = parsedDoc.workflow.name || 'workflow';
    flows.push({ name, rawSteps: parsedDoc.workflow.steps });
  }

  // flows.<name>.steps → one flow per key.
  if (parsedDoc?.flows && typeof parsedDoc.flows === 'object') {
    for (const name of Object.keys(parsedDoc.flows)) {
      const flow = parsedDoc.flows[name];
      if (Array.isArray(flow?.steps)) {
        flows.push({ name, rawSteps: flow.steps });
      }
    }
  }

  // Fallback: function-only spec with no flow steps at all.
  if (flows.length === 0 && parsedDoc?.functions && typeof parsedDoc.functions === 'object') {
    const rawSteps = Object.keys(parsedDoc.functions).map(id => ({ id, function: id }));
    flows.push({ name: 'functions', rawSteps });
  }

  return flows;
}

/** Normalize one raw step object into the internal shape. */
function normalizeStep(raw) {
  const _extra = {};
  for (const key of Object.keys(raw)) {
    if (!SURFACED_KEYS.has(key)) _extra[key] = raw[key];
  }

  // `kind` classifies the step for the canvas: agent | function | flow | parallel.
  let kind = 'agent';
  if (raw.flow) kind = 'flow';
  else if (raw.type === 'parallel_dispatch') kind = 'parallel';
  else if (raw.function && raw.agent === undefined) kind = 'function';
  else if (raw.agent !== undefined) kind = 'agent';
  else if (raw.function) kind = 'function';

  return {
    id: raw.id,
    kind,
    agent: raw.agent,
    function: raw.function,
    intent: raw.intent,
    inputs: raw.inputs ? { ...raw.inputs } : {},
    output_contract: raw.output_contract,
    ensure: Array.isArray(raw.ensure) ? [...raw.ensure] : [],
    retries: raw.retries,
    depends_on: Array.isArray(raw.depends_on) ? [...raw.depends_on] : [],
    on_fail: raw.on_fail,
    _extra,
  };
}

/**
 * Build the editable model from a parsed spec object.
 * @returns {{ version, flows: Array<{name, steps[]}>, contracts: object, _doc }}
 */
export function specToModel(parsedDoc) {
  const doc = parsedDoc || {};
  const rawFlows = extractFlows(doc);
  const flows = rawFlows.map(({ name, rawSteps }) => ({
    name,
    steps: rawSteps.map(normalizeStep),
  }));

  return {
    version: doc.version,
    flows,
    // Deep-copy contracts so nested field edits on the model never leak into the
    // parsed source object (the backend re-parses disk for serialization, and the
    // model is meant to be an isolated, freely-editable working copy).
    contracts: deepCopyContracts(doc.contracts),
    _doc: doc,
  };
}

/** Structured deep clone of the contracts block (plain JSON-ish data). */
function deepCopyContracts(contracts) {
  if (!contracts || typeof contracts !== 'object') return {};
  return JSON.parse(JSON.stringify(contracts));
}

/** Return the normalized steps[] for one flow (live reference into the model). */
export function flowSteps(model, flowName) {
  const flow = model.flows.find(f => f.name === flowName);
  return flow ? flow.steps : [];
}

/** Return flow names that have a non-empty steps[]. */
export function listEditableFlows(parsedDoc) {
  return extractFlows(parsedDoc)
    .filter(f => f.rawSteps.length > 0)
    .map(f => f.name);
}

/** Serialize one normalized step back to a plain object (merging _extra). */
function denormalizeStep(step) {
  const out = {};
  // Start with id so it leads.
  out.id = step.id;

  // Merge _extra first so surfaced fields below take precedence on key collision,
  // but _extra also carries things like `flow`, `type`, gate routes, source.
  for (const key of Object.keys(step._extra || {})) {
    out[key] = step._extra[key];
  }

  if (step.agent !== undefined) out.agent = step.agent;
  if (step.function !== undefined) out.function = step.function;
  if (step.intent !== undefined) out.intent = step.intent;
  if (step.inputs && Object.keys(step.inputs).length > 0) out.inputs = { ...step.inputs };
  if (step.output_contract !== undefined) out.output_contract = step.output_contract;
  if (Array.isArray(step.ensure) && step.ensure.length > 0) out.ensure = [...step.ensure];
  if (step.retries !== undefined) out.retries = step.retries;
  if (Array.isArray(step.depends_on) && step.depends_on.length > 0) out.depends_on = [...step.depends_on];
  if (step.on_fail !== undefined) out.on_fail = step.on_fail;

  return out;
}

/**
 * Convert the model back to a plain spec object suitable for serialization.
 * (The backend prefers in-place YAML Document mutation; this is the fallback
 * serializer and a test oracle for shape preservation.)
 */
export function modelToSpecObject(model) {
  const doc = model._doc || {};
  const out = { ...doc };

  // Rebuild flows / workflow.steps from the model, preserving other flow keys.
  const byName = new Map(model.flows.map(f => [f.name, f]));

  // workflow.steps case.
  if (Array.isArray(doc?.workflow?.steps)) {
    const wfName = doc.workflow.name || 'workflow';
    const flow = byName.get(wfName);
    if (flow) {
      out.workflow = { ...doc.workflow, steps: flow.steps.map(denormalizeStep) };
    }
  }

  // flows.<name>.steps case — preserve each flow's other keys (input/output/...).
  if (doc?.flows && typeof doc.flows === 'object') {
    out.flows = {};
    for (const name of Object.keys(doc.flows)) {
      const flow = byName.get(name);
      if (flow) {
        out.flows[name] = { ...doc.flows[name], steps: flow.steps.map(denormalizeStep) };
      } else {
        out.flows[name] = doc.flows[name];
      }
    }
  }

  return out;
}

// Extract a referenced step id from a JSONPath of the form `$.steps.<id>.…`.
// Returns null for non-step paths (e.g. `$.input.x`). The id capture is greedy
// over [A-Za-z0-9_-] so hyphenated ids are captured whole.
const STEPS_PATH_RE = /^\$\.steps\.([A-Za-z0-9_-]+)/;
function stepIdFromPath(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(STEPS_PATH_RE);
  return m ? m[1] : null;
}

/** Collect every step-id reference a step makes, tagged by source field. */
function stepRefs(step) {
  const refs = [];
  for (const id of (step.depends_on || [])) refs.push({ field: 'depends_on', id });
  for (const field of SCALAR_REF_FIELDS) {
    const v = field === 'on_fail' ? step.on_fail : step._extra?.[field];
    if (v != null && v !== 'null') refs.push({ field, id: v });
  }
  // inputs values of the form `$.steps.<id>.output…` reference a prior step.
  for (const [key, v] of Object.entries(step.inputs || {})) {
    const id = stepIdFromPath(v);
    if (id) refs.push({ field: `inputs.${key}`, id });
  }
  // parallel `source` of the form `$.steps.<id>.output…`.
  const sourceId = stepIdFromPath(step._extra?.source);
  if (sourceId) refs.push({ field: 'source', id: sourceId });
  return refs;
}

/**
 * Structural validation of one flow.
 * @returns {{ errors: string[], warningsByStepId: object }}
 */
export function validateFlow(model, flowName) {
  const steps = flowSteps(model, flowName);
  const errors = [];
  const warningsByStepId = {};

  const ids = steps.map(s => s.id);
  const idSet = new Set(ids);

  // Duplicate ids (also flagged per-step so the inspector/canvas can badge it).
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      const msg = `Duplicate step id "${id}" in flow "${flowName}"`;
      errors.push(msg);
      (warningsByStepId[id] ||= []).push(msg);
    }
    seen.add(id);
  }

  // Reference integrity across every ref field.
  const contractNames = new Set([...Object.keys(model.contracts || {}), ...BUILTIN_CONTRACTS]);
  for (const step of steps) {
    // Dangling refs.
    for (const { field, id } of stepRefs(step)) {
      if (!idSet.has(id)) {
        const msg = `Step "${step.id}" ${field} references unknown step "${id}" in flow "${flowName}"`;
        errors.push(msg);
        (warningsByStepId[step.id] ||= []).push(msg);
      }
    }
    // Unknown output_contract.
    if (step.output_contract != null && !contractNames.has(step.output_contract)) {
      const msg = `Step "${step.id}" output_contract "${step.output_contract}" is not a known contract`;
      errors.push(msg);
      (warningsByStepId[step.id] ||= []).push(msg);
    }
  }

  // depends_on cycle detection (DFS).
  const adj = new Map(steps.map(s => [s.id, (s.depends_on || []).filter(d => idSet.has(d))]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(ids.map(id => [id, WHITE]));
  let cycleFound = false;
  const visit = (node) => {
    if (cycleFound) return;
    color.set(node, GRAY);
    for (const dep of (adj.get(node) || [])) {
      if (color.get(dep) === GRAY) { cycleFound = true; return; }
      if (color.get(dep) === WHITE) visit(dep);
    }
    color.set(node, BLACK);
  };
  for (const id of ids) {
    if (color.get(id) === WHITE) visit(id);
    if (cycleFound) break;
  }
  if (cycleFound) errors.push(`Dependency cycle detected in flow "${flowName}"`);

  return { errors, warningsByStepId };
}

/** Rewrite a single ref value if it equals oldId. */
function rewriteScalar(value, oldId, newId) {
  return value === oldId ? newId : value;
}

/** Rewrite the step id in a `$.steps.<id>.…` JSONPath, matching the whole id. */
function rewriteStepsPath(value, oldId, newId) {
  if (typeof value !== 'string') return value;
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  // Negative lookahead, not \b, so `foo` does not match inside `foo-bar`.
  return value.replace(new RegExp(`^(\\$\\.steps\\.)${escaped}(?![A-Za-z0-9_-])`), `$1${newId}`);
}

/**
 * Rename a step id within a flow, rewriting ALL reference fields
 * (depends_on, on_fail, on_approve/on_revise/on_kill, inputs JSONPaths,
 * parallel source).
 */
export function renameStep(model, flowName, oldId, newId) {
  const steps = flowSteps(model, flowName);
  for (const step of steps) {
    if (step.id === oldId) {
      // Record the ORIGINAL on-disk id (across chained renames) so the save path
      // can still match this step to its existing YAML node and preserve
      // disk-only fields. Internal-only: never serialized (not surfaced, not _extra).
      if (step._renamedFrom === undefined) step._renamedFrom = oldId;
      step.id = newId;
    }

    if (Array.isArray(step.depends_on)) {
      step.depends_on = step.depends_on.map(d => rewriteScalar(d, oldId, newId));
    }
    if (step.on_fail !== undefined) step.on_fail = rewriteScalar(step.on_fail, oldId, newId);

    for (const field of ['on_approve', 'on_revise', 'on_kill']) {
      if (step._extra && step._extra[field] !== undefined) {
        step._extra[field] = rewriteScalar(step._extra[field], oldId, newId);
      }
    }
    for (const key of Object.keys(step.inputs || {})) {
      step.inputs[key] = rewriteStepsPath(step.inputs[key], oldId, newId);
    }
    if (step._extra && typeof step._extra.source === 'string') {
      step._extra.source = rewriteStepsPath(step._extra.source, oldId, newId);
    }
  }
  return model;
}

/**
 * Whether a step can be deleted without orphaning a reference.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canDeleteStep(model, flowName, id) {
  const steps = flowSteps(model, flowName);
  for (const step of steps) {
    if (step.id === id) continue;
    for (const ref of stepRefs(step)) {
      if (ref.id === id) {
        return {
          ok: false,
          reason: `Cannot delete "${id}": step "${step.id}" references it via ${ref.field}`,
        };
      }
    }
  }
  return { ok: true };
}

/** Delete a step; throws if the delete would orphan a reference. */
export function deleteStep(model, flowName, id) {
  const check = canDeleteStep(model, flowName, id);
  if (!check.ok) throw new Error(check.reason);
  const flow = model.flows.find(f => f.name === flowName);
  if (!flow) throw new Error(`Unknown flow "${flowName}"`);
  flow.steps = flow.steps.filter(s => s.id !== id);
  return model;
}

// ===========================================================================
// COMP-PIPE-EDIT-3 — Dependency wiring (pure)
// ===========================================================================

/**
 * Add `depId` to a step's `depends_on`. No-op (returns false) if the edge
 * already exists, is a self-edge (stepId === depId), or either endpoint is not a
 * real step in the flow (no dangling edges). Returns true if added.
 * Does NOT itself reject cycles — the caller gates with `wouldCreateCycle`.
 */
export function addDependency(model, flowName, stepId, depId) {
  if (stepId === depId) return false;
  const steps = flowSteps(model, flowName);
  const step = steps.find(s => s.id === stepId);
  if (!step) return false;
  // Reject dangling edges: depId must be a real step in the same flow.
  if (!steps.some(s => s.id === depId)) return false;
  if (!Array.isArray(step.depends_on)) step.depends_on = [];
  if (step.depends_on.includes(depId)) return false;
  step.depends_on.push(depId);
  return true;
}

/**
 * Remove `depId` from a step's `depends_on`. Returns true if removed, false if
 * the edge was absent.
 */
export function removeDependency(model, flowName, stepId, depId) {
  const step = flowSteps(model, flowName).find(s => s.id === stepId);
  if (!step || !Array.isArray(step.depends_on)) return false;
  const idx = step.depends_on.indexOf(depId);
  if (idx === -1) return false;
  step.depends_on.splice(idx, 1);
  return true;
}

/**
 * Pure DFS: would adding the edge `stepId depends_on depId` close a cycle?
 * True iff `depId` already (transitively) depends on `stepId` — i.e. there is a
 * path from `depId` back to `stepId` along the existing `depends_on` edges. A
 * self-edge (stepId === depId) is treated as a cycle.
 */
export function wouldCreateCycle(model, flowName, stepId, depId) {
  if (stepId === depId) return true;
  const steps = flowSteps(model, flowName);
  const deps = new Map(steps.map(s => [s.id, Array.isArray(s.depends_on) ? s.depends_on : []]));
  // Walk depId's dependency closure; if we reach stepId, the new edge closes a cycle.
  const seen = new Set();
  const stack = [depId];
  while (stack.length) {
    const node = stack.pop();
    if (node === stepId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const d of (deps.get(node) || [])) stack.push(d);
  }
  return false;
}

// ===========================================================================
// COMP-PIPE-EDIT-4 — Contract editing (pure)
// ===========================================================================
//
// A contract NAME is referenced in three places across the spec:
//   1. step.output_contract  — on normalized flow steps (model.flows[].steps[])
//   2. _doc.flows.<name>.output    — passthrough scalar on each flow
//   3. _doc.functions.<name>.output — passthrough scalar on each function def
// Every rename/delete check must honor all three.

const RESERVED_CONTRACT = 'TaskGraph';

/** Collect every (site, ref) that names a contract, across all three sites. */
function contractRefSites(model, name) {
  const sites = [];
  // Site 1: step output_contracts.
  for (const flow of (model.flows || [])) {
    for (const step of (flow.steps || [])) {
      if (step.output_contract === name) {
        sites.push(`flow "${flow.name}" step "${step.id}" output_contract`);
      }
    }
  }
  // Site 2: flows.<name>.output (passthrough).
  const docFlows = model._doc?.flows;
  if (docFlows && typeof docFlows === 'object') {
    for (const fname of Object.keys(docFlows)) {
      if (docFlows[fname] && docFlows[fname].output === name) {
        sites.push(`flows.${fname}.output`);
      }
    }
  }
  // Site 3: functions.<name>.output (passthrough).
  const docFns = model._doc?.functions;
  if (docFns && typeof docFns === 'object') {
    for (const fnName of Object.keys(docFns)) {
      if (docFns[fnName] && docFns[fnName].output === name) {
        sites.push(`functions.${fnName}.output`);
      }
    }
  }
  return sites;
}

/** Add an empty contract. Throws on duplicate or the reserved TaskGraph name. */
export function addContract(model, name) {
  if (name === RESERVED_CONTRACT) {
    throw new Error(`"${RESERVED_CONTRACT}" is a reserved built-in contract and cannot be added`);
  }
  if (!model.contracts) model.contracts = {};
  if (name in model.contracts) {
    throw new Error(`Contract "${name}" already exists`);
  }
  model.contracts[name] = {};
  return model;
}

/**
 * Rename a contract key AND rewrite every reference across all three sites
 * (step.output_contract, _doc.flows.*.output, _doc.functions.*.output).
 * Throws if newName already exists or is the reserved TaskGraph.
 */
export function renameContract(model, oldName, newName) {
  if (newName === RESERVED_CONTRACT || oldName === RESERVED_CONTRACT) {
    throw new Error(`"${RESERVED_CONTRACT}" is a reserved built-in contract and cannot be renamed`);
  }
  if (oldName === newName) return model;
  if (!model.contracts || !(oldName in model.contracts)) {
    throw new Error(`Contract "${oldName}" does not exist`);
  }
  if (newName in model.contracts) {
    throw new Error(`Contract "${newName}" already exists`);
  }

  // Rename the key, preserving insertion order.
  const rebuilt = {};
  for (const key of Object.keys(model.contracts)) {
    if (key === oldName) rebuilt[newName] = model.contracts[oldName];
    else rebuilt[key] = model.contracts[key];
  }
  model.contracts = rebuilt;

  // Site 1: step output_contracts.
  for (const flow of (model.flows || [])) {
    for (const step of (flow.steps || [])) {
      if (step.output_contract === oldName) step.output_contract = newName;
    }
  }
  // Site 2 + 3: passthrough flows/functions outputs.
  const docFlows = model._doc?.flows;
  if (docFlows && typeof docFlows === 'object') {
    for (const fname of Object.keys(docFlows)) {
      if (docFlows[fname] && docFlows[fname].output === oldName) docFlows[fname].output = newName;
    }
  }
  const docFns = model._doc?.functions;
  if (docFns && typeof docFns === 'object') {
    for (const fnName of Object.keys(docFns)) {
      if (docFns[fnName] && docFns[fnName].output === oldName) docFns[fnName].output = newName;
    }
  }
  return model;
}

/**
 * Whether a contract can be deleted (no reference at any of the three sites).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canDeleteContract(model, name) {
  if (name === RESERVED_CONTRACT) {
    return { ok: false, reason: `"${RESERVED_CONTRACT}" is a reserved built-in contract and cannot be deleted` };
  }
  const sites = contractRefSites(model, name);
  if (sites.length > 0) {
    return { ok: false, reason: `Cannot delete contract "${name}": still referenced by ${sites.join(', ')}` };
  }
  return { ok: true };
}

/** Delete a contract; throws if any of the three ref sites still references it. */
export function deleteContract(model, name) {
  const check = canDeleteContract(model, name);
  if (!check.ok) throw new Error(check.reason);
  if (model.contracts) delete model.contracts[name];
  return model;
}

// The reserved built-in is locked against all field-level edits too.
function assertContractEditable(name) {
  if (name === RESERVED_CONTRACT) {
    throw new Error(`"${RESERVED_CONTRACT}" is a reserved built-in contract and cannot be edited`);
  }
}

/** Set (add or replace) a field spec `{type, values?, optional?}` on a contract. */
export function setContractField(model, name, fieldName, fieldSpec) {
  assertContractEditable(name);
  if (!model.contracts || !(name in model.contracts)) {
    throw new Error(`Contract "${name}" does not exist`);
  }
  model.contracts[name][fieldName] = fieldSpec;
  return model;
}

/** Remove a field from a contract. */
export function removeContractField(model, name, fieldName) {
  assertContractEditable(name);
  if (!model.contracts || !(name in model.contracts)) {
    throw new Error(`Contract "${name}" does not exist`);
  }
  delete model.contracts[name][fieldName];
  return model;
}

/** Rename a field key within a contract, preserving its spec and key order. */
export function renameContractField(model, name, oldField, newField) {
  assertContractEditable(name);
  if (!model.contracts || !(name in model.contracts)) {
    throw new Error(`Contract "${name}" does not exist`);
  }
  const contract = model.contracts[name];
  if (!(oldField in contract)) {
    throw new Error(`Field "${oldField}" does not exist on contract "${name}"`);
  }
  if (oldField === newField) return model;
  if (newField in contract) {
    throw new Error(`Field "${newField}" already exists on contract "${name}"`);
  }
  const rebuilt = {};
  for (const key of Object.keys(contract)) {
    if (key === oldField) rebuilt[newField] = contract[oldField];
    else rebuilt[key] = contract[key];
  }
  model.contracts[name] = rebuilt;
  return model;
}

/**
 * The contracts object to persist — every user contract EXCLUDING the reserved
 * built-in TaskGraph (never re-emit the built-in as a user contract).
 */
export function serializeContracts(model) {
  const out = {};
  const contracts = model.contracts || {};
  for (const key of Object.keys(contracts)) {
    if (key === RESERVED_CONTRACT) continue;
    out[key] = contracts[key];
  }
  return out;
}
