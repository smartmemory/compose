import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWaveFixture, decision, decisionProfiles, task, waveSpec } from './helpers/build-wave-fixture.js';
import { BuildStreamWriter } from '../lib/build-stream-writer.js';
process.env.NODE_ENV = 'test';
test('runner preflight rejects a cost ceiling on reserved review_gate', async t => {
  const spec = waveSpec();
  spec.flows.bug_fix.steps.at(-1).id = 'review_gate';
  const f = buildWaveFixture(t, { gate: true, spec, profiles: {
    execute: 'codex:implementer:standard',
    _costCeiling: { input: 'limit', default: 1, gates: ['review_gate'] },
  } });
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'WAVE_COST_CEILING_RESERVED_GATE');
    assert.match(error.message, /_costCeiling\.gates.*review_gate/);
    return true;
  });
  assert.equal(f.stratum.calls.length, 0);
});
for (const [action, expected] of [['complete', 'approve'], ['implement', 'revise'], ['repair', 'revise'], ['blocked', 'kill']]) {
  test(`public build maps ${action} to ${expected} with recorded evidence`, async t => {
    const findings = [{ severity: 'error', files: ['f1.txt'], claim: 'fix', evidence: 'test' }];
    const output = decision(action, action === 'complete' ? {} : { open_findings: findings, open_count: 1,
      tasks: action === 'blocked' ? [] : [task(1)] });
    const f = buildWaveFixture(t, { gate: true, output });
    await f.run();
    const resolution = f.stratum.calls.find(c => c.type === 'gateResolve');
    assert.equal(resolution.args[2], expected); assert.equal(resolution.args[5], 'gate-token');
    const evidence = f.state.receipts.find(r => r.dispatchId.endsWith(':proposed'));
    assert.equal(evidence.detail.source.output.action, action);
    assert.equal(f.state.receipts.filter(r => r.source === 'compose:gate_decision').length, 2);
  });
}
test('invalid recorded review forces human hold without resolving or finalizing', async t => {
  const f = buildWaveFixture(t, { gate: true });
  f.state.steps.review.output.blocking = true;
  const result = await f.run();
  assert.equal(result.status, 'waiting_gate');
  assert.equal(result.reason, 'GATE_VALIDATION_FAILED');
  assert.equal(f.stratum.calls.some(c => c.type === 'gateResolve'), false);
  const active = JSON.parse(readFileSync(join(f.cwd, '.compose/data/active-build.json')));
  assert.equal(active.status, 'waiting_gate');
});
for (const spent of [150, 150.01]) test(`ceiling ${spent} from strict receipt spine`, async t => {
  const f = buildWaveFixture(t, { gate: true, profiles: { ...decisionProfiles,
    _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['assess_gate'] } },
    receipts: [{ dispatchId: 'paid', amount: { usd: spent }, usdSource: 'reported' }] });
  const oldRoot = process.env.STRATUM_STATE_ROOT;
  process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (oldRoot === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = oldRoot; });
  const result = await f.run();
  if (spent === 150) assert.equal(f.stratum.calls.some(c => c.type === 'gateResolve'), true);
  else {
    assert.equal(result.status, 'waiting_gate'); assert.equal(result.reason, 'WAVE_COST_CEILING_EXCEEDED');
    const resumed = await f.run({ resume: true, costCeilingUsd: 300 });
    assert.equal(resumed.status, 'waiting_gate');
    assert.equal(f.stratum.calls.some(c => c.type === 'gateResolve'), false);
    assert.ok(f.state.receipts.some(r => r.source === 'compose:cost_ceiling' && r.detail.override === 300));
  }
});
test('pause emits one build_paused and no build_end', t => {
  const f = buildWaveFixture(t);
  const writer = new BuildStreamWriter(f.cwd, f.code);
  writer.pause({ reason: 'test' }); writer.close('failed'); writer.pause();
  const events = readFileSync(writer.filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'build_paused').length, 1);
  assert.equal(events.filter(e => e.type === 'build_end').length, 0);
});

test('ceiling hold overrides flag policy, retains pause stream and requires a human after resume', async t => {
  const f = buildWaveFixture(t, { gate: true, profiles: { ...decisionProfiles,
    _costCeiling: { input: 'cost_ceiling_usd', default: 1, gates: ['assess_gate'] } },
    receipts: [{ dispatchId: 'paid', amount: { usd: 2 }, usdSource: 'reported' }] });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(f.cwd, '.compose/data/settings.json'), JSON.stringify({ policies: { assess_gate: 'flag' } }));
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  assert.equal((await f.run()).status, 'waiting_gate');
  const events = readFileSync(join(f.cwd, '.compose/build-stream.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some(e => e.type === 'build_end'), false);
  assert.equal(events.filter(e => e.type === 'build_paused').length, 1);
  const { PassThrough, Writable } = await import('node:stream');
  const input = new PassThrough();
  const output = new Writable({ write(c, _e, cb) {
    if (c.toString() === '\n> ') setImmediate(() => input.write('r\n'));
    if (c.toString() === 'Rationale: ') setImmediate(() => input.write('continue with repairs\n'));
    cb();
  } });
  await f.run({ resume: true, costCeilingUsd: 3, gateOpts: { nonInteractive: false, input, output } });
  input.destroy();
  const resolution = f.stratum.calls.find(c => c.type === 'gateResolve');
  assert.equal(resolution.args[2], 'revise'); assert.equal(resolution.args[4], 'human');
});

test('lost paid receipt acknowledgement replays the same id without charging twice', async t => {
  const { ConsumerFanoutArtifacts } = await import('../lib/consumer-fanout.js');
  const { reportUsageReceipts, flushWaveReceipts, preflightPipelineProfiles } = await import('../lib/build.js');
  const f = buildWaveFixture(t, { gate: true, profiles: { ...decisionProfiles,
    _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['assess_gate'] } } });
  const profileCheck = preflightPipelineProfiles({ ...decisionProfiles, _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['assess_gate'] } }, f.spec);
  const artifacts = new ConsumerFanoutArtifacts({ runId: f.runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot,
    revisionDigest: 'revision', profilesDigest: profileCheck.profilesDigest });
  const original = f.stratum.usageReport; let dropped = false;
  f.stratum.usageReport = async (...args) => { const ack = await original(...args); if (!dropped) { dropped = true; throw new Error('lost ack'); } return ack; };
  const ctx = { stratum: f.stratum, flowId: f.runId, artifacts, receiptsMode: true, pipelineProfiles: profileCheck.normalized };
  await reportUsageReceipts(ctx, { dispatch_id: 'paid-once', cost_usd: 5, usd_source: 'reported', model: 'reported', duration_ms: 2 });
  assert.equal(artifacts.journal.pendingUsageReceipts[0].state, 'pending');
  const reloaded = new ConsumerFanoutArtifacts({ runId: f.runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot });
  await flushWaveReceipts({ ...ctx, artifacts: reloaded });
  assert.equal(reloaded.journal.pendingUsageReceipts[0].state, 'acknowledged');
  assert.equal(f.state.receipts.filter(r => r.dispatchId === 'paid-once').length, 1);
});

test('an unavailable cost snapshot holds instead of treating spend as zero', async t => {
  const f = buildWaveFixture(t, { gate: true, profiles: { ...decisionProfiles,
    _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['assess_gate'] } } });
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = join(f.cwd, 'missing');
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  assert.equal((await f.run()).reason, 'WAVE_COST_UNVERIFIED');
  assert.equal(f.stratum.calls.some(c => c.type === 'gateResolve'), false);
});

test('unacknowledged paid calls reach a human ceiling hold and retain the receipt locally', async t => {
  const f = buildWaveFixture(t, { profiles: { ...decisionProfiles,
    _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['execute_merge'] } } });
  const original = f.stratum.usageReport;
  f.stratum.usageReport = async (id, receipt) => {
    if (!receipt.source.startsWith('compose:')) throw new Error('paid receipt unavailable');
    return original(id, receipt);
  };
  const old = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = f.stateRoot;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
  const result = await f.run();
  assert.equal(result.status, 'waiting_gate'); assert.equal(result.reason, 'WAVE_COST_UNVERIFIED');
  assert.equal(f.stratum.calls.filter(c => c.type === 'agentRun').length, 1);
  assert.ok(f.journal().pendingUsageReceipts.some(r => r.state === 'pending' && r.receipt.source === 'fanout'));
});

for (const args of [ ['build', 'D2-WIRING', '--cost-ceiling-usd', '0'], ['build', '--all', '--cost-ceiling-usd=10'] ]) {
  test(`CLI rejects ${args.join(' ')}`, async t => {
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const f = buildWaveFixture(t);
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../bin/compose.js', import.meta.url)), ...args],
      { cwd: f.cwd, encoding: 'utf8', stdio: 'pipe' }), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /cost-ceiling-usd.*(positive|single-build)/);
      return true;
    });
  });
}
