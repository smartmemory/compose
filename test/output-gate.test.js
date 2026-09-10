import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGateFromOutput } from '../lib/output-gate.js';
const config = { decide_from: { step: 'assess', field: 'action', approve: ['complete'], revise: ['repair', 'implement'], kill: ['blocked'] },
  validators: [{ name: 'WaveDecision', review_step: 'review' }] };
const finding = { severity: 'error', files: ['owned.txt'], claim: 'broken', evidence: 'test failed' };
const task = { id: 'T1', description: 'fix', files_owned: ['owned.txt'], files_read: [], depends_on: [], tier: 'critical' };
const executeOptions = { executeProfile: { default: 'codex:implementer:critical', tier_from: 'item.tier' }, executeProvider: 'codex' };
function evaluate(changes = {}, opts = {}, stateChanges = {}) {
  const output = { action: 'repair', rationale: 'fix test', tasks: [task], addressed_findings: [], open_findings: [finding], open_count: 1, blocking: true, ...changes };
  return decideGateFromOutput(config, { assess: { status: 'succeeded', epoch: 1, acceptedDispatchToken: 'source', output },
    review: { status: 'succeeded', epoch: 1, output: { blocking: output.blocking } },
    gate: { status: 'waiting_gate', epoch: 1, gateToken: 'gate-token' }, ...stateChanges }, { gateStepId: 'gate', gateToken: 'gate-token', ...executeOptions, ...opts });
}
for (const [action, outcome] of [['complete', 'approve'], ['repair', 'revise'], ['implement', 'revise'], ['blocked', 'kill']]) test(`${action} maps to ${outcome} with source/token evidence`, () => {
  const result = evaluate(action === 'complete' ? { action, open_count: 0, open_findings: [], blocking: false, tasks: [] } : { action });
  assert.equal(result.outcome, outcome); assert.equal(result.source.gateToken, 'gate-token');
  assert.equal(result.source.acceptedDispatchToken, 'source'); assert.equal(result.source.output.action, action);
});
const failures = [
  [{ open_count: 2 }, 'WAVE_OPEN_COUNT_MISMATCH'], [{ action: 'complete' }, 'WAVE_COMPLETE_WITH_OPEN_FINDINGS'],
  [{ action: 'blocked', open_count: 0, open_findings: [] }, 'WAVE_BLOCKED_WITHOUT_FINDINGS'],
  [{ tasks: [] }, 'WAVE_REPAIR_EMPTY'], [{ tasks: [{ ...task, files_owned: ['other.txt'] }] }, 'WAVE_REPAIR_UNOWNED_FINDING'],
  [{ tasks: [{ ...task, depends_on: ['prior'] }] }, 'WAVE_DEPENDENCIES_NOT_EMPTY'],
  [{ tasks: [{ ...task, tier: 'bogus' }] }, 'WAVE_TIER_INVALID'], [{ tasks: [{}] }, 'WAVE_DECISION_SHAPE'],
  [{ open_findings: [{}] }, 'WAVE_DECISION_SHAPE'],
];
for (const [changes, code] of failures) test(`${code} holds without consuming gate`, () => {
  const result = evaluate(changes); assert.equal(result.outcome, null); assert.ok(result.findings.some(f => f.code === code));
});
test('blocking must match current review output', () => {
  assert.ok(evaluate({}, {}, { review: { status: 'succeeded', epoch: 1, output: { blocking: false } } }).findings.some(f => f.code === 'WAVE_BLOCKING_MISMATCH'));
});
test('r1 #2: missing waiting gate, token or epoch evidence cannot approve completion', () => {
  const complete = { action: 'complete', open_count: 0, open_findings: [], blocking: false, tasks: [] };
  for (const gate of [undefined, {}, { status: 'succeeded', epoch: 1, gateToken: 'gate-token' },
    { status: 'waiting_gate', epoch: 2, gateToken: 'gate-token' },
    { status: 'waiting_gate', epoch: 1 }, { status: 'waiting_gate', gateToken: 'gate-token' }]) {
    const result = evaluate(complete, {}, { gate });
    assert.equal(result.outcome, null); assert.equal(result.reason, 'GATE_SOURCE_STALE');
  }
  for (const gateToken of [undefined, null, '']) {
    assert.equal(evaluate(complete, { gateToken }, { gate: { status: 'waiting_gate', epoch: 1, gateToken } }).outcome, null);
  }
  for (const step of ['assess', 'review']) {
    const state = { status: 'succeeded', output: step === 'assess' ? complete : { blocking: false } };
    assert.equal(evaluate(complete, {}, { [step]: state }).outcome, null);
  }
});
test('r1 #3: review override cannot approve a recorded blocking or missing review', () => {
  const complete = { action: 'complete', open_count: 0, open_findings: [], blocking: false, tasks: [] };
  for (const review of [{ status: 'succeeded', epoch: 1, output: { blocking: true } }, undefined]) {
    const result = evaluate(complete, { reviewOutput: { blocking: false } }, { review });
    assert.equal(result.outcome, null);
    assert.ok(result.findings.some(f => f.code === 'WAVE_BLOCKING_MISMATCH'));
  }
  assert.equal(evaluate(complete, { reviewOutput: { blocking: true } }).outcome, 'approve');
});
test('r1 #4: admission uses the required execute profile and provider', () => {
  const { tier, ...untiered } = task;
  const options = { executeProfile: { default: 'claude:implementer:fast', tier_from: 'item.tier' }, executeProvider: 'claude' };
  assert.equal(evaluate({ action: 'implement', tasks: [untiered] }, options).outcome, 'revise');
  const mismatch = evaluate({ action: 'implement', tasks: [untiered] }, { ...options, executeProvider: 'codex' });
  assert.equal(mismatch.outcome, null); assert.ok(mismatch.findings.some(f => f.code === 'PIPELINE_PROFILE_INVALID'));
  assert.equal(evaluate({ action: 'implement', tasks: [{ ...untiered, tier: null }] },
    { ...options, executeProfile: { default: 'claude:implementer:fast' } }).outcome, 'revise');
  for (const field of ['executeProfile', 'executeProvider']) for (const missing of [undefined, null, '']) {
    const result = evaluate({}, { ...options, [field]: missing });
    assert.equal(result.outcome, null); assert.equal(result.reason, 'GATE_CONFIG_INVALID');
  }
});
test('ceiling boundary allows equality; breach holds with spent/ceiling', () => {
  assert.equal(evaluate({}, { ceiling: { spent: 150, ceiling: 150 } }).outcome, 'revise');
  const held = evaluate({}, { ceiling: { spent: 151, ceiling: 150 } });
  assert.equal(held.outcome, null); assert.deepEqual(held.breach, { spent: 151, ceiling: 150 });
});
test('unknown action, stale source/token, absent source, and overlapping mappings hold', () => {
  assert.equal(evaluate({ action: 'invented' }).reason, 'GATE_ACTION_UNKNOWN');
  assert.equal(evaluate({}, { gateToken: 'old' }).reason, 'GATE_SOURCE_STALE');
  assert.equal(evaluate({}, {}, { gate: { status: 'waiting_gate', epoch: 2 } }).reason, 'GATE_SOURCE_STALE');
  assert.equal(evaluate({}, {}, { assess: undefined }).reason, 'GATE_SOURCE_MISSING');
  assert.equal(decideGateFromOutput({ decide_from: { ...config.decide_from, kill: ['complete'] } }, {}).reason, 'GATE_CONFIG_INVALID');
});
