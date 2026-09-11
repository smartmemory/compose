import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { materializeRoutingLedger, readRoutingLedger, reconcileRoutingPaidReceipts, readRoutingOwners, bindRoutingCalls, flushRoutingReceipts, routingEligible } from '../lib/routing-ledger.js';
import { fixture, beginCall, finishCall, acknowledgeAll, gateEvidence, consumerWave, continueRoutingFixture, linkRepair } from './helpers/routing-s1b-fixture.js';
const materialize = f => materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() });

test('incomplete rows are written; raw absent values stay null and late completion creates exactly one latest version', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i, { callId: 'late-primary' });
  finishCall(f, c, { unresolved: true });
  const first = materialize(f).find(r => r.recordId === i.id);
  assert.equal(first.completeness.state, 'incomplete'); assert.equal(first.cost.usd, null); assert.equal(first.cost.tokens, null); assert.equal(first.outcome.label, 'unknown');
  const path = join(f.cwd, '.compose/routing/ledger.jsonl'); const before = readFileSync(path, 'utf8');
  assert.equal(materialize(f)[0].version, 1); assert.equal(readFileSync(path, 'utf8'), before);
  finishCall(f, c, { usd: 0.42 }); f.settle(i); gateEvidence(f, [i]); acknowledgeAll(f);
  const updated = materialize(f)[0]; assert.equal(updated.version, 2); assert.equal(updated.cost.usd, 0.42); assert.equal(updated.completeness.state, 'complete');
  assert.equal(routingEligible(updated), true); assert.equal(readRoutingLedger(f).length, 1); assert.equal(readRoutingLedger(f)[0].version, 2);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
  assert.equal(materialize(f)[0].version, 2);
});
test('complete plus excluded spend reconciles unique paid receipts despite inclusive unsupported child costs', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i, { callId: 'primary', }); finishCall(f, c, { usd: 1 });
  const child = c.observer.child({ parentIntentId: c.intent.id, callSite: 'repair' }); const cc = beginCall(f, i, { observer: child, callId: 'child' }); finishCall(f, cc, { usd: 2, errored: true });
  f.settle(i); gateEvidence(f, [i]); acknowledgeAll(f);
  const rows = materialize(f); assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.recordId === i.id).cost.usd, 3);
  const excluded = rows.find(r => r.source === 'unsupported'); assert.equal(excluded.cost.usd, 2); assert.equal(routingEligible(excluded), false);
  const paid = reconcileRoutingPaidReceipts(rows); assert.equal(paid.length, 2); assert.equal(paid.reduce((sum, p) => sum + p.usd, 0), 3);
});
test('crashes before/after append and incomplete crash tails preserve complete rows and refuse malformed full lines', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); finishCall(f, beginCall(f, i));
  for (const hook of ['beforeLedgerAppend', 'afterLedgerAppend']) {
    const path = join(f.cwd, '.compose/routing/ledger.jsonl');
    if (existsSync(path)) rmSync(path);
    assert.throws(() => materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen(), hooks: { [hook]() { throw Error('publication crash'); } } }), /publication crash/);
    const rows = materialize(f); assert.equal(rows.length, 1); assert.equal(rows[0].version, 1);
  }
  const path = join(f.cwd, '.compose/routing/ledger.jsonl'); const before = readFileSync(path, 'utf8');
  appendFileSync(path, before.slice(0, 45));
  assert.throws(() => readRoutingLedger(f), { code: 'ROUTING_LEDGER_INCOMPLETE' });
  assert.equal(materialize(f)[0].version, 1); assert.equal(readFileSync(path, 'utf8'), before);
  const quarantines = readdirSync(join(f.cwd, '.compose/routing')).filter(p => p.includes('.tail-')); assert.equal(quarantines.length, 1);
  assert.equal(readFileSync(join(f.cwd, '.compose/routing', quarantines[0]), 'utf8'), before.slice(0, 45));
  appendFileSync(path, '{malformed}\n');
  assert.throws(() => materialize(f), { code: 'ROUTING_LEDGER_INVALID' });
});
function worker(f) {
  const script = `import {ConsumerFanoutArtifacts} from './lib/consumer-fanout.js'; import {materializeRoutingLedger} from './lib/routing-ledger.js'; const o=JSON.parse(process.argv[1]); const a=new ConsumerFanoutArtifacts(o); for(let n=0;n<3;n++) materializeRoutingLedger({cwd:o.targetCwd,artifacts:a});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...f.opts, hooks: {} })], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`child ${code}: ${output}`)));
  });
}
test('concurrent processes across different starts serialize one project ledger and same-owner writers', async t => {
  const f = fixture(t); const g = fixture(t, { cwd: f.cwd });
  f.issue(); g.issue();
  await Promise.all([worker(f), worker(g), worker(f), worker(g)]);
  const rows = readRoutingLedger(f); assert.equal(rows.length, 2); assert.ok(rows.every(r => r.version === 1));
  assert.equal(readFileSync(join(f.cwd, '.compose/routing/ledger.jsonl'), 'utf8').trim().split('\n').length, 2);
});
test('original-owner late completion and receipt delivery survive an actual S1a continuation without moving the spool', async t => {
  const f = fixture(t, { consumer: true }); const wave = await consumerWave(f, [{ id: 'A', description: 'same task', depends_on: [] }]);
  const i = wave.issuances[0]; f.launch(i); const c = beginCall(f, i, { callId: 'old-owner-call' }); finishCall(f, c, { unresolved: true }); f.settle(i);
  const continuation = await continueRoutingFixture(f, wave);
  assert.equal(continuation.artifacts.journal.pendingUsageReceipts, undefined);
  const initial = materializeRoutingLedger({ cwd: f.cwd, artifacts: continuation.artifacts }); assert.equal(initial[0].completeness.state, 'incomplete');
  const oldObserver = bindRoutingCalls({ artifacts: f.reopen(), issuanceId: i.id }); finishCall(f, { ...c, observer: oldObserver }, { usd: 4 });
  const deliveryRuns = [];
  await flushRoutingReceipts({ artifacts: f.reopen(), deliver: async runId => { deliveryRuns.push(runId); return { status: 'recorded' }; } });
  assert.deepEqual([...new Set(deliveryRuns)], [f.binding.runId]);
  const updated = materializeRoutingLedger({ cwd: f.cwd, artifacts: continuation.artifacts });
  assert.equal(updated[0].version, 2); assert.equal(updated[0].cost.usd, 4); assert.equal(updated[0].startId, f.start.startId);
  assert.equal(updated[0].calls[0].intent.ownerRunId, f.binding.runId);
  assert.equal(materializeRoutingLedger({ cwd: f.cwd, artifacts: continuation.artifacts })[0].version, 2);
  assert.equal(continuation.artifacts.journal.pendingUsageReceipts, undefined);
  rmSync(f.artifacts.journalPath);
  assert.throws(() => readRoutingOwners({ artifacts: continuation.artifacts }), { code: 'ROUTING_BINDING_MISSING' });
});
test('repair context recomputes from disk and freezes independent repair depths; in-memory edits never enter rows', t => {
  const f = fixture(t); const first = f.issue(); f.launch(first); finishCall(f, beginCall(f, first)); f.settle(first);
  const a = gateEvidence(f, [first], { proposals: [{ from: first, fullItem: f.workInput(1) }], relation: 'repaired' });
  const second = f.issue({ epoch: 1 }); f.launch(second); finishCall(f, beginCall(f, second)); f.settle(second);
  const b = gateEvidence(f, [second], { proposals: [{ from: second, fullItem: f.workInput(2) }], relation: 'repaired', gateOrdinal: 1, priorSnapshotIds: [a.snapshot.id] }); linkRepair(f, first, second, a, b);
  const third = f.issue({ epoch: 2 }); f.launch(third); finishCall(f, beginCall(f, third)); f.settle(third);
  const c = gateEvidence(f, [third], { gateOrdinal: 2, priorSnapshotIds: [b.snapshot.id] }); linkRepair(f, second, third, b, c);
  const retry = f.issue({ epoch: 2 }); const unknown = f.issue({ epoch: 3 });
  f.artifacts.journal.routing.records[second.admissionId].repairContext = { state: 'fresh', evidenceRefs: [] };
  const rows = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.artifacts });
  const context = id => rows.find(r => r.recordId === id).context;
  assert.equal(context(first.id).waveKind, 'fresh'); assert.equal(context(second.id).repairOfRecordId, first.id);
  assert.equal(context(third.id).repairDepth, 2); assert.equal(context(retry.id).waveKind, 'retry');
  assert.deepEqual(context(unknown.id), { waveKind: 'unknown', ancestryUnknown: true, repairOfRecordId: null, repairDepth: null, repairLineageRefs: null });
});
test('off and non-observed S1a allocate no S1b journal fields or ledger implicitly', t => {
  const off = fixture(t, { off: true }); assert.equal(off.start, null); assert.equal(existsSync(join(off.cwd, '.compose/routing')), false);
  const f = fixture(t, { observation: false }); const i = f.issue({ metadata: false });
  assert.equal(f.artifacts.journal.pendingUsageReceipts, undefined); assert.equal(i.observationVersion, undefined);
  assert.equal(existsSync(join(f.cwd, '.compose/routing/ledger.jsonl')), false);
});

test('same task name in a new source wave does not create repair lineage or default to fresh', async t => {
  const f = fixture(t, { consumer: true });
  const tasks = [{ id: 'A', description: 'identical task name', depends_on: [] }];
  const first = await consumerWave(f, tasks); const a = first.issuances[0]; f.launch(a); finishCall(f, beginCall(f, a)); f.settle(a); first.seal();
  const second = await consumerWave(f, tasks, 1); const b = second.issuances[0];
  assert.equal(a.logicalTaskId, b.logicalTaskId); assert.notEqual(a.logicalWaveId, b.logicalWaveId);
  const row = materialize(f).find(r => r.recordId === b.id);
  assert.deepEqual(row.context, { waveKind: 'unknown', ancestryUnknown: true, repairOfRecordId: null, repairDepth: null, repairLineageRefs: null });
  assert.equal(routingEligible(row), false);
});

test('ledger latest reader rejects duplicate/gapped versions and contradictory cost revisions', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); finishCall(f, beginCall(f, i));
  const row = materialize(f)[0]; const path = join(f.cwd, '.compose/routing/ledger.jsonl'); const before = readFileSync(path, 'utf8');
  for (const next of [row, { ...row, version: 3 }, { ...row, version: 2, cost: { ...row.cost, usd: 99 } }]) {
    writeFileSync(path, before + JSON.stringify(next) + '\n'); assert.throws(() => readRoutingLedger(f));
  }
  writeFileSync(path, before); assert.equal(readRoutingLedger(f).length, 1);
});
test('known connector nonexecution writes an incomplete row rather than inventing zero usage or dropping it', t => {
  const f = fixture(t); const i = f.issue(); f.launch(i); const c = beginCall(f, i);
  c.observer.resolve(c.intent.id, { outcome: 'errored', launchOutcome: 'not-executed',
    terminationEvidence: { kind: 'acknowledged-termination', intentId: c.intent.id, callId: c.intent.callId, evidence: { refusedBeforeRpc: true } } });
  acknowledgeAll(f);
  const row = materialize(f)[0]; assert.equal(row.completeness.state, 'incomplete'); assert.equal(row.cost.usd, null); assert.equal(row.calls[0].resolution.callId, c.intent.callId);
});
