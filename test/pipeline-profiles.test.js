/** Sidecar validation, static precedence, routing policy projection and off digest identity. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { normalizePipelineProfiles, mergeRuntimeProfiles, resolveConsumerProfile, validateWaveAdmission,
  profilesDigest, preflightPipelineProfiles, routingProfileProjection, PipelineProfileError } from '../lib/pipeline-profiles.js';
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
  const models = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
  ['critical', 'standard', 'fast'].forEach((tier, i) => {
    const result = resolveConsumerProfile(entry, { tier, provider: 'claude', template: 'orchestrator' }, 'codex');
    assert.equal(result.modelID, models[i]); assert.equal(result.template, 'implementer');
    assert.equal(result.effort, tier === 'critical' ? 'high' : 'medium');
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

test('routing policy validates closed shapes, refuses runtime policy overrides and gate routes', () => {
  const raw = { execute: { ...entry, route: { learn: true } }, _routing: { mode: 'shadow' } };
  assert.deepEqual(normalizePipelineProfiles(raw, spec), raw);
  for (const route of [null, [], {}, { learn: 1 }, { learn: true, extra: false }]) assert.throws(() => normalizePipelineProfiles({ execute: { ...entry, route } }, spec));
  assert.throws(() => normalizePipelineProfiles({ assess_gate: { ...gate, route: { learn: true } } }, spec));
  for (const metadata of [null, [], {}, { mode: 'off' }, { mode: 'shadow', extra: 1 }]) assert.throws(() => normalizePipelineProfiles({ _routing: metadata }, spec));
  assert.throws(() => mergeRuntimeProfiles(raw, { execute: { ...entry, route: { learn: true } } }), { code: 'ROUTING_POLICY_OVERRIDE' });
});
test('off projection pins bundled 0.5.1 digest and preserves legacy object representation', () => {
  // The shipped preset carries routing fields (plan/execute `route`, `_routing`); the 0.5.1 legacy
  // shape is derived from it here, never the other way round.
  const wrapped = JSON.parse(readFileSync('presets/team-fable-astra.profiles.json', 'utf8'));
  const yaml = readFileSync('presets/team-fable-astra.stratum.yaml', 'utf8');
  assert.deepEqual(wrapped.plan.route, { learn: true }); assert.deepEqual(wrapped.execute.route, { learn: true });
  assert.deepEqual(wrapped._routing, { mode: 'shadow' });
  const { _routing, ...rest } = wrapped;
  const { route: planRoute, ...planRest } = rest.plan;
  const { route: executeRoute, ...executeRest } = rest.execute;
  const raw = { ...rest, plan: Object.keys(planRest).length === 1 ? planRest.default : planRest, execute: executeRest };
  const expected = '0a7792f6228420b553b6852f89b3d3f45a32cbf11e524a271bca49f9f45e5843';
  assert.equal(preflightPipelineProfiles(raw, yaml).profilesDigest, expected);
  const result = preflightPipelineProfiles(wrapped, yaml, {}, { mode: 'off' });
  assert.equal(result.profilesDigest, expected); assert.deepEqual(result.normalized, raw);
  assert.deepEqual(preflightPipelineProfiles({ plan: { default: 'claude' } }, spec).normalized.plan, { default: 'claude' });
  assert.equal(Object.keys(result).includes('routingPolicy'), false);
  assert.equal(result.routingPolicy.mode, 'off');
});
test('provenance retains original prior, equal-valued explicit override and item-tier fallback semantics', () => {
  const raw = { execute: { ...entry, route: { learn: true } } };
  const result = preflightPipelineProfiles(raw, spec, { execute: 'codex:implementer:fast' });
  const p = result.staticProvenance.execute;
  assert.equal(p.prior, 'critical'); assert.equal(p.source, 'manual'); assert.equal(p.manualFallback.supplied, true);
  assert.equal(result.resolved.execute.tier, 'fast');
  assert.equal(resolveConsumerProfile(result.normalized.execute, { tier: 'critical' }).tier, 'critical');
  assert.equal(p.itemTier.source, 'preset'); assert.equal(p.itemTier.via, 'item.tier');
  assert.equal(preflightPipelineProfiles(raw, spec, { execute: entry.default }).staticProvenance.execute.source, 'manual');
  const role = preflightPipelineProfiles(raw, spec, { execute: entry.default }, { runtimeOrigins: { execute: { supplied: false, origin: 'default-role', recordedRole: entry.default } } });
  assert.equal(role.staticProvenance.execute.source, 'preset'); assert.equal(role.staticProvenance.execute.manualFallback.origin, 'default-role');
  assert.equal(result.staticProvenance.plan.source, 'default'); assert.equal(result.staticProvenance.plan.prior, null);
});
test('manual override without a sidecar retains the original literal spec prior', () => {
  const plain = { flows: { main: { steps: [{ id: 'work', agent: 'codex' }] } } };
  const p = preflightPipelineProfiles({}, plain, { work: 'codex::critical' });
  assert.equal(p.staticProvenance.work.prior, null); assert.equal(p.staticProvenance.work.source, 'manual');
  assert.equal(p.resolved.work.tier, 'critical');
});

test('off preflight preserves inert underscore metadata and equals HEAD output and digest', async () => {
  const raw = { plan: 'claude', execute: entry,
    _comment: { default: 'label', route: { learn: true } },
    _unknown: { route: 'some metadata', inert: true } };
  const original = structuredClone(raw);
  assert.deepEqual(routingProfileProjection(raw, { mode: 'off' }).staticProfiles, raw);
  // Read the real legacy implementation without creating or regenerating a baseline fixture.
  let source = execFileSync('git', ['show', 'HEAD:lib/pipeline-profiles.js'], { encoding: 'utf8' });
  source = source.replace("from 'yaml'", `from '${import.meta.resolve('yaml')}'`)
    .replace("from './agent-string.js'", `from '${pathToFileURL(resolve('lib/agent-string.js')).href}'`);
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const expected = legacy.preflightPipelineProfiles(raw, spec);
  const actual = preflightPipelineProfiles(raw, spec, {}, { mode: 'off' });
  assert.deepEqual(actual.normalized._comment, original._comment);
  assert.deepEqual(actual.normalized._unknown, original._unknown);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(actual.profilesDigest, expected.profilesDigest);
  assert.deepEqual(raw, original);
});
