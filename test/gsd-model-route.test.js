import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { assertGsdRoutingBaseline } from '../lib/gsd.js';
import { preflightPipelineProfiles } from '../lib/build.js';
test('Q1 bundled bare GSD proceeds; customized ordinary static dispatch refuses', () => {
  const spec = YAML.parse(readFileSync('pipelines/gsd.stratum.yaml', 'utf8'));
  assertGsdRoutingBaseline(spec, preflightPipelineProfiles({}, spec));
  const profiles = { decompose_gsd: { default: 'claude::critical', route: { learn: true } } };
  assert.throws(() => assertGsdRoutingBaseline(spec, preflightPipelineProfiles(profiles, spec)), { code: 'ROUTING_STATIC_DISPATCH_MISMATCH' });
  for (const key of ['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation']) assert.equal(spec.flows.gsd.input[key], 'string?');
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGsd, loadResumeTaskGraph } from '../lib/gsd.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { ConsumerFanoutArtifacts } from '../lib/consumer-fanout.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';
import { routingDigest } from '../lib/model-router.js';
import { sealRoutingEpochs, resumeRouting } from '../lib/build.js';
process.env.NODE_ENV = 'test';
const code = 'COMP-GSD-5-FIX';
const blueprint = `# Routing\n\n## File Plan\n\n| File | Action | Purpose |\n|------|--------|---------|\n| \`a.txt\` | new | A |\n| \`b.txt\` | new | B |\n| \`c.txt\` | new | C |\n\n## Boundary Map\n\n### S01: A\n\nFile Plan: \`a.txt\` (new)\n\nProduces:\n  a.txt → a (function)\n\nConsumes: nothing\n\n### S02: B\n\nFile Plan: \`b.txt\` (new)\n\nProduces:\n  b.txt → b (function)\n\nConsumes: nothing\n\n### S03: C\n\nFile Plan: \`c.txt\` (new)\n\nProduces:\n  c.txt → c (function)\n\nConsumes: nothing\n`;
const taskResult = id => ({ status: 'passed', files_changed: [`${id.toLowerCase()}.txt`], summary: `${id} done`, produces: {},
  gates: [{ command: 'true', status: 'pass', output: '' }], attempts: 1 });
async function gsdFixture(t, { route = 'shadow', runner = 'GSD', spec, profiles = {}, receiptsOffline = () => false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gsd-route-'));
  const cwd = join(root, 'workspace'); const stateRoot = join(root, 'engine'); const artifactRoot = join(root, 'artifacts');
  mkdirSync(cwd); mkdirSync(stateRoot);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'GSD Route']); git(['config', 'user.email', 'route@example.test']);
  mkdirSync(join(cwd, 'docs/features', code), { recursive: true });
  writeFileSync(join(cwd, 'docs/features', code, 'blueprint.md'), blueprint);
  if (spec) {
    mkdirSync(join(cwd, 'pipelines'));
    writeFileSync(join(cwd, 'pipelines/gsd.stratum.yaml'), YAML.stringify(spec));
    writeFileSync(join(cwd, 'pipelines/gsd.profiles.json'), JSON.stringify(profiles));
  }
  if (runner === 'Build') {
    mkdirSync(join(cwd, '.compose/data'), { recursive: true });
    writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ version: 2, capabilities: { preMergeGate: true } }));
    writeFileSync(join(cwd, '.compose/data/settings.json'), JSON.stringify({ policies: { execute_merge: 'skip', inspect_merge: 'skip' } }));
  }
  writeFileSync(join(cwd, '.gitignore'), '.compose/gsd/\n.compose/data/\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = stateRoot;
  const client = new StratumMcpClient();
  await client.connect({ command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath, args: [TS_MCP_BIN], cwd,
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot, RESEND_API_KEY: '', STRIPE_API_KEY: '' } });
  t.after(async () => { await client.close(); if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old;
    rmSync(root, { recursive: true, force: true }); });
  const calls = [], plans = [], receiptDeliveries = [];
  const connector = new StratumMcpClient();
  let nextOutput;
  connector._testClient = { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ text: JSON.stringify(nextOutput), usage: { tokens: 5, ms: 7, usd: 0.1 }, usdSource: 'reported' }) }] }) };
  let stopAtMerge = true;
  const stratum = new Proxy(client, { get(target, key) {
    if (key === 'agentRun') return async (provider, prompt, opts) => {
      calls.push({ provider, prompt, opts });
      const output = opts.telemetry?.step_id === 'decompose_gsd' ? { tasks: ['A', 'B', 'C'].map((id, i) => ({ id,
        description: `Task ${id}`, files_owned: [`${id.toLowerCase()}.txt`], files_read: [], depends_on: i ? ['A'] : [] })) }
        : { outcome: 'complete', summary: 'done', files_changed: [] };
      nextOutput = output;
      return connector.agentRun(provider, prompt, opts);
    };
    if (key === 'usageReport') return async (...args) => {
      receiptDeliveries.push(structuredClone(args));
      if (args[1].detail?.routing?.kind === 'paid-call' && receiptsOffline(args[0])) throw Error('receipt delivery offline');
      return target.usageReport(...args);
    };
    if (key === 'plan') return async (...args) => {
      plans.push(structuredClone(args));
      if (args[2].routing_continuation) {
        const start = JSON.parse(args[2].routing_start);
        const record = JSON.parse(readFileSync(join(cwd, '.compose/routing/starts', start.startId, 'records', `${args[2].routing_continuation}.json`)));
        assert.equal(record.type, 'continuation-intent', 'continuation is durable before plan');
      }
      return target.plan(...args);
    };
    if (key === 'gateResolve' && runner === 'Build') return async (...args) => {
      if (args[1] === 'execute_merge') throw Object.assign(new Error('fixture merge boundary'), { code: 'FIXTURE_MERGE_STOP' });
      return target.gateResolve(...args);
    };
    if (key === 'stepDone') return async (...args) => {
      const next = await target.stepDone(...args);
      const snapshot = JSON.parse(readFileSync(join(stateRoot, `${args[0]}.json`)));
      if (stopAtMerge && snapshot.steps.execute_merge?.status === 'waiting_gate') return { ...next, status: runner === 'Build' ? 'running' : 'waiting_gate', gateToken: snapshot.steps.execute_merge.gateToken };
      if (snapshot.steps.inspect_merge?.status === 'waiting_gate') return { ...next, status: 'running' };
      return next;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const { runBuild } = await import('../lib/build.js');
  const run = opts => (runner === 'Build' ? runBuild : runGsd)(code, { cwd, stratum, route_mode: route, consumerArtifactsRoot: artifactRoot,
    gateCommands: ['true'], preMergeGate: ['true'], ...(runner === 'Build' ? { mode: 'feature', template: 'gsd', skipTriage: true, gateOpts: { nonInteractive: true } } : {}), ...opts });
  const snapshot = runId => JSON.parse(readFileSync(join(stateRoot, `${runId}.json`)));
  const journal = runId => new ConsumerFanoutArtifacts({ runId, targetCwd: cwd, artifactRoot }).journal;
  const pause = (runId, completed, crash = false) => {
    const tasks = snapshot(runId).steps.decompose_gsd.output.tasks;
    const dir = join(cwd, '.compose/gsd', code); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blackboard.json'), JSON.stringify(Object.fromEntries(completed.map(id => [id, taskResult(id)]))));
    if (crash) {
      rmSync(join(dir, 'pause.json'), { force: true });
      const state = JSON.parse(readFileSync(join(dir, 'state.json')));
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, status: 'running', pid: 2147483647, completedTaskIds: completed, decomposedTasks: tasks, resumeReady: true }));
    } else writeFileSync(join(dir, 'pause.json'), JSON.stringify({ mode: 'gsd', flowId: runId, decomposedTasks: tasks, completedTaskIds: completed, pid: 2147483647 }));
  };
  return { cwd, git, client, stratum, stateRoot, artifactRoot, run, calls, plans, receiptDeliveries, snapshot, journal, pause,
    allowMerge() { stopAtMerge = false; } };
}
test('real GSD three-run continuation preserves C allocation through 2→1→0, pause and crash bridge', async t => {
  const f = await gsdFixture(t);
  const first = await f.run(); const run1 = first.runId;
  assert.equal(first.status, 'waiting_gate');
  const j1 = f.journal(run1); const root = j1.routing.rootDigest;
  const a1 = Object.values(j1.routing.records).filter(r => r.type === 'admission' && r.stage === 0);
  assert.equal(a1.length, 3); const c1 = a1.find(a => a.logicalTaskId === 'C');
  f.pause(run1, ['A']);
  const second = await f.run({ resume: true, route_mode: 'off' }); const run2 = second.runId;
  const j2 = f.journal(run2);
  assert.equal(j2.routing.rootDigest, root); assert.equal(j2.routing.runBinding.previousRunId, run1);
  const link2 = j2.routing.records[j2.routing.runBinding.continuationIntentId];
  assert.deepEqual(link2.removedTaskIds, ['A']);
  assert.deepEqual(link2.removedDependencies, [{ taskId: 'B', dependency: 'A' }, { taskId: 'C', dependency: 'A' }]);
  assert.deepEqual(link2.indexMap.map(i => i.newIndex), [null, 0, 1]);
  assert.deepEqual(j2.routing.records[c1.id], c1);
  f.pause(run2, ['A', 'B'], true);
  const third = await f.run({ resume: true }); const run3 = third.runId; const j3 = f.journal(run3);
  const link3 = j3.routing.records[j3.routing.runBinding.continuationIntentId];
  assert.equal(j3.routing.rootDigest, root); assert.deepEqual(link3.completedTaskIds, ['A', 'B']); assert.deepEqual(link3.removedTaskIds, ['B']);
  assert.deepEqual(link3.indexMap.map(i => i.newIndex), [null, 0]); assert.deepEqual(link3.completionChain, [link2.id]);
  assert.deepEqual(j3.routing.records[c1.id], c1);
  const cCalls = Object.values(j3.routing.records).filter(r => r.type === 'issuance' && r.logicalTaskId === 'C');
  assert.deepEqual(cCalls.map(i => i.itemIndex), [2, 1, 0]); assert.equal(new Set(cCalls.map(i => i.id)).size, 3);
  assert.equal(cCalls[2].priorRecordId, cCalls[1].id); assert.equal(new Set(cCalls.map(i => i.admissionId)).size, 1);
  assert.equal(f.calls.filter(c => c.opts.telemetry?.step_id === 'decompose_gsd').length, 1);
  assert.equal(f.plans.length, 3); assert.ok(f.plans.every(p => p[2].routing_root === root));
});
test('GSD off/shadow compare path-normalized prompts and selected options; fresh input matches frozen GSD input', async t => {
  const off = await gsdFixture(t, { route: 'off' }); const a = await off.run();
  const frozen = JSON.parse(readFileSync('test/fixtures/model-route-off-gsd-input-v0.5.1.json'));
  assert.deepEqual(off.plans[0][2], frozen.events[0].input);
  assert.equal(existsSync(join(off.cwd, '.compose/routing')), false);
  const shadow = await gsdFixture(t); await shadow.run();
  const project = (calls, cwd) => calls.map(c => ({ provider: c.provider, prompt: c.prompt.replaceAll(c.opts.cwd, '<dispatch-cwd>').replaceAll(cwd, '<workspace>'),
    modelID: c.opts.modelID, effort: c.opts.effort, sandboxMode: c.opts.sandboxMode, allowedTools: c.opts.allowedTools,
    disallowedTools: c.opts.disallowedTools, systemPrompt: c.opts.systemPrompt }));
  assert.deepEqual(project(shadow.calls, shadow.cwd), project(off.calls, off.cwd));
  assert.equal(off.calls.length, 4);
  assert.equal(off.journal(a.runId).routing, undefined);
});

test('bundled GSD merge error revises execute to epoch 1 while source stays at epoch 0', async t => {
  const { runOneStep } = await import('../lib/gsd.js');
  const { ConsumerMergeDecisionError } = await import('../lib/consumer-fanout.js');
  const f = await gsdFixture(t); const first = await f.run(); const runId = first.runId;
  const localSpec = YAML.parse(readFileSync('pipelines/gsd.stratum.yaml', 'utf8'));
  const routing = await resumeRouting({ runId, cwd: f.cwd, artifactRoot: f.artifactRoot, localSpec, profiles: {}, stratum: f.stratum });
  const oldSource = f.snapshot(runId).steps.decompose_gsd;
  const before = f.journal(runId); const oldAdmission = Object.values(before.routing.records).find(r => r.type === 'admission' && r.logicalTaskId === 'A');
  const realPrepare = routing.artifacts.prepareMerge.bind(routing.artifacts);
  routing.artifacts.prepareMerge = () => { throw new ConsumerMergeDecisionError('MERGE_WITNESS_PRECOMPUTE_FAILED', 'injected merge failure'); };
  const ctx = { cwd: f.cwd, stratum: f.stratum, featureCode: code, flowId: runId, routing,
    artifacts: routing.artifacts, consumerArtifacts: routing.artifacts, consumerArtifactsRoot: f.artifactRoot,
    localSpec, localSpecDigest: routing.artifacts.journal.specDigest, pipelineProfiles: {}, filesChanged: [], receiptsMode: true };
  let next = await runOneStep({ status: 'running', runId }, ctx);
  routing.artifacts.prepareMerge = realPrepare;
  assert.equal(f.snapshot(runId).steps.execute.epoch, 1);
  assert.deepEqual(f.snapshot(runId).steps.decompose_gsd, oldSource);
  while (next.status === 'ready') next = await runOneStep(next, ctx);
  assert.equal(next.status, 'waiting_gate');
  const journal = f.journal(runId);
  const admissions = Object.values(journal.routing.records).filter(r => r.type === 'admission' && r.logicalTaskId === 'A');
  assert.equal(admissions.length, 2); assert.equal(admissions[1].logicalEpoch, oldAdmission.logicalEpoch + 1);
  assert.equal(admissions[1].logicalWaveId, oldAdmission.logicalWaveId);
  const epochs = Object.values(journal.routing.records).filter(r => r.type === 'epoch-binding' && !r.id.startsWith('capture_') && r.stage === 0);
  assert.deepEqual(epochs.map(r => r.epoch), [0, 1]);
  assert.ok(epochs.every(r => r.sourceBinding.epoch === 0 && r.sourceBinding.acceptedDispatchToken === oldSource.acceptedDispatchToken));
  assert.equal(epochs[1].priorEpochBindingId, epochs[0].id);
  assert.equal(f.calls.filter(c => c.opts.telemetry?.step_id === 'decompose_gsd').length, 1);
  assert.equal(f.calls.length, 7);
});
for (const defect of ['unknown completion', 'conflicting completion', 'description drift', 'unsettled call']) test(`GSD continuation refuses ${defect} before plan/model`, async t => {
  const f = await gsdFixture(t); const first = await f.run(); const runId = first.runId;
  f.pause(runId, ['A']);
  const dir = join(f.cwd, '.compose/gsd', code);
  if (defect === 'unknown completion') {
    const p = JSON.parse(readFileSync(join(dir, 'pause.json'))); p.completedTaskIds.push('UNKNOWN'); writeFileSync(join(dir, 'pause.json'), JSON.stringify(p));
  }
  if (defect === 'conflicting completion') {
    mkdirSync(join(dir, 'results'), { recursive: true }); writeFileSync(join(dir, 'results/A.json'), JSON.stringify({ ...taskResult('A'), summary: 'conflict' }));
  }
  if (defect === 'description drift') {
    const p = JSON.parse(readFileSync(join(dir, 'pause.json'))); p.decomposedTasks[1].description = 'changed'; writeFileSync(join(dir, 'pause.json'), JSON.stringify(p));
  }
  if (defect === 'unsettled call') {
    const a = new ConsumerFanoutArtifacts({ runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot });
    const records = a.journal.routing.records;
    const last = Object.values(records).filter(r => r.type === 'issuance-event' && r.event === 'settled').at(-1);
    delete records[last.id]; writeFileSync(a.journalPath, JSON.stringify(a.journal));
  }
  const calls = f.calls.length, plans = f.plans.length;
  await assert.rejects(f.run({ resume: true }), e => /^ROUTING_/.test(e.code));
  assert.equal(f.calls.length, calls); assert.equal(f.plans.length, plans);
});

test('Q1 refuses the public GSD fresh call before plan, with no sidecar application', async t => {
  const f = await gsdFixture(t);
  mkdirSync(join(f.cwd, 'pipelines'));
  writeFileSync(join(f.cwd, 'pipelines/gsd.stratum.yaml'), readFileSync('pipelines/gsd.stratum.yaml'));
  writeFileSync(join(f.cwd, 'pipelines/gsd.profiles.json'), JSON.stringify({ decompose_gsd: 'claude::critical' }));
  await assert.rejects(f.run({ allowDirtyWorkspace: true }), { code: 'ROUTING_STATIC_DISPATCH_MISMATCH' });
  assert.equal(f.plans.length, 0); assert.equal(f.calls.length, 0);
});

test('GSD routing admission rejects changed source token/output and stale item epoch/index/generation before calls', async t => {
  const { admitConsumerWave } = await import('../lib/build.js');
  const f = await gsdFixture(t); const first = await f.run(); const runId = first.runId;
  const localSpec = YAML.parse(readFileSync('pipelines/gsd.stratum.yaml', 'utf8'));
  const routing = await resumeRouting({ runId, cwd: f.cwd, artifactRoot: f.artifactRoot, localSpec, profiles: {}, stratum: f.stratum });
  const gate = f.snapshot(runId).steps.execute_merge;
  const next = await f.client.gateResolve(runId, 'execute_merge', 'revise', 'test revision', 'test', gate.gateToken);
  const pristine = f.snapshot(runId); const count = f.calls.length;
  for (const defect of ['source token', 'source output', 'item epoch', 'item index', 'item generation']) {
    const bad = structuredClone(pristine); const items = bad.steps.execute.fanout.items;
    if (defect === 'source token') bad.steps.decompose_gsd.acceptedDispatchToken = 'changed';
    if (defect === 'source output') bad.steps.decompose_gsd.output.tasks[0].description = 'changed';
    if (defect === 'item epoch') items.at(-1).epoch = 0;
    if (defect === 'item index') items.at(-1).index = 0;
    if (defect === 'item generation') items[0].generation += 1;
    writeFileSync(join(f.stateRoot, `${runId}.json`), JSON.stringify(bad));
    await assert.rejects(admitConsumerWave({ descriptor: next.ready[0], descriptors: next.ready, audit: bad, localSpec,
      artifacts: routing.artifacts, stratum: f.stratum, flowId: runId, routing }), e => /^(ROUTING_|WAVE_INPUT_INVALID)/.test(e.code), defect);
    assert.equal(f.calls.length, count);
  }
  writeFileSync(join(f.stateRoot, `${runId}.json`), JSON.stringify(pristine));
});

test('real-engine GSD refuses routing_start in decompose do before plan and model', async t => {
  const spec = YAML.parse(readFileSync('pipelines/gsd.stratum.yaml', 'utf8'));
  spec.flows.gsd.steps[0].do += '\nRouting debug: ${input.routing_start}';
  const f = await gsdFixture(t, { spec });
  await assert.rejects(f.run(), { code: 'ROUTING_TRANSPORT_EXPOSED' });
  assert.equal(f.plans.length, 0); assert.equal(f.calls.length, 0);
});
for (const runner of ['GSD', 'Build']) for (const policy of ['consumer', 'tier']) for (const mixed of [false, true]) {
  test(`real ${runner} shadow preserves ${policy} multi-stage wave${mixed ? ' mixed with ordinary and single-stage' : ''}`, async t => {
    const spec = YAML.parse(readFileSync('pipelines/gsd.stratum.yaml', 'utf8'));
    const flow = spec.flows.gsd;
    // Build supplies its feature envelope; only this unused-before-merge field differs.
    if (runner === 'Build') Object.assign(flow.input, { gateCommands: 'string[]?', description: 'string', implementer_agent: 'string?', reviewer_agent: 'string?' });
    const execute = flow.steps.find(s => s.id === 'execute');
    execute.fanout.steps.push(structuredClone(execute.fanout.steps[0]));
    if (mixed) {
      const single = structuredClone(execute); single.id = 'inspect';
      single.fanout.steps.pop();
      execute.after = ['inspect_merge']; flow.steps.splice(1, 0, single, {
        id: 'inspect_merge', after: ['inspect'], gate: { on_approve: 'execute', on_revise: 'inspect', on_kill: null, max_rounds: 2 },
      });
    }
    const profiles = policy === 'consumer' ? { _consumer: { execute: {} } } : { execute: { default: 'claude', tier_from: 'item.tier' } };
    const runToMerge = async f => {
      if (runner === 'Build') await assert.rejects(f.run(), { code: 'FIXTURE_MERGE_STOP' });
      else assert.equal((await f.run()).status, 'waiting_gate');
    };
    const off = await gsdFixture(t, { route: 'off', runner, spec, profiles }); await runToMerge(off);
    const shadow = await gsdFixture(t, { runner, spec, profiles }); await runToMerge(shadow);
    assert.equal(off.calls.length, mixed ? 10 : 7); assert.equal(shadow.calls.length, off.calls.length);
    const project = f => f.calls.map(c => ({ provider: c.provider, step: c.opts.telemetry?.step_id, modelID: c.opts.modelID,
      prompt: c.prompt.replaceAll(c.opts.cwd, '<dispatch-cwd>').replaceAll(f.cwd, '<workspace>') }));
    assert.deepEqual(project(shadow), project(off));
    const runId = JSON.parse(readFileSync(join(shadow.cwd,
      runner === 'Build' ? '.compose/data/active-build.json' : `.compose/gsd/${code}/state.json`))).flowId;
    const journal = shadow.journal(runId);
    const bindings = Object.values(journal.dispatchBindings);
    assert.equal(bindings.filter(b => !b.routing).length, 6);
    const admissions = Object.values(journal.routing.records).filter(r => r.type === 'admission');
    assert.ok(admissions.some(a => a.scopedStep === 'decompose_gsd'));
    assert.equal(admissions.filter(a => a.scopedStep === 'execute').length, 0);
    if (mixed) {
      assert.equal(bindings.filter(b => b.routing).length, 3);
      const routing = await resumeRouting({ runId, cwd: shadow.cwd, artifactRoot: shadow.artifactRoot,
        localSpec: spec, profiles, stratum: shadow.stratum });
      const [token, binding] = Object.entries(journal.dispatchBindings).find(([, b]) => b.routing);
      assert.throws(() => routing.artifacts.recordDispatchBinding({ dispatchToken: token,
        itemBinding: binding.itemBinding, resolvedProfile: binding.resolvedProfile,
        deferred: { flow: 'gsd', step: 'inspect', stage: 0 } }), { code: 'ROUTING_BINDING_MISSING' });
    }
  });
}

test('GSD continuation recovers late paid receipts at their original owner without replaying completed work', async t => {
  let offline = true;
  const f = await gsdFixture(t, { receiptsOffline: () => offline });
  const first = await f.run(), owner = first.runId;
  const oldPaid = f.journal(owner).pendingUsageReceipts.filter(p => p.receipt.detail?.routing?.kind === 'paid-call');
  assert.equal(oldPaid.length, 4); assert.ok(oldPaid.every(p => p.state === 'pending'));
  f.pause(owner, ['A']);
  const second = await f.run({ resume: true });
  assert.notEqual(second.runId, owner);
  const count = f.calls.length;
  offline = false;
  const { recoverRoutingEvidence } = await import('../lib/routing-runtime.js');
  const localSpec = YAML.parse(readFileSync('pipelines/gsd.stratum.yaml', 'utf8'));
  const routing = await resumeRouting({ runId: second.runId, cwd: f.cwd, artifactRoot: f.artifactRoot, localSpec, profiles: {}, stratum: f.stratum });
  await recoverRoutingEvidence({ routing, stratum: f.stratum });
  assert.equal(f.calls.length, count);
  const ids = new Set(oldPaid.map(p => p.dispatchId));
  assert.ok(f.receiptDeliveries.filter(([, receipt]) => ids.has(receipt.dispatchId)).every(([run]) => run === owner));
  assert.ok(f.journal(owner).pendingUsageReceipts.filter(p => ids.has(p.dispatchId)).every(p => p.state === 'acknowledged'));
  assert.equal(f.calls.filter(c => c.opts.telemetry?.step_id === 'decompose_gsd').length, 1);
});
