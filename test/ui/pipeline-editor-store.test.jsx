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
  saveResponse = { ok: true, file: 'demo.stratum.yaml' };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/pipeline/specs')) {
      return makeResponse({ specs: [
        { file: 'demo.stratum.yaml', version: '0.3', flows: ['build', 'review_check'] },
        { file: 'legacy.stratum.yaml', version: '0.1', flows: ['legacy'] },
      ] });
    }
    if (u.includes('/api/pipeline/spec')) {
      const file = decodeURIComponent(u.split('file=')[1] || '');
      const text = file.startsWith('legacy') ? V01_YAML : V03_YAML;
      return makeResponse({ file, text });
    }
    if (u.includes('/api/pipeline/save')) {
      saveCalls.push({ url: u, body: JSON.parse(opts.body) });
      return makeResponse(saveResponse);
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
    saveResponse = { error: 'parse failed' };
    const res = await store().saveSpec();
    expect(res.error).toBeTruthy();
    expect(store().editorDirty).toBe(true);
  });
});
