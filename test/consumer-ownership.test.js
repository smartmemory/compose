import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConsumerFanoutArtifacts, snapshotWorkingTree } from '../lib/consumer-fanout.js';
import { consumerWaveFixture, git } from './helpers/consumer-wave-fixture.js';
const success = { output: { outcome: 'success', files_changed: ['owned.txt'] }, usage: { usd: 1 } };
function capture(f, item, edit) {
  const descriptor = f.descriptor(item);
  const ready = f.artifacts.reconcileDescriptor(descriptor, f.audit(descriptor, 'running'));
  edit(ready.worktree);
  const issuance = f.artifacts.prepareIssuance(descriptor, success, { finalStage: true, itemBinding: f.binding(descriptor) });
  return { descriptor, issuance, worktree: ready.worktree };
}
test('actual unowned edit fails despite forged files_changed, retains patch and replays exact failure', t => {
  const f = consumerWaveFixture(t);
  const before = snapshotWorkingTree(f.cwd);
  const { descriptor, issuance } = capture(f, { id: 'T1', files_owned: ['owned.txt'] }, cwd => f.write('other.txt', 'unauthorized\n', cwd));
  assert.equal(issuance.state, 'failed'); assert.equal(issuance.findings[0].code, 'OWNERSHIP_VIOLATION');
  assert.deepEqual(issuance.findings[0].files, ['other.txt']); assert.equal(issuance.envelope.usage.usd, 1);
  assert.ok(issuance.diff.includes('unauthorized')); assert.equal(issuance.envelope.output, undefined);
  const recovered = new ConsumerFanoutArtifacts(f.options);
  assert.deepEqual(recovered.reconcileDescriptor(descriptor, f.audit(descriptor, 'running')).envelope, issuance.envelope);
  assert.throws(() => recovered.prepareMerge({ gateStepId: 'merge', gateToken: 'gate', fanoutStepId: 'execute', audit: f.audit(descriptor) }));
  assert.equal(snapshotWorkingTree(f.cwd), before);
});
for (const kind of ['add', 'delete', 'mode', 'binary', 'symlink', 'whitespace']) test(`owned ${kind} patch merges with the parent index untouched`, async t => {
  const f = consumerWaveFixture(t);
  const files = ['owned.txt', 'new.txt', 'odd\n name.txt', 'link'];
  const { descriptor, issuance } = capture(f, { id: 'T1', files_owned: files }, cwd => {
    if (kind === 'add') f.write('new.txt', 'new\n', cwd);
    if (kind === 'delete') rmSync(join(cwd, 'owned.txt'));
    if (kind === 'mode') chmodSync(join(cwd, 'owned.txt'), 0o755);
    if (kind === 'binary') f.write('owned.txt', Buffer.from([0, 255, 4, 0]), cwd);
    if (kind === 'symlink') symlinkSync('other.txt', join(cwd, 'link'));
    if (kind === 'whitespace') f.write('odd\n name.txt', 'odd\n', cwd);
  });
  assert.equal(issuance.state, 'prepared');
  const index = git(f.cwd, ['write-tree']);
  const transaction = f.artifacts.prepareMerge({ gateStepId: 'merge', gateToken: 'gate', fanoutStepId: 'execute', audit: f.audit(descriptor) });
  await f.artifacts.applyMerge(transaction);
  assert.equal(snapshotWorkingTree(f.cwd), issuance.ownership.capturedTree);
  assert.equal(git(f.cwd, ['write-tree']), index); assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
});
for (const both of [false, true]) test(`rename requires both endpoints (both owned: ${both})`, t => {
  const f = consumerWaveFixture(t);
  const { issuance } = capture(f, { id: 'T1', files_owned: both ? ['owned.txt', 'renamed.txt'] : ['renamed.txt'] }, cwd => renameSync(join(cwd, 'owned.txt'), join(cwd, 'renamed.txt')));
  assert.deepEqual(issuance.ownership.changedPaths, ['owned.txt', 'renamed.txt']);
  assert.equal(issuance.state, both ? 'prepared' : 'failed');
});
for (const owned of [['../owned.txt'], ['/owned.txt'], ['*.txt'], ['.git/config'], ['dir']]) test(`invalid or directory ownership does not grant owned.txt: ${owned}`, t => {
  const f = consumerWaveFixture(t);
  const { issuance } = capture(f, { id: 'T1', files_owned: owned }, cwd => f.write('owned.txt', 'changed\n', cwd));
  assert.equal(issuance.state, 'failed');
});
test('corrupted retained patch blocks capture replay at merge, even after worktree loss', t => {
  const f = consumerWaveFixture(t);
  const { descriptor, worktree } = capture(f, { id: 'T1', files_owned: ['owned.txt'] }, cwd => f.write('owned.txt', 'changed\n', cwd));
  const journal = JSON.parse(readFileSync(f.artifacts.journalPath, 'utf8'));
  journal.issuances[0].diff += '\ncorruption';
  writeFileSync(f.artifacts.journalPath, JSON.stringify(journal));
  rmSync(worktree, { recursive: true, force: true });
  const before = snapshotWorkingTree(f.cwd);
  assert.throws(() => f.artifacts.prepareMerge({ gateStepId: 'merge', gateToken: 'gate', fanoutStepId: 'execute', audit: f.audit(descriptor) }), e => e.code === 'OWNERSHIP_EVIDENCE_MISMATCH');
  assert.equal(snapshotWorkingTree(f.cwd), before);
});
test('existing merge transaction and pre-apply seam recheck ordered patch identity', async t => {
  const f = consumerWaveFixture(t);
  const { descriptor } = capture(f, { id: 'T1', files_owned: ['owned.txt'] }, cwd => f.write('owned.txt', 'changed\n', cwd));
  const args = { gateStepId: 'merge', gateToken: 'gate', fanoutStepId: 'execute', audit: f.audit(descriptor) };
  const tx = f.artifacts.prepareMerge(args);
  const journal = JSON.parse(readFileSync(f.artifacts.journalPath, 'utf8'));
  journal.mergeTransactions[0].orderedDiffs[0].diff += '\n';
  writeFileSync(f.artifacts.journalPath, JSON.stringify(journal));
  assert.throws(() => f.artifacts.prepareMerge(args), e => e.code === 'OWNERSHIP_EVIDENCE_MISMATCH');
  await assert.rejects(f.artifacts.applyMerge(tx), e => e.code === 'OWNERSHIP_EVIDENCE_MISMATCH');
  assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'base\n');
});
test('configured missing files_owned fails', t => {
  const f = consumerWaveFixture(t); const d = f.descriptor({ id: 'T1', tier: 'fast' });
  f.artifacts.reconcileDescriptor(d, f.audit(d, 'running'));
  const entry = f.artifacts.prepareIssuance(d, success, { finalStage: true, ownership: true });
  assert.equal(entry.state, 'failed'); assert.equal(entry.findings[0].code, 'OWNERSHIP_VIOLATION');
});

test('legacy descriptor items remain inert until dispatch 2 supplies a binding', t => {
  const f = consumerWaveFixture(t); const d = f.descriptor();
  const { worktree } = f.artifacts.reconcileDescriptor(d, f.audit(d, 'running'));
  f.write('other.txt', 'legacy change\n', worktree);
  const issuance = f.artifacts.prepareIssuance(d, success, { finalStage: true });
  assert.equal(issuance.state, 'prepared'); assert.equal(Object.hasOwn(issuance, 'itemBinding'), false);
  assert.equal(Object.hasOwn(issuance, 'ownership'), false);
});
test('tier-only binding remains independent of ownership; owned isolation:none refuses before execution', t => {
  const f = consumerWaveFixture(t); const d = f.descriptor({ id: 'T1', tier: 'fast' });
  f.artifacts.reconcileDescriptor(d, f.audit(d, 'running'));
  const issuance = f.artifacts.prepareIssuance(d, success, { finalStage: true, itemBinding: f.binding(d) });
  assert.equal(issuance.state, 'prepared'); assert.equal(issuance.ownership, undefined);
  const none = f.descriptor({ id: 'T2', files_owned: ['owned.txt'] }, { dispatchToken: 'none', policy: { isolation: 'none' } });
  f.artifacts.recordDispatchBinding({ dispatchToken: none.dispatchToken, itemBinding: f.binding(none), resolvedProfile: { profile: 'codex' } });
  assert.throws(() => f.artifacts.reconcileDescriptor(none, {}), e => e.code === 'WAVE_OWNERSHIP_INVALID');
  assert.equal(readFileSync(join(f.cwd, 'owned.txt'), 'utf8'), 'base\n');
});
