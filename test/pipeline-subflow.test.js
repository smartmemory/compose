/**
 * pipeline-subflow.test.js — collapseToSubflow + modelToYamlObject
 * (COMP-PIPE-EDIT-5 collapse, COMP-PIPE-EDIT-6 YAML serialize helper).
 *
 * collapseToSubflow extracts a SESE, dependency-contiguous group of steps from
 * one flow into a brand-new sub-flow with `input` ports + a single `output`,
 * replacing the group with a single `kind:'flow'` step in the parent. This is
 * the first CROSS-flow rewrite in the model lib (all prior ref logic is
 * flow-local), so the tests below pin: happy-path rewiring, the single-output
 * SESE constraint, dependency contiguity, and the boundary-edge rejections
 * (source / gate-route cuts) plus name-uniqueness.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildSpecText = readFileSync(`${ROOT}/pipelines/build.stratum.yaml`, 'utf-8');

const {
  specToModel,
  flowSteps,
  modelToSpecObject,
  collapseToSubflow,
  modelToYamlObject,
  validateFlow,
} = await import(`${ROOT}/src/lib/pipeline-model.js`);

// A small hand-built spec with a clean SESE region. Flow `main`:
//   a (producer) -> b -> c -> d (consumer)
// where b,c each take a $.steps.<prev>.output input. Collapsing {b,c} should:
//   - mint one input port for a's output (consumed by b),
//   - set the single output to c's output_contract (c consumed by d),
//   - leave a flow-step in `main` between a and d.
function seseSpec() {
  return {
    version: '0.3',
    contracts: {
      AOut: { x: { type: 'string' } },
      BOut: { y: { type: 'string' } },
      COut: { z: { type: 'string' } },
      DOut: { w: { type: 'string' } },
    },
    flows: {
      main: {
        input: { seed: { type: 'string' } },
        output: 'DOut',
        steps: [
          { id: 'a', agent: 'claude', intent: 'a', inputs: { seed: '$.input.seed' }, output_contract: 'AOut' },
          { id: 'b', agent: 'claude', intent: 'b', inputs: { from_a: '$.steps.a.output.x' }, output_contract: 'BOut', depends_on: ['a'] },
          { id: 'c', agent: 'claude', intent: 'c', inputs: { from_b: '$.steps.b.output.y' }, output_contract: 'COut', depends_on: ['b'] },
          { id: 'd', agent: 'claude', intent: 'd', inputs: { from_c: '$.steps.c.output.z' }, output_contract: 'DOut', depends_on: ['c'] },
        ],
      },
    },
  };
}

describe('collapseToSubflow — happy SESE collapse', () => {
  test('creates a new flow with input ports + single output, parent flow-step, rewired refs', () => {
    const model = specToModel(seseSpec());
    const r = collapseToSubflow(model, 'main', ['b', 'c'], 'sub');
    assert.equal(r.ok, true, r.reason);

    // New flow exists in model.flows AND _doc.flows.
    const sub = model.flows.find(f => f.name === 'sub');
    assert.ok(sub, 'sub flow created in model.flows');
    assert.deepEqual(sub.steps.map(s => s.id), ['b', 'c']);
    assert.ok(model._doc.flows.sub, 'sub injected into _doc.flows');

    // Sub-flow has exactly one input port (from a's output) and one output (c's contract).
    const subInput = model._doc.flows.sub.input;
    assert.equal(typeof subInput, 'object');
    const inputFields = Object.keys(subInput);
    assert.equal(inputFields.length, 1, 'exactly one inbound producer => one input port');
    assert.equal(model._doc.flows.sub.output, 'COut', 'single outbound producer contract is the output');

    // The moved `b` step's input ref was rewritten from $.steps.a... to $.input.<field>.
    const movedB = sub.steps.find(s => s.id === 'b');
    const bInputVal = movedB.inputs.from_a;
    assert.ok(bInputVal.startsWith('$.input.'), `b input rewired to $.input.* (got ${bInputVal})`);
    assert.ok(bInputVal.includes(inputFields[0]), 'b input names the minted port');
    // The moved `c` step's intra-group ref ($.steps.b...) is preserved (still flow-local in sub).
    const movedC = sub.steps.find(s => s.id === 'c');
    assert.ok(movedC.inputs.from_b.startsWith('$.steps.b'), 'intra-group ref preserved');

    // Parent flow `main` now: a, <flow-step>, d.
    const main = flowSteps(model, 'main');
    const ids = main.map(s => s.id);
    assert.equal(ids.length, 3);
    assert.equal(ids[0], 'a');
    assert.equal(ids[2], 'd');
    const flowStep = main[1];
    assert.equal(flowStep.kind, 'flow');
    assert.equal(flowStep._extra.flow, 'sub');
    // flow-step depends on the outside producer `a`.
    assert.ok(flowStep.depends_on.includes('a'), 'flow-step depends_on outside producer a');
    // flow-step inputs supply the sub-flow input port from a's output (parent scope).
    const fsInputVal = flowStep.inputs[inputFields[0]];
    assert.ok(fsInputVal.startsWith('$.steps.a'), `flow-step input pulls from a (got ${fsInputVal})`);

    // Outside consumer `d` was rewired: its $.steps.c... ref now points at the flow-step id.
    const d = main.find(s => s.id === 'd');
    assert.ok(d.inputs.from_c.startsWith(`$.steps.${flowStep.id}`), `d rewired to flow-step (got ${d.inputs.from_c})`);
    assert.ok(d.depends_on.includes(flowStep.id), 'd depends_on flow-step');
    assert.ok(!d.depends_on.includes('c'), 'd no longer depends_on the moved c');

    // Both flows still validate.
    assert.equal(validateFlow(model, 'main').errors.length, 0, JSON.stringify(validateFlow(model, 'main').errors));
    assert.equal(validateFlow(model, 'sub').errors.length, 0, JSON.stringify(validateFlow(model, 'sub').errors));
  });

  test('inbound input ref KEEPS its .output.<field> suffix (port fed by full path)', () => {
    // a.output has fields x and y. b (selected) consumes $.steps.a.output.x.
    // Collapsing {b}: the sub-flow input port must be fed by the FULL
    // $.steps.a.output.x path in the parent flow-step inputs, and the moved
    // step must read a bare $.input.<port> (the port value already IS a.output.x).
    const model = specToModel(seseSpec());
    const r = collapseToSubflow(model, 'main', ['b'], 'sub');
    assert.equal(r.ok, true, r.reason);

    const main = flowSteps(model, 'main');
    const flowStep = main.find(s => s.kind === 'flow');
    const ports = Object.keys(flowStep.inputs);
    assert.equal(ports.length, 1, 'one inbound ref => one port');
    const port = ports[0];
    // The parent flow-step feeds the port from the FULL original path (.output.x).
    assert.equal(flowStep.inputs[port], '$.steps.a.output.x', `port fed by full path (got ${flowStep.inputs[port]})`);

    // The moved step reads a BARE $.input.<port> (NOT $.input.<port>.output.x).
    const sub = model.flows.find(f => f.name === 'sub');
    const movedB = sub.steps.find(s => s.id === 'b');
    assert.equal(movedB.inputs.from_a, `$.input.${port}`, `moved step reads bare $.input.<port> (got ${movedB.inputs.from_a})`);
  });

  test('two DISTINCT suffixes from the same producer mint TWO ports; identical refs share one', () => {
    // b consumes a.output.x ; c consumes a.output.y AND a.output.x (shared with b).
    // Collapsing {b, c}: producer `a` is outside. Distinct ref strings:
    //   $.steps.a.output.x (b + c) -> ONE shared port
    //   $.steps.a.output.y (c)     -> a SECOND port
    const spec = {
      version: '0.3',
      contracts: { AOut: { x: { type: 'string' }, y: { type: 'string' } }, O: { z: { type: 'string' } } },
      flows: {
        main: {
          steps: [
            { id: 'a', agent: 'claude', intent: 'a', output_contract: 'AOut' },
            { id: 'b', agent: 'claude', intent: 'b', inputs: { bx: '$.steps.a.output.x' }, output_contract: 'O', depends_on: ['a'] },
            { id: 'c', agent: 'claude', intent: 'c', inputs: { cx: '$.steps.a.output.x', cy: '$.steps.a.output.y' }, output_contract: 'O', depends_on: ['a', 'b'] },
            { id: 'd', agent: 'claude', intent: 'd', inputs: { i: '$.steps.c.output.z' }, output_contract: 'O', depends_on: ['c'] },
          ],
        },
      },
    };
    const model = specToModel(spec);
    const r = collapseToSubflow(model, 'main', ['b', 'c'], 'sub');
    assert.equal(r.ok, true, r.reason);

    const flowStep = flowSteps(model, 'main').find(s => s.kind === 'flow');
    // Exactly two ports: one for a.output.x, one for a.output.y.
    assert.equal(Object.keys(flowStep.inputs).length, 2, 'two distinct suffixes => two ports');
    const portVals = Object.values(flowStep.inputs);
    assert.ok(portVals.includes('$.steps.a.output.x'), 'port for a.output.x');
    assert.ok(portVals.includes('$.steps.a.output.y'), 'port for a.output.y');

    // The two moved-step refs that both consume a.output.x point at the SAME port.
    const sub = model.flows.find(f => f.name === 'sub');
    const movedB = sub.steps.find(s => s.id === 'b');
    const movedC = sub.steps.find(s => s.id === 'c');
    const xPort = Object.keys(flowStep.inputs).find(k => flowStep.inputs[k] === '$.steps.a.output.x');
    const yPort = Object.keys(flowStep.inputs).find(k => flowStep.inputs[k] === '$.steps.a.output.y');
    assert.equal(movedB.inputs.bx, `$.input.${xPort}`, 'b.bx -> shared x port');
    assert.equal(movedC.inputs.cx, `$.input.${xPort}`, 'c.cx -> SAME shared x port');
    assert.equal(movedC.inputs.cy, `$.input.${yPort}`, 'c.cy -> distinct y port');
  });

  test('modelToSpecObject emits the newly-injected flow', () => {
    const model = specToModel(seseSpec());
    collapseToSubflow(model, 'main', ['b', 'c'], 'sub');
    const spec = modelToSpecObject(model);
    assert.ok(spec.flows.sub, 'modelToSpecObject emits sub');
    assert.equal(spec.flows.sub.output, 'COut');
    assert.ok(spec.flows.sub.input);
    assert.deepEqual(spec.flows.sub.steps.map(s => s.id), ['b', 'c']);
    // Parent flow has the flow-step referencing sub.
    const flowStep = spec.flows.main.steps.find(s => s.flow === 'sub');
    assert.ok(flowStep, 'parent flow-step emitted with flow: sub');
  });
});

describe('collapseToSubflow — rejections', () => {
  test('rejects when two distinct selected steps are consumed outside (multi-output)', () => {
    // main: a -> b -> c ; both b and c consumed by separate outside steps d, e.
    const spec = {
      version: '0.3',
      contracts: { O: { x: { type: 'string' } } },
      flows: {
        main: {
          steps: [
            { id: 'a', agent: 'claude', intent: 'a', output_contract: 'O' },
            { id: 'b', agent: 'claude', intent: 'b', inputs: { i: '$.steps.a.output.x' }, output_contract: 'O', depends_on: ['a'] },
            { id: 'c', agent: 'claude', intent: 'c', inputs: { i: '$.steps.b.output.x' }, output_contract: 'O', depends_on: ['b'] },
            { id: 'd', agent: 'claude', intent: 'd', inputs: { i: '$.steps.b.output.x' }, output_contract: 'O', depends_on: ['b'] },
            { id: 'e', agent: 'claude', intent: 'e', inputs: { i: '$.steps.c.output.x' }, output_contract: 'O', depends_on: ['c'] },
          ],
        },
      },
    };
    const model = specToModel(spec);
    const r = collapseToSubflow(model, 'main', ['b', 'c'], 'sub');
    assert.equal(r.ok, false);
    assert.match(r.reason, /output|consumed/i);
    // model untouched: no sub flow created.
    assert.ok(!model.flows.find(f => f.name === 'sub'));
  });

  test('rejects a non-contiguous selection (outside step between selected steps)', () => {
    // a -> b -> mid -> c -> d ; selecting {b, c} skips `mid` which sits between them.
    const spec = {
      version: '0.3',
      contracts: { O: { x: { type: 'string' } } },
      flows: {
        main: {
          steps: [
            { id: 'a', agent: 'claude', intent: 'a', output_contract: 'O' },
            { id: 'b', agent: 'claude', intent: 'b', inputs: { i: '$.steps.a.output.x' }, output_contract: 'O', depends_on: ['a'] },
            { id: 'mid', agent: 'claude', intent: 'mid', inputs: { i: '$.steps.b.output.x' }, output_contract: 'O', depends_on: ['b'] },
            { id: 'c', agent: 'claude', intent: 'c', inputs: { i: '$.steps.mid.output.x' }, output_contract: 'O', depends_on: ['mid'] },
            { id: 'd', agent: 'claude', intent: 'd', inputs: { i: '$.steps.c.output.x' }, output_contract: 'O', depends_on: ['c'] },
          ],
        },
      },
    };
    const model = specToModel(spec);
    const r = collapseToSubflow(model, 'main', ['b', 'c'], 'sub');
    assert.equal(r.ok, false);
    assert.match(r.reason, /contiguous|between|DAG/i);
    assert.ok(!model.flows.find(f => f.name === 'sub'));
  });

  test('rejects a boundary edge that crosses via parallel `source`', () => {
    // a (decompose) -> b ; outside `disp` is a parallel_dispatch with source on b.
    const spec = {
      version: '0.3',
      contracts: { O: { x: { type: 'string' } }, TaskGraph: { tasks: { type: 'array' } } },
      flows: {
        main: {
          steps: [
            { id: 'a', agent: 'claude', intent: 'a', output_contract: 'O' },
            { id: 'b', type: 'decompose', agent: 'claude', intent: 'b', inputs: { i: '$.steps.a.output.x' }, output_contract: 'TaskGraph', depends_on: ['a'] },
            { id: 'disp', type: 'parallel_dispatch', agent: 'claude', source: '$.steps.b.output.tasks', intent_template: 't', depends_on: ['b'] },
          ],
        },
      },
    };
    const model = specToModel(spec);
    // Selecting {b}: b is consumed by `disp` via a parallel `source` boundary edge → reject.
    const r = collapseToSubflow(model, 'main', ['b'], 'sub');
    assert.equal(r.ok, false);
    assert.match(r.reason, /source/i);
    assert.ok(!model.flows.find(f => f.name === 'sub'));
  });

  test('rejects a boundary edge that crosses via a gate route (on_fail)', () => {
    // a -> b ; outside `g` references b via on_fail (a gate route / control transfer).
    const spec = {
      version: '0.3',
      contracts: { O: { x: { type: 'string' } } },
      flows: {
        main: {
          steps: [
            { id: 'a', agent: 'claude', intent: 'a', output_contract: 'O' },
            { id: 'b', agent: 'claude', intent: 'b', inputs: { i: '$.steps.a.output.x' }, output_contract: 'O', depends_on: ['a'] },
            { id: 'g', agent: 'claude', intent: 'g', output_contract: 'O', on_fail: 'b', depends_on: ['b'] },
          ],
        },
      },
    };
    const model = specToModel(spec);
    const r = collapseToSubflow(model, 'main', ['b'], 'sub');
    assert.equal(r.ok, false);
    assert.match(r.reason, /on_fail|gate|route/i);
    assert.ok(!model.flows.find(f => f.name === 'sub'));
  });

  test('rejects a duplicate / self / existing flow name', () => {
    const model = specToModel(seseSpec());
    // newFlowName collides with an existing flow.
    assert.equal(collapseToSubflow(model, 'main', ['b', 'c'], 'main').ok, false);
    // collides with another existing flow key too — add one and retry.
    const m2 = specToModel({
      ...seseSpec(),
      flows: { ...seseSpec().flows, other: { steps: [{ id: 'z', agent: 'claude', intent: 'z' }] } },
    });
    const r = collapseToSubflow(m2, 'main', ['b', 'c'], 'other');
    assert.equal(r.ok, false);
    assert.match(r.reason, /exist|unique|name/i);
  });

  test('rejects stepIds not all in the named flow', () => {
    const model = specToModel(seseSpec());
    const r = collapseToSubflow(model, 'main', ['b', 'nope'], 'sub');
    assert.equal(r.ok, false);
    assert.match(r.reason, /nope|flow/i);
  });
});

describe('modelToYamlObject — full plain spec for the YAML pane', () => {
  test('round-trips structurally for the real build spec', () => {
    const parsed = YAML.parse(buildSpecText);
    const model = specToModel(parsed);
    const obj = modelToYamlObject(model);
    // Has version + contracts + flows.
    assert.equal(obj.version, '0.3');
    assert.ok(obj.contracts && obj.contracts.PhaseResult, 'contracts present');
    assert.ok(obj.flows && obj.flows.build, 'flows present');
    // Re-parse via specToModel: same flow set + step ids per flow.
    const yamlText = YAML.stringify(obj);
    const round = specToModel(YAML.parse(yamlText));
    const flowNames = round.flows.map(f => f.name).sort();
    const origNames = model.flows.map(f => f.name).sort();
    assert.deepEqual(flowNames, origNames);
    for (const f of origNames) {
      assert.deepEqual(
        flowSteps(round, f).map(s => s.id),
        flowSteps(model, f).map(s => s.id),
        `flow ${f} step ids round-trip`,
      );
    }
    // Reserved TaskGraph should NOT be emitted as a user contract (serializeContracts strips it).
    // build.stratum.yaml DOES declare TaskGraph in contracts, so confirm it is dropped.
    assert.ok(!obj.contracts.TaskGraph, 'reserved TaskGraph stripped from serialized contracts');
  });
});
