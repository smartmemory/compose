/**
 * COMP-SETUP-PREFLIGHT-1 fix round 2 (MEDIUM-1 of review-fix-round-1.md).
 *
 * The bundled build pipelines run the tests (`coverage`) BEFORE the paid reviews, so a
 * failing suite never pays for a review. The review fixers still change code after
 * that, so the pipelines run the same tests sub-flow again (`retest`) after the last
 * review. This module holds the two small decisions Compose makes around that step:
 *
 *  - is the code the same code that already passed the tests? Then the second run is a
 *    logged no-op skip, not a second paid test run (`codeFingerprint`).
 *  - did a review fixer run? Then ship's own test run must really attest a pass for the
 *    feature to be marked COMPLETE, guarded project or not (`isReviewStep`).
 */
import { execFileSync } from 'node:child_process';
import { withTemporaryIndex } from './consumer-fanout.js';
import { classifyStepAsTier } from './gate-tiers.js';

/** The tests step of the shipped `coverage_check` sub-flow (`coverage/run_tests`, `retest/run_tests`). */
export function isTestsStep(stepId) {
  return typeof stepId === 'string' && stepId.split('/').at(-1) === 'run_tests';
}

/** A Claude review (T3) or the Codex review (T4) step, whose fixer changes code. */
export function isReviewStep(stepId) {
  const tier = classifyStepAsTier(stepId);
  return tier === 'T3' || tier === 'T4';
}

/**
 * A git tree id for the working content (tracked + untracked, not ignored), leaving
 * the real index alone. `.compose/` is excluded: Compose writes its own stream and state
 * there during every step, which is not code. Returns null where there is no git repo;
 * the caller then runs the tests (it never skips on an unknown).
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function codeFingerprint(cwd) {
  try {
    return withTemporaryIndex(cwd, (env) => {
      const run = (args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      try { run(['read-tree', 'HEAD']); } catch { /* no commit yet: start from an empty index */ }
      run(['add', '-A']);
      // Not an exclude pathspec: git refuses one that names an ignored path.
      run(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.compose']);
      return run(['write-tree']) || null;
    });
  } catch {
    return null;
  }
}
