/**
 * diagnose-retry-with-ledger.test.js — COMP-FIX-HARD T6.
 *
 * Verifies:
 *   1. buildRetryPrompt prepends a "Previously Rejected Hypotheses" block when
 *      context.mode === 'bug', stepDispatch.step_id === 'diagnose',
 *      context.bug_code is set, and the ledger has rejected entries.
 *   2. Empty ledger → output unchanged from current behavior.
 *   3. Bug mode + non-diagnose step → output unchanged.
 *   4. Feature mode → output unchanged.
 *   5. After diagnose success in bug mode, recordDiagnoseSuccessIfBugMode appends
 *      one ledger entry with verdict 'accepted'.
 *   6. After diagnose success in feature mode, no ledger write occurs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildRetryPrompt } = await import(`${REPO_ROOT}/lib/step-prompt.js`);
const {
  appendHypothesisEntry,
  readHypotheses,
  getHypothesesPath,
} = await import(`${REPO_ROOT}/lib/bug-ledger.js`);
const { recordDiagnoseSuccessIfBugMode } = await import(`${REPO_ROOT}/lib/build.js`);

function makeTmpCwd() {
  return mkdtempSync(join(tmpdir(), 'diagnose-retry-ledger-test-'));
}
function cleanup(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

const diagnoseDispatch = {
  step_id: 'diagnose',
  intent: 'Identify the root cause of the failing test',
  inputs: { task: 'Fix flaky parser' },
  output_fields: [{ name: 'root_cause', type: 'string' }],
  ensure: ['root_cause is non-empty'],
};

const otherDispatch = {
  step_id: 'execute',
  intent: 'Apply the fix',
  inputs: {},
  output_fields: [],
  ensure: [],
};

// 1. Bug mode + diagnose + ledger has rejected entries → prompt starts with Previously Rejected block
test('buildRetryPrompt prepends Previously Rejected block in bug+diagnose with rejected ledger entries', () => {
  const cwd = makeTmpCwd();
  try {
    appendHypothesisEntry(cwd, 'BUG-T6-A', {
      attempt: 1,
      ts: '2026-05-01T00:00:00Z',
      hypothesis: 'Off-by-one in the parser',
      verdict: 'rejected',
      evidence_against: ['test still fails after re-indexing'],
    });

    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-A', featureCode: 'BUG-T6-A' };
    const prompt = buildRetryPrompt(diagnoseDispatch, ['root_cause was empty'], ctx);

    assert.ok(
      prompt.startsWith('## Previously Rejected Hypotheses'),
      'prompt should start with the rejected-hypotheses header'
    );
    assert.ok(prompt.includes('Off-by-one in the parser'), 'prompt should include the prior hypothesis');
    // RETRY header still present, after the ledger block
    const ledgerIdx = prompt.indexOf('## Previously Rejected Hypotheses');
    const retryIdx = prompt.indexOf('RETRY');
    assert.ok(ledgerIdx < retryIdx, 'ledger block must appear before RETRY header');
  } finally { cleanup(cwd); }
});

// 2. Bug mode + diagnose + empty ledger → unchanged
test('buildRetryPrompt unchanged in bug+diagnose with empty ledger', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-EMPTY', featureCode: 'BUG-T6-EMPTY' };
    const baseline = buildRetryPrompt(diagnoseDispatch, ['violation X'], { cwd, featureCode: 'F' });
    const got = buildRetryPrompt(diagnoseDispatch, ['violation X'], ctx);

    assert.ok(!got.startsWith('## Previously Rejected Hypotheses'), 'no rejected block when ledger empty');
    // Should be identical content shape (modulo featureCode echo); check the RETRY portion present and identical structure
    assert.ok(got.startsWith('RETRY'), 'should start with RETRY when ledger empty');
    assert.equal(
      got.replace(/Feature: BUG-T6-EMPTY/g, 'Feature: F'),
      baseline,
      'prompt should match baseline (modulo feature code) when ledger empty'
    );
  } finally { cleanup(cwd); }
});

// 3. Bug mode + non-diagnose step → unchanged
test('buildRetryPrompt unchanged in bug mode for non-diagnose step', () => {
  const cwd = makeTmpCwd();
  try {
    appendHypothesisEntry(cwd, 'BUG-T6-NONDIAG', {
      attempt: 1, ts: '2026-05-01T00:00:00Z',
      hypothesis: 'should not appear', verdict: 'rejected',
    });

    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-NONDIAG', featureCode: 'BUG-T6-NONDIAG' };
    const prompt = buildRetryPrompt(otherDispatch, ['v'], ctx);

    assert.ok(!prompt.includes('Previously Rejected'), 'should not inject ledger for non-diagnose step');
    assert.ok(prompt.startsWith('RETRY'), 'should start with RETRY');
  } finally { cleanup(cwd); }
});

// 4. Feature mode → unchanged
test('buildRetryPrompt unchanged in feature mode for diagnose-named step', () => {
  const cwd = makeTmpCwd();
  try {
    // Even if a feature-mode flow had a step called diagnose, no bug_code → no ledger read.
    const ctx = { cwd, mode: 'feature', featureCode: 'AUTH-1' };
    const prompt = buildRetryPrompt(diagnoseDispatch, ['v'], ctx);
    assert.ok(!prompt.includes('Previously Rejected'), 'should not inject ledger in feature mode');
    assert.ok(prompt.startsWith('RETRY'), 'should start with RETRY');
  } finally { cleanup(cwd); }
});

// 5. Diagnose success in bug mode → ledger gains one accepted entry
test('recordDiagnoseSuccessIfBugMode appends accepted entry in bug mode', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-OK' };
    const response = { step_id: 'diagnose' };
    const result = {
      root_cause: 'Race condition in cache invalidation',
      trace_evidence: ['evt:cache.miss before evt:cache.set', 'log line 42 at lib/cache.js:120'],
    };

    recordDiagnoseSuccessIfBugMode(ctx, response, result);

    const entries = readHypotheses(cwd, 'BUG-T6-OK');
    assert.equal(entries.length, 1, 'one entry should have been appended');
    const e = entries[0];
    assert.equal(e.verdict, 'accepted');
    assert.equal(e.hypothesis, 'Race condition in cache invalidation');
    assert.deepEqual(e.evidence_for, [
      'evt:cache.miss before evt:cache.set',
      'log line 42 at lib/cache.js:120',
    ]);
    assert.equal(e.attempt, 1, 'first success → attempt 1');
    assert.ok(typeof e.ts === 'string' && e.ts.length > 0, 'ts should be a non-empty ISO string');
  } finally { cleanup(cwd); }
});

// 6. Feature mode → no ledger write
test('recordDiagnoseSuccessIfBugMode is a no-op in feature mode', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'feature', featureCode: 'AUTH-1' };
    const response = { step_id: 'diagnose' };
    const result = { root_cause: 'X', trace_evidence: [] };

    recordDiagnoseSuccessIfBugMode(ctx, response, result);

    // No bug_code → nothing to look up. Ensure the bugs dir was not created.
    assert.equal(existsSync(join(cwd, 'docs', 'bugs')), false, 'no docs/bugs/ should be created in feature mode');
  } finally { cleanup(cwd); }
});

// 7. Bug mode but non-diagnose response.step_id → no-op
test('recordDiagnoseSuccessIfBugMode is a no-op for non-diagnose steps', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-NOOP' };
    const response = { step_id: 'execute' };
    const result = { root_cause: 'X' };

    recordDiagnoseSuccessIfBugMode(ctx, response, result);

    assert.equal(existsSync(getHypothesesPath(cwd, 'BUG-T6-NOOP')), false, 'no ledger file should be created');
  } finally { cleanup(cwd); }
});
