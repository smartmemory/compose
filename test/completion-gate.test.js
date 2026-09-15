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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Never let the gate's default vision projector find a real cockpit on :4001.
process.env.COMPOSE_PORT = '19995';

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

function makeWorkspace({ guard = true, status = 'PLANNED', testCommand } = {}) {
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
    JSON.stringify({
      paths: { features: 'docs/features' },
      capabilities: { guard },
      ...(testCommand ? { guard: { testCommand } } : {}),
    }, null, 2),
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
    // Stratum >= 0.4.0 accepts only "agent" | "human" for resolved_by; a tagged
    // resolver is refused as evidence_parse_error (that refusal broke every
    // completion after the 0.4.0 upgrade, 2026-09-05).
    assert.equal(transition.resolvedBy, 'agent');
    // Late registration is stamped in the artifacts so the ledger never implies
    // lifecycle history, and the stamp still lands in the payload digest.
    assert.match(transition.artifacts.resolver_tags, /late-registration/);
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

test('[COMP-COMPLETION-GATE-1] a 7-char SHA prefix refuses before acquiring a held lock', async () => {
  const ws = makeWorkspace();
  const calls = [];
  const lockDir = path.join(ws.root, '.compose', 'data', 'locks', 'completion-GATE-1');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner'), 'pre-held-by-test');
  const releaseHeldLock = setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), 1000);
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async (rid) => {
    calls.push({ op: 'history', rid });
    return { error: { code: 'guard_not_found' } };
  });
  try {
    const started = Date.now();
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha.slice(0, 7), testsPass: true,
      workspaceRoot: ws.root, filesChanged: ['README.md'],
    });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'evidence');
    assert.ok(elapsed < 700, `SHA refusal waited on the held lock (${elapsed}ms)`);
    assert.match(r.reasons.join(' '), /full 40-char hex SHA/);
    assert.equal(readIntent(ws.root, 'GATE-1'), null, 'invalid SHA must not write an intent');
    assert.deepEqual(calls, [], 'invalid SHA must not read or transition the guard');
    assert.equal(featureStatus(ws.root), 'PLANNED');
  } finally {
    clearTimeout(releaseHeldLock);
    rmSync(lockDir, { recursive: true, force: true });
    reset();
    ws.cleanup();
  }
});

for (const { name, over, reason } of [
  {
    name: 'feature_code must match the strict feature-code shape',
    over: { featureCode: 'lowercase-1' },
    reason: /invalid feature_code/,
  },
  {
    name: 'files_changed must be an array',
    over: { filesChanged: 'README.md' },
    reason: /files_changed must be an array/,
  },
  {
    name: 'files_changed entries must be strings',
    over: { filesChanged: [42] },
    reason: /each entry must be a non-empty string/,
  },
  {
    name: 'files_changed entries must be non-empty',
    over: { filesChanged: [''] },
    reason: /each entry must be a non-empty string/,
  },
  {
    name: 'files_changed entries must not contain NUL',
    over: { filesChanged: ['bad\0path'] },
    reason: /contains NUL byte/,
  },
  {
    name: 'files_changed entries must be repo-relative',
    over: { filesChanged: ['/etc/passwd'] },
    reason: /absolute paths not allowed/,
  },
  {
    name: 'files_changed entries must use POSIX separators',
    over: { filesChanged: ['lib\\completion-gate.js'] },
    reason: /POSIX separators/,
  },
  {
    name: 'files_changed entries must already be normalized',
    over: { filesChanged: ['./lib/completion-gate.js'] },
    reason: /must already be normalized/,
  },
  {
    name: 'files_changed entries must not escape with dot-dot',
    over: { filesChanged: ['../outside.js'] },
    reason: /escape rejected/,
  },
  {
    name: 'notes must be a string when present',
    over: { notes: 42 },
    reason: /notes must be a string/,
  },
  {
    name: 'notes must not contain NUL',
    over: { notes: 'bad\0note' },
    reason: /notes must not contain NUL bytes/,
  },
  {
    name: 'built_via must be a lowercase template slug',
    over: { builtVia: 'Build Quick!' },
    reason: /built_via must be a lowercase template slug/,
  },
  {
    name: 'force must be a strict boolean',
    over: { force: 1 },
    reason: /force must be a boolean/,
  },
  {
    name: 'idempotency_key must be a non-empty string when used',
    over: { idempotencyKey: 1 },
    reason: /idempotency: key must be a non-empty string/,
  },
]) {
  test(`[COMP-COMPLETION-GATE-1] shape: ${name}; zero guard traffic`, async () => {
    const ws = makeWorkspace();
    const calls = [];
    _testOnly_setGuardClient(applyingGuard(calls));
    _testOnly_setHistoryClient(async (rid) => {
      calls.push({ op: 'history', rid });
      return { error: { code: 'guard_not_found' } };
    });
    try {
      const r = await completionGate({
        featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true,
        workspaceRoot: ws.root, filesChanged: ['README.md'], ...over,
      });
      assert.equal(r.ok, false);
      assert.equal(r.refusedAt, 'request');
      assert.match(r.reasons.join(' '), reason);
      assert.equal(readIntent(ws.root, over.featureCode || 'GATE-1'), null,
        'shape refusal must not write an intent');
      assert.deepEqual(calls, [], 'shape refusal must not read or transition the guard');
      assert.equal(featureStatus(ws.root), 'PLANNED');
    } finally { reset(); ws.cleanup(); }
  });
}

for (const { name, commitSha, reason } of [
  { name: 'non-string SHA', commitSha: 123, reason: /non-empty 40-char hex SHA/ },
  { name: 'empty SHA', commitSha: '   ', reason: /non-empty 40-char hex SHA/ },
  { name: 'non-hex SHA', commitSha: 'g'.repeat(40), reason: /full 40-char hex SHA/ },
]) {
  test(`[COMP-COMPLETION-GATE-1] evidence shape: ${name}; zero guard traffic`, async () => {
    const ws = makeWorkspace();
    const calls = [];
    _testOnly_setGuardClient(applyingGuard(calls));
    _testOnly_setHistoryClient(async (rid) => {
      calls.push({ op: 'history', rid });
      return { error: { code: 'guard_not_found' } };
    });
    try {
      const r = await completionGate({
        featureCode: 'GATE-1', commitSha, testsPass: true,
        workspaceRoot: ws.root, filesChanged: ['README.md'],
      });
      assert.equal(r.ok, false);
      assert.equal(r.refusedAt, 'evidence');
      assert.match(r.reasons.join(' '), reason);
      assert.equal(readIntent(ws.root, 'GATE-1'), null, 'invalid SHA must not write an intent');
      assert.deepEqual(calls, [], 'invalid SHA must not read or transition the guard');
      assert.equal(featureStatus(ws.root), 'PLANNED');
    } finally { reset(); ws.cleanup(); }
  });
}

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

test('[COMP-COMPLETION-GATE-1] a passing configured command attests an omitted tests_pass', async () => {
  const ws = makeWorkspace({
    guard: true,
    testCommand: [process.execPath, '-e', 'process.exit(0)'],
  });
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: undefined,
      workspaceRoot: ws.root, filesChanged: ['README.md'],
    });
    assert.equal(r.ok, true, r.reasons?.join('; '));
    assert.equal(r.attestedTestsPass, true);
    const stored = JSON.parse(readFileSync(
      path.join(ws.root, 'docs', 'features', 'GATE-1', 'feature.json'), 'utf8',
    ));
    assert.equal(stored.completions[0].tests_pass, true,
      'the writer receives the derived attestation');
    assert.equal(featureStatus(ws.root), 'COMPLETE');
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

test('[COMP-COMPLETION-GATE-1] crash after guard: uppercase retry of the same commit RECOVERS', async () => {
  const ws = makeWorkspace();
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  try {
    const intentDir = path.join(ws.root, '.compose', 'data', 'completion-intents');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(path.join(intentDir, 'GATE-1.json'), JSON.stringify({
      operation_id: 'op-uppercase-retry', feature_code: 'GATE-1', commit_sha: ws.sha,
      tests_attested: true, started_at: new Date().toISOString(),
    }));
    _testOnly_setHistoryClient(async () => ({ current_state: 'complete' }));

    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha.toUpperCase(), testsPass: true,
      workspaceRoot: ws.root, filesChanged: ['README.md'],
    });
    assert.equal(r.ok, true, r.reasons?.join('; '));
    assert.equal(r.recovered, true);
    assert.equal(r.operationId, 'op-uppercase-retry');
    assert.equal(r.result.commit_sha, ws.sha, 'writer receives the canonical lowercase SHA');
    assert.equal(calls.filter((c) => c.op === 'transition').length, 0,
      'recovery must not apply a second guard transition');
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

// --- the REAL producer shape ------------------------------------------------
//
// Every other test in this file injects `{ error: { code: 'guard_not_found' } }`.
// server/stratum-client.js never produces that: it returns stratum's canonical
// error object verbatim, `{ status:'error', error_type:'guard_not_found',
// message:'no guard registered for "<rid>"' }`. Reading only `code`/`kind` made
// the not-found branch dead against the real client, so EVERY unregistered
// feature — i.e. every feature that never ran a lifecycle — refused with "guard
// unreachable". Green suite, dead path. Found 2026-08-24.

test('guard_not_found in the REAL client shape is a null state, not unreachable', async () => {
  const ws = makeWorkspace();
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({
    status: 'error',
    error_type: 'guard_not_found',
    message: `no guard registered for "compose:deadbeef1234:GATE-1"`,
  }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true,
      workspaceRoot: ws.root, filesChanged: ['README.md'],
    });
    assert.equal(r.ok, true, 'an unregistered guard must not refuse the gate');
    assert.ok(calls.find((c) => c.op === 'transition'), 'and the transition must still be attempted');
  } finally {
    reset();
  }
});

test('a genuinely unreachable guard STILL refuses — the fix must not fail open', async () => {
  const ws = makeWorkspace();
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({
    status: 'error',
    error_type: 'timeout',
    message: 'Stratum guard timed out',
  }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: ws.sha, testsPass: true,
      workspaceRoot: ws.root, filesChanged: ['README.md'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusedAt, 'guard');
    assert.deepEqual(r.reasons, ['guard unreachable']);
  } finally {
    reset();
  }
});

// ---------------------------------------------------------------------------
// Slice 3 — the gate owns the projections (§2.3a)
// ---------------------------------------------------------------------------

function writeVision(root, items) {
  mkdirSync(path.join(root, '.compose', 'data'), { recursive: true });
  writeFileSync(path.join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items, connections: [], gates: [] }));
}
const readVision = (root) => JSON.parse(readFileSync(path.join(root, '.compose', 'data', 'vision-state.json'), 'utf8'));

test('AC-4a: after a gated completion, ROADMAP and vision are NOT stale (the round-2 P0)', async () => {
  const { root, sha, cleanup } = makeWorkspace({ guard: true, status: 'IN_PROGRESS' });
  const calls = [];
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  writeVision(root, [{ id: 'it-1', title: 'GATE-1', status: 'in_progress', lifecycle: { featureCode: 'GATE-1', mode: 'build', currentPhase: 'ship' } }]);
  try {
    const r = await completionGate({ featureCode: 'GATE-1', commitSha: sha, testsPass: true, workspaceRoot: root });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.partial, false, JSON.stringify(r.failures));
    assert.equal(featureStatus(root), 'COMPLETE');
    assert.deepEqual(r.result.status_changed, { from: 'IN_PROGRESS', to: 'COMPLETE' });
    assert.equal(r.result.completion_id, `GATE-1:${sha}`);

    // ROADMAP regenerated with the new status
    const roadmap = readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');
    assert.match(roadmap, /GATE-1[\s\S]*COMPLETE/, 'ROADMAP row reflects COMPLETE');

    // Vision projected through the seam, with the tier stamped. The guard stub
    // reports not-found for history, so this is honestly canonical-status-only.
    const it = readVision(root).items[0];
    assert.equal(it.status, 'complete');
    assert.equal(it.completion_projection.verified_by, 'canonical-status-only');
    assert.equal(it.completion_projection.commit_sha, sha);
    assert.equal(r.visionProjection.verified_by, 'canonical-status-only');

    // The gate's own status event carries the operation id + reason
    const events = readFileSync(path.join(root, '.compose', 'data', 'feature-events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const flip = events.find((e) => e.tool === 'set_feature_status' && e.code === 'GATE-1');
    assert.ok(flip, 'status event appended');
    assert.equal(flip.reason, 'completion_gate');
    assert.equal(flip.operation_id, r.operationId);

    assert.equal(calls.filter((c) => c.op === 'transition').length, 1, 'exactly one guard transition');
    assert.equal(readIntent(root, 'GATE-1'), null, 'intent cleared');
  } finally { reset(); cleanup(); }
});

test('AC-4c: a projection failure is reported as partial, never a silent success', async () => {
  const { root, sha, cleanup } = makeWorkspace({ guard: true, status: 'IN_PROGRESS' });
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  // Make ROADMAP.md a directory so the roadmap writer throws.
  mkdirSync(path.join(root, 'ROADMAP.md'));
  try {
    const r = await completionGate({ featureCode: 'GATE-1', commitSha: sha, testsPass: true, workspaceRoot: root });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.partial, true);
    assert.equal(r.failures[0].step, 'roadmap');
    assert.match(r.failures[0].recover, /roadmap generate/);
    assert.equal(r.result.status_flip_partial, true);
    assert.equal(featureStatus(root), 'COMPLETE', 'the durable truth stands');
    assert.equal(readIntent(root, 'GATE-1'), null, 'a partial projection is still a completed operation');
  } finally { reset(); cleanup(); }
});

test('AC-4c: a VISION projection failure reaches the writer-shaped result every caller returns (Codex r1 #3)', async () => {
  const { root, sha, cleanup } = makeWorkspace({ guard: true, status: 'IN_PROGRESS' });
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({
      featureCode: 'GATE-1', commitSha: sha, testsPass: true, workspaceRoot: root,
      visionProjector: async () => { throw new Error('cockpit exploded'); },
    });
    assert.equal(r.ok, true);
    assert.equal(r.partial, true);
    assert.equal(r.failures[0].step, 'vision');
    // The legacy result — what record_completion (MCP), the CLI and
    // recordCompletion() hand back — must say so too.
    assert.equal(r.result.partial, true);
    assert.equal(r.result.status_flip_partial, true);
    assert.equal(r.result.failures[0].step, 'vision');
    assert.match(r.result.failures[0].message, /cockpit exploded/);
    assert.equal(featureStatus(root), 'COMPLETE');
  } finally { reset(); cleanup(); }
});

test('AC-4a: no vision item is a skipped projection, not a failure (paths 1–2 carry no item id)', async () => {
  const { root, sha, cleanup } = makeWorkspace({ guard: true, status: 'IN_PROGRESS' });
  _testOnly_setGuardClient(applyingGuard([]));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  try {
    const r = await completionGate({ featureCode: 'GATE-1', commitSha: sha, testsPass: true, workspaceRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.partial, false);
    assert.equal(r.visionProjection.skipped, true);
  } finally { reset(); cleanup(); }
});

test('AC-20: no import cycle — each entry point loads cleanly when imported FIRST', () => {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const first of ['lib/completion-gate.js', 'lib/feature-writer.js', 'server/lifecycle-guard.js', 'lib/completion-writer.js', 'lib/vision-writer.js', 'server/completion-projection.js']) {
    const others = ['lib/completion-gate.js', 'lib/feature-writer.js', 'server/lifecycle-guard.js', 'lib/completion-writer.js', 'lib/vision-writer.js', 'server/completion-projection.js'].filter((m) => m !== first);
    const code = [first, ...others].map((m) => `await import(${JSON.stringify(path.join(ROOT, m))});`).join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: ROOT });
    assert.equal(r.status, 0, `importing ${first} first failed:\n${r.stderr}`);
  }
});
