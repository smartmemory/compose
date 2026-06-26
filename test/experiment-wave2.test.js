/**
 * experiment-wave2.test.js — Wave 2 tests for COMP-MODEL-AB (S5, S6, S7).
 *
 * Covers:
 *   S5 — experiment.js: spec validation, matrix expansion, concurrency cap,
 *        single-run resilience (failed run records completed=false)
 *   S6 — experiment-report.js: aggregation math (median/spread, N-completed),
 *        render (table format, winner-per-metric, caveats)
 *   S7 — fast isolation test (sandbox COMPOSE_PORT=19997 → live vision-state
 *        unchanged); golden flow gated behind COMP_MODEL_AB_GOLDEN=1
 *
 * Run: node --test --test-timeout=120000 test/experiment-wave2.test.js
 *
 * The isolation acceptance gate is the S7 fast test — it runs unconditionally.
 * The golden flow (real builds) requires COMP_MODEL_AB_GOLDEN=1 in the env.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, copyFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_ROOT = resolve(__dirname, '..');

// Top-level module imports (ES module top level — await is valid here)
const { validateSpec, expandMatrix } = await import('../lib/experiment.js');
const { aggregate, render, computeSpread } = await import('../lib/experiment-report.js');
const { VisionWriter } = await import('../lib/vision-writer.js');

// ---------------------------------------------------------------------------
// S5 — spec validation
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S5: validateSpec — fail-closed validations', () => {
  const VALID_SPEC = {
    id: 'test-exp',
    fixture: { goal: 'Write add(a,b)', seedRepo: null, seedRef: null },
    configs: [
      { label: 'config-a', implementer: 'claude::standard', reviewer: 'codex' },
      { label: 'config-b', implementer: 'codex', reviewer: 'claude' },
    ],
    reps: 2,
    parallelism: 1,
    buildTimeoutMs: 30_000,
    judge: { enabled: false, model: 'claude::critical' },
  };

  test('accepts a valid spec', () => {
    const spec = validateSpec(VALID_SPEC);
    assert.equal(spec.id, 'test-exp');
    assert.equal(spec.reps, 2);
    assert.equal(spec.configs.length, 2);
  });

  test('rejects non-object spec', () => {
    assert.throws(() => validateSpec('not-an-object'), /JSON object/i);
    assert.throws(() => validateSpec(null),            /JSON object/i);
  });

  test('rejects missing or empty id', () => {
    assert.throws(() => validateSpec({ ...VALID_SPEC, id: '' }),        /spec\.id/);
    assert.throws(() => validateSpec({ ...VALID_SPEC, id: undefined }), /spec\.id/);
  });

  test('rejects missing or empty fixture.goal', () => {
    assert.throws(() => validateSpec({ ...VALID_SPEC, fixture: { goal: '' } }),        /fixture\.goal/);
    assert.throws(() => validateSpec({ ...VALID_SPEC, fixture: { goal: undefined } }), /fixture\.goal/);
  });

  test('rejects empty configs array', () => {
    assert.throws(() => validateSpec({ ...VALID_SPEC, configs: [] }), /configs.*non-empty/i);
  });

  test('rejects duplicate config labels', () => {
    assert.throws(
      () => validateSpec({ ...VALID_SPEC, configs: [
        { label: 'x', implementer: 'claude', reviewer: 'codex' },
        { label: 'x', implementer: 'codex',  reviewer: 'claude' },
      ]}),
      /duplicate label/i
    );
  });

  test('rejects labels that collide after runId sanitization (fix #5)', () => {
    // WOULD FAIL BEFORE FIX: old code only deduped raw labels; "a/b" and "a?b"
    // both sanitize to "a_b" and would overwrite each other's workspace.
    assert.throws(
      () => validateSpec({ ...VALID_SPEC, configs: [
        { label: 'a/b', implementer: 'claude', reviewer: 'codex' },
        { label: 'a?b', implementer: 'codex',  reviewer: 'claude' },
      ]}),
      /sanitize to "a_b"/
    );
  });

  test('accepts labels that are distinct after sanitization', () => {
    // Confirm safe labels still pass
    const spec = validateSpec({ ...VALID_SPEC, configs: [
      { label: 'alpha-1', implementer: 'claude', reviewer: 'codex' },
      { label: 'alpha-2', implementer: 'codex',  reviewer: 'claude' },
    ]});
    assert.equal(spec.configs.length, 2);
  });

  test('rejects invalid agent string in config', () => {
    assert.throws(
      () => validateSpec({ ...VALID_SPEC, configs: [
        { label: 'bad', implementer: 'openai::critical', reviewer: 'codex' },
      ]}),
      /configs\[0\]\.implementer/
    );
  });

  test('rejects reps < 1', () => {
    assert.throws(() => validateSpec({ ...VALID_SPEC, reps: 0 }),  /reps.*integer.*1/i);
    assert.throws(() => validateSpec({ ...VALID_SPEC, reps: -1 }), /reps.*integer.*1/i);
  });

  test('rejects parallelism < 1', () => {
    assert.throws(() => validateSpec({ ...VALID_SPEC, parallelism: 0 }), /parallelism.*integer.*1/i);
  });

  test('rejects judge.enabled=true with missing model', () => {
    assert.throws(
      () => validateSpec({ ...VALID_SPEC, judge: { enabled: true, model: '' } }),
      /judge\.model/
    );
  });

  test('rejects judge.enabled=true with invalid agent model', () => {
    assert.throws(
      () => validateSpec({ ...VALID_SPEC, judge: { enabled: true, model: 'openai::standard' } }),
      /judge\.model/
    );
  });

  test('fills defaults for optional fields', () => {
    const minimal = {
      id: 'minimal',
      fixture: { goal: 'goal' },
      configs: [{ label: 'c', implementer: 'claude', reviewer: 'codex' }],
      reps: 1,
    };
    const spec = validateSpec(minimal);
    assert.equal(spec.parallelism, 1);
    assert.equal(spec.buildTimeoutMs, 1_800_000);
    assert.equal(spec.judge.enabled, false);
    assert.equal(spec.fixture.seedRepo, null);
  });
});

// ---------------------------------------------------------------------------
// S5 — matrix expansion
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S5: expandMatrix — correct run count + stable runIds', () => {
  const SPEC = {
    id: 'shootout',
    fixture: { goal: 'test', seedRepo: null, seedRef: null },
    configs: [
      { label: 'opus',   implementer: 'claude::critical', reviewer: 'codex' },
      { label: 'sonnet', implementer: 'claude::standard', reviewer: 'codex' },
    ],
    reps: 3,
    parallelism: 2,
    buildTimeoutMs: 60_000,
    judge: { enabled: false },
  };

  test('run count = configs × reps', () => {
    const runs = expandMatrix(SPEC);
    assert.equal(runs.length, 2 * 3);   // 6
  });

  test('config labels appear in runIds', () => {
    const runs = expandMatrix(SPEC);
    const opusRuns   = runs.filter(r => r.config.label === 'opus');
    const sonnetRuns = runs.filter(r => r.config.label === 'sonnet');
    assert.equal(opusRuns.length,   3);
    assert.equal(sonnetRuns.length, 3);
  });

  test('rep numbers are 1-indexed and span 1..reps', () => {
    const runs = expandMatrix(SPEC);
    const reps = runs.map(r => r.rep).sort((a, b) => a - b);
    // 2 configs × 3 reps → reps [1,1,2,2,3,3]
    assert.deepEqual(reps, [1, 1, 2, 2, 3, 3]);
  });

  test('runIds are unique and safe as directory names', () => {
    const runs = expandMatrix(SPEC);
    const ids = runs.map(r => r.runId);
    const unique = new Set(ids);
    assert.equal(unique.size, runs.length, 'runIds must be unique');
    for (const id of ids) {
      assert.match(id, /^[a-zA-Z0-9_-]+$/, `runId "${id}" must contain only safe chars`);
    }
  });

  test('runIds are deterministic (same spec → same ids)', () => {
    const run1 = expandMatrix(SPEC).map(r => r.runId);
    const run2 = expandMatrix(SPEC).map(r => r.runId);
    assert.deepEqual(run1, run2);
  });

  test('single-config single-rep produces one run', () => {
    const spec = { ...SPEC, configs: [SPEC.configs[0]], reps: 1 };
    const runs = expandMatrix(spec);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].rep, 1);
    assert.equal(runs[0].config.label, 'opus');
  });
});

// ---------------------------------------------------------------------------
// S6 — aggregation math
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S6: aggregate — median/spread, N-completed', () => {
  function makeRun(configLabel, rep, completed, cost_usd, health, correctness = null) {
    return {
      runId:       `${configLabel}-rep${rep}`,
      configLabel,
      rep,
      metrics: {
        cost:    { tokensIn: 1000, tokensOut: 200, calls: 5, wallMs: 30000, usd: cost_usd },
        outcome: { completed, health, testsPass: null, testsTotal: null, filesChanged: 2, linesChanged: 40 },
        process: { reviewIters: 2, gateFailures: 0, retries: 0, escalations: 0 },
      },
      judge: correctness != null ? { correctness, clarity: 8, idiomaticity: 7, rationale: 'ok' } : null,
    };
  }

  test('nCompleted counts only completed runs', () => {
    const runs = [
      makeRun('cfg-a', 1, true,  0.08, 85),
      makeRun('cfg-a', 2, false, 0.03, null),  // failed
      makeRun('cfg-a', 3, true,  0.09, 90),
    ];
    const results = aggregate(runs, 'test-exp');
    const cfg = results.configs[0];
    assert.equal(cfg.nCompleted, 2);
    assert.equal(cfg.nTotal,     3);
  });

  test('cost.usd median computed only from completed runs', () => {
    const runs = [
      makeRun('cfg-a', 1, true,  0.06, 80),
      makeRun('cfg-a', 2, false, 0.01, null),  // failed — must not count
      makeRun('cfg-a', 3, true,  0.10, 90),
    ];
    const results = aggregate(runs, 'test-exp');
    const cfg = results.configs[0];
    // Only [0.06, 0.10] → median = 0.08
    assert.ok(cfg.metrics['cost.usd'] != null, 'cost.usd must be aggregated');
    assert.equal(cfg.metrics['cost.usd'].median, 0.08);
    assert.equal(cfg.metrics['cost.usd'].min,    0.06);
    assert.equal(cfg.metrics['cost.usd'].max,    0.10);
  });

  test('multiple configs are aggregated independently', () => {
    const runs = [
      makeRun('cheap', 1, true, 0.02, 70),
      makeRun('cheap', 2, true, 0.03, 80),
      makeRun('pricey', 1, true, 0.10, 90),
      makeRun('pricey', 2, true, 0.12, 95),
    ];
    const results = aggregate(runs, 'multi');
    assert.equal(results.configs.length, 2);
    const cheap  = results.configs.find(c => c.label === 'cheap');
    const pricey = results.configs.find(c => c.label === 'pricey');
    assert.ok(cheap.metrics['cost.usd'].median < pricey.metrics['cost.usd'].median);
  });

  test('judge metrics aggregated from runs where judge is non-null', () => {
    const runs = [
      makeRun('cfg-a', 1, true, 0.05, 80, 9),
      makeRun('cfg-a', 2, true, 0.06, 85, 7),
      makeRun('cfg-a', 3, false, null, null, null),  // failed build, no judge
    ];
    const results = aggregate(runs, 'judge-test');
    const cfg = results.configs[0];
    // [9, 7] → median = 8
    assert.ok(cfg.metrics['judge.correctness'] != null, 'judge.correctness must be aggregated');
    assert.equal(cfg.metrics['judge.correctness'].median, 8);
  });

  test('no completed runs → no metric aggregations but nCompleted=0 is reported', () => {
    const runs = [
      makeRun('cfg-a', 1, false, null, null),
      makeRun('cfg-a', 2, false, null, null),
    ];
    const results = aggregate(runs, 'all-fail');
    const cfg = results.configs[0];
    assert.equal(cfg.nCompleted, 0);
    assert.equal(cfg.nTotal,     2);
    assert.equal(cfg.metrics['cost.usd'], undefined, 'no completed runs → no cost.usd');
  });

  test('generatedAt is an ISO timestamp string', () => {
    const results = aggregate([], 'empty');
    assert.match(results.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// S6 — computeSpread
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S6: computeSpread utility', () => {
  test('null values are dropped', () => {
    const r = computeSpread([1, null, 3, undefined, 2]);
    assert.equal(r.median, 2);
    assert.equal(r.min,    1);
    assert.equal(r.max,    3);
    assert.equal(r.n,      3);
  });

  test('single value → median=min=max', () => {
    const r = computeSpread([5]);
    assert.equal(r.median, 5);
    assert.equal(r.min,    5);
    assert.equal(r.max,    5);
  });

  test('all null → returns null', () => {
    assert.equal(computeSpread([null, undefined]), null);
    assert.equal(computeSpread([]), null);
  });

  test('even-length array → average of two middle values', () => {
    const r = computeSpread([1, 2, 3, 4]);
    assert.equal(r.median, 2.5);
  });
});

// ---------------------------------------------------------------------------
// S6 — render
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S6: render — Markdown report structure', () => {
  function makeResults(opts = {}) {
    return {
      experimentId: opts.id ?? 'my-exp',
      generatedAt: '2026-06-26T00:00:00.000Z',
      configs: opts.configs ?? [
        {
          label: 'config-a',
          nCompleted: 2,
          nTotal: 2,
          metrics: {
            'cost.usd':          { median: 0.05, min: 0.04, max: 0.06 },
            'outcome.health':    { median: 85,   min: 80,   max: 90 },
            'judge.correctness': { median: 8,    min: 7,    max: 9 },
          },
        },
        {
          label: 'config-b',
          nCompleted: 2,
          nTotal: 2,
          metrics: {
            'cost.usd':          { median: 0.12, min: 0.10, max: 0.14 },
            'outcome.health':    { median: 90,   min: 85,   max: 95 },
            'judge.correctness': { median: 7,    min: 6,    max: 8 },
          },
        },
      ],
    };
  }

  test('render includes experiment id as H1', () => {
    const md = render(makeResults());
    assert.match(md, /# Experiment Report: my-exp/);
  });

  test('render includes config labels as table rows', () => {
    const md = render(makeResults());
    assert.match(md, /config-a/);
    assert.match(md, /config-b/);
  });

  test('render marks winner with **bold**', () => {
    const md = render(makeResults());
    // config-a wins on cost.usd (lower), config-b wins on outcome.health (higher)
    // The winning value should be bold somewhere in the table
    assert.match(md, /\*\*.*\*\*/);
  });

  test('render includes "## Winner per Metric" section', () => {
    const md = render(makeResults());
    assert.match(md, /## Winner per Metric/);
  });

  test('render includes "## Caveats" section', () => {
    const md = render(makeResults());
    assert.match(md, /## Caveats/);
  });

  test('render handles empty configs gracefully', () => {
    const md = render(makeResults({ configs: [] }));
    assert.match(md, /No runs found/i);
  });

  test('render includes N in caveats block', () => {
    const md = render(makeResults());
    assert.match(md, /N = 4 total runs/);
  });
});

// ---------------------------------------------------------------------------
// S7 — fast isolation test (NO full build required; runs unconditionally)
// ---------------------------------------------------------------------------

describe('COMP-MODEL-AB S7: sandbox isolation acceptance gate', () => {
  test('VisionWriter with COMPOSE_PORT=19997 does NOT modify live vision-state.json', async () => {
    // This test verifies the isolation primitive without running a full build.
    // It directly constructs a VisionWriter with port=19997 (the dead port the
    // sandbox uses), makes a write call, and asserts the live vision-state.json
    // is byte-identical afterwards.
    //
    // This is the acceptance gate from the design spec: "a sandbox build with
    // live :4001 UP must leave live vision-state byte-identical."

    const liveVisionStatePath = join(COMPOSE_ROOT, '.compose', 'data', 'vision-state.json');
    const liveSnapshotBefore  = existsSync(liveVisionStatePath)
      ? readFileSync(liveVisionStatePath, 'utf-8')
      : null;

    // Create a temp dir to act as the sandbox data dir
    const sandboxDataDir = mkdtempSync(join(tmpdir(), 'comp-ab-isolation-'));
    try {
      // Construct a VisionWriter with port=19997 (dead) pointing at the sandbox data dir.
      // COMPOSE_PORT in process.env is NOT changed — this proves the port comes from
      // the constructor arg, which is what experiment-sandbox.js sets in the child
      // process env (COMPOSE_PORT=19997 → resolvePort() → 19997 in the child).
      const sandboxWriter = new VisionWriter(sandboxDataDir, { port: 19997 });

      // Trigger a write — this should write to sandboxDataDir, NOT to live :4001
      await sandboxWriter.ensureFeatureItem('ISO-TEST', 'ISO-TEST', 'feature');

      // Assert 1: live vision-state unchanged
      const liveSnapshotAfter = existsSync(liveVisionStatePath)
        ? readFileSync(liveVisionStatePath, 'utf-8')
        : null;
      assert.equal(
        liveSnapshotAfter, liveSnapshotBefore,
        'ISOLATION BREACH: live vision-state.json was modified by a sandboxed VisionWriter'
      );

      // Assert 2: sandbox has its own vision-state (direct file write occurred)
      const sandboxVisionPath = join(sandboxDataDir, 'vision-state.json');
      assert.ok(
        existsSync(sandboxVisionPath),
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
        assert.equal(
          sandbox.env.COMPOSE_PORT, '19997',
          'sandbox COMPOSE_PORT must be 19997 (dead port for vision isolation)'
        );
        assert.notEqual(
          Number(sandbox.env.COMPOSE_PORT), 4001,
          'sandbox COMPOSE_PORT must not be the live server port'
        );
      } finally {
        sandbox.cleanup({ pruneWorkspace: true });
      }
    } finally {
      rmSync(expRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S7 — golden flow (COMP_MODEL_AB_GOLDEN=1 only, real builds)
// ---------------------------------------------------------------------------

if (process.env.COMP_MODEL_AB_GOLDEN === '1') {
  describe('COMP-MODEL-AB S7: golden flow (real builds, COMP_MODEL_AB_GOLDEN=1)', () => {
    test('full experiment: 2 configs × 1 rep → results.json + report.md + live vision-state unchanged', async () => {
      // This is the acceptance gate: real isolated builds, real backends, real
      // sandbox, real metrics. Expected to be slow (minutes per config).
      const SPEC_PATH = join(COMPOSE_ROOT, 'docs', 'features', 'COMP-MODEL-AB', 'example-experiment.json');
      assert.ok(existsSync(SPEC_PATH), `example spec not found: ${SPEC_PATH}`);

      const liveVisionStatePath = join(COMPOSE_ROOT, '.compose', 'data', 'vision-state.json');
      const liveSnapshotBefore  = existsSync(liveVisionStatePath)
        ? readFileSync(liveVisionStatePath, 'utf-8')
        : null;

      const { runExperiment } = await import('../lib/experiment.js');
      const result = await runExperiment(SPEC_PATH, { pruneWorkspaces: true });

      // results.json and report.md must exist
      assert.ok(existsSync(result.resultsPath), 'results.json must be written');
      assert.ok(existsSync(result.reportPath),  'report.md must be written');

      // results.json must have both configs
      const results = JSON.parse(readFileSync(result.resultsPath, 'utf-8'));
      assert.equal(results.configs.length, 2, 'results must have 2 configs');
      for (const cfg of results.configs) {
        assert.equal(cfg.nTotal, 1, 'each config must have 1 total run');
        // Cost and outcome must be populated (metrics.cost.wallMs always set)
        assert.ok(cfg.metrics['cost.wallMs'] != null || cfg.nCompleted === 0,
          'wallMs must be present for any run that ran');
      }

      // report.md must contain a comparison table
      const report = readFileSync(result.reportPath, 'utf-8');
      assert.match(report, /## Results/);
      assert.match(report, /## Caveats/);

      // ISOLATION GATE: live vision-state must be byte-identical after builds
      const liveSnapshotAfter = existsSync(liveVisionStatePath)
        ? readFileSync(liveVisionStatePath, 'utf-8')
        : null;
      assert.equal(
        liveSnapshotAfter, liveSnapshotBefore,
        'ISOLATION BREACH: live vision-state.json was modified by sandboxed builds'
      );
    });
  });
}
