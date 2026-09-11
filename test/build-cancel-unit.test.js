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

test('teardown finalizes routing evidence after drain and before terminal ownership writes', async () => {
  const { runCancelTeardown } = await import('../lib/build-cancel.js');
  const buildCancel = createBuildCancel(), order = [];
  buildCancel.resolveDrained();
  await runCancelTeardown({ buildCancel, signal: 'SIGINT', flowId: 'run', timeoutMs: 50, drainMs: 50,
    flowCancel: async () => { order.push('cancel'); }, finalizeEvidence: async () => { order.push('evidence'); },
    killVision: async () => { order.push('vision'); }, writeTerminal: () => { order.push('terminal'); },
    removeListeners: () => {}, exit: () => { order.push('exit'); }, log: () => {} });
  assert.deepEqual(order, ['cancel', 'evidence', 'vision', 'terminal', 'exit']);
});
test('teardown routing-integrity failure escapes and cannot become a clean terminal write', async () => {
  const { runCancelTeardown } = await import('../lib/build-cancel.js');
  const buildCancel = createBuildCancel(); buildCancel.resolveDrained(); let terminals = 0;
  await assert.rejects(runCancelTeardown({ buildCancel, signal: 'SIGTERM', flowId: 'run', timeoutMs: 50, drainMs: 50,
    flowCancel: async () => {}, finalizeEvidence: async () => { throw Object.assign(Error('disk failed'), { code: 'ROUTING_PERSISTENCE_FAILED' }); },
    killVision: async () => {}, writeTerminal: () => { terminals++; }, removeListeners: () => {}, exit: () => {}, log: () => {} }), { code: 'ROUTING_PERSISTENCE_FAILED' });
  assert.equal(terminals, 0);
});

test('routing evidence recovery shares the bounded teardown allowance and cannot grant terminal success on timeout', async () => {
  const { runCancelTeardown } = await import('../lib/build-cancel.js');
  const buildCancel = createBuildCancel(); buildCancel.resolveDrained(); let terminal = 0;
  await assert.rejects(runCancelTeardown({ buildCancel, signal: 'SIGINT', flowId: 'f', timeoutMs: 5, drainMs: 5,
    flowCancel: async () => {}, finalizeEvidence: () => new Promise(() => {}),
    killVision: async () => {}, writeTerminal: () => { terminal++; }, removeListeners() {}, exit() {}, log() {},
  }), { code: 'ROUTING_RECOVERY_INCOMPLETE' });
  assert.equal(terminal, 0);
});


test('public Build signal deadline persists unknown call ownership before exit and refuses reissue', { timeout: 15000 }, async t => {
  const { runtimeFixture } = await import('./helpers/routing-runtime-fixture.js');
  const { resumeRouting } = await import('../lib/build.js');
  const { seedCanonicalCatalog } = await import('./helpers/policy-catalog-stub.js');
  const { _clearCatalogCache } = await import('../lib/policy-catalog.js');
  const { writeFileSync, rmSync } = await import('node:fs'); const { join } = await import('node:path');
  const memoryDir = seedCanonicalCatalog(); t.after(() => { _clearCatalogCache(); rmSync(memoryDir, { recursive: true, force: true }); });
  const prior = [process.env.COMPOSE_CANCEL_TIMEOUT_MS, process.env.COMPOSE_TEARDOWN_DRAIN_MS];
  process.env.COMPOSE_CANCEL_TIMEOUT_MS = '2000'; process.env.COMPOSE_TEARDOWN_DRAIN_MS = '5';
  t.after(() => ['COMPOSE_CANCEL_TIMEOUT_MS', 'COMPOSE_TEARDOWN_DRAIN_MS'].forEach((key, n) => {
    if (prior[n] === undefined) delete process.env[key]; else process.env[key] = prior[n];
  }));
  let announceLaunch, release;
  const launched = new Promise(resolve => { announceLaunch = resolve; });
  const f = await runtimeFixture(t, {
    setup({ cwd }) { writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ version: 2, policyCheck: { memoryDir } })); },
    intercept(method, args) { if (method === 'before:usageReport' && args[1].detail?.routing?.kind === 'paid-call') throw Error('paid receipt delivery unavailable'); },
    inference: async (_args, _f, ordinal) => {
    if (ordinal === 0) return { text: '{"outcome":"complete","summary":"Want me to continue with the tests?"}',
      usage: { tokens: 4, ms: 5, usd: 0.3 }, usdSource: 'reported' };
    announceLaunch(); await new Promise(resolve => { release = resolve; });
    return { text: '{"outcome":"complete","summary":"late"}', usage: { tokens: 4, ms: 5, usd: 0.3 }, usdSource: 'reported' };
  } });
  // The actual connector cannot confirm termination within the drain budget.
  f.connector.cancelAgentRun = async () => ({ status: 'cancelled' });
  let finishExit;
  const exited = new Promise(resolve => { finishExit = resolve; });
  t.mock.method(process, 'exit', code => {
    // Capture before the suspended pump's catch/finally can recover anything.
    finishExit({ code, rows: f.rows(), journal: f.journal(), reports: structuredClone(f.reports) });
  });
  const running = f.run().catch(error => error);
  await launched;
  const handle = lookupBuildCancel(f.flowId);
  let drained = false; handle.drained.then(() => { drained = true; });
  process.emit('SIGINT');
  try {
    const atExit = await exited;
    assert.equal(atExit.code, 130); assert.equal(drained, false, 'drain deadline expired with the call outstanding');
    assert.equal(f.snapshot().status, 'cancelled');
    const parent = atExit.rows.find(r => r.issuance?.scopedStep === 'work');
    assert.ok(parent); assert.equal(parent.outcome.label, 'unknown'); assert.equal(parent.outcome.binary, 'excluded');
    assert.deepEqual(parent.calls.map(c => c.resolution.outcome).sort(), ['resolved', 'unresolved']);
    assert.equal(parent.cost.usd, 0.3);
    const records = Object.values(atExit.journal.routing.records);
    assert.equal(records.some(r => r.event === 'settled'), false); assert.equal(atExit.reports.length, 0);
    const call = records.find(r => r.type === 'call-intent');
    const metadata = records.find(r => r.type === 'issuance-metadata' && r.issuanceId === call.issuanceId);
    const owner = records.find(r => r.id === metadata.ownerId);
    assert.ok(owner); assert.equal(owner.ownerRunId, f.flowId);
    const paid = atExit.journal.pendingUsageReceipts.find(p => p.receipt.detail?.routing?.kind === 'paid-call');
    assert.equal(paid.state, 'pending'); assert.equal(paid.receipt.detail.routing.ownerRunId, f.flowId);
    assert.equal(paid.receipt.dispatchId, call.callId); assert.equal(paid.receipt.usage.usd, 0.3);
    await assert.rejects(resumeRouting({ runId: f.flowId, cwd: f.cwd, localSpec: f.spec, profiles: f.profiles,
      stratum: f.stratum, artifactRoot: f.artifactRoot }), { code: 'ROUTING_ISSUANCE_UNCERTAIN' });
    assert.equal(f.calls.length, 2);
  } finally { release(); await running; }
});
