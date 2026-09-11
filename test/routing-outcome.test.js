import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoutingOutcome, deriveRoutingContext, routingIssuanceState, materializeRoutingLedger, routingEligible } from '../lib/routing-ledger.js';
import { routingEvent } from '../lib/build.js';
import { routingDigest } from '../lib/model-router.js';
import { fixture, beginCall, finishCall, acknowledgeAll, gateEvidence, linkRepair, evidenceRecord } from './helpers/routing-s1b-fixture.js';

function completed(f, epoch = 0) { const i = f.issue({ epoch }); f.launch(i); const c = beginCall(f, i); finishCall(f, c); f.settle(i); return { i, c }; }
function failure(f, i, patch = {}) {
  const envelope = { dispatchToken: i.issuanceToken, output: null, failure: { message: 'provider failed' } };
  routingEvent(f.context, i, 'result-prepared', { envelope });
  const request = { ...Object.fromEntries(['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation'].map(k => [k, i[k]])), dispatchToken: i.issuanceToken, envelope };
  return { ...Object.fromEntries(['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].map(k => [k, i[k]])),
    acceptedDispatchToken: null, status: 'failed', proofKind: 'failure-acknowledgement', request, requestDigest: routingDigest(request),
    response: { acknowledged: true, status: 'failed', result: { failure: 'exact request rejected' } }, ...patch };
}
function cancellation(f, i, resolution) {
  return { ...Object.fromEntries(['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].map(k => [k, i[k]])),
    acceptedDispatchToken: null, status: 'cancelled', proofKind: 'cancellation-audit',
    audit: { runId: i.runId, revisionDigest: i.revisionDigest, status: 'cancelled', evidence: { authority: 'run-audit' } }, terminationRefs: [resolution.id] };
}
for (const scenario of ['accepted', 'repaired', 're-implemented', 'retried-same-epoch', 'failed-or-cancelled', 'unknown']) {
  test(`evidence derives ${scenario} through real journal and S1a producers`, t => {
    const f = fixture(t); let i;
    if (scenario === 'failed-or-cancelled') {
      i = f.issue(); f.launch(i); finishCall(f, beginCall(f, i), { errored: true });
      routingEvent(f.context, i, 'settled', { evidence: failure(f, i) });
    } else {
      ({ i } = completed(f));
      if (scenario === 'accepted') gateEvidence(f, [i]);
      if (scenario === 'retried-same-epoch') f.issue();
      if (['repaired', 're-implemented'].includes(scenario)) {
        const before = gateEvidence(f, [i], { relation: scenario, proposals: [{ from: i, fullItem: f.workInput(1) }] });
        const next = completed(f, 1).i;
        const after = gateEvidence(f, [next], { gateOrdinal: 1, priorSnapshotIds: [before.snapshot.id] });
        linkRepair(f, i, next, before, after, scenario);
      }
    }
    const outcome = deriveRoutingOutcome(f.reopen().exportRoutingJournal(), i.id);
    assert.equal(outcome.label, scenario);
    assert.equal(outcome.binary, scenario === 'accepted' ? 'positive' : ['unknown', 're-implemented'].includes(scenario) ? 'excluded' : 'negative');
  });
}
test('cancellation audit plus all primary/child termination is separate from failure acknowledgement and wins after repair', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i); const r = finishCall(f, c);
  const evidence = cancellation(f, i, r);
  assert.throws(() => routingEvent(f.context, i, 'settled', { evidence: { ...evidence, terminationRefs: [] } }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  assert.throws(() => routingEvent(f.context, i, 'settled', { evidence: { ...evidence, audit: { ...evidence.audit, runId: 'wrong' } } }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  routingEvent(f.context, i, 'settled', { evidence });
  const before = gateEvidence(f, [i], { proposals: [{ from: i, fullItem: f.workInput(1) }], relation: 'repaired' });
  const next = completed(f, 1).i; const after = gateEvidence(f, [next], { gateOrdinal: 1, priorSnapshotIds: [before.snapshot.id] }); linkRepair(f, i, next, before, after);
  const outcome = deriveRoutingOutcome(f.reopen().exportRoutingJournal(), i.id);
  assert.equal(outcome.label, 'failed-or-cancelled'); assert.equal(outcome.binary, 'excluded'); assert.equal(outcome.censorReason, 'cancelled');
});
test('uncertain child termination prevents cancellation settlement and leaves unknown', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i); const r = finishCall(f, c);
  const child = c.observer.child({ parentIntentId: c.intent.id, callSite: 'repair' });
  const cr = finishCall(f, beginCall(f, i, { observer: child }), { unresolved: true });
  assert.throws(() => routingEvent(f.context, i, 'settled', { evidence: { ...cancellation(f, i, r), terminationRefs: [r.id, cr.id] } }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  assert.equal(deriveRoutingOutcome(f.reopen().exportRoutingJournal(), i.id).label, 'unknown');
});
test('failure proves exact prepared envelope/request; no success equality relaxation and lost ack cannot settle', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); finishCall(f, beginCall(f, i), { errored: true });
  const evidence = failure(f, i);
  for (const patch of [{ requestDigest: 'a'.repeat(64) }, { request: { ...evidence.request, dispatchToken: 'stale-token' } },
    { request: { ...evidence.request, envelope: {} } }, { response: { ...evidence.response, acknowledged: false } }]) {
    assert.throws(() => routingEvent(f.context, i, 'settled', { evidence: { ...evidence, ...patch } }));
  }
  const { proofKind, request, requestDigest, response, ...legacy } = evidence;
  assert.throws(() => routingEvent(f.context, i, 'settled', { evidence: { ...legacy, status: 'succeeded' } }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  assert.throws(() => f.issue(), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  routingEvent(f.context, i, 'settled', { evidence });
  assert.equal(routingIssuanceState(f.reopen().exportRoutingJournal(), i.id).state, 'settled');
  assert.equal(f.issue().priorRecordId, i.id);
});
for (const reconciliation of ['ordinal', 'unconfirmed', 'token-response', 'token-engine-witness']) {
  test(`gate ${reconciliation} retains its actual proof strength`, t => {
    const f = fixture(t); const { i } = completed(f); gateEvidence(f, [i], { reconciliation });
    assert.equal(deriveRoutingOutcome(f.reopen().exportRoutingJournal(), i.id).label, reconciliation.startsWith('token-') ? 'accepted' : 'unknown');
  });
}
test('ambiguous partition, lost downstream disposition and a prepared token never imply acceptance', t => {
  const f = fixture(t); const { i } = completed(f); gateEvidence(f, [i], { partitionCheck: 'ambiguous' });
  assert.equal(deriveRoutingOutcome(f.reopen().exportRoutingJournal(), i.id).label, 'unknown');
});
test('repair context is durable: fresh, first and second repair, same-epoch retry, missing lineage unknown', t => {
  const f = fixture(t); const { i: first } = completed(f);
  const g0 = gateEvidence(f, [first], { proposals: [{ from: first, fullItem: f.workInput(1) }], relation: 'repaired' });
  const { i: second } = completed(f, 1); const g1 = gateEvidence(f, [second], { proposals: [{ from: second, fullItem: f.workInput(2) }], relation: 'repaired', gateOrdinal: 1, priorSnapshotIds: [g0.snapshot.id] });
  linkRepair(f, first, second, g0, g1);
  const { i: third } = completed(f, 2); const g2 = gateEvidence(f, [third], { gateOrdinal: 2, priorSnapshotIds: [g1.snapshot.id] });
  linkRepair(f, second, third, g1, g2);
  const retry = f.issue({ epoch: 2 });
  const r = f.reopen().exportRoutingJournal();
  assert.deepEqual(deriveRoutingContext(r, first.id), { waveKind: 'fresh', ancestryUnknown: false, repairOfRecordId: null, repairDepth: 0, repairLineageRefs: [] });
  assert.equal(deriveRoutingContext(r, second.id).repairOfRecordId, first.id);
  assert.equal(deriveRoutingContext(r, second.id).repairDepth, 1);
  assert.equal(deriveRoutingContext(r, third.id).repairDepth, 2);
  assert.equal(deriveRoutingContext(r, retry.id).waveKind, 'retry');
  const fourth = f.issue({ epoch: 3 });
  const unknown = deriveRoutingContext(f.reopen().exportRoutingJournal(), fourth.id);
  assert.deepEqual(unknown, { waveKind: 'unknown', ancestryUnknown: true, repairOfRecordId: null, repairDepth: null, repairLineageRefs: null });
  // Same ordinary task/input text in every epoch is deliberately not a lineage key.
  assert.equal(third.logicalWaveId, fourth.logicalWaveId);
});
test('eligibility uses one complete population, excludes unsupported/unknown/cancelled and null executed tier claims', t => {
  const f = fixture(t); const { i } = completed(f); gateEvidence(f, [i]); acknowledgeAll(f);
  const row = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === i.id);
  assert.equal(routingEligible(row), true); assert.equal(routingEligible(row, { requireExecutedTier: true }), true);
  assert.equal(routingEligible(row, { key: 'another' }), false); assert.equal(routingEligible(row, { cohort: 'calibration' }), false);
  const next = f.issue(); f.launch(next); finishCall(f, beginCall(f, next, { transport: 'local-sdk' })); f.settle(next); gateEvidence(f, [next], { gateOrdinal: 1 }); acknowledgeAll(f);
  const local = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === next.id);
  assert.equal(routingEligible(local), true); assert.equal(routingEligible(local, { requireExecutedTier: true }), false);
  const observation = f.artifacts.recordRoutingObservation({ unsupportedReason: 'engine-evidence-unavailable', callSite: 'engine-region', evidenceSource: 'engine-audit', context: { scopedStep: 'engine', epoch: 0 } });
  const unsupported = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === observation.id);
  assert.equal(routingEligible(unsupported), false);
});

test('outcome revisions are produced from journal evidence, immutable by id and one validated latest chain', async t => {
  const { latestRoutingOutcome } = await import('../lib/routing-ledger.js');
  const f = fixture(t); const { i } = completed(f);
  const first = f.artifacts.recordRoutingOutcome(i.id); assert.equal(first.label, 'unknown');
  const before = f.bytes(); assert.deepEqual(f.artifacts.recordRoutingOutcome(i.id), first); assert.equal(f.bytes(), before);
  gateEvidence(f, [i]); const second = f.artifacts.recordRoutingOutcome(i.id);
  assert.equal(second.previousOutcomeId, first.id); assert.equal(second.label, 'accepted');
  assert.equal(latestRoutingOutcome(f.reopen().exportRoutingJournal(), i.id).id, second.id);
  assert.throws(() => f.artifacts.recordRoutingRecord({ ...second, label: 'repaired', binary: 'negative' }), { code: 'ROUTING_BINDING_DRIFT' });
  assert.throws(() => f.artifacts.recordRoutingRecord({ ...second, id: 'invented-outcome', previousOutcomeId: second.id, label: 'repaired', binary: 'negative' }), { code: 'ROUTING_BINDING_DRIFT' });
});

test('two plausible repair predecessors censor the stratum instead of choosing by task text or arrival', t => {
  const f = fixture(t); const a = completed(f).i;
  const ga = gateEvidence(f, [a], { proposals: [{ from: a, fullItem: f.workInput(1) }], relation: 'repaired', gateOrdinal: 0 });
  const b = completed(f).i;
  const gb = gateEvidence(f, [b], { proposals: [{ from: b, fullItem: f.workInput(1) }], relation: 'repaired', gateOrdinal: 1 });
  const c = completed(f, 1).i;
  const gc = gateEvidence(f, [c], { gateOrdinal: 2, priorSnapshotIds: [ga.snapshot.id, gb.snapshot.id] });
  linkRepair(f, a, c, ga, gc); linkRepair(f, b, c, gb, gc);
  const row = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === c.id);
  assert.deepEqual(row.context, { waveKind: 'unknown', ancestryUnknown: true, repairOfRecordId: null, repairDepth: null, repairLineageRefs: null });
  assert.equal(routingEligible(row), false);
});
test('cancellation remains settled after later usage completeness improves the same terminated call', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i);
  const r = c.observer.resolve(c.intent.id, { outcome: 'errored', launchOutcome: 'executed',
    terminationEvidence: { kind: 'return', intentId: c.intent.id, callId: c.intent.callId, evidence: { returned: true } } });
  routingEvent(f.context, i, 'settled', { evidence: cancellation(f, i, r) });
  finishCall(f, c, { errored: true });
  assert.equal(routingIssuanceState(f.reopen().exportRoutingJournal(), i.id).state, 'settled');
  assert.equal(deriveRoutingOutcome(f.reopen().exportRoutingJournal(), i.id).censorReason, 'cancelled');
});
