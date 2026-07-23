/**
 * COMP-TRIAGE-6 Phase 3 — build identity, estimates, actuals, and settlements.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildAccumulatorPath,
  createBuildAccumulator,
  emitBuildActuals,
  emitTriageEstimate,
  readBuildAccumulator,
  selectBuildAccumulator,
  settleDispatches,
  updateBuildAccumulator,
  writeBuildAccumulator,
} from '../lib/build.js';
import { readEvents } from '../lib/dispatch-ledger.js';

function freshProject(prefix = 'dispatch-build-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

const TERMINAL_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
`;

function setupBuildProject(cwd, featureCodes) {
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  mkdirSync(join(cwd, 'pipelines'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2 }));
  writeFileSync(join(cwd, 'pipelines', 'build.stratum.yaml'), TERMINAL_SPEC);
  for (const featureCode of featureCodes) {
    const featureDir = join(cwd, 'docs', 'features', featureCode);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'description.md'), `# ${featureCode}\n`);
  }
}

function terminalStratum(statuses) {
  let nextId = 0;
  return {
    async plan() {
      const status = statuses.shift() ?? 'completed';
      nextId += 1;
      return {
        status,
        runId: `flow-${nextId}`,
        trace: [],
        ...(status === 'failed' ? { failure: { reason: 'planned terminal failure' } } : {}),
      };
    },
    async close() {},
  };
}

function fakeVisionWriter() {
  return {
    async ensureFeatureItem(featureCode) { return featureCode; },
    async updateItemStatus() {},
    async updateItemPhase() {},
  };
}

describe('build accumulator lifecycle', () => {
  test('failed → resume → complete keeps identity and cumulative counters; complete wins and clears', () => {
    const cwd = freshProject();
    try {
      const created = selectBuildAccumulator(cwd, 'COMP-X');
      assert.equal(created.isNew, true);
      // Selection is side-effect-free: nothing persists until the caller owns
      // the attempt (review r2 — a refused --fresh must not clobber a live
      // build's sidecar).
      assert.equal(readBuildAccumulator(cwd, 'COMP-X'), null);
      writeBuildAccumulator(cwd, created.accumulator);
      const buildId = created.accumulator.build_id;

      updateBuildAccumulator(cwd, 'COMP-X', (acc) => ({
        ...acc,
        review_iterations: acc.review_iterations + 1,
        escalations: acc.escalations + 1,
        files_changed: ['lib/a.js', 'lib/a.js', 'lib/b.js'],
        tokens_total: acc.tokens_total + 12,
        usd: acc.usd + 0.25,
      }));
      emitBuildActuals(cwd, readBuildAccumulator(cwd, 'COMP-X'), 'failed');

      const resumed = selectBuildAccumulator(cwd, 'COMP-X');
      assert.equal(resumed.isNew, false);
      assert.equal(resumed.accumulator.build_id, buildId);
      assert.equal(resumed.accumulator.review_iterations, 1);
      assert.equal(resumed.accumulator.escalations, 1);
      assert.equal(resumed.accumulator.tokens_total, 12);

      updateBuildAccumulator(cwd, 'COMP-X', (acc) => ({
        ...acc,
        files_changed: [...new Set([...acc.files_changed, 'lib/c.js'])],
        ship_files_changed: ['ship/one.js', 'ship/two.js'],
        test_count: 8,
        pass_rate: 100,
        tokens_total: acc.tokens_total + 5,
        usd: acc.usd + 0.1,
      }));
      emitBuildActuals(cwd, readBuildAccumulator(cwd, 'COMP-X'), 'complete');

      assert.equal(existsSync(buildAccumulatorPath(cwd, 'COMP-X')), false);
      const actuals = readEvents(cwd, { kind: 'build-actuals' });
      assert.deepEqual(actuals.map((row) => row.terminal_status), ['failed', 'complete']);
      assert.deepEqual(actuals.map((row) => row.build_id), [buildId, buildId]);
      assert.equal(actuals.at(-1).files_changed_count, 2);
      assert.equal(actuals.at(-1).files_source, 'ship');
      assert.equal(actuals.at(-1).review_iterations, 1);
      assert.equal(actuals.at(-1).escalations, 1);
      assert.equal(actuals.at(-1).tokens_total, 17);
      assert.equal(actuals.at(-1).usd, 0.35);
      assert.equal(actuals.at(-1).test_count, 8);
      assert.equal(actuals.at(-1).pass_rate, 100);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('actuals fall back to the accumulated deduplicated file union', () => {
    const cwd = freshProject();
    try {
      createBuildAccumulator(cwd, 'COMP-FILES');
      updateBuildAccumulator(cwd, 'COMP-FILES', (acc) => ({
        ...acc,
        files_changed: ['a.js', 'b.js'],
      }));
      emitBuildActuals(cwd, readBuildAccumulator(cwd, 'COMP-FILES'), 'failed');
      const row = readEvents(cwd, { kind: 'build-actuals' })[0];
      assert.equal(row.files_source, 'accumulated');
      assert.equal(row.files_changed_count, 2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('strict reads reject corrupt and feature-mismatched sidecars', () => {
    const cwd = freshProject();
    try {
      const path = buildAccumulatorPath(cwd, 'COMP-X');
      mkdirSync(join(cwd, '.compose', 'data', 'build-accumulator'), { recursive: true });
      writeFileSync(path, '{bad json');
      assert.throws(() => readBuildAccumulator(cwd, 'COMP-X'), /corrupt/i);

      writeFileSync(path, JSON.stringify({
        v: 1,
        build_id: '930d8aac-46ac-4f7f-a6b4-36fb96e12b4c',
        feature_code: 'COMP-Y',
        last_terminal: null,
        review_iterations: 0,
        escalations: 0,
        files_changed: [],
        ship_files_changed: null,
        test_count: null,
        pass_rate: null,
        tokens_total: 0,
        usd: 0,
      }));
      assert.throws(() => readBuildAccumulator(cwd, 'COMP-X'), /feature.*mismatch/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('triage estimate and settlement rows', () => {
  test('persisted front/refined/escalated sources map to fresh/fresh/escalated', () => {
    const cwd = freshProject();
    try {
      for (const [index, estimateSource] of ['front', 'refined', 'escalated'].entries()) {
        emitTriageEstimate(cwd, {
          build_id: `build-${index}`,
          feature_code: `COMP-${index}`,
          triageTier: index,
          lane: index === 2 ? 'complex' : 'standard',
          profile: { needs_verification: true },
          estimateSource,
          triageConfidence: index === 0 ? null : 'medium',
        });
      }
      const rows = readEvents(cwd, { kind: 'triage-estimate' });
      assert.deepEqual(rows.map((row) => row.estimate_source), ['fresh', 'fresh', 'escalated']);
      assert.deepEqual(rows.map((row) => row.confidence), [null, 'medium', 'medium']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('settles only dispatch-backed work, suppresses GSD, and pairs primary plus repair', () => {
    const cwd = freshProject();
    try {
      settleDispatches(cwd, 'build-1', 'work', {
        dispatchIds: { primary: null, repair: null },
        accepted: true,
      });
      settleDispatches(cwd, 'build-1', 'gsd', {
        dispatchIds: { primary: 'gsd-id', repair: null },
        accepted: true,
        gsd: true,
      });
      settleDispatches(cwd, 'build-1', 'work', {
        dispatchIds: { primary: 'primary-ok', repair: null },
        accepted: true,
      });
      settleDispatches(cwd, 'build-1', 'retry', {
        dispatchIds: { primary: 'retry-id', repair: null },
        accepted: true,
        isEnsureRetry: true,
      });
      for (const failureClass of ['ownership', 'vocabulary', 'normalization', 'agent']) {
        settleDispatches(cwd, 'build-1', failureClass, {
          dispatchIds: { primary: `${failureClass}-id`, repair: null },
          accepted: false,
          failureClass,
        });
      }
      settleDispatches(cwd, 'build-1', 'review', {
        dispatchIds: { primary: 'primary-review', repair: 'repair-review' },
        accepted: false,
        failureClass: 'agent',
      });

      const rows = readEvents(cwd, { kind: 'settlement' });
      assert.deepEqual(rows.map(({ dispatch_id, accepted, failure_class }) => ({
        dispatch_id, accepted, failure_class,
      })), [
        { dispatch_id: 'primary-ok', accepted: true, failure_class: undefined },
        { dispatch_id: 'retry-id', accepted: false, failure_class: 'ensure-retry' },
        { dispatch_id: 'ownership-id', accepted: false, failure_class: 'ownership' },
        { dispatch_id: 'vocabulary-id', accepted: false, failure_class: 'vocabulary' },
        { dispatch_id: 'normalization-id', accepted: false, failure_class: 'normalization' },
        { dispatch_id: 'agent-id', accepted: false, failure_class: 'agent' },
        { dispatch_id: 'primary-review', accepted: false, failure_class: 'normalization' },
        { dispatch_id: 'repair-review', accepted: false, failure_class: 'agent' },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test('missing lifecycle spec emits failed actuals and retains the sidecar', async () => {
  const cwd = freshProject('dispatch-build-missing-spec-');
  try {
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2 }));
    const { runBuild } = await import('../lib/build.js');
    await assert.rejects(
      runBuild('COMP-MISSING', {
        cwd,
        template: 'does-not-exist',
        skipTriage: true,
      }),
      /Lifecycle spec not found/,
    );
    const actuals = readEvents(cwd, { kind: 'build-actuals' });
    assert.equal(actuals.length, 1);
    assert.equal(actuals[0].terminal_status, 'failed');
    assert.equal(existsSync(buildAccumulatorPath(cwd, 'COMP-MISSING')), true);
    assert.equal(readBuildAccumulator(cwd, 'COMP-MISSING').last_terminal, 'failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('complete, failed, and health-downgraded attempts each emit one final actual', async () => {
  const cwd = freshProject('dispatch-build-terminals-');
  try {
    setupBuildProject(cwd, ['COMP-OK', 'COMP-FAIL', 'COMP-HEALTH']);
    const stratum = terminalStratum(['completed', 'failed', 'completed']);
    const visionWriter = fakeVisionWriter();
    const { runBuild } = await import('../lib/build.js');

    await runBuild('COMP-OK', {
      cwd,
      stratum,
      visionWriter,
      template: 'build',
      skipTriage: true,
      description: 'complete',
    });
    await runBuild('COMP-FAIL', {
      cwd,
      stratum,
      visionWriter,
      template: 'build',
      skipTriage: true,
      description: 'failed',
    });

    writeFileSync(
      join(cwd, '.compose', 'data', 'settings.json'),
      JSON.stringify({ health: { gate_threshold: 101 } }),
    );
    await runBuild('COMP-HEALTH', {
      cwd,
      stratum,
      visionWriter,
      template: 'build',
      skipTriage: true,
      description: 'health downgrade',
    });

    const actuals = readEvents(cwd, { kind: 'build-actuals' });
    assert.deepEqual(
      actuals.map(({ feature_code, terminal_status }) => ({ feature_code, terminal_status })),
      [
        { feature_code: 'COMP-OK', terminal_status: 'complete' },
        { feature_code: 'COMP-FAIL', terminal_status: 'failed' },
        { feature_code: 'COMP-HEALTH', terminal_status: 'failed' },
      ],
    );
    assert.equal(existsSync(buildAccumulatorPath(cwd, 'COMP-OK')), false);
    assert.equal(readBuildAccumulator(cwd, 'COMP-FAIL').last_terminal, 'failed');
    assert.equal(readBuildAccumulator(cwd, 'COMP-HEALTH').last_terminal, 'failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runBuild emits fresh, cached, and escalated estimates on the three resolution paths', async () => {
  const cwd = freshProject('dispatch-build-estimates-');
  try {
    setupBuildProject(cwd, ['COMP-EST']);
    const stratum = terminalStratum(['completed', 'completed', 'completed']);
    const visionWriter = fakeVisionWriter();
    const { runBuild } = await import('../lib/build.js');
    const options = {
      cwd,
      stratum,
      visionWriter,
      description: 'fix typo in src/example.js',
    };

    await runBuild('COMP-EST', options);
    const featurePath = join(cwd, 'docs', 'features', 'COMP-EST', 'feature.json');
    let feature = JSON.parse(readFileSync(featurePath, 'utf8'));
    feature.triageTimestamp = '2999-01-01T00:00:00.000Z';
    writeFileSync(featurePath, JSON.stringify(feature, null, 2));

    await runBuild('COMP-EST', options);
    feature = JSON.parse(readFileSync(featurePath, 'utf8'));
    feature.estimateSource = 'escalated';
    feature.lane = 'complex';
    feature.triageTier = 4;
    feature.complexity = 'XL';
    feature.profile = {
      needs_prd: true,
      needs_architecture: true,
      needs_verification: true,
      needs_report: true,
    };
    writeFileSync(featurePath, JSON.stringify(feature, null, 2));

    await runBuild('COMP-EST', options);

    const estimates = readEvents(cwd, { kind: 'triage-estimate' });
    assert.deepEqual(estimates.map((row) => row.estimate_source), ['fresh', 'cached', 'escalated']);
    assert.ok(estimates.every((row) => row.confidence === null
      || ['high', 'medium', 'low'].includes(row.confidence)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
