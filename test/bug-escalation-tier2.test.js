/**
 * bug-escalation-tier2.test.js — COMP-FIX-HARD T10 Tier 2 (fresh agent in worktree).
 *
 * Run: node --test test/bug-escalation-tier2.test.js
 *
 * Coverage:
 *   - "Materially new" gate: skip when codex hypothesis already in ledger
 *     with verdict='rejected'.
 *   - Proceed when no matching rejected hypothesis.
 *   - Worktree create + agent dispatch + cleanup-on-success.
 *   - Cleanup-on-error: agent dispatch throws → worktree still removed.
 *   - Patch artifact path increments per attempt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { tier2FreshAgent } = await import(`${REPO_ROOT}/lib/bug-escalation.js`);
const { appendHypothesisEntry } = await import(`${REPO_ROOT}/lib/bug-ledger.js`);

function initGitRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'bug-esc-tier2-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email t@t.io', { cwd });
  execSync('git config user.name test', { cwd });
  writeFileSync(join(cwd, 'README.md'), 'init\n');
  execSync('git add -A && git commit -q -m init', { cwd });
  return cwd;
}
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

function makeStratum(behavior /* (type, prompt, opts) => string|throws */) {
  const calls = [];
  return {
    calls,
    runAgentText: async (type, prompt, opts) => {
      calls.push({ type, prompt, opts });
      return await behavior(type, prompt, opts);
    },
  };
}

function buildReview(hypothesis = 'Off-by-one in cursor decode') {
  return {
    clean: false,
    summary: hypothesis,
    findings: [
      { lens: 'general', file: 'lib/x.js', line: 1, severity: 'must-fix', finding: hypothesis, confidence: 9 },
    ],
    meta: { agent_type: 'codex', model_id: null },
    lenses_run: [], auto_fixes: [], asks: [],
  };
}

describe('tier2FreshAgent — materially-new gate', () => {
  test('skips when codex hypothesis already in ledger as rejected', async () => {
    const cwd = initGitRepo();
    try {
      const code = 'BUG-T2A';
      const codexReview = buildReview('cache eviction race');
      // Pre-load ledger: a rejected entry whose hypothesis matches codex's.
      appendHypothesisEntry(cwd, code, {
        attempt: 1, ts: '2026-05-01T00:00:00Z',
        hypothesis: 'cache eviction race',
        verdict: 'rejected',
      });

      const stratum = makeStratum(async () => 'should not be called');
      const context = { cwd, mode: 'bug', bug_code: code };
      const result = await tier2FreshAgent(stratum, context, codexReview, [], null);
      assert.equal(result.skipped, true);
      assert.match(result.reason, /no new hypothesis/i);
      assert.equal(stratum.calls.length, 0);
    } finally {
      cleanup(cwd);
    }
  });

  test('proceeds when codex hypothesis is materially new', async () => {
    const cwd = initGitRepo();
    try {
      const code = 'BUG-T2B';
      // Existing rejected hypothesis is unrelated to codex's.
      appendHypothesisEntry(cwd, code, {
        attempt: 1, ts: '2026-05-01T00:00:00Z',
        hypothesis: 'race in cache eviction',
        verdict: 'rejected',
      });
      const codexReview = buildReview('cursor decoded with parseInt drops chars');
      const stratum = makeStratum(async () => 'agent reasoning text');
      const context = { cwd, mode: 'bug', bug_code: code };
      const result = await tier2FreshAgent(stratum, context, codexReview, [], null);
      assert.notEqual(result.skipped, true);
      assert.ok(result.patch_path);
      assert.equal(stratum.calls.length, 1);
      assert.equal(stratum.calls[0].type, 'claude');
    } finally {
      cleanup(cwd);
    }
  });
});

describe('tier2FreshAgent — worktree lifecycle', () => {
  test('creates and removes worktree on success', async () => {
    const cwd = initGitRepo();
    try {
      const codexReview = buildReview('a new angle');
      const observed = { wtPath: null, wtExistedDuringCall: false };
      const stratum = makeStratum(async (_t, _p, opts) => {
        observed.wtPath = opts.cwd;
        observed.wtExistedDuringCall = existsSync(opts.cwd);
        return 'patch reasoning';
      });
      const context = { cwd, mode: 'bug', bug_code: 'BUG-T2C' };
      const result = await tier2FreshAgent(stratum, context, codexReview, [], null);
      assert.equal(observed.wtExistedDuringCall, true);
      assert.equal(existsSync(observed.wtPath), false, 'worktree should be removed after success');
      assert.ok(result.patch_path);
      assert.match(result.agent_reasoning, /patch reasoning/);
    } finally {
      cleanup(cwd);
    }
  });

  test('removes worktree even when agent dispatch throws', async () => {
    const cwd = initGitRepo();
    try {
      const codexReview = buildReview('another fresh angle');
      const observed = { wtPath: null };
      const stratum = makeStratum(async (_t, _p, opts) => {
        observed.wtPath = opts.cwd;
        throw new Error('agent failed');
      });
      const context = { cwd, mode: 'bug', bug_code: 'BUG-T2D' };
      await assert.rejects(
        tier2FreshAgent(stratum, context, codexReview, [], null),
        /agent failed/,
      );
      assert.ok(observed.wtPath, 'worktree path should have been captured');
      assert.equal(existsSync(observed.wtPath), false, 'worktree must be cleaned up after error');
    } finally {
      cleanup(cwd);
    }
  });
});

describe('tier2FreshAgent — patch artifact path', () => {
  test('increments N per attempt', async () => {
    const cwd = initGitRepo();
    try {
      const code = 'BUG-T2E';
      const codexReview = buildReview('first new angle');
      const stratum = makeStratum(async () => 'reason');
      const context = { cwd, mode: 'bug', bug_code: code };

      const r1 = await tier2FreshAgent(stratum, context, codexReview, [], null);
      // simulate prior patch persisted (the fresh agent would write it; we test
      // that the next call increments N regardless of whether file exists).
      mkdirSync(join(cwd, 'docs', 'bugs', code), { recursive: true });
      writeFileSync(r1.patch_path, '# patch 1\n');

      const codexReview2 = buildReview('second new angle');
      const r2 = await tier2FreshAgent(stratum, context, codexReview2, [], null);

      assert.match(r1.patch_path, /escalation-patch-1\.md$/);
      assert.match(r2.patch_path, /escalation-patch-2\.md$/);
    } finally {
      cleanup(cwd);
    }
  });
});
