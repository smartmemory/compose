/**
 * pipeline-editor-store.test.jsx — COMP-PIPE-EDIT-1 / T3
 *
 * Tests the visual-pipeline-editor slice of useVisionStore against the REAL
 * pure model lib (src/lib/pipeline-model.js). fetch and WebSocket are stubbed so
 * the singleton store constructs without a live backend; the editor actions are
 * then driven directly and their effect on the model + flags asserted.
 *
 * Coverage:
 *   - loadSpecList populates editorSpecs
 *   - loadSpecForEdit parses → model, selects first flow, v0.1 → read-only
 *   - updateStep mutates the model, sets editorDirty, and revalidates
 *   - deleteStep-when-referenced surfaces an error and does NOT mutate
 *   - deleteStep-when-free mutates and clears the reference cleanly
 *   - renameStep sets _renamedFrom and rewrites depends_on references
 *   - saveSpec POSTs { file, model, flowName } and clears editorDirty on ok
 *
 * Run: npm run test:ui  (vitest run)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Stub WebSocket BEFORE importing the store (it connects on module load) ────
class FakeWS {
  constructor() {}
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
  set onopen(_) {}
  send() {}
}

// ── Fixtures: a v0.3 multi-flow doc + a v0.1 doc, as raw YAML text ────────────
const V03_YAML = `version: "0.3"
contracts:
  Plan:
    fields: { summary: string }
flows:
  build:
    steps:
      - id: design
        agent: claude:design:opus
        intent: "Design the thing"
        output_contract: Plan
      - id: implement
        agent: claude:impl:sonnet
        intent: "Implement it"
        depends_on: [design]
      - id: review
        agent: claude:review:opus
        intent: "Review it"
        depends_on: [implement]
        on_fail: implement
  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"
`;

const V01_YAML = `version: "0.1"
flows:
  legacy:
    steps:
      - id: only
        agent: claude:x:opus
        intent: "legacy step"
`;

// ── fetch stub keyed by URL ───────────────────────────────────────────────────
let saveCalls;
let saveResponse;
let templateCalls;
let templateResponse;
let specHash; // COMP-PIPE-EDIT-6: hash returned by GET /api/pipeline/spec
let specGetFails; // COMP-PIPE-EDIT-6: make GET /api/pipeline/spec fail (reload failure)

function makeResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    clone() { return makeResponse(body, ok, status); },
  };
}

function installFetch() {
  saveCalls = [];
  specHash = 'hash-v1';
  specGetFails = false;
  // COMP-PIPE-EDIT-6: save response is now { ok, status, body } so tests can
  // simulate a 409 conflict. body.hash lets the store update editorSpecHash.
  saveResponse = { ok: true, status: 200, body: { ok: true, file: 'demo.stratum.yaml', hash: 'hash-v2' } };
  templateCalls = [];
  templateResponse = { ok: true, status: 200, body: { ok: true, file: 'pipelines/my-template.stratum.yaml' } };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/pipeline/specs')) {
      return makeResponse({ specs: [
        { file: 'demo.stratum.yaml', version: '0.3', flows: ['build', 'review_check'] },
        { file: 'legacy.stratum.yaml', version: '0.1', flows: ['legacy'] },
      ] });
    }
    if (u.includes('/api/pipeline/spec')) {
      if (specGetFails) return makeResponse({ error: 'read failed' }, false, 500);
      const file = decodeURIComponent(u.split('file=')[1] || '');
      const text = file.startsWith('legacy') ? V01_YAML : V03_YAML;
      // COMP-PIPE-EDIT-6: GET /spec also returns a content hash (conflict base).
      return makeResponse({ file, text, hash: specHash });
    }
    if (u.includes('/api/pipeline/save-as-template')) {
      templateCalls.push({ url: u, body: JSON.parse(opts.body) });
      return makeResponse(templateResponse.body, templateResponse.ok, templateResponse.status);
    }
    if (u.includes('/api/pipeline/save')) {
      saveCalls.push({ url: u, body: JSON.parse(opts.body) });
      return makeResponse(saveResponse.body, saveResponse.ok, saveResponse.status);
    }
    // Everything else the store hydrates on boot (session/build/draft/agents).
    return makeResponse({});
  });
}

// Import the store AFTER the global stubs are in place.
globalThis.WebSocket = FakeWS;
installFetch();
const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');

function store() { return useVisionStore.getState(); }

async function loadV03() {
  await store().loadSpecForEdit('demo.stratum.yaml');
}

describe('useVisionStore — pipeline editor slice (COMP-PIPE-EDIT-1)', () => {
  beforeEach(() => {
    globalThis.WebSocket = FakeWS;
    installFetch();
    // Reset editor slice between tests.
    useVisionStore.setState({
      editorSpecFile: null, editorSpecs: [], editorModel: null, editorVersion: null,
      editorSelectedFlow: null, editorSelectedStep: null, editorDirty: false,
      editorErrors: { errors: [], warningsByStepId: {} }, editorReadOnly: false,
      // COMP-PIPE-EDIT-6 fields
      editorSpecHash: null, editorSaveScope: 'flow', editorConflict: null,
      editorYamlBuffer: null, editorYamlError: null,
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('loadSpecList populates editorSpecs', async () => {
    const specs = await store().loadSpecList();
    expect(specs).toHaveLength(2);
    expect(store().editorSpecs.map(s => s.file)).toContain('demo.stratum.yaml');
  });

  it('loadSpecForEdit parses to a model and selects the first editable flow', async () => {
    await loadV03();
    const s = store();
    expect(s.editorSpecFile).toBe('demo.stratum.yaml');
    expect(s.editorVersion).toBe('0.3');
    expect(s.editorSelectedFlow).toBe('build');
    expect(s.editorReadOnly).toBe(false);
    expect(s.editorModel.flows.map(f => f.name)).toEqual(['build', 'review_check']);
    // The duplicate `review` id lives in both flows but identity is (flow,id).
    const buildSteps = s.editorModel.flows.find(f => f.name === 'build').steps;
    expect(buildSteps.map(st => st.id)).toEqual(['design', 'implement', 'review']);
  });

  it('loads a v0.1 spec read-only', async () => {
    await store().loadSpecForEdit('legacy.stratum.yaml');
    expect(store().editorReadOnly).toBe(true);
    expect(store().editorVersion).toBe('0.1');
  });

  it('updateStep mutates the model, sets dirty, and revalidates', async () => {
    await loadV03();
    expect(store().editorDirty).toBe(false);
    expect(store().editorErrors.errors).toHaveLength(0);

    store().updateStep('design', { intent: 'New intent' });
    const design = store().editorModel.flows[0].steps.find(s => s.id === 'design');
    expect(design.intent).toBe('New intent');
    expect(store().editorDirty).toBe(true);

    // An unknown contract should now surface as a validation error live.
    store().updateStep('design', { output_contract: 'DoesNotExist' });
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
    expect(store().editorErrors.warningsByStepId.design).toBeTruthy();
  });

  it('updateStep is a no-op on a read-only (v0.1) spec', async () => {
    await store().loadSpecForEdit('legacy.stratum.yaml');
    store().updateStep('only', { intent: 'changed' });
    expect(store().editorDirty).toBe(false);
    expect(store().editorModel.flows[0].steps[0].intent).toBe('legacy step');
  });

  it('deleteStep is blocked when the step is still referenced, with no mutation', async () => {
    await loadV03();
    // `implement` is referenced by `review` (depends_on + on_fail).
    const ok = store().deleteStep('implement');
    expect(ok).toBe(false);
    // Model untouched.
    const ids = store().editorModel.flows[0].steps.map(s => s.id);
    expect(ids).toContain('implement');
    expect(store().editorDirty).toBe(false);
    // Error surfaced (not mutated away).
    expect(store().editorErrors.errors.some(e => /Cannot delete "implement"/.test(e))).toBe(true);
    expect(store().editorErrors.warningsByStepId.implement).toBeTruthy();
  });

  it('deleteStep removes a step that nothing references', async () => {
    await loadV03();
    // `review` (in build) is not referenced by any other step.
    const ok = store().deleteStep('review');
    expect(ok).toBe(true);
    const ids = store().editorModel.flows[0].steps.map(s => s.id);
    expect(ids).not.toContain('review');
    expect(store().editorDirty).toBe(true);
  });

  it('renameStep sets _renamedFrom and rewrites references', async () => {
    await loadV03();
    store().selectStep('design');
    store().renameStep('design', 'design_v2');
    const buildFlow = store().editorModel.flows[0];
    const renamed = buildFlow.steps.find(s => s.id === 'design_v2');
    expect(renamed).toBeTruthy();
    expect(renamed._renamedFrom).toBe('design');
    // `implement` depended on `design` → now points at `design_v2`.
    const implement = buildFlow.steps.find(s => s.id === 'implement');
    expect(implement.depends_on).toEqual(['design_v2']);
    // Selection follows the rename.
    expect(store().editorSelectedStep).toBe('design_v2');
    expect(store().editorDirty).toBe(true);
    // No dangling refs after the rename.
    expect(store().editorErrors.errors).toHaveLength(0);
  });

  it('mutations hand back a fresh editorModel reference (so subscribers re-render)', async () => {
    await loadV03();
    const before = store().editorModel;
    const beforeFlows = before.flows;
    store().updateStep('design', { intent: 'changed' });
    expect(store().editorModel).not.toBe(before);
    expect(store().editorModel.flows).not.toBe(beforeFlows);
  });

  it('saveSpec clears _renamedFrom on the saved flow so a later rename re-anchors', async () => {
    await loadV03();
    store().renameStep('design', 'design_v2');
    expect(store().editorModel.flows[0].steps.find(s => s.id === 'design_v2')._renamedFrom).toBe('design');
    await store().saveSpec();
    const step = store().editorModel.flows[0].steps.find(s => s.id === 'design_v2');
    expect(step._renamedFrom).toBeUndefined();
  });

  it('addStep appends a uniquely-named step and selects it', async () => {
    await loadV03();
    const id = store().addStep();
    const buildFlow = store().editorModel.flows[0];
    expect(buildFlow.steps.some(s => s.id === id)).toBe(true);
    expect(store().editorSelectedStep).toBe(id);
    expect(store().editorDirty).toBe(true);
  });

  it('saveSpec POSTs { file, model, flowName } and clears dirty on ok', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    expect(store().editorDirty).toBe(true);

    const res = await store().saveSpec();
    expect(res.ok).toBe(true);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].body.file).toBe('demo.stratum.yaml');
    expect(saveCalls[0].body.flowName).toBe('build');
    expect(Array.isArray(saveCalls[0].body.model.flows)).toBe(true);
    expect(store().editorDirty).toBe(false);
  });

  it('saveSpec leaves dirty true when the server reports an error', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    saveResponse = { ok: false, status: 400, body: { error: 'parse failed' } };
    const res = await store().saveSpec();
    expect(res.error).toBeTruthy();
    expect(store().editorDirty).toBe(true);
  });

  // ── COMP-PIPE-EDIT-3: dependency wiring actions ──────────────────────────────

  it('addDependency applies a valid edge and sets dirty', async () => {
    await loadV03();
    // design has no deps. Add a direct edge review depends_on design: walking
    // design's closure (empty) never reaches review, so it is acyclic.
    const ok = store().addDependency('review', 'design');
    expect(ok).toBe(true);
    const review = store().editorModel.flows[0].steps.find(s => s.id === 'review');
    expect(review.depends_on).toContain('design');
    expect(store().editorDirty).toBe(true);
    // Fresh model ref so subscribers re-render.
    const before = store().editorModel;
    store().removeDependency('review', 'design');
    expect(store().editorModel).not.toBe(before);
  });

  it('addDependency refuses a cycle: no mutation, error surfaced', async () => {
    await loadV03();
    // implement depends_on design; review depends_on implement.
    // Adding design depends_on implement would close design→implement→design.
    const ok = store().addDependency('design', 'implement');
    expect(ok).toBe(false);
    const design = store().editorModel.flows[0].steps.find(s => s.id === 'design');
    expect(design.depends_on || []).not.toContain('implement');
    expect(store().editorDirty).toBe(false);
    expect(store().editorErrors.errors.some(e => /cycle/i.test(e))).toBe(true);
  });

  it('removeDependency drops an existing edge and sets dirty', async () => {
    await loadV03();
    // implement depends_on design.
    const ok = store().removeDependency('implement', 'design');
    expect(ok).toBe(true);
    const implement = store().editorModel.flows[0].steps.find(s => s.id === 'implement');
    expect(implement.depends_on).not.toContain('design');
    expect(store().editorDirty).toBe(true);
  });

  // ── COMP-PIPE-EDIT-4: contract editing actions ───────────────────────────────

  it('addContract adds an empty contract and hands back a fresh model ref', async () => {
    await loadV03();
    const before = store().editorModel;
    store().addContract('Report');
    expect(store().editorModel).not.toBe(before);
    expect(store().editorModel.contracts.Report).toBeTruthy();
    expect(store().editorDirty).toBe(true);
  });

  it('addContract surfaces a duplicate/reserved error without mutating', async () => {
    await loadV03();
    store().addContract('TaskGraph'); // reserved
    expect(store().editorModel.contracts.TaskGraph).toBeUndefined();
    expect(store().editorErrors.errors.some(e => /reserved/i.test(e))).toBe(true);
    expect(store().editorDirty).toBe(false);
  });

  it('setContractField mutates the contract and hands back a fresh model ref', async () => {
    await loadV03();
    store().addContract('Report');
    const before = store().editorModel;
    store().setContractField('Report', 'summary', { type: 'string' });
    expect(store().editorModel).not.toBe(before);
    expect(store().editorModel.contracts.Report.summary).toEqual({ type: 'string' });
    expect(store().editorDirty).toBe(true);
  });

  it('deleteContract blocked-when-referenced surfaces a reason and does not mutate', async () => {
    await loadV03();
    // `Plan` is referenced by build/design output_contract.
    store().deleteContract('Plan');
    expect(store().editorModel.contracts.Plan).toBeTruthy();
    expect(store().editorErrors.errors.some(e => /Cannot delete contract "Plan"/.test(e))).toBe(true);
    expect(store().editorDirty).toBe(false);
  });

  it('deleteContract removes an unreferenced contract', async () => {
    await loadV03();
    store().addContract('Loose');
    store().deleteContract('Loose');
    expect(store().editorModel.contracts.Loose).toBeUndefined();
    expect(store().editorDirty).toBe(true);
  });

  it('renameContract rewrites step output_contract references', async () => {
    await loadV03();
    store().renameContract('Plan', 'PlanV2');
    expect(store().editorModel.contracts.PlanV2).toBeTruthy();
    expect(store().editorModel.contracts.Plan).toBeUndefined();
    const design = store().editorModel.flows[0].steps.find(s => s.id === 'design');
    expect(design.output_contract).toBe('PlanV2');
    expect(store().editorDirty).toBe(true);
  });

  // ── COMP-PIPE-EDIT-7: save-as-template ───────────────────────────────────────

  it('saveAsTemplate posts { filename, model, metadata } and returns the response', async () => {
    await loadV03();
    const res = await store().saveAsTemplate({
      filename: 'my-template.stratum.yaml',
      metadata: { id: 'my-template', label: 'My Template' },
    });
    expect(res.ok).toBe(true);
    expect(templateCalls).toHaveLength(1);
    expect(templateCalls[0].body.filename).toBe('my-template.stratum.yaml');
    expect(templateCalls[0].body.metadata).toEqual({ id: 'my-template', label: 'My Template' });
    expect(Array.isArray(templateCalls[0].body.model.flows)).toBe(true);
  });

  it('saveAsTemplate surfaces a 409 id-collision without clearing dirty', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    expect(store().editorDirty).toBe(true);
    templateResponse = { ok: false, status: 409, body: { error: 'metadata.id "my-template" already in use' } };
    const res = await store().saveAsTemplate({
      filename: 'my-template.stratum.yaml',
      metadata: { id: 'my-template' },
    });
    expect(res.error).toBeTruthy();
    expect(store().editorDirty).toBe(true);
  });

  it('saveAsTemplate refuses to publish when the model has validation errors (no POST)', async () => {
    await loadV03();
    // Introduce a validation error (unknown contract) so editorErrors is non-empty.
    store().updateStep('design', { output_contract: 'DoesNotExist' });
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);
    const res = await store().saveAsTemplate({ filename: 'x.stratum.yaml', metadata: { id: 'x' } });
    expect(res.error).toMatch(/validation/i);
    expect(templateCalls).toHaveLength(0);
  });

  // ── COMP-PIPE-EDIT-6: YAML sync + conflict resolution ────────────────────────

  // A spec-wide YAML doc with a 2nd flow renamed so flushYaml must reconcile.
  const V03_YAML_RENAMED = `version: "0.3"
contracts:
  Plan:
    fields: { summary: string }
flows:
  pipeline:
    steps:
      - id: design
        agent: claude:design:opus
        intent: "Design the thing"
        output_contract: Plan
      - id: implement
        agent: claude:impl:sonnet
        intent: "Implement it"
        depends_on: [design]
`;

  it('loadSpecForEdit captures editorSpecHash and resets scope/conflict', async () => {
    await loadV03();
    expect(store().editorSpecHash).toBe('hash-v1');
    expect(store().editorSaveScope).toBe('flow');
    expect(store().editorConflict).toBeNull();
  });

  it('flushYaml replaces the model, reconciles the selected flow, validates spec-wide, latches scope', async () => {
    await loadV03();
    expect(store().editorSelectedFlow).toBe('build'); // gone in the new doc

    store().setYamlBuffer(V03_YAML_RENAMED);
    const ok = store().flushYaml();
    expect(ok).toBe(true);

    const s = store();
    // Model replaced from the pane text.
    expect(s.editorModel.flows.map(f => f.name)).toEqual(['pipeline']);
    // Selected flow reconciled (the old 'build' vanished → first editable flow).
    expect(s.editorSelectedFlow).toBe('pipeline');
    // Spec-wide save scope latched.
    expect(s.editorSaveScope).toBe('spec');
    expect(s.editorDirty).toBe(true);
    // Buffer cleared after a successful flush.
    expect(s.editorYamlBuffer).toBeNull();
    expect(s.editorYamlError).toBeNull();
    // Valid doc → no validation errors.
    expect(s.editorErrors.errors).toHaveLength(0);
  });

  it('flushYaml spec-wide validation catches an error in ANY flow', async () => {
    await loadV03();
    // Break flow `build` by referencing an unknown contract on a non-selected flow's
    // perspective; we simply edit the whole doc so design points at a missing contract.
    const broken = V03_YAML.replace('output_contract: Plan', 'output_contract: Ghost');
    store().setYamlBuffer(broken);
    store().flushYaml();
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
  });

  it('flushYaml on a parse error leaves the model intact and surfaces inline', async () => {
    await loadV03();
    const before = store().editorModel;
    store().setYamlBuffer('this: : : not valid yaml: [');
    const ok = store().flushYaml();
    expect(ok).toBe(false);
    // Model untouched.
    expect(store().editorModel).toBe(before);
    // Error surfaced + buffer still pending.
    expect(store().editorYamlError).toMatch(/parse error/i);
    expect(store().editorErrors.errors.some(e => /parse error/i.test(e))).toBe(true);
    expect(store().editorYamlBuffer).not.toBeNull();
  });

  it('saveSpec sends baseHash and the flowName when scope is flow', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    await store().saveSpec();
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].body.baseHash).toBe('hash-v1');
    expect(saveCalls[0].body.flowName).toBe('build');
    expect(saveCalls[0].body.force).toBeUndefined();
  });

  it('saveSpec omits flowName and updates the hash + un-latches scope when scope is spec', async () => {
    await loadV03();
    store().setYamlBuffer(V03_YAML_RENAMED);
    store().flushYaml();
    expect(store().editorSaveScope).toBe('spec');

    const res = await store().saveSpec();
    expect(res.ok).toBe(true);
    expect(saveCalls).toHaveLength(1);
    expect('flowName' in saveCalls[0].body).toBe(false);
    expect(saveCalls[0].body.baseHash).toBe('hash-v1');
    // Hash refreshed from the response, scope reset, dirty cleared.
    expect(store().editorSpecHash).toBe('hash-v2');
    expect(store().editorSaveScope).toBe('flow');
    expect(store().editorDirty).toBe(false);
  });

  it('saveSpec is BLOCKED (no POST) while the YAML buffer is pending', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    store().setYamlBuffer('version: "0.3"\nflows: {}'); // pending, not flushed
    const res = await store().saveSpec();
    expect(res.error).toMatch(/yaml pane/i);
    expect(saveCalls).toHaveLength(0);
    expect(store().editorDirty).toBe(true);
  });

  it('saveSpec is BLOCKED while the YAML buffer is unparseable (editorYamlError set)', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    store().setYamlBuffer('not: : valid [');
    store().flushYaml(); // sets editorYamlError, leaves buffer pending
    expect(store().editorYamlError).toBeTruthy();
    const res = await store().saveSpec();
    expect(res.error).toMatch(/yaml pane/i);
    expect(saveCalls).toHaveLength(0);
  });

  it('saveSpec sets editorConflict on a 409 and does NOT clear dirty', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    saveResponse = { ok: false, status: 409, body: { error: 'changed on disk', conflict: true, currentHash: 'hash-other' } };
    const res = await store().saveSpec();
    expect(res.conflict).toBe(true);
    expect(store().editorConflict).toEqual({ currentHash: 'hash-other' });
    expect(store().editorDirty).toBe(true);
  });

  it('resolveConflict("reload") re-fetches the spec and discards local edits', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    const res = await store().resolveConflict('reload');
    expect(res).toBeTruthy();
    expect(store().editorConflict).toBeNull();
    // Re-loaded → not dirty, intent reverted to the on-disk value.
    expect(store().editorDirty).toBe(false);
    const design = store().editorModel.flows[0].steps.find(s => s.id === 'design');
    expect(design.intent).toBe('Design the thing');
  });

  it('resolveConflict("overwrite") re-saves with force:true', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    const res = await store().resolveConflict('overwrite');
    expect(res.ok).toBe(true);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].body.force).toBe(true);
    expect(store().editorConflict).toBeNull();
  });

  it('handleSpecChanged reloads when the editor is clean', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'local but saved away' });
    useVisionStore.setState({ editorDirty: false }); // pretend clean
    specHash = 'hash-v3';
    await store().handleSpecChanged({ currentHash: 'hash-v3' });
    expect(store().editorSpecHash).toBe('hash-v3');
    expect(store().editorConflict).toBeNull();
  });

  it('handleSpecChanged sets a conflict when the editor is dirty', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'unsaved' });
    expect(store().editorDirty).toBe(true);
    store().handleSpecChanged({ currentHash: 'hash-disk' });
    expect(store().editorConflict).toEqual({ currentHash: 'hash-disk' });
    // Dirty edits preserved.
    expect(store().editorDirty).toBe(true);
  });

  // FINDING 2: a pane edit is pending (debounce/parse-error window) but not yet
  // flushed, so editorDirty is still false. A specChanged must NOT auto-reload
  // and discard the buffer — it must raise a conflict instead.
  it('handleSpecChanged conflicts (no reload) when a YAML buffer is pending though not dirty', async () => {
    await loadV03();
    store().setYamlBuffer('version: "0.3"\nflows: {}\n'); // pending, not flushed
    expect(store().editorDirty).toBe(false);
    specHash = 'hash-disk'; // would-be reload target
    store().handleSpecChanged({ currentHash: 'hash-disk' });
    // No reload: the pending buffer survives, the original load hash is unchanged,
    // and a conflict banner is raised instead.
    expect(store().editorConflict).toEqual({ currentHash: 'hash-disk' });
    expect(store().editorYamlBuffer).toBe('version: "0.3"\nflows: {}\n');
    expect(store().editorSpecHash).toBe('hash-v1');
  });

  it('handleSpecChanged conflicts (no reload) when the YAML buffer is unparseable', async () => {
    await loadV03();
    store().setYamlBuffer('not: : valid [');
    store().flushYaml(); // sets editorYamlError, leaves buffer pending, dirty stays false
    expect(store().editorDirty).toBe(false);
    expect(store().editorYamlError).toBeTruthy();
    store().handleSpecChanged({ currentHash: 'hash-disk' });
    expect(store().editorConflict).toEqual({ currentHash: 'hash-disk' });
    expect(store().editorYamlError).toBeTruthy();
  });

  // FINDING 3: an overwrite blocked by a pending buffer must KEEP the banner.
  it('resolveConflict("overwrite") keeps the banner when the save is blocked by a pending buffer', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    store().setYamlBuffer('version: "0.3"\nflows: {}\n'); // pending → blocks save
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    const res = await store().resolveConflict('overwrite');
    expect(res.error).toMatch(/yaml pane/i);
    // Banner preserved (the conflict is unresolved), no POST happened.
    expect(store().editorConflict).toEqual({ currentHash: 'x' });
    expect(saveCalls).toHaveLength(0);
  });

  it('resolveConflict("overwrite") keeps the banner when the save errors', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    saveResponse = { ok: false, status: 500, body: { error: 'disk full' } };
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    const res = await store().resolveConflict('overwrite');
    expect(res.error).toBeTruthy();
    expect(store().editorConflict).toEqual({ currentHash: 'x' });
  });

  it('resolveConflict("overwrite") clears the banner on a successful force save', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    const res = await store().resolveConflict('overwrite');
    expect(res.ok).toBe(true);
    expect(saveCalls[0].body.force).toBe(true);
    expect(store().editorConflict).toBeNull();
  });

  it('resolveConflict("reload") keeps the banner if the re-fetch fails', async () => {
    await loadV03();
    store().updateStep('design', { intent: 'edited' });
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    // Make the spec GET fail so loadSpecForEdit returns null (no model replace).
    specGetFails = true;
    const res = await store().resolveConflict('reload');
    expect(res).toBeNull();
    expect(store().editorConflict).toEqual({ currentHash: 'x' });
  });

  // FINDING 4: two flows share a step id ('review'); a validation error on
  // review in a NON-selected flow must not badge review in the selected flow.
  it('flushYaml scopes per-step warnings to the selected flow (no cross-flow id bleed)', async () => {
    await loadV03();
    // build/review and review_check/review share the id. Break ONLY review_check's
    // review (unknown contract) and keep `build` selected. The error must count in
    // errors[] but the per-step warning must NOT appear for the selected flow.
    const broken = V03_YAML.replace(
      `  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"`,
      `  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"
        output_contract: Ghost`,
    );
    store().setYamlBuffer(broken);
    store().flushYaml();
    expect(store().editorSelectedFlow).toBe('build');
    // Spec-wide errors[] still surfaces the problem (drives the count + banner).
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
    // But the selected flow (build) has no error on its own review step, so no
    // warning bleeds onto the visible node.
    expect(store().editorErrors.warningsByStepId.review).toBeFalsy();
  });

  // ── COMP-PIPE-EDIT-5: collapse / expand sub-flows ────────────────────────────

  it('collapseSelectedToSubflow surfaces a rejection reason without mutating', async () => {
    await loadV03();
    const flowCountBefore = store().editorModel.flows.length;
    // Self-name collision: newFlowName === the source flow is rejected.
    const ok = store().collapseSelectedToSubflow(['design'], 'build');
    expect(ok).toBe(false);
    expect(store().editorModel.flows.length).toBe(flowCountBefore);
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);
    expect(store().editorDirty).toBe(false);
  });

  it('collapseSelectedToSubflow applies on success and latches scope to spec', async () => {
    await loadV03();
    // Collapse [design] into a new sub-flow. design is consumed by implement via
    // depends_on (a rewireable boundary edge); single output, contiguous.
    // (implement/review carry an on_fail gate route, which cannot cross a boundary.)
    const ok = store().collapseSelectedToSubflow(['design'], 'prep');
    expect(ok).toBe(true);
    const names = store().editorModel.flows.map(f => f.name);
    expect(names).toContain('prep');
    // A flow-step replaced the group in the parent flow.
    const build = store().editorModel.flows.find(f => f.name === 'build');
    expect(build.steps.some(s => s._extra?.flow === 'prep')).toBe(true);
    expect(store().editorSaveScope).toBe('spec');
    expect(store().editorDirty).toBe(true);
  });

  it('expandSubflow opens the sub-flow for editing (selectFlow)', async () => {
    await loadV03();
    store().collapseSelectedToSubflow(['design'], 'prep');
    store().expandSubflow('prep');
    expect(store().editorSelectedFlow).toBe('prep');
  });

  // ── COMP-PIPE-EDIT-6 Codex review fixes ──────────────────────────────────────

  // FIX 1: spec-wide validation must not be clobbered by single-flow revalidation.
  // A YAML-pane doc with TWO flows, where the NON-selected flow has a broken step.
  const V03_YAML_TWO_FLOWS_ONE_BROKEN = `version: "0.3"
contracts:
  Plan:
    fields: { summary: string }
flows:
  build:
    steps:
      - id: design
        agent: claude:design:opus
        intent: "Design the thing"
        output_contract: Plan
  other:
    steps:
      - id: bad
        agent: claude:impl:sonnet
        intent: "Broken"
        output_contract: Ghost
`;

  it('FIX1: selectFlow under scope=spec keeps non-selected flows’ errors (no clobber)', async () => {
    await loadV03();
    // Flush a spec-wide doc with a broken non-selected flow → scope latches to spec.
    store().setYamlBuffer(V03_YAML_TWO_FLOWS_ONE_BROKEN);
    store().flushYaml();
    expect(store().editorSaveScope).toBe('spec');
    // Spec-wide errors picked up the broken `other` flow.
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
    const countAfterFlush = store().editorErrors.errors.length;
    expect(countAfterFlush).toBeGreaterThan(0);

    // selectFlow to the CLEAN flow must NOT drop the broken flow's error.
    store().selectFlow('build');
    expect(store().editorSelectedFlow).toBe('build');
    expect(store().editorErrors.errors.length).toBe(countAfterFlush);
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
  });

  it('FIX1: _revalidateEditor under scope=spec aggregates across all editable flows', async () => {
    await loadV03();
    store().setYamlBuffer(V03_YAML_TWO_FLOWS_ONE_BROKEN);
    store().flushYaml();
    store().selectFlow('build'); // clean flow selected, scope still spec
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);

    // A direct revalidation call (e.g. after a mutation) must stay spec-wide.
    store()._revalidateEditor();
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
  });

  it('FIX1: a collapse that leaves an error in a NON-selected flow keeps Save gated', async () => {
    await loadV03();
    // Break the non-selected `review_check` flow so it has a standing error,
    // then collapse a group in `build` (latches scope to spec).
    const broken = V03_YAML.replace(
      `  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"`,
      `  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"
        output_contract: Ghost`,
    );
    store().setYamlBuffer(broken);
    store().flushYaml();
    store().selectFlow('build'); // select the clean flow; scope stays spec
    // Sanity: build itself is clean, but spec-wide error from review_check stands.
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);

    // Collapse a group in build. After the collapse, revalidation runs; it must
    // remain spec-wide so the review_check error is NOT dropped (Save stays gated).
    const ok = store().collapseSelectedToSubflow(['design'], 'prep');
    expect(ok).toBe(true);
    expect(store().editorSaveScope).toBe('spec');
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
  });

  it('FIX1: spec-wide warningsByStepId stays keyed to the selected flow after selectFlow', async () => {
    await loadV03();
    // Break review_check/review only; keep scope spec.
    const broken = V03_YAML.replace(
      `  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"`,
      `  review_check:
    steps:
      - id: review
        agent: claude:review:opus
        intent: "Subflow review"
        output_contract: Ghost`,
    );
    store().setYamlBuffer(broken);
    store().flushYaml();
    // Select build (clean): its `review` step shares the id but is fine, so no
    // warning should bleed onto it from review_check.
    store().selectFlow('build');
    expect(store().editorErrors.errors.some(e => /not a known contract/.test(e))).toBe(true);
    expect(store().editorErrors.warningsByStepId.review).toBeFalsy();
    // Selecting the broken flow surfaces the per-step warning for review.
    store().selectFlow('review_check');
    expect(store().editorErrors.warningsByStepId.review).toBeTruthy();
  });

  // FIX 2: validation + buffer gates must live in the store actions so all callers
  // (overwrite/force, save-as-template) are protected, not just the UI buttons.

  it('FIX2: saveSpec({force:true}) with validation errors returns an error and does NOT POST', async () => {
    await loadV03();
    // Introduce a validation error (unknown contract) on the selected flow.
    store().updateStep('design', { output_contract: 'DoesNotExist' });
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);
    const res = await store().saveSpec({ force: true });
    expect(res.error).toBeTruthy();
    expect(res.error).toMatch(/validation/i);
    expect(saveCalls).toHaveLength(0);
    // Still dirty (nothing persisted).
    expect(store().editorDirty).toBe(true);
  });

  it('FIX2: resolveConflict("overwrite") with validation errors keeps the banner and does NOT POST', async () => {
    await loadV03();
    store().updateStep('design', { output_contract: 'DoesNotExist' });
    useVisionStore.setState({ editorConflict: { currentHash: 'x' } });
    const res = await store().resolveConflict('overwrite');
    expect(res.error).toMatch(/validation/i);
    expect(saveCalls).toHaveLength(0);
    // Conflict unresolved → banner preserved.
    expect(store().editorConflict).toEqual({ currentHash: 'x' });
  });

  it('FIX2: saveAsTemplate with a pending YAML buffer returns an error and does NOT POST', async () => {
    await loadV03();
    store().setYamlBuffer('version: "0.3"\nflows: {}'); // pending, not flushed
    const res = await store().saveAsTemplate({ filename: 'x.stratum.yaml', metadata: { id: 'x' } });
    expect(res.error).toMatch(/yaml pane/i);
    expect(templateCalls).toHaveLength(0);
  });

  it('FIX2: saveAsTemplate with an unparseable YAML buffer returns an error and does NOT POST', async () => {
    await loadV03();
    store().setYamlBuffer('not: : valid [');
    store().flushYaml(); // sets editorYamlError, leaves buffer pending
    expect(store().editorYamlError).toBeTruthy();
    const res = await store().saveAsTemplate({ filename: 'x.stratum.yaml', metadata: { id: 'x' } });
    expect(res.error).toMatch(/yaml pane/i);
    expect(templateCalls).toHaveLength(0);
  });

  it('FIX2: saveAsTemplate still refuses to publish with validation errors (no POST)', async () => {
    await loadV03();
    store().updateStep('design', { output_contract: 'DoesNotExist' });
    expect(store().editorErrors.errors.length).toBeGreaterThan(0);
    const res = await store().saveAsTemplate({ filename: 'x.stratum.yaml', metadata: { id: 'x' } });
    expect(res.error).toMatch(/validation/i);
    expect(templateCalls).toHaveLength(0);
  });
});
