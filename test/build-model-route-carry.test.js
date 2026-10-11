// Split out of build-model-route-outcomes.test.js: wave builds are capped per file (WAVE_BUILDS_PER_FILE in the fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const records = f => Object.values(f.journal().routing.records);
for (const added of [false, true]) test(`real Build carry reset retains A and ${added ? 'adds C without rejecting B' : 'repairs old B while new B moves to index zero'}`, async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { added }); await f.run();
  assert.equal(f.captured.length, 2, JSON.stringify({ events: f.snapshot().events.filter(e => e.type === "gate_resolved"), merges: f.journal().mergeTransactions }));
  const before = f.captured[0]; assert.equal(before.before.steps.execute.fanout.items.length, 2);
  const snapshots = Object.values(before.journal.routing.records).filter(r => r.type === 'wave-snapshot' && r.gateStepId === 'assess_gate');
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].waves[0].items.length, 2);
  const work = f.rows().filter(r => r.issuance?.scopedStep === 'execute');
  const oldA = work.find(r => r.issuance.epoch === 0 && r.issuance.itemIndex === 0);
  const oldB = work.find(r => r.issuance.epoch === 0 && r.issuance.itemIndex === 1);
  const next = work.find(r => r.issuance.epoch === 1);
  assert.equal(oldA.outcome.label, 'accepted'); assert.equal(oldB.outcome.label, added ? 'accepted' : 'repaired');
  assert.equal(next.issuance.itemIndex, 0); assert.equal(next.issuance.logicalTaskId, added ? 'C' : 'B');
  if (!added) assert.equal(next.context.repairOfRecordId, oldB.recordId);
});
test('actual carry provenance recovers a lost revise response as a validated engine token witness', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { lostRevise: true }); await f.run();
  const ack = records(f).find(r => r.type === 'gate-acknowledgement' && r.reconciliation === 'token-engine-witness');
  assert.ok(ack); assert.equal(ack.witness.engineEvidence.consumedGateToken, f.captured[0].args[5]);
  assert.ok(f.rows().some(r => r.outcome.label === 'repaired'));
});
