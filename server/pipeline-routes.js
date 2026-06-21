/**
 * pipeline-routes.js — Pipeline authoring REST routes.
 *
 * Routes:
 *   GET  /api/pipeline/templates          — list available pipeline templates
 *   GET  /api/pipeline/templates/:id/spec — full YAML spec for a template
 *   POST /api/pipeline/draft              — create a draft from template or inline spec
 *   GET  /api/pipeline/draft              — get current draft
 *   POST /api/pipeline/draft/approve      — approve and persist current draft
 *   POST /api/pipeline/draft/reject       — reject and discard current draft
 *   GET  /api/pipeline/specs              — list raw spec files (filename-keyed) [COMP-PIPE-EDIT-1]
 *   POST /api/pipeline/save               — save an edited model back to its source file [COMP-PIPE-EDIT-1]
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import YAML from 'yaml';

/** sha-256 hex of a string (COMP-PIPE-EDIT-6 conflict-detection baseline). */
function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Symlink/realpath containment guard (COMP-PIPE-EDIT — security). A bare-basename
 * check stops `..`/slashes but NOT a symlink that escapes the pipelines dir. This
 * resolves real paths and refuses anything that is a symlink or whose resolved
 * parent is not the (resolved) pipelines dir.
 *
 * Two modes:
 *   - mustExist:true  (read/overwrite an EXISTING file — /spec, /save): realpath
 *     the file itself, reject if it is a symlink or its real parent ≠ real dir.
 *   - mustExist:false (CREATE a new file — /save-as-template): the target may not
 *     exist yet, so realpath the DIR and require real(dirname(target)) === realDir;
 *     also reject if a node already sits at the target path AS a symlink.
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertWithinPipelines(pipelinesDir, filePath, { mustExist }) {
  try {
    const realDir = realpathSync(pipelinesDir);
    if (mustExist) {
      const realFile = realpathSync(filePath);
      if (lstatSync(filePath).isSymbolicLink() || dirname(realFile) !== realDir) {
        return { ok: false, error: 'refusing to read or write through a symlink or outside the pipelines dir' };
      }
    } else {
      // Create path: refuse a pre-existing symlink at the target, and require the
      // resolved parent directory to be the resolved pipelines dir.
      if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
        return { ok: false, error: 'refusing to write through a symlink or outside the pipelines dir' };
      }
      const realParent = realpathSync(dirname(filePath));
      if (realParent !== realDir) {
        return { ok: false, error: 'refusing to write through a symlink or outside the pipelines dir' };
      }
    }
  } catch (e) {
    return { ok: false, error: `Cannot resolve spec path: ${e.message}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read all *.stratum.yaml files from the pipelines dir and return those
 * with a valid metadata block.
 */
function loadTemplates(pipelinesDir) {
  const templates = [];
  let files;
  try {
    files = readdirSync(pipelinesDir).filter(f => f.endsWith('.stratum.yaml'));
  } catch {
    return templates;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(pipelinesDir, file), 'utf-8');
      const parsed = YAML.parse(raw);
      if (parsed?.metadata?.id) {
        templates.push({
          id: parsed.metadata.id,
          label: parsed.metadata.label || parsed.metadata.id,
          description: parsed.metadata.description || '',
          category: parsed.metadata.category || 'general',
          steps: typeof parsed.metadata.steps === 'number' ? parsed.metadata.steps : 0,
          estimated_minutes: typeof parsed.metadata.estimated_minutes === 'number' ? parsed.metadata.estimated_minutes : 0,
          _file: file,
        });
      }
    } catch {
      // skip unparseable files
    }
  }
  return templates;
}

/**
 * Extract steps from a parsed spec, version-aware.
 * v0.3: workflow.steps or flows.<name>.steps
 * v0.1: flows.<name>.steps or functions (as step list)
 */
function extractSteps(parsed) {
  // v0.3 with workflow.steps
  if (parsed?.workflow?.steps) {
    return parsed.workflow.steps.map(s => ({ id: s.id, ...s }));
  }

  // flows.<name>.steps (both v0.1 and v0.3)
  if (parsed?.flows) {
    for (const flowName of Object.keys(parsed.flows)) {
      const flow = parsed.flows[flowName];
      if (Array.isArray(flow?.steps) && flow.steps.length > 0) {
        return flow.steps.map(s => ({ id: s.id, ...s }));
      }
    }
  }

  // Fallback: list functions as pseudo-steps (v0.1 function-only specs)
  if (parsed?.functions) {
    return Object.keys(parsed.functions).map(id => ({ id }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Spec discovery + save helpers (COMP-PIPE-EDIT-1)
// ---------------------------------------------------------------------------

/**
 * List raw spec files in the pipelines dir, keyed by filename (NOT metadata).
 * The shipped specs store `metadata` as a leading `#` comment (or omit it), so
 * the metadata-based `loadTemplates` never surfaces them. The editor discovers
 * by filename instead.
 * @returns {Array<{ file, version, flows: string[] }>}
 */
function listSpecFiles(pipelinesDir) {
  let files;
  try {
    files = readdirSync(pipelinesDir).filter(f => f.endsWith('.stratum.yaml'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const parsed = YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8'));
      out.push({
        file,
        version: parsed?.version ?? null,
        flows: flowNamesOf(parsed),
      });
    } catch {
      out.push({ file, version: null, flows: [] });
    }
  }
  return out;
}

/** Flow names with a non-empty steps[] (workflow.steps or flows.<name>.steps). */
function flowNamesOf(parsed) {
  const names = [];
  if (Array.isArray(parsed?.workflow?.steps)) {
    names.push(parsed.workflow.name || 'workflow');
  }
  if (parsed?.flows && typeof parsed.flows === 'object') {
    for (const name of Object.keys(parsed.flows)) {
      if (Array.isArray(parsed.flows[name]?.steps)) names.push(name);
    }
  }
  return names;
}

/**
 * Reconstruct a plain step object from a normalized model step, merging `_extra`
 * back so nothing the editor never surfaced is lost. Mirrors
 * src/lib/pipeline-model.js `denormalizeStep` (kept in sync; server cannot import
 * the frontend module). `id` leads; surfaced fields override `_extra` on clash.
 */
function denormalizeModelStep(step) {
  const out = { id: step.id };
  if (step._extra && typeof step._extra === 'object') {
    for (const key of Object.keys(step._extra)) out[key] = step._extra[key];
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
 * Find a model flow by name. The flow-scoped model stores flows as an array of
 * { name, steps[] }.
 */
function modelFlow(model, flowName) {
  if (!model || !Array.isArray(model.flows)) return null;
  return model.flows.find(f => f && f.name === flowName) || null;
}

// The reserved built-in contract — never written as a user contract (mirrors
// src/lib/pipeline-model.js serializeContracts; server can't import the FE module).
const RESERVED_CONTRACT = 'TaskGraph';

/** The contracts object a model wants persisted, excluding the reserved TaskGraph. */
function serializeModelContracts(model) {
  const out = {};
  const contracts = (model && model.contracts && typeof model.contracts === 'object') ? model.contracts : {};
  for (const key of Object.keys(contracts)) {
    if (key === RESERVED_CONTRACT) continue;
    out[key] = contracts[key];
  }
  return out;
}

/** Structural equality over plain JSON-ish data (field specs, contract maps). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Merge a model's contracts into the freshly-parsed Document in place
 * (COMP-PIPE-EDIT-4). Only contracts that differ from disk or are new get a
 * `setIn` (preserving comments on unchanged contracts); contracts on disk but
 * absent from the model get a `deleteIn` (except the reserved TaskGraph).
 *
 * @param {YAML.Document} doc
 * @param {object} diskParsed — the same file's `YAML.parse` output (plain JS)
 * @param {object} model
 */
function mergeContracts(doc, diskParsed, model) {
  const wanted = serializeModelContracts(model);
  const onDisk = (diskParsed && diskParsed.contracts && typeof diskParsed.contracts === 'object')
    ? diskParsed.contracts : {};

  // Add / update changed contracts (skip unchanged to preserve their comments).
  for (const name of Object.keys(wanted)) {
    if (deepEqual(onDisk[name], wanted[name])) continue;
    doc.setIn(['contracts', name], doc.createNode(wanted[name]));
  }
  // Delete contracts present on disk but absent from the model (never TaskGraph).
  for (const name of Object.keys(onDisk)) {
    if (name === RESERVED_CONTRACT) continue;
    if (!(name in wanted)) doc.deleteIn(['contracts', name]);
  }
}

/**
 * Reconcile `flows.<name>.output` and `functions.<name>.output` scalar refs
 * (COMP-PIPE-EDIT-4). A contract rename in the model edits these passthrough
 * values in `model._doc`; the save re-parses disk and would otherwise miss
 * them. When the model's `_doc` value differs from the fresh disk value, write
 * the new value; otherwise leave the node (and its comment) untouched.
 */
function reconcileOutputRefs(doc, diskParsed, model, specWide = false) {
  const docOf = model && model._doc;
  if (!docOf || typeof docOf !== 'object') return;

  for (const section of ['flows', 'functions']) {
    const modelSection = docOf[section];
    const diskSection = diskParsed && diskParsed[section];
    if (!modelSection || typeof modelSection !== 'object') continue;
    for (const name of Object.keys(modelSection)) {
      const modelOut = modelSection[name] && modelSection[name].output;
      const diskOut = diskSection && diskSection[name] && diskSection[name].output;
      const hasNode = doc.hasIn([section, name]);
      if (modelOut === undefined) {
        // On a spec-wide save, output ABSENT in model._doc but present on disk is a
        // removal — delete it. (Flow-scoped leaves it; it may be unsurfaced.)
        if (specWide && hasNode && doc.hasIn([section, name, 'output'])) {
          doc.deleteIn([section, name, 'output']);
        }
        continue;
      }
      if (doc.hasIn([section, name, 'output'])) {
        // Update an existing output node only when the value changed (rename or edit).
        if (modelOut !== diskOut) doc.setIn([section, name, 'output'], doc.createNode(modelOut));
      } else if (specWide && hasNode) {
        // Spec-wide: CREATE an output that the model added but disk lacks.
        doc.setIn([section, name, 'output'], doc.createNode(modelOut));
      }
    }
  }

  // workflow.output — a single object (not a name-map). A contract rename also
  // rewrites _doc.workflow.output, so persist it like the flows/functions case
  // (rename/edit always; create/delete only on a spec-wide save).
  const mWf = docOf.workflow;
  if (mWf && typeof mWf === 'object' && doc.hasIn(['workflow'])) {
    const modelOut = mWf.output;
    const diskOut = diskParsed && diskParsed.workflow && diskParsed.workflow.output;
    if (modelOut === undefined) {
      if (specWide && doc.hasIn(['workflow', 'output'])) doc.deleteIn(['workflow', 'output']);
    } else if (doc.hasIn(['workflow', 'output'])) {
      if (modelOut !== diskOut) doc.setIn(['workflow', 'output'], doc.createNode(modelOut));
    } else if (specWide) {
      doc.setIn(['workflow', 'output'], doc.createNode(modelOut));
    }
  }
}

/** Resolve where a flow's steps live in the doc (flows.<name>.steps or workflow.steps). */
function stepsPathFor(doc, name) {
  if (doc.hasIn(['flows', name, 'steps'])) return ['flows', name, 'steps'];
  if (doc.hasIn(['workflow', 'steps'])) {
    const wfName = doc.getIn(['workflow', 'name']);
    if (wfName === name || (wfName == null && name === 'workflow')) return ['workflow', 'steps'];
  }
  return null;
}

/**
 * Propagate a contract rename to step.output_contract across EVERY flow, not just
 * the one being saved (COMP-PIPE-EDIT-4). The per-flow step merge only rewrites
 * the saved flow's steps, but renameContract changes output_contract on steps in
 * other flows too; without this, a multi-flow spec saved while editing one flow
 * would leave other flows' steps pointing at the old contract name. Only the
 * output_contract scalar is touched (matched by step id), so non-saved flows'
 * other fields/comments are untouched.
 */
function reconcileStepContractRefs(doc, model) {
  for (const flow of (model.flows || [])) {
    const path = stepsPathFor(doc, flow.name);
    if (!path) continue;
    const seq = doc.getIn(path, true);
    if (!seq || !Array.isArray(seq.items)) continue;
    for (const step of (flow.steps || [])) {
      if (step.output_contract === undefined) continue;
      const node = seq.items.find(it => it && typeof it.get === 'function' && it.get('id') === step.id);
      if (!node) continue;
      if (node.get('output_contract') !== step.output_contract) {
        node.set('output_contract', doc.createNode(step.output_contract));
      }
    }
  }
}

/**
 * Reconcile each flow's `input` declaration block (COMP-PIPE-EDIT-5/-6) on a
 * spec-wide save. A YAML-pane edit (or a collapse minting sub-flow input ports)
 * lives in model._doc.flows.<name>.input. Per field: setIn only when the model
 * value DIFFERS from fresh disk (preserving comments on unchanged fields),
 * deleteIn for fields removed in the model. Only flows that exist in the doc are
 * touched (a brand-new flow's input was already written by createNewFlowNode).
 */
function reconcileFlowInputs(doc, diskParsed, model) {
  const docFlows = model && model._doc && model._doc.flows;
  if (!docFlows || typeof docFlows !== 'object') return;
  for (const name of Object.keys(docFlows)) {
    if (!doc.hasIn(['flows', name])) continue; // new flows handled elsewhere
    const modelInput = docFlows[name] && docFlows[name].input;
    // Whole-block removal: the model dropped this flow's input entirely — delete
    // the on-disk `input` block (spec-wide save treats model._doc as authoritative).
    if (!modelInput || typeof modelInput !== 'object') {
      if (doc.hasIn(['flows', name, 'input'])) doc.deleteIn(['flows', name, 'input']);
      continue;
    }
    const diskInput = (diskParsed && diskParsed.flows && diskParsed.flows[name] && diskParsed.flows[name].input) || {};
    // Add / update changed fields (skip unchanged to keep their comments).
    for (const field of Object.keys(modelInput)) {
      if (deepEqual(diskInput[field], modelInput[field])) continue;
      doc.setIn(['flows', name, 'input', field], doc.createNode(modelInput[field]));
    }
    // Delete fields present on disk but removed in the model.
    for (const field of Object.keys(diskInput)) {
      if (!(field in modelInput)) doc.deleteIn(['flows', name, 'input', field]);
    }
  }
}

/**
 * Merge the top-level `functions` block (COMP-PIPE-EDIT-6) on a spec-wide save,
 * mirroring mergeContracts: setIn changed/new functions, deleteIn removed ones,
 * never replace an unchanged function (keeps its comments). Reads model._doc.functions.
 */
function mergeFunctions(doc, diskParsed, model) {
  // Only called on a SPEC-WIDE save, where model._doc is the authoritative full
  // document. So `model._doc.functions` ABSENT means the whole functions block was
  // removed — delete it on disk (not "leave untouched").
  const hasModelDoc = model && model._doc && typeof model._doc === 'object';
  const wanted = (hasModelDoc && model._doc.functions && typeof model._doc.functions === 'object')
    ? model._doc.functions : null;
  if (!wanted) {
    if (hasModelDoc && doc.hasIn(['functions'])) doc.deleteIn(['functions']);
    return;
  }
  const onDisk = (diskParsed && diskParsed.functions && typeof diskParsed.functions === 'object')
    ? diskParsed.functions : {};
  for (const name of Object.keys(wanted)) {
    if (deepEqual(onDisk[name], wanted[name])) continue;
    doc.setIn(['functions', name], doc.createNode(wanted[name]));
  }
  for (const name of Object.keys(onDisk)) {
    if (!(name in wanted)) doc.deleteIn(['functions', name]);
  }
}

/**
 * Reconcile `workflow.name` (COMP-PIPE-EDIT-6) on a spec-wide save: write it only
 * when the model._doc value differs from fresh disk and the node exists.
 */
function reconcileWorkflowName(doc, diskParsed, model) {
  const modelWf = model && model._doc && model._doc.workflow;
  // Only act when the model actually carries a workflow block (else nothing to do).
  if (!modelWf || typeof modelWf !== 'object') return;
  const modelName = modelWf.name;
  const diskName = diskParsed && diskParsed.workflow && diskParsed.workflow.name;
  if (modelName === undefined) {
    // workflow.name became undefined in the model — delete it on disk.
    if (doc.hasIn(['workflow', 'name'])) doc.deleteIn(['workflow', 'name']);
    return;
  }
  if (modelName !== diskName && doc.hasIn(['workflow'])) {
    doc.setIn(['workflow', 'name'], doc.createNode(modelName));
  }
}

// Surfaced (editable) step fields, with the same include/omit rules as
// denormalizeModelStep so an absent/empty value clears the key.
const SURFACED_STEP_KEYS = ['agent', 'function', 'intent', 'inputs', 'output_contract', 'ensure', 'retries', 'depends_on', 'on_fail'];
function surfacedValue(step, key) {
  if (key === 'inputs') {
    return step.inputs && Object.keys(step.inputs).length > 0
      ? { present: true, value: { ...step.inputs } } : { present: false };
  }
  if (key === 'ensure') {
    return Array.isArray(step.ensure) && step.ensure.length > 0
      ? { present: true, value: [...step.ensure] } : { present: false };
  }
  if (key === 'depends_on') {
    return Array.isArray(step.depends_on) && step.depends_on.length > 0
      ? { present: true, value: [...step.depends_on] } : { present: false };
  }
  return step[key] !== undefined ? { present: true, value: step[key] } : { present: false };
}

/**
 * Merge a normalized model step onto an EXISTING YAML map node in place.
 * Surfaced fields are overwritten from the model (or deleted when cleared).
 *
 * `_extra` (unsurfaced) handling depends on the save scope (COMP-PIPE-EDIT-6):
 *   - flow-scoped (specWide=false): ADDITIVE only — disk `_extra` keys are LEFT
 *     untouched (preserving values + comments) and absent model `_extra` keys are
 *     added. An incomplete client `_extra` can never silently delete a disk field.
 *   - spec-wide (specWide=true): model._doc is the authoritative full document, so
 *     `_extra` is fully reconciled — changed keys are UPDATED (only when different,
 *     to keep comments on unchanged nodes) and disk `_extra` keys absent from the
 *     model step are DELETED. The set of unsurfaced disk keys = all map keys minus
 *     `id` and the surfaced keys.
 */
function mergeStepNode(doc, mapNode, step, specWide = false) {
  const extra = (step._extra && typeof step._extra === 'object') ? step._extra : {};
  if (!specWide) {
    // Additive: add only missing keys.
    for (const k of Object.keys(extra)) {
      if (!mapNode.has(k)) mapNode.set(k, doc.createNode(extra[k]));
    }
  } else {
    // Full reconcile of unsurfaced fields.
    const surfacedSet = new Set(['id', ...SURFACED_STEP_KEYS]);
    // Add / update changed extra keys (skip unchanged to preserve their comments).
    for (const k of Object.keys(extra)) {
      if (!mapNode.has(k)) {
        mapNode.set(k, doc.createNode(extra[k]));
      } else {
        // Compare on plain-JS projections so a scalar OR nested node compares to
        // the model value; only write (losing the node's comment) when different.
        const diskNode = mapNode.get(k, true);
        const diskJs = diskNode && typeof diskNode.toJSON === 'function' ? diskNode.toJSON() : mapNode.get(k);
        if (!deepEqual(diskJs, extra[k])) mapNode.set(k, doc.createNode(extra[k]));
      }
    }
    // Delete unsurfaced disk keys absent from the model step's _extra.
    for (const item of [...(mapNode.items || [])]) {
      const k = item && item.key && item.key.value !== undefined ? item.key.value : (item && item.key);
      if (k == null || surfacedSet.has(k)) continue;
      if (!(k in extra)) mapNode.delete(k);
    }
  }
  if (mapNode.get('id') !== step.id) mapNode.set('id', step.id);
  for (const key of SURFACED_STEP_KEYS) {
    const { present, value } = surfacedValue(step, key);
    if (present) mapNode.set(key, doc.createNode(value));
    else if (mapNode.has(key)) mapNode.delete(key);
  }
  return mapNode;
}

/**
 * Create a brand-new `flows.<name>` document node for a flow that exists in the
 * model but not yet on disk (COMP-PIPE-EDIT-5 — a just-collapsed sub-flow). The
 * node gets `input` + `output` from `model._doc.flows[name]` (the collapse
 * injects them there) and an empty `steps` sequence the caller then populates by
 * the normal per-step merge. Returns true if the node was created, false if the
 * flow cannot be created here (no model flow, or no flows: container to host it).
 *
 * @returns {boolean}
 */
function createNewFlowNode(doc, model, name) {
  const flow = modelFlow(model, name);
  if (!flow) return false;

  // The collapse injects { input, output, steps:[] } into model._doc.flows[name].
  const injected = (model._doc && model._doc.flows && typeof model._doc.flows === 'object')
    ? model._doc.flows[name] : null;

  const node = {};
  if (injected && injected.input && typeof injected.input === 'object') {
    node.input = injected.input;
  }
  if (injected && injected.output !== undefined && injected.output !== null) {
    node.output = injected.output;
  }
  node.steps = []; // populated by the per-step merge that runs next.

  // Ensure a top-level `flows:` map exists, then set the new flow node.
  if (!doc.hasIn(['flows'])) {
    doc.setIn(['flows'], doc.createNode({}));
  }
  doc.setIn(['flows', name], doc.createNode(node));
  return true;
}

// ---------------------------------------------------------------------------
// In-memory draft state (single draft at a time)
// ---------------------------------------------------------------------------

let currentDraft = null;

const DRAFT_FILE = 'pipeline-draft.json';

function saveDraft(dataDir, draft) {
  currentDraft = draft;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, DRAFT_FILE), JSON.stringify(draft, null, 2));
}

function loadDraft(dataDir) {
  if (currentDraft) return currentDraft;
  const p = join(dataDir, DRAFT_FILE);
  if (!existsSync(p)) return null;
  try {
    currentDraft = JSON.parse(readFileSync(p, 'utf-8'));
    return currentDraft;
  } catch {
    return null;
  }
}

function clearDraft(dataDir) {
  currentDraft = null;
  const p = join(dataDir, DRAFT_FILE);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Route attachment
// ---------------------------------------------------------------------------

/**
 * Attach pipeline authoring routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{
 *   broadcastMessage: function,
 *   scheduleBroadcast: function,
 *   getDataDir: function,
 *   getPipelinesDir: function,
 *   stratumClient?: { validate: function } | null,
 * }} deps
 */
export function attachPipelineRoutes(app, { broadcastMessage, scheduleBroadcast, getDataDir, getPipelinesDir, stratumClient }) {

  // GET /api/pipeline/templates
  app.get('/api/pipeline/templates', (_req, res) => {
    const templates = loadTemplates(getPipelinesDir());
    // Strip internal _file field
    const clean = templates.map(({ _file, ...rest }) => rest);
    res.json({ templates: clean });
  });

  // GET /api/pipeline/templates/:id/spec
  app.get('/api/pipeline/templates/:id/spec', (req, res) => {
    const templates = loadTemplates(getPipelinesDir());
    const tmpl = templates.find(t => t.id === req.params.id);
    if (!tmpl) return res.status(404).json({ error: `Template "${req.params.id}" not found` });

    const spec = readFileSync(join(getPipelinesDir(), tmpl._file), 'utf-8');
    res.json({ spec });
  });

  // POST /api/pipeline/draft
  app.post('/api/pipeline/draft', (req, res) => {
    const { templateId, spec: inlineSpec, metadata: inlineMeta } = req.body || {};
    const dataDir = getDataDir();

    let spec;
    let metadata;
    let parsed;

    if (templateId) {
      // Load from template
      const templates = loadTemplates(getPipelinesDir());
      const tmpl = templates.find(t => t.id === templateId);
      if (!tmpl) return res.status(404).json({ error: `Template "${templateId}" not found` });

      spec = readFileSync(join(getPipelinesDir(), tmpl._file), 'utf-8');
      try {
        parsed = YAML.parse(spec);
      } catch (e) {
        return res.status(400).json({ error: `Failed to parse template: ${e.message}` });
      }
      metadata = parsed.metadata || tmpl;
    } else if (inlineSpec) {
      // Inline spec
      spec = inlineSpec;
      try {
        parsed = YAML.parse(spec);
      } catch (e) {
        return res.status(400).json({ error: `Invalid YAML: ${e.message}` });
      }
      metadata = parsed?.metadata || inlineMeta;
      if (!metadata || !metadata.id) {
        return res.status(400).json({ error: 'Spec must include a metadata block with at least an id field, or metadata must be provided separately' });
      }
    } else {
      return res.status(400).json({ error: 'Provide either templateId or spec + metadata' });
    }

    const steps = extractSteps(parsed);
    const draftId = randomUUID();

    const draft = {
      draftId,
      spec,
      metadata,
      steps,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    saveDraft(dataDir, draft);

    broadcastMessage({ type: 'pipelineDraft', ...draft });

    res.json(draft);
  });

  // GET /api/pipeline/draft
  app.get('/api/pipeline/draft', (_req, res) => {
    const draft = loadDraft(getDataDir());
    res.json({ draft: draft ?? null });
  });

  // POST /api/pipeline/draft/approve
  app.post('/api/pipeline/draft/approve', async (req, res) => {
    const { draftId } = req.body || {};
    const dataDir = getDataDir();
    const draft = loadDraft(dataDir);

    if (!draft) return res.status(404).json({ error: 'No draft to approve' });
    if (draft.draftId !== draftId) return res.status(409).json({ error: 'Draft ID mismatch' });

    // Validate spec before approval
    if (stratumClient && typeof stratumClient.validate === 'function') {
      try {
        const result = await stratumClient.validate(draft.spec);
        if (result?.valid === false) {
          return res.status(422).json({ error: `Spec validation failed: ${result.error || 'unknown error'}` });
        }
      } catch (err) {
        // Stratum unavailable at runtime — fall back to YAML parse check
        try {
          YAML.parse(draft.spec);
        } catch (parseErr) {
          return res.status(422).json({ error: `Invalid YAML: ${parseErr.message}` });
        }
      }
    } else {
      // No stratum client — basic YAML parse check
      try {
        YAML.parse(draft.spec);
      } catch (parseErr) {
        return res.status(422).json({ error: `Invalid YAML: ${parseErr.message}` });
      }
    }

    // Write approved spec to approved-specs/
    const approvedDir = join(dataDir, 'approved-specs');
    mkdirSync(approvedDir, { recursive: true });
    const specPath = join(approvedDir, `${draftId}.yaml`);
    writeFileSync(specPath, draft.spec);

    // Only delete draft AFTER spec file written
    clearDraft(dataDir);

    broadcastMessage({
      type: 'pipelineDraftResolved',
      draftId,
      outcome: 'approved',
      specPath,
    });

    res.json({ ok: true, specPath });
  });

  // POST /api/pipeline/draft/reject
  app.post('/api/pipeline/draft/reject', (req, res) => {
    const { draftId } = req.body || {};
    const dataDir = getDataDir();
    const draft = loadDraft(dataDir);

    if (!draft) return res.status(404).json({ error: 'No draft to reject' });
    if (draft.draftId !== draftId) return res.status(409).json({ error: 'Draft ID mismatch' });

    clearDraft(dataDir);

    broadcastMessage({
      type: 'pipelineDraftResolved',
      draftId,
      outcome: 'rejected',
    });

    res.json({ ok: true });
  });

  // GET /api/pipeline/specs — filename-keyed spec discovery (COMP-PIPE-EDIT-1).
  app.get('/api/pipeline/specs', (_req, res) => {
    res.json({ specs: listSpecFiles(getPipelinesDir()) });
  });

  // GET /api/pipeline/spec?file=<name> — raw YAML text for one spec, keyed by
  // filename (NOT metadata id — the shipped specs carry metadata as a comment
  // the template loader can't see, so /templates/:id/spec misses them).
  app.get('/api/pipeline/spec', (req, res) => {
    const file = req.query?.file;
    if (!file || typeof file !== 'string' || basename(file) !== file || !file.endsWith('.stratum.yaml')) {
      return res.status(400).json({ error: 'file must be a bare *.stratum.yaml filename' });
    }
    const pipelinesDir = getPipelinesDir();
    const filePath = join(pipelinesDir, file);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: `Spec "${file}" not found` });
    }
    // Symlink/containment guard: never read through a symlink or a resolved path
    // outside the pipelines dir (basename alone does not stop symlink escape).
    {
      const guard = assertWithinPipelines(pipelinesDir, filePath, { mustExist: true });
      if (!guard.ok) return res.status(400).json({ error: guard.error });
    }
    const text = readFileSync(filePath, 'utf-8');
    // COMP-PIPE-EDIT-6: sha-256 of the on-disk text as a conflict-detection
    // baseline. Computed on the file only (never on a serialized model), so it
    // stays a true disk-divergence signal.
    res.json({ file, text, hash: sha256(text) });
  });

  // POST /api/pipeline/save — save an edited model back to its source file.
  // Body: { file, model, flowName }. Mutates the on-disk YAML Document in place
  // so the `# metadata:` comment header, body comments, key ordering, and every
  // untouched flow/field survive (COMP-PIPE-EDIT-1).
  app.post('/api/pipeline/save', (req, res) => {
    const { file, model, flowName, baseHash, force } = req.body || {};

    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'file is required' });
    }
    // Path-traversal-safe: reject anything whose basename differs (no slashes / ..).
    if (basename(file) !== file || !file.endsWith('.stratum.yaml')) {
      return res.status(400).json({ error: 'file must be a bare *.stratum.yaml filename' });
    }
    const pipelinesDir = getPipelinesDir();
    const filePath = join(pipelinesDir, file);
    if (!existsSync(filePath)) {
      return res.status(400).json({ error: `Spec "${file}" not found in pipelines dir` });
    }
    // Symlink/containment guard: never write through a symlink or to a resolved
    // path outside the pipelines dir (basename alone does not stop symlink escape).
    {
      const guard = assertWithinPipelines(pipelinesDir, filePath, { mustExist: true });
      if (!guard.ok) return res.status(400).json({ error: guard.error });
    }
    if (!model || !Array.isArray(model.flows)) {
      return res.status(400).json({ error: 'model with flows[] is required' });
    }

    // Determine which flows to write back. If flowName is given, write only that
    // flow (the editor edits one flow at a time); otherwise write every flow the
    // model carries that exists in the document.
    const flowsToWrite = flowName
      ? [flowName]
      : model.flows.map(f => f && f.name).filter(Boolean);

    // A SPEC-WIDE save (flowName omitted) treats model._doc as the authoritative
    // full document: reconcilers update AND delete, not just add. The flow-scoped
    // path (flowName given) stays additive and never touches other flows/blocks.
    const specWide = !flowName;

    let doc;
    let diskParsed;
    let diskText;
    try {
      diskText = readFileSync(filePath, 'utf-8');
    } catch (e) {
      return res.status(400).json({ error: `Cannot read current spec: ${e.message}` });
    }

    // COMP-PIPE-EDIT-6 conflict detection: if the client sent a baseHash and the
    // freshly-read disk text no longer matches it, the file diverged since load
    // (another writer / external edit). Refuse to write (409) unless force:true.
    if (baseHash && !force) {
      const currentHash = sha256(diskText);
      if (currentHash !== baseHash) {
        return res.status(409).json({
          error: 'Spec changed on disk since it was loaded',
          conflict: true,
          currentHash,
        });
      }
    }

    try {
      doc = YAML.parseDocument(diskText);
      diskParsed = YAML.parse(diskText);
    } catch (e) {
      return res.status(400).json({ error: `Failed to parse current spec: ${e.message}` });
    }

    for (const name of flowsToWrite) {
      const flow = modelFlow(model, name);
      if (!flow) {
        return res.status(400).json({ error: `Flow "${name}" not present in model` });
      }

      // Where do this flow's steps live? Prefer flows.<name>.steps; fall back to
      // workflow.steps only on an exact name match (or the synthetic 'workflow'
      // name when the doc omits workflow.name) — never on a blanket null match.
      let stepsPath = null;
      if (doc.hasIn(['flows', name, 'steps'])) {
        stepsPath = ['flows', name, 'steps'];
      } else if (doc.hasIn(['workflow', 'steps'])) {
        const wfName = doc.getIn(['workflow', 'name']);
        if (wfName === name || (wfName == null && name === 'workflow')) {
          stepsPath = ['workflow', 'steps'];
        }
      }
      if (!stepsPath) {
        // COMP-PIPE-EDIT-5: the flow is not on disk yet (e.g. a just-collapsed
        // sub-flow that exists only in the model). CREATE the flows.<name> node —
        // steps + input + output from model._doc.flows — rather than erroring.
        // ONLY on a SPEC-WIDE save (flowName omitted): an explicit flowName that
        // doesn't map to a steps location is still a 400 (never auto-create a
        // flow the caller named by mistake / clobber a workflow.steps spec).
        const created = !flowName && createNewFlowNode(doc, model, name);
        if (!created) {
          return res.status(400).json({ error: `Flow "${name}" has no steps location in the spec` });
        }
        stepsPath = ['flows', name, 'steps'];
      }

      // Merge in place: existing steps are mutated by id (preserving disk-only
      // fields/comments), new steps are created, dropped steps are removed, and
      // the sequence is reordered to match the model.
      const seq = doc.getIn(stepsPath, true);
      const oldById = new Map();
      for (const item of (seq?.items || [])) {
        const id = item && typeof item.get === 'function' ? item.get('id') : undefined;
        if (id != null) oldById.set(id, item);
      }
      seq.items = (flow.steps || []).map((step) => {
        // Match a renamed step to its ORIGINAL disk node via _renamedFrom FIRST
        // (so a rename chain like A->B, B->C maps each step to its true node),
        // else by current id. Consume the matched node so it is never claimed
        // twice. Unmatched steps are created fresh.
        let existing;
        if (step._renamedFrom != null && oldById.has(step._renamedFrom)) {
          existing = oldById.get(step._renamedFrom);
          oldById.delete(step._renamedFrom);
        } else if (oldById.has(step.id)) {
          existing = oldById.get(step.id);
          oldById.delete(step.id);
        }
        return existing
          ? mergeStepNode(doc, existing, step, specWide)
          : doc.createNode(denormalizeModelStep(step));
      });
    }

    // Persist the top-level contracts block (COMP-PIPE-EDIT-4) — only when the
    // model carries a contracts field, so step-only saves never touch contracts.
    // Order matters: reconcile the rename-driven output refs BEFORE the contract
    // key merge so both the old and new contract values are still observable
    // (the helpers read model state + fresh disk, not each other's writes).
    if (model.contracts && typeof model.contracts === 'object') {
      // Flow-scoped: reconcile rename-driven output refs here (update-only). On a
      // spec-wide save the full output create/update/delete reconcile runs below,
      // so skip it here to avoid a redundant pass.
      if (!specWide) reconcileOutputRefs(doc, diskParsed, model, false);
      reconcileStepContractRefs(doc, model);
      mergeContracts(doc, diskParsed, model);
    }

    // COMP-PIPE-EDIT-5/-6: a SPEC-WIDE save (flowName omitted) can carry YAML-pane
    // edits to structural blocks beyond steps/contracts. Reconcile them
    // comment-preservingly (setIn only when the model._doc value differs from
    // fresh disk; deleteIn for removed; never replace an unchanged node, to keep
    // its comments). The flow-SCOPED path is left untouched (edits one flow's
    // steps only). NOTE: only steps, contracts, the `functions` block,
    // flows.<name>.input/output, and workflow.name are reconciled — arbitrary
    // OTHER top-level keys are intentionally out of scope (not pane-editable).
    if (specWide) {
      reconcileOutputRefs(doc, diskParsed, model, true);
      reconcileFlowInputs(doc, diskParsed, model);
      mergeFunctions(doc, diskParsed, model);
      reconcileWorkflowName(doc, diskParsed, model);
    }

    const out = String(doc);

    // Validation gate: the serialized text must still parse before we write it.
    try {
      YAML.parse(out);
    } catch (e) {
      return res.status(400).json({ error: `Refusing to write invalid YAML: ${e.message}` });
    }

    writeFileSync(filePath, out);
    // COMP-PIPE-EDIT-6: return the hash of the freshly-written text so the editor
    // updates its conflict baseline (editorSpecHash) without an extra GET.
    res.json({ ok: true, file, hash: sha256(out) });
  });

  // POST /api/pipeline/save-as-template — write the current model as a NEW
  // discoverable template file (COMP-PIPE-EDIT-7). Body:
  //   { filename, model, metadata: { id, label?, description?, category? } }
  // Create-only (refuses to overwrite); refuses an id colliding with any existing
  // spec's metadata.id (the template system keys on metadata.id). Emits a REAL
  // `metadata:` key so TemplateSelector / loadTemplates surface it.
  app.post('/api/pipeline/save-as-template', (req, res) => {
    const { filename, model, metadata } = req.body || {};

    if (!filename || typeof filename !== 'string'
        || basename(filename) !== filename || !filename.endsWith('.stratum.yaml')) {
      return res.status(400).json({ error: 'filename must be a bare *.stratum.yaml filename' });
    }
    if (!model || !Array.isArray(model.flows)) {
      return res.status(400).json({ error: 'model with flows[] is required' });
    }
    if (!metadata || typeof metadata !== 'object' || !metadata.id || typeof metadata.id !== 'string') {
      return res.status(400).json({ error: 'metadata.id is required' });
    }

    const pipelinesDir = getPipelinesDir();
    const filePath = join(pipelinesDir, filename);

    // Symlink/containment guard FIRST: refuse a target that is a symlink or whose
    // resolved parent escapes the pipelines dir, before the create-only check (so a
    // symlink-escape reports as such, not as "already exists").
    {
      const guard = assertWithinPipelines(pipelinesDir, filePath, { mustExist: false });
      if (!guard.ok) return res.status(400).json({ error: guard.error });
    }

    // Create-only: refuse to overwrite an existing file (editing is /save).
    if (existsSync(filePath)) {
      return res.status(400).json({ error: `File "${filename}" already exists (create-only; use /save to edit)` });
    }

    // Refuse a metadata.id that collides with any existing spec's metadata.id.
    let existingFiles;
    try {
      existingFiles = readdirSync(pipelinesDir).filter(f => f.endsWith('.stratum.yaml'));
    } catch {
      existingFiles = [];
    }
    for (const f of existingFiles) {
      try {
        const parsed = YAML.parse(readFileSync(join(pipelinesDir, f), 'utf-8'));
        if (parsed?.metadata?.id === metadata.id) {
          return res.status(409).json({ error: `metadata.id "${metadata.id}" already used by ${f}` });
        }
      } catch {
        // skip unparseable files
      }
    }

    // Build the spec object: version/flows passthrough from the model, then a
    // REAL metadata key + the serialized contracts block.
    const specObj = buildSpecObjectFromModel(model);
    const ordered = { metadata, ...specObj };
    ordered.contracts = serializeModelContracts(model);

    let text;
    try {
      text = YAML.stringify(ordered);
      YAML.parse(text); // parse gate — never write something that won't reload
    } catch (e) {
      return res.status(400).json({ error: `Refusing to write invalid YAML: ${e.message}` });
    }

    writeFileSync(filePath, text);
    res.json({ ok: true, file: filename });
  });
}

/**
 * Reconstruct a plain spec object from the model for template serialization
 * (COMP-PIPE-EDIT-7). Mirrors src/lib/pipeline-model.js `modelToSpecObject`:
 * version/flows/functions passthrough from `_doc`, with each flow's steps
 * rebuilt from the model. `metadata` and `contracts` are set by the caller.
 */
function buildSpecObjectFromModel(model) {
  const doc = (model && model._doc && typeof model._doc === 'object') ? model._doc : {};
  const out = { ...doc };
  // Don't carry a parsed metadata/contracts through — the caller sets fresh ones.
  delete out.metadata;
  delete out.contracts;

  const byName = new Map((model.flows || []).map(f => [f.name, f]));

  if (Array.isArray(doc?.workflow?.steps)) {
    const wfName = doc.workflow.name || 'workflow';
    const flow = byName.get(wfName);
    if (flow) out.workflow = { ...doc.workflow, steps: (flow.steps || []).map(denormalizeModelStep) };
  }

  if (doc?.flows && typeof doc.flows === 'object') {
    out.flows = {};
    for (const name of Object.keys(doc.flows)) {
      const flow = byName.get(name);
      out.flows[name] = flow
        ? { ...doc.flows[name], steps: (flow.steps || []).map(denormalizeModelStep) }
        : doc.flows[name];
    }
  }

  return out;
}
