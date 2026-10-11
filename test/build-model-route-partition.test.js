// Split out of build-model-route-outcomes.test.js: wave builds are capped per file (WAVE_BUILDS_PER_FILE in the fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const records = f => Object.values(f.journal().routing.records);
test('real merge conflict records original approve and final revise/kill before each engine reset', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { checkpoint: false }); await f.run();
  const flips = records(f).filter(r => r.type === 'gate-disposition' && r.requestedDecision.decision !== r.finalProposedDecision.decision);
  assert.deepEqual(flips.map(r => r.finalProposedDecision.decision), ['revise', 'kill']);
  for (const flip of flips) {
    assert.equal(flip.requestedDecision.decision, 'approve');
    assert.match(flip.finalProposedDecision.rationale, /MERGE_WITNESS_PRECOMPUTE_FAILED/);
    assert.equal(flip.ownershipCheck, 'ambiguous');
    const before = f.gates.find(g => g.args[5] === flip.gateToken);
    assert.ok(Object.values(before.journal.routing.records).some(r => r.id === flip.snapshotId));
    assert.equal(Object.values(before.journal.routing.records).some(r => r.type === 'gate-acknowledgement' && r.dispositionId === flip.id), false);
  }
});

test('incomplete original finding partition remains unknown through the public gate producer', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { incompletePartition: true }); await f.run();
  const disposition = records(f).find(r => r.type === 'gate-disposition' && r.gateStepId === 'assess_gate');
  assert.ok(disposition); assert.equal(disposition.partitionCheck, 'ambiguous');
  const original = f.rows().filter(r => r.issuance?.scopedStep === 'execute' && r.issuance.epoch === 0);
  assert.equal(original.length, 2); assert.ok(original.every(r => r.outcome.label === 'unknown'));
});

test('engine-skipped item is captured without an invented issuance and remains unsafe to seal', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { added: true, skipB: true });
  // Revision admission must retain the S1a refusal for the unissued allocation.
  await assert.rejects(f.run(), { code: 'ROUTING_CONTINUATION_AMBIGUOUS' });
  const snapshot = records(f).find(r => r.type === 'wave-snapshot' && r.gateStepId === 'merge');
  const skipped = snapshot.waves.flatMap(w => w.items).find(i => i.fullItem.id === 'B');
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.issuanceId, null); assert.equal(skipped.issuanceToken, null);
  assert.equal(records(f).filter(r => r.type === 'issuance' && r.logicalTaskId === 'B').length, 0);
});
