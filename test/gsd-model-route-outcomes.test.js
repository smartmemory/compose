import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture } from './helpers/routing-runtime-fixture.js';
test('ordinary-only no-ceiling GSD retains sibling provenance from the real connector and engine producer', async t => {
  const f = await runtimeFixture(t, { gsd: true }); const result = await f.run();
  assert.equal(result.status, 'complete'); assert.equal(f.calls.length, 1);
  const rows = f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].cost.usd, 0.12);
  assert.equal(rows[0].outcome.label, 'unknown');
  const paid = f.snapshot().receipts.find(r => r.detail?.routing?.kind === 'paid-call');
  assert.equal(paid.usdSource, 'reported'); assert.equal(paid.amount.usd, 0.12);
  assert.equal(paid.detail.routing.callId, rows[0].calls[0].intent.callId);
  assert.equal(f.receipts[0][1].source, 'compose:route');
});
test('GSD post-call parse exception settles failed attempt and materializes paid usage before throw', async t => {
  const f = await runtimeFixture(t, { gsd: true, inference: () => ({ text: 'not json', usage: { tokens: 9, ms: 12, usd: 0.4 }, usdSource: 'reported' }) });
  await assert.rejects(f.run(), /parseable JSON/); assert.equal(f.calls.length, 1);
  assert.equal(f.rows()[0].cost.usd, 0.4); assert.equal(f.rows()[0].outcome.label, 'failed-or-cancelled');
  assert.equal(f.reports.length, 1); assert.ok(f.reports[0][2].failure);
});
test('participating GSD cancellation at plan exits its public loop without inventing a call or row', async t => {
  const f = await runtimeFixture(t, { gsd: true, intercept: async (method, args, response, f) => {
    if (method === 'plan') { await f.engine.flowCancel(response.runId); return { ...response, status: 'cancelled' }; }
  } });
  const result = await f.run(); assert.equal(result.status, 'cancelled'); assert.equal(f.calls.length, 0); assert.equal(f.rows().length, 0);
});
test('GSD metadata barrier refuses before a model call and keeps a locally owned incomplete row', async t => {
  const f = await runtimeFixture(t, { gsd: true, intercept(method) { if (method === 'before:usageReport') throw Error('offline'); } });
  await assert.rejects(f.run(), { code: 'ROUTING_RECEIPT_INCOMPLETE' }); assert.equal(f.calls.length, 0);
  assert.equal(f.rows()[0].completeness.state, 'incomplete');
});

test('GSD cancelled after a returned paid call uses run audit and call termination, with locally pending cost', async t => {
  const f = await runtimeFixture(t, { gsd: true, inference: async (_args, f) => {
    await f.engine.flowCancel(f.flowId);
    return { text: '{"outcome":"complete","summary":"done"}', usage: { tokens: 7, ms: 8, usd: 0.6 }, usdSource: 'reported' };
  } });
  await assert.rejects(f.run(), /cancelled/);
  const rows = f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].cost.usd, 0.6);
  assert.equal(rows[0].outcome.label, 'failed-or-cancelled'); assert.equal(rows[0].outcome.binary, 'excluded');
  const settlement = Object.values(f.journal().routing.records).find(r => r.event === 'settled');
  assert.equal(settlement.evidence.proofKind, 'cancellation-audit'); assert.equal(settlement.evidence.terminationRefs.length, 1);
  const paid = f.journal().pendingUsageReceipts.find(p => p.receipt.detail?.routing?.kind === 'paid-call');
  assert.equal(paid.state, 'pending');
});

test('GSD unconfirmed connector teardown retains an unknown outcome and blocks reissue', async t => {
  const { ConsumerFanoutArtifacts } = await import('../lib/consumer-fanout.js');
  const { runOneStep } = await import('../lib/gsd.js');
  const originalIntent = ConsumerFanoutArtifacts.prototype.recordRoutingCallIntent;
  let routing, originalReady;
  t.mock.method(ConsumerFanoutArtifacts.prototype, 'recordRoutingCallIntent', function (args) {
    routing = this.routingContext; return originalIntent.call(this, args);
  });
  const f = await runtimeFixture(t, { gsd: true,
    intercept(method, _args, response) { if (method === 'plan') originalReady = structuredClone(response); },
    inference: async (_args, f) => {
    await f.engine.flowCancel(f.flowId);
    throw Object.assign(Error('teardown not acknowledged'), { code: 'CANCELLATION_UNCONFIRMED' });
  } });
  await assert.rejects(f.run(), /teardown not acknowledged/);
  assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 0);
  assert.equal(f.rows()[0].outcome.label, 'unknown');
  assert.equal(f.rows()[0].calls[0].resolution.terminationEvidence.kind, 'uncertain');
  // Retry the actual engine-issued descriptor through GSD's dispatch producer.
  // The retained live routing context comes from the first producer, unchanged.
  assert.ok(routing); assert.equal(originalReady.status, 'ready');
  assert.equal(f.snapshot().steps.work.dispatchToken, undefined, 'engine cancellation revokes the original dispatch token');
  await assert.rejects(runOneStep(originalReady, { routing, artifacts: routing.artifacts, stratum: f.stratum,
    cwd: f.cwd, localSpec: f.spec }), { code: 'ROUTING_BINDING_DRIFT' });
  const { resumeRouting } = await import('../lib/build.js');
  await assert.rejects(resumeRouting({ runId: f.flowId, cwd: f.cwd, localSpec: f.spec, profiles: f.profiles,
    stratum: f.stratum, artifactRoot: f.artifactRoot }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 0);
});

test('GSD real assess/reset closure captures the old wave and retains ownership after B reindexes', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { gsd: true }); const returned = await f.run();
  assert.equal(returned.status, 'complete'); assert.equal(f.captured.length, 2);
  const oldB = f.rows().find(r => r.issuance?.scopedStep === 'execute' && r.issuance.epoch === 0 && r.issuance.itemIndex === 1);
  const newB = f.rows().find(r => r.issuance?.scopedStep === 'execute' && r.issuance.epoch === 1);
  assert.equal(oldB.outcome.label, 'repaired'); assert.equal(newB.issuance.itemIndex, 0);
  assert.equal(newB.context.repairOfRecordId, oldB.recordId);
});

test('GSD preserves raw sibling token split in the original paid receipt', async t => {
  const split = { input: 3, output: 6, cacheRead: 1 };
  const f = await runtimeFixture(t, { gsd: true, inference: () => ({ text: '{"outcome":"complete","summary":"done"}',
    usage: { tokens: 9, ms: 10, usd: 0.2 }, usdSource: 'reported', split }) });
  await f.run();
  const receipt = f.snapshot().receipts.find(r => r.detail?.routing?.kind === 'paid-call');
  assert.deepEqual(receipt.split, split); assert.equal(receipt.usdSource, 'reported');
  assert.equal(f.rows()[0].cost.tokens, 9);
});
