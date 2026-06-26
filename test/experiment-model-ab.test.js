/**
 * experiment-model-ab.test.js — Wave 1 unit/integration tests for COMP-MODEL-AB.
 *
 * Covers:
 *   S1 — --implementer / --reviewer flag parsing + precedence + rejection
 *   S2 — experiment-sandbox provision (greenfield + provision failure)
 *   S3 — experiment-metrics collect math over fixture artifact files
 *   S4 — experiment-judge failure degrades to null
 *
 * Run: node --test --test-timeout=60000 test/experiment-model-ab.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_ROOT = resolve(__dirname, '..');
const COMPOSE_BIN = join(COMPOSE_ROOT, 'bin', 'compose.js');
const BUILD_PATH = join(COMPOSE_ROOT, 'pipelines', 'build.stratum.yaml');

// Top-level module imports — valid in ES modules (the test file is .js run as ESM).
const { provision } = await import('../lib/experiment-sandbox.js');
const { collect }   = await import('../lib/experiment-metrics.js');
const { _scaffoldSandboxProject } = await import('../lib/experiment.js');
const { lookupExperimentPricing, deriveUsd } = await import('../lib/experiment-pricing.js');
const { judge }     = await import('../lib/experiment-judge.js');
const { startFresh } = await import('../lib/build.js');

// ---------------------------------------------------------------------------
// S1 — CLI flag parsing (via spawnSync against bin/compose.js)
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S1: --implementer / --reviewer CLI flags', () => {
  const run = (extraArgs) =>
    spawnSync(process.execPath, [COMPOSE_BIN, 'build', ...extraArgs], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

  // --- parse-rejection tests (validation runs before workspace init) ---

  test('rejects --implementer= with unknown provider', () => {
    const r = run(['--implementer=openai::critical', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--implementer.*unknown provider/i);
  });

  test('rejects --reviewer= with unknown provider', () => {
    const r = run(['--reviewer=openai', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--reviewer.*unknown provider/i);
  });

  test('rejects --implementer= with unknown tier', () => {
    const r = run(['--implementer=claude::super', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--implementer.*unknown tier/i);
  });

  test('rejects --reviewer= with unknown tier', () => {
    const r = run(['--reviewer=claude::ultra', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--reviewer.*unknown tier/i);
  });

  // --- mutual exclusion with --codex ---

  test('rejects --codex combined with conflicting --implementer', () => {
    const r = run(['--codex', '--implementer=claude::standard', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /conflicts with --codex/i);
  });

  test('rejects --codex combined with conflicting --reviewer', () => {
    const r = run(['--codex', '--reviewer=codex', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /conflicts with --codex/i);
  });

  test('allows --codex combined with identical --implementer=codex (no conflict)', () => {
    // Use --abort to pass through flag validation without scaffolding any feature dir.
    // The assertion is that "conflicts with --codex" is NOT in stderr — we do not
    // care whether abort fails for some other reason.
    const r = run(['--codex', '--implementer=codex', '--abort']);
    assert.doesNotMatch(r.stderr ?? '', /conflicts with --codex/i);
  });

  test('allows --codex combined with identical --reviewer=claude (no conflict)', () => {
    const r = run(['--codex', '--reviewer=claude', '--abort']);
    assert.doesNotMatch(r.stderr ?? '', /conflicts with --codex/i);
  });
});

// ---------------------------------------------------------------------------
// S1 — startFresh role injection (programmatic)
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S1: startFresh receives tiered implementer/reviewer', () => {
  function fakeStratum() {
    const calls = {};
    return {
      calls,
      async plan(_spec, flowName, planInputs) {
        calls.planInputs = planInputs;
        calls.flowName = flowName;
        return { flow_id: 'flow-ab', step_id: 'explore_design', step_number: 1, total_steps: 10 };
      },
    };
  }

  function withDataDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const specYaml = readFileSync(BUILD_PATH, 'utf-8');

  test('tiered implementer string (claude::standard) passes through to plan inputs intact', async () => {
    await withDataDir(async (dataDir) => {
      const stratum = fakeStratum();
      const roles = { implementerAgent: 'claude::standard', reviewerAgent: 'claude::critical' };
      await startFresh(stratum, specYaml, 'AB-1', 'desc', dataDir, 'build', 'feature', undefined, roles);
      assert.equal(stratum.calls.planInputs.implementer_agent, 'claude::standard',
        'tiered implementer string must reach planInputs intact');
      assert.equal(stratum.calls.planInputs.reviewer_agent, 'claude::critical',
        'tiered reviewer string must reach planInputs intact');
    });
  });

  test('tiered roles are persisted to active-build.json', async () => {
    await withDataDir(async (dataDir) => {
      const stratum = fakeStratum();
      const roles = { implementerAgent: 'claude::critical', reviewerAgent: 'codex' };
      await startFresh(stratum, specYaml, 'AB-1', 'desc', dataDir, 'build', 'feature', undefined, roles);
      const active = JSON.parse(readFileSync(join(dataDir, 'active-build.json'), 'utf-8'));
      assert.equal(active.implementerAgent, 'claude::critical');
      assert.equal(active.reviewerAgent, 'codex');
    });
  });
});

// ---------------------------------------------------------------------------
// S2 — experiment-sandbox provision
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S2: experiment-sandbox provision', () => {
  test('greenfield provision creates workspace with git repo + manifest', async () => {
    const expRoot = mkdtempSync(join(tmpdir(), 'comp-ab-exp-'));
    try {
      const fixture = { goal: 'add(a,b)', seedRepo: null, seedRef: null };
      const sandbox = await provision({ fixture, runId: 'test-run-1', expRoot });

      // workspace exists and is a git repo
      assert.ok(existsSync(sandbox.workspace), 'workspace must exist');
      assert.ok(existsSync(join(sandbox.workspace, '.git')), 'workspace must be a git repo');

      // env sets COMPOSE_TARGET and COMPOSE_PORT
      assert.equal(sandbox.env.COMPOSE_TARGET, sandbox.workspace);
      assert.ok(sandbox.env.COMPOSE_PORT, 'COMPOSE_PORT must be set in sandbox env');
      assert.notEqual(Number(sandbox.env.COMPOSE_PORT), 4001,
        'sandbox COMPOSE_PORT must differ from live server port');

      // manifest.json written
      const manifestPath = join(sandbox.runDir, 'manifest.json');
      assert.ok(existsSync(manifestPath), 'manifest.json must be written');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      assert.equal(manifest.fixtureGoal, 'add(a,b)');
      assert.ok(manifest.startedAt);
      assert.equal(typeof manifest.composeSha, 'string');

      // cleanup removes workspace when pruneWorkspace=true
      sandbox.cleanup({ pruneWorkspace: true });
      assert.ok(!existsSync(sandbox.workspace), 'workspace must be removed after pruneWorkspace');
    } finally {
      rmSync(expRoot, { recursive: true, force: true });
    }
  });

  test('provision failure surfaces cleanly with descriptive error', async () => {
    const expRoot = mkdtempSync(join(tmpdir(), 'comp-ab-err-'));
    try {
      // Use a non-existent seedRepo — git clone will fail.
      const fixture = {
        goal: 'test',
        seedRepo: '/nonexistent-repo-that-should-not-exist-comp-ab',
        seedRef: 'HEAD',
      };
      await assert.rejects(
        () => provision({ fixture, runId: 'fail-run', expRoot }),
        /Sandbox provision failed/
      );
    } finally {
      rmSync(expRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S2b — scaffoldSandboxProject .gitignore append-or-create
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S2b: scaffoldSandboxProject .gitignore behavior', () => {
  test('.gitignore append-or-create: preserves existing rules when workspace already has .gitignore (fix: gitignore clobber)', () => {
    // WOULD FAIL before fix: scaffoldSandboxProject used writeFileSync to overwrite
    // .gitignore with '.compose/\n', deleting pre-existing seed-repo rules like
    // 'node_modules/' and 'dist/' — causing those trees to appear in the diff.
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-gitignore-acreate-'));
    try {
      // Simulate a seeded fixture workspace that already has a .gitignore
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n');

      _scaffoldSandboxProject(dir, 'test fixture goal');

      const result = readFileSync(join(dir, '.gitignore'), 'utf-8');
      assert.ok(result.includes('node_modules/'),
        'must preserve existing node_modules/ rule from seeded fixture');
      assert.ok(result.includes('dist/'),
        'must preserve existing dist/ rule from seeded fixture');
      assert.ok(result.includes('.compose/'),
        'must add .compose/ rule');
      assert.ok(result.endsWith('\n'),
        'must end with newline for clean gitignore hygiene');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.gitignore created from scratch when none exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-gitignore-new-'));
    try {
      _scaffoldSandboxProject(dir, 'test fixture goal');

      const result = readFileSync(join(dir, '.gitignore'), 'utf-8');
      assert.equal(result, '.compose/\n', 'fresh workspace must get exactly .compose/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stale .compose/ from seeded fixture is cleared before scaffold (rmSync fix)', () => {
    // WOULD FAIL before fix: scaffold did not rmSync — a pre-existing .compose/data/
    // build-history.jsonl from a cloned seed repo would survive, causing collect()
    // to read the SEED's stale record and misreport this run's metrics.
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-compose-clear-'));
    try {
      // Pre-create stale .compose state (simulates a seeded fixture with tracked .compose/)
      mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
      writeFileSync(
        join(dir, '.compose', 'data', 'build-history.jsonl'),
        JSON.stringify({ status: 'complete', featureCode: 'STALE', cost_usd: 999 }) + '\n'
      );

      _scaffoldSandboxProject(dir, 'test fixture goal');

      assert.ok(
        !existsSync(join(dir, '.compose', 'data', 'build-history.jsonl')),
        'stale build-history.jsonl must not exist after scaffold — clean slate for this run'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.gitignore is idempotent when .compose/ already present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-gitignore-idempotent-'));
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.compose/\n');

      _scaffoldSandboxProject(dir, 'test fixture goal');

      const result = readFileSync(join(dir, '.gitignore'), 'utf-8');
      // Must not duplicate .compose/
      assert.equal(
        result.split('\n').filter(l => l === '.compose/').length, 1,
        '.compose/ must appear exactly once when already present'
      );
      assert.ok(result.includes('node_modules/'), 'must preserve existing rules');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S3 — experiment-metrics collect
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S3: experiment-metrics collect', () => {
  function makeWorkspace() {
    const ws = mkdtempSync(join(tmpdir(), 'comp-ab-ws-'));
    mkdirSync(join(ws, '.compose', 'data'), { recursive: true });
    execSync('git init -q', { cwd: ws });
    execSync('git config user.email "t@t"', { cwd: ws });
    execSync('git config user.name "test"', { cwd: ws });
    writeFileSync(join(ws, 'init.txt'), 'init\n');
    execSync('git add -A && git commit -q -m "init"', { cwd: ws });
    return ws;
  }

  function writeBuildHistory(ws, record) {
    writeFileSync(
      join(ws, '.compose', 'data', 'build-history.jsonl'),
      JSON.stringify(record) + '\n'
    );
  }

  function writeBuildStream(ws, events) {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(ws, '.compose', 'build-stream.jsonl'), lines);
  }

  test('completed build returns correct cost + outcome.completed=true', () => {
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete',
        input_tokens: 10_000,
        output_tokens: 2_000,
        stepCount: 5,
        durationMs: 30_000,
        cost_usd: 0.08,
      });

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });

      assert.equal(result.cost.tokensIn,  10_000);
      assert.equal(result.cost.tokensOut, 2_000);
      assert.equal(result.cost.calls,     5);
      assert.equal(result.cost.wallMs,    30_000);
      assert.equal(result.cost.usd,       0.08);
      assert.equal(result.outcome.completed, true);
      assert.equal(typeof result.outcome.filesChanged, 'number');
      assert.equal(typeof result.outcome.linesChanged, 'number');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('crashed build returns outcome.completed=false with partial cost data', () => {
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'failed',
        input_tokens: 5_000,
        output_tokens: 800,
        stepCount: 2,
        durationMs: 12_000,
        cost_usd: 0.03,
      });

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });

      assert.equal(result.outcome.completed, false);
      assert.equal(result.cost.tokensIn, 5_000);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('no history record yields completed=false with zero cost', () => {
    const ws = makeWorkspace();
    try {
      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });

      assert.equal(result.outcome.completed, false);
      assert.equal(result.cost.tokensIn,  0);
      assert.equal(result.cost.tokensOut, 0);
      assert.equal(result.cost.calls,     0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('health score extracted from build stream', () => {
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1, durationMs: 1_000, cost_usd: 0,
      });
      writeBuildStream(ws, [
        { type: 'health_score', score: 87, breakdown: {} },
      ]);

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      assert.equal(result.outcome.health, 87);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('review iterations counted from build_step_done (real-build shape)', () => {
    // Before fix #3: ensure_failed was used for gateFailures (doesn't exist in
    // real stream); build_step_done.retries was ignored; 'escalation' type counted.
    // After fix: use real-build event shapes.
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1, durationMs: 1_000, cost_usd: 0,
      });
      writeBuildStream(ws, [
        // Real build emits build_step_done with retries field (not step_retry events)
        { type: 'build_step_done', stepId: 'review',       retries: 0 },
        { type: 'build_step_done', stepId: 'codex_review', retries: 0 },
        { type: 'build_step_done', stepId: 'execute',      retries: 0 },
        // Gate failure: build_gate_resolved with outcome='revise' (not ensure_failed)
        { type: 'build_gate_resolved', stepId: 'review', outcome: 'revise', rationale: 'needs work' },
        { type: 'build_step_done', stepId: 'review',       retries: 1 },  // post-revise retry
        { type: 'build_step_done', stepId: 'codex_review', retries: 0 },
        // Auto-approval: must NOT count as gateFailure
        { type: 'build_gate_resolved', stepId: 'plan_gate', outcome: 'approve', policyMode: 'flag' },
      ]);

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      // 2 review + 2 codex_review completions
      assert.equal(result.process.reviewIters, 4);
      // 1 gate with outcome='revise' (the 'approve' must not count)
      assert.equal(result.process.gateFailures, 1);
      // retries: 0+0+0+1+0 = 1 (only from build_step_done.retries, not step_retry)
      assert.equal(result.process.retries, 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('retries summed from build_step_done.retries — real-build shape (fix #3)', () => {
    // WOULD FAIL BEFORE FIX: old code counted step_retry events (never emitted).
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1, durationMs: 1_000, cost_usd: 0,
      });
      writeBuildStream(ws, [
        { type: 'build_step_done', stepId: 'implement',    retries: 2 },
        { type: 'build_step_done', stepId: 'review',       retries: 3 },
        { type: 'build_step_done', stepId: 'codex_review', retries: 0 },
        // Events the old code wrongly counted — confirm they do NOT add to retries:
        { type: 'step_retry',  stepId: 'execute' },
        { type: 'build_retry', stepId: 'review' },
      ]);

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      // 2+3+0 = 5 retries from build_step_done.retries fields
      assert.equal(result.process.retries, 5,
        'retries must be summed from build_step_done.retries (real-build shape)');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('gateFailures from build_gate_resolved outcome=revise/kill — real-build shape (fix #3)', () => {
    // WOULD FAIL BEFORE FIX: old code counted ensure_failed events (never emitted).
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1, durationMs: 1_000, cost_usd: 0,
      });
      writeBuildStream(ws, [
        { type: 'build_gate_resolved', stepId: 'review',    outcome: 'revise', policyMode: 'gate' },
        { type: 'build_gate_resolved', stepId: 'plan_gate', outcome: 'approve', policyMode: 'flag' },
        { type: 'build_gate_resolved', stepId: 'ship_gate', outcome: 'kill',   policyMode: 'gate' },
        // Old ensure_failed events must NOT count (they don't exist in real stream)
        { type: 'ensure_failed', stepId: 'review' },
      ]);

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      // 1 revise + 1 kill = 2; approve must not count; ensure_failed must not count
      assert.equal(result.process.gateFailures, 2,
        'gateFailures must count build_gate_resolved with outcome revise or kill');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('escalations from build_error message — real-build shape (fix #3)', () => {
    // WOULD FAIL BEFORE FIX: old code counted 'escalation' event type (debug-ledger only).
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1, durationMs: 1_000, cost_usd: 0,
      });
      writeBuildStream(ws, [
        // Real stream event for escalation (lib/build.js ~line 1766):
        { type: 'build_error', message: 'Debug discipline: escalating after 3 attempts. Dispatching to cross-agent review.' },
        // Old event type that does NOT exist in the real stream:
        { type: 'escalation', attempt: 3 },
        { type: 'bug_escalation', attempt: 2 },
      ]);

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      // Only the build_error with "escalating" counts; type='escalation' events must not
      assert.equal(result.process.escalations, 1,
        'escalations must come from build_error events with "escalating" in message');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('testsTotal and testsPass read from build-history test_count/pass_rate fields (fix #4, fix B)', () => {
    // WOULD FAIL BEFORE FIX B: old code tried to re-parse from stdout; ship step's
    // execSync output never reaches realHeadlessBuild's stdout buffer, so testsPass
    // and testsTotal stayed null for all real builds.
    // After fix B: build.js ship step persists test_count/pass_rate to build-history;
    // collect() reads those directly from historyRecord.
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1,
        durationMs: 1_000, cost_usd: 0,
        test_count: 5, pass_rate: 100,  // written by build.js ship step
      });

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      assert.equal(result.outcome.testsTotal, 5,
        'testsTotal must come from historyRecord.test_count');
      assert.equal(result.outcome.testsPass, 5,
        'testsPass must reflect all-passing tests (pass_rate=100 → testsPass=testsTotal)');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('testsPass reflects partial failures when historyRecord.pass_rate < 100 (fix #4, fix B)', () => {
    // WOULD FAIL BEFORE FIX B: testsTotal and testsPass were null when no parseable stdout.
    const ws = makeWorkspace();
    try {
      writeBuildHistory(ws, {
        status: 'complete', input_tokens: 1, output_tokens: 1, stepCount: 1,
        durationMs: 1_000, cost_usd: 0,
        test_count: 10, pass_rate: 80,  // 8 of 10 passing
      });

      const sandbox = { workspace: ws, runDir: ws };
      const result = collect({ sandbox });
      assert.equal(result.outcome.testsTotal, 10,
        'testsTotal = historyRecord.test_count');
      assert.equal(result.outcome.testsPass, 8,
        'testsPass = Math.round(pass_rate/100 * test_count) when pass_rate < 100');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S3 — experiment-pricing
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S3: experiment-pricing', () => {
  test('exact match returns pricing', () => {
    const p = lookupExperimentPricing('claude-sonnet-4-6');
    assert.ok(p, 'pricing must be found for claude-sonnet-4-6');
    assert.equal(p.inputPerMTok,  3);
    assert.equal(p.outputPerMTok, 15);
  });

  test('prefix match returns pricing for dated variant', () => {
    const p = lookupExperimentPricing('claude-sonnet-4-6-20250514');
    assert.ok(p, 'prefix match must resolve dated variants');
    assert.equal(p.inputPerMTok, 3);
  });

  test('unknown model returns null (degrade, not crash)', () => {
    const p = lookupExperimentPricing('gemini-ultra');
    assert.equal(p, null);
  });

  test('deriveUsd returns null for unknown model', () => {
    const usd = deriveUsd('unknown-model', 10_000, 2_000);
    assert.equal(usd, null);
  });

  test('deriveUsd computes correctly for known model', () => {
    // claude-sonnet-4-6: $3/MTok input, $15/MTok output
    // 1M in + 1M out = $3 + $15 = $18
    const usd = deriveUsd('claude-sonnet-4-6', 1_000_000, 1_000_000);
    assert.equal(typeof usd, 'number');
    assert.equal(usd, 18);
  });
});

// ---------------------------------------------------------------------------
// S4 — experiment-judge failure → null
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S4: experiment-judge', () => {
  test('judge degrades to null when stratum throws', async () => {
    const throwingStratum = {
      async runAgentText() { throw new Error('simulated stratum failure'); },
      async agentRun()     { throw new Error('simulated stratum failure'); },
    };

    const result = await judge({
      diff:       'diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js',
      goal:       'Write a hello-world function',
      judgeModel: 'claude::critical',
      stratum:    throwingStratum,
    });
    assert.equal(result, null, 'judge must degrade to null on stratum failure');
  });

  test('judge degrades to null when agent returns unparseable text', async () => {
    const garbledStratum = {
      async runAgentText() { return 'I have reviewed the code. Looks fine.'; },
      async agentRun()     { return { text: 'I have reviewed the code. Looks fine.' }; },
    };

    const result = await judge({
      diff:       'diff --git a/foo.js b/foo.js',
      goal:       'Write a hello-world function',
      judgeModel: 'claude',
      stratum:    garbledStratum,
    });
    assert.equal(result, null, 'judge must degrade to null when no JSON block found');
  });

  test('judge returns structured scores when agent returns valid JSON block', async () => {
    const validPayload = JSON.stringify({
      correctness:  8,
      clarity:      7,
      idiomaticity: 9,
      rationale:    'Clean implementation with good coverage.',
    });
    const goodStratum = {
      async runAgentText() { return '```json\n' + validPayload + '\n```'; },
      async agentRun()     { return { text: '```json\n' + validPayload + '\n```' }; },
    };

    const result = await judge({
      diff:       'diff --git a/foo.js b/foo.js',
      goal:       'Write a hello-world function',
      judgeModel: 'claude',
      stratum:    goodStratum,
    });
    assert.ok(result !== null, 'judge must return scores on valid response');
    assert.equal(result.correctness,  8);
    assert.equal(result.clarity,      7);
    assert.equal(result.idiomaticity, 9);
    assert.equal(result.rationale,    'Clean implementation with good coverage.');
  });
});
