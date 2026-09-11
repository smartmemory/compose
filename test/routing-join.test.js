import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { bindRoutingCalls, latestRoutingCall, validateRoutingJoin, validateReceiptRouting, routingReceiptDetail, flushRoutingReceipts, routingUsageEvidence } from '../lib/routing-ledger.js';
import { routingDigest } from '../lib/model-router.js';
import { fixture, beginCall, finishCall, acknowledgeAll, consumerWave } from './helpers/routing-s1b-fixture.js';

test('immutable observers bind same-profile A/B calls and child costs to original producers despite reversed completion', async t => {
  const f = fixture(t, { consumer: true });
  const wave = await consumerWave(f, ['A', 'B'].map(id => ({ id, description: 'same profile', depends_on: [] })));
  const [a, b] = wave.issuances;
  f.launch(a); const ac = beginCall(f, a, { callId: 'connector-A' });
  f.launch(b); const bc = beginCall(f, b, { callId: 'connector-B' });
  const child = ac.observer.child({ parentIntentId: ac.intent.id, callSite: 'normalize', unsupportedReason: 'normalization-repair' });
  assert.ok(Object.isFrozen(ac.observer.binding));
  const cc = beginCall(f, a, { observer: child, callId: 'connector-repair-A', callSite: 'repair' });
  finishCall(f, bc, { usd: 0.7 }); finishCall(f, cc, { usd: 0.9 }); finishCall(f, ac, { usd: 0.3 });
  const r = f.reopen().exportRoutingJournal();
  assert.equal(r.records[bc.intent.id].issuanceId, b.id);
  assert.equal(r.records[r.records[ac.intent.id].issuanceId].itemIndex, wave.descriptors[0].itemIndex);
  assert.equal(r.records[r.records[bc.intent.id].issuanceId].itemIndex, wave.descriptors[1].itemIndex);
  assert.equal(r.records[cc.intent.id].parentRecordId, a.id);
  assert.equal(latestRoutingCall(r, bc.intent.id).resolution.usageEvidence.usd, 0.7);
  assert.equal(latestRoutingCall(r, cc.intent.id).resolution.usageEvidence.usd, 0.9);
  assert.throws(() => ac.observer.resolve(bc.intent.id, {}), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
});
test('unresolved to late completion appends contiguous evidence and identical replay preserves bytes after reload', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const call = beginCall(f, i);
  const unknown = finishCall(f, call, { unresolved: true });
  const observer = bindRoutingCalls({ artifacts: f.reopen(), issuanceId: i.id });
  const late = finishCall(f, { ...call, observer });
  assert.equal(late.sequence, 1); assert.equal(late.previousResolutionId, unknown.id);
  const before = f.bytes(); finishCall(f, { ...call, observer }); assert.equal(f.bytes(), before);
  acknowledgeAll(f); const afterAck = f.bytes(); finishCall(f, { ...call, observer }); assert.equal(f.bytes(), afterAck);
  assert.equal(latestRoutingCall(f.reopen().exportRoutingJournal(), call.intent.id).resolution.id, late.id);
});
test('changed same-id bytes, competing identity, usage, terminal result and nonexecution conflicts refuse', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const call = beginCall(f, i); const r = finishCall(f, call);
  assert.throws(() => f.artifacts.recordRoutingRecord({ ...r, resolvedAt: 'changed' }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  for (const changes of [{ callId: 'another' }, { outcome: 'errored' }, { launchOutcome: 'not-executed' }, { usageEvidence: { ...r.usageEvidence, usd: 999 } },
    { terminationEvidence: { ...r.terminationEvidence, kind: 'acknowledged-termination' } }]) {
    const { schemaVersion, startId, rootDigest, type, id, intentId, sequence, previousResolutionId, ...evidence } = r;
    assert.throws(() => f.artifacts.recordRoutingCallResolution({ intentId, evidence: { ...evidence, ...changes } }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  }
});
test('reload refuses missing middle/head/tail and fork instead of selecting by timestamp', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const call = beginCall(f, i);
  finishCall(f, call, { unresolved: true }); finishCall(f, call);
  const bytes = f.bytes(); const r = f.reopen().exportRoutingJournal(); const chain = latestRoutingCall(r, call.intent.id);
  for (const mutate of [j => delete j.routing.records[chain.resolution.id], j => delete j.routing.records[chain.head.id],
    j => j.routing.records[chain.resolution.id].sequence = 8, j => j.routing.records[chain.head.id].previousHeadId = null,
    j => j.routing.records[chain.resolution.id].previousResolutionId = null]) {
    const j = JSON.parse(bytes); mutate(j); writeFileSync(f.artifacts.journalPath, JSON.stringify(j)); assert.throws(f.reopen, { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  }
  writeFileSync(f.artifacts.journalPath, bytes);
});
test('receipt detail is a separate closed schema; missing ids remain null, local effort stays null', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const call = beginCall(f, i, { callId: null });
  const r = finishCall(f, call, { receipt: false }); assert.equal(r.callId, null); assert.equal(r.callIdSource, 'absent');
  const routing = f.artifacts.exportRoutingJournal();
  const detail = routingReceiptDetail(routing, i, call.intent);
  assert.throws(() => validateReceiptRouting(detail)); assert.throws(() => validateReceiptRouting(call.intent));
  for (const bad of ['fallback', 'dispatch-token', 'legacy']) assert.throws(() => validateRoutingJoin({ ...call.intent, callIdSource: bad }));
  const metadata = routingReceiptDetail(routing, i); assert.deepEqual(validateReceiptRouting(metadata, routing), metadata);
  assert.throws(() => validateReceiptRouting({ ...metadata, extra: true }));
  const local = beginCall(f, i, { callSite: 'local', transport: 'local-sdk' }); finishCall(f, local);
  assert.equal(latestRoutingCall(f.reopen().exportRoutingJournal(), local.intent.id).resolution.reportedEffort, null);
  for (const callId of ['legacy:1', i.issuanceToken, 'compose:paid:fake']) assert.throws(() => beginCall(f, i, { callSite: callId, callId }));
});
test('minted identity can prove nonexecution independently; conflicting later execution refuses', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const call = beginCall(f, i);
  const r = call.observer.resolve(call.intent.id, { outcome: 'errored', launchOutcome: 'not-executed', usage: routingUsageEvidence(),
    terminationEvidence: { kind: 'acknowledged-termination', intentId: call.intent.id, callId: call.intent.callId, evidence: { capabilityRefused: true } } });
  assert.equal(r.callId, call.intent.callId); assert.equal(r.usageEvidence.usd, null);
  assert.throws(() => finishCall(f, call), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
});
test('missing participating journal refuses and unsupported observation requires no invented issuance', t => {
  assert.throws(() => bindRoutingCalls({ artifacts: {}, issuanceId: 'missing' }), { code: 'ROUTING_BINDING_MISSING' });
  const f = fixture(t); const observation = f.artifacts.recordRoutingObservation({ unsupportedReason: 'gate-qa', callSite: 'question-1' });
  assert.equal(observation.issuanceId, null); assert.equal(observation.scopedStep, null);
  const observer = bindRoutingCalls({ artifacts: f.artifacts, observationId: observation.id });
  const intent = observer.intent({ callSite: 'qa', purpose: 'auxiliary', transport: 'mcp', callId: 'qa-connector', profileIntent: { provider: 'codex', model: null, effort: null } });
  assert.equal(intent.issuanceId, null); assert.equal(intent.observationId, observation.id);
});
test('metadata delivery barrier and paid delivery retries retain exact payload through concurrent journal mutation', async t => {
  const f = fixture(t); const i = f.issue(); const id = `compose:route:${i.runId}:${i.issuanceToken}`;
  await assert.rejects(flushRoutingReceipts({ artifacts: f.artifacts, requiredDispatchId: id, deliver: async () => { throw Error('lost'); } }), { code: 'ROUTING_RECEIPT_INCOMPLETE' });
  await flushRoutingReceipts({ artifacts: f.artifacts, requiredDispatchId: id, deliver: async (run, receipt) => {
    assert.equal(run, i.runId); assert.equal(receipt.dispatchId, id); assert.deepEqual(receipt.usage, {});
    f.reopen().recordRoutingObservation({ unsupportedReason: 'gate-qa', callSite: 'while-RPC-outside-lock' });
    return { status: 'already_recorded', seq: 8 };
  } });
  f.launch(i); const c = beginCall(f, i); finishCall(f, c);
  await flushRoutingReceipts({ artifacts: f.artifacts, deliver: async () => { throw Error('cancelled upstream refuses'); } });
  assert.equal(f.artifacts.pendingRoutingReceipts().length, 1);
  const pending = f.artifacts.pendingRoutingReceipts()[0];
  assert.throws(() => f.artifacts.recordPendingUsageReceipt({ dispatchId: pending.dispatchId, receipt: { ...pending.receipt, usage: { usd: 900 } } }), { code: 'CONSUMER_EVIDENCE_MISMATCH' });
  assert.throws(() => f.artifacts.acknowledgeUsageReceipt({ dispatchId: pending.dispatchId, payloadDigest: routingDigest({ changed: true }) }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
});

test('atomic resolution checkpoints detect deletion of both resolution and head, including expected final tail', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i);
  finishCall(f, c, { unresolved: true }); finishCall(f, c);
  const j = JSON.parse(f.bytes()); const latest = latestRoutingCall(j.routing, c.intent.id);
  delete j.routing.records[latest.resolution.id]; delete j.routing.records[latest.head.id];
  writeFileSync(f.artifacts.journalPath, JSON.stringify(j));
  assert.throws(f.reopen, { code: 'ROUTING_BINDING_MISSING' });
});

test('engine observations retain receipt provenance, reject changed sequence/digest, and scope coverage gaps by epoch', t => {
  const f = fixture(t);
  const receipt = { dispatchId: 'legacy:17', source: 'agent', usage: { tokens: 20, ms: 50, usd: 3 }, usdSource: 'reported' };
  f.artifacts.recordPendingUsageReceipt({ dispatchId: receipt.dispatchId, receipt });
  f.artifacts.acknowledgeUsageReceipt({ dispatchId: receipt.dispatchId, seq: 17 });
  const input = { unsupportedReason: 'engine-fanout', evidenceSource: 'engine-receipt', evidenceRef: {
    ownerRunId: f.binding.runId, dispatchId: 'legacy:17', sequence: 17, payloadDigest: routingDigest(receipt) } };
  const observation = f.artifacts.recordRoutingObservation(input);
  assert.equal(observation.issuanceId, null); assert.equal(observation.evidenceRef.dispatchId, 'legacy:17');
  assert.deepEqual(f.artifacts.recordRoutingObservation(input), observation);
  assert.throws(() => f.artifacts.recordRoutingObservation({ ...input, evidenceRef: { ...input.evidenceRef, sequence: 18 } }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  assert.throws(() => f.artifacts.recordRoutingObservation({ ...input, evidenceRef: { ...input.evidenceRef, ownerRunId: 'other-run' } }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  const gap = epoch => f.artifacts.recordRoutingObservation({ unsupportedReason: 'engine-evidence-unavailable', evidenceSource: 'engine-audit', callSite: 'coverage', context: { scopedStep: 'engine', stage: 0, epoch } });
  assert.notEqual(gap(0).id, gap(1).id);
});
test('paid receipt amounts must agree with the raw call in the same atomic mutation', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i);
  const usage = routingUsageEvidence({ tokens: 2, durationMs: 3, usd: 0.4, model: c.intent.profileIntent.model, effort: c.intent.profileIntent.effort }, { provenance: 'reported' });
  const routing = f.artifacts.exportRoutingJournal();
  const receipt = { dispatchId: c.intent.callId, stepId: i.scopedStep, source: 'agent', usage: { tokens: 2, ms: 3, usd: 99 }, usdSource: 'reported', detail: { routing: routingReceiptDetail(routing, i, c.intent) } };
  const before = f.bytes();
  assert.throws(() => c.observer.resolve(c.intent.id, { outcome: 'resolved', launchOutcome: 'executed', usage,
    terminationEvidence: { kind: 'return', intentId: c.intent.id, callId: c.intent.callId, evidence: { returned: true } } }, receipt), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  assert.equal(f.bytes(), before);
});
