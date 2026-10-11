// Split out of build-model-route-outcomes.test.js: wave builds are capped per file (WAVE_BUILDS_PER_FILE in the fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const records = f => Object.values(f.journal().routing.records);
for (const files of [['c.txt'], ['a.txt', 'c.txt'], ['b.txt', 'c.txt']]) {
  test(`two real carry resets preserve residual B0 ownership for ${files.join('+')}`, async t => {
    const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
    const f = await runtimeWaveFixture(t, { repairRounds: 2,
      initialBFiles: ['b.txt', 'c.txt'], repairFilesByRound: [['b.txt'], files] });
    await f.run();
    assert.equal(f.captured.length, 3);
    const work = f.rows().filter(r => r.issuance?.scopedStep === 'execute');
    const b0 = work.find(r => r.issuance.logicalTaskId === 'B' && r.issuance.epoch === 0);
    const b1 = work.find(r => r.issuance.epoch === 1);
    const b2 = work.find(r => r.issuance.epoch === 2);
    assert.equal(b1.context.repairOfRecordId, b0.recordId);
    assert.equal(b1.context.repairDepth, 1);
    const second = records(f).find(r => r.type === 'gate-disposition' && r.gateStepId === 'assess_gate' && r.gateOrdinal === 1);
    assert.equal(second.partitionCheck, 'valid');
    if (files.length === 1) {
      assert.equal(second.ownershipCheck, 'valid');
      assert.equal(second.lineage.length, 1);
      assert.equal(second.lineage[0].fromIssuanceId, b0.recordId);
      assert.equal(b2.context.repairOfRecordId, b0.recordId);
      assert.equal(b2.context.repairDepth, 1);
    } else {
      assert.equal(second.ownershipCheck, 'ambiguous');
      assert.equal(second.lineage.length, 0);
      assert.equal(b2.context.repairOfRecordId, null);
      assert.equal(b2.context.ancestryUnknown, true);
    }
    // Ownership projection must never rewrite the retained historical task.
    const historical = records(f).filter(r => r.type === 'wave-snapshot').flatMap(r => r.waves.flatMap(w => w.items))
      .filter(i => i.issuanceId === b0.recordId);
    assert.ok(historical.length > 1);
    for (const item of historical) assert.deepEqual(item.fullItem.files_owned, ['b.txt', 'c.txt']);
  });
}
