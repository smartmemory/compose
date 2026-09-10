import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { startFresh, resumeRouting, admitOrdinaryRoute, prepareRoutingIssuance, launchRoutingIssuance,
  reportRoutingStep, preflightPipelineProfiles, routingOptionsFor, reconcileRoutingIssuances } from '../lib/build.js';
import { routingDigest, canonicalRoutingJson } from '../lib/model-router.js';
import { resolvePlanSpecValues } from '../lib/stratum-mcp-client.js';
import { routingIssuanceState } from '../lib/routing-ledger.js';
const transport = Object.fromEntries(['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'].map(k => [k, 'string?']));
function fixture(t, extra = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'build-route-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Route']); git(['config', 'user.email', 'route@example.test']);
  writeFileSync(join(cwd, 'base'), 'base'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const stateRoot = join(cwd, 'engine'); mkdirSync(stateRoot);
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const dataDir = join(cwd, '.compose/data'); mkdirSync(dataDir, { recursive: true });
  const spec = { version: 1, contracts: { R: { summary: 'string' } }, flows: { entry: 'feature', feature: {
    input: { featureCode: 'string', description: 'string', implementer_agent: 'string?', reviewer_agent: 'string?', ...transport },
    steps: [{ id: 'work', agent: '$.input.implementer_agent', do: 'unchanged prompt', out: 'R' }], output: { from: '${work.output}', contract: 'R' } } } };
  const profiles = { work: { default: 'codex', route: { learn: true } } };
  let snapshot, calls = [], token = 0;
  const persist = () => writeFileSync(join(stateRoot, 'run.json'), JSON.stringify(snapshot));
  const ready = () => ({ status: 'ready', runId: 'run', revisionDigest: snapshot.revisionDigest,
    ready: [{ id: 'work', flow: 'feature', agent: snapshot.spec.flows.feature.steps[0].agent, do: 'unchanged prompt', dispatchToken: snapshot.steps.work.dispatchToken, epoch: snapshot.steps.work.epoch ?? 0 }] });
  const stratum = {
    async plan(text, flow, input, opts) {
      calls.push({ method: 'plan', input: structuredClone(input), opts });
      const effective = resolvePlanSpecValues(YAML.parse(text), input);
      snapshot = { id: 'run', revisionDigest: routingDigest(effective), spec: effective, workspaceRoot: cwd, input,
        steps: { work: { status: 'ready', dispatchToken: `token-${++token}` } } };
      persist(); if (extra.lostAck) throw Error('lost acknowledgement'); return ready();
    },
    async resume() { calls.push({ method: 'resume' }); return ready(); },
    async stepDone(runId, id, envelope, dispatchToken) {
      calls.push({ method: 'stepDone', id, envelope, dispatchToken });
      Object.assign(snapshot.steps.work, { status: 'succeeded', acceptedDispatchToken: dispatchToken }); delete snapshot.steps.work.dispatchToken;
      persist(); return { status: 'completed', runId };
    },
  };
  const start = (mode = 'shadow', roles = { implementerAgent: 'codex::critical', reviewerAgent: 'claude' }) => startFresh(stratum, YAML.stringify(spec), 'ROUTE', 'description', dataDir,
    'feature', 'feature', undefined, roles, cwd, { mode, profiles, artifactRoot: `${cwd}-artifacts` });
  t.after(() => rmSync(`${cwd}-artifacts`, { recursive: true, force: true }));
  return { cwd, git, spec, profiles, stratum, start, calls, persist, ready, get snapshot() { return snapshot; } };
}
test('fresh ordinary-only binding carries sealed start/root; recorded roles survive resume', async t => {
  const f = fixture(t); const response = await f.start(); const routing = response.routing;
  assert.equal(f.calls[0].input.routing_root, routing.start.rootDigest);
  assert.equal(f.calls[0].input.routing_start, canonicalRoutingJson(routing.start));
  assert.equal(routing.artifacts.journal.routing.runBinding.runId, 'run');
  const resumed = await resumeRouting({ runId: 'run', cwd: f.cwd, localSpec: f.spec, profiles: f.profiles, stratum: f.stratum, artifactRoot: `${f.cwd}-artifacts` });
  assert.equal(resumed.start.originalInput.implementer_agent, 'codex::critical');
  assert.equal(resumed.start.rootDigest, routing.start.rootDigest);
});
test('ordinary retry reuses admission; new epoch appends identity and exact events replay', async t => {
  const f = fixture(t); const response = await f.start();
  const context = { routing: response.routing, stratum: f.stratum, flowId: 'run' };
  const issue = async () => {
    const descriptor = f.ready().ready[0];
    const admission = admitOrdinaryRoute({ descriptor, localSpec: f.spec, context });
    const issuance = prepareRoutingIssuance({ descriptor, admission, context });
    await launchRoutingIssuance(context, issuance);
    await reportRoutingStep(context, descriptor, issuance, { output: { summary: 'done' } });
    return { admission, issuance };
  };
  const first = await issue();
  Object.assign(f.snapshot.steps.work, { status: 'ready', dispatchToken: 'retry' }); f.persist();
  const retry = await issue(); assert.deepEqual(retry.admission, first.admission); assert.equal(retry.issuance.priorRecordId, first.issuance.id);
  Object.assign(f.snapshot.steps.work, { status: 'ready', epoch: 1, dispatchToken: 'epoch1' }); f.persist();
  const revised = await issue(); assert.notEqual(revised.admission.id, first.admission.id); assert.equal(revised.admission.logicalEpoch, 1);
  const records = context.routing.artifacts.exportRoutingJournal();
  assert.equal(routingIssuanceState(records, first.issuance.id).state, 'settled');
  assert.deepEqual(first.admission.would, first.admission.baseline);
  assert.equal(Object.values(records.records).filter(r => r.type === 'admission').length, 2);
});
for (const defect of ['root missing', 'root drift', 'binding missing', 'journal missing', 'sidecar drift', 'spec drift']) test(`${defect} refuses before calls`, async t => {
  const f = fixture(t); const { routing } = await f.start(); const calls = f.calls.length;
  const dir = join(f.cwd, '.compose/routing/starts', routing.start.startId);
  if (defect === 'root missing') rmSync(join(dir, 'routing-start.json'));
  if (defect === 'root drift') writeFileSync(join(dir, 'routing-start.json'), '{}');
  if (defect === 'binding missing') rmSync(join(dir, 'records', `${routing.binding.id}.json`));
  if (defect === 'journal missing') rmSync(routing.artifacts.journalPath);
  if (defect === 'sidecar drift') f.profiles.work.default = 'claude';
  if (defect === 'spec drift') f.spec.flows.feature.steps[0].do = 'changed';
  await assert.rejects(resumeRouting({ runId: 'run', cwd: f.cwd, localSpec: f.spec, profiles: f.profiles, stratum: f.stratum, artifactRoot: `${f.cwd}-artifacts` }), e => /^ROUTING_/.test(e.code));
  assert.equal(f.calls.length, calls);
});
test('lost plan acknowledgement recovers the single recorded plan without another plan call', async t => {
  const f = fixture(t, { lostAck: true }); const result = await f.start();
  assert.equal(result.routing.binding.runId, 'run'); assert.equal(f.calls.filter(c => c.method === 'plan').length, 1);
});
test('unresolved launch refuses resume; exact prepared result resends only stepDone', async t => {
  const f = fixture(t); const response = await f.start(); const context = { routing: response.routing, stratum: f.stratum, flowId: 'run' };
  const descriptor = f.ready().ready[0]; const admission = admitOrdinaryRoute({ descriptor, localSpec: f.spec, context });
  const issuance = prepareRoutingIssuance({ descriptor, admission, context }); await launchRoutingIssuance(context, issuance);
  await assert.rejects(reconcileRoutingIssuances({ context }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  const { routingEvent } = await import('../lib/build.js'); routingEvent(context, issuance, 'result-prepared', { envelope: { output: { summary: 'retained' } } });
  await reconcileRoutingIssuances({ context }); assert.equal(f.calls.filter(c => c.method === 'stepDone').length, 1);
});
test('bundled off digest and synthetic Build input keys remain stable without routing storage', async t => {
  for (const [name, path] of [['bundled-build', 'presets/team-fable-astra'], ['carry', null]]) {
    const frozen = JSON.parse(readFileSync(`test/fixtures/model-route-off-${name}-v0.5.1.json`));
    if (path) {
      const check = preflightPipelineProfiles(JSON.parse(readFileSync(`${path}.profiles.json`)), readFileSync(`${path}.stratum.yaml`, 'utf8'), path, undefined, { mode: 'off' });
      assert.equal(check.profilesDigest, '310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205');
    }
    assert.equal(frozen.captured, true);
  }
  const f = fixture(t); await f.start('off');
  assert.deepEqual(Object.keys(f.calls[0].input), ['featureCode', 'description', 'implementer_agent', 'reviewer_agent']);
  assert.equal(existsSync(join(f.cwd, '.compose/routing')), false);
  assert.doesNotMatch(readFileSync(join(f.cwd, '.git/info/exclude'), 'utf8'), /compose\/routing/);
});
for (const opts of [{ route_mode: 'active' }, { route_trials: ['x'] }, { route_explore: 0.1 }, { calibration_feedback: true }]) {
  test(`S1a refuses ${JSON.stringify(opts)}`, () => assert.throws(() => routingOptionsFor({}, opts), { code: 'ROUTING_SLICE_UNAVAILABLE' }));
}

test('carry preflight digest and bundled startFresh input match frozen values', async t => {
  const { PROFILES, WAVE_GOLDEN_SPEC } = await import('./helpers/build-wave-golden-fixture.js');
  const carry = JSON.parse(readFileSync('test/fixtures/model-route-off-carry-v0.5.1.json'));
  assert.equal(preflightPipelineProfiles(PROFILES, WAVE_GOLDEN_SPEC, 'carry', undefined, { mode: 'off' }).profilesDigest, carry.profileDigest);
  const bundled = JSON.parse(readFileSync('test/fixtures/model-route-off-bundled-build-v0.5.1.json'));
  const expected = bundled.events.find(e => e.kind === 'plan');
  const f = fixture(t);
  let input;
  await startFresh({ plan: async (_spec, _flow, values) => { input = values; return { runId: 'off' }; } },
    readFileSync('presets/team-fable-astra.stratum.yaml', 'utf8'), expected.input.featureCode, expected.input.description,
    join(f.cwd, '.compose/data'), 'team-fable-astra', 'feature', undefined, undefined, f.cwd, { mode: 'off' });
  assert.deepEqual(input, expected.input); assert.equal(existsSync(join(f.cwd, '.compose/routing')), false);
});
test('routing storage stays outside git snapshots, cleanup, staged diff and ship tree', async t => {
  const f = fixture(t); const { routing } = await f.start();
  const rootPath = join(f.cwd, '.compose/routing/starts', routing.start.startId, 'routing-start.json');
  const before = readFileSync(rootPath, 'utf8');
  assert.doesNotMatch(f.git(['status', '--porcelain', '--untracked-files=all']), /\.compose\/routing/);
  f.git(['add', '-A']); assert.doesNotMatch(f.git(['diff', '--cached', '--name-only']), /\.compose\/routing/);
  f.git(['clean', '-fd']); assert.equal(readFileSync(rootPath, 'utf8'), before);
  f.git(['commit', '-qm', 'ship fixture']); assert.doesNotMatch(f.git(['ls-tree', '-r', '--name-only', 'HEAD']), /\.compose\/routing/);
  assert.equal(readFileSync(rootPath, 'utf8'), before);
});
test('bound plan interrupted before first dispatch is recovered with the same start and no second plan', async t => {
  const f = fixture(t); const first = await f.start(); const second = await f.start();
  assert.equal(f.calls.filter(c => c.method === 'plan').length, 1); assert.equal(second.routing.start.rootDigest, first.routing.start.rootDigest);
});

test('public Build ordinary shadow preserves exact prompt/model/effort/tool/sandbox bytes and call count', async t => {
  const { buildWaveFixture, waveSpec } = await import('./helpers/build-wave-fixture.js');
  const { agentResult } = await import('./helpers/build-stratum-fixture.js');
  const spec = waveSpec(); Object.assign(spec.flows.bug_fix.input, transport);
  spec.flows.bug_fix.steps = [{ id: 'work', agent: 'codex', do: 'Return a complete result.', out: 'R' }];
  spec.flows.bug_fix.output = { from: '${work.output}', contract: 'R' };
  const profiles = { work: { default: 'codex:read-only-reviewer:critical', route: { learn: true } } };
  const f = buildWaveFixture(t, { spec, profiles });
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const calls = []; let number = 0, id;
  const persist = () => writeFileSync(join(f.stateRoot, `${id}.json`), JSON.stringify(f.state));
  f.stratum.plan = async (yaml, flow, input, options) => {
    id = `ordinary-${++number}`;
    Object.assign(f.state, { id, spec: YAML.parse(yaml), revisionDigest: routingDigest(YAML.parse(yaml)), input,
      workspaceRoot: options.workspaceRoot, status: 'running', steps: { work: { status: 'ready', dispatchToken: `${id}-token` } } });
    persist(); return { status: 'ready', runId: id, revisionDigest: f.state.revisionDigest,
      ready: [{ id: 'work', agent: 'codex', do: 'Return a complete result.', epoch: 0, dispatchToken: `${id}-token` }] };
  };
  f.stratum.agentRun = async (provider, prompt, opts) => {
    calls.push({ provider, prompt, modelID: opts.modelID, effort: opts.effort, allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools, sandboxMode: opts.sandboxMode, cwd: opts.cwd });
    return agentResult({ outcome: 'complete', summary: 'done' }, `call-${number}`);
  };
  f.stratum.stepDone = async (_id, step, envelope, token) => {
    Object.assign(f.state.steps.work, { status: 'succeeded', acceptedDispatchToken: token, output: envelope.output });
    delete f.state.steps.work.dispatchToken; f.state.status = 'completed'; persist(); return { status: 'completed', runId: id };
  };
  f.stratum.audit = async () => ({ ...structuredClone(f.state), runId: id });
  await f.run({ route_mode: 'off' }); assert.equal(calls.length, 1);
  await f.run({ route_mode: 'shadow', fresh: true }); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  const { ConsumerFanoutArtifacts } = await import('../lib/consumer-fanout.js');
  const journal = new ConsumerFanoutArtifacts({ runId: id, targetCwd: f.cwd, artifactRoot: f.artifactRoot }).journal;
  assert.equal(Object.values(journal.routing.records).filter(r => r.type === 'admission').length, 1);
  assert.equal(Object.values(journal.routing.records).filter(r => r.type === 'issuance-event' && r.event === 'settled').length, 1);
});

for (const kind of ['zero', 'multiple', 'unreadable']) test(`lost acknowledgement with ${kind} matches refuses another plan`, async t => {
  const f = fixture(t); const plan = f.stratum.plan;
  f.stratum.plan = async (...args) => {
    await plan(...args);
    const stateRoot = process.env.STRATUM_STATE_ROOT;
    if (kind === 'zero') rmSync(join(stateRoot, 'run.json'));
    if (kind === 'multiple') writeFileSync(join(stateRoot, 'second.json'), JSON.stringify({ ...f.snapshot, id: 'second' }));
    if (kind === 'unreadable') writeFileSync(join(stateRoot, 'unknown.json'), '{');
    throw Error('acknowledgement lost');
  };
  await assert.rejects(f.start(), { code: 'ROUTING_PLAN_UNCERTAIN' });
  await assert.rejects(f.start(), { code: 'ROUTING_PLAN_UNCERTAIN' });
  assert.equal(f.calls.filter(c => c.method === 'plan').length, 1);
});
test('scoped ordinary admission resolves the child flow and fences its recorded input', async t => {
  const f = fixture(t);
  f.spec.flows.feature.steps = [{ id: 'child', run: 'sub', input: {} }];
  f.spec.flows.feature.output.from = '${child.output}';
  f.spec.flows.sub = { input: {}, steps: [{ id: 'work', agent: 'codex', do: 'child', out: 'R' }], output: { from: '${work.output}', contract: 'R' } };
  const { routing } = await f.start();
  f.snapshot.steps = { child: { status: 'running', sub: { input: {}, steps: { work: { status: 'ready', dispatchToken: 'child-token' } } } } }; f.persist();
  const descriptor = { id: 'child/work', agent: 'codex', dispatchToken: 'child-token', epoch: 0, do: 'child' };
  const admission = admitOrdinaryRoute({ descriptor, localSpec: f.spec, context: { routing } });
  assert.equal(admission.scopedStep, 'child/work'); assert.equal(admission.baseline.resolution.provider, 'codex');
  f.snapshot.steps.child.sub.input.changed = true; f.persist();
  assert.throws(() => admitOrdinaryRoute({ descriptor, localSpec: f.spec, context: { routing } }), { code: 'ROUTING_BINDING_DRIFT' });
});

test('routing-only generic isolation:none admission needs no task id, tier, ownership or Git HEAD', async t => {
  const { planWithRouting, admitConsumerWave } = await import('../lib/build.js');
  const cwd = mkdtempSync(join(tmpdir(), 'route-unborn-')); const stateRoot = `${cwd}-state`, artifactRoot = `${cwd}-artifacts`;
  t.after(() => { for (const path of [cwd, stateRoot, artifactRoot]) rmSync(path, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd }); mkdirSync(stateRoot);
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const spec = { version: 1, flows: { entry: 'f', f: { input: { items: 'object[]', ...transport }, steps: [{ id: 'scan', fanout: {
    dispatch: 'consumer', over: '${input.items}', isolation: 'none', steps: [{ agent: 'codex', do: 'inspect' }] } }] } } };
  let snapshot, descriptor;
  const stratum = { async plan(_text, _flow, input) {
    snapshot = { id: 'unborn', spec, revisionDigest: routingDigest(spec), input, workspaceRoot: cwd,
      steps: { scan: { status: 'running', fanout: { items: [{ status: 'ready', epoch: 0, index: 0, generation: 1, dispatchToken: 'scan-token' }] } } } };
    writeFileSync(join(stateRoot, 'unborn.json'), JSON.stringify(snapshot));
    descriptor = { id: 'scan/0', step: 'scan', flow: 'f', item: input.items[0], itemIndex: 0, stage: 0, generation: 1, epoch: 0,
      dispatchToken: 'scan-token', policy: { isolation: 'none' }, revisionDigest: snapshot.revisionDigest, agent: 'codex', do: 'inspect' };
    return { runId: 'unborn', revisionDigest: snapshot.revisionDigest, status: 'ready', ready: [descriptor] };
  } };
  const { routing } = await planWithRouting({ stratum, specYaml: YAML.stringify(spec), flowName: 'f', input: { items: [{ label: 'untyped observation' }] },
    cwd, featureCode: 'UNBORN', options: { mode: 'shadow' }, artifactRoot });
  const admitted = await admitConsumerWave({ descriptor, audit: snapshot, localSpec: spec, artifacts: routing.artifacts,
    stratum, flowId: 'unborn', routing });
  assert.equal(admitted.routingOnly, true); assert.equal(routing.artifacts.journal.waveAdmissions, undefined);
  assert.ok(admitted.bindings['scan-token'].routing.logicalTaskId); assert.equal(routing.artifacts.journal.worktrees.length, 0);
});

test('public Build resume restores recorded roles before preflight and ignores new role flags', async t => {
  const oldProbe = process.env.COMPOSE_SKIP_CODEX_PROBE; process.env.COMPOSE_SKIP_CODEX_PROBE = '1';
  t.after(() => { if (oldProbe === undefined) delete process.env.COMPOSE_SKIP_CODEX_PROBE; else process.env.COMPOSE_SKIP_CODEX_PROBE = oldProbe; });
  const { buildWaveFixture } = await import('./helpers/build-wave-fixture.js');
  const { agentResult } = await import('./helpers/build-stratum-fixture.js');
  const spec = { version: 1, contracts: { R: { outcome: 'string', summary: 'string' } }, flows: { entry: 'feature', feature: {
    input: { featureCode: 'string', description: 'string', implementer_agent: 'string', reviewer_agent: 'string', ...transport },
    steps: [{ id: 'work', agent: '$.input.implementer_agent', do: 'recorded role work', out: 'R' }], output: { from: '${work.output}', contract: 'R' } } } };
  const f = buildWaveFixture(t, { spec, profiles: { work: { default: 'codex', route: { learn: true } } } });
  mkdirSync(join(f.cwd, 'docs/features', f.code), { recursive: true }); writeFileSync(join(f.cwd, 'docs/features', f.code, 'description.md'), '# Role\n');
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const persist = () => writeFileSync(join(f.stateRoot, `${f.runId}.json`), JSON.stringify(f.state));
  const calls = []; let plans = 0, crash = true;
  const ready = () => ({ status: 'ready', runId: f.runId, revisionDigest: f.state.revisionDigest,
    ready: [{ id: 'work', agent: 'codex', do: 'recorded role work', epoch: 0, dispatchToken: 'role-token' }] });
  f.stratum.plan = async (text, flow, input, options) => {
    plans++;
    const effective = resolvePlanSpecValues(YAML.parse(text), input);
    Object.assign(f.state, { id: f.runId, spec: effective, revisionDigest: routingDigest(effective), input, workspaceRoot: options.workspaceRoot,
      status: 'running', steps: { work: { status: 'ready', dispatchToken: 'role-token' } } }); persist();
    return { status: 'running', runId: f.runId, revisionDigest: f.state.revisionDigest };
  };
  f.stratum.audit = async () => { if (crash) throw Error('stop before pump'); return { ...structuredClone(f.state), runId: f.runId }; };
  f.stratum.resume = async () => ready();
  f.stratum.agentRun = async (provider, prompt, opts) => { calls.push({ provider, model: opts.modelID }); return agentResult({ outcome: 'complete', summary: 'done' }, 'role-call'); };
  f.stratum.stepDone = async (_run, _id, envelope, token) => {
    f.state.status = 'completed'; Object.assign(f.state.steps.work, { status: 'succeeded', acceptedDispatchToken: token, output: envelope.output });
    delete f.state.steps.work.dispatchToken; persist(); return { status: 'completed', runId: f.runId };
  };
  await assert.rejects(f.run({ mode: 'feature', implementer: 'codex::critical', reviewer: 'claude', route_mode: 'shadow' }), /stop before pump/);
  assert.equal(calls.length, 0); crash = false;
  await f.run({ mode: 'feature', resumeFlowId: f.runId, route_mode: 'off', implementer: 'invalid-new-flag', reviewer: 'also-invalid' });
  assert.equal(plans, 1); assert.deepEqual(calls, [{ provider: 'codex', model: 'gpt-6-astra' }]);
});

test('replayed frozen bundled/carry prompts retain supplied bytes and six static connector option fields', async () => {
  const { PROFILES } = await import('./helpers/build-wave-golden-fixture.js');
  const { resolveConsumerProfile, routingProfileProjection } = await import('../lib/pipeline-profiles.js');
  const { runAndNormalize } = await import('../lib/result-normalizer.js');
  const { fakeBuildStratum, agentResult } = await import('./helpers/build-stratum-fixture.js');
  for (const [name, raw] of [['bundled-build', JSON.parse(readFileSync('presets/team-fable-astra.profiles.json'))], ['carry', PROFILES]]) {
    const frozen = JSON.parse(readFileSync(`test/fixtures/model-route-off-${name}-v0.5.1.json`));
    const profiles = routingProfileProjection(raw, { mode: 'off' }).staticProfiles;
    const observed = [];
    const stratum = fakeBuildStratum({ agentRun: (provider, prompt, opts) => { observed.push({ provider, prompt, opts }); return agentResult({ summary: 'recorded fixture call' }, `oracle-${observed.length}`); } });
    const calls = frozen.events.filter(e => e.kind === 'call');
    const progress = new Proxy({}, { get: () => () => {} });
    for (const call of calls) {
      const step = call.opts.telemetry.step_id; const parent = step.split('/')[0];
      const tier = call.prompt.match(/"tier":"(critical|standard|fast)"/)?.[1];
      const profile = resolveConsumerProfile(profiles[parent], tier ? { tier } : {});
      await runAndNormalize(null, call.prompt, { step_id: step, agent: call.provider, has_out_contract: false }, {
        stratum, progress, streamWriter: { write() {} }, profile: profile.profile, cwd: call.opts.cwd,
        ...(step.startsWith('execute/') ? { sandboxMode: 'workspace-write' } : {}), maxDurationMs: 10000,
      });
    }
    const projection = call => ({ provider: call.provider, prompt: call.prompt,
      options: Object.fromEntries(['modelID', 'thinking', 'effort', 'allowedTools', 'disallowedTools', 'sandboxMode']
        .filter(k => call.opts[k] !== undefined).map(k => [k, call.opts[k]])) });
    assert.deepEqual(observed.map(projection), calls.map(projection));
  }
});

// Public runner seam: plan/audit snapshots are persisted like the engine, while
// inference is deterministic. Every fresh plan has a distinct run identity.
async function ordinaryPublicFixture(t, { role = false, exposure, profiles = {} } = {}) {
  const { buildWaveFixture, waveSpec } = await import('./helpers/build-wave-fixture.js');
  const { agentResult } = await import('./helpers/build-stratum-fixture.js');
  const spec = waveSpec(); Object.assign(spec.flows.bug_fix.input, transport);
  spec.flows.bug_fix.steps = [{ id: 'work', agent: role ? '$.input.implementer_agent' : 'claude', do: exposure ?? 'ordinary', out: 'R' }];
  if (role) Object.assign(spec.flows.bug_fix.input, { featureCode: 'string', description: 'string', implementer_agent: 'string?', reviewer_agent: 'string?' });
  spec.flows.bug_fix.output = { from: '${work.output}', contract: 'R' };
  const f = buildWaveFixture(t, { spec, profiles });
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const plans = [], calls = []; let id;
  const persist = () => writeFileSync(join(f.stateRoot, `${id}.json`), JSON.stringify(f.state));
  f.stratum.plan = async (text, flow, input, options) => {
    plans.push(structuredClone(input)); id = `fresh-${plans.length}`;
    const effective = resolvePlanSpecValues(YAML.parse(text), input);
    Object.assign(f.state, { id, spec: effective, revisionDigest: routingDigest(effective), input,
      workspaceRoot: options.workspaceRoot, status: 'running', steps: { work: { status: 'ready', dispatchToken: `${id}-token` } } });
    persist(); return { status: 'ready', runId: id, revisionDigest: f.state.revisionDigest,
      ready: [{ id: 'work', agent: effective.flows.bug_fix.steps[0].agent, do: 'ordinary', epoch: 0, dispatchToken: `${id}-token` }] };
  };
  f.stratum.agentRun = async (...args) => { calls.push(args); return agentResult({ outcome: 'complete', summary: 'done' }, `call-${calls.length}`); };
  f.stratum.stepDone = async (_id, step, envelope, token) => {
    Object.assign(f.state.steps.work, { status: 'succeeded', acceptedDispatchToken: token, output: envelope.output });
    delete f.state.steps.work.dispatchToken; f.state.status = 'completed'; persist(); return { status: 'completed', runId: id };
  };
  f.stratum.audit = async () => ({ ...structuredClone(f.state), runId: id });
  const staleActive = () => {
    const path = join(f.cwd, '.compose/data/active-build.json');
    const active = JSON.parse(readFileSync(path));
    writeFileSync(path, JSON.stringify({ ...active, status: 'running', pid: 2147483647 }));
  };
  return { ...f, calls, plans, staleActive, get id() { return id; } };
}
for (const implementer of ['claude', 'claude::fast']) test(`public role flag ${implementer} preserves historical off/shadow profile merging`, async t => {
  const { resolveAgentConfig } = await import('../lib/agent-string.js');
  const f = await ordinaryPublicFixture(t, { role: true, profiles: { work: 'claude::critical' } });
  const expected = resolveAgentConfig(implementer === 'claude' ? 'claude::critical' : implementer);
  const options = { mode: 'feature', implementer, reviewer: 'codex' };
  await f.run({ ...options, route_mode: 'off' });
  assert.equal(f.plans.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'claude');
  assert.ok(expected.modelID);
  if (implementer === 'claude') assert.ok(expected.effort);
  assert.equal(f.calls[0][2].modelID, expected.modelID);
  assert.equal(f.calls[0][2].effort ?? null, expected.effort);
  await f.run({ ...options, route_mode: 'shadow', fresh: true });
  assert.equal(f.plans.length, 2); assert.equal(f.calls.length, 2);
  // Compare every serialized argument after normalizing fresh run/build/call
  // identities. JSON does not represent callback or AbortSignal identity.
  const normalize = call => {
    const copy = JSON.parse(JSON.stringify(call));
    copy[2].flow.runId = '<run>';
    copy[2].telemetry.build_id = '<build>';
    copy[2].correlationId = '<call>';
    return copy;
  };
  assert.deepEqual(normalize(f.calls[1]), normalize(f.calls[0]));
  const start = JSON.parse(f.plans[1].routing_start);
  assert.equal(start.originalInput.implementer_agent, implementer);
  assert.deepEqual(start.runtimeOverrides, implementer === 'claude' ? {} : { work: implementer });
  const provenance = start.staticResolutions['bug_fix/work'];
  assert.equal(provenance.winner.modelID, expected.modelID);
  assert.equal(provenance.winner.effort, expected.effort);
  assert.equal(provenance.source, implementer === 'claude' ? 'preset' : 'manual');
  assert.deepEqual(provenance.manualFallback, {
    supplied: true, origin: 'explicit', recordedRole: implementer,
    profile: implementer === 'claude' ? null : implementer,
  });
});
for (const opts of [{ route_mode: 'active' }, { route_trials: ['trial'] }, { route_explore: 0.1 }, { calibration_feedback: true }]) {
  test(`public terminal old flow revalidates fresh options ${JSON.stringify(opts)} before plan/model`, async t => {
    const f = await ordinaryPublicFixture(t); await f.run({ route_mode: 'off' }); f.staleActive();
    await assert.rejects(f.run(opts), { code: 'ROUTING_SLICE_UNAVAILABLE' });
    assert.equal(f.plans.length, 1); assert.equal(f.calls.length, 1);
  });
}
test('public terminal old flow starts current shadow mode with a new journal', async t => {
  const { routingJournalPath } = await import('../lib/consumer-fanout.js');
  const f = await ordinaryPublicFixture(t); await f.run({ route_mode: 'off' }); f.staleActive();
  await f.run({ route_mode: 'shadow' });
  assert.equal(f.plans.length, 2); assert.equal(f.calls.length, 2);
  const journal = JSON.parse(readFileSync(routingJournalPath({ runId: f.id, targetCwd: f.cwd, artifactRoot: f.artifactRoot })));
  assert.equal(journal.routing.runBinding.runId, f.id); assert.equal(f.plans[1].route_mode, 'shadow');
});
for (const previousMode of ['shadow', 'off']) test(`public fresh off leaves missing ordinary-only ${previousMode} journal absent`, async t => {
  const { routingJournalPath } = await import('../lib/consumer-fanout.js');
  const f = await ordinaryPublicFixture(t); await f.run({ route_mode: previousMode });
  const path = routingJournalPath({ runId: f.id, targetCwd: f.cwd, artifactRoot: f.artifactRoot });
  if (previousMode === 'shadow') assert.ok(existsSync(path));
  rmSync(path, { force: true });
  if (previousMode === 'shadow') {
    await assert.rejects(f.run({ fresh: true, route_mode: 'off' }), { code: 'ROUTING_BINDING_MISSING' });
    assert.equal(f.calls.length, 1); assert.equal(f.plans.length, 1);
  } else { await f.run({ fresh: true, route_mode: 'off' }); assert.equal(f.calls.length, 2); }
  assert.equal(existsSync(path), false, 'old inspection never creates a journal');
});
for (const exposure of ['${input.routing_start}', '${input}', '$.input.routing_root']) test(`Build participating plan rejects transport forwarding ${exposure}`, async t => {
  const f = fixture(t);
  f.spec.flows.feature.steps.unshift({ id: 'child', run: 'sub', input: { forwarded: exposure } });
  f.spec.flows.sub = { input: { forwarded: 'string' }, steps: [{ id: 'child_work', agent: 'claude', do: '${input.forwarded}' }] };
  await assert.rejects(f.start(), { code: 'ROUTING_TRANSPORT_EXPOSED' });
  assert.equal(f.calls.length, 0);
});

test('public Build rejects model-facing transport before plan/model dispatch', async t => {
  const f = await ordinaryPublicFixture(t, { exposure: '${input.routing_start}' });
  await assert.rejects(f.run({ route_mode: 'shadow' }), { code: 'ROUTING_TRANSPORT_EXPOSED' });
  assert.equal(f.plans.length, 0); assert.equal(f.calls.length, 0);
});
for (const boundary of ['audit terminal', 'resume terminal']) test(`fresh after ${boundary} resolves current roles and runtime provenance`, async t => {
  const oldProbe = process.env.COMPOSE_SKIP_CODEX_PROBE; process.env.COMPOSE_SKIP_CODEX_PROBE = '1';
  t.after(() => { if (oldProbe === undefined) delete process.env.COMPOSE_SKIP_CODEX_PROBE; else process.env.COMPOSE_SKIP_CODEX_PROBE = oldProbe; });
  const f = await ordinaryPublicFixture(t, { role: true });
  await f.run({ mode: 'feature', route_mode: 'shadow', implementer: 'claude', reviewer: 'codex' }); f.staleActive();
  if (boundary === 'resume terminal') {
    const audit = f.stratum.audit; let first = true;
    f.stratum.audit = async () => { const result = await audit(); if (first) { first = false; result.status = 'running'; } return result; };
    f.stratum.resume = async () => ({ status: 'completed', runId: f.id, revisionDigest: f.state.revisionDigest });
  }
  await f.run({ mode: 'feature', route_mode: 'shadow', implementer: 'codex::critical', reviewer: 'claude' });
  assert.equal(f.plans.length, 2); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][0], 'codex'); assert.equal(f.calls[1][2].modelID, 'gpt-6-astra');
  const start = JSON.parse(f.plans[1].routing_start);
  assert.equal(start.originalInput.implementer_agent, 'codex::critical');
  assert.equal(start.runtimeOverrides.work, 'codex::critical');
  assert.equal(start.staticResolutions['bug_fix/work'].manualFallback.supplied, true);
});
