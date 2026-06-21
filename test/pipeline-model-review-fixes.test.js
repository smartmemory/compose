/**
 * pipeline-model-review-fixes.test.js — Codex review fixes for the pure model lib.
 *
 * FIX 2: workflow.output is a fourth contract ref site (rename/canDelete/delete).
 * FIX 3: validateFlow flags a flow-step whose _extra.flow targets a missing flow.
 * FIX 4: the synthetic 'functions' fallback flow is display-only and must NOT be
 *        emitted as a real flows.functions block by modelToSpecObject.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  specToModel,
  modelToSpecObject,
  validateFlow,
  renameContract,
  canDeleteContract,
  deleteContract,
} = await import(`${ROOT}/src/lib/pipeline-model.js`);

// ---------------------------------------------------------------------------
// FIX 2 — workflow.output as a fourth contract ref site
// ---------------------------------------------------------------------------

// A workflow.steps spec that ALSO declares workflow.output: Foo.
function workflowOutputSpec() {
  return {
    version: '0.3',
    contracts: { Foo: { a: { type: 'string' } }, Bar: { b: { type: 'string' } } },
    workflow: {
      name: 'wf',
      output: 'Foo',
      steps: [
        { id: 's1', agent: 'claude', intent: 'x', output_contract: 'Bar' },
      ],
    },
  };
}

describe('FIX 2 — workflow.output is a tracked contract ref site', () => {
  test('renameContract rewrites _doc.workflow.output', () => {
    const model = specToModel(workflowOutputSpec());
    renameContract(model, 'Foo', 'FooRenamed');
    assert.equal(model._doc.workflow.output, 'FooRenamed', 'workflow.output rewritten');
    assert.ok(model.contracts.FooRenamed);
    assert.ok(!('Foo' in model.contracts));
  });

  test('canDeleteContract is blocked when referenced ONLY by workflow.output', () => {
    const model = specToModel({
      version: '0.3',
      contracts: { OnlyWfOut: { z: { type: 'string' } } },
      workflow: { name: 'wf', output: 'OnlyWfOut', steps: [{ id: 's', agent: 'claude', intent: 'x' }] },
    });
    const res = canDeleteContract(model, 'OnlyWfOut');
    assert.equal(res.ok, false, 'a workflow.output ref must block delete');
    assert.ok(/OnlyWfOut/.test(res.reason));
  });

  test('deleteContract throws when blocked by workflow.output', () => {
    const model = specToModel(workflowOutputSpec());
    assert.throws(() => deleteContract(model, 'Foo'), /Foo|referenc/i);
    assert.ok(model.contracts.Foo, 'contract still present after blocked delete');
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — validateFlow flags a flow-step targeting a missing flow
// ---------------------------------------------------------------------------

// A doc with a `main` flow holding a flow-step + a real subflow.
function specWithFlowStep(targetFlow) {
  return {
    version: '0.3',
    contracts: { Foo: {} },
    flows: {
      main: {
        steps: [
          { id: 'a', agent: 'claude', intent: 'x' },
          { id: 'fs', flow: targetFlow, depends_on: ['a'] },
        ],
      },
      real_subflow: {
        input: {},
        output: 'Foo',
        steps: [{ id: 'inner', agent: 'claude', intent: 'y' }],
      },
    },
  };
}

describe('FIX 3 — validateFlow checks flow-step targets', () => {
  test('flags a flow-step whose _extra.flow targets a missing flow', () => {
    const model = specToModel(specWithFlowStep('missing'));
    const { errors, warningsByStepId } = validateFlow(model, 'main');
    assert.ok(
      errors.some(e => /missing/.test(e) && /flow/i.test(e)),
      `expected a missing-flow error, got ${JSON.stringify(errors)}`,
    );
    assert.ok((warningsByStepId.fs || []).some(e => /missing/.test(e)), 'badged per-step');
  });

  test('does NOT flag a flow-step that targets a real flow', () => {
    const model = specToModel(specWithFlowStep('real_subflow'));
    const { errors } = validateFlow(model, 'main');
    assert.ok(
      !errors.some(e => /flow.*not present|references unknown flow|target flow/i.test(e)),
      `unexpected flow-target error: ${JSON.stringify(errors)}`,
    );
  });

  test('does NOT flag a flow-step that self-references its own flow', () => {
    const model = specToModel({
      version: '0.3',
      contracts: { Foo: {} },
      flows: {
        main: {
          steps: [{ id: 'fs', flow: 'main' }],
        },
      },
    });
    const { errors } = validateFlow(model, 'main');
    assert.ok(
      !errors.some(e => /target flow|not present|references unknown flow/i.test(e)),
      `self-flow ref should not be flagged as missing: ${JSON.stringify(errors)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — function-only fallback flow is display-only (not serialized)
// ---------------------------------------------------------------------------

function functionOnlySpec() {
  return {
    version: '0.1',
    functions: {
      execute_task: { mode: 'compute', intent: 'Execute' },
      fix_and_review: { mode: 'compute', intent: 'Review' },
    },
  };
}

describe('FIX 4 — synthetic functions fallback flow round-trips without flows.functions', () => {
  test('specToModel surfaces a display-only functions flow', () => {
    const model = specToModel(functionOnlySpec());
    assert.ok(model.flows.some(f => f.name === 'functions'), 'display-only functions flow present');
  });

  test('modelToSpecObject does NOT introduce a flows.functions block', () => {
    const model = specToModel(functionOnlySpec());
    const out = modelToSpecObject(model);
    assert.ok(
      !(out.flows && 'functions' in out.flows),
      `synthetic functions flow must not serialize as flows.functions: ${JSON.stringify(out.flows)}`,
    );
    // The real functions DEFINITIONS block is untouched.
    assert.ok(out.functions && out.functions.execute_task, 'functions definitions preserved');
  });

  test('a REAL flow named functions IS still emitted (only the synthetic fallback is skipped)', () => {
    // A spec that has actual flow steps in a flow literally named `functions`.
    const model = specToModel({
      version: '0.3',
      functions: { helper: { mode: 'compute' } },
      flows: {
        functions: { steps: [{ id: 'real', agent: 'claude', intent: 'x' }] },
      },
    });
    const out = modelToSpecObject(model);
    assert.ok(out.flows && out.flows.functions, 'a real flows.functions is preserved');
    assert.deepEqual(out.flows.functions.steps.map(s => s.id), ['real']);
  });
});
