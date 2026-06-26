/**
 * experiment-orchestrator.test.js — End-to-end orchestrator tests for COMP-MODEL-AB (S5–S7).
 *
 * ALL tests use a FAKE build runner (opts._runBuild) so NO real compose build,
 * NO LLM calls, and NO writes to the real .compose/data directory.
 *
 * The fake runner writes canned build-history.jsonl + build-stream.jsonl into
 * `cwd/.compose/` (the sandbox workspace) so the orchestrator's full path
 * (provision → scaffold → build → collect → judge → write record) is exercised.
 *
 * S7 golden flow is written at the bottom, gated behind COMP_MODEL_AB_GOLDEN=1
 * and is NOT executed during normal test runs.
 *
 * Run: node --test --test-timeout=120000 test/experiment-orchestrator.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const COMPOSE_ROOT = resolve(__dirname, '..');

const { runExperiment } = await import('../lib/experiment.js');
const { VisionWriter }  = await import('../lib/vision-writer.js');

// ---------------------------------------------------------------------------
// Fake build runner helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake build runner that writes canned build artifacts.
 *
 * The artifact shapes match what the REAL compose build emits so the orchestrator
 * code paths (collect, parseProcessFromStream) are exercised against the true
 * signal shapes (fix #1–#4):
 *   - build_step_done carries a `retries` field (not step_retry events)
 *   - gate failures use build_gate_resolved with outcome='revise' (not ensure_failed)
 *   - The fake runner writes a real source file AND commits it (like the ship step)
 *     so the baseline-diff path captures a non-empty diff and non-zero stat.
 *
 * @param {object} opts
 * @param {string[]}  [opts.failLabels=[]]  Config labels whose runs return exitCode=1
 * @param {number}    [opts.cost_usd=0.05]
 * @param {number}    [opts.health=80]
 * @param {Function}  [opts.onCall]         Called with (config, cwd) on each invocation
 */
function makeFakeBuildRunner({ failLabels = [], cost_usd = 0.05, health = 80, onCall } = {}) {
  const calls = [];

  async function fakeBuildRunner(config, sandboxEnv, { cwd }) {
    calls.push({ configLabel: config.label, cwd });
    if (onCall) onCall(config, cwd);

    const shouldFail = failLabels.includes(config.label);

    // Write fake artifacts so collect() has something to read
    const dataDir   = join(cwd, '.compose', 'data');
    const streamDir = join(cwd, '.compose');
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, 'build-history.jsonl'),
      JSON.stringify({
        status:        shouldFail ? 'failed' : 'complete',
        input_tokens:  shouldFail ? 2_000   : 8_000,
        output_tokens: shouldFail ? 400     : 1_600,
        stepCount:     shouldFail ? 2       : 6,
        durationMs:    shouldFail ? 5_000   : 20_000,
        cost_usd:      shouldFail ? null    : cost_usd,
        // COMP-MODEL-AB fix B: ship step persists test_count/pass_rate to build-history.
        // Fake runner includes these for successful runs so the testsTotal/testsPass
        // path (which now reads from historyRecord, not stdout) is exercised.
        ...(shouldFail ? {} : { test_count: 10, pass_rate: 100 }),
      }) + '\n'
    );

    // Real-build stream shape (fixes #3):
    //   - build_step_done carries retries field (not step_retry events)
    //   - gate failures use build_gate_resolved outcome='revise' (not ensure_failed)
    //   - health_score event format unchanged
    const streamEvents = [
      ...(shouldFail ? [] : [{ type: 'health_score', score: health }]),
      { type: 'build_step_done', stepId: 'implement',    retries: 0 },
      { type: 'build_step_done', stepId: 'review',       retries: 0 },
      { type: 'build_step_done', stepId: 'codex_review', retries: 0 },
    ];
    writeFileSync(
      join(streamDir, 'build-stream.jsonl'),
      streamEvents.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    // Simulate the ship step: write a source file and commit it (fix #1/#2).
    // The real build commits during ship, leaving `git diff HEAD` empty.
    // Without this commit, the baseline-diff code path wouldn't be exercised.
    if (!shouldFail) {
      try {
        writeFileSync(join(cwd, 'add.js'), '// add(a, b)\nexport function add(a, b) { return a + b; }\n');
        execSync('git add -A && git commit -q -m "feat(EXP-FIXTURE): implement add"', { cwd });
      } catch { /* best-effort — git may not be available */ }
    }

    return {
      stdout:   shouldFail ? '' : 'Build complete.\n',
      stderr:   shouldFail ? 'simulated build failure' : '',
      exitCode: shouldFail ? 1 : 0,
      timedOut: false,
    };
  }

  fakeBuildRunner.calls = calls;
  return fakeBuildRunner;
}

// ---------------------------------------------------------------------------
// Spec fixture helpers
// ---------------------------------------------------------------------------

function makeSpec(overrides = {}) {
  return {
    id: 'test-orch',
    fixture: { goal: 'Write add(a,b) returning a+b', seedRepo: null, seedRef: null },
    configs: [
      { label: 'config-a', implementer: 'claude::standard', reviewer: 'codex' },
      { label: 'config-b', implementer: 'codex', reviewer: 'claude' },
    ],
    reps: 1,
    parallelism: 2,
    buildTimeoutMs: 30_000,
    judge: { enabled: false },
    ...overrides,
  };
}

/** Write a spec JSON file to a temp dir; returns the spec path. */
function writeSpecFile(spec, dir) {
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  return specPath;
}

// ---------------------------------------------------------------------------
// S5 — orchestrator integration tests (fake build runner)
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S5: orchestrator integration — fake build runner', () => {
  test('runs correct number of runs (configs × reps) and writes run records', async () => {
    const dir     = mkdtempSync(join(tmpdir(), 'comp-ab-orch-'));
    try {
      const spec    = makeSpec({ reps: 2 });  // 2 configs × 2 reps = 4 runs
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { runs, expRoot } = await runExperiment(specPath, { _runBuild: runner });

      assert.equal(runs.length, 4, 'must produce 4 run records');
      assert.equal(runner.calls.length, 4, 'fake runner must be called 4 times');

      // Each run must have its own runs/<runId>.json
      for (const run of runs) {
        const recordPath = join(expRoot, 'runs', run.runId, `${run.runId}.json`);
        assert.ok(existsSync(recordPath), `run record must exist: ${recordPath}`);
        const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
        assert.equal(record.runId, run.runId);
        assert.ok(['config-a', 'config-b'].includes(record.configLabel));
        assert.ok(record.metrics?.cost != null, 'metrics.cost must be present');
        assert.ok(record.metrics?.outcome != null, 'metrics.outcome must be present');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one failed run records completed=false and does NOT abort the experiment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-resilience-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      // config-b fails, config-a succeeds
      const runner = makeFakeBuildRunner({ failLabels: ['config-b'] });

      const { runs } = await runExperiment(specPath, { _runBuild: runner });

      assert.equal(runs.length, 2, 'both run records must exist despite one failure');

      const runA = runs.find(r => r.configLabel === 'config-a');
      const runB = runs.find(r => r.configLabel === 'config-b');
      assert.ok(runA, 'config-a run must exist');
      assert.ok(runB, 'config-b run must exist');

      assert.equal(runA.metrics.outcome.completed, true,  'config-a must be completed');
      assert.equal(runB.metrics.outcome.completed, false, 'config-b must be completed=false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('results.json is written with correct nCompleted per config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-results-'));
    try {
      const spec     = makeSpec({ reps: 2 });  // 2 configs × 2 reps = 4 runs
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner({ failLabels: ['config-b'] });

      const { resultsPath } = await runExperiment(specPath, { _runBuild: runner });

      assert.ok(existsSync(resultsPath), 'results.json must be written');
      const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));

      assert.equal(results.experimentId, 'test-orch');
      assert.equal(results.configs.length, 2);

      const cfgA = results.configs.find(c => c.label === 'config-a');
      const cfgB = results.configs.find(c => c.label === 'config-b');

      assert.equal(cfgA.nCompleted, 2, 'config-a: 2 reps all completed');
      assert.equal(cfgA.nTotal,     2);
      assert.equal(cfgB.nCompleted, 0, 'config-b: 0 completed (both failed)');
      assert.equal(cfgB.nTotal,     2);

      // Metric aggregations for config-a (has completed runs)
      assert.ok(cfgA.metrics['cost.usd'] != null, 'config-a cost.usd must be aggregated');
      // No metric aggregations for config-b (no completed runs)
      assert.equal(cfgB.metrics['cost.usd'], undefined, 'config-b cost.usd must be absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('report.md is written with comparison table and caveats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-report-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { reportPath } = await runExperiment(specPath, { _runBuild: runner });

      assert.ok(existsSync(reportPath), 'report.md must be written');
      const md = readFileSync(reportPath, 'utf-8');
      assert.match(md, /# Experiment Report/);
      assert.match(md, /## Results/);
      assert.match(md, /## Caveats/);
      assert.match(md, /config-a/);
      assert.match(md, /config-b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parallelism=1 serializes runs (runner called sequentially)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-serial-'));
    try {
      const spec     = makeSpec({ reps: 2, parallelism: 1 });
      const specPath = writeSpecFile(spec, dir);

      const callOrder = [];
      const runner = makeFakeBuildRunner({
        onCall: (config) => callOrder.push(config.label),
      });

      await runExperiment(specPath, { _runBuild: runner });

      // With parallelism=1, 4 calls must complete in order (no interleaving)
      assert.equal(callOrder.length, 4, '4 runs must be called');
      // Each call completes before the next starts (semaphore=1 ensures this)
      // We can verify by checking no overlap: callOrder must be complete before next starts.
      // Since JS is single-threaded and our fake is sync-ish, order is deterministic:
      // config-a-rep1, config-a-rep2, config-b-rep1, config-b-rep2
      assert.deepEqual(callOrder, ['config-a', 'config-a', 'config-b', 'config-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('run record has required fields from the contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-contract-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner({ health: 90 });

      const { runs } = await runExperiment(specPath, { _runBuild: runner });
      const run = runs[0];

      // Contract: runId, configLabel, rep, metrics.{cost,outcome,process}, judge, artifacts, manifest
      assert.equal(typeof run.runId,       'string');
      assert.equal(typeof run.configLabel, 'string');
      assert.equal(typeof run.rep,         'number');

      // metrics axes
      const { cost, outcome, process: proc } = run.metrics;
      assert.equal(typeof cost.tokensIn,   'number');
      assert.equal(typeof cost.tokensOut,  'number');
      assert.equal(typeof outcome.completed, 'boolean');
      assert.equal(typeof proc.reviewIters,  'number');

      // judge=null (judge.enabled=false in spec)
      assert.equal(run.judge, null);

      // artifacts
      assert.ok(run.artifacts.logPath  != null, 'logPath must be set');
      assert.ok(run.artifacts.diffPath != null, 'diffPath must be set');

      // manifest
      assert.equal(run.manifest.fixtureGoal, spec.fixture.goal);
      assert.ok(typeof run.manifest.startedAt === 'string');
      assert.ok(typeof run.manifest.endedAt   === 'string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('health score from build stream reaches outcome.health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-health-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner({ health: 92 });

      const { runs } = await runExperiment(specPath, { _runBuild: runner });
      const completed = runs.filter(r => r.metrics.outcome.completed);
      // At least one run has health=92 from the fake stream
      const healthVals = completed.map(r => r.metrics.outcome.health).filter(v => v != null);
      assert.ok(healthVals.length > 0, 'at least one run must have a health score');
      assert.ok(healthVals.every(h => h === 92), 'health must come from fake stream (92)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid spec file throws with descriptive error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-invalid-'));
    try {
      const specPath = join(dir, 'spec.json');
      writeFileSync(specPath, JSON.stringify({ id: 'x', fixture: { goal: 'g' } }) + '\n');
      // Missing configs field → validateSpec throws
      await assert.rejects(
        () => runExperiment(specPath, { _runBuild: makeFakeBuildRunner() }),
        /spec\.configs/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff.patch is non-empty when fake runner commits files (fix #1)', async () => {
    // WOULD FAIL BEFORE FIX: old code used `git diff HEAD` AFTER the build; the real
    // build (and the updated fake) commits during ship, leaving HEAD clean → empty diff.
    // After fix: diff is captured against a pre-build baseline commit → non-empty.
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-diff-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { runs, expRoot } = await runExperiment(specPath, { _runBuild: runner });
      const run = runs.find(r => r.metrics.outcome.completed);
      assert.ok(run, 'must have at least one completed run');

      const diffPath = run.artifacts.diffPath;
      assert.ok(existsSync(diffPath), 'diff.patch must exist');
      const patch = readFileSync(diffPath, 'utf-8');
      assert.ok(patch.length > 0,
        'diff.patch must be non-empty when the build commits files (baseline-diff fix #1)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('filesChanged and linesChanged are non-zero when fake runner commits files (fix #2)', async () => {
    // WOULD FAIL BEFORE FIX: gitDiffStat used `git diff --stat HEAD`; after commit
    // the working tree is clean → 0/0. Now uses baselineSha → counts committed changes.
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-stat-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { runs } = await runExperiment(specPath, { _runBuild: runner });
      const run = runs.find(r => r.metrics.outcome.completed);
      assert.ok(run, 'must have at least one completed run');

      assert.ok(run.metrics.outcome.filesChanged > 0,
        'filesChanged must be > 0 when the fake runner commits new files (fix #2)');
      assert.ok(run.metrics.outcome.linesChanged > 0,
        'linesChanged must be > 0 when the fake runner commits new files (fix #2)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('process.retries = 0 for default fake runner (all steps have retries:0) (fix #3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-retries-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { runs } = await runExperiment(specPath, { _runBuild: runner });
      for (const run of runs.filter(r => r.metrics.outcome.completed)) {
        assert.equal(run.metrics.process.retries, 0,
          'process.retries must be 0 when all build_step_done.retries=0');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.compose writes by the build do NOT inflate filesChanged or appear in diff.patch (fix A)', async () => {
    // WOULD FAIL BEFORE FIX A: scaffoldSandboxProject did not write .gitignore, so
    // git add -A in gitDiffStat would stage .compose/ files → filesChanged > 0.
    // After fix A: .gitignore with .compose/ is committed before the baseline, so
    // .compose/ files are always gitignored — only real product changes are counted.
    //
    // The default fake runner writes .compose/data/build-history.jsonl and
    // .compose/build-stream.jsonl but does NOT commit any .compose/ changes.
    // With .gitignore in place, filesChanged must count only product files (add.js=1).
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-gitignore-'));
    try {
      // Use only ONE config, one rep, so there's exactly one completed run to inspect
      const spec = makeSpec({
        reps: 1,
        configs: [{ label: 'config-a', implementer: 'claude::standard', reviewer: 'codex' }],
        parallelism: 1,
      });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { runs } = await runExperiment(specPath, { _runBuild: runner });
      const run = runs.find(r => r.metrics.outcome.completed);
      assert.ok(run, 'must have a completed run');

      // filesChanged must not include .compose/ entries — only add.js committed by the fake runner
      assert.ok(run.metrics.outcome.filesChanged <= 1,
        '.compose/ writes must not inflate filesChanged — only product files count (fix A)');

      // diff.patch must not reference .compose/ paths
      const patch = existsSync(run.artifacts.diffPath)
        ? readFileSync(run.artifacts.diffPath, 'utf-8') : '';
      assert.ok(!patch.includes('.compose/'),
        'diff.patch must not contain .compose/ paths (fix A)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('testsTotal and testsPass from fake runner history record (fix B)', async () => {
    // WOULD FAIL BEFORE FIX B: collect() tried to re-parse stdout for test counts,
    // but realHeadlessBuild stdout never contains ship-step execSync output →
    // testsTotal/testsPass stayed null for all real builds.
    // After fix B: collect() reads test_count/pass_rate from historyRecord;
    // build.js persists them from the ship step.
    //
    // The default fake runner now writes test_count:10, pass_rate:100 to history.
    const dir = mkdtempSync(join(tmpdir(), 'comp-ab-tests-'));
    try {
      const spec     = makeSpec({ reps: 1 });
      const specPath = writeSpecFile(spec, dir);
      const runner   = makeFakeBuildRunner();

      const { runs } = await runExperiment(specPath, { _runBuild: runner });
      const run = runs.find(r => r.metrics.outcome.completed);
      assert.ok(run, 'must have a completed run');

      assert.equal(run.metrics.outcome.testsTotal, 10,
        'testsTotal must come from historyRecord.test_count (fix B)');
      assert.equal(run.metrics.outcome.testsPass, 10,
        'testsPass must be testsTotal when pass_rate=100 (fix B)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S7 — fast isolation test (no real build required; always runs)
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S7: sandbox isolation acceptance gate (fast, no real build)', () => {
  test('VisionWriter with COMPOSE_PORT=19997 does NOT modify live vision-state.json', async () => {
    // Proves isolation primitive: port=19997 → ECONNREFUSED → _serverAvailable()=false
    // → _directXxx() writes to sandbox dataDir → live :4001 never contacted.

    const liveVisionStatePath = join(COMPOSE_ROOT, '.compose', 'data', 'vision-state.json');
    const snapshotBefore = existsSync(liveVisionStatePath)
      ? readFileSync(liveVisionStatePath, 'utf-8') : null;

    const sandboxDataDir = mkdtempSync(join(tmpdir(), 'comp-ab-isolation-'));
    try {
      // Construct VisionWriter with dead port (same port sandbox puts in COMPOSE_PORT)
      const sandboxWriter = new VisionWriter(sandboxDataDir, { port: 19997 });
      await sandboxWriter.ensureFeatureItem('ISO-TEST', 'ISO-TEST', 'feature');

      // Assert 1: live vision-state byte-identical
      const snapshotAfter = existsSync(liveVisionStatePath)
        ? readFileSync(liveVisionStatePath, 'utf-8') : null;
      assert.equal(snapshotAfter, snapshotBefore,
        'ISOLATION BREACH: live vision-state.json was modified by a sandboxed VisionWriter');

      // Assert 2: sandbox has its own vision-state (direct write path executed)
      assert.ok(
        existsSync(join(sandboxDataDir, 'vision-state.json')),
        'Sandbox must have its own vision-state.json (direct write path)'
      );
    } finally {
      rmSync(sandboxDataDir, { recursive: true, force: true });
    }
  });

  test('sandbox env sets COMPOSE_PORT=19997 (confirmed from provision())', async () => {
    const { provision } = await import('../lib/experiment-sandbox.js');
    const expRoot = mkdtempSync(join(tmpdir(), 'comp-ab-isolation2-'));
    try {
      const fixture = { goal: 'test isolation', seedRepo: null, seedRef: null };
      const sandbox = await provision({ fixture, runId: 'iso-run', expRoot });
      try {
        assert.equal(sandbox.env.COMPOSE_PORT, '19997',
          'sandbox COMPOSE_PORT must be 19997 (dead port)');
        assert.notEqual(Number(sandbox.env.COMPOSE_PORT), 4001,
          'sandbox COMPOSE_PORT must not be the live server port');
      } finally {
        sandbox.cleanup({ pruneWorkspace: true });
      }
    } finally {
      rmSync(expRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S7 — golden flow (opt-in: COMP_MODEL_AB_GOLDEN=1, real LLM builds, slow)
// ---------------------------------------------------------------------------

if (process.env.COMP_MODEL_AB_GOLDEN === '1') {
  describe('COMP-MODEL-AB S7: golden flow (COMP_MODEL_AB_GOLDEN=1 — real builds, slow)', () => {
    test('full experiment: 2 configs × 1 rep → results.json + report.md + live vision-state unchanged', async () => {
      // This is the acceptance gate from design.md §"Sandbox isolation":
      // "a sandbox build with the live :4001 UP must leave live vision-state byte-identical."
      // Expected runtime: minutes per config (real LLM build).
      const SPEC_PATH = join(
        COMPOSE_ROOT, 'docs', 'features', 'COMP-MODEL-AB', 'example-experiment.json'
      );
      assert.ok(existsSync(SPEC_PATH), `example spec not found: ${SPEC_PATH}`);

      const liveVisionStatePath = join(COMPOSE_ROOT, '.compose', 'data', 'vision-state.json');
      const snapshotBefore = existsSync(liveVisionStatePath)
        ? readFileSync(liveVisionStatePath, 'utf-8') : null;

      // No _runBuild injection — uses realHeadlessBuild (real compose builds)
      const result = await runExperiment(SPEC_PATH, { pruneWorkspaces: true });

      assert.ok(existsSync(result.resultsPath), 'results.json must be written');
      assert.ok(existsSync(result.reportPath),  'report.md must be written');

      const results = JSON.parse(readFileSync(result.resultsPath, 'utf-8'));
      assert.equal(results.configs.length, 2, 'results must have 2 configs');
      for (const cfg of results.configs) {
        assert.equal(cfg.nTotal, 1, 'each config must have 1 total run');
      }

      const reportMd = readFileSync(result.reportPath, 'utf-8');
      assert.match(reportMd, /## Results/);
      assert.match(reportMd, /## Caveats/);

      // ISOLATION GATE: live vision-state must be byte-identical after real builds
      const snapshotAfter = existsSync(liveVisionStatePath)
        ? readFileSync(liveVisionStatePath, 'utf-8') : null;
      assert.equal(snapshotAfter, snapshotBefore,
        'ISOLATION BREACH: live vision-state.json was modified by sandboxed builds');
    });
  });
}
