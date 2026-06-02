/**
 * COMP-GSD-5 Task 4: gsd stuck-halt + resume tests.
 *
 * Drives runGsd with a stubbed Stratum client. Two scenarios:
 *   1. A task gets stuck (same-file edits) during the execute step → runGsd
 *      writes stuck.md + stuck.json (schema-valid) + pause.json and returns
 *      { status: 'stuck' }.
 *   2. `compose gsd <feature> --resume` reads pause.json, guards on pid/mode,
 *      re-dispatches decomposedTasks MINUS completedTaskIds, and deletes
 *      pause.json on clean completion.
 *
 * No real Stratum; the stub follows the pattern in test/gsd.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runGsd, loadResumeTaskGraph } = await import(`${REPO_ROOT}/lib/gsd.js`);
const Ajv = (await import('ajv')).default;

// --- schema (for validating the emitted stuck.json / pause.json) -------------
function compileDef(defName) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'gsd-stuck.json'), 'utf-8'));
  ajv.addSchema(schema, 'gsd-stuck.json');
  return ajv.compile({ $ref: `gsd-stuck.json#/definitions/${defName}` });
}

const FIXTURE_BLUEPRINT = `# COMP-GSD-5-FIX: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`lib/bar.js\` | new | Bar module |
| \`lib/baz.js\` | new | Baz module |

## Boundary Map

### S01: Bar

File Plan: \`lib/bar.js\` (new)

Produces:
  lib/bar.js → bar (function)

Consumes: nothing

### S02: Baz

File Plan: \`lib/baz.js\` (new)

Produces:
  lib/baz.js → baz (function)

Consumes:
  from S01: lib/bar.js → bar
`;

const TASKGRAPH = {
  tasks: [
    { id: 'T01', files_owned: ['lib/bar.js'], files_read: [], depends_on: [], description: '' },
    { id: 'T02', files_owned: ['lib/baz.js'], files_read: ['lib/bar.js'], depends_on: ['T01'], description: '' },
  ],
};

function ev(taskId, filePath) {
  return {
    schema_version: '0.2.7', flow_id: 'F1', step_id: 'execute',
    seq: Math.floor(Math.random() * 1e9), ts: new Date().toISOString(),
    kind: 'tool_use_summary', task_id: taskId,
    metadata: { tool: 'Edit', summary: 'edit', ok: true, duration_ms: 1, input: { file_path: filePath }, tool_use_id: `tu-${Math.random()}` },
  };
}

function scaffoldRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'gsd-resume-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name test', { cwd });
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/locks/\n');
  execSync('git add .gitignore && git commit -q -m initial', { cwd });
  const featureDir = join(cwd, 'docs', 'features', 'COMP-GSD-5-FIX');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
  execSync('git add . && git commit -q -m scaffold', { cwd });
  return cwd;
}

// A diff that writes a per-task TaskResult JSON (so the blackboard captures it).
function makeTaskDiff(taskId, code) {
  const path = `.compose/gsd/${code}/results/${taskId}.json`;
  const body = JSON.stringify({
    status: 'passed',
    files_changed: [`lib/${taskId.toLowerCase()}.js`],
    summary: `${taskId} done`,
    produces: { [taskId.toLowerCase()]: 'function' },
    gates: [{ command: 'pnpm test', status: 'pass', output: '' }],
    attempts: 1,
  }, null, 2);
  const lines = body.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`), '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Stub that makes T01 STUCK during execute (same-file edits → detector cancel).
// ---------------------------------------------------------------------------
function makeStuckStub({ captured }) {
  let phase = 'plan';
  let handler = null;
  let polls = 0;
  return {
    connect: async () => {}, disconnect: async () => {},
    plan: async () => {
      phase = 'decompose';
      return { status: 'execute_step', flow_id: 'F1', step_id: 'decompose_gsd', step_number: 1, total_steps: 3, agent: 'claude', intent: 'decompose', type: 'decompose' };
    },
    runAgentText: async () => {
      if (phase === 'decompose') return JSON.stringify(TASKGRAPH);
      throw new Error(`runAgentText unexpected in phase ${phase}`);
    },
    stepDone: async (flowId, stepId, result) => {
      if (stepId === 'decompose_gsd') {
        captured.decomposeResult = result;
        phase = 'execute';
        return { status: 'execute_step', flow_id: flowId, step_id: 'execute', step_number: 2, total_steps: 3, type: 'parallel_dispatch', tasks: result.tasks.map((t) => ({ id: t.id })), isolation: 'worktree', capture_diff: true };
      }
      throw new Error(`unexpected stepDone ${stepId}`);
    },
    parallelStart: async () => ({ status: 'started' }),
    onEvent: (flowId, stepId, fn) => { handler = fn; return () => { handler = null; }; },
    parallelPoll: async () => {
      // Emit a same-file edit for T01 each poll; after 3, the detector fires.
      if (handler) handler(ev('T01', 'lib/bar.js'));
      polls++;
      return {
        flow_id: 'F1', step_id: 'execute',
        summary: { pending: 0, running: 1, complete: 0, failed: 0, cancelled: 0 },
        tasks: { T01: { task_id: 'T01', state: 'running' }, T02: { task_id: 'T02', state: 'pending' } },
        require_satisfied: false, can_advance: false, outcome: null,
      };
    },
    parallelAdvance: async (flowId, stepId, mergeStatus) => {
      captured.cancelMergeStatus = mergeStatus;
      return { status: 'ensure_failed', reason: 'cancelled_stuck', step_id: stepId };
    },
  };
}

// ---------------------------------------------------------------------------
// Stub for the RESUME run: T01 already done (in blackboard); only T02 should
// be dispatched, and it completes cleanly.
// ---------------------------------------------------------------------------
function makeResumeStub({ captured }) {
  let phase = 'plan';
  return {
    connect: async () => {}, disconnect: async () => {},
    plan: async () => {
      phase = 'decompose';
      return { status: 'execute_step', flow_id: 'F2', step_id: 'decompose_gsd', step_number: 1, total_steps: 3, agent: 'claude', intent: 'decompose', type: 'decompose' };
    },
    runAgentText: async () => {
      // On resume, decompose MUST NOT call the agent — it uses persisted tasks.
      captured.agentCalledOnResume = true;
      throw new Error('runAgentText should not be called on resume');
    },
    stepDone: async (flowId, stepId, result) => {
      if (stepId === 'decompose_gsd') {
        captured.resumeDispatchTasks = result.tasks.map((t) => t.id);
        phase = 'execute';
        return { status: 'execute_step', flow_id: flowId, step_id: 'execute', step_number: 2, total_steps: 3, type: 'parallel_dispatch', tasks: result.tasks.map((t) => ({ id: t.id })), isolation: 'worktree', capture_diff: true };
      }
      if (stepId === 'execute') {
        phase = 'ship';
        return { status: 'execute_step', flow_id: flowId, step_id: 'ship_gsd', step_number: 3, total_steps: 3, agent: 'claude::critical', intent: 'ship' };
      }
      if (stepId === 'ship_gsd') { phase = 'done'; return { status: 'complete', flow_id: flowId }; }
      throw new Error(`unexpected stepDone ${stepId}`);
    },
    parallelStart: async () => ({ status: 'started' }),
    parallelPoll: async () => {
      // Only the re-dispatched tasks complete here. Build a diff for each.
      const tasks = {};
      for (const id of (captured.resumeDispatchTasks ?? [])) {
        tasks[id] = { task_id: id, state: 'complete', diff: makeTaskDiff(id, 'COMP-GSD-5-FIX') };
      }
      return {
        flow_id: 'F2', step_id: 'execute',
        summary: { pending: 0, running: 0, complete: Object.keys(tasks).length, failed: 0, cancelled: 0 },
        tasks, require_satisfied: true, can_advance: false,
        outcome: { status: 'awaiting_consumer_advance', aggregate: { merge_status: 'clean' } },
      };
    },
    parallelAdvance: async (flowId, stepId) => ({ status: 'execute_step', flow_id: flowId, step_id: 'ship_gsd', step_number: 3, total_steps: 3, agent: 'claude::critical', intent: 'ship' }),
  };
}

// ===========================================================================
// Scenario 1 — stuck halt writes artifacts
// ===========================================================================

describe('runGsd stuck halt', () => {
  test('writes stuck.md + schema-valid stuck.json + pause.json and returns status:stuck', async () => {
    const cwd = scaffoldRepo();
    try {
      const captured = {};
      process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
      const result = await runGsd('COMP-GSD-5-FIX', { cwd, stratum: makeStuckStub({ captured }) });
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;

      assert.equal(result.status, 'stuck', 'runGsd returns status:stuck');
      assert.equal(captured.cancelMergeStatus, 'conflict', 'stuck task cancelled via conflict');

      const gsdDir = join(cwd, '.compose', 'gsd', 'COMP-GSD-5-FIX');
      assert.ok(existsSync(join(gsdDir, 'stuck.md')), 'stuck.md written');
      assert.ok(existsSync(join(gsdDir, 'stuck.json')), 'stuck.json written');
      assert.ok(existsSync(join(gsdDir, 'pause.json')), 'pause.json written');

      const stuckJson = JSON.parse(readFileSync(join(gsdDir, 'stuck.json'), 'utf-8'));
      assert.ok(compileDef('stuck')(stuckJson), 'stuck.json must be schema-valid');
      assert.equal(stuckJson.signal, 'same_file');
      assert.equal(stuckJson.taskId, 'T01');
      assert.equal(stuckJson.feature, 'COMP-GSD-5-FIX');

      const pauseJson = JSON.parse(readFileSync(join(gsdDir, 'pause.json'), 'utf-8'));
      assert.ok(compileDef('pause')(pauseJson), 'pause.json must be schema-valid');
      assert.equal(pauseJson.mode, 'gsd');
      assert.equal(pauseJson.stuckTaskId, 'T01');
      assert.equal(pauseJson.pid, process.pid, 'pause records the owning pid');
      assert.deepEqual(pauseJson.decomposedTasks.map((t) => t.id), ['T01', 'T02'], 'full task list persisted');
      // T01 never produced a validated result → not completed.
      assert.deepEqual(pauseJson.completedTaskIds, [], 'no completed tasks (T01 was stuck, T02 never ran)');

      // The stuck.md should mention the signal and resume guidance.
      const md = readFileSync(join(gsdDir, 'stuck.md'), 'utf-8');
      assert.match(md, /same_file/);
      assert.match(md, /--resume/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Scenario 2 — resume guards + re-dispatch
// ===========================================================================

function writePause(cwd, overrides = {}) {
  const gsdDir = join(cwd, '.compose', 'gsd', 'COMP-GSD-5-FIX');
  mkdirSync(gsdDir, { recursive: true });
  const pause = {
    flowId: 'F1', stepId: 'execute', stuckTaskId: 'T02',
    signal: 'same_file', detail: 'lib/baz.js edited 3 times',
    decomposedTasks: TASKGRAPH.tasks,
    completedTaskIds: ['T01'],
    pid: 999999999, // not a live pid
    mode: 'gsd',
    ts: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(join(gsdDir, 'pause.json'), JSON.stringify(pause, null, 2));
  return join(gsdDir, 'pause.json');
}

// Seed the blackboard so T01's completed result is recognized as present.
function seedBlackboard(cwd) {
  const gsdDir = join(cwd, '.compose', 'gsd', 'COMP-GSD-5-FIX');
  mkdirSync(gsdDir, { recursive: true });
  const bb = {
    T01: { status: 'passed', files_changed: ['lib/bar.js'], summary: 'T01 done', produces: { bar: 'function' }, gates: [{ command: 'pnpm test', status: 'pass', output: '' }], attempts: 1 },
  };
  writeFileSync(join(gsdDir, 'blackboard.json'), JSON.stringify(bb, null, 2));
}

describe('runGsd --resume', () => {
  test('skips completedTaskIds and re-dispatches only the remainder', async () => {
    const cwd = scaffoldRepo();
    try {
      writePause(cwd);
      seedBlackboard(cwd);
      const captured = {};
      process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
      const result = await runGsd('COMP-GSD-5-FIX', { cwd, resume: true, stratum: makeResumeStub({ captured }) });
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;

      assert.notEqual(captured.agentCalledOnResume, true, 'resume must NOT re-decompose via the agent');
      assert.deepEqual(captured.resumeDispatchTasks, ['T02'], 'only T02 (not the completed T01) is re-dispatched');
      assert.equal(result.status, 'complete', 'clean resume completes the flow');

      // pause.json removed on clean finish.
      const pausePath = join(cwd, '.compose', 'gsd', 'COMP-GSD-5-FIX', 'pause.json');
      assert.equal(existsSync(pausePath), false, 'pause.json deleted after a clean resume');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses to resume when the recorded pid is still alive', async () => {
    const cwd = scaffoldRepo();
    try {
      // process.pid is definitely alive (it's us).
      writePause(cwd, { pid: process.pid });
      seedBlackboard(cwd);
      await assert.rejects(
        () => runGsd('COMP-GSD-5-FIX', { cwd, resume: true, stratum: makeResumeStub({ captured: {} }) }),
        /live|already|owns|running/i,
        'resume must refuse when another live pid owns the pause',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses to resume when mode mismatches', async () => {
    const cwd = scaffoldRepo();
    try {
      writePause(cwd, { mode: 'bug' });
      seedBlackboard(cwd);
      await assert.rejects(
        () => runGsd('COMP-GSD-5-FIX', { cwd, resume: true, stratum: makeResumeStub({ captured: {} }) }),
        /mode/i,
        'resume must refuse on mode mismatch',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('errors clearly when --resume is requested but no pause.json exists', async () => {
    const cwd = scaffoldRepo();
    try {
      await assert.rejects(
        () => runGsd('COMP-GSD-5-FIX', { cwd, resume: true, stratum: makeResumeStub({ captured: {} }) }),
        /no .*pause|nothing to resume|pause\.json/i,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a second --resume refuses while a claim is held (race-safe ownership)', () => {
    const cwd = scaffoldRepo();
    try {
      writePause(cwd);   // dead pid → passes the pid guard, reaches the claim
      seedBlackboard(cwd);
      // First resume claims ownership via an atomic mkdir of pause.lock.
      const first = loadResumeTaskGraph(cwd, 'COMP-GSD-5-FIX');
      assert.deepEqual(first.tasks.map((t) => t.id), ['T02'], 'first claim returns the remaining tasks');
      assert.ok(
        existsSync(join(cwd, '.compose', 'gsd', 'COMP-GSD-5-FIX', 'pause.lock')),
        'claim dir created',
      );
      // A concurrent second resume must refuse — the claim already exists. This
      // is the race Codex flagged: the atomic mkdir makes the loser get EEXIST.
      assert.throws(
        () => loadResumeTaskGraph(cwd, 'COMP-GSD-5-FIX'),
        /claim already exists|pause\.lock/i,
        'second resume must refuse while a claim is held',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
