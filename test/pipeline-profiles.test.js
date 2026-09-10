import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizePipelineProfiles, mergeRuntimeProfiles, resolveConsumerProfile, validateWaveAdmission,
  profilesDigest, preflightPipelineProfiles, PipelineProfileError } from '../lib/pipeline-profiles.js';
const spec = { flows: { main: { steps: [
  { id: 'plan', agent: 'claude' },
  { id: 'execute', after: ['plan'], fanout: { dispatch: 'consumer', isolation: 'worktree', steps: [{ agent: 'codex' }] } },
  { id: 'merge', after: ['execute'], gate: {} }, { id: 'review', after: ['merge'], agent: 'codex' },
  { id: 'assess', after: ['review'], agent: 'claude' }, { id: 'assess_gate', after: ['assess'], gate: {} },
] } } };
const entry = { default: 'codex:implementer:critical', tier_from: 'item.tier' };
const gate = { decide_from: { step: 'assess', field: 'action', approve: ['complete'], revise: ['repair', 'implement'], kill: ['blocked'] },
  validators: [{ name: 'WaveDecision', review_step: 'review', tasks_field: 'tasks' }] };
for (const file of readdirSync(resolve('presets')).filter(f => f.endsWith('.profiles.json'))) {
  test(`bundled sidecar ${file} normalizes unchanged`, () => {
    const raw = JSON.parse(readFileSync(resolve('presets', file), 'utf8'));
    const yaml = readFileSync(resolve('presets', file.replace('.profiles.json', '.stratum.yaml')), 'utf8');
    assert.deepEqual(normalizePipelineProfiles(raw, yaml), raw);
  });
}
test('normalizes independent seams, retains inert metadata and hashes canonically', () => {
  const raw = { execute: entry, assess_gate: gate, _comment: 'kept', _reduceSteps: ['review'], _unknown: { inert: true },
    _consumer: { execute: { ownership: 'item.files_owned', independent: true, checkpoint_gate: 'merge' } },
    _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['assess_gate'] } };
  assert.deepEqual(normalizePipelineProfiles(raw, spec), raw);
  assert.equal(profilesDigest(raw), profilesDigest(Object.fromEntries(Object.entries(raw).reverse())));
  assert.notEqual(profilesDigest(raw), profilesDigest({ ...raw, execute: 'codex' }));
});
test('runtime default replacement preserves tier_from and enforces stage provider on preflight', () => {
  const merged = mergeRuntimeProfiles({ execute: entry }, { execute: 'codex:implementer:fast' });
  assert.equal(merged.execute.tier_from, 'item.tier');
  assert.equal(preflightPipelineProfiles(merged, spec).resolved.execute.tier, 'fast');
  assert.throws(() => preflightPipelineProfiles({ execute: entry }, spec, { execute: 'claude:implementer:fast' }));
});
test('item routing fixes provider/template, resolves exact models and effort, default when absent', () => {
  const models = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.3-codex-spark'];
  ['critical', 'standard', 'fast'].forEach((tier, i) => {
    const result = resolveConsumerProfile(entry, { tier, provider: 'claude', template: 'orchestrator' }, 'codex');
    assert.equal(result.modelID, models[i]); assert.equal(result.template, 'implementer');
    assert.equal(result.effort, tier === 'fast' ? 'medium' : 'high');
  });
  assert.equal(resolveConsumerProfile(entry, {}, 'codex').tier, 'critical');
  assert.equal(resolveConsumerProfile('claude:orchestrator', {}).modelID, null);
});
for (const tier of [null, '', 3, 'coordinator', 'unknown', undefined]) test(`invalid supplied tier ${String(tier)} is typed`, () => {
  assert.throws(() => resolveConsumerProfile(entry, { tier }), e => e instanceof PipelineProfileError && e.code === 'WAVE_TIER_INVALID');
});
test('whole recorded list rejects the sixth item; admission never truncates to concurrency', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `T${i}`, tier: i === 5 ? 'nope' : 'fast', files_owned: [`${i}.txt`], depends_on: [] }));
  const result = validateWaveAdmission(entry, items, { provider: 'codex', ownership: true, independent: true, concurrency: 3 });
  assert.equal(result.ok, false); assert.equal(result.findings[0].itemIndex, 5);
});
for (const file of ['../out', '/out', 'C:\\out', 'lib/*.js', '.git/config', 'lib/../out', '']) test(`reject ownership path ${file}`, () => {
  assert.equal(validateWaveAdmission(entry, [{ files_owned: [file] }], { ownership: true }).ok, false);
});
test('ownership is literal, overlapping paths and dependencies reject the wave', () => {
  const result = validateWaveAdmission(entry, [{ files_owned: ['./lib/a'], depends_on: [] }, { files_owned: ['lib/a'], depends_on: ['T1'] }], { independent: true });
  assert.deepEqual(result.findings.map(f => f.code).sort(), ['WAVE_DEPENDENCIES_NOT_EMPTY', 'WAVE_OWNERSHIP_CONFLICT']);
  assert.equal(validateWaveAdmission(entry, [{}], { ownership: true }).ok, false);
});
const invalid = [
  { execute: { ...entry, typo: true } }, { plan: { default: 'claude', tier_from: 'item.tier' } }, { absent: 'claude' },
  { execute: [] }, { execute: null }, { execute: { ...entry, decide_from: gate.decide_from } },
  { assess_gate: { decide_from: { ...gate.decide_from, kill: ['complete'] } } },
  { assess_gate: { ...gate, validators: [{ name: 'Unknown', review_step: 'review' }] } },
  { assess_gate: { decide_from: { ...gate.decide_from, field: '__proto__.action' } } },
  { assess_gate: { decide_from: { ...gate.decide_from, step: 'absent' } } },
  { _consumer: { execute: { checkpoint_gate: 'assess_gate' } } },
  { _costCeiling: { input: 'usd', default: -1, gates: ['assess_gate'] } },
];
invalid.forEach((raw, i) => test(`preflight rejects invalid sidecar ${i}`, () => assert.throws(() => normalizePipelineProfiles(raw, spec))));
test('preflight checks unprofiled stage defaults and rejects malformed runtime objects', () => {
  const invalidSpec = structuredClone(spec); invalidSpec.flows.main.steps[0].agent = 'claude::bogus';
  assert.throws(() => preflightPipelineProfiles({}, invalidSpec));
  assert.throws(() => mergeRuntimeProfiles({ execute: entry }, { execute: { default: 'codex', typo: true } }));
  assert.equal(preflightPipelineProfiles({}, spec).resolved.execute.provider, 'codex');
});
