// Split out of build-model-route-outcomes.test.js: wave builds are capped per file (WAVE_BUILDS_PER_FILE in the fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const records = f => Object.values(f.journal().routing.records);
test('real multi-stage consumer stages emit unsupported observations with no route issuance', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { multiStage: true, added: true }); await f.run();
  const intents = records(f).filter(r => r.type === 'call-intent' && r.observationId);
  const stages = intents.map(i => records(f).find(r => r.id === i.observationId)).filter(o => o.unsupportedReason === 'multi-stage-consumer');
  assert.ok(stages.some(o => o.stage === 0)); assert.ok(stages.some(o => o.stage === 1));
  assert.ok(intents.every(i => i.issuanceId === null));
  assert.equal(records(f).filter(r => r.type === 'issuance' && r.scopedStep === 'execute').length, 0);
});

test('configured hold materializes incomplete evidence without promoting merge checkpoints to acceptance', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { hold: true }); await f.run();
  assert.equal(f.snapshot().steps.assess_gate.status, 'waiting_gate');
  assert.equal(f.captured.length, 0, 'hold performs no gate RPC or pre-reset capture');
  const work = f.rows().filter(r => r.issuance?.scopedStep === 'execute');
  assert.equal(work.length, 2); assert.ok(work.every(r => r.outcome.label === 'unknown'));
  assert.equal(records(f).find(r => r.type === 'gate-disposition' && r.gateStepId === 'merge').dispositions.length, 0);
});

test('a consumer transport loss remains unsettled and cannot silently retry the item', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { failBTransport: true });
  await assert.rejects(f.run(), /lost consumer transport/);
  const b = records(f).find(r => r.type === 'issuance' && r.logicalTaskId === 'B');
  assert.ok(b); assert.equal(f.rows().find(r => r.recordId === b.id).outcome.label, 'unknown');
  assert.equal(f.reports.filter(([, , , token]) => token === b.issuanceToken).length, 0);
  assert.equal(records(f).filter(r => r.type === 'call-intent' && r.issuanceId === b.id).length, 1);
});
