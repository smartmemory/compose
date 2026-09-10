/**
 * S03-1: the build-level cancel handle (`createBuildCancel`), its two independent states
 * (`cancelled` / `teardownStarted`, C27), the in-process registry (§3.5), the teardown
 * handshake's two promises (`teardown` / `drained`, §3.6), and `isRunCancelled` (§ S03-1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBuildCancel,
  registerBuildCancel,
  unregisterBuildCancel,
  lookupBuildCancel,
  pendingTeardown,
  isRunCancelled,
} from '../lib/build-cancel.js';

describe('createBuildCancel', () => {
  test('starts uncancelled, with a live AbortSignal and null reason/at', () => {
    const handle = createBuildCancel();
    assert.equal(handle.cancelled, false);
    assert.equal(handle.reason, null);
    assert.equal(handle.at, null);
    assert.equal(handle.teardownStarted, false);
    assert.ok(handle.signal instanceof AbortSignal);
    assert.equal(handle.signal.aborted, false);
  });

  test('cancel(reason) is idempotent: true only for the first caller, aborts the signal', () => {
    const handle = createBuildCancel();
    let abortedReasonSeen;
    handle.signal.addEventListener('abort', () => { abortedReasonSeen = handle.signal.reason; });

    assert.equal(handle.cancel('user_ctrl_c'), true);
    assert.equal(handle.cancelled, true);
    assert.equal(handle.reason, 'user_ctrl_c');
    assert.ok(handle.at && !Number.isNaN(Date.parse(handle.at)));
    assert.equal(handle.signal.aborted, true);
    assert.ok(abortedReasonSeen instanceof Error);
    assert.match(abortedReasonSeen.message, /user_ctrl_c/);

    const firstAt = handle.at;
    assert.equal(handle.cancel('second_reason'), false);
    assert.equal(handle.reason, 'user_ctrl_c', 'second cancel must not overwrite the reason');
    assert.equal(handle.at, firstAt, 'second cancel must not overwrite the timestamp');
  });

  test('beginTeardown() is idempotent: true only for the first caller', () => {
    const handle = createBuildCancel();
    assert.equal(handle.beginTeardown(), true);
    assert.equal(handle.teardownStarted, true);
    assert.equal(handle.beginTeardown(), false);
    assert.equal(handle.teardownStarted, true);
  });

  test('teardown starts null; drained is a pending promise resolved by resolveDrained', async () => {
    const handle = createBuildCancel();
    assert.equal(handle.teardown, null);
    assert.ok(handle.drained instanceof Promise);

    let settled = false;
    handle.drained.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'drained must not resolve on its own');

    handle.resolveDrained();
    await handle.drained;
    assert.equal(settled, true);
  });

  test('teardown is a writable slot the caller (runCancelTeardown, in S06) sets synchronously', () => {
    const handle = createBuildCancel();
    const marker = Promise.resolve('teardown-in-flight');
    handle.teardown = marker;
    assert.equal(handle.teardown, marker);
  });

  test('two handles are independent', () => {
    const a = createBuildCancel();
    const b = createBuildCancel();
    a.cancel('a-reason');
    assert.equal(a.cancelled, true);
    assert.equal(b.cancelled, false);
    assert.equal(b.reason, null);
  });
});

describe('the in-process build registry (§3.5)', () => {
  test('register makes a handle reachable by flow id; unregister removes it', () => {
    const handle = createBuildCancel();
    assert.equal(lookupBuildCancel('flow-reg-1'), null);
    registerBuildCancel('flow-reg-1', handle);
    assert.equal(lookupBuildCancel('flow-reg-1'), handle);
    unregisterBuildCancel('flow-reg-1');
    assert.equal(lookupBuildCancel('flow-reg-1'), null);
  });

  test('register/unregister/lookup are no-ops on undefined/null flow ids', () => {
    const handle = createBuildCancel();
    registerBuildCancel(undefined, handle);
    registerBuildCancel(null, handle);
    assert.equal(lookupBuildCancel(undefined), null);
    assert.equal(lookupBuildCancel(null), null);
    // must not throw
    unregisterBuildCancel(undefined);
    unregisterBuildCancel(null);
  });

  test('a foreign (unregistered) flow id is unreachable through the registry, by construction', () => {
    assert.equal(lookupBuildCancel('never-registered-flow'), null);
  });
});

describe('pendingTeardown()', () => {
  test('resolves to null when nothing in this process is tearing down', () => {
    assert.equal(pendingTeardown(), null);
  });

  test('returns the in-flight teardown promise for whichever registered handle has one', () => {
    const handle = createBuildCancel();
    registerBuildCancel('flow-teardown-1', handle);
    try {
      assert.equal(pendingTeardown(), null);
      const marker = Promise.resolve('done');
      handle.teardown = marker;
      assert.equal(pendingTeardown(), marker);
    } finally {
      unregisterBuildCancel('flow-teardown-1');
    }
  });
});

describe('isRunCancelled (the authority on "was this run cancelled")', () => {
  test('returns false when stratum or flowId is missing', async () => {
    assert.equal(await isRunCancelled(null, 'flow-1'), false);
    assert.equal(await isRunCancelled({ audit: async () => ({ status: 'cancelled' }) }, null), false);
  });

  test('returns true only when the audit reports status: cancelled', async () => {
    const stratum = { audit: async () => ({ status: 'cancelled' }) };
    assert.equal(await isRunCancelled(stratum, 'flow-1'), true);
  });

  test('returns false for any other audited status', async () => {
    const stratum = { audit: async () => ({ status: 'running' }) };
    assert.equal(await isRunCancelled(stratum, 'flow-1'), false);
  });

  test('returns false (not an exception) when the audit call itself fails: unreachable is not evidence of a cancel', async () => {
    const stratum = { audit: async () => { throw new Error('engine unreachable'); } };
    assert.equal(await isRunCancelled(stratum, 'flow-1'), false);
  });
});
