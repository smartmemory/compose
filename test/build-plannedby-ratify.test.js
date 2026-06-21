import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlannedByRatify } from '../lib/build.js';

// COMP-ROADMAP-PLAN S5 (T12): build's explore_design ratifies a plan-authored
// design instead of clobbering it, when feature.json.plannedBy is set.

function makeSpec() {
  return {
    flows: {
      build: {
        steps: [
          { id: 'explore_design', agent: 'claude', intent: 'Explore the codebase and write a design doc.' },
          { id: 'blueprint', agent: 'claude', intent: 'Write a blueprint.' },
          { id: 'ship', agent: 'claude', intent: 'Ship it.' },
        ],
      },
    },
  };
}

test('T12a: plannedBy set rewrites explore_design to ratify-not-rewrite', () => {
  const spec = makeSpec();
  const original = spec.flows.build.steps[0].intent;
  const mutated = applyPlannedByRatify(spec, 'build', 'PLAN-WIDGET');
  assert.equal(mutated, true);
  const intent = spec.flows.build.steps[0].intent;
  assert.notEqual(intent, original);
  assert.match(intent, /RATIFY/);
  assert.match(intent, /READ it fully/);
  assert.match(intent, /not rewrite/i);
  assert.match(intent, /PLAN-WIDGET/);
  // other steps untouched
  assert.match(spec.flows.build.steps[1].intent, /blueprint/i);
});

test('T12b: no plannedBy leaves the spec unchanged', () => {
  const spec = makeSpec();
  const original = spec.flows.build.steps[0].intent;
  assert.equal(applyPlannedByRatify(spec, 'build', null), false);
  assert.equal(spec.flows.build.steps[0].intent, original);
});

test('T12c: a flow without explore_design is a safe no-op', () => {
  const spec = { flows: { build: { steps: [{ id: 'ship', intent: 'ship' }] } } };
  assert.equal(applyPlannedByRatify(spec, 'build', 'PLAN-X'), false);
  assert.equal(spec.flows.build.steps[0].intent, 'ship');
});

test('T12d: falls back to the first flow when flowName is unknown', () => {
  const spec = makeSpec();
  const mutated = applyPlannedByRatify(spec, 'nonexistent-flow', 'PLAN-Y');
  assert.equal(mutated, true);
  assert.match(spec.flows.build.steps[0].intent, /PLAN-Y/);
});

test('T12e: keeps the {featureCode} token so build interpolation still resolves', () => {
  const spec = makeSpec();
  applyPlannedByRatify(spec, 'build', 'PLAN-Z');
  assert.match(spec.flows.build.steps[0].intent, /\{featureCode\}/);
});
