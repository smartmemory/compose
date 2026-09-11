import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReceipt } from '../../stratum/ts/dist/engine/receipts.js';
import { fixture, beginCall, finishCall, acknowledgeAll, gateEvidence, linkRepair, evidenceRecord } from './helpers/routing-s1b-fixture.js';
import { bindRoutingCalls, deriveRoutingOutcome, deriveRoutingContext, materializeRoutingLedger, routingEligible, routingUsageEvidence, readRoutingLedger, reconcileRoutingPaidReceipts } from '../lib/routing-ledger.js';
import { canonicalRoutingJson, routingDigest } from '../lib/model-router.js';

function complete(f, epoch) {
  const i = f.issue({ epoch }); f.launch(i); finishCall(f, beginCall(f, i)); f.settle(i); return i;
}

test('r1: retained non-defective gate refuses independently conflicting repair link atomically', t => {
  const f = fixture(t); const a = complete(f, 0); const ga = gateEvidence(f, [a]);
  assert.deepEqual(ga.disposition.dispositions, [{ issuanceId: a.id, relation: 'retained', defective: false }]);
  assert.deepEqual(ga.disposition.lineage, []);
  const b = complete(f, 1); const gb = gateEvidence(f, [b], { gateOrdinal: 1, priorSnapshotIds: [ga.snapshot.id] });
  const bytes = f.bytes();
  assert.throws(() => linkRepair(f, a, b, ga, gb), { code: 'ROUTING_BINDING_DRIFT' });
  assert.equal(f.bytes(), bytes);
  const routing = f.reopen().exportRoutingJournal();
  assert.equal(deriveRoutingOutcome(routing, a.id).label, 'accepted');
  assert.equal(deriveRoutingContext(routing, b.id).waveKind, 'unknown');
});

test('r1: completed replacement must match an earlier proposal and its original predecessor and defect evidence', t => {
  const f = fixture(t); const a = complete(f, 0);
  // The proposal bytes exist before B is issued. The assertion never supplies its label to this gate.
  const ga = gateEvidence(f, [a], { relation: 'repaired', proposals: [{ from: a, fullItem: f.workInput(1) }] });
  const proposalBytes = f.bytes();
  const b = complete(f, 1); const gb = gateEvidence(f, [b], { gateOrdinal: 1 });
  const c = complete(f, 2); const gc = gateEvidence(f, [c], { gateOrdinal: 2 });
  assert.notEqual(ga.snapshot.ordinaryIssuances[0].itemDigest, gb.snapshot.ordinaryIssuances[0].itemDigest);
  assert.notEqual(gb.snapshot.ordinaryIssuances[0].itemDigest, gc.snapshot.ordinaryIssuances[0].itemDigest);
  assert.equal(JSON.parse(proposalBytes).routing.records[b.id], undefined);
  assert.throws(() => linkRepair(f, a, c, ga, gc), { code: 'ROUTING_BINDING_DRIFT' });
  assert.throws(() => linkRepair(f, b, c, ga, gc), { code: 'ROUTING_BINDING_DRIFT' });
  assert.throws(() => linkRepair(f, a, b, ga, gb, 're-implemented'), { code: 'ROUTING_BINDING_DRIFT' });
  const link = linkRepair(f, a, b, ga, gb);
  const valid = f.bytes(); const journal = JSON.parse(valid);
  const completedProposal = JSON.parse(valid);
  Object.assign(completedProposal.routing.records[ga.disposition.id].lineage[0], {
    toSnapshotId: gb.snapshot.id, toAdmissionId: b.admissionId, toIssuanceId: b.id,
  });
  writeFileSync(f.artifacts.journalPath, JSON.stringify(completedProposal));
  assert.throws(f.reopen, { code: 'ROUTING_BINDING_DRIFT' });
  journal.routing.records[ga.disposition.id].lineage = [];
  writeFileSync(f.artifacts.journalPath, JSON.stringify(journal));
  assert.throws(f.reopen, { code: 'ROUTING_BINDING_DRIFT' });
  writeFileSync(f.artifacts.journalPath, valid);
  assert.equal(f.reopen().readRoutingRecord(link.id).toIssuanceId, b.id);
  assert.equal(deriveRoutingOutcome(f.reopen().exportRoutingJournal(), a.id).label, 'repaired');
  for (const defective of [false, null]) {
    const bad = JSON.parse(valid); bad.routing.records[ga.disposition.id].dispositions[0].defective = defective;
    writeFileSync(f.artifacts.journalPath, JSON.stringify(bad));
    assert.throws(f.reopen, { code: 'ROUTING_BINDING_DRIFT' });
  }
  writeFileSync(f.artifacts.journalPath, valid);
  const snap = structuredClone(gb.snapshot); snap.ordinaryIssuances[0].fullItem.stepInputs.revision = 99;
  snap.ordinaryIssuances[0].itemDigest = routingDigest(snap.ordinaryIssuances[0].fullItem);
  assert.throws(() => f.artifacts.recordRoutingRecord({ ...snap, id: 'wrong-admitted-input' }), { code: 'ROUTING_BINDING_DRIFT' });
});

test('r1: defect relation alone cannot authorize a replacement without a retained proposal', t => {
  const f = fixture(t); const a = complete(f, 0); const ga = gateEvidence(f, [a], { relation: 'repaired' });
  const b = complete(f, 1); const gb = gateEvidence(f, [b], { gateOrdinal: 1 });
  assert.throws(() => linkRepair(f, a, b, ga, gb), { code: 'ROUTING_BINDING_DRIFT' });
  const defective = evidenceRecord(f, 'gate-disposition', { ...ga.disposition, id: 'different-gate', lineage: [] });
  const proposal = { ...ga.disposition, id: 'wrong-proposal-owner', lineage: [{ dispositionId: defective.id,
    relation: 'repaired', fromSnapshotId: ga.snapshot.id, fromAdmissionId: a.admissionId, fromIssuanceId: a.id,
    proposedTaskDigest: gb.snapshot.ordinaryIssuances[0].itemDigest, toSnapshotId: null, toAdmissionId: null, toIssuanceId: null }] };
  f.artifacts.recordRoutingRecord(defective);
  assert.throws(() => f.artifacts.recordRoutingRecord(proposal), { code: 'ROUTING_BINDING_DRIFT' });
});

test('r1: acknowledged retained retry keeps unknown ancestry censored across repeated retries and reload', t => {
  const f = fixture(t); const a = complete(f, 1); gateEvidence(f, [a]);
  assert.equal(deriveRoutingContext(f.reopen().exportRoutingJournal(), a.id).waveKind, 'unknown');
  for (const gateOrdinal of [1, 2]) {
    const b = complete(f, 1); gateEvidence(f, [b], { gateOrdinal }); acknowledgeAll(f);
    const row = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === b.id);
    assert.equal(row.outcome.label, 'accepted'); assert.equal(row.context.waveKind, 'retry');
    assert.equal(row.context.ancestryUnknown, true); assert.equal(row.context.repairDepth, null);
    assert.equal(row.completeness.state, 'incomplete');
    assert.ok(row.completeness.reasons.includes('unknown-repair-context'));
    assert.equal(routingEligible(row), false);
    assert.throws(() => routingEligible({ ...row, completeness: { state: 'complete', reasons: [] } }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
    assert.throws(() => routingEligible({ ...row, context: { ...row.context, ancestryUnknown: false } }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
    assert.deepEqual(readRoutingLedger(f).find(r => r.recordId === b.id), row);
  }
});

test('r1: exact retained submission/spool receipt contributes known excluded spend without connector identity', t => {
  const f = fixture(t);
  // This existing API resolves the acknowledged Compose submission, before buildReceipt.
  const receipt = { dispatchId: 'legacy:17', source: 'agent', usage: { tokens: 20, ms: 50, usd: 3 }, usdSource: 'reported' };
  const receiptBytes = canonicalRoutingJson(receipt);
  f.artifacts.recordPendingUsageReceipt({ dispatchId: receipt.dispatchId, receipt });
  f.artifacts.acknowledgeUsageReceipt({ dispatchId: receipt.dispatchId, seq: 17 });
  const input = { unsupportedReason: 'engine-fanout', evidenceSource: 'engine-receipt', evidenceRef: {
    ownerRunId: f.binding.runId, dispatchId: receipt.dispatchId, sequence: 17, payloadDigest: routingDigest(receipt) } };
  const before = f.bytes();
  for (const patch of [{ sequence: 18 }, { dispatchId: 'legacy:18' }, { payloadDigest: routingDigest({ other: true }) }, { ownerRunId: 'other-run' }]) {
    assert.throws(() => f.artifacts.recordRoutingObservation({ ...input, evidenceRef: { ...input.evidenceRef, ...patch } }));
    assert.equal(f.bytes(), before);
  }
  const observation = f.artifacts.recordRoutingObservation(input);
  assert.deepEqual(f.reopen().recordRoutingObservation(input), observation);
  const rows = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() });
  const row = rows[0]; assert.equal(rows.length, 1);
  assert.deepEqual(row.observation.engineReceiptEvidence.receipt, receipt);
  assert.equal(canonicalRoutingJson(row.observation.engineReceiptEvidence.receipt), receiptBytes);
  assert.equal(row.issuance, null); assert.equal(row.observation.issuanceToken, null); assert.deepEqual(row.calls, []);
  assert.equal(row.cost.tokens, 20); assert.equal(row.cost.durationMs, 50); assert.equal(row.cost.usd, 3);
  assert.deepEqual(row.cost.provenance, ['reported']); assert.equal(row.completeness.state, 'incomplete');
  assert.equal(row.outcome.binary, 'excluded'); assert.equal(routingEligible(row), false);
  const { sequence, ...ref } = input.evidenceRef;
  assert.deepEqual(reconcileRoutingPaidReceipts(readRoutingLedger(f)), [{ ref, tokens: 20, durationMs: 50, usd: 3 }]);
});

test('r1: extracted engine receipt writer retains partial amounts, validates reload, and reconciles with supported spend', t => {
  const f = fixture(t); const i = complete(f, 0); gateEvidence(f, [i]); acknowledgeAll(f);
  // Extraction consumes ReceiptRecord returned by the engine, not its ReceiptInput.
  const receipt = buildReceipt({ receiptCounter: 17 }, {
    dispatchId: 'legacy:18', source: 'judged', usage: { tokens: 11, usd: 2 }, usdSource: 'estimated',
  });
  const receiptBytes = canonicalRoutingJson(receipt);
  const input = { unsupportedReason: 'engine-judged', sequence: receipt.seq, receipt };
  const observation = f.artifacts.recordRoutingEngineReceipt(input);
  const bytes = f.bytes();
  assert.deepEqual(f.reopen().recordRoutingEngineReceipt(input), observation); assert.equal(f.bytes(), bytes);
  assert.throws(() => f.artifacts.recordRoutingEngineReceipt({ ...input, receipt: { ...input.receipt, amount: { usd: 99 } } }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  assert.equal(f.bytes(), bytes);
  const rows = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() });
  const engine = rows.find(r => r.source === 'unsupported');
  assert.deepEqual(engine.observation.engineReceiptEvidence.receipt, receipt);
  assert.equal(canonicalRoutingJson(engine.observation.engineReceiptEvidence.receipt), receiptBytes);
  assert.equal(canonicalRoutingJson(receipt), receiptBytes);
  assert.equal(engine.cost.tokens, 11); assert.equal(engine.cost.durationMs, null); assert.equal(engine.cost.usd, 2);
  assert.deepEqual(engine.cost.provenance, ['estimated']); assert.ok(engine.completeness.reasons.includes('missing-durationMs'));
  assert.equal(routingEligible(engine), false);
  const paid = reconcileRoutingPaidReceipts(rows); assert.equal(paid.length, 2);
  assert.equal(paid.reduce((sum, p) => sum + p.usd, 0), 2.12);
  assert.deepEqual(reconcileRoutingPaidReceipts([...rows, engine]), paid);
  for (const mutate of [
    o => { o.evidenceRef.sequence = 19; }, o => { o.evidenceRef.payloadDigest = routingDigest({ changed: true }); },
    o => { o.engineReceiptEvidence.usageEvidence.usd = 99; },
    o => { o.engineReceiptEvidence.usageEvidence.provenance = 'reported'; },
    o => { o.engineReceiptEvidence.receipt.amount.tokens = 99; },
  ]) {
    const j = JSON.parse(bytes); mutate(j.routing.records[observation.id]);
    writeFileSync(f.artifacts.journalPath, JSON.stringify(j));
    assert.throws(f.reopen, { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
    const corruptRow = structuredClone(engine); mutate(corruptRow.observation);
    assert.throws(() => reconcileRoutingPaidReceipts([corruptRow]), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  }
  writeFileSync(f.artifacts.journalPath, bytes);
  const observer = bindRoutingCalls({ artifacts: f.reopen(), observationId: observation.id });
  assert.throws(() => beginCall(f, i, { observer }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
});

for (const usdSource of ['reported', 'legacy']) {
  test(`r2: real persisted ${usdSource} engine receipt retains bytes and excluded spend across reload`, t => {
    const f = fixture(t);
    const receipt = buildReceipt({ receiptCounter: 16 }, {
      dispatchId: 'legacy:17', source: 'fanout', stepId: 'execute',
      usage: { tokens: 20, ms: 50, usd: 3 }, usdSource,
      split: { input: 12, output: 8 }, detail: { engineEvidence: 'retain unchanged' },
    });
    const receiptBytes = canonicalRoutingJson(receipt);
    const input = { receipt, sequence: receipt.seq, unsupportedReason: 'engine-fanout' };
    const observation = f.artifacts.recordRoutingEngineReceipt(input);
    const journalBytes = f.bytes();
    assert.deepEqual(f.reopen().recordRoutingEngineReceipt(input), observation);
    assert.equal(f.bytes(), journalBytes);
    const rows = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() });
    assert.equal(rows.length, 1);
    const [row] = readRoutingLedger(f);
    assert.deepEqual(row, rows[0]);
    assert.deepEqual(row.observation.engineReceiptEvidence.receipt, receipt);
    assert.equal(canonicalRoutingJson(row.observation.engineReceiptEvidence.receipt), receiptBytes);
    assert.equal(canonicalRoutingJson(receipt), receiptBytes);
    assert.equal(row.observation.evidenceRef.payloadDigest, routingDigest(receipt));
    assert.equal(row.observation.engineReceiptEvidence.usageEvidence.provenance, usdSource);
    assert.deepEqual(row.cost, { tokens: 20, durationMs: 50, usd: 3, provenance: [usdSource],
      paidReceiptRefs: [{ ownerRunId: f.binding.runId, dispatchId: receipt.dispatchId, payloadDigest: routingDigest(receipt) }] });
    assert.equal(row.issuance, null); assert.equal(row.observation.issuanceId, null);
    assert.equal(row.observation.issuanceToken, null); assert.deepEqual(row.calls, []);
    assert.equal(row.completeness.state, 'incomplete'); assert.equal(row.outcome.binary, 'excluded');
    assert.equal(routingEligible(row), false);
    assert.deepEqual(reconcileRoutingPaidReceipts([row, row]), [
      { ref: row.cost.paidReceiptRefs[0], tokens: 20, durationMs: 50, usd: 3 },
    ]);
    assert.throws(() => routingEligible({ ...row, completeness: { state: 'complete', reasons: [] } }),
      { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  });
}

test('r2: engine legacy provenance cannot enter connector evidence or connector ledger cost', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const call = beginCall(f, i);
  const before = f.bytes();
  assert.throws(() => call.observer.resolve(call.intent.id, {
    outcome: 'resolved', launchOutcome: 'executed',
    usage: routingUsageEvidence({ tokens: 20, durationMs: 50, usd: 3 }, { provenance: 'legacy' }),
    terminationEvidence: { kind: 'return', intentId: call.intent.id, callId: call.intent.callId, evidence: { returned: true } },
  }), { code: 'ROUTING_SCHEMA_INVALID' });
  assert.equal(f.bytes(), before);
  finishCall(f, call); f.settle(i); gateEvidence(f, [i]); acknowledgeAll(f);
  const [row] = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() });
  assert.equal(routingEligible(row), true);
  assert.throws(() => routingEligible({ ...row, cost: { ...row.cost, provenance: ['legacy'] } }),
    { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
});

test('r1: malformed censored ledger revisions cannot become latest or supply an eligible binary', t => {
  const f = fixture(t); const i = complete(f, 0); gateEvidence(f, [i]); acknowledgeAll(f);
  const row = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() })[0];
  assert.equal(routingEligible(row), true);
  const path = join(f.cwd, '.compose/routing/ledger.jsonl'); const bytes = readFileSync(path, 'utf8');
  for (const outcome of [
    { label: 'unknown', binary: 'positive', derivation: 'no-evidence', censorReason: 'missing-lineage' },
    { label: 'unknown', binary: 'negative', derivation: 'no-evidence', censorReason: 'missing-lineage' },
    { label: 'failed-or-cancelled', binary: 'negative', derivation: 'confirmed-cancellation', censorReason: 'cancelled' },
    { label: 're-implemented', binary: 'positive', derivation: 'linked-non-defect-replacement', censorReason: 'non-defect-supersession' },
  ]) {
    const invalid = { ...row, version: 2, outcome };
    writeFileSync(path, bytes + JSON.stringify(invalid) + '\n');
    assert.throws(() => readRoutingLedger(f), { code: 'ROUTING_BINDING_DRIFT' });
    assert.throws(() => routingEligible(invalid), { code: 'ROUTING_BINDING_DRIFT' });
  }
  writeFileSync(path, bytes); assert.deepEqual(readRoutingLedger(f), [row]);
});
