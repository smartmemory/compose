/**
 * bug-escalation-tier1.test.js — COMP-FIX-HARD T10 Tier 1 (Codex read-only review).
 *
 * Run: node --test test/bug-escalation-tier1.test.js
 *
 * Coverage:
 *   - tier1CodexReview constructs prompt containing bug description, repro test,
 *     diff, and a "Previously attempted" hypothesis block.
 *   - Output parsed via normalizeReviewResult to canonical ReviewResult.
 *   - Ledger receives an entry with verdict 'escalation_tier_1', agent 'codex',
 *     and findings copied from the parsed ReviewResult.
 *   - Dispatch goes through stratum.runAgentText('codex', prompt, {cwd}).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { tier1CodexReview } = await import(`${REPO_ROOT}/lib/bug-escalation.js`);
const { readHypotheses } = await import(`${REPO_ROOT}/lib/bug-ledger.js`);

function makeTmpCwd() {
  return mkdtempSync(join(tmpdir(), 'bug-esc-tier1-'));
}
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

function makeMockStratum(responseText) {
  const calls = [];
  return {
    calls,
    runAgentText: async (type, prompt, opts) => {
      calls.push({ type, prompt, opts });
      return responseText;
    },
  };
}

const CANONICAL_CODEX_JSON = JSON.stringify({
  summary: 'Off-by-one in pagination cursor decoding',
  findings: [
    {
      lens: 'general',
      file: 'lib/paginate.js',
      line: 42,
      severity: 'must-fix',
      finding: 'cursor decoded with parseInt — drops trailing chars',
      confidence: 9,
      rationale: 'See test fixture decode-cursor.test.js',
    },
  ],
});

describe('tier1CodexReview', () => {
  test('prompt contains bug description, repro test, diff, and hypothesis block', async () => {
    const cwd = makeTmpCwd();
    try {
      const stratum = makeMockStratum(CANONICAL_CODEX_JSON);
      const context = { cwd, mode: 'bug', bug_code: 'BUG-T1A' };
      const hypotheses = [
        { attempt: 1, ts: '2026-05-01T00:00:00Z', hypothesis: 'race in cache', verdict: 'rejected', evidence_against: ['no concurrency in repro'] },
        { attempt: 2, ts: '2026-05-01T00:01:00Z', hypothesis: 'wrong default', verdict: 'rejected' },
      ];
      await tier1CodexReview(
        stratum,
        context,
        'Pagination drops last page item',
        'test/pagination.test.js: expect(page).toEqual([...])',
        'diff --git a/lib/paginate.js ...',
        hypotheses,
      );
      assert.equal(stratum.calls.length, 1);
      const call = stratum.calls[0];
      assert.equal(call.type, 'codex');
      assert.equal(call.opts.cwd, cwd);
      assert.match(call.prompt, /Pagination drops last page item/);
      assert.match(call.prompt, /pagination\.test\.js/);
      assert.match(call.prompt, /diff --git/);
      assert.match(call.prompt, /Previously attempted/i);
      assert.match(call.prompt, /race in cache/);
      assert.match(call.prompt, /wrong default/);
    } finally {
      cleanup(cwd);
    }
  });

  test('returns canonical ReviewResult parsed from Codex output', async () => {
    const cwd = makeTmpCwd();
    try {
      const stratum = makeMockStratum(CANONICAL_CODEX_JSON);
      const context = { cwd, mode: 'bug', bug_code: 'BUG-T1B' };
      const review = await tier1CodexReview(stratum, context, 'desc', 'repro', 'diff', []);
      assert.equal(typeof review, 'object');
      assert.equal(review.clean, false);
      assert.equal(review.findings.length, 1);
      assert.equal(review.findings[0].severity, 'must-fix');
      assert.equal(review.meta.agent_type, 'codex');
    } finally {
      cleanup(cwd);
    }
  });

  test('appends ledger entry with verdict=escalation_tier_1, agent=codex, findings', async () => {
    const cwd = makeTmpCwd();
    try {
      const stratum = makeMockStratum(CANONICAL_CODEX_JSON);
      const context = { cwd, mode: 'bug', bug_code: 'BUG-T1C' };
      await tier1CodexReview(stratum, context, 'desc', 'repro', 'diff', []);
      const entries = readHypotheses(cwd, 'BUG-T1C');
      assert.equal(entries.length, 1);
      const e = entries[0];
      assert.equal(e.verdict, 'escalation_tier_1');
      assert.equal(e.agent, 'codex');
      assert.ok(Array.isArray(e.findings) && e.findings.length === 1);
      assert.equal(e.findings[0].severity, 'must-fix');
    } finally {
      cleanup(cwd);
    }
  });

  test('empty hypothesis array still produces well-formed prompt', async () => {
    const cwd = makeTmpCwd();
    try {
      const stratum = makeMockStratum(CANONICAL_CODEX_JSON);
      const context = { cwd, mode: 'bug', bug_code: 'BUG-T1D' };
      const r = await tier1CodexReview(stratum, context, 'desc', 'repro', 'diff', []);
      assert.ok(r.summary);
      assert.equal(stratum.calls.length, 1);
    } finally {
      cleanup(cwd);
    }
  });
});
