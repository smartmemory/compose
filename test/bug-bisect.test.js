/**
 * bug-bisect.test.js — Unit tests for COMP-FIX-HARD bisect helpers.
 *
 * Run: node --test test/bug-bisect.test.js
 *
 * TDD strategy: build synthetic git repos in tmpdirs (mkdtempSync + git init +
 * scripted commits), so we exercise the real `git` CLI via `child_process`.
 *
 * Coverage:
 *   - classifyRegression: true when repro test is in main + affected files
 *     touched in last 10 commits on main
 *   - classifyRegression: false when repro test was authored after the bug
 *     (file present in last 10 commits but not in main branch tip)
 *   - classifyRegression: false when affected_layers files weren't touched
 *     recently
 *   - estimateBisectCost: test_runs = log2(commit count); seconds_per_run
 *     comes from a real timed sample
 *   - runBisect: drives `git bisect run` against a scripted bad commit;
 *     returns the actual bad commit hash; writes a log file
 *   - runBisect: always calls `git bisect reset` in finally — even when the
 *     test command throws or `git bisect run` errors
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  classifyRegression,
  estimateBisectCost,
  runBisect,
} = await import(`${REPO_ROOT}/lib/bug-bisect.js`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'bug-bisect-test-'));
  // Configure git so commits work without global identity.
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  return dir;
}

function commitFile(dir, relPath, contents, msg) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  execSync(`git add ${JSON.stringify(relPath)}`, { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(msg)}`, { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── classifyRegression ───────────────────────────────────────────────────────

describe('classifyRegression', () => {
  test('true when repro test exists in main AND affected files touched in last 10 commits', () => {
    const cwd = makeTmpRepo();
    try {
      commitFile(cwd, 'src/widget.js', 'export const x = 1;\n', 'init widget');
      commitFile(cwd, 'test/widget.test.js', '// repro\n', 'add repro test');
      // Recent touch to affected layer:
      commitFile(cwd, 'src/widget.js', 'export const x = 2;\n', 'tweak widget');

      const result = classifyRegression(
        cwd,
        { affected_layers: ['src/widget.js'] },
        'test/widget.test.js'
      );
      assert.equal(result, true);
    } finally {
      cleanup(cwd);
    }
  });

  test('false when repro test was authored AFTER the bug (test file not in main tip)', () => {
    const cwd = makeTmpRepo();
    try {
      commitFile(cwd, 'src/widget.js', 'export const x = 1;\n', 'init widget');
      // No test file is ever committed — so it is not "in main".
      const result = classifyRegression(
        cwd,
        { affected_layers: ['src/widget.js'] },
        'test/widget.test.js'
      );
      assert.equal(result, false);
    } finally {
      cleanup(cwd);
    }
  });

  test('false when affected_layers files were not touched in last 10 commits', () => {
    const cwd = makeTmpRepo();
    try {
      // Touch the affected file early then make 10+ unrelated commits.
      commitFile(cwd, 'src/old.js', 'old\n', 'init old (the affected file)');
      commitFile(cwd, 'test/old.test.js', '// repro\n', 'add repro');
      for (let i = 0; i < 11; i++) {
        commitFile(cwd, `src/unrelated-${i}.js`, `export const v = ${i};\n`, `unrelated ${i}`);
      }

      const result = classifyRegression(
        cwd,
        { affected_layers: ['src/old.js'] },
        'test/old.test.js'
      );
      assert.equal(result, false);
    } finally {
      cleanup(cwd);
    }
  });
});

// ── estimateBisectCost ───────────────────────────────────────────────────────

describe('estimateBisectCost', () => {
  test('test_runs equals ceil(log2(commit count)); total_minutes = test_runs * seconds_per_run / 60', () => {
    const cwd = makeTmpRepo();
    try {
      // Create 8 commits in the range — log2(8) = 3.
      let head;
      for (let i = 0; i < 8; i++) {
        head = commitFile(cwd, `f${i}.txt`, `${i}\n`, `c${i}`);
      }
      // Use the very first commit as the known-good baseline.
      const firstCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd })
        .toString().trim();

      // A trivial test command that returns quickly.
      const cost = estimateBisectCost(cwd, 'true', `${firstCommit}..HEAD`);

      assert.equal(typeof cost.test_runs, 'number');
      assert.equal(typeof cost.seconds_per_run, 'number');
      assert.equal(typeof cost.total_minutes, 'number');
      assert.ok(cost.test_runs >= 1, 'test_runs must be at least 1');
      assert.ok(cost.test_runs <= 4, `expected ~log2(8)=3 runs, got ${cost.test_runs}`);
      assert.ok(cost.seconds_per_run >= 0, 'seconds_per_run non-negative');
      const expectedMin = (cost.test_runs * cost.seconds_per_run) / 60;
      assert.ok(
        Math.abs(cost.total_minutes - expectedMin) < 1e-6,
        `total_minutes mismatch: ${cost.total_minutes} vs ${expectedMin}`
      );
    } finally {
      cleanup(cwd);
    }
  });
});

// ── runBisect ────────────────────────────────────────────────────────────────

describe('runBisect', () => {
  test('drives git bisect run, identifies the bad commit, writes a log file', () => {
    const cwd = makeTmpRepo();
    try {
      // Build history: good, good, BAD, good-after.
      // The "test command" passes when token === "good", fails otherwise.
      const goodA = commitFile(cwd, 'token.txt', 'good\n', 'c0 good');
      // Touch a separate file so the next commit has a real diff.
      const goodB = commitFile(cwd, 'sentinel-1.txt', '1\n', 'c1 still good');
      // Insert a real bad commit:
      const bad = commitFile(cwd, 'token.txt', 'bad\n', 'c2 BAD introduces bug');
      // More commits after the bad one — the bug persists.
      commitFile(cwd, 'sentinel-2.txt', '2\n', 'c3 still bad');
      commitFile(cwd, 'sentinel-3.txt', '3\n', 'c4 still bad');

      // Test command: read token.txt and exit non-zero if it contains "bad".
      const testScript = join(cwd, 'check.sh');
      writeFileSync(testScript, '#!/bin/sh\ngrep -q good token.txt\n', 'utf8');
      chmodSync(testScript, 0o755);

      // We need the bug-code dir for the log path.
      mkdirSync(join(cwd, 'docs', 'bugs', 'BUG-BIS-1'), { recursive: true });

      const result = runBisect(cwd, './check.sh', {
        knownGood: goodB,
        bugCode: 'BUG-BIS-1',
      });

      assert.ok(result.bisect_commit, 'bisect_commit should be set');
      assert.equal(result.bisect_commit, bad, `expected bad=${bad}, got ${result.bisect_commit}`);
      assert.ok(existsSync(result.log_path), 'log file should exist');
    } finally {
      cleanup(cwd);
    }
  });

  test('always runs `git bisect reset` in finally — even when bisect errors', () => {
    const cwd = makeTmpRepo();
    try {
      // Single commit — git bisect cannot start meaningfully without a good ref.
      commitFile(cwd, 'a.txt', 'one\n', 'only commit');
      mkdirSync(join(cwd, 'docs', 'bugs', 'BUG-RESET'), { recursive: true });

      let threw = false;
      try {
        // Pass a bogus knownGood ref to force git bisect to error.
        runBisect(cwd, 'true', {
          knownGood: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          bugCode: 'BUG-RESET',
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true, 'expected runBisect to throw on bad knownGood ref');

      // Verify no bisect state lingers — `git bisect log` should error or be empty.
      let bisectActive = false;
      try {
        execSync('git bisect log', { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        bisectActive = true;
      } catch {
        bisectActive = false;
      }
      assert.equal(bisectActive, false, 'git bisect should have been reset');
    } finally {
      cleanup(cwd);
    }
  });
});
