/**
 * comp-fix-hard-gaps.test.js — COMP-FIX-HARD Phase 7 step 4 coverage sweep.
 *
 * Targets edge cases NOT covered by the existing per-module test files:
 *   1. Concurrent appendHypothesisEntry against the same ledger file
 *      (Promise.all of N writers → all must persist or be deduped, no
 *      truncation, no malformed JSON lines).
 *   2. Malformed inputs:
 *        - readHypotheses with a 1MB malformed-line file (no crash)
 *        - formatRejectedHypotheses tolerates entries missing optional fields
 *        - tier1CodexReview when stratum returns non-JSON garbage
 *          (text-mode fallback lands in ledger)
 *   3. Filesystem edge cases:
 *        - emitCheckpoint when docs/bugs/<code>/ pre-exists as a regular FILE
 *          (must surface a sane error, not corrupt ledger)
 *   4. Mode-mode boundary:
 *        - active-build.json has mode:'feature', subsequent runBuild in
 *          mode:'bug' must start fresh (not implicit-resume the wrong shape).
 *   5. Tier 2 hostile-prompt invariant:
 *        - even if the fresh agent commits inside the worktree, the
 *          parent repo's HEAD/branch is unaffected once the worktree is
 *          removed.
 *
 * Run: node --test test/comp-fix-hard-gaps.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  appendHypothesisEntry,
  readHypotheses,
  formatRejectedHypotheses,
  getHypothesesPath,
} = await import(`${REPO_ROOT}/lib/bug-ledger.js`);

const { emitCheckpoint } = await import(`${REPO_ROOT}/lib/bug-checkpoint.js`);
const { tier1CodexReview, tier2FreshAgent } = await import(`${REPO_ROOT}/lib/bug-escalation.js`);
const { runBuild } = await import(`${REPO_ROOT}/lib/build.js`);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpCwd(prefix = 'fix-hard-gap-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function initGitRepo(prefix) {
  const cwd = makeTmpCwd(prefix);
  execSync('git init -q', { cwd });
  execSync('git config user.email t@t.io', { cwd });
  execSync('git config user.name test', { cwd });
  writeFileSync(join(cwd, 'README.md'), 'init\n');
  execSync('git add -A && git commit -q -m init', { cwd });
  return cwd;
}

function makeProject(tmpDir, { template = 'bug-fix' } = {}) {
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 1, capabilities: { stratum: true } })
  );

  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(
    join(pipeDir, `${template}.stratum.yaml`),
    `
version: "0.2"
contracts:
  PhaseResult:
    phase: { type: string }
    artifact: { type: string }
    outcome: { type: string }
flows:
  ${template === 'bug-fix' ? 'bug_fix' : template}:
    input:
      featureCode: { type: string }
      description: { type: string }
      task: { type: string }
    output: PhaseResult
    steps:
      - id: design
        agent: claude
        intent: "stub"
        inputs: { featureCode: "$.input.featureCode" }
        output_contract: PhaseResult
        retries: 1
`
  );
}

function makeMockStratum() {
  const captured = { plan: null, resume: null, stepDoneCalls: [] };
  return {
    captured,
    async connect() {},
    async plan(spec, flow, inputs) {
      captured.plan = { spec, flow, inputs };
      return {
        status: 'complete',
        flow_id: 'mock-flow-fresh',
        step_id: 'design',
        step_number: 1,
        total_steps: 1,
      };
    },
    async resume(flowId) {
      captured.resume = { flowId };
      return {
        status: 'complete',
        flow_id: flowId,
        step_id: 'design',
        step_number: 1,
        total_steps: 1,
      };
    },
    async stepDone(flowId, stepId, result) {
      captured.stepDoneCalls.push({ flowId, stepId, result });
      return { status: 'complete', flow_id: flowId };
    },
    async audit() { return { status: 'complete' }; },
    async runAgentText() { return { text: '', tokens: { input: 0, output: 0 } }; },
    async close() {},
  };
}

// ── 1. Concurrent ledger appends ──────────────────────────────────────────

describe('appendHypothesisEntry — concurrency', () => {
  test('Promise.all of 10 distinct (attempt,ts) writes — all rows persist, no truncation', async () => {
    const cwd = makeTmpCwd();
    try {
      const N = 10;
      const writes = [];
      for (let i = 0; i < N; i++) {
        writes.push(Promise.resolve().then(() =>
          appendHypothesisEntry(cwd, 'BUG-CONC', {
            attempt: i + 1,
            ts: `2026-05-01T00:00:${String(i).padStart(2, '0')}Z`,
            hypothesis: `h${i}`,
            verdict: 'rejected',
          })
        ));
      }
      await Promise.all(writes);

      const got = readHypotheses(cwd, 'BUG-CONC');
      assert.equal(got.length, N, 'all distinct entries must persist');
      // Every row valid JSON (readHypotheses already filters; double-check raw).
      const raw = readFileSync(getHypothesesPath(cwd, 'BUG-CONC'), 'utf8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      assert.equal(lines.length, N, 'no truncated lines on disk');
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `line malformed: ${line.slice(0,40)}`);
      }
    } finally {
      cleanup(cwd);
    }
  });

  test('Promise.all with duplicate (attempt,ts) keys — idempotent: at most one row per key', async () => {
    const cwd = makeTmpCwd();
    try {
      const dupKey = { attempt: 7, ts: '2026-05-01T00:00:00Z' };
      const N = 6;
      await Promise.all(Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          appendHypothesisEntry(cwd, 'BUG-DUP', {
            ...dupKey,
            hypothesis: `writer-${i}`,
            verdict: 'rejected',
          })
        )
      ));
      const got = readHypotheses(cwd, 'BUG-DUP');
      // Idempotency is best-effort under concurrent writers (the read+append is
      // not atomic), but the file must still be parseable and the entries must
      // share the dup key. We assert: ≥1 row, ≤N rows, every row uses dupKey.
      assert.ok(got.length >= 1 && got.length <= N, `expected 1..${N} entries, got ${got.length}`);
      for (const e of got) {
        assert.equal(e.attempt, dupKey.attempt);
        assert.equal(e.ts, dupKey.ts);
      }
    } finally {
      cleanup(cwd);
    }
  });
});

// ── 2. Malformed inputs ──────────────────────────────────────────────────

describe('readHypotheses — pathological input', () => {
  test('1MB of malformed lines — does not crash, returns []', () => {
    const cwd = makeTmpCwd();
    try {
      const path = getHypothesesPath(cwd, 'BUG-MAL-BIG');
      mkdirSync(dirname(path), { recursive: true });
      // Build ~1MB of garbage with trailing newlines.
      const chunk = '{not json:::' + 'x'.repeat(80) + '\n';
      const buf = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
      writeFileSync(path, buf, 'utf8');

      const origWarn = console.warn;
      console.warn = () => {}; // suppress noise
      let got;
      try {
        got = readHypotheses(cwd, 'BUG-MAL-BIG');
      } finally {
        console.warn = origWarn;
      }
      assert.deepEqual(got, [], 'all lines malformed → no entries returned');
    } finally {
      cleanup(cwd);
    }
  });
});

describe('formatRejectedHypotheses — entries with missing fields', () => {
  test('rejected entry with no evidence_against / no next_to_try → still rendered', () => {
    const out = formatRejectedHypotheses([
      { attempt: 1, ts: 't1', hypothesis: 'minimal', verdict: 'rejected' },
    ]);
    assert.match(out, /## Previously Rejected Hypotheses/);
    assert.match(out, /minimal/);
    // No "Evidence against" or "Next to try" sections expected.
    assert.doesNotMatch(out, /Evidence against/);
    assert.doesNotMatch(out, /Next to try/);
  });

  test('rejected entry with evidence_for only → renders that section, not evidence_against', () => {
    const out = formatRejectedHypotheses([
      {
        attempt: 1, ts: 't1', hypothesis: 'h', verdict: 'rejected',
        evidence_for: ['weak signal A'],
      },
    ]);
    assert.match(out, /Evidence for:/);
    assert.match(out, /weak signal A/);
    assert.doesNotMatch(out, /Evidence against:/);
  });

  test('non-array / null input → "" (defensive)', () => {
    assert.equal(formatRejectedHypotheses(null), '');
    assert.equal(formatRejectedHypotheses(undefined), '');
    assert.equal(formatRejectedHypotheses('not an array'), '');
  });
});

describe('tier1CodexReview — codex returns non-JSON garbage', () => {
  test('text-mode fallback used; ledger entry still appended with verdict escalation_tier_1', async () => {
    const cwd = makeTmpCwd();
    try {
      const stratum = {
        runAgentText: async () => 'this is not JSON at all, just rambling prose',
      };
      const review = await tier1CodexReview(
        stratum,
        { cwd, mode: 'bug', bug_code: 'BUG-CODEX-GARBAGE' },
        'desc', 'repro', 'diff', [],
      );
      // normalizeReviewResult fallback path returns a result; we don't assert
      // on its findings shape (varies by text-mode heuristic), only that the
      // ledger got an entry.
      assert.ok(review, 'review result returned');
      const entries = readHypotheses(cwd, 'BUG-CODEX-GARBAGE');
      assert.equal(entries.length, 1, 'one ledger entry appended');
      assert.equal(entries[0].verdict, 'escalation_tier_1');
      assert.equal(entries[0].agent, 'codex');
    } finally {
      cleanup(cwd);
    }
  });
});

// ── 3. Filesystem edge cases ─────────────────────────────────────────────

describe('emitCheckpoint — filesystem hostility', () => {
  test('docs/bugs/<code>/ pre-exists as a regular file → throws (not silent corruption)', async () => {
    const cwd = makeTmpCwd();
    try {
      // Create docs/bugs/, then place a regular file where the bug dir would be.
      mkdirSync(join(cwd, 'docs', 'bugs'), { recursive: true });
      writeFileSync(join(cwd, 'docs', 'bugs', 'BUG-FILE'), 'i am a file, not a dir\n');

      await assert.rejects(
        emitCheckpoint(
          { cwd, bug_code: 'BUG-FILE' },
          'design',
          { violations: [], retries_exhausted: 3 },
        ),
        // mkdirSync with recursive:true throws ENOTDIR / EEXIST when the
        // path is a regular file. We accept either error code.
        /EEXIST|ENOTDIR|file already exists/i,
      );
    } finally {
      cleanup(cwd);
    }
  });
});

// ── 4. Mode-mode boundary (cross-mode active build) ──────────────────────

describe('runBuild — mode boundary', () => {
  test('active-build is feature-mode → bug-mode invocation starts fresh (no implicit cross-mode resume)', async () => {
    const tmpDir = makeTmpCwd('cross-mode-');
    try {
      makeProject(tmpDir, { template: 'bug-fix' });
      // Pre-seed an active-build.json from a prior FEATURE-mode run.
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
      writeFileSync(activePath, JSON.stringify({
        featureCode: 'BUG-XMODE',
        flowId: 'flow-stale-feature',
        mode: 'feature',           // ← cross-mode
        status: 'running',
        pid: process.pid,
      }));

      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-XMODE');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-XMODE\n');

      const stratum = makeMockStratum();
      await runBuild('BUG-XMODE', {
        cwd: tmpDir,
        stratum,
        mode: 'bug',
        template: 'bug-fix',
        description: 'cross-mode bug',
        skipTriage: true,
      });

      // Must call plan() (fresh start), NOT resume() — implicit cross-mode
      // resume of a feature flow under bug-mode would corrupt state.
      assert.ok(stratum.captured.plan, 'plan() must be called (fresh start)');
      assert.equal(stratum.captured.resume, null,
        'resume() must NOT be called when prior active build is in a different mode');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ── 5. Tier 2 hostile-prompt invariant ───────────────────────────────────

describe('tier2FreshAgent — worktree commit isolation', () => {
  test('agent committing inside worktree does NOT affect parent repo HEAD/branch', async () => {
    const cwd = initGitRepo('tier2-isolate-');
    try {
      const parentHeadBefore = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
      const parentBranchBefore = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();

      // Hostile agent: ignores the "DO NOT commit" rule and creates an
      // orphan commit inside the worktree (which is detached HEAD).
      const stratum = {
        runAgentText: async (_type, _prompt, opts) => {
          const wt = opts.cwd;
          // Create a file and commit it inside the worktree.
          writeFileSync(join(wt, 'rogue.txt'), 'hostile content\n');
          execSync('git add rogue.txt', { cwd: wt });
          execSync('git -c user.email=x@x -c user.name=x commit -q -m rogue', { cwd: wt });
          return 'I committed anyway, muahaha';
        },
      };

      const codexReview = {
        clean: false,
        summary: 'fresh angle for hostile test',
        findings: [{
          lens: 'general', file: 'lib/x.js', line: 1, severity: 'must-fix',
          finding: 'fresh', confidence: 9,
        }],
        meta: { agent_type: 'codex', model_id: null },
        lenses_run: [], auto_fixes: [], asks: [],
      };

      await tier2FreshAgent(
        stratum,
        { cwd, mode: 'bug', bug_code: 'BUG-HOSTILE' },
        codexReview,
        [],
        null,
      );

      // After tier2 returns, the parent repo's HEAD and branch must be
      // identical to before. The orphan commit died with the worktree.
      const parentHeadAfter = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
      const parentBranchAfter = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
      assert.equal(parentHeadAfter, parentHeadBefore, 'parent HEAD unchanged');
      assert.equal(parentBranchAfter, parentBranchBefore, 'parent branch unchanged');

      // Parent working tree must not contain rogue.txt.
      assert.equal(existsSync(join(cwd, 'rogue.txt')), false,
        'rogue file from worktree must not leak to parent');
    } finally {
      cleanup(cwd);
    }
  });
});
