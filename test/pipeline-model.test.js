/**
 * pipeline-model.test.js — Unit tests for the pure pipeline-model lib (COMP-PIPE-EDIT-1 / T1).
 *
 * The module is framework-free: it receives an already-parsed JS object (from
 * `YAML.parse`) and returns/manipulates a flow-scoped in-memory model. Step
 * identity is (flowName, id), so the duplicate `review` id that lives in BOTH
 * the `review_check` subflow and the main `build` flow of build.stratum.yaml
 * must be kept distinct per flow.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  specToModel,
  flowSteps,
  listEditableFlows,
  modelToSpecObject,
  validateFlow,
  renameStep,
  canDeleteStep,
  deleteStep,
} = await import(`${ROOT}/src/lib/pipeline-model.js`);

const buildSpecText = readFileSync(`${ROOT}/pipelines/build.stratum.yaml`, 'utf-8');
const researchSpecText = readFileSync(`${ROOT}/pipelines/research.stratum.yaml`, 'utf-8');
const newSpecText = readFileSync(`${ROOT}/pipelines/new.stratum.yaml`, 'utf-8');

function parseBuild() { return YAML.parse(buildSpecText); }
function parseResearch() { return YAML.parse(researchSpecText); }
function parseNew() { return YAML.parse(newSpecText); }

// ---------------------------------------------------------------------------
// specToModel — multi-flow, duplicate ids per flow
// ---------------------------------------------------------------------------

describe('specToModel — multi-flow document', () => {
  test('returns multiple flows from build.stratum.yaml', () => {
    const model = specToModel(parseBuild());
    assert.equal(model.version, '0.3');
    const names = model.flows.map(f => f.name);
    // All flow keys under `flows:` should appear.
    assert.ok(names.includes('build'));
    assert.ok(names.includes('review_check'));
    assert.ok(names.includes('parallel_review'));
    assert.ok(names.includes('coverage_check'));
    assert.ok(names.includes('test_review'));
    assert.ok(model.flows.length >= 5);
  });

  test('keeps the duplicate `review` id distinct per flow ((flowName,id) identity)', () => {
    const model = specToModel(parseBuild());
    const reviewCheckReview = flowSteps(model, 'review_check').find(s => s.id === 'review');
    const buildReview = flowSteps(model, 'build').find(s => s.id === 'review');
    // Both flows have a step whose id is `review`...
    assert.ok(reviewCheckReview, 'review_check has a step id `review`');
    assert.ok(buildReview, 'build has a step id `review`');
    // ...but they are different steps: review_check's is an agent step, build's is a sub-flow ref.
    assert.equal(reviewCheckReview.kind, 'agent');
    assert.notEqual(reviewCheckReview.agent, undefined);
    // build's `review` is a flow-ref step (no agent, carries `flow` in _extra).
    assert.equal(buildReview._extra.flow, 'parallel_review');
  });

  test('contracts are exposed on the model', () => {
    const model = specToModel(parseBuild());
    assert.ok(model.contracts.PhaseResult);
    assert.ok(model.contracts.ReviewResult);
    assert.ok(model.contracts.TaskGraph);
  });

  test('workflow.steps single-flow spec is treated as one synthetic flow (new)', () => {
    const model = specToModel(parseNew());
    assert.equal(model.version, '0.2');
    const names = model.flows.map(f => f.name);
    // `new` uses flows.new.steps; one editable flow.
    assert.ok(names.includes('new'));
    assert.ok(flowSteps(model, 'new').length > 0);
  });

  test('v0.1 function-step spec loads with flow steps (research)', () => {
    const model = specToModel(parseResearch());
    assert.equal(model.version, '0.1');
    const steps = flowSteps(model, 'research');
    assert.deepEqual(steps.map(s => s.id), ['gather', 'analyze', 'report']);
    // function-step: function set, no agent.
    assert.equal(steps[0].function, 'gather');
  });
});

// ---------------------------------------------------------------------------
// flowSteps — normalized step shape
// ---------------------------------------------------------------------------

describe('flowSteps — normalized shape', () => {
  test('normalizes a step to the full field set with _extra carrying unsurfaced fields', () => {
    const model = specToModel(parseBuild());
    const exploreDesign = flowSteps(model, 'build').find(s => s.id === 'explore_design');
    const keys = Object.keys(exploreDesign).sort();
    assert.deepEqual(keys, [
      '_extra', 'agent', 'depends_on', 'ensure', 'function',
      'id', 'inputs', 'intent', 'kind', 'on_fail', 'output_contract', 'retries',
    ].sort());
    assert.equal(exploreDesign.agent, 'claude');
    assert.equal(exploreDesign.output_contract, 'PhaseResult');
    assert.ok(Array.isArray(exploreDesign.ensure));
    assert.ok(Array.isArray(exploreDesign.depends_on));
    assert.ok(exploreDesign.intent.includes('Explore the codebase'));
    assert.equal(exploreDesign.retries, 2);
  });

  test('_extra carries skip_if, gate routes, parallel fields, type, reasoning_template', () => {
    const model = specToModel(parseBuild());
    const steps = flowSteps(model, 'build');

    // skip_if survives in _extra (prd step).
    const prd = steps.find(s => s.id === 'prd');
    assert.equal(prd._extra.skip_if, 'true');
    assert.equal(prd._extra.skip_reason, 'PRD skipped by default — set skip_if to false to enable');

    // gate routes survive in _extra (design_gate step).
    const designGate = steps.find(s => s.id === 'design_gate');
    assert.equal(designGate._extra.on_approve, 'prd');
    assert.equal(designGate._extra.on_revise, 'explore_design');
    assert.ok('on_kill' in designGate._extra);
    // `function` is a surfaced field, not _extra.
    assert.equal(designGate.function, 'design_gate');

    // parallel-dispatch fields survive in _extra (execute step).
    const execute = steps.find(s => s.id === 'execute');
    assert.equal(execute._extra.type, 'parallel_dispatch');
    assert.equal(execute._extra.source, '$.steps.decompose.output.tasks');
    assert.equal(execute._extra.isolation, 'worktree');
    assert.equal(execute._extra.max_concurrent, 3);

    // isolation: none preserved in _extra (review_lenses in parallel_review).
    const reviewLenses = flowSteps(model, 'parallel_review').find(s => s.id === 'review_lenses');
    assert.equal(reviewLenses._extra.isolation, 'none');
    assert.equal(reviewLenses._extra.source, '$.steps.triage.output.tasks');
  });
});

// ---------------------------------------------------------------------------
// modelToSpecObject ∘ specToModel — shape-preserving
// ---------------------------------------------------------------------------

describe('modelToSpecObject ∘ specToModel — shape preserving', () => {
  test('round-trips build.stratum.yaml structure', () => {
    const parsed = parseBuild();
    const model = specToModel(parsed);
    const out = modelToSpecObject(model);

    // Same top-level keys (order-insensitive).
    assert.deepEqual(Object.keys(out.flows).sort(), Object.keys(parsed.flows).sort());
    assert.equal(out.version, parsed.version);

    // Both `review` steps preserved in their own flows.
    const outReviewCheck = out.flows.review_check.steps.find(s => s.id === 'review');
    const outBuildReview = out.flows.build.steps.find(s => s.id === 'review');
    assert.ok(outReviewCheck);
    assert.ok(outBuildReview);
    assert.equal(outBuildReview.flow, 'parallel_review');

    // Gate routes + parallel source + isolation survive.
    const outDesignGate = out.flows.build.steps.find(s => s.id === 'design_gate');
    assert.equal(outDesignGate.on_approve, 'prd');
    const outExecute = out.flows.build.steps.find(s => s.id === 'execute');
    assert.equal(outExecute.source, '$.steps.decompose.output.tasks');
    assert.equal(outExecute.isolation, 'worktree');
    const outLenses = out.flows.parallel_review.steps.find(s => s.id === 'review_lenses');
    assert.equal(outLenses.isolation, 'none');

    // Step counts match per flow.
    for (const name of Object.keys(parsed.flows)) {
      assert.equal(
        out.flows[name].steps.length,
        parsed.flows[name].steps.length,
        `step count for flow ${name}`,
      );
    }
  });

  test('round-trips the new (workflow.steps) spec', () => {
    const parsed = parseNew();
    const out = modelToSpecObject(specToModel(parsed));
    // `new` is single-flow; its steps round-trip.
    const outSteps = out.flows ? out.flows.new.steps : out.workflow.steps;
    const origSteps = parsed.workflow?.steps || parsed.flows.new.steps;
    assert.equal(outSteps.length, origSteps.length);
    assert.deepEqual(outSteps.map(s => s.id), origSteps.map(s => s.id));
  });
});

// ---------------------------------------------------------------------------
// listEditableFlows
// ---------------------------------------------------------------------------

describe('listEditableFlows', () => {
  test('returns flow names with a non-empty steps[]', () => {
    const flows = listEditableFlows(parseBuild());
    assert.ok(flows.includes('build'));
    assert.ok(flows.includes('review_check'));
    assert.ok(flows.includes('parallel_review'));
  });

  test('returns the synthetic flow for workflow.steps specs', () => {
    const flows = listEditableFlows(parseNew());
    assert.deepEqual(flows, ['new']);
  });
});

// ---------------------------------------------------------------------------
// validateFlow — table-driven
// ---------------------------------------------------------------------------

// Build a minimal single-flow parsed doc for targeted validation cases.
function specWithSteps(steps, contracts = { Foo: {} }) {
  return {
    version: '0.3',
    contracts,
    flows: {
      f: { input: {}, output: 'Foo', steps },
    },
  };
}

describe('validateFlow — table-driven', () => {
  test('passes a valid flow', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', output_contract: 'Foo' },
      { id: 'b', agent: 'claude', intent: 'y', output_contract: 'TaskGraph', depends_on: ['a'] },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.deepEqual(errors, [], `expected no errors, got ${JSON.stringify(errors)}`);
  });

  test('flags a duplicate step id (top-level AND per-step for the badge)', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x' },
      { id: 'a', agent: 'claude', intent: 'y' },
    ]));
    const { errors, warningsByStepId } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /duplicate/i.test(e) && /\ba\b/.test(e)));
    assert.ok(
      (warningsByStepId.a || []).some(e => /duplicate/i.test(e)),
      'duplicate id must also surface per-step so the inspector/canvas can badge it',
    );
  });

  test('flags a dangling depends_on ref', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', depends_on: ['ghost'] },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /depends_on/.test(e)));
  });

  test('flags a dangling on_fail ref', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', on_fail: 'ghost' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /on_fail/.test(e)));
  });

  test('flags a dangling on_approve ref', () => {
    const model = specToModel(specWithSteps([
      { id: 'g', function: 'gate', on_approve: 'ghost' },
      { id: 'a', agent: 'claude', intent: 'x' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /on_approve/.test(e)));
  });

  test('flags a dangling on_revise ref', () => {
    const model = specToModel(specWithSteps([
      { id: 'g', function: 'gate', on_revise: 'ghost' },
      { id: 'a', agent: 'claude', intent: 'x' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /on_revise/.test(e)));
  });

  test('flags a dangling on_kill ref', () => {
    const model = specToModel(specWithSteps([
      { id: 'g', function: 'gate', on_kill: 'ghost' },
      { id: 'a', agent: 'claude', intent: 'x' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /on_kill/.test(e)));
  });

  test('flags a dangling parallel `source` ref', () => {
    // `source` referencing a step uses the $.steps.<id>.output... form.
    const model = specToModel(specWithSteps([
      { id: 'a', type: 'parallel_dispatch', agent: 'claude', source: '$.steps.ghost.output.tasks' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /source/.test(e)));
  });

  test('does NOT flag a `source` that points at $.input (not a step ref)', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', type: 'parallel_dispatch', agent: 'claude', source: '$.input.tasks' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(!errors.some(e => /source/.test(e)), `unexpected source error: ${JSON.stringify(errors)}`);
  });

  test('flags an unknown output_contract (TaskGraph and none are allowed)', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', output_contract: 'Nonexistent' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /Nonexistent/.test(e) && /contract/i.test(e)));
  });

  test('allows TaskGraph and none as output_contract', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', output_contract: 'TaskGraph' },
      { id: 'b', agent: 'claude', intent: 'y', output_contract: 'none' },
      { id: 'c', agent: 'claude', intent: 'z', output_contract: 'Foo' },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(!errors.some(e => /contract/i.test(e)), `unexpected contract error: ${JSON.stringify(errors)}`);
  });

  test('flags a depends_on cycle', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', depends_on: ['b'] },
      { id: 'b', agent: 'claude', intent: 'y', depends_on: ['a'] },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /cycle/i.test(e)));
  });

  test('real build flow validates clean', () => {
    const model = specToModel(parseBuild());
    const { errors } = validateFlow(model, 'build');
    assert.deepEqual(errors, [], `build flow should be valid: ${JSON.stringify(errors)}`);
  });
});

// ---------------------------------------------------------------------------
// renameStep — rewrites ALL ref fields
// ---------------------------------------------------------------------------

describe('renameStep', () => {
  test('rewrites every reference field across the flow', () => {
    const model = specToModel(specWithSteps([
      { id: 'old', agent: 'claude', intent: 'x' },
      { id: 'b', agent: 'claude', intent: 'y', depends_on: ['old'], on_fail: 'old' },
      { id: 'g', function: 'gate', on_approve: 'old', on_revise: 'old', on_kill: 'old' },
      { id: 'p', type: 'parallel_dispatch', agent: 'claude', source: '$.steps.old.output.tasks' },
    ]));
    renameStep(model, 'f', 'old', 'renamed');
    const steps = flowSteps(model, 'f');

    assert.ok(steps.find(s => s.id === 'renamed'), 'step itself renamed');
    assert.ok(!steps.find(s => s.id === 'old'), 'no step with old id remains');

    const b = steps.find(s => s.id === 'b');
    assert.deepEqual(b.depends_on, ['renamed']);
    assert.equal(b.on_fail, 'renamed');

    const g = steps.find(s => s.id === 'g');
    assert.equal(g._extra.on_approve, 'renamed');
    assert.equal(g._extra.on_revise, 'renamed');
    assert.equal(g._extra.on_kill, 'renamed');

    const p = steps.find(s => s.id === 'p');
    assert.equal(p._extra.source, '$.steps.renamed.output.tasks');

    // The rename is flow-scoped: validation stays clean.
    const { errors } = validateFlow(model, 'f');
    assert.deepEqual(errors, [], `rename should keep flow valid: ${JSON.stringify(errors)}`);
  });
});

// ---------------------------------------------------------------------------
// canDeleteStep / deleteStep — blocked when referenced
// ---------------------------------------------------------------------------

describe('deleteStep — blocked when referenced', () => {
  test('canDeleteStep is false when another step references it', () => {
    const model = specToModel(specWithSteps([
      { id: 'target', agent: 'claude', intent: 'x' },
      { id: 'b', agent: 'claude', intent: 'y', depends_on: ['target'] },
    ]));
    const res = canDeleteStep(model, 'f', 'target');
    assert.equal(res.ok, false);
    assert.ok(/target/.test(res.reason));
  });

  test('deleteStep throws (or errors) when blocked', () => {
    const model = specToModel(specWithSteps([
      { id: 'target', agent: 'claude', intent: 'x' },
      { id: 'b', agent: 'claude', intent: 'y', on_approve: 'target', function: 'gate' },
    ]));
    assert.throws(() => deleteStep(model, 'f', 'target'), /target|referenc/i);
    // Step still present after a blocked delete.
    assert.ok(flowSteps(model, 'f').find(s => s.id === 'target'));
  });

  test('deleteStep removes an unreferenced step', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x' },
      { id: 'leaf', agent: 'claude', intent: 'y', depends_on: ['a'] },
    ]));
    assert.equal(canDeleteStep(model, 'f', 'leaf').ok, true);
    deleteStep(model, 'f', 'leaf');
    assert.ok(!flowSteps(model, 'f').find(s => s.id === 'leaf'));
    assert.ok(flowSteps(model, 'f').find(s => s.id === 'a'));
  });
});

// ---------------------------------------------------------------------------
// inputs JSONPath step references (finding 1) — $.steps.<id>... in inputs
// ---------------------------------------------------------------------------

describe('inputs $.steps.<id> references', () => {
  test('validateFlow flags a dangling inputs ref but ignores $.input refs', () => {
    const model = specToModel(specWithSteps([
      { id: 'a', agent: 'claude', intent: 'x', inputs: { fromInput: '$.input.task', fromGhost: '$.steps.ghost.output' } },
    ]));
    const { errors } = validateFlow(model, 'f');
    assert.ok(errors.some(e => /ghost/.test(e) && /inputs/.test(e)), `expected dangling inputs ref: ${JSON.stringify(errors)}`);
    assert.ok(!errors.some(e => /\$\.input\b/.test(e)), 'must not flag a $.input flow-input ref');
  });

  test('renameStep rewrites an inputs $.steps path (and only the whole id)', () => {
    const model = specToModel(specWithSteps([
      { id: 'foo', agent: 'claude', intent: 'x' },
      { id: 'foo-bar', agent: 'claude', intent: 'y' },
      { id: 'b', agent: 'claude', intent: 'z', inputs: {
        a: '$.steps.foo.output.x',
        b: '$.steps.foo-bar.output.y',
        c: '$.input.keep',
      } },
    ]));
    renameStep(model, 'f', 'foo', 'renamed');
    const b = flowSteps(model, 'f').find(s => s.id === 'b');
    assert.equal(b.inputs.a, '$.steps.renamed.output.x', 'foo rewritten');
    assert.equal(b.inputs.b, '$.steps.foo-bar.output.y', 'foo-bar NOT corrupted by foo rename');
    assert.equal(b.inputs.c, '$.input.keep', 'flow-input untouched');
    assert.deepEqual(validateFlow(model, 'f').errors, [], 'flow stays valid after rename');
  });

  test('canDeleteStep is blocked when referenced via inputs', () => {
    const model = specToModel(specWithSteps([
      { id: 'producer', agent: 'claude', intent: 'x' },
      { id: 'consumer', agent: 'claude', intent: 'y', inputs: { data: '$.steps.producer.output' } },
    ]));
    const res = canDeleteStep(model, 'f', 'producer');
    assert.equal(res.ok, false);
    assert.ok(/producer/.test(res.reason) && /inputs/.test(res.reason));
  });
});
