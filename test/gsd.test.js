/**
 * COMP-GSD-2 T7: Golden flow test.
 *
 * Drives runGsd end-to-end against a fixture feature with a stubbed Stratum
 * client and a mock task-result file system. Verifies the load-bearing
 * acceptance criteria from plan.md T7:
 *   - decompose_gsd output is validated via enrichTaskGraph (T3 integration)
 *   - validated TaskGraph passed to stratum.stepDone has task 2's description
 *     containing task 1's declared produces (the prompt contract — load-bearing
 *     for v1 since runtime handoff is out of scope) — verified via manual
 *     interpolation matching Stratum's spec.py rules
 *   - post-execute blackboard finalization populates one entry per task,
 *     each validated against contracts/task-result.json
 *   - gateCommands fallback works (default lint/build/test when project
 *     config lacks the field)
 *
 * NOTE: Sequential ordering (max_concurrent: 1) is enforced by Stratum's
 * ParallelExecutor (stratum-mcp/src/stratum_mcp/parallel_exec.py), not by
 * Compose. T5 (test/gsd-pipeline.test.js) asserts the spec declares
 * max_concurrent: 1 — that's the load-bearing assertion. Re-testing
 * Stratum's executor here would duplicate Stratum's own test coverage.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runGsd } = await import(`${REPO_ROOT}/lib/gsd.js`);

const FIXTURE_BLUEPRINT = `# COMP-GSD-2-FIX: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`contracts/foo.json\` | new | Foo contract |
| \`lib/bar.js\` | new | Bar module |
| \`lib/baz.js\` | new | Baz module |

## Boundary Map

### S01: Foo contract

File Plan: \`contracts/foo.json\` (new)

Produces:
  contracts/foo.json → Foo (type)

Consumes: nothing

### S02: Bar implementation

File Plan: \`lib/bar.js\` (new)

Produces:
  lib/bar.js → bar (function)

Consumes:
  from S01: contracts/foo.json → Foo

### S03: Baz implementation

File Plan: \`lib/baz.js\` (new)

Produces:
  lib/baz.js → baz (function)

Consumes:
  from S02: lib/bar.js → bar
`;

const CANNED_TASKGRAPH = {
  tasks: [
    {
      id: 'T01',
      files_owned: ['contracts/foo.json'],
      files_read: [],
      depends_on: [],
      description: '', // empty → triggers description-repair via T4
    },
    {
      id: 'T02',
      files_owned: ['lib/bar.js'],
      files_read: ['contracts/foo.json'],
      depends_on: ['T01'],
      description: '',
    },
    {
      id: 'T03',
      files_owned: ['lib/baz.js'],
      files_read: ['lib/bar.js'],
      depends_on: ['T02'],
      description: '',
    },
  ],
};

let cwd;

before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gsd-golden-'));
  // Initialize as a git repo (runGsd's clean-workspace check requires it).
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name test', { cwd });
  // Initial commit so HEAD exists.
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/locks/\n');
  execSync('git add .gitignore && git commit -q -m initial', { cwd });

  // Scaffold the fixture feature.
  const featureDir = join(cwd, 'docs', 'features', 'COMP-GSD-2-FIX');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
  execSync('git add . && git commit -q -m scaffold', { cwd });
});

after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stub Stratum that captures the TaskGraph passed to stepDone(decompose_gsd)
// and simulates the rest of the flow without invoking real Stratum.
// ---------------------------------------------------------------------------

function makeStubStratum({ resultsDir, captured }) {
  let phase = 'plan'; // 'plan' → 'decompose' → 'execute' → 'ship' → 'done'
  return {
    connect: async () => {},
    disconnect: async () => {},
    plan: async () => {
      phase = 'decompose';
      return {
        status: 'execute_step',
        flow_id: 'F1',
        step_id: 'decompose_gsd',
        step_number: 1, total_steps: 3,
        agent: 'claude',
        intent: 'decompose intent',
        type: 'decompose',
      };
    },
    runAgentText: async (agentType, prompt) => {
      if (phase === 'decompose') {
        // Return the canned TaskGraph as JSON (with empty descriptions —
        // tests T6's repair path via T4 buildTaskDescription).
        return JSON.stringify(CANNED_TASKGRAPH);
      }
      // ship_gsd is handled by executeShipStep — runAgentText shouldn't be
      // called for it. If it is, fail loudly.
      throw new Error(`runAgentText called unexpectedly in phase ${phase}`);
    },
    stepDone: async (flowId, stepId, result) => {
      if (stepId === 'decompose_gsd') {
        captured.decomposeResult = result;
        phase = 'execute';
        return {
          status: 'execute_step',
          flow_id: flowId,
          step_id: 'execute',
          step_number: 2, total_steps: 3,
          type: 'parallel_dispatch',
          tasks: result.tasks.map((t) => ({ id: t.id })),
          isolation: 'worktree',
          capture_diff: true,
        };
      }
      if (stepId === 'execute') {
        phase = 'ship';
        return {
          status: 'execute_step',
          flow_id: flowId,
          step_id: 'ship_gsd',
          step_number: 3, total_steps: 3,
          agent: 'claude::critical',
          intent: 'ship intent',
        };
      }
      if (stepId === 'ship_gsd') {
        phase = 'done';
        return { status: 'complete', flow_id: flowId };
      }
      throw new Error(`unexpected stepDone for ${stepId}`);
    },
    // Parallel dispatch primitives — simulate all 3 tasks landing diffs that
    // write per-task TaskResult files.
    parallelStart: async () => ({ status: 'started' }),
    parallelPoll: async () => {
      const tasks = {};
      for (const t of CANNED_TASKGRAPH.tasks) {
        tasks[t.id] = {
          task_id: t.id, state: 'complete',
          diff: makeTaskDiff(t.id, 'COMP-GSD-2-FIX'),
        };
      }
      return {
        flow_id: 'F1', step_id: 'execute',
        summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
        tasks,
        require_satisfied: true, can_advance: false,
        outcome: { status: 'awaiting_consumer_advance', aggregate: { merge_status: 'clean' } },
      };
    },
    parallelAdvance: async (flowId, stepId, mergeStatus) => {
      captured.parallelMergeStatus = mergeStatus;
      // Return a synthetic next-step envelope; runGsd's loop calls stepDone
      // after parallel_dispatch returns, so this just needs to be a valid
      // execute_step or complete envelope.
      return {
        status: 'execute_step',
        flow_id: flowId,
        step_id: 'ship_gsd',
        step_number: 3, total_steps: 3,
        agent: 'claude::critical',
        intent: 'ship intent',
      };
    },
  };
}

// Construct a unified diff that creates a per-task TaskResult JSON file at
// .compose/gsd/<code>/results/<task_id>.json (the path runGsd's
// collectBlackboard reads after execute step completes).
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
  const lineCount = lines.length;
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runGsd validates decompose_gsd output and repairs descriptions (T3+T4 integration)', async () => {
  const captured = {};
  const stub = makeStubStratum({ captured });

  // Skip the executeShipStep call by simulating ship_gsd → complete via
  // stepDone immediately. Since executeShipStep would actually try to git
  // commit in the temp repo (which works), allow it.
  // Allow opts.allowDirtyWorkspace=false to fire — fixture is clean.
  await runGsd('COMP-GSD-2-FIX', { cwd, stratum: stub });

  // Decompose result captured by the stub on stepDone(decompose_gsd).
  assert.ok(captured.decomposeResult, 'decompose result should be captured');
  const tasks = captured.decomposeResult.tasks;
  assert.equal(tasks.length, 3);

  // Each task's description should have been REPAIRED by buildTaskDescription
  // (canned input had empty descriptions). All five required section markers
  // must be present.
  for (const t of tasks) {
    assert.match(t.description, /Symbols you must produce/, `${t.id} description missing produce section`);
    assert.match(t.description, /Symbols you may consume from upstream tasks/, `${t.id} description missing consume section`);
    assert.match(t.description, /Boundary Map slice/, `${t.id} description missing slice section`);
    assert.match(t.description, /Upstream tasks/, `${t.id} description missing upstream section`);
    assert.match(t.description, /GATES/, `${t.id} description missing GATES section`);
  }

  // Load-bearing prompt-contract check: T02's description must reference T01's
  // declared produces (Foo). T03's description must reference T02's bar.
  const t02 = tasks.find((t) => t.id === 'T02');
  const t03 = tasks.find((t) => t.id === 'T03');
  assert.match(t02.description, /T01.*Foo|Foo.*T01/s, 'T02 description must mention upstream T01 producing Foo');
  assert.match(t03.description, /T02.*bar|bar.*T02/s, 'T03 description must mention upstream T02 producing bar');
  // T01 has no upstream — its Upstream tasks section should render (none).
  const t01 = tasks.find((t) => t.id === 'T01');
  assert.match(t01.description, /Upstream tasks[^]*\(none\)/s, 'T01 has no depends_on; upstream section should be (none)');

  // produces/consumes attached from Boundary Map slices.
  assert.deepEqual(t02.produces, [{ file: 'lib/bar.js', symbols: ['bar'], kind: 'function' }]);
  assert.deepEqual(t02.consumes, [{ from: 'S01', file: 'contracts/foo.json', symbols: ['Foo'] }]);
});

test('runGsd writes blackboard.json with one validated entry per task after execute', () => {
  // The previous test's runGsd() invocation should have written the blackboard.
  const blackboardPath = join(cwd, '.compose', 'gsd', 'COMP-GSD-2-FIX', 'blackboard.json');
  assert.ok(existsSync(blackboardPath), `blackboard should exist at ${blackboardPath}`);
  const bb = JSON.parse(readFileSync(blackboardPath, 'utf-8'));
  const ids = Object.keys(bb).sort();
  assert.deepEqual(ids, ['T01', 'T02', 'T03'], 'blackboard should have entries for all three tasks');
  for (const id of ids) {
    assert.equal(bb[id].status, 'passed');
    assert.equal(bb[id].attempts, 1);
    assert.equal(bb[id].gates[0].status, 'pass');
  }
});

// Mirror of Stratum's parallel_dispatch interpolation rules
// (stratum-mcp/src/stratum_mcp/spec.py:567-590). Used to simulate what each
// task agent's prompt actually looks like during execute step dispatch.
function interpolateIntent(template, task, flowInputs) {
  const listToStr = (v) => Array.isArray(v) ? v.join(', ') : String(v ?? '');
  let out = template
    .replaceAll('{task.id}', String(task.id ?? ''))
    .replaceAll('{task.description}', String(task.description ?? ''))
    .replaceAll('{task.files_owned}', listToStr(task.files_owned))
    .replaceAll('{task.files_read}', listToStr(task.files_read))
    .replaceAll('{task.depends_on}', listToStr(task.depends_on))
    .replaceAll('{task.index}', String(task._index ?? 0));
  for (const [k, v] of Object.entries(flowInputs ?? {})) {
    out = out.replaceAll(`{input.${k}}`, String(v));
  }
  return out;
}

test('execute-step prompt contract: task 2 prompt includes upstream T01 symbols (load-bearing for v1)', async () => {
  // Reuse the captured TaskGraph from the first test. Read the gsd pipeline
  // intent_template, simulate Stratum's interpolation per task, and assert
  // the prompt contract is honored: T02's interpolated intent must contain
  // T01's declared produces (Foo) — since v1 has no runtime handoff, this
  // spec-level prompt is the only way T02 knows what T01 will produce.
  const YAML = await import('yaml');
  const spec = YAML.parse(readFileSync(join(REPO_ROOT, 'pipelines', 'gsd.stratum.yaml'), 'utf-8'));
  const executeStep = spec.flows.gsd.steps.find((s) => s.id === 'execute');
  const template = executeStep.intent_template;

  // Re-run to capture a fresh TaskGraph (the first test's runGsd was invoked
  // against the shared cwd and state may have advanced).
  const captured = {};
  const subCwd = mkdtempSync(join(tmpdir(), 'gsd-prompt-'));
  try {
    execSync('git init -q', { cwd: subCwd });
    execSync('git config user.email test@example.com', { cwd: subCwd });
    execSync('git config user.name test', { cwd: subCwd });
    writeFileSync(join(subCwd, '.gitignore'), '.compose/data/locks/\n');
    execSync('git add .gitignore && git commit -q -m initial', { cwd: subCwd });
    const featureDir = join(subCwd, 'docs', 'features', 'COMP-GSD-2-FIX');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
    execSync('git add . && git commit -q -m scaffold', { cwd: subCwd });

    const stub = makeStubStratum({ captured });
    await runGsd('COMP-GSD-2-FIX', { cwd: subCwd, stratum: stub });

    const tasks = captured.decomposeResult.tasks;
    const flowInputs = { featureCode: 'COMP-GSD-2-FIX' };
    const t02 = tasks.find((t) => t.id === 'T02');
    const t02Intent = interpolateIntent(template, t02, flowInputs);

    // Required substrings — what each task agent's prompt must include for
    // the v1 spec-level handoff to work.
    assert.match(t02Intent, /Foo/, 'T02 prompt must reference upstream T01 symbol Foo');
    assert.match(t02Intent, /T01/, 'T02 prompt must reference upstream task id T01');
    assert.match(t02Intent, /Symbols you must produce/, 'T02 prompt must contain produce section');
    assert.match(t02Intent, /Symbols you may consume from upstream tasks/, 'T02 prompt must contain consume section (load-bearing v1 handoff)');
    assert.match(t02Intent, /Boundary Map slice/, 'T02 prompt must embed slice text');
    assert.match(t02Intent, /Upstream tasks/, 'T02 prompt must contain upstream summary section');
    assert.match(t02Intent, /pnpm test/, 'T02 prompt must list gate commands (default fallback)');
    assert.match(t02Intent, /\.compose\/gsd\/COMP-GSD-2-FIX\/results\/T02\.json/, 'T02 prompt must include the per-task TaskResult path');
  } finally {
    rmSync(subCwd, { recursive: true, force: true });
  }
});

test('runGsd uses default gateCommands when project config lacks the field', async () => {
  // Reuse the existing fixture; this test asserts behavior not file output.
  // The decomposeResult tasks' descriptions should contain the default
  // gate commands (lint/build/test).
  const captured = {};
  const subCwd = mkdtempSync(join(tmpdir(), 'gsd-golden-default-'));
  try {
    execSync('git init -q', { cwd: subCwd });
    execSync('git config user.email test@example.com', { cwd: subCwd });
    execSync('git config user.name test', { cwd: subCwd });
    writeFileSync(join(subCwd, '.gitignore'), '.compose/data/locks/\n');
    execSync('git add .gitignore && git commit -q -m initial', { cwd: subCwd });
    const featureDir = join(subCwd, 'docs', 'features', 'COMP-GSD-2-FIX');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
    execSync('git add . && git commit -q -m scaffold', { cwd: subCwd });

    const stub = makeStubStratum({ captured });
    await runGsd('COMP-GSD-2-FIX', { cwd: subCwd, stratum: stub });

    const t01 = captured.decomposeResult.tasks.find((t) => t.id === 'T01');
    // Defaults from runGsd: pnpm lint, pnpm build, pnpm test
    assert.match(t01.description, /pnpm lint/);
    assert.match(t01.description, /pnpm build/);
    assert.match(t01.description, /pnpm test/);
  } finally {
    rmSync(subCwd, { recursive: true, force: true });
  }
});
