import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyBackfillUpgrade, ensureGuard, resourceId, _testOnly_setGuardClient,
  _testOnly_setEnsureDescriptors, _testOnly_resetGuardCache,
} from '../server/lifecycle-guard.js';
import { deriveBackfillPolicy } from '../lib/guard-descriptors.js';
import { DESCRIPTOR_LOCK_TIMEOUT_MS } from '../lib/guard-custody.js';

function legacyPolicy(checksum = 'a'.repeat(64)) {
  return {
    status: 'ok', checksum,
    graph: { explore_design: ['ship', 'killed'], ship: ['killed'], killed: [] },
    edge_predicates: {}, terminal: ['killed'], stakes: {},
  };
}

function upgradedPolicy(checksum = 'b'.repeat(64)) {
  const legacy = legacyPolicy(checksum);
  return { ...legacy, ...deriveBackfillPolicy(legacy, 'build') };
}

function client({ policy, applyUpgrade = async () => ({ status: 'applied', ledger_ref: 'ledger-1', checksum: 'b'.repeat(64) }) }) {
  return {
    register: async () => ({ status: 'registered' }),
    transition: async () => ({ status: 'applied' }),
    policy: async () => policy,
    descriptors: async () => ({ status: 'ok', signature: 'verified: test', group_or_world_writable: false }),
    applyUpgrade,
  };
}

function reset() {
  _testOnly_resetGuardCache();
  _testOnly_setEnsureDescriptors();
}

test('already-upgraded policy short-circuits without ensure and refreshes the guard cache', async () => {
  reset();
  const root = mkdtempSync(path.join(tmpdir(), 'backfill-upgrade-'));
  let ensures = 0;
  _testOnly_setGuardClient(client({ policy: upgradedPolicy() }));
  _testOnly_setEnsureDescriptors(async () => { ensures += 1; throw new Error('must not ensure'); });
  try {
    const result = await applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: root });
    assert.deepEqual(result, { ok: true, status: 'unchanged', checksum: 'b'.repeat(64) });
    assert.equal(ensures, 0);
    assert.equal((await ensureGuard('F1', 'ship', root)).status, 'cached');
  } finally { reset(); rmSync(root, { recursive: true, force: true }); }
});

test('ensure refusal is returned as the complete refusal envelope', async () => {
  reset();
  const root = mkdtempSync(path.join(tmpdir(), 'backfill-upgrade-'));
  _testOnly_setGuardClient(client({ policy: legacyPolicy() }));
  _testOnly_setEnsureDescriptors(async () => ({
    status: 'refused', code: 'signature_not_approved', message: 'approval was not completed', hint: 'approve the Touch ID prompt',
  }));
  try {
    assert.deepEqual(await applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: root }), {
      ok: false, reasons: ['approval was not completed'],
      error: { code: 'signature_not_approved', message: 'approval was not completed', hint: 'approve the Touch ID prompt' },
    });
  } finally { reset(); rmSync(root, { recursive: true, force: true }); }
});

test('holds the descriptor lock through slow ensure and slow applyUpgrade', async () => {
  reset();
  const root = mkdtempSync(path.join(tmpdir(), 'backfill-upgrade-'));
  const keepAlive = setInterval(() => {}, 1_000);
  const events = [];
  let notifyEnsure;
  let notifyApply;
  let resumeEnsure;
  let resumeApply;
  let applies = 0;
  const ensureEntered = new Promise((resolve) => { notifyEnsure = resolve; });
  const applyEntered = new Promise((resolve) => { notifyApply = resolve; });
  let calls = 0;
  _testOnly_setGuardClient(client({ policy: legacyPolicy(), applyUpgrade: async () => {
    applies += 1;
    events.push('apply-start');
    if (applies === 1) {
      notifyApply();
      await new Promise((resolve) => { resumeApply = resolve; });
    }
    events.push('apply-end');
    return { status: 'applied', ledger_ref: 'ledger-1', checksum: 'b'.repeat(64) };
  } }));
  _testOnly_setEnsureDescriptors(async () => {
    calls += 1;
    events.push(`ensure-${calls}-start`);
    if (calls === 1) {
      notifyEnsure();
      await new Promise((resolve) => { resumeEnsure = resolve; });
    }
    events.push(`ensure-${calls}-end`);
    return { status: 'signed', path: path.join(root, 'resolved', 'descriptors.json'), sha: 'c'.repeat(64) };
  });
  try {
    const first = applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: root });
    await ensureEntered;
    const second = applyBackfillUpgrade({ featureCode: 'F2', workspaceRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['ensure-1-start']);
    resumeEnsure();
    await applyEntered;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['ensure-1-start', 'ensure-1-end', 'apply-start']);
    resumeApply();
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      'ensure-1-start', 'ensure-1-end', 'apply-start', 'apply-end',
      'ensure-2-start', 'ensure-2-end', 'apply-start', 'apply-end',
    ]);
  } finally { clearInterval(keepAlive); reset(); rmSync(root, { recursive: true, force: true }); }
});

test('waits beyond the historical 30 second lock deadline when the descriptor budget is 150 seconds', { timeout: 45_000 }, async () => {
  reset();
  const root = mkdtempSync(path.join(tmpdir(), 'backfill-upgrade-'));
  const keepAlive = setInterval(() => {}, 1_000);
  let notifyEntered;
  let resumeFirst;
  const entered = new Promise((resolve) => { notifyEntered = resolve; });
  let calls = 0;
  _testOnly_setGuardClient(client({ policy: legacyPolicy() }));
  _testOnly_setEnsureDescriptors(async () => {
    calls += 1;
    if (calls === 1) {
      notifyEntered();
      await new Promise((resolve) => { resumeFirst = resolve; });
    }
    return { status: 'fresh', path: path.join(root, 'resolved', 'descriptors.json'), sha: 'd'.repeat(64) };
  });
  try {
    const first = applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: root });
    await entered;
    const started = Date.now();
    const second = applyBackfillUpgrade({ featureCode: 'F2', workspaceRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    resumeFirst();
    await Promise.all([first, second]);
    assert.ok(Date.now() - started > 30_000);
  } finally { clearInterval(keepAlive); reset(); rmSync(root, { recursive: true, force: true }); }
});

test('DirLockTimeout is a refusal envelope, never a throw', async () => {
  reset();
  const root = mkdtempSync(path.join(tmpdir(), 'backfill-upgrade-'));
  const lock = path.join(root, '.compose', 'data', 'locks', 'guard-descriptors');
  mkdirSync(lock, { recursive: true });
  const actualNow = Date.now;
  let nowCalls = 0;
  Date.now = () => (++nowCalls <= 2 ? 0 : DESCRIPTOR_LOCK_TIMEOUT_MS + 1);
  _testOnly_setGuardClient(client({ policy: legacyPolicy() }));
  try {
    const result = await applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: root });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.error).sort(), ['code', 'hint', 'message']);
    assert.equal(result.error.code, 'upgrade_descriptor_unavailable');
    assert.match(result.reasons[0], /timed out after 150000ms/);
  } finally {
    Date.now = actualNow;
    reset();
    rmSync(root, { recursive: true, force: true });
  }
});
