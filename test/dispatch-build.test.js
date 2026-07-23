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
  newBuildAccumulatorRecord,
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

// COMP-TRIAGE-6-4: a fresh-over-failed retry whose startFresh (the plan call)
// throws must NOT re-finalize the prior attempt's accumulator. Before the fix,
// rotation ran AFTER startFresh, so a throw left the OLD failed record on disk
// under the reused build_id and finalizeBuildAttempt emitted a DUPLICATE
// build-actuals failed row under that same build_id (stale counters →
// double-count in ACRR). After the fix, rotation runs BEFORE startFresh, so the
// retry's terminal row lands under a fresh, distinct build_id.
test('fresh-over-failed retry whose startFresh throws does not duplicate the prior build-actuals row', async () => {
  const cwd = freshProject('dispatch-build-retry-throw-');
  try {
    setupBuildProject(cwd, ['COMP-RETRY']);
    const visionWriter = fakeVisionWriter();
    const { runBuild } = await import('../lib/build.js');

    // Run 1: plan resolves to a terminal 'failed' flow → leaves a failed
    // accumulator on disk (sidecar retained, last_terminal='failed').
    let planCalls = 0;
    const stratum = {
      async plan() {
        planCalls += 1;
        // The retry's startFresh (second plan call) explodes before writing
        // active-build state — the fallible path this fix guards.
        if (planCalls === 2) throw new Error('planned startFresh explosion');
        return {
          status: 'failed',
          runId: `flow-${planCalls}`,
          trace: [],
          failure: { reason: 'planned terminal failure' },
        };
      },
      async audit() {
        return { status: 'failed', trace: [] };
      },
      async close() {},
    };
    const opts = { cwd, stratum, visionWriter, template: 'build', skipTriage: true, description: 'x' };

    await runBuild('COMP-RETRY', opts);
    const firstId = readBuildAccumulator(cwd, 'COMP-RETRY').build_id;

    // Run 2: fresh-over-failed retry; startFresh throws.
    await assert.rejects(runBuild('COMP-RETRY', opts), /planned startFresh explosion/);

    const actuals = readEvents(cwd, { kind: 'build-actuals' });
    const ids = actuals.map((row) => row.build_id);
    // Each build_id emits exactly one terminal row — no duplicate under the old id.
    assert.equal(new Set(ids).size, ids.length, `duplicate build-actuals rows: ${JSON.stringify(ids)}`);
    assert.ok(actuals.every((row) => row.terminal_status === 'failed'));
    // The retry rotated to a fresh identity before the throw.
    const retryId = readBuildAccumulator(cwd, 'COMP-RETRY').build_id;
    assert.notEqual(retryId, firstId, 'retry must rotate the accumulator identity');
    assert.ok(ids.includes(firstId) && ids.includes(retryId));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// COMP-TRIAGE-6-4 (belt): a fresh-over-failed retry can also die BEFORE the
// fresh/resume verdict is resolved — e.g. stratum.audit() throws while probing
// the prior flow's terminality. That is upstream of the rotation, so
// finalizeBuildAttempt must not re-emit the reused failed record's terminal row
// under its old build_id. The prior attempt already closed that story.
test('fresh-over-failed retry whose flow-audit throws does not re-finalize the reused failed row', async () => {
  const cwd = freshProject('dispatch-build-audit-throw-');
  try {
    setupBuildProject(cwd, ['COMP-AUDIT']);
    const visionWriter = fakeVisionWriter();
    const { runBuild } = await import('../lib/build.js');

    let auditCalls = 0;
    const stratum = {
      async plan() {
        return {
          status: 'failed',
          runId: 'flow-1',
          trace: [],
          failure: { reason: 'planned terminal failure' },
        };
      },
      async audit() {
        // The retry probes the prior flow's terminality before deciding
        // fresh vs resume; make that probe explode.
        auditCalls += 1;
        throw new Error('planned audit explosion');
      },
      async close() {},
    };
    const opts = { cwd, stratum, visionWriter, template: 'build', skipTriage: true, description: 'x' };

    await runBuild('COMP-AUDIT', opts);
    const firstId = readBuildAccumulator(cwd, 'COMP-AUDIT').build_id;

    await assert.rejects(runBuild('COMP-AUDIT', opts), /planned audit explosion/);
    assert.ok(auditCalls >= 1, 'the retry must have reached the flow-audit probe');

    const actuals = readEvents(cwd, { kind: 'build-actuals' });
    // Exactly one terminal row — the retry died before owning a fresh identity,
    // so it must not add a second row under the reused build_id.
    assert.equal(actuals.length, 1, `expected one build-actuals row, got ${JSON.stringify(actuals.map((r) => r.build_id))}`);
    assert.equal(actuals[0].build_id, firstId);
    assert.equal(actuals[0].terminal_status, 'failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// COMP-TRIAGE-6-4 (guard boundary): the ownership guard must suppress ONLY a
// reused record that already emitted (last_terminal==='failed'). A reused but
// still-OPEN record (last_terminal===null — a hard-killed build that never
// finalized) has not emitted yet, so an attempt that dies before the verdict
// must still leave that build its one terminal row. Regression for the guard
// wrongly swallowing an interrupted build's only actuals row.
test('interrupted (last_terminal=null) reuse that dies before the verdict still emits its terminal row', async () => {
  const cwd = freshProject('dispatch-build-interrupted-');
  try {
    setupBuildProject(cwd, ['COMP-INT']);
    const dataDir = join(cwd, '.compose', 'data');

    // Seed a hard-killed prior attempt: an OPEN accumulator (last_terminal=null)
    // with real counters, and an active-build pointing at a dead pid so the
    // retry takes the audit-probe path.
    const seeded = {
      ...newBuildAccumulatorRecord('COMP-INT'),
      build_id: '4fe533b1-70b4-4df7-845e-85c1686ad832',
      last_terminal: null,
      tokens_total: 4242,
      usd: 0.99,
    };
    writeBuildAccumulator(cwd, seeded);
    writeFileSync(
      join(dataDir, 'active-build.json'),
      JSON.stringify({
        featureCode: 'COMP-INT',
        flowId: 'flow-open',
        pipeline: 'build',
        mode: 'feature',
        pid: 999999, // not alive → audit probe runs
        status: 'running',
        currentStepId: 'work',
      }),
    );

    const visionWriter = fakeVisionWriter();
    const stratum = {
      async plan() { return { status: 'completed', runId: 'flow-x', trace: [] }; },
      async audit() { throw new Error('planned audit explosion'); },
      async close() {},
    };
    const { runBuild } = await import('../lib/build.js');
    await assert.rejects(
      runBuild('COMP-INT', { cwd, stratum, visionWriter, template: 'build', skipTriage: true, description: 'x' }),
      /planned audit explosion/,
    );

    const actuals = readEvents(cwd, { kind: 'build-actuals' });
    assert.equal(actuals.length, 1, 'the interrupted build must still get its terminal row');
    assert.equal(actuals[0].build_id, '4fe533b1-70b4-4df7-845e-85c1686ad832');
    assert.equal(actuals[0].terminal_status, 'failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// COMP-TRIAGE-6-4 (row-first ordering): emitBuildActuals appends the durable
// ledger row BEFORE writing the accumulator marker / clearing the sidecar, so
// the two writes are effectively atomic — a crash between them can never strand
// a `last_terminal='failed'` marker with no row, nor lose a row. Assert the
// happy-path outcome is unchanged (row + marker for failed; row + sidecar
// cleared for complete) and that the row is emitted from the persisted snapshot.
test('emitBuildActuals writes the ledger row then the marker/clear (row-first)', () => {
  const cwd = freshProject('dispatch-build-rowfirst-');
  try {
    createBuildAccumulator(cwd, 'COMP-ORDER');
    updateBuildAccumulator(cwd, 'COMP-ORDER', (acc) => ({
      ...acc,
      files_changed: ['x.js'],
      tokens_total: 42,
    }));
    const failId = readBuildAccumulator(cwd, 'COMP-ORDER').build_id;
    emitBuildActuals(cwd, readBuildAccumulator(cwd, 'COMP-ORDER'), 'failed');
    // Failed: row is durable AND the marker was written after it.
    const afterFail = readEvents(cwd, { kind: 'build-actuals' });
    assert.equal(afterFail.length, 1);
    assert.equal(afterFail[0].build_id, failId);
    assert.equal(afterFail[0].tokens_total, 42);
    assert.equal(readBuildAccumulator(cwd, 'COMP-ORDER').last_terminal, 'failed');

    // Complete: row is durable AND the sidecar is cleared after it.
    emitBuildActuals(cwd, readBuildAccumulator(cwd, 'COMP-ORDER'), 'complete');
    const afterComplete = readEvents(cwd, { kind: 'build-actuals' });
    assert.deepEqual(afterComplete.map((r) => r.terminal_status), ['failed', 'complete']);
    assert.equal(existsSync(buildAccumulatorPath(cwd, 'COMP-ORDER')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
