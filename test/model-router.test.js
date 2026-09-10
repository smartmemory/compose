/** Pure routing identity, contract closure and static-only policy tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRoutingJson, contractFingerprint, reachableContracts, dispatchKey, routingRecordId, routingTable, resolveRoute } from '../lib/model-router.js';

test('canonical JSON sorts objects, preserves arrays and rejects non-JSON values', () => {
  assert.equal(canonicalRoutingJson({ z: 1, a: [{ b: 2, a: '汉字' }] }), '{"a":[{"a":"汉字","b":2}],"z":1}');
  for (const value of [undefined, NaN, Infinity, { x: undefined }, [undefined], new Date(), 1n, Array(1)]) {
    assert.throws(() => canonicalRoutingJson(value));
  }
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalRoutingJson(cycle));
});
test('fingerprint follows reachable contracts, optionality, unions and unordered option/path sets', () => {
  const input = { root: 'Result', contracts: { Result: { rows: 'Row[]?', status: 'string|number' }, Row: { id: 'string' }, Unused: { x: 'number' } }, options: ['optional', 'union'], paths: ['rows.id', 'status'] };
  const original = contractFingerprint(input);
  assert.equal(original, contractFingerprint({ ...input, options: [...input.options].reverse(), paths: [...input.paths].reverse(), contracts: { ...input.contracts, Unused: { prompt: 'changed' } } }));
  assert.equal(original, contractFingerprint({ ...input, contracts: { ...input.contracts, Result: { rows: 'Row[]?', status: 'number|string' } } }));
  for (const change of [{ paths: ['rows'] }, { options: ['required'] }, { contracts: { ...input.contracts, Row: { id: 'number' } } }, { contracts: { ...input.contracts, Result: { rows: 'Row[]', status: 'string|number' } } }]) assert.notEqual(original, contractFingerprint({ ...input, ...change }));
  assert.throws(() => contractFingerprint({ root: 'Missing', contracts: {} }));
});
test('statistical keys omit task/run/spec text and encode null prior and scoped numeric stages', () => {
  const value = { preset: 'preset', scopedStep: 'sub/execute', stage: 0, provider: 'codex', prior: null, fingerprint: 'a'.repeat(64) };
  assert.equal(dispatchKey(value), dispatchKey({ ...value, task: 'different', runId: 'run2', spec: 'edit' }));
  assert.equal(JSON.parse(dispatchKey(value)).prior, null);
  assert.notEqual(dispatchKey(value), dispatchKey({ ...value, stage: null }));
  assert.notEqual(dispatchKey(value), dispatchKey({ ...value, scopedStep: 'other/execute' }));
  assert.throws(() => dispatchKey({ ...value, prior: 'gpt-6-astra' }));
});
test('issuance tuple distinguishes stages, items, epochs, generations, runs and retry tokens', () => {
  const value = { runId: 'run', scopedStep: 'a/b', stage: null, epoch: 0, itemIndex: null, generation: null, issuanceToken: 'token' };
  const ids = [value, { ...value, stage: 0 }, { ...value, itemIndex: 0, generation: 1 }, { ...value, epoch: 1 }, { ...value, runId: 'run2' }, { ...value, issuanceToken: 'retry' }].map(routingRecordId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(routingRecordId(value), routingRecordId({ ...value }));
  assert.throws(() => routingRecordId({ ...value, epoch: undefined }));
});
test('S1a always returns independent copies of static baseline, preserves manual/item provenance', () => {
  const start = { mode: 'shadow', policy: { route_trials: [], route_explore: 0 }, table: routingTable(), calibration_feedback: false };
  const baseline = { provider: 'codex', template: 'implementer', tier: 'critical', modelID: 'gpt-6-astra', source: 'preset', via: 'item.tier' };
  const result = resolveRoute({ start, key: 'key', allocationId: 'allocation', baseline, manualOverride: { supplied: true, profile: 'codex:implementer:fast' } });
  assert.deepEqual(result.admitted, baseline); assert.deepEqual(result.would, baseline); assert.deepEqual(result.proposal, baseline);
  assert.equal(result.source, 'preset'); assert.equal(result.via, 'item.tier');
  result.admitted.tier = 'fast'; assert.equal(baseline.tier, 'critical'); assert.equal(result.would.tier, 'critical');
  for (const change of [{ mode: 'active' }, { policy: { route_trials: ['x'], route_explore: 0 } }, { policy: { route_trials: [], route_explore: 0.1 } }, { calibration_feedback: true }]) assert.throws(() => resolveRoute({ start: { ...start, ...change }, baseline }), { code: 'ROUTING_SLICE_UNAVAILABLE' });
});
test('resolver exposes provenance from the same closed route shape persisted in admissions', () => {
  const baseline = { resolution: { provider: 'codex', tier: null }, provenance: { source: 'default', via: 'spec.agent' } };
  const result = resolveRoute({ start: { mode: 'shadow' }, key: 'key', baseline, allocationId: 'allocation' });
  assert.equal(result.source, 'default'); assert.equal(result.via, 'spec.agent'); assert.deepEqual(result.would, baseline);
});

test('contract grammar separates literal enums from refs and preserves optional nested arrays', () => {
  const contracts = { Result: { rows: 'Row[][]?', labels: '(Row|fast|critical)[][]?', status: 'complete|repair?' }, Row: { value: 'string' }, fast: { bad: 'Missing' } };
  const fingerprint = contractFingerprint({ root: 'Result', contracts });
  assert.deepEqual(Object.keys(reachableContracts('Result', contracts)).sort(), ['Result', 'Row']);
  assert.equal(fingerprint, contractFingerprint({ root: 'Result', contracts: { ...contracts, Result: { ...contracts.Result, labels: '(critical|fast|Row)[][]?', status: 'repair|complete?' } } }));
  assert.deepEqual(reachableContracts('Row|Missing', contracts), {});
  assert.deepEqual(reachableContracts('(Row)[]', contracts), {});
  assert.notEqual(contractFingerprint({ root: 'Row[]', contracts }), contractFingerprint({ root: '(Row)[]', contracts }));
  for (const labels of ['(Row|fast|critical)[]?', '(Row|fast|critical)[][]', '(Row|fast)[][]?']) {
    assert.notEqual(fingerprint, contractFingerprint({ root: 'Result', contracts: { ...contracts, Result: { ...contracts.Result, labels } } }));
  }
  for (const root of ['Row?[]', 'Row??', 'a||b', '(a|b)', 'unknown']) assert.throws(() => contractFingerprint({ root, contracts }), { code: 'ROUTING_SCHEMA_INVALID' });
});
