/**
 * bug-bisect.js — COMP-FIX-HARD bisect helpers (T7).
 *
 * Drives `git bisect` against a synthetic-or-real test command to localize
 * a regression to a single commit. Used by the `bisect` step in the
 * bug-fix.stratum.yaml pipeline.
 *
 * API:
 *   - classifyRegression(cwd, diagnosisResult, reproTestPath)
 *       → boolean. True iff the repro test exists in the main branch's tree
 *         AND any file in `diagnosisResult.affected_layers` was touched in
 *         the last 10 commits on main. This is the "is this a regression?"
 *         gate test for the `bisect` step.
 *
 *   - estimateBisectCost(cwd, testCmd, knownGoodRange)
 *       → { test_runs, seconds_per_run, total_minutes }. test_runs is
 *         ceil(log2(commits in `knownGoodRange`)) — the canonical bisect
 *         step count. seconds_per_run is sampled by running `testCmd` once
 *         and timing it.
 *
 *   - findKnownGoodBaseline(cwd)
 *       → string commit hash (or null). Tries tags matching `v*` then
 *         `release-*`; falls back to the commit 50 back from HEAD if no tag.
 *         Surfaced to humans as part of the gate prompt so they can override
 *         before bisect runs.
 *
 *   - runBisect(cwd, testCmd, opts)
 *       → { bisect_commit, log_path }. Executes
 *         `git bisect start && git bisect bad HEAD && git bisect good <ref>
 *          && git bisect run <testCmd>`. Captures stdout+stderr to
 *         `docs/bugs/<bug-code>/bisect.log`. ALWAYS runs `git bisect reset`
 *         in a finally block — even on error.
 *
 * Decision 6 reconciliation (per plan T7):
 *   design.md Decision 6 originally proposed adding `regression_class:
 *   boolean` to the `TriageResult` YAML contract. T7 implements that
 *   classification at runtime in `classifyRegression()` instead — cheaper,
 *   no schema migration, and the bisect step is the only consumer. The
 *   design doc is updated in Phase 9 to reflect this implementation
 *   choice.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const RECENT_COMMITS_WINDOW = 10;
const FALLBACK_BASELINE_DEPTH = 50;

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Run a git command, return trimmed stdout. Returns null on any non-zero exit
 * or other failure (e.g. not a git repo).
 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout ?? '').trim();
}

/**
 * Files in main branch's tree HEAD. Returns a Set of paths, or null on
 * failure. We treat "main" loosely — try `main` then `master` then current
 * HEAD as a last resort.
 */
function listMainTreeFiles(cwd) {
  for (const ref of ['main', 'master', 'HEAD']) {
    const out = git(cwd, ['ls-tree', '-r', '--name-only', ref]);
    if (out !== null) return new Set(out.split('\n').filter(Boolean));
  }
  return null;
}

/**
 * Files changed in the last N commits on main (or master/HEAD fallback).
 */
function filesChangedRecently(cwd, n) {
  for (const ref of ['main', 'master', 'HEAD']) {
    const out = git(cwd, ['log', `-n`, String(n), '--name-only', '--pretty=format:', ref]);
    if (out !== null) return new Set(out.split('\n').filter(Boolean));
  }
  return null;
}

// ── classifyRegression ───────────────────────────────────────────────────────

/**
 * Decide whether a bug looks like a regression worth bisecting.
 *
 * Returns true iff:
 *   1. The repro test path exists in the main branch's tree, AND
 *   2. Any file listed in diagnosisResult.affected_layers was touched in
 *      the most recent RECENT_COMMITS_WINDOW commits on main.
 *
 * Both conditions must hold. (1) ensures the test is part of the known-good
 * suite; if it was authored *after* the bug, it can't witness "good" history
 * and bisect would mislead. (2) ensures recent change is plausibly the
 * culprit — if the affected files haven't been touched recently, a bisect
 * that exhaustively walks history is unlikely to be cost-effective.
 *
 * @param {string} cwd
 * @param {{affected_layers?: string[]}} diagnosisResult
 * @param {string} reproTestPath — path relative to cwd
 * @returns {boolean}
 */
export function classifyRegression(cwd, diagnosisResult, reproTestPath) {
  if (!diagnosisResult || !Array.isArray(diagnosisResult.affected_layers)) {
    return false;
  }
  if (!reproTestPath) return false;

  const treeFiles = listMainTreeFiles(cwd);
  if (!treeFiles || !treeFiles.has(reproTestPath)) return false;

  const recent = filesChangedRecently(cwd, RECENT_COMMITS_WINDOW);
  if (!recent || recent.size === 0) return false;

  for (const layer of diagnosisResult.affected_layers) {
    if (recent.has(layer)) return true;
  }
  return false;
}

// ── estimateBisectCost ───────────────────────────────────────────────────────

/**
 * Estimate the cost of running `git bisect run <testCmd>` on a range.
 *
 * `test_runs` = ceil(log2(commits_in_range)). Bisect halves the range each
 * step, so the worst case is log2(N) test invocations.
 *
 * `seconds_per_run` is sampled by running testCmd ONCE and timing it. We do
 * not retry; a flaky test will skew the estimate but not break the run.
 *
 * `total_minutes` = test_runs * seconds_per_run / 60.
 *
 * @param {string} cwd
 * @param {string} testCmd — shell command, run via `sh -c`
 * @param {string} knownGoodRange — git revision range, e.g. "abc123..HEAD"
 * @returns {{test_runs: number, seconds_per_run: number, total_minutes: number}}
 */
export function estimateBisectCost(cwd, testCmd, knownGoodRange) {
  // Count commits in the range.
  const out = git(cwd, ['rev-list', '--count', knownGoodRange]);
  const commits = out ? parseInt(out, 10) : 0;
  const test_runs = commits > 1 ? Math.ceil(Math.log2(commits)) : 1;

  // Sample one run of testCmd.
  const start = Date.now();
  spawnSync('sh', ['-c', testCmd], { cwd, stdio: 'ignore' });
  const seconds_per_run = (Date.now() - start) / 1000;

  const total_minutes = (test_runs * seconds_per_run) / 60;
  return { test_runs, seconds_per_run, total_minutes };
}

// ── findKnownGoodBaseline ────────────────────────────────────────────────────

/**
 * Pick a "last known good" baseline commit for bisect.
 *
 * Strategy:
 *   1. Most recent tag matching `v*` (semver-ish releases).
 *   2. Most recent tag matching `release-*`.
 *   3. Fall back to the commit FALLBACK_BASELINE_DEPTH back from HEAD.
 *
 * Returns the resolved commit hash, or null if the repo has fewer commits
 * than the fallback depth and no tags.
 *
 * The return value is surfaced to humans in the gate prompt so they can
 * override before `runBisect` is invoked.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function findKnownGoodBaseline(cwd) {
  for (const pattern of ['v*', 'release-*']) {
    const tag = git(cwd, ['describe', '--tags', '--abbrev=0', '--match', pattern]);
    if (tag) {
      const sha = git(cwd, ['rev-parse', tag]);
      if (sha) return sha;
    }
  }
  const sha = git(cwd, ['rev-parse', `HEAD~${FALLBACK_BASELINE_DEPTH}`]);
  if (sha) return sha;
  // Last resort: oldest commit in the repo.
  const root = git(cwd, ['rev-list', '--max-parents=0', 'HEAD']);
  if (root) return root.split('\n')[0];
  return null;
}

// ── runBisect ────────────────────────────────────────────────────────────────

/**
 * Drive `git bisect` end-to-end and return the first-bad commit.
 *
 * Sequence:
 *   git bisect start
 *   git bisect bad HEAD
 *   git bisect good <opts.knownGood>
 *   git bisect run <testCmd>
 *
 * The full transcript (stdout+stderr from each step) is captured to
 * `docs/bugs/<opts.bugCode>/bisect.log`. The function ALWAYS runs
 * `git bisect reset` in a finally — including when any of the above
 * steps throws — to leave the working tree clean.
 *
 * @param {string} cwd
 * @param {string} testCmd — the predicate command bisect should run
 * @param {object} opts
 * @param {string} opts.knownGood — last-known-good commit ref
 * @param {string} opts.bugCode  — bug code, used to locate the log file
 * @returns {{bisect_commit: string, log_path: string}}
 */
export function runBisect(cwd, testCmd, opts) {
  const { knownGood, bugCode } = opts || {};
  if (!knownGood) throw new Error('runBisect: opts.knownGood required');
  if (!bugCode) throw new Error('runBisect: opts.bugCode required');

  const logPath = join(cwd, 'docs', 'bugs', bugCode, 'bisect.log');
  mkdirSync(dirname(logPath), { recursive: true });

  const transcript = [];
  const append = (label, output) => {
    transcript.push(`### ${label}\n${output ?? ''}\n`);
  };
  const flush = () => {
    try { writeFileSync(logPath, transcript.join('\n'), 'utf8'); } catch {}
  };

  const runStep = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    append(`git ${args.join(' ')}`, (r.stdout || '') + (r.stderr || ''));
    if (r.status !== 0) {
      const err = new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
      err.cause = r;
      throw err;
    }
    return r.stdout || '';
  };

  try {
    runStep(['bisect', 'start']);
    runStep(['bisect', 'bad', 'HEAD']);
    runStep(['bisect', 'good', knownGood]);

    // `git bisect run` exits 0 on success and prints a "X is the first bad
    // commit" line. We capture and parse it.
    const runResult = spawnSync('git', ['bisect', 'run', 'sh', '-c', testCmd], {
      cwd,
      encoding: 'utf8',
    });
    append('git bisect run', (runResult.stdout || '') + (runResult.stderr || ''));
    if (runResult.status !== 0) {
      throw new Error(`git bisect run failed: ${runResult.stderr || runResult.stdout}`);
    }

    // Extract the first-bad commit from the transcript.
    const match = (runResult.stdout || '').match(/([0-9a-f]{40}) is the first bad commit/);
    let bisect_commit = match ? match[1] : null;
    if (!bisect_commit) {
      // Fall back to `git bisect log` — the last `bad` line points at it.
      const logOut = git(cwd, ['bisect', 'log']) || '';
      const m2 = logOut.match(/# first bad commit: \[([0-9a-f]{40})\]/);
      if (m2) bisect_commit = m2[1];
    }
    if (!bisect_commit) {
      throw new Error('runBisect: could not parse first-bad commit from output');
    }

    flush();
    return { bisect_commit, log_path: logPath };
  } finally {
    // Always reset, even on error. Suppress reset failures — the throw above
    // is the user-facing error.
    try {
      const reset = spawnSync('git', ['bisect', 'reset'], { cwd, encoding: 'utf8' });
      append('git bisect reset (finally)', (reset.stdout || '') + (reset.stderr || ''));
    } catch {
      // best-effort
    }
    flush();
  }
}
