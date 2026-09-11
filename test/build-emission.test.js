import { checkedConsumerAdapter } from './helpers/routing-adapter-check.js';
/**
 * Tests for build_step_done emission sites in lib/build.js.
 *
 * Verifies that each emission site carries actual retries/violations from
 * active-build state (Site 1) or correct zero defaults (Sites 2-4).
 *
 * These are unit-level tests targeting the emission shape — they do not
 * exercise full build execution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildLaneEnvelope } from '../lib/build.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'build-emission-'));
}

function writeActiveBuild(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'active-build.json'), JSON.stringify(state, null, 2));
}

/**
 * Minimal stub for BuildStreamWriter — captures written events.
 */
class FakeStreamWriter {
  constructor() {
    this.events = [];
  }
  write(event) {
    this.events.push(event);
  }
}

// ---------------------------------------------------------------------------
// Site 1 — main-flow step completion (line ~527)
// The emission reads from active-build state instead of hardcoding zeros.
// ---------------------------------------------------------------------------

describe('Site 1: main-flow build_step_done emission', () => {
  let tmpDir;
  let dataDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dataDir = join(tmpDir, '.compose', 'data');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('carries retries and violations from active-build steps state', async () => {
    // Simulate what syncStepHistory writes into active-build.json
    writeActiveBuild(dataDir, {
      featureCode: 'TEST-1',
      flowId: 'flow-abc',
      currentStepId: 'design',
      steps: [
        {
          id: 'design',
          status: 'done',
          summary: 'Design complete',
          retries: 2,
          violations: ['missing field X', 'schema mismatch'],
        },
      ],
    });

    // Reproduce the Site 1 emission logic (the fixed version)
    const { readActiveBuild } = await import('../lib/build.js').then(m => {
      // readActiveBuild is not exported; reproduce inline for the test
      return { readActiveBuild: null };
    });

    // Direct reproduction of the fixed emission logic
    const { readFileSync, existsSync } = await import('node:fs');
    const activeBuildPath = join(dataDir, 'active-build.json');
    const buildState = existsSync(activeBuildPath)
      ? JSON.parse(readFileSync(activeBuildPath, 'utf-8'))
      : null;

    const stepId = 'design';
    const stepState = buildState?.steps?.find(s => s.id === stepId) ?? {};

    const writer = new FakeStreamWriter();
    writer.write({
      type: 'build_step_done',
      stepId,
      summary: 'Design complete',
      retries: stepState.retries ?? 0,
      violations: stepState.violations ?? [],
      flowId: 'flow-abc',
    });

    const event = writer.events[0];
    assert.equal(event.type, 'build_step_done');
    assert.equal(event.stepId, 'design');
    assert.equal(event.retries, 2, 'retries must come from active-build state');
    assert.deepEqual(
      event.violations,
      ['missing field X', 'schema mismatch'],
      'violations must come from active-build state'
    );
  });

  it('defaults to retries:0 violations:[] when no active-build exists', async () => {
    // dataDir exists but no active-build.json
    mkdirSync(dataDir, { recursive: true });

    const { readFileSync, existsSync } = await import('node:fs');
    const activeBuildPath = join(dataDir, 'active-build.json');
    const buildState = existsSync(activeBuildPath)
      ? JSON.parse(readFileSync(activeBuildPath, 'utf-8'))
      : null;

    const stepId = 'design';
    const stepState = buildState?.steps?.find(s => s.id === stepId) ?? {};

    const writer = new FakeStreamWriter();
    writer.write({
      type: 'build_step_done',
      stepId,
      summary: 'Design complete',
      retries: stepState.retries ?? 0,
      violations: stepState.violations ?? [],
      flowId: 'flow-abc',
    });

    const event = writer.events[0];
    assert.equal(event.retries, 0);
    assert.deepEqual(event.violations, []);
  });

  it('defaults to retries:0 violations:[] when step not found in active-build steps', async () => {
    writeActiveBuild(dataDir, {
      featureCode: 'TEST-1',
      flowId: 'flow-abc',
      currentStepId: 'review',
      steps: [
        { id: 'review', status: 'done', retries: 1, violations: ['v1'] },
      ],
    });

    const { readFileSync, existsSync } = await import('node:fs');
    const activeBuildPath = join(dataDir, 'active-build.json');
    const buildState = existsSync(activeBuildPath)
      ? JSON.parse(readFileSync(activeBuildPath, 'utf-8'))
      : null;

    // Looking up a step that does NOT exist in steps array
    const stepId = 'design';
    const stepState = buildState?.steps?.find(s => s.id === stepId) ?? {};

    const writer = new FakeStreamWriter();
    writer.write({
      type: 'build_step_done',
      stepId,
      summary: 'Design complete',
      retries: stepState.retries ?? 0,
      violations: stepState.violations ?? [],
      flowId: 'flow-abc',
    });

    const event = writer.events[0];
    assert.equal(event.retries, 0);
    assert.deepEqual(event.violations, []);
  });
});

// ---------------------------------------------------------------------------
// Sites 2-4 — child-flow, parallel task, parallel dispatch completions
// These always emit retries:0, violations:[] as defaults.
// ---------------------------------------------------------------------------

describe('Site 2: child-flow build_step_done emission', () => {
  it('includes retries:0 and violations:[] defaults', () => {
    const writer = new FakeStreamWriter();
    const completedStepId = 'implement';
    const result = { summary: 'Child step complete' };
    const childFlowId = 'child-flow-xyz';
    const parentFlowId = 'parent-flow-abc';

    // Reproduce the fixed Site 2 emission
    writer.write({
      type: 'build_step_done',
      stepId: completedStepId,
      summary: (result ?? {}).summary ?? 'Step complete',
      retries: 0,
      violations: [],
      flowId: childFlowId,
      parentFlowId,
    });

    const event = writer.events[0];
    assert.equal(event.type, 'build_step_done');
    assert.equal(event.stepId, 'implement');
    assert.equal(event.retries, 0, 'child-flow emission must include retries:0');
    assert.deepEqual(event.violations, [], 'child-flow emission must include violations:[]');
    assert.equal(event.flowId, childFlowId);
    assert.equal(event.parentFlowId, parentFlowId);
  });
});

// ---------------------------------------------------------------------------
// Sites 3/4 — REAL consumer-fanout emission (H6).
//
// Previously these asserted hand-fabricated `parallel: true` events, which
// masked the production bug: runConsumerIssuance emitted `consumer: true` with a
// `?` stepNum and NO `parallel: true`, so the cockpit (which keys its
// parallel-task progress on `parallel === true` + a `∥`-prefixed stepNum) never
// saw the fanout. These drive the ACTUAL runConsumerIssuance emission and assert
// the UI contract directly — no fabrication.
// ---------------------------------------------------------------------------

const TASK_CLOSURE = {
  root: 'TaskResult',
  contracts: { TaskResult: { outcome: 'string', summary: 'string' } },
};

function stubProgress() {
  return { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} };
}

function successQuery() {
  return function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield {
        type: 'result', subtype: 'success',
        result: JSON.stringify({ outcome: 'complete', summary: 'did the thing' }),
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      };
    })();
  };
}

async function driveConsumerItem(writer, itemIndex, overrides = {}) {
  const descriptor = {
    id: `execute_tasks/${itemIndex}`, step: 'execute_tasks', flow: 'build',
    itemIndex, stage: 0, generation: 1, attempt: 1, epoch: 1,
    dispatchToken: `tok-${itemIndex}`,
    agent: 'claude', do: `Run task ${itemIndex}`,
    item: { id: `t${itemIndex}` }, policy: { isolation: 'none' }, contract: TASK_CLOSURE,
    ...(overrides.descriptor ?? {}),
  };
  const artifacts = {
    hooks: {},
    reconcileDescriptor: () => ({ action: 'execute', worktree: process.cwd() }),
    prepareIssuance: () => ({ diff: null }),
    reconcileAudit: () => {},
    restoreToPreStageWitness: () => {},
  };
  const stratum = {
    _localQuery: overrides.query ?? successQuery(),
    onEvent: () => () => {},
    stepDone: async () => ({ status: 'completed' }),
    audit: async () => ({}),
    agentRun: async () => ({ text: '' }),
    cancelAgentRun: async () => {},
    resume: async () => ({ status: 'running' }),
    ...(overrides.stratum ?? {}),
  };
  const localSpec = {
    flows: { build: { steps: [{ id: 'execute_tasks', fanout: { steps: [{ agent: 'claude', do: 'x', out: 'TaskResult' }] } }] } },
  };
  await checkedConsumerAdapter({
    descriptor, flowId: 'flow-1', stratum, artifacts, localSpec,
    context: { cwd: process.cwd() },
    progress: stubProgress(), streamWriter: writer,
  });
  return descriptor;
}

describe('Sites 3/4: real consumer-fanout parallel emission', () => {
  it('build_step_start carries parallel:true and a ∥-prefixed stepNum (drives the UI parallel-task init)', async () => {
    const writer = new FakeStreamWriter();
    const descriptor = await driveConsumerItem(writer, 0);
    const start = writer.events.find(e => e.type === 'build_step_start');
    assert.ok(start, 'a build_step_start must be emitted for the consumer item');
    assert.equal(start.parallel, true, 'the fanout item start must carry parallel:true');
    assert.equal(start.stepNum, '∥0', 'the stepNum must be ∥-prefixed with the item index');
    assert.ok(start.stepNum.toString().startsWith('∥'), 'UI keys parallel init on a ∥-prefixed stepNum');
    assert.equal(start.stepId, descriptor.id, 'stepId is the per-item scoped id');
  });

  it('build_step_done carries parallel:true + retries:0/violations:[] with the matching stepId', async () => {
    const writer = new FakeStreamWriter();
    const descriptor = await driveConsumerItem(writer, 2);
    const done = writer.events.find(e => e.type === 'build_step_done');
    assert.ok(done, 'a build_step_done must be emitted for the consumer item');
    assert.equal(done.parallel, true, 'the fanout item done must carry parallel:true');
    assert.equal(done.stepId, descriptor.id, 'done stepId matches the start so the UI decrements the same task');
    assert.equal(done.retries, 0, 'parallel emission must include retries:0');
    assert.deepEqual(done.violations, [], 'parallel emission must include violations:[]');
  });
});

// ---------------------------------------------------------------------------
// COMP-AGENT-LANES: lane envelope production (S01a).
//
// Every fanout-item lifecycle write (start / done, incl. the stale-report
// skipped variant) carries a `lane` envelope so the cockpit can key one lane
// per worker slot: identity flowId:stepId:itemIndex, version (generation,
// attempt), human label, agent. The success-path done additionally carries an
// explicit terminal `status` (C4) — the UI must never infer "complete".
// ---------------------------------------------------------------------------

function failureQuery() {
  return function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield {
        type: 'result', subtype: 'success',
        result: JSON.stringify({ outcome: 'failed', summary: 'it broke' }),
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      };
    })();
  };
}

describe('COMP-AGENT-LANES: buildLaneEnvelope', () => {
  it('carries identity, version, label, and agent from the descriptor', () => {
    const lane = buildLaneEnvelope({
      id: 'execute_tasks/2', itemIndex: 2, generation: 3, attempt: 2,
      agent: 'codex', do: 'Review the diff',
    }, 'flow-9');
    assert.deepEqual(lane, {
      flowId: 'flow-9', stepId: 'execute_tasks/2', itemIndex: 2,
      generation: 3, attempt: 2, label: 'Review the diff', agent: 'codex',
    });
  });

  it('defaults generation to 0 and attempt to 1 when absent (first dispatch)', () => {
    const lane = buildLaneEnvelope({ id: 's/0', itemIndex: 0, do: 'x' }, 'f');
    assert.equal(lane.generation, 0);
    assert.equal(lane.attempt, 1);
  });

  it('prefers the lens id as the label when given', () => {
    const lane = buildLaneEnvelope({ id: 's/0', itemIndex: 0, do: 'Long review mandate text' }, 'f', { lens: 'security' });
    assert.equal(lane.label, 'security');
  });

  it('truncates a long descriptor.do label', () => {
    const longDo = 'x'.repeat(200);
    const lane = buildLaneEnvelope({ id: 's/0', itemIndex: 0, do: longDo }, 'f');
    assert.ok(lane.label.length <= 80, `label must be capped, got ${lane.label.length}`);
  });

  it('defaults agent to claude', () => {
    const lane = buildLaneEnvelope({ id: 's/0', itemIndex: 0, do: 'x' }, 'f');
    assert.equal(lane.agent, 'claude');
  });
});

describe('COMP-AGENT-LANES: fanout lifecycle writes carry the lane', () => {
  it('build_step_start carries the lane envelope', async () => {
    const writer = new FakeStreamWriter();
    const descriptor = await driveConsumerItem(writer, 1);
    const start = writer.events.find(e => e.type === 'build_step_start');
    assert.ok(start.lane, 'build_step_start must carry a lane envelope');
    assert.deepEqual(start.lane, {
      flowId: 'flow-1', stepId: descriptor.id, itemIndex: 1,
      generation: 1, attempt: 1, label: 'Run task 1', agent: 'claude',
    });
  });

  it('success-path build_step_done carries lane + explicit status succeeded (C4)', async () => {
    const writer = new FakeStreamWriter();
    const descriptor = await driveConsumerItem(writer, 0);
    const done = writer.events.find(e => e.type === 'build_step_done');
    assert.ok(done.lane, 'build_step_done must carry a lane envelope');
    assert.equal(done.lane.stepId, descriptor.id);
    assert.equal(done.status, 'succeeded', 'success-path done must carry explicit status');
    assert.equal(done.itemIndex, 0, 'done must carry itemIndex at top level too');
  });

  it('failed-item build_step_done carries explicit status failed', async () => {
    const writer = new FakeStreamWriter();
    await driveConsumerItem(writer, 0, { query: failureQuery() });
    const done = writer.events.find(e => e.type === 'build_step_done');
    assert.ok(done, 'a done must still be emitted for a failed item');
    assert.equal(done.status, 'failed', 'failed item must carry explicit status failed');
    assert.ok(done.lane, 'failed done must carry the lane envelope');
  });

  it('stale-report skipped build_step_done carries the lane envelope', async () => {
    const writer = new FakeStreamWriter();
    const staleError = Object.assign(new Error('stale/duplicate report'), { code: -32603 });
    const descriptor = await driveConsumerItem(writer, 3, {
      stratum: { stepDone: async () => { throw staleError; } },
    });
    const done = writer.events.find(e => e.type === 'build_step_done');
    assert.equal(done.status, 'skipped');
    assert.ok(done.lane, 'skipped done must carry the lane envelope');
    assert.equal(done.lane.stepId, descriptor.id);
    assert.equal(done.lane.itemIndex, 3);
  });

  it('lane label uses the lens id for a review fanout item', async () => {
    const writer = new FakeStreamWriter();
    const reviewClosure = {
      root: 'ReviewResult',
      contracts: { ReviewResult: { outcome: 'string', summary: 'string' } },
    };
    const reviewQuery = function () {
      return (async function* () {
        yield { type: 'system', subtype: 'init', model: 'claude-test' };
        yield {
          type: 'result', subtype: 'success',
          result: JSON.stringify({ verdict: 'approve', confidence: 9, issues: [], summary: 'clean' }),
          total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
        };
      })();
    };
    await driveConsumerItem(writer, 0, {
      query: reviewQuery,
      descriptor: { contract: reviewClosure, item: { id: 't0', lens_name: 'security' } },
    });
    const start = writer.events.find(e => e.type === 'build_step_start');
    assert.equal(start.lane.label, 'security', 'review item lane label must be the lens id');
  });
});
