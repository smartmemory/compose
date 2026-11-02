/** Run with --test-timeout=900000. No model services, GUI, or installed-package mutation.
 *  Split from build-wave-golden.test.js (COMP-TEST-BWG-SPLIT-1) so no one file nears the suite per-file timeout. */
import { tier } from '../helpers/model-catalog.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resumeRouting } from '../../lib/build.js';
import { recoverRoutingEvidence } from '../../lib/routing-runtime.js';
import { reconcileRoutingPaidReceipts, routingEligible } from '../../lib/routing-ledger.js';
import { resolveTierThinking } from '../../server/model-tiers.js';
import { paidWaveGolden } from '../helpers/build-wave-golden-fixture.js';

for (const repair of ['failed', 'uncredited']) test(`d3 paid carry ${repair ?? 'primary'}: independent ownership survives reset and late receipt delivery`, { timeout: 180000 }, async t => {
  const f = await paidWaveGolden(t, { repair, late: true });
  await f.run();
  assert.equal(f.snapshot().status, 'completed');
  // LAUNCH order of A0/B0 is a race the harness deliberately leaves free: the
  // parallel execute/N scheduler decides who reaches the tool first (execute/1
  // can precede execute/0), and the latch at build-wave-golden-fixture.js:413
  // only waits until BOTH have arrived before forcing the RETURN order. Gate 3
  // requires ownership to survive adversarial A/B ordering, so launch order is
  // compared as a multiset -- membership and multiplicity, not sequence. The
  // `returned` assertion below IS a forced sequence and stays exact.
  assert.deepEqual(f.paidCalls.filter(k => /^[AB]/.test(k)).slice(0, repair ? 4 : 2).sort(),
    (repair ? ['A0', 'B0', 'B0repair', 'A0repair'] : ['A0', 'B0']).sort());
  if (repair) for (const report of f.reports.filter(r => r[1].startsWith('execute/'))) {
    assert.equal(report[2].output.summary, repair === 'success' ? 'repaired JSON' : '0 findings (0 must-fix, 0 should-fix, 0 nit).');
  }
  assert.deepEqual(f.returned.filter(k => /^[AB]/.test(k)), repair
    ? ['B0', 'A0', 'A0repair', 'B0repair', 'B1', 'B1repair'] : ['B0', 'A0', 'B1']);
  const before = f.rows(); assert.ok(before.length > 0);
  assert.ok(before.some(r => r.completeness.reasons.includes('unacknowledged-paid-receipt')));
  const original = f.journal();
  const expected = repair ? ['A0', 'B0', 'A0repair', 'B0repair', 'B1', 'B1repair'] : ['A0', 'B0', 'B1'];
  const callsBefore = [...f.paidCalls];
  f.enableDelivery();
  const routing = await resumeRouting({ runId: f.flowId, cwd: f.cwd, artifactRoot: f.artifactRoot,
    localSpec: f.spec, profiles: f.profiles, stratum: f.stratum });
  await recoverRoutingEvidence({ routing, artifacts: routing.artifacts, stratum: f.stratum, flowId: f.flowId, cwd: f.cwd, localSpec: f.spec });
  const rows = f.rows(), journal = f.journal(), all = Object.values(journal.routing.records);
  assert.deepEqual(f.paidCalls, callsBefore, 'recovery never reruns inference');
  for (const name of expected) {
    const issuance = all.find(r => r.type === 'issuance' && r.logicalTaskId === name[0] && r.epoch === Number(name[1]));
    const intent = all.find(r => r.type === 'call-intent' && r.callId === f.ids[name]);
    assert.ok(intent, name); assert.ok(issuance, name);
    assert.equal(intent.issuanceId ?? intent.parentRecordId, issuance.id, name);
    assert.equal(issuance.itemIndex, name === 'B0' || name === 'B0repair' ? 1 : 0, name);
    assert.equal(intent.issuanceId === null, name.endsWith('repair'));
    const receipt = f.snapshot().receipts.find(r => r.dispatchId === f.ids[name]);
    assert.ok(receipt, name); assert.equal(receipt.amount.usd, f.costs[name], name);
    assert.equal(receipt.detail.routing.intentId, intent.id);
    assert.equal(receipt.detail.routing.ownerRunId, f.flowId);
    assert.equal(receipt.detail.routing.issuanceId, intent.issuanceId);
    assert.equal(journal.pendingUsageReceipts.find(r => r.dispatchId === f.ids[name]).state, 'acknowledged');
    const call = rows.flatMap(r => r.calls).find(c => c.intent.id === intent.id);
    assert.equal(call.resolution.usageEvidence.usd, f.costs[name]);
    assert.equal(call.resolution.usageEvidence.tokens, 8);
    assert.deepEqual(receipt.split, { input: 3, output: 5, cacheRead: 2 });
    assert.equal(call.resolution.reportedModel, tier('codex', 'standard').model);
    assert.equal(call.resolution.reportedEffort, resolveTierThinking('standard', 'codex').effort);
    assert.equal(call.executedTier.value, 'standard');
    if (name.endsWith('repair')) assert.equal(call.resolution.outcome, repair === 'failed' ? 'errored' : 'resolved');
  }
  const owners = rows.filter(r => r.issuance?.scopedStep === 'execute');
  assert.equal(owners.length, 3);
  const byTask = (id, epoch) => owners.find(r => r.issuance.logicalTaskId === id && r.issuance.epoch === epoch);
  assert.equal(byTask('A', 0).cost.usd, repair ? 5 : 1);
  assert.equal(byTask('B', 0).cost.usd, repair ? 10 : 2);
  assert.equal(byTask('B', 1).cost.usd, repair ? 48 : 16);
  assert.equal(byTask('A', 0).outcome.label, 'accepted');
  assert.equal(byTask('B', 0).outcome.label, 'repaired');
  assert.equal(byTask('B', 1).context.repairOfRecordId, byTask('B', 0).recordId);
  assert.ok(owners.every(r => r.completeness.state === 'complete'));
  const unsupported = rows.filter(r => r.source === 'unsupported');
  assert.equal(unsupported.length, repair ? 3 : 0);
  assert.ok(unsupported.every(r => r.issuance === null && r.outcome.binary === 'excluded'));
  // Parent rows include child cost. Reconcile by unique original receipt, not row sums.
  const refs = new Map(rows.flatMap(r => r.calls).filter(c => c.resolution?.usageRef)
    .map(c => [c.resolution.usageRef.dispatchId, c.resolution.usageEvidence.usd]));
  const paid = f.snapshot().receipts.filter(r => r.detail?.routing?.kind === 'paid-call');
  assert.equal(refs.size, paid.length);
  const reconciled = reconcileRoutingPaidReceipts(rows);
  assert.equal(reconciled.length, paid.length);
  const completeRefs = new Set(rows.filter(r => routingEligible(r)).flatMap(r => r.cost.paidReceiptRefs).map(r => r.dispatchId));
  for (const name of ['A0', 'B0', 'B1']) assert.ok(completeRefs.has(f.ids[name]), name);
  const completeUsd = paid.filter(r => completeRefs.has(r.dispatchId)).reduce((sum, r) => sum + r.amount.usd, 0);
  const excludedUsd = paid.filter(r => !completeRefs.has(r.dispatchId)).reduce((sum, r) => sum + r.amount.usd, 0);
  assert.ok(completeUsd > 0); assert.ok(excludedUsd > 0);
  assert.equal(completeUsd + excludedUsd, (repair ? 63 : 19) + 1.75);
  assert.equal([...refs.values()].reduce((a, b) => a + b, 0), (repair ? 63 : 19) + 7 * 0.25);
  assert.equal(paid.reduce((sum, r) => sum + r.amount.usd, 0), [...refs.values()].reduce((a, b) => a + b, 0));
  for (const [id, record] of Object.entries(original.routing.records)) assert.deepEqual(journal.routing.records[id], record);
  const ledgerBytes = await readFile(join(f.cwd, '.compose/routing/ledger.jsonl'));
  await recoverRoutingEvidence({ routing, artifacts: routing.artifacts, stratum: f.stratum, flowId: f.flowId, cwd: f.cwd, localSpec: f.spec });
  assert.deepEqual(await readFile(join(f.cwd, '.compose/routing/ledger.jsonl')), ledgerBytes);
});
