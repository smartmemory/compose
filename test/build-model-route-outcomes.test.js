import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, simpleSpec } from './helpers/routing-runtime-fixture.js';
import { routingIssuanceState } from '../lib/routing-ledger.js';
import { resumeRouting } from '../lib/build.js';
import { routingResetClosure } from '../lib/routing-gates.js';
import YAML from 'yaml';
import { readFileSync } from 'node:fs';
const records = f => Object.values(f.journal().routing.records);
test('ordinary-only no-ceiling Build records real connector and persisted engine receipts without blanket acceptance', async t => {
  const f = await runtimeFixture(t); await f.run();
  assert.equal(f.calls.length, 1);
  const issuance = records(f).find(r => r.type === 'issuance');
  const intent = records(f).find(r => r.type === 'call-intent');
  const metadata = f.receipts.find(([, r]) => r.source === 'compose:route')[1];
  assert.equal(metadata.dispatchId, `compose:route:${f.flowId}:${issuance.issuanceToken}`); assert.deepEqual(metadata.usage, {});
  assert.equal(f.receipts[0][1].dispatchId, metadata.dispatchId);
  const paid = f.snapshot().receipts.find(r => r.dispatchId === intent.callId);
  assert.equal(paid.amount.usd, 0.12); assert.equal(paid.detail.routing.issuanceId, issuance.id);
  assert.equal(f.rows()[0].cost.usd, 0.12); assert.equal(f.rows()[0].outcome.label, 'unknown');
});
test('metadata delivery refusal blocks the public Build producer before inference', async t => {
  const f = await runtimeFixture(t, { intercept(method, args) { if (method === 'before:usageReport' && args[1].source === 'compose:route') throw Error('offline'); } });
  await assert.rejects(f.run(), { code: 'ROUTING_RECEIPT_INCOMPLETE' }); assert.equal(f.calls.length, 0);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].outcome.label, 'unknown');
});
test('real engine contract rejection clears token and settles acknowledged original failure', async t => {
  const f = await runtimeFixture(t, { inference: () => ({ text: '{"wrong":true}', usage: { tokens: 3, ms: 5, usd: 0.2 }, usdSource: 'reported' }) });
  await f.run();
  const issuance = records(f).find(r => r.type === 'issuance');
  const settled = records(f).find(r => r.event === 'settled');
  assert.equal(settled.evidence.proofKind, 'failure-acknowledgement');
  assert.deepEqual(settled.evidence.request.envelope, f.reports[0][2]);
  assert.equal(f.snapshot().steps.work.acceptedDispatchToken, undefined);
  assert.equal(routingIssuanceState(f.journal().routing, issuance.id).state, 'settled');
  assert.equal(f.rows()[0].outcome.label, 'failed-or-cancelled');
});
test('lost failure response stays unknown and blocks resume after real token removal', async t => {
  const f = await runtimeFixture(t, { inference: () => ({ text: '{"wrong":true}' }), intercept(method) { if (method === 'stepDone') throw Error('lost response'); } });
  await assert.rejects(f.run(), /lost response/);
  assert.equal(f.rows()[0].outcome.label, 'unknown');
  await assert.rejects(resumeRouting({ runId: f.flowId, cwd: f.cwd, localSpec: f.spec, profiles: f.profiles, stratum: f.stratum, artifactRoot: f.artifactRoot }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  assert.equal(f.calls.length, 1);
});
test('public Build captures ordinary downstream approval before RPC and records exact token response', async t => {
  const spec = simpleSpec(); spec.flows.bug_fix.max_rounds = 2; spec.flows.bug_fix.steps.push({ id: 'assess_gate', after: ['work'], gate: { on_approve: 'finish', on_revise: 'work', on_kill: null, max_rounds: 2 } });
  spec.flows.bug_fix.steps.push({ id: 'finish', after: ['assess_gate'], agent: 'claude', do: 'FINISH', out: 'R' });
  spec.flows.bug_fix.output.from = '${finish.output}';
  let before;
  const f = await runtimeFixture(t, { spec, intercept(method, args, response, f) {
    if (method === 'before:gateResolve') { before = records(f); assert.equal(f.snapshot().steps.work.status, 'succeeded'); }
  } });
  await f.run();
  assert.ok(before.some(r => r.type === 'wave-snapshot')); assert.ok(before.some(r => r.type === 'gate-disposition'));
  assert.equal(before.some(r => r.type === 'gate-acknowledgement'), false);
  assert.equal(records(f).find(r => r.type === 'gate-acknowledgement').reconciliation, 'token-response');
  assert.equal(f.rows().find(r => r.issuance?.scopedStep === 'work').outcome.label, 'accepted');
});
test('bundled assess_gate reset closure includes non-adjacent execute and downstream waves', () => {
  const spec = YAML.parse(readFileSync('presets/team-fable-astra.stratum.yaml', 'utf8'));
  const steps = spec.flows[spec.flows.entry].steps;
  const gate = steps.find(s => s.id === 'assess_gate');
  const actual = routingResetClosure(steps, gate);
  assert.equal(actual.target, 'execute'); assert.ok(actual.closure.includes('execute')); assert.ok(actual.closure.includes('assess'));
  assert.equal(gate.after.includes('execute'), false);
});

for (const when of ['before:gateResolve', 'gateResolve']) test(`gate response loss at ${when} never upgrades an ordinal/prepared token to acceptance`, async t => {
  const spec = simpleSpec(); spec.flows.bug_fix.max_rounds = 2;
  spec.flows.bug_fix.steps.push({ id: 'assess_gate', after: ['work'], gate: { on_approve: 'finish', on_revise: 'work', on_kill: null } },
    { id: 'finish', after: ['assess_gate'], agent: 'claude', do: 'FINISH', out: 'R' }); spec.flows.bug_fix.output.from = '${finish.output}';
  const f = await runtimeFixture(t, { spec, intercept(method) { if (method === when) throw Error('gate response lost'); } });
  await assert.rejects(f.run(), /gate response lost/);
  const ack = records(f).find(r => r.type === 'gate-acknowledgement');
  assert.equal(ack.reconciliation, when.startsWith('before:') ? 'unconfirmed' : 'ordinal');
  assert.equal(f.rows().find(r => r.issuance?.scopedStep === 'work').outcome.label, 'unknown');
});

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

test('real multi-stage consumer stages emit unsupported observations with no route issuance', async t => {
  const { runtimeWaveFixture } = await import('./helpers/routing-runtime-fixture.js');
  const f = await runtimeWaveFixture(t, { multiStage: true, added: true }); await f.run();
  const intents = records(f).filter(r => r.type === 'call-intent' && r.observationId);
  const stages = intents.map(i => records(f).find(r => r.id === i.observationId)).filter(o => o.unsupportedReason === 'multi-stage-consumer');
  assert.ok(stages.some(o => o.stage === 0)); assert.ok(stages.some(o => o.stage === 1));
  assert.ok(intents.every(i => i.issuanceId === null));
  assert.equal(records(f).filter(r => r.type === 'issuance' && r.scopedStep === 'execute').length, 0);
});

test('real nested retry drives the scoped fixer without inventing a supported issuance for it', async t => {
  const spec = simpleSpec();
  spec.flows.bug_fix.steps = [{ id: 'nested', run: 'child', with: { task: '${input.task}' } }];
  spec.flows.bug_fix.output.from = '${nested.output}';
  spec.flows.child = { input: { task: 'string' }, steps: [{ id: 'work', agent: 'claude', do: 'WORK', out: 'R', attempts: 2 }], output: { from: '${work.output}', contract: 'R' } };
  const f = await runtimeFixture(t, { spec, inference: (_args, _f, ordinal) => ({ text: ordinal === 0 ? '{"wrong":true}' : '{"outcome":"complete","summary":"fixed"}', usage: { tokens: 2, ms: 3, usd: 0.1 }, usdSource: 'reported' }) });
  await f.run(); assert.equal(f.calls.length, 3);
  const observation = records(f).find(r => r.type === 'unsupported-observation' && r.unsupportedReason === 'scoped-fixer');
  assert.ok(observation); const fixer = records(f).find(r => r.type === 'call-intent' && r.observationId === observation.id);
  assert.equal(fixer.issuanceId, null); assert.ok(fixer.parentRecordId);
  assert.equal(records(f).filter(r => r.type === 'issuance').length, 2);
});

test('real Build policy revision keeps the original call and distinct unsupported replacement cost', async t => {
  const { seedCanonicalCatalog } = await import('./helpers/policy-catalog-stub.js');
  const { _clearCatalogCache } = await import('../lib/policy-catalog.js');
  const { writeFileSync, rmSync } = await import('node:fs'); const { join } = await import('node:path');
  const memoryDir = seedCanonicalCatalog(); t.after(() => { _clearCatalogCache(); rmSync(memoryDir, { recursive: true, force: true }); });
  const f = await runtimeFixture(t, { setup({ cwd }) { writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ version: 2, policyCheck: { memoryDir } })); },
    inference: (_args, _f, ordinal) => ({ text: JSON.stringify({ outcome: 'complete', summary: ordinal === 0 ? 'Want me to continue with the tests?' : 'Tests completed.' }), usage: { tokens: 2, ms: 3, usd: 0.2 }, usdSource: 'reported' }) });
  await f.run(); assert.equal(f.calls.length, 2);
  const observation = records(f).find(r => r.type === 'unsupported-observation' && r.unsupportedReason === 'policy-revision');
  assert.ok(observation); assert.ok(observation.parentRecordId);
  const parent = f.rows().find(r => r.recordId === observation.parentRecordId);
  assert.equal(parent.cost.usd, 0.4); assert.equal(f.reports.length, 1);
});

for (const fault of ['intent', 'resolution', 'receipt']) test(`public Build ${fault} integrity failure preserves durable uncertainty and never retries`, async t => {
  const { ConsumerFanoutArtifacts } = await import('../lib/consumer-fanout.js');
  const method = fault === 'intent' ? 'recordRoutingCallIntent' : fault === 'resolution' ? 'recordRoutingCallResolution' : 'recordPendingUsageReceipt';
  const original = ConsumerFanoutArtifacts.prototype[method];
  t.mock.method(ConsumerFanoutArtifacts.prototype, method, function (args) {
    if (fault !== 'receipt' || args.receipt?.detail?.routing?.kind === 'paid-call') {
      if (fault !== 'receipt') throw Error(`injected ${fault} persistence failure`);
      // Store an independently corrupted payload through the real spool, then
      // let the real producer attempt to store its original bytes.
      original.call(this, { ...args, receipt: { ...args.receipt, usage: { ...args.receipt.usage, usd: 97 } } });
    }
    return original.call(this, args);
  });
  const f = await runtimeFixture(t);
  await assert.rejects(f.run(), { code: fault === 'receipt' ? 'CONSUMER_EVIDENCE_MISMATCH' : 'ROUTING_PERSISTENCE_FAILED' });
  assert.equal(f.calls.length, fault === 'intent' ? 0 : 1); assert.equal(f.reports.length, 0);
  assert.equal(records(f).some(r => r.type === 'issuance-event' && r.event === 'settled'), false);
});

test('lost failure acknowledgement with the original token still live replays only the retained envelope', async t => {
  let offline = true;
  const f = await runtimeFixture(t, { inference: () => ({ text: '{"wrong":true}' }), intercept(method) {
    if (offline && method === 'before:stepDone') throw Error('request never reached engine');
  } });
  await assert.rejects(f.run(), /never reached engine/); assert.equal(f.calls.length, 1);
  const envelope = f.reports[0][2]; offline = false;
  await resumeRouting({ runId: f.flowId, cwd: f.cwd, localSpec: f.spec, profiles: f.profiles, stratum: f.stratum, artifactRoot: f.artifactRoot });
  assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 2); assert.deepEqual(f.reports[1][2], envelope);
  assert.ok(records(f).find(r => r.event === 'settled' && r.evidence.proofKind === 'failure-acknowledgement'));
});

test('runtime ingestion reads real persisted engine amounts without inventing a connector identity', async t => {
  const f = await runtimeFixture(t, { intercept: async (method, args, response, f) => {
    if (method === 'plan') await f.engine.usageReport(response.runId, { dispatchId: 'engine-independent', source: 'engine:fanout', usage: { tokens: 13, ms: 17, usd: 0.7 }, usdSource: 'reported' });
  } });
  await f.run();
  const row = f.rows().find(r => r.observation?.evidenceSource === 'engine-receipt');
  assert.ok(row, JSON.stringify({ receipts: f.snapshot().receipts, observations: records(f).filter(r => r.type === 'unsupported-observation') })); assert.equal(row.issuance, null); assert.equal(row.calls.length, 0); assert.equal(row.cost.usd, 0.7);
  const evidence = records(f).find(r => r.type === 'unsupported-observation' && r.evidenceSource === 'engine-receipt').engineReceiptEvidence;
  assert.equal(evidence.receipt.amount.usd, 0.7); assert.equal(evidence.receipt.usage, undefined);
});

test('a lost paid-receipt response retries the same canonical bytes and preserves one engine receipt', async t => {
  let lost = false;
  const f = await runtimeFixture(t, { intercept(method, args) {
    if (method === 'usageReport' && args[1].detail?.routing?.kind === 'paid-call' && !lost) { lost = true; throw Error('ack lost'); }
  } });
  await f.run(); assert.equal(f.calls.length, 1);
  const intent = records(f).find(r => r.type === 'call-intent');
  const submissions = f.receipts.filter(([, r]) => r.dispatchId === intent.callId);
  assert.equal(submissions.length, 2); assert.deepEqual(submissions[0], submissions[1]);
  assert.equal(f.snapshot().receipts.filter(r => r.dispatchId === intent.callId).length, 1);
  assert.equal(f.journal().pendingUsageReceipts.find(p => p.dispatchId === intent.callId).state, 'acknowledged');
});

test('real dirty-review gate runs an unsupported review fixer before revising', async t => {
  const spec = simpleSpec(); spec.contracts.Review = { clean: 'boolean', summary: 'string', findings: 'object[]', meta: 'object', lenses_run: 'string[]', auto_fixes: 'object[]', asks: 'object[]' };
  const flow = spec.flows.bug_fix; flow.max_rounds = 2;
  flow.steps = [{ id: 'review_merge', agent: 'claude', do: 'REVIEW_WORK', out: 'Review' },
    { id: 'review_gate', after: ['review_merge'], gate: { on_approve: null, on_revise: 'review_merge', on_kill: null } }];
  flow.output = { from: '${review_merge.output}', contract: 'Review' };
  const f = await runtimeFixture(t, { spec, profiles: { _reduceSteps: ['review_merge'] }, inference: (_args, f, ordinal) => {
    const output = ordinal === 1 ? { outcome: 'complete', summary: 'fixed' } : { clean: ordinal > 0, summary: 'review',
      findings: ordinal ? [] : [{ file: 'a.js', line: 1, severity: 'must-fix', finding: 'broken', lens: 'security', confidence: 9 }],
      meta: {}, lenses_run: ['security'], auto_fixes: [], asks: [] };
    return { text: JSON.stringify(output), usage: { tokens: 2, ms: 3, usd: 0.1 }, usdSource: 'reported' };
  } });
  await f.run();
  const observations = records(f).filter(r => r.type === 'unsupported-observation' && r.unsupportedReason === 'review-fixer');
  assert.equal(observations.length, 1); assert.equal(f.calls.length, 3);
  assert.equal(records(f).find(r => r.id === observations[0].parentRecordId).scopedStep, 'review_merge');
  const intent = records(f).find(r => r.type === 'call-intent' && r.observationId === observations[0].id);
  assert.equal(intent.issuanceId, null);
  assert.ok(records(f).some(r => r.type === 'gate-disposition' && r.finalProposedDecision.decision === 'revise'));
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

test('Build cancelled after a paid return materializes audit-plus-termination and terminal resume performs no call', async t => {
  const f = await runtimeFixture(t, { inference: async (_args, f) => {
    await f.engine.flowCancel(f.flowId);
    return { text: '{"outcome":"complete","summary":"done"}', usage: { tokens: 4, ms: 5, usd: 0.3 }, usdSource: 'reported' };
  } });
  await assert.rejects(f.run(), /cancelled/);
  assert.equal(f.rows()[0].outcome.label, 'failed-or-cancelled'); assert.equal(f.rows()[0].outcome.binary, 'excluded');
  assert.equal(f.rows()[0].cost.usd, 0.3);
  const before = f.calls.length;
  await assert.rejects(f.run({ resumeFlowId: f.flowId }), { code: 'FLOW_CANCELLED' });
  assert.equal(f.calls.length, before);
  assert.equal(f.rows().length, 1);
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

test('real engine-driven fanout recovers persisted receipts and coverage after the runner pauses', async t => {
  const { makeFakeCodexProject, waitForReceipt } = await import('./helpers/fake-codex-project.js');
  const { rmSync } = await import('node:fs');
  const fake = await makeFakeCodexProject({ featureCode: 'ENGINE-COVERAGE', spec: YAML.stringify(simpleSpec()),
    costUsd: 0.03, lanes: [{ name: 'engine-worker', text: '{"outcome":"complete","summary":"engine work"}' }] });
  t.after(() => { for (const path of [fake.workspace, fake.stateRoot, fake.binDir]) rmSync(path, { recursive: true, force: true }); });
  const spec = simpleSpec(); spec.contracts.Graph = { tasks: 'object[]' }; spec.flows.bug_fix.steps[0].out = 'Graph';
  spec.flows.bug_fix.steps.push({ id: 'engine_work', after: ['work'], fanout: { over: '${work.output.tasks}', dispatch: 'engine',
    concurrency: 2, isolation: 'none', require: 'all', merge: 'sequential', steps: [{ agent: 'codex', do: 'ENGINE ${item}', out: 'R' }] } });
  spec.flows.bug_fix.output = { from: '${work.output}', contract: 'Graph' };
  const f = await runtimeFixture(t, { spec, engineEnv: fake.env, inference: () => ({ text: '{"tasks":[{"id":"A"},{"id":"B"}]}' }) });
  await f.run();
  await waitForReceipt(() => f.snapshot().status === 'completed', 'engine workers to complete');
  await f.run({ resumeFlowId: f.flowId });
  assert.equal(f.calls.length, 1, 'only ordinary work crosses the Compose wrapper');
  assert.equal((await fake.readAgentPids()).length, 2, 'both engine workers actually launched');
  const observed = records(f).filter(r => r.type === 'unsupported-observation');
  const receipts = observed.filter(r => r.evidenceSource === 'engine-receipt');
  assert.equal(receipts.length, 2); assert.ok(receipts.every(r => r.issuanceId === null && r.parentRecordId === null));
  assert.ok(receipts.every(r => r.engineReceiptEvidence.receipt.dispatchId.startsWith('legacy:')));
  assert.ok(receipts.every(r => r.engineReceiptEvidence.receipt.usdSource === 'reported'));
  assert.deepEqual(receipts.map(r => r.itemIndex).sort(), [0, 1]);
  assert.ok(receipts.every(r => r.stage === 0 && Number.isInteger(r.generation)));
  assert.equal(receipts.reduce((n, r) => n + r.engineReceiptEvidence.receipt.amount.usd, 0), 0.06);
  assert.ok(observed.some(r => r.evidenceSource === 'engine-audit' && r.scopedStep === 'engine_work'));
});


test('policy revision transport disconnect cannot settle or approve its parent and resume refuses reissue', async t => {
  const { seedCanonicalCatalog } = await import('./helpers/policy-catalog-stub.js');
  const { _clearCatalogCache } = await import('../lib/policy-catalog.js');
  const { writeFileSync, rmSync } = await import('node:fs'); const { join } = await import('node:path');
  const memoryDir = seedCanonicalCatalog(); t.after(() => { _clearCatalogCache(); rmSync(memoryDir, { recursive: true, force: true }); });
  const spec = simpleSpec(); spec.flows.bug_fix.max_rounds = 2;
  spec.flows.bug_fix.steps.push({ id: 'assess_gate', after: ['work'], gate: { on_approve: null, on_revise: 'work', on_kill: null } });
  const f = await runtimeFixture(t, { spec,
    setup({ cwd }) { writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ version: 2, policyCheck: { memoryDir } })); },
    inference: (_args, _f, ordinal) => {
      if (ordinal === 1) throw Error('revision transport disconnected');
      return { text: JSON.stringify({ outcome: 'complete', summary: 'Want me to continue with the tests?' }), usage: { tokens: 2, ms: 3, usd: 0.2 }, usdSource: 'reported' };
    } });
  await assert.rejects(f.run(), /revision transport disconnected/);
  const parent = f.rows().find(r => r.issuance?.scopedStep === 'work');
  assert.equal(parent.outcome.label, 'unknown'); assert.equal(parent.outcome.binary, 'excluded');
  assert.deepEqual(parent.calls.map(c => c.resolution.outcome).sort(), ['resolved', 'unresolved']);
  assert.equal(f.reports.length, 0); assert.equal(records(f).some(r => r.event === 'settled'), false);
  await assert.rejects(f.run({ resumeFlowId: f.flowId }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  assert.equal(f.calls.length, 2);
});

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

test('public Build settles unchanged real Codex SDK output with combined event model and split telemetry', async t => {
  const { realCodexTool } = await import('./helpers/real-codex-tool.js');
  const spec = simpleSpec(); spec.flows.bug_fix.steps[0].agent = 'codex';
  const f = await runtimeFixture(t, { spec });
  f.connector._testClient.callTool = realCodexTool({ onCall: args => f.calls.push(structuredClone(args)) });
  await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 1);
  assert.equal(f.snapshot().steps.work.status, 'succeeded');
  const issuance = records(f).find(r => r.type === 'issuance');
  assert.equal(routingIssuanceState(f.journal().routing, issuance.id).state, 'settled');
  const row = f.rows().find(r => r.issuance?.scopedStep === 'work');
  assert.equal(row.cost.usd, 0.2); assert.equal(row.cost.paidReceiptRefs.length, 1);
  assert.notEqual(row.outcome.censorReason, 'uncertain-settlement');
});

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
