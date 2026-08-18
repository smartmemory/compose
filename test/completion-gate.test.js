/**
 * test/completion-gate.test.js — COMP-COMPLETION-GATE slice 1.
 *
 * These assert the behaviours the coverage audit showed were missing, not the
 * gate's internal shape:
 *   - a completion actually reaches the guard (it never has for a real feature)
 *   - bad evidence refuses and writes NOTHING
 *   - a guard that is configured-but-unreachable refuses (never degrades)
 *   - the crash window between guard-applied and record-written is recoverable,
 *     and a retry on DIFFERENT evidence is not
 *   - a KILLED feature cannot be completed
 *   - a feature cannot be created COMPLETE
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  completionGate, readIntent, guardEnabled,
  _testOnly_setHistoryClient, _testOnly_resetHistoryClient,
} from '../lib/completion-gate.js';
import {
  _testOnly_setGuardClient, _testOnly_resetGuardCache,
} from '../server/lifecycle-guard.js';

// ---------------------------------------------------------------------------
// Fixture: a real git repo with a real commit, so evidence verification is
// exercised against git rather than mocked away.
// ---------------------------------------------------------------------------

function makeWorkspace({ guard = true, status = 'PLANNED' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'compgate-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(root, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const sha = git('rev-parse', 'HEAD').trim();

  mkdirSync(path.join(root, '.compose'), { recursive: true });
  writeFileSync(
    path.join(root, '.compose', 'compose.json'),
    JSON.stringify({ paths: { features: 'docs/features' }, capabilities: { guard } }, null, 2),
  );

  const fdir = path.join(root, 'docs', 'features', 'GATE-1');
  mkdirSync(fdir, { recursive: true });
  writeFileSync(
    path.join(fdir, 'feature.json'),
    JSON.stringify({ code: 'GATE-1', description: 'gate fixture', phase: 'Phase 1', status }, null, 2),
  );
  return { root, sha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function featureStatus(root) {
  return JSON.parse(
    readFileSync(path.join(root, 'docs', 'features', 'GATE-1', 'feature.json'), 'utf8'),
  ).status;
}

/** A guard client that applies everything and records what it saw. */
function applyingGuard(calls) {
  return {
    register: async (a) => { calls.push({ op: 'register', ...a }); return { status: 'registered' }; },
    transition: async (a) => {
      calls.push({ op: 'transition', ...a });
      return { status: 'applied', current_state: 'complete', ledger_ref: 'ledger#1', verdict: { met: true } };
    },
  };
}

function reset() {
  _testOnly_resetGuardCache();
  _testOnly_resetHistoryClient();
}

// ---------------------------------------------------------------------------

test('a completion reaches the guard — the transition that has never happened', async () => {
  const ws = makeWorkspace();
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true,
      workspaceRoot: ws.root, filesChanged: ['README.md'],
    });
    assert.equal(r.ok, true, r.reasons?.join('; '));
    assert.equal(r.guarded, true);

    const transition = calls.find(c => c.op === 'transition');
    assert.ok(transition, 'a guarded transition must have been attempted');
    assert.equal(transition.toState, 'complete');
    // Late registration is stamped so the ledger never implies lifecycle history.
    assert.match(transition.resolvedBy, /late-registration/);
    // operation_id must ride in the artifacts or two commit-less completions
    // would be indistinguishable in the ledger.
    assert.ok(transition.artifacts.operation_id, 'operation_id must be a guard artifact');
    assert.equal(transition.artifacts.commit_sha, ws.sha);

    assert.equal(featureStatus(ws.root), 'COMPLETE');
    assert.equal(readIntent(ws.root, 'GATE-1'), null, 'intent cleared on success');
  } finally { reset(); ws.cleanup(); }
});

test('a nonexistent commit refuses, and nothing is written', async () => {
  const ws = makeWorkspace();
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: 'a'.repeat(40), testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'evidence');
    assert.equal(calls.length, 0, 'the guard must not be touched when evidence fails');
    assert.equal(featureStatus(ws.root), 'PLANNED', 'status must be untouched');
  } finally { reset(); ws.cleanup(); }
});

test('tests_pass that is not explicitly true is not an attestation', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, workspaceRoot: ws.root, // testsPass omitted
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'evidence');
    assert.equal(featureStatus(ws.root), 'PLANNED');
  } finally { reset(); ws.cleanup(); }
});

test('guard configured but unreachable fails CLOSED — never degrades to guard-off', async () => {
  const ws = makeWorkspace({ guard: true });
  try {
    _testOnly_setGuardClient(applyingGuard([]));
    _testOnly_setHistoryClient(async () => ({ error: { code: 'SPAWN', message: 'stratum missing' } }));
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'guard');
    assert.equal(featureStatus(ws.root), 'PLANNED');
  } finally { reset(); ws.cleanup(); }
});

test('guard disabled is a true opt-out: no guard traffic, no evidence enforcement', async () => {
  // `capabilities.guard:false` means the project has not opted in. The gate must
  // not enforce evidence there — non-git workspaces could never satisfy it, and
  // turning an opt-out into enforcement would break every guard-off project.
  const ws = makeWorkspace({ guard: false });
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  try {
    assert.equal(guardEnabled(ws.root), false);
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, true);
    assert.equal(r.guarded, false);
    assert.equal(calls.length, 0, 'no guard traffic when the guard is off');
    assert.equal(featureStatus(ws.root), 'COMPLETE');
  } finally { reset(); ws.cleanup(); }
});

test('a KILLED feature cannot be completed', async () => {
  const ws = makeWorkspace({ status: 'KILLED' });
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'preflight');
    assert.match(r.reasons.join(' '), /KILLED/);
    assert.equal(calls.length, 0);
  } finally { reset(); ws.cleanup(); }
});

// --- recovery (design.md §2.4a) --------------------------------------------

test('crash after the guard applied, before the record: same commit RECOVERS', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient(applyingGuard([]));
  try {
    // Simulate the crash window: an intent on disk, guard already complete,
    // feature.json still not COMPLETE.
    const intentDir = path.join(ws.root, '.compose', 'data', 'completion-intents');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(path.join(intentDir, 'GATE-1.json'), JSON.stringify({
      operation_id: 'op-abc', feature_code: 'GATE-1', commit_sha: ws.sha,
      tests_attested: true, started_at: new Date().toISOString(),
    }));
    _testOnly_setHistoryClient(async () => ({ current_state: 'complete' }));

    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, true, r.reasons?.join('; '));
    assert.equal(r.recovered, true);
    assert.equal(r.operationId, 'op-abc', 'recovery adopts the recorded operation, not a new one');
    assert.equal(featureStatus(ws.root), 'COMPLETE');
    assert.equal(readIntent(ws.root, 'GATE-1'), null);
  } finally { reset(); ws.cleanup(); }
});

test('crash after the guard applied: a retry on a DIFFERENT commit is refused', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient(applyingGuard([]));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: ws.root, encoding: 'utf8' });
    writeFileSync(path.join(ws.root, 'b.txt'), 'b');
    git('add', '-A'); git('commit', '-qm', 'second');
    const shaB = git('rev-parse', 'HEAD').trim();
    assert.notEqual(shaB, ws.sha);

    // The ledger attested commit A.
    const intentDir = path.join(ws.root, '.compose', 'data', 'completion-intents');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(path.join(intentDir, 'GATE-1.json'), JSON.stringify({
      operation_id: 'op-A', feature_code: 'GATE-1', commit_sha: ws.sha,
      tests_attested: true, started_at: new Date().toISOString(),
    }));
    _testOnly_setHistoryClient(async () => ({ current_state: 'complete' }));

    // The retry carries commit B. A derived-identity scheme would have waved
    // this through; that was the round-4 P0.
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: shaB, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'recovery');
    assert.match(r.reasons.join(' '), /different evidence/);
    assert.equal(featureStatus(ws.root), 'PLANNED');
  } finally { reset(); ws.cleanup(); }
});

test('guard complete with NO intent on record refuses — not ours to resume', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({ current_state: 'complete' }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'recovery');
    assert.equal(featureStatus(ws.root), 'PLANNED');
  } finally { reset(); ws.cleanup(); }
});

test('a stale intent with no applied transition is cleared, and the completion proceeds', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const intentDir = path.join(ws.root, '.compose', 'data', 'completion-intents');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(path.join(intentDir, 'GATE-1.json'), JSON.stringify({
      operation_id: 'op-stale', feature_code: 'GATE-1', commit_sha: ws.sha,
    }));

    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, true, r.reasons?.join('; '));
    assert.notEqual(r.operationId, 'op-stale', 'a stale intent is discarded, not adopted');
    assert.equal(featureStatus(ws.root), 'COMPLETE');
  } finally { reset(); ws.cleanup(); }
});

test('a guard REFUSAL writes nothing and leaves no intent behind', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient({
    register: async () => ({ status: 'registered' }),
    transition: async () => ({ status: 'refused', verdict: { met: false }, current_state: 'ship' }),
  });
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'guard');
    assert.equal(featureStatus(ws.root), 'PLANNED');
    assert.equal(readIntent(ws.root, 'GATE-1'), null, 'a refusal must not strand an intent');
  } finally { reset(); ws.cleanup(); }
});

test('evidence-only intent verifies but does NOT drive the guard to terminal', async () => {
  const ws = makeWorkspace();
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true,
      workspaceRoot: ws.root, intent: 'evidence-only',
    });
    assert.equal(r.ok, true);
    assert.equal(r.evidenceOnly, true);
    assert.equal(calls.length, 0, 'recording evidence is not completing');
    assert.equal(featureStatus(ws.root), 'PLANNED');
  } finally { reset(); ws.cleanup(); }
});

// --- the creation hole ------------------------------------------------------

test('a feature cannot be created COMPLETE (closes `roadmap add --status COMPLETE`)', async () => {
  const ws = makeWorkspace();
  try {
    const { addRoadmapEntry } = await import('../lib/feature-writer.js');
    await assert.rejects(
      () => addRoadmapEntry(ws.root, {
        code: 'GATE-BORN', description: 'born complete', phase: 'Phase 1', status: 'COMPLETE',
      }),
      (e) => e.code === 'COMPLETE_ON_CREATE_REFUSED',
    );
    assert.equal(
      existsSync(path.join(ws.root, 'docs', 'features', 'GATE-BORN', 'feature.json')), false,
      'the refusal must not leave a partially-created feature behind',
    );
  } finally { ws.cleanup(); }
});

test('the migration exemption is explicit and narrow: only a stated reason gets through', async () => {
  // A migration transcribes a completion that already happened (an old ROADMAP
  // row); refusing it would make history unrepresentable. But it must be opt-in
  // and visible, never an ambient escape hatch.
  const ws = makeWorkspace();
  try {
    const { addRoadmapEntry } = await import('../lib/feature-writer.js');

    await assert.rejects(
      () => addRoadmapEntry(ws.root, {
        code: 'GATE-NOREASON', description: 'x', phase: 'Phase 1', status: 'COMPLETE',
        _migration: {},            // present but no reason — not an exemption
      }),
      (e) => e.code === 'COMPLETE_ON_CREATE_REFUSED',
      'an exemption without a stated reason must not count',
    );

    await addRoadmapEntry(ws.root, {
      code: 'GATE-MIGRATED', description: 'historical row', phase: 'Phase 1', status: 'COMPLETE',
      _migration: { reason: 'test: promoting a historical ROADMAP row' },
    });
    const f = JSON.parse(readFileSync(
      path.join(ws.root, 'docs', 'features', 'GATE-MIGRATED', 'feature.json'), 'utf8'));
    assert.equal(f.status, 'COMPLETE');
  } finally { ws.cleanup(); }
});
