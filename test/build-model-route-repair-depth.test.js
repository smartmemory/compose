// Split out of build-model-route-outcomes.test.js: wave builds are capped per file (WAVE_BUILDS_PER_FILE in the fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('two real carry repairs retain A and bind B0 to B1 to B2 with repair depth two', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { repairRounds: 2 }); await f.run();
  assert.equal(f.captured.length, 3);
  const work = f.rows().filter(r => r.issuance?.scopedStep === 'execute');
  const a = work.find(r => r.issuance.logicalTaskId === 'A');
  const b = work.filter(r => r.issuance.logicalTaskId === 'B').sort((a, b) => a.issuance.epoch - b.issuance.epoch);
  assert.equal(a.outcome.label, 'accepted'); assert.equal(b.length, 3);
  assert.deepEqual(b.map(r => r.outcome.label), ['repaired', 'repaired', 'accepted']);
  assert.equal(b[1].context.repairOfRecordId, b[0].recordId);
  assert.equal(b[2].context.repairOfRecordId, b[1].recordId); assert.equal(b[2].context.repairDepth, 2);
});
