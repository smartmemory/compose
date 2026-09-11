/** Immutable local routing admissions, issuance token index and execution event recovery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConsumerFanoutArtifacts } from '../lib/consumer-fanout.js';
import { preflightPipelineProfiles, profilesDigest } from '../lib/pipeline-profiles.js';
import { routingRecordId, routingDigest } from '../lib/model-router.js';
import { routingIssuanceState } from '../lib/routing-ledger.js';
const pin = { schemaVersion: 1, type: 'run-binding', id: 'binding', startId: 'start', rootDigest: 'a'.repeat(64), runId: 'run', revisionDigest: 'b'.repeat(64), specDigest: 'c'.repeat(64), inputDigest: 'd'.repeat(64), planIntentId: 'plan', previousRunId: null, continuationIntentId: null };
const base = (type, id) => ({ schemaVersion: 1, startId: pin.startId, rootDigest: pin.rootDigest, type, id });
const p = preflightPipelineProfiles({}, { flows: { main: { steps: [{ id: 'work', agent: 'codex' }] } } });
const route = { resolution: p.resolved.work, provenance: p.staticProvenance.work };
const logical = { scopedStep: 'main/work', stage: null, logicalWaveId: 'ordinary-work', logicalEpoch: 0, logicalTaskId: null };
function admission(id = 'admission') { return { ...base('admission', id), ...logical, allocationId: 'allocation', runId: 'run', epoch: 0, itemIndex: null, generation: null, inputDigest: pin.inputDigest, inputProvenance: { kind: 'input' }, candidate: route, baseline: route, proposal: route, admitted: route, refusal: null, would: route, repairContext: { state: 'not-evaluated-s1a' } }; }
function issuance(token = 'token') {
  const value = { ...base('issuance', 'temporary'), ...logical, key: 'statistical-key', admissionId: 'admission', runId: 'run', revisionDigest: pin.revisionDigest, epoch: 0, itemIndex: null, generation: null, issuanceToken: token, priorRecordId: null, selected: route, would: route };
  value.id = routingRecordId(value); return value;
}
function event(kind, sequence, record = issuance()) {
  return { ...base('issuance-event', `${record.id}-${sequence}`), event: kind, sequence, issuanceId: record.id, issuanceToken: record.issuanceToken,
    ...(kind === 'result-prepared' ? { envelope: { output: { done: true }, artifact: 'exact', dispatchToken: record.issuanceToken } } : {}),
    ...(kind === 'uncertain' ? { reason: 'RPC response lost' } : {}),
    ...(kind === 'settled' ? { evidence: { runId: record.runId, revisionDigest: record.revisionDigest, scopedStep: record.scopedStep, epoch: record.epoch,
      itemIndex: record.itemIndex, generation: record.generation, issuanceToken: record.issuanceToken, acceptedDispatchToken: record.issuanceToken, status: 'succeeded' } } : {}) };
}
function fixture(t, enabled = true, hooks = {}) {
  const root = mkdtempSync(join(tmpdir(), 'routing-journal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = { runId: 'run', targetCwd: join(root, 'target'), artifactRoot: join(root, 'artifacts'), revisionDigest: pin.revisionDigest,
    ...(enabled ? { routingBinding: pin } : {}), hooks };
  const artifacts = new ConsumerFanoutArtifacts(opts);
  return { artifacts, opts, reopen: () => new ConsumerFanoutArtifacts(opts), bytes: () => readFileSync(artifacts.journalPath, 'utf8') };
}
function ready(f) { f.artifacts.recordRoutingAdmissions([admission()]); f.artifacts.recordRoutingIssuance({ issuance: issuance() }); }

test('whole admission batch is atomic and immutable; ordinary routing requires no Git base', t => {
  const f = fixture(t); const before = f.bytes();
  assert.throws(() => f.artifacts.recordRoutingAdmissions([admission(), { ...admission('bad'), would: { ...route, extra: true } }])); assert.equal(f.bytes(), before);
  f.artifacts.recordRoutingAdmissions([admission(), admission('second')]);
  assert.deepEqual(f.reopen().readRoutingRecord('admission'), admission());
  assert.throws(() => f.artifacts.recordRoutingRecord({ ...admission(), allocationId: 'changed' }), { code: 'ROUTING_BINDING_DRIFT' });
  assert.throws(() => f.artifacts.readRoutingRecord('missing'), { code: 'ROUTING_BINDING_MISSING' });
});
test('issuance and token index commit together; same-key retry has a new immutable identity', t => {
  const f = fixture(t); ready(f); const bytes = f.bytes();
  f.artifacts.recordRoutingIssuance({ issuance: issuance() }); assert.equal(f.bytes(), bytes, 'idempotent replay changes no journal bytes');
  assert.equal(f.reopen().journal.routing.tokenIndex.token, issuance().id);
  const retry = { ...issuance('retry'), priorRecordId: issuance().id };
  assert.throws(() => f.artifacts.recordRoutingIssuance({ issuance: retry }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  f.artifacts.recordRoutingEvent(event('launch-intent', 0)); f.artifacts.recordRoutingEvent(event('settled', 1));
  f.artifacts.recordRoutingIssuance({ issuance: retry }); assert.equal(f.reopen().journal.routing.tokenIndex.retry, retry.id);
  assert.equal(f.artifacts.journal.pendingUsageReceipts, undefined);
});
test('journal refuses missing index, missing issuance and changed pins on every read', t => {
  const f = fixture(t); ready(f); const original = f.bytes();
  for (const mutate of [j => delete j.routing.tokenIndex.token, j => delete j.routing.records[issuance().id], j => delete j.routing.records.admission, j => j.routing.rootDigest = 'e'.repeat(64), j => delete j.routing.tokenIndex]) {
    const j = JSON.parse(original); mutate(j); writeFileSync(f.artifacts.journalPath, JSON.stringify(j)); assert.throws(f.reopen);
  }
  writeFileSync(f.artifacts.journalPath, original);
  assert.throws(() => new ConsumerFanoutArtifacts({ ...f.opts, routingBinding: { ...pin, rootDigest: 'e'.repeat(64) } }));
});
test('ordinary event recovery retains exact envelope, refuses duplicate launches and uncertain settlement', t => {
  const f = fixture(t); ready(f);
  assert.throws(() => f.artifacts.recordRoutingEvent(event('result-prepared', 0)));
  f.artifacts.recordRoutingEvent(event('launch-intent', 0));
  assert.equal(routingIssuanceState(f.reopen().journal.routing, issuance().id).state, 'launched');
  assert.throws(() => f.artifacts.recordRoutingEvent(event('launch-intent', 1)));
  f.artifacts.recordRoutingEvent(event('result-prepared', 1)); const bytes = f.bytes();
  f.artifacts.recordRoutingEvent(event('result-prepared', 1)); assert.equal(f.bytes(), bytes);
  const read = routingIssuanceState(f.reopen().journal.routing, issuance().id); assert.deepEqual(read.envelope, event('result-prepared', 1).envelope);
  assert.throws(() => f.artifacts.recordRoutingEvent({ ...event('result-prepared', 1), envelope: { output: 'changed' } }));
  const invalid = event('settled', 2); invalid.evidence.acceptedDispatchToken = null;
  assert.throws(() => f.artifacts.recordRoutingEvent(invalid), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
  f.artifacts.recordRoutingEvent(event('uncertain', 2)); f.artifacts.recordRoutingEvent(event('settled', 3));
  assert.equal(routingIssuanceState(f.reopen().journal.routing, issuance().id).state, 'settled');
});
test('dispatch routing link checks token/root/admission/identity and stays out of legacy receipt APIs', t => {
  const f = fixture(t); ready(f);
  const args = { dispatchToken: 'token', itemBinding: { item: { id: 'T' }, itemDigest: profilesDigest({ id: 'T' }) }, resolvedProfile: route.resolution,
    routing: { rootDigest: pin.rootDigest, recordId: issuance().id, admissionId: 'admission', logicalTaskId: null, logicalWaveId: logical.logicalWaveId, logicalEpoch: 0 } };
  assert.deepEqual(f.artifacts.recordDispatchBinding(args).routing, args.routing);
  assert.throws(() => f.artifacts.recordDispatchBinding({ ...args, routing: undefined,
    deferred: { flow: 'main', step: 'other-wave', stage: 0 } }), { code: 'ROUTING_BINDING_MISSING' });
  assert.throws(() => f.artifacts.recordDispatchBinding({ ...args, resolvedProfile: { ...route.resolution, modelID: 'different' } }), { code: 'ROUTING_BINDING_DRIFT' });
  assert.throws(() => f.artifacts.recordDispatchBinding({ ...args, routing: { ...args.routing, logicalEpoch: 1 } }));
  assert.throws(() => f.artifacts.recordDispatchBinding({ ...args, dispatchToken: 'other' }));
  assert.equal(f.artifacts.journal.pendingUsageReceipts, undefined);
});
test('off journal bytes remain unchanged on reopen and cannot acquire a routing root', t => {
  const f = fixture(t, false); const before = f.bytes(); f.reopen(); assert.equal(f.bytes(), before); assert.equal(JSON.parse(before).routing, undefined);
  assert.throws(() => new ConsumerFanoutArtifacts({ ...f.opts, routingBinding: pin }), { code: 'ROUTING_BINDING_MISSING' });
  assert.equal(f.bytes(), before);
  assert.throws(() => f.artifacts.recordRoutingRecord(admission()), { code: 'ROUTING_BINDING_MISSING' });
});
test('publication boundary crashes preserve either the old journal or the complete next record/index', t => {
  for (const boundary of ['beforeRoutingWrite', 'afterRoutingWrite']) {
    let enabled = false;
    const f = fixture(t, true, { [boundary]() { if (enabled) throw Error('injected crash'); } });
    f.artifacts.recordRoutingAdmissions([admission()]); enabled = true;
    assert.throws(() => f.artifacts.recordRoutingIssuance({ issuance: issuance() }), /injected crash/); enabled = false;
    const reopened = f.reopen(); const saved = reopened.journal.routing.records[issuance().id];
    assert.equal(Boolean(saved), boundary === 'afterRoutingWrite');
    reopened.recordRoutingIssuance({ issuance: issuance() }); assert.equal(f.reopen().journal.routing.tokenIndex.token, issuance().id);
  }
});

test('all admission/launch/result/settlement publication boundaries replay without a second launch', t => {
  for (const boundary of ['beforeRoutingWrite', 'afterRoutingWrite']) {
    for (const stage of ['admission', 'launch-intent', 'result-prepared', 'settled']) {
      let inject = false;
      const f = fixture(t, true, { [boundary]() { if (inject) throw Error('crash'); } });
      if (stage !== 'admission') ready(f);
      if (['result-prepared', 'settled'].includes(stage)) f.artifacts.recordRoutingEvent(event('launch-intent', 0));
      if (stage === 'settled') f.artifacts.recordRoutingEvent(event('result-prepared', 1));
      const sequence = { 'launch-intent': 0, 'result-prepared': 1, settled: 2 }[stage];
      const record = stage === 'admission' ? admission() : event(stage, sequence);
      const apply = artifacts => stage === 'admission' ? artifacts.recordRoutingAdmissions([record]) : artifacts.recordRoutingEvent(record);
      inject = true; assert.throws(() => apply(f.artifacts), /crash/); inject = false;
      const reopened = f.reopen();
      assert.equal(Object.hasOwn(reopened.journal.routing.records, record.id), boundary === 'afterRoutingWrite');
      apply(reopened); const bytes = f.bytes(); apply(f.reopen()); assert.equal(f.bytes(), bytes);
    }
  }
});
test('journal reopening detects a missing dispatch routing link and missing prepared-result event', t => {
  const f = fixture(t); ready(f); f.artifacts.recordRoutingEvent(event('launch-intent', 0)); f.artifacts.recordRoutingEvent(event('result-prepared', 1)); f.artifacts.recordRoutingEvent(event('settled', 2));
  const original = f.bytes(); const altered = JSON.parse(original);
  delete altered.routing.records[event('result-prepared', 1).id]; writeFileSync(f.artifacts.journalPath, JSON.stringify(altered));
  assert.throws(f.reopen, { code: 'ROUTING_BINDING_MISSING' });
  writeFileSync(f.artifacts.journalPath, original);
  const args = { dispatchToken: 'token', itemBinding: { item: {}, itemDigest: profilesDigest({}) }, resolvedProfile: route.resolution,
    routing: { rootDigest: pin.rootDigest, recordId: issuance().id, admissionId: 'admission', logicalTaskId: null, logicalWaveId: logical.logicalWaveId, logicalEpoch: 0 } };
  f.artifacts.recordDispatchBinding(args);
  const missing = JSON.parse(f.bytes()); delete missing.dispatchBindings.token.routing;
  writeFileSync(f.artifacts.journalPath, JSON.stringify(missing)); assert.throws(f.reopen, { code: 'ROUTING_BINDING_MISSING' });
  missing.dispatchBindings.token.deferred = { flow: 'main', step: 'other-wave', stage: 0 };
  writeFileSync(f.artifacts.journalPath, JSON.stringify(missing)); assert.throws(f.reopen, { code: 'ROUTING_BINDING_MISSING' });
});
test('same-admission reissuance cannot omit its prior link or fork an issuance chain', t => {
  const f = fixture(t); ready(f);
  assert.throws(() => f.artifacts.recordRoutingIssuance({ issuance: issuance('unlinked') }), { code: 'ROUTING_BINDING_MISSING' });
  f.artifacts.recordRoutingEvent(event('launch-intent', 0)); f.artifacts.recordRoutingEvent(event('settled', 1));
  const retry = { ...issuance('retry-linked'), priorRecordId: issuance().id };
  f.artifacts.recordRoutingIssuance({ issuance: retry });
  assert.throws(() => f.artifacts.recordRoutingIssuance({ issuance: { ...issuance('fork'), priorRecordId: issuance().id } }), { code: 'ROUTING_BINDING_DRIFT' });
});

for (const finalEvent of ['launch-intent', 'result-prepared']) {
  test(`loss of FINAL ${finalEvent} refuses reload and replay`, t => {
    const f = fixture(t); ready(f);
    f.artifacts.recordRoutingEvent(event('launch-intent', 0));
    if (finalEvent === 'result-prepared') f.artifacts.recordRoutingEvent(event('result-prepared', 1));
    const last = event(finalEvent, finalEvent === 'launch-intent' ? 0 : 1);
    const original = f.bytes();
    const altered = JSON.parse(original);
    delete altered.routing.records[last.id];
    writeFileSync(f.artifacts.journalPath, JSON.stringify(altered));
    assert.throws(f.reopen, { code: 'ROUTING_BINDING_MISSING' });
    assert.throws(() => f.artifacts.recordRoutingEvent(last), { code: 'ROUTING_BINDING_MISSING' });
    writeFileSync(f.artifacts.journalPath, original);
    assert.equal(routingIssuanceState(f.reopen().journal.routing, issuance().id).state, finalEvent === 'launch-intent' ? 'launched' : 'result-prepared');
  });
}
test('event tip cannot be lost, detached or reset independently of retained events', t => {
  const f = fixture(t); ready(f); f.artifacts.recordRoutingEvent(event('launch-intent', 0));
  const original = f.bytes();
  for (const mutate of [j => delete j.routing.eventTips, j => delete j.routing.eventTips[issuance().id],
    j => j.routing.eventTips[issuance().id].eventId = 'missing', j => j.routing.eventTips[issuance().id].count = 0]) {
    const altered = JSON.parse(original); mutate(altered); writeFileSync(f.artifacts.journalPath, JSON.stringify(altered));
    assert.throws(f.reopen, { code: 'ROUTING_BINDING_MISSING' });
  }
});

// New S1b coverage uses the actual S1a start/admission/issuance producers.
import { fixture as s1bFixture } from './helpers/routing-s1b-fixture.js';
for (const boundary of ['beforeRoutingWrite', 'afterRoutingWrite']) {
  test(`S1b atomic issuance/metadata/owner/index/tip survives ${boundary} crash`, t => {
    let enabled = false;
    const f = s1bFixture(t, { hooks: { [boundary](journal) {
      if (enabled && Object.values(journal?.routing?.records ?? {}).some(r => r.type === 'issuance')) throw Error('atomic publication crash');
    } } });
    enabled = true;
    assert.throws(() => f.issue({ token: 'atomic-token' }), /atomic publication crash/); enabled = false;
    let reopened = f.reopen();
    const before = reopened.exportRoutingJournal();
    assert.equal(Boolean(before.tokenIndex['atomic-token']), boundary === 'afterRoutingWrite');
    const issuance = f.issue({ token: 'atomic-token' }); reopened = f.reopen();
    assert.equal(issuance.observationVersion, 1);
    const routing = reopened.exportRoutingJournal();
    assert.deepEqual(routing.eventTips[issuance.id], { count: 0, eventId: null });
    const metadata = Object.values(routing.records).find(r => r.type === 'issuance-metadata');
    const owner = routing.records[metadata.ownerId];
    assert.equal(owner.ownerRunId, f.binding.runId); assert.equal(owner.journalLocator, f.artifacts.journalPath);
    const pending = reopened.journal.pendingUsageReceipts;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].dispatchId, `compose:route:${f.binding.runId}:atomic-token`);
    assert.deepEqual(Object.keys(pending[0].receipt).sort(), ['detail', 'dispatchId', 'source', 'stepId', 'usage']);
    assert.deepEqual(pending[0].receipt.usage, {}); assert.equal(pending[0].receipt.source, 'compose:route');
    assert.equal(pending[0].receipt.detail.routing.callId, null); assert.equal(pending[0].receipt.detail.routing.intentId, null);
    assert.equal(pending[0].receipt.detail.routing.selectedRouteRef, issuance.id);
    assert.equal(metadata.payloadDigest, routingDigest(pending[0].receipt));
    const bytes = f.bytes(); reopened.recordRoutingIssuance({ issuance, prepareMetadata: true }); assert.equal(f.bytes(), bytes);
    for (const corrupt of [j => delete j.pendingUsageReceipts, j => delete j.routing.records[metadata.id], j => delete j.routing.records[owner.id],
      j => j.pendingUsageReceipts[0].receipt.usage.tokens = 0, j => j.pendingUsageReceipts[0].dispatchId = 'wrong']) {
      const j = JSON.parse(bytes); corrupt(j); writeFileSync(f.artifacts.journalPath, JSON.stringify(j)); assert.throws(f.reopen);
    }
    writeFileSync(f.artifacts.journalPath, bytes);
  });
}
test('S1a unlaunched metadata upgrade is atomic; launched historical evidence is never certified retroactively', t => {
  const f = s1bFixture(t, { observation: false }); const i = f.issue({ metadata: false });
  assert.equal(i.observationVersion, undefined); assert.equal(f.artifacts.journal.pendingUsageReceipts, undefined);
  f.artifacts.prepareRoutingMetadata(i.id); assert.equal(f.reopen().journal.pendingUsageReceipts.length, 1);
  f.launch(i); f.settle(i);
  const retry = f.issue({ metadata: false }); f.launch(retry);
  assert.throws(() => f.artifacts.prepareRoutingMetadata(retry.id), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
});
