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
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

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
 * Surfaced fields are overwritten from the model (or deleted when cleared);
 * unsurfaced keys already on disk are LEFT untouched (preserving their values
 * and comments) — so an incomplete client `_extra` can never silently delete a
 * field that exists on disk. `_extra` keys absent from disk are added.
 */
function mergeStepNode(doc, mapNode, step) {
  if (step._extra && typeof step._extra === 'object') {
    for (const k of Object.keys(step._extra)) {
      if (!mapNode.has(k)) mapNode.set(k, doc.createNode(step._extra[k]));
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

  // POST /api/pipeline/save — save an edited model back to its source file.
  // Body: { file, model, flowName }. Mutates the on-disk YAML Document in place
  // so the `# metadata:` comment header, body comments, key ordering, and every
  // untouched flow/field survive (COMP-PIPE-EDIT-1).
  app.post('/api/pipeline/save', (req, res) => {
    const { file, model, flowName } = req.body || {};

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
    try {
      const realDir = realpathSync(pipelinesDir);
      const realFile = realpathSync(filePath);
      if (lstatSync(filePath).isSymbolicLink() || dirname(realFile) !== realDir) {
        return res.status(400).json({ error: 'refusing to write through a symlink or outside the pipelines dir' });
      }
    } catch (e) {
      return res.status(400).json({ error: `Cannot resolve spec path: ${e.message}` });
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

    let doc;
    try {
      doc = YAML.parseDocument(readFileSync(filePath, 'utf-8'));
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
        return res.status(400).json({ error: `Flow "${name}" has no steps location in the spec` });
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
          ? mergeStepNode(doc, existing, step)
          : doc.createNode(denormalizeModelStep(step));
      });
    }

    const out = String(doc);

    // Validation gate: the serialized text must still parse before we write it.
    try {
      YAML.parse(out);
    } catch (e) {
      return res.status(400).json({ error: `Refusing to write invalid YAML: ${e.message}` });
    }

    writeFileSync(filePath, out);
    res.json({ ok: true, file });
  });
}
