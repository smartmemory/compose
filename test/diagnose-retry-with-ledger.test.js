/**
 * diagnose-retry-with-ledger.test.js — COMP-FIX-HARD T6 (TS re-expression).
 *
 * Spec source: the pre-deletion test at cc390a7, which drove the python-era
 * buildRetryPrompt. That function was removed with the python path; the TS
 * diagnose retry reissues through buildStepPrompt (previousFailure block), so
 * this re-expression asserts the rejected-hypotheses ledger block is restored
 * onto buildStepPrompt for a bug-mode diagnose (and absent otherwise).
 *
 * Verifies:
 *   1. bug + diagnose + rejected ledger entries → "## Previously Rejected
 *      Hypotheses" block prepended (before the step body).
 *   2. bug + diagnose + empty ledger → no block.
 *   3. bug + non-diagnose step → no block.
 *   4. feature mode → no block.
 *   5. recordDiagnoseSuccessIfBugMode appends one 'accepted' ledger entry in bug
 *      mode; 6. no ledger write in feature mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildStepPrompt } = await import(`${REPO_ROOT}/lib/step-prompt.js`);
const { appendHypothesisEntry, readHypotheses } = await import(`${REPO_ROOT}/lib/bug-ledger.js`);
const { recordDiagnoseSuccessIfBugMode } = await import(`${REPO_ROOT}/lib/build.js`);

function makeTmpCwd() { return mkdtempSync(join(tmpdir(), 'diagnose-retry-ledger-')); }
function cleanup(d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

const diagnoseDispatch = {
  step_id: 'diagnose', intent: 'Identify the root cause of the failing test',
  inputs: { task: 'Fix flaky parser' }, output_fields: [{ name: 'root_cause', type: 'string' }],
  ensure: ['root_cause is non-empty'],
};
const executeDispatch = { step_id: 'execute', intent: 'Apply the fix', inputs: {}, output_fields: [], ensure: [] };

const HEADER = '## Previously Rejected Hypotheses';

test('bug+diagnose with rejected ledger entries prepends the Previously Rejected block', () => {
  const cwd = makeTmpCwd();
  try {
    appendHypothesisEntry(cwd, 'BUG-T6-A', {
      attempt: 1, ts: '2026-05-01T00:00:00Z',
      hypothesis: 'Off-by-one in the parser', verdict: 'rejected',
      evidence_against: ['test still fails after re-indexing'],
    });
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-A', featureCode: 'BUG-T6-A' };
    const prompt = buildStepPrompt(diagnoseDispatch, ctx);
    assert.ok(prompt.startsWith(HEADER), 'prompt should start with the rejected-hypotheses header');
    assert.ok(prompt.includes('Off-by-one in the parser'), 'includes the prior hypothesis');
    assert.ok(prompt.includes('test still fails after re-indexing'), 'includes the evidence against');
    // The ledger block precedes the ordinary step body.
    assert.ok(prompt.indexOf(HEADER) < prompt.indexOf('You are executing step'), 'ledger block comes first');
  } finally { cleanup(cwd); }
});

test('bug+diagnose with an empty ledger renders no block', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-EMPTY', featureCode: 'BUG-T6-EMPTY' };
    const prompt = buildStepPrompt(diagnoseDispatch, ctx);
    assert.ok(!prompt.includes(HEADER), 'no rejected block when ledger empty');
    assert.ok(prompt.startsWith('You are executing step'), 'ordinary step prompt when ledger empty');
  } finally { cleanup(cwd); }
});

test('bug mode + a non-diagnose step renders no block', () => {
  const cwd = makeTmpCwd();
  try {
    appendHypothesisEntry(cwd, 'BUG-T6-B', {
      attempt: 1, ts: '2026-05-01T00:00:00Z', hypothesis: 'X', verdict: 'rejected', evidence_against: ['y'],
    });
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-B', featureCode: 'BUG-T6-B' };
    const prompt = buildStepPrompt(executeDispatch, ctx);
    assert.ok(!prompt.includes(HEADER), 'no rejected block for a non-diagnose step');
  } finally { cleanup(cwd); }
});

test('feature mode renders no block even for a diagnose step', () => {
  const cwd = makeTmpCwd();
  try {
    appendHypothesisEntry(cwd, 'F-1', {
      attempt: 1, ts: '2026-05-01T00:00:00Z', hypothesis: 'X', verdict: 'rejected', evidence_against: ['y'],
    });
    const ctx = { cwd, mode: 'feature', bug_code: 'F-1', featureCode: 'F-1' };
    // mode !== 'bug' → no block (even though a ledger + bug_code coincide).
    const prompt = buildStepPrompt(diagnoseDispatch, { ...ctx, mode: 'feature' });
    assert.ok(!prompt.includes(HEADER), 'feature mode never renders the rejected block');
  } finally { cleanup(cwd); }
});

test('recordDiagnoseSuccessIfBugMode appends one accepted entry in bug mode', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'bug', bug_code: 'BUG-T6-C', featureCode: 'BUG-T6-C' };
    recordDiagnoseSuccessIfBugMode(ctx, 'diagnose', { root_cause: 'stale cache', summary: 'found it' });
    const entries = readHypotheses(cwd, 'BUG-T6-C');
    const accepted = entries.filter(e => e.verdict === 'accepted');
    assert.equal(accepted.length, 1, 'exactly one accepted entry appended');
  } finally { cleanup(cwd); }
});

test('recordDiagnoseSuccessIfBugMode writes nothing in feature mode', () => {
  const cwd = makeTmpCwd();
  try {
    const ctx = { cwd, mode: 'feature', featureCode: 'F-2' };
    recordDiagnoseSuccessIfBugMode(ctx, 'diagnose', { root_cause: 'x', summary: 'y' });
    assert.ok(!existsSync(join(cwd, 'docs', 'bugs')), 'no ledger tree written in feature mode');
  } finally { cleanup(cwd); }
});
