import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildWaveFixture, task, waveSpec } from './helpers/build-wave-fixture.js';
import { resolveConsumerProfile } from '../lib/pipeline-profiles.js';
process.env.NODE_ENV = 'test';

for (const source of ['carry', 'plan']) test(`fresh audit item epochs admit the full ${source} wave without a parent epoch`, async t => {
  const tasks = [task(1), task(2)];
  const spec = waveSpec();
  if (source === 'carry') spec.flows.bug_fix.steps[1].fanout.over = '${wave}';
  const f = buildWaveFixture(t, { spec, tasks });
  delete f.state.steps.execute.epoch;
  delete f.state.steps.plan.epoch;
  f.state.steps.execute.fanout.items.forEach((item, index) => Object.assign(item, { index, epoch: 0 }));
  if (source === 'carry') f.state.carry = { wave: { value: tasks, provenance: { kind: 'initial', sourceStep: 'plan', sourceEpoch: 0 } } };
  await f.run();
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 2);
  assert.equal(f.journal().waveAdmissions[0].epoch, 0);
});

for (const defect of ['missing epoch', 'pending epoch', 'parent epoch', 'descriptor epoch', 'index', 'generation', 'length']) {
  test(`admission rejects inconsistent ${defect} evidence before any worker`, async t => {
    const tasks = Array.from({ length: ['descriptor epoch', 'generation'].includes(defect) ? 3 : 4 }, (_, i) => task(i + 1));
    const spec = waveSpec();
    spec.flows.bug_fix.steps[1].fanout.over = '${wave}';
    const f = buildWaveFixture(t, { tasks, spec });
    const state = f.state.steps.execute;
    delete state.epoch;
    state.fanout.items.forEach((item, index) => Object.assign(item, { index, epoch: 0 }));
    f.state.carry = { wave: { value: tasks } };
    if (defect === 'missing epoch') state.fanout.items.forEach(item => delete item.epoch);
    if (defect === 'pending epoch') state.fanout.items[3].epoch = 1;
    if (defect === 'parent epoch') state.epoch = 1;
    if (defect === 'descriptor epoch') f.descriptors[0].epoch = 1;
    if (defect === 'index') state.fanout.items[3].index = 2;
    if (defect === 'generation') state.fanout.items[0].generation = 99;
    if (defect === 'length') f.state.carry.wave.value = tasks.slice(0, 3);
    await f.run();
    assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 0);
    assert.ok(f.stratum.calls.filter(c => c.type === 'stepDone').every(c => /^WAVE_INPUT_INVALID:/.test(c.envelope.failure)));
    assert.equal(f.state.status, 'failed');
  });
}

test('legacy builds retain baseline audit counts for consumer admission and plan gates', async t => {
  // Measured with the reviewer's 9e1fa25 baseline loader: consumer=5, plan gate=2.
  for (const [gate, expectedAudits] of [[false, 5], [true, 2]]) {
    const spec = waveSpec();
    spec.flows.bug_fix.steps.at(-1).id = 'plan_gate';
    const f = buildWaveFixture(t, { gate, spec, profiles: { execute: 'codex:implementer:standard' } });
    if (gate) {
      f.state.steps.plan_gate = f.state.steps.assess_gate;
      delete f.state.steps.assess_gate;
      f.persist();
    }
    await f.run();
    assert.equal(f.state.status, 'completed');
    assert.equal(f.stratum.calls.filter(c => c.type === 'gateResolve').length, 1);
    assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, gate ? 0 : 1);
    assert.equal(f.stratum.calls.filter(c => c.type === 'audit').length, expectedAudits);
  }
});
test('sixth invalid tier rejects the entire wave before any worker', async t => {
  const tasks = Array.from({ length: 6 }, (_, i) => task(i + 1, i === 5 ? 'invalid' : 'fast'));
  const f = buildWaveFixture(t, { tasks });
  await f.run();
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 0);
  const reports = f.stratum.calls.filter(c => c.type === 'stepDone');
  assert.equal(reports.length, 6);
  for (const report of reports) assert.match(report.envelope.failure, /^WAVE_TIER_INVALID:/);
  assert.equal(f.state.status, 'failed');
});
test('mixed tiers reach the model connector and persist intended vs observed models', async t => {
  const tasks = [task(1), task(2, 'critical'), task(3, 'standard'), task(4, 'fast')];
  const f = buildWaveFixture(t, { tasks });
  await f.run();
  const calls = f.stratum.calls.filter(c => c.type === 'agentRun');
  assert.equal(calls.length, 4);
  const journal = f.journal();
  for (const d of f.descriptors) {
    const expected = resolveConsumerProfile({ default: 'codex:implementer:standard', tier_from: 'item.tier' }, d.item, 'codex');
    assert.equal(journal.dispatchBindings[d.dispatchToken].resolvedProfile.profile, expected.profile);
    const call = calls.find(c => c.args[2].telemetry?.step_id === d.id);
    assert.ok(call, `connector call for ${d.id}`);
    assert.equal(call.args[2].modelID, expected.modelID);
  }
  assert.equal(f.state.receipts.filter(r => r.dispatchId.endsWith(':observed')).length, 4);
});
test('ownership failure replaces success before step_done and prepared replay calls no agent', async t => {
  let crash = true;
  const f = buildWaveFixture(t, { mutate: cwd => writeFileSync(join(cwd, 'unowned.txt'), 'bad\n') });
  await assert.rejects(f.run({ consumerCrashHooks: { afterPreparedBeforeReport() { if (crash) throw new Error('prepared crash'); } } }), /prepared crash/);
  crash = false;
  await f.run({ resume: true });
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 1);
  const reports = f.stratum.calls.filter(c => c.type === 'stepDone');
  assert.equal(reports.length, 1);
  assert.match(reports[0].envelope.failure, /FILES_OWNED_VIOLATION/);
  assert.equal(f.state.receipts.some(r => r.source === 'compose:ownership'), true);
});

for (const source of ['carry', 'input']) test(`admission resolves complete recorded ${source} input using engine reference syntax`, async t => {
  const { waveSpec } = await import('./helpers/build-wave-fixture.js');
  const spec = waveSpec();
  spec.flows.bug_fix.steps[1].fanout.over = source === 'carry' ? '${wave.tasks[0]}' : '${input.waves[0]}';
  const tasks = [task(1, 'fast')];
  const f = buildWaveFixture(t, { spec, tasks });
  if (source === 'carry') f.state.carry = { wave: { value: { tasks: [tasks] }, provenance: { sourceStep: 'assess', sourceEpoch: 0 } } };
  else f.state.input = { waves: [tasks] };
  f.persist();
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  await f.run();
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 1);
  assert.equal(f.journal().waveAdmissions[0].items.length, 1);
});

test('profile edits on a resumed run are refused before another worker', async t => {
  const f = buildWaveFixture(t);
  await assert.rejects(f.run({ consumerCrashHooks: { afterPreparedBeforeReport() { throw new Error('stop before report'); } } }), /stop before report/);
  const path = join(f.cwd, 'pipelines/bug-fix.profiles.json');
  const profiles = JSON.parse(readFileSync(path, 'utf8')); profiles.execute.default = 'codex:implementer:fast';
  writeFileSync(path, JSON.stringify(profiles));
  await assert.rejects(f.run({ resume: true }), error => error.code === 'CONSUMER_PROFILE_REVISION_MISMATCH');
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 1);
});

test('direct runConsumerIssuance validates the whole recorded list, not just its descriptor', async t => {
  const { consumerWaveFixture } = await import('./helpers/consumer-wave-fixture.js');
  const { fakeBuildStratum } = await import('./helpers/build-stratum-fixture.js');
  const { runConsumerIssuance } = await import('../lib/build.js');
  const f = consumerWaveFixture(t);
  const tasks = [task(1, 'fast'), task(2, null)];
  const d = f.descriptor(tasks[0], { flow: 'main', policy: { isolation: 'worktree' } });
  const audit = f.audit(d, 'running');
  audit.steps.plan = { status: 'succeeded', epoch: 0, output: { tasks } };
  audit.steps.execute.fanout.items.push({ status: 'pending', generation: 2 });
  const stratum = fakeBuildStratum({ audit: () => audit, agentRun() { throw new Error('must not run'); } });
  await runConsumerIssuance({ descriptor: d, flowId: 'wave-test', stratum, artifacts: f.artifacts,
    audit, localSpec: { flows: { entry: 'main', main: { steps: [
      { id: 'execute', fanout: { over: '${plan.output.tasks}', steps: [{ agent: 'codex' }] } },
    ] } } }, context: { cwd: f.cwd, pipelineProfiles: { execute: { default: 'codex:implementer:standard', tier_from: 'item.tier' } } },
    progress: { warn() {}, stepDone() {} }, streamWriter: { write() {} } });
  assert.equal(stratum.calls.some(c => c.type === 'agentRun'), false);
  assert.match(stratum.calls.find(c => c.type === 'stepDone').envelope.failure, /^WAVE_TIER_INVALID:/);
});

for (const invalid of [false, true]) test(`routing-only whole-wave Build ${invalid ? 'sixth-item refusal' : 'stage admission and static shadow'}`, async t => {
  const { routingDigest } = await import('../lib/model-router.js');
  const { resolvePlanSpecValues } = await import('../lib/stratum-mcp-client.js');
  const YAML = (await import('yaml')).default;
  const spec = waveSpec();
  Object.assign(spec.flows.bug_fix.input, Object.fromEntries(['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'].map(k => [k, 'string?'])));
  const profiles = { execute: { default: 'codex:implementer:standard', route: { learn: true } } };
  const tasks = Array.from({ length: invalid ? 6 : 2 }, (_, i) => task(i + 1));
  const f = buildWaveFixture(t, { profiles, spec, tasks });
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const plan = f.stratum.plan;
  const digest = routingDigest(resolvePlanSpecValues(spec, { task: 'task' }));
  for (const d of f.descriptors) d.revisionDigest = digest;
  f.state.steps.execute.fanout.items.forEach((item, index) => Object.assign(item, { epoch: 0, index }));
  if (invalid) f.state.steps.execute.fanout.items[5].epoch = 1;
  f.stratum.plan = async (text, flow, input, options) => {
    f.state.spec = resolvePlanSpecValues(YAML.parse(text), input); f.state.revisionDigest = routingDigest(f.state.spec);
    f.state.workspaceRoot = options.workspaceRoot; f.state.input = input;
    // Initial binding precedes all Compose execution. The fixture's plan output is intercepted, not a paid call.
    const sourceToken = f.state.steps.plan.acceptedDispatchToken; delete f.state.steps.plan.acceptedDispatchToken;
    const response = await plan(text, flow, input, options); response.revisionDigest = f.state.revisionDigest;
    f.persist();
    // Publish the source when audit is first requested, after first journal initialization.
    const audit = f.stratum.audit;
    f.stratum.audit = async (...args) => { f.state.steps.plan.acceptedDispatchToken = sourceToken; f.persist(); return audit(...args); };
    return response;
  };
  if (invalid) await assert.rejects(f.run({ route_mode: 'shadow' }), { code: 'WAVE_INPUT_INVALID' });
  else await f.run({ route_mode: 'shadow' });
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, invalid ? 0 : 2);
  const journal = f.journal();
  assert.equal(journal.wave, undefined); assert.equal(journal.waveAdmissions, undefined);
  if (!invalid) {
    const admissions = Object.values(journal.routing.records).filter(r => r.type === 'admission');
    assert.equal(admissions.length, 2); assert.ok(admissions.every(a => a.stage === 0));
    for (const a of admissions) assert.deepEqual(a.would, a.baseline);
    assert.ok(Object.values(journal.dispatchBindings).every(b => b.routing?.recordId));
    const { routingJournalPath } = await import('../lib/consumer-fanout.js');
    const path = routingJournalPath({ runId: f.runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot });
    rmSync(path);
    const calls = f.stratum.calls.filter(c => ['plan', 'agentRun'].includes(c.type)).length;
    await assert.rejects(f.run({ fresh: true, route_mode: 'off' }), { code: 'ROUTING_BINDING_MISSING' });
    assert.equal(f.stratum.calls.filter(c => ['plan', 'agentRun'].includes(c.type)).length, calls);
    assert.equal(existsSync(path), false, 'fresh cleanup must not recreate lost consumer evidence');
  }
});
