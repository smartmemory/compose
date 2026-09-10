import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as fanout from '../lib/consumer-fanout.js';
import { lookupBuildCancel } from '../lib/build-cancel.js';
import { FLOW, mergeFixture } from './helpers/build-cancel-s05.js';

test('post-apply fence reverses a cancellation between applyMerge return and isRunCancelled', async t => {
  const f = mergeFixture(t);
  let applied = false;
  let confirmations = 0;
  const apply = fanout.ConsumerFanoutArtifacts.prototype.applyMerge;
  t.mock.method(fanout.ConsumerFanoutArtifacts.prototype, 'applyMerge', async function(tx) {
    const result = await apply.call(this, tx);
    assert.ok(existsSync(join(f.cwd, 'landed.txt')), 'real diff landed before cancellation');
    assert.equal(f.journal().issuances[0].state, 'merged');
    applied = true;
    return result;
  });
  // isRunCancelled's authority seam: flip ONLY after the actual apply returned,
  // without setting the local flag, so the post-apply RPC itself must detect it.
  t.mock.method(f.client, 'audit', async () => {
    if (applied) { confirmations++; return { ...f.audit, status: 'cancelled' }; }
    return structuredClone(f.audit);
  });
  await assert.rejects(f.run(f.client), error => {
    assert.equal(error.code, 'MERGE_AFTER_CANCEL');
    assert.ok(error instanceof fanout.MergeAfterCancelError);
    assert.equal(error instanceof fanout.ConsumerMergeDecisionError, false);
    return true;
  });
  assert.equal(confirmations, 1);
  const journal = f.journal();
  const tx = journal.mergeTransactions[0];
  assert.equal(fanout.snapshotWorkingTree(f.cwd), tx.baselineTree, f.git(['status', '--short']));
  assert.equal(tx.rollbackReason, 'cancelled');
  assert.equal(tx.state, 'rolled_back');
  assert.ok(journal.issuances.every(i => ['accepted', 'superseded'].includes(i.state)));
  assert.ok(journal.issuances[0].diff.includes('captured evidence'));
  assert.equal(f.client.calls.filter(c => c.name === 'gateResolve').length, 0, 'repairFor must never revise cancellation');
  assert.equal(f.read('active-build.json').status, 'aborted');
});

test('post-apply fence also reverses when the in-process handle was cancelled during apply', async t => {
  const f = mergeFixture(t);
  const apply = fanout.ConsumerFanoutArtifacts.prototype.applyMerge;
  t.mock.method(fanout.ConsumerFanoutArtifacts.prototype, 'applyMerge', async function(tx) {
    const result = await apply.call(this, tx);
    lookupBuildCancel(FLOW).cancel('flow_cancelled');
    return result;
  });
  await assert.rejects(f.run(f.client), { code: 'MERGE_AFTER_CANCEL' });
  assert.equal(f.journal().mergeTransactions[0].rollbackReason, 'cancelled');
  assert.equal(existsSync(join(f.cwd, 'landed.txt')), false);
});
