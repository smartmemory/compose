import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareCheckpoint, publishCheckpoint, readCheckpointRef, worktreeBaseFor, squashOntoBase, removeCheckpointRef, reconcileCheckpoint } from '../lib/wave-checkpoint.js';
import { ConsumerFanoutArtifacts, recoverAdvancedConsumerArtifacts, verifyConsumerRunRevision, snapshotWorkingTree } from '../lib/consumer-fanout.js';
import { profilesDigest } from '../lib/pipeline-profiles.js';
import { consumerWaveFixture, git } from './helpers/consumer-wave-fixture.js';
function prepare(f) {
  return prepareCheckpoint({ cwd: f.cwd, ref: f.ref, parentCommit: f.base, workingTree: true, message: 'run wave 1 gate-token' });
}
test('checkpoint and squash preserve HEAD, index bytes, branch, staged/unstaged split and dirty parent', t => {
  const f = consumerWaveFixture(t);
  f.write('owned.txt', 'staged\n'); git(f.cwd, ['add', 'owned.txt']); f.write('owned.txt', 'unstaged\n');
  f.write('dirty.txt', 'initial dirt\n');
  const index = readFileSync(join(f.cwd, '.git', 'index'));
  const branch = git(f.cwd, ['symbolic-ref', 'HEAD']);
  const tree = snapshotWorkingTree(f.cwd);
  const checkpoint = prepare(f);
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), null);
  publishCheckpoint({ cwd: f.cwd, ref: f.ref, expected: null, commit: checkpoint.commit });
  assert.equal(squashOntoBase({ cwd: f.cwd, ref: f.ref, base: f.base }), tree);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base); assert.equal(git(f.cwd, ['symbolic-ref', 'HEAD']), branch);
  assert.deepEqual(readFileSync(join(f.cwd, '.git', 'index')), index); assert.equal(snapshotWorkingTree(f.cwd), tree);
  assert.equal(prepareCheckpoint({ cwd: f.cwd, ...checkpoint }).commit, checkpoint.commit);
});
test('CAS refuses unexpected refs; fresh deletes only exact expected flow ref', t => {
  const f = consumerWaveFixture(t); const checkpoint = prepare(f);
  publishCheckpoint({ cwd: f.cwd, ref: f.ref, commit: checkpoint.commit, expected: null });
  assert.throws(() => publishCheckpoint({ cwd: f.cwd, ref: f.ref, commit: checkpoint.commit, expected: null }), e => e.code === 'WAVE_CHECKPOINT_DIVERGED');
  const other = `${f.ref}-other`; publishCheckpoint({ cwd: f.cwd, ref: other, commit: checkpoint.commit, expected: null });
  assert.throws(() => removeCheckpointRef({ cwd: f.cwd, ref: f.ref, expected: f.base }));
  removeCheckpointRef({ cwd: f.cwd, ref: f.ref, expected: checkpoint.commit });
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), null);
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: other }), checkpoint.commit);
});
const rows = [
  [null, null, 'ADMIT_FROM_BASE'], [{ gateOutcome: undefined }, null, 'RECOVER_WAITING_GATE'],
  [{ gateOutcome: 'approve' }, null, 'PREPARE_AND_PUBLISH'],
  [{ commit: 'J', parentCommit: 'P', state: 'prepared' }, 'P', 'REPLAY_AND_PUBLISH'],
  [{ commit: 'J', parentCommit: 'P', waveNumber: 1, state: 'prepared' }, null, 'REPLAY_AND_PUBLISH'],
  [{ commit: 'J', state: 'prepared' }, 'J', 'MARK_PUBLISHED'],
  [{ commit: 'J', state: 'published' }, 'J', 'ALREADY_PUBLISHED'],
  [{ commit: 'J', knownAncestorCommits: ['A'] }, 'A', 'RECONCILE_IN_ORDER'],
  [{ commit: 'J' }, 'unknown', 'WAVE_CHECKPOINT_DIVERGED'],
  [{ evidenceMissing: true }, null, 'WAVE_CHECKPOINT_EVIDENCE_MISSING'],
  [{ commit: 'J', state: 'published', terminal: true }, 'J', 'PRESERVE_PUBLISHED'],
];
for (const [journalEntry, refValue, action] of rows) test(`recovery table: ${action} (${refValue})`, () => assert.equal(reconcileCheckpoint({ journalEntry, refValue }), action));
async function approvedWave(f, { empty = false } = {}) {
  f.artifacts.bindRunRevision({ profilesDigest: 'profiles' });
  f.artifacts.initializeWave({ ref: f.ref, profilesDigest: 'profiles' });
  const d = f.descriptor();
  const { worktree } = f.artifacts.reconcileDescriptor(d, f.audit(d, 'running'));
  if (!empty) f.write('owned.txt', 'wave one\n', worktree);
  f.artifacts.prepareIssuance(d, { output: { outcome: 'success' } }, { finalStage: true, itemBinding: f.binding(d) });
  const tx = f.artifacts.prepareMerge({ gateStepId: 'merge', gateToken: 'gate-1', fanoutStepId: 'execute', audit: f.audit(d) });
  await f.artifacts.applyMerge(tx);
  return { d, tx, audit: { ...f.audit(d, 'succeeded', { merge: { status: 'waiting_gate', gateToken: 'gate-2' } }),
    events: [{ type: 'gate_resolved', stepId: 'merge', detail: { decision: 'approve' } }] } };
}
for (const empty of [false, true]) test(`approved old gate recovers while later round waits, preserving later edits (empty=${empty})`, async t => {
  const f = consumerWaveFixture(t); const { d, audit } = await approvedWave(f, { empty });
  f.write('later.txt', 'post-wave review\n');
  assert.equal(recoverAdvancedConsumerArtifacts({ ...f.options, audit }), true);
  const artifacts = new ConsumerFanoutArtifacts(f.options);
  const checkpoint = artifacts.journal.wave.checkpoints[0];
  assert.equal(checkpoint.state, 'published'); assert.equal(checkpoint.gateOrdinal, 0);
  assert.equal(readFileSync(join(f.cwd, 'later.txt'), 'utf8'), 'post-wave review\n');
  assert.equal(artifacts.journal.issuances[0].diff !== null, true, 'retain payload until evidence receipt');
  assert.equal(worktreeBaseFor({ journal: artifacts.journal, ref: checkpoint.commit }), checkpoint.commit);
  const next = f.descriptor({ id: 'T2', files_owned: ['new.txt'] }, { generation: 2, epoch: 1, dispatchToken: 'dispatch-2' });
  const ready = artifacts.reconcileDescriptor(next, f.audit(next, 'running'));
  assert.equal(git(ready.worktree, ['rev-parse', 'HEAD']), checkpoint.commit);
  assert.equal(readFileSync(join(ready.worktree, 'owned.txt'), 'utf8'), empty ? 'base\n' : 'wave one\n');
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  assert.equal(new ConsumerFanoutArtifacts(f.options).journal.wave.checkpoints.length, 1);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
});
test('prepared then published-ref crash resumes with one identical commit; missing replay payload refuses', async t => {
  const f = consumerWaveFixture(t); const { tx, audit } = await approvedWave(f);
  const cp = prepareCheckpoint({ cwd: f.cwd, ref: f.ref, parentCommit: f.base, tree: tx.witnessChain.at(-1), message: 'gate-1' });
  f.artifacts.recordPreparedCheckpoint({ ...cp, gateStepId: 'merge', gateToken: 'gate-1', gateOrdinal: 0,
    waveNumber: 1, baselineTree: tx.baselineTree, orderedDispatchTokens: tx.orderedDiffs.map(d => d.dispatchToken) });
  publishCheckpoint({ cwd: f.cwd, ref: f.ref, expected: null, commit: cp.commit });
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  const recovered = new ConsumerFanoutArtifacts(f.options);
  assert.equal(recovered.journal.wave.checkpoints[0].commit, cp.commit);
  recovered.markCheckpointPublished({ gateToken: 'gate-1', commit: cp.commit, evidenceReceiptId: 'receipt' });
  recovered.cleanupWorktrees('evidence acknowledged');
  removeCheckpointRef({ cwd: f.cwd, ref: f.ref, expected: cp.commit });
  assert.throws(() => recoverAdvancedConsumerArtifacts({ ...f.options, audit }), e => e.code === 'WAVE_CHECKPOINT_EVIDENCE_MISSING');
});
test('r1 #1: exact-tip recovery restores prior witnesses and preserves post-checkpoint edits', async t => {
  const f = consumerWaveFixture(t); const { tx, audit } = await approvedWave(f);
  const cp = prepareCheckpoint({ cwd: f.cwd, ref: f.ref, parentCommit: f.base, tree: tx.witnessChain.at(-1), message: 'gate-1' });
  f.artifacts.recordPreparedCheckpoint({ ...cp, gateStepId: 'merge', gateToken: 'gate-1', gateOrdinal: 0,
    waveNumber: 1, baselineTree: tx.baselineTree, orderedDispatchTokens: tx.orderedDiffs.map(d => d.dispatchToken) });
  publishCheckpoint({ cwd: f.cwd, ref: f.ref, expected: null, commit: cp.commit });
  const index = readFileSync(join(f.cwd, '.git', 'index'));
  const branch = git(f.cwd, ['symbolic-ref', 'HEAD']);
  for (const phase of ['prepared', 'published', 'cleaned']) {
    if (phase === 'cleaned') {
      const artifacts = new ConsumerFanoutArtifacts(f.options);
      artifacts.markCheckpointPublished({ gateToken: 'gate-1', commit: cp.commit, evidenceReceiptId: 'receipt' });
      artifacts.cleanupWorktrees('evidence acknowledged');
      assert.equal(artifacts.journal.issuances[0].diff, null);
    }
    f.write('owned.txt', 'base\n');
    assert.equal(snapshotWorkingTree(f.cwd), tx.baselineTree);
    assert.equal(recoverAdvancedConsumerArtifacts({ ...f.options, audit }), true);
    assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'wave one\n', phase);
    assert.equal(new ConsumerFanoutArtifacts(f.options).journal.wave.checkpoints[0].state, 'published');
    f.write('owned.txt', 'post-checkpoint verification edit\n');
    assert.equal(recoverAdvancedConsumerArtifacts({ ...f.options, audit }), true);
    assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'post-checkpoint verification edit\n');
    assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), cp.commit);
    assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
    assert.equal(git(f.cwd, ['symbolic-ref', 'HEAD']), branch);
    assert.deepEqual(readFileSync(join(f.cwd, '.git', 'index')), index);
  }
});
test('journal ahead of ref replays only in temporary index; unknown ref refuses', async t => {
  const f = consumerWaveFixture(t); const { tx, audit } = await approvedWave(f);
  const cp = prepareCheckpoint({ cwd: f.cwd, ref: f.ref, parentCommit: f.base, tree: tx.witnessChain.at(-1), message: 'gate-1' });
  f.artifacts.recordPreparedCheckpoint({ ...cp, gateStepId: 'merge', gateToken: 'gate-1', gateOrdinal: 0,
    waveNumber: 1, baselineTree: tx.baselineTree, orderedDispatchTokens: tx.orderedDiffs.map(d => d.dispatchToken) });
  f.write('other.txt', 'later content\n');
  const before = snapshotWorkingTree(f.cwd);
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  assert.equal(snapshotWorkingTree(f.cwd), before); assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), cp.commit);
  const alien = prepare(f); publishCheckpoint({ cwd: f.cwd, ref: f.ref, expected: cp.commit, commit: alien.commit });
  assert.throws(() => recoverAdvancedConsumerArtifacts({ ...f.options, audit }), e => e.code === 'WAVE_CHECKPOINT_DIVERGED');
});
test('v1 legacy fields stay absent; durable bindings/admissions survive reload and digest drift is refused', t => {
  const f = consumerWaveFixture(t);
  assert.equal(f.artifacts.journal.version, 1); assert.equal(Object.hasOwn(f.artifacts.journal, 'wave'), false);
  assert.equal(Object.hasOwn(f.artifacts.journal, 'profilesDigest'), false);
  f.artifacts.bindRunRevision({ profilesDigest: 'profiles' });
  const item = { id: 'T1', files_owned: ['owned.txt'] };
  const itemBinding = { item, itemDigest: profilesDigest(item), epoch: 0, sourceProvenance: 'carry.wave' };
  f.artifacts.recordDispatchBinding({ dispatchToken: 'dispatch-1', itemBinding, resolvedProfile: { profile: 'codex', profilesDigest: 'profiles' } });
  const admission = { fanoutStepId: 'execute', epoch: 0, inputDigest: profilesDigest([item]), sourceProvenance: 'carry.wave', baseCommit: f.base,
    items: [{ itemIndex: 0, itemDigest: itemBinding.itemDigest, filesOwned: item.files_owned, profilesByStage: ['codex'] }] };
  f.artifacts.recordWaveAdmission(admission); f.artifacts.recordWaveAdmission(admission);
  const fresh = new ConsumerFanoutArtifacts(f.options);
  assert.equal(fresh.journal.waveAdmissions.length, 1); assert.deepEqual(fresh.journal.dispatchBindings['dispatch-1'].itemBinding, itemBinding);
  assert.throws(() => fresh.bindRunRevision({ profilesDigest: 'changed' }), e => e.code === 'CONSUMER_PROFILE_REVISION_MISMATCH');
  assert.throws(() => verifyConsumerRunRevision({ ...f.options, profilesDigest: 'changed' }), e => e.code === 'CONSUMER_PROFILE_REVISION_MISMATCH');
  assert.equal(verifyConsumerRunRevision({ ...f.options, profilesDigest: 'profiles' }).profilesDigest, 'profiles');
});
test('unapproved applied merge creates no checkpoint; cancelled run preserves prior publication', async t => {
  const f = consumerWaveFixture(t); const { d, audit } = await approvedWave(f);
  const waiting = { ...audit, events: [] };
  assert.equal(recoverAdvancedConsumerArtifacts({ ...f.options, audit: waiting }), false);
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), null);
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  const tip = readCheckpointRef({ cwd: f.cwd, ref: f.ref });
  recoverAdvancedConsumerArtifacts({ ...f.options, audit: { ...audit, status: 'cancelled' } });
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), tip);
  assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'wave one\n');
});
test('two approved rounds recover in order without rewinding a newer tip or reapplying old work', async t => {
  const f = consumerWaveFixture(t); const first = await approvedWave(f);
  recoverAdvancedConsumerArtifacts({ ...f.options, audit: first.audit });
  const artifacts = new ConsumerFanoutArtifacts(f.options);
  const firstTip = artifacts.journal.wave.checkpoints[0].commit;
  const d = f.descriptor({ id: 'T2', files_owned: ['other.txt'] }, { generation: 2, epoch: 1, dispatchToken: 'dispatch-2' });
  const { worktree } = artifacts.reconcileDescriptor(d, f.audit(d, 'running'));
  f.write('other.txt', 'wave two\n', worktree);
  artifacts.prepareIssuance(d, { output: { outcome: 'success' } }, { finalStage: true, itemBinding: f.binding(d) });
  const audit = { ...f.audit(d, 'succeeded', { merge: { status: 'waiting_gate' } }), events: first.audit.events };
  const tx = artifacts.prepareMerge({ gateStepId: 'merge', gateToken: 'gate-2', fanoutStepId: 'execute', audit });
  assert.equal(tx.gateOrdinal, 1); assert.equal(tx.checkpointParent, firstTip);
  await artifacts.applyMerge(tx);
  audit.events = [...audit.events, { type: 'gate_resolved', stepId: 'merge', detail: { decision: 'approve' } }];
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  const tip = readCheckpointRef({ cwd: f.cwd, ref: f.ref });
  assert.equal(git(f.cwd, ['rev-parse', `${tip}^`]), firstTip);
  f.write('review.txt', 'later review\n');
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), tip);
  assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'wave one\n');
  assert.equal(readFileSync(join(f.cwd, 'other.txt'), 'utf8'), 'wave two\n');
  assert.equal(readFileSync(join(f.cwd, 'review.txt'), 'utf8'), 'later review\n');
  const tree = squashOntoBase({ cwd: f.cwd, ref: f.ref, base: f.base });
  assert.equal(tree, git(f.cwd, ['rev-parse', `${tip}^{tree}`]));
  // Existing ship stages selected files and makes one base-parent commit.
  git(f.cwd, ['add', 'owned.txt', 'other.txt']); git(f.cwd, ['commit', '-qm', 'ship']);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD^']), f.base);
});
test('wave admission pins all later promotions to the same base even after a ref moves', async t => {
  const f = consumerWaveFixture(t); const { audit } = await approvedWave(f);
  f.artifacts.recordWaveAdmission({ fanoutStepId: 'execute', epoch: 0, inputDigest: 'items', baseCommit: f.base, items: [] });
  recoverAdvancedConsumerArtifacts({ ...f.options, audit });
  const artifacts = new ConsumerFanoutArtifacts(f.options);
  const d = f.descriptor({ id: 'T2', files_owned: ['other.txt'] }, { id: 'execute/1', itemIndex: 1, dispatchToken: 'later-promotion' });
  const ready = artifacts.reconcileDescriptor(d, {});
  assert.equal(git(ready.worktree, ['rev-parse', 'HEAD']), f.base);
});
test('pre-existing, symbolic and checked-out wave refs refuse mutation; detached parent is supported', t => {
  const f = consumerWaveFixture(t); const checkpoint = prepare(f);
  git(f.cwd, ['symbolic-ref', f.ref, 'refs/heads/main']);
  assert.throws(() => publishCheckpoint({ cwd: f.cwd, ref: f.ref, expected: null, commit: checkpoint.commit }), e => e.code === 'WAVE_CHECKPOINT_DIVERGED');
  git(f.cwd, ['symbolic-ref', '--delete', f.ref]);
  publishCheckpoint({ cwd: f.cwd, ref: f.ref, expected: null, commit: checkpoint.commit });
  assert.throws(() => f.artifacts.initializeWave({ ref: f.ref }), e => e.code === 'WAVE_CHECKPOINT_DIVERGED');
  git(f.cwd, ['checkout', '-q', f.ref.replace('refs/heads/', '')]);
  assert.throws(() => removeCheckpointRef({ cwd: f.cwd, ref: f.ref, expected: checkpoint.commit }), e => e.code === 'WAVE_CHECKPOINT_DIVERGED');
  git(f.cwd, ['checkout', '-q', '--detach', f.base]);
  assert.equal(prepare(f).tree, checkpoint.tree);
});
test('prepared recovery refuses ambiguous parent edits and leaves ref/evidence intact', async t => {
  const f = consumerWaveFixture(t); const { audit } = await approvedWave(f);
  f.write('owned.txt', 'unrelated replacement\n');
  assert.throws(() => recoverAdvancedConsumerArtifacts({ ...f.options, audit }), e => e.code === 'WAVE_CHECKPOINT_DIVERGED');
  assert.equal(readCheckpointRef({ cwd: f.cwd, ref: f.ref }), null);
  assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'unrelated replacement\n');
  assert.ok(new ConsumerFanoutArtifacts(f.options).journal.issuances[0].diff);
});
test('metadata receipt intent and acknowledgement persist without stale-instance overwrite', t => {
  const f = consumerWaveFixture(t); const second = new ConsumerFanoutArtifacts(f.options);
  const receipt = { source: 'compose.wave_checkpoint', usage: {}, detail: { commit: 'commit' } };
  f.artifacts.recordPendingUsageReceipt({ dispatchId: 'receipt', receipt });
  second.acknowledgeUsageReceipt({ dispatchId: 'receipt', seq: 4 });
  assert.equal(f.artifacts.recordPendingUsageReceipt({ dispatchId: 'receipt', receipt }).state, 'acknowledged');
  assert.equal(new ConsumerFanoutArtifacts(f.options).journal.pendingUsageReceipts[0].seq, 4);
  assert.throws(() => second.recordPendingUsageReceipt({ dispatchId: 'receipt', receipt: { usage: {} } }), e => e.code === 'CONSUMER_EVIDENCE_MISMATCH');
});
