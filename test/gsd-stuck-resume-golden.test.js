/**
 * gsd-stuck-resume-golden.test.js — real-path re-expression of the deleted
 * test/gsd-resume.test.js (spec at cc390a7), which drove the RETIRED python
 * dispatch protocol (parallelStart/parallelPoll/parallelAdvance + execute_step
 * envelopes) through a hand-rolled stub. Those stubs no longer exercise anything
 * the shipped runGsd runs.
 *
 * This drives the REAL runGsd over the live TS bin via runGsdWithAgentFactory.
 * The stuck detector, the consumer fanout, the halt-artifact writers, and the
 * --resume guards/re-dispatch all run for real; only agent inference is faked:
 *
 * COVERAGE BOUNDARY (honest): this proves the detector→verdict→artifact plumbing
 * over the real engine — the same-file loop trips the REAL GsdStuckDetector and the
 * REAL halt writers produce the diagnostics (directly catching the pre-fix
 * `execute:0` task-id bug). It does NOT prove in-flight interruption of a genuinely
 * runaway agent: GSD execute items use worktree isolation → the sync engine
 * `agent_run` seam cannot be aborted mid-stream (documented at
 * result-normalizer.js `useLocalClaude`/stratum-mcp-client.js `cancelAgentRun`), so
 * the stuck verdict lands only once the (finite) fake agent returns and abortReason
 * is checked. Interrupting a spinning workspace-write agent needs a stratum
 * follow-up (background write mode) — tracked as stratum issue #18.
 *   - Scenario 1 (stuck halt): the execute agent for the first task emits
 *     repeated same-file Edit tool events. The REAL GsdStuckDetector (default
 *     sameFileEdits=3) trips, aborts the in-flight item, and runGsd writes
 *     schema-valid stuck.json + stuck.md + pause.json and returns status:'stuck'.
 *   - Scenario 2 (resume): a seeded pause.json (dead pid) + a completed T01 in
 *     the blackboard drive `--resume`, which must NOT re-decompose, re-dispatch
 *     only the unfinished T02, complete, and delete pause.json.
 *   - Scenario 3 (resume guards): live pid, mode mismatch, missing pause.json,
 *     and a held claim (pause.lock) each refuse.
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
const { runGsdWithAgentFactory } = await import(`${REPO_ROOT}/test/helpers/ts-agent-harness.js`);
const Ajv = (await import('ajv')).default;

// --- schema (validate the emitted stuck.json / pause.json) -------------------
function compileDef(defName) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'gsd-stuck.json'), 'utf-8'));
  ajv.addSchema(schema, 'gsd-stuck.json');
  return ajv.compile({ $ref: `gsd-stuck.json#/definitions/${defName}` });
}

const FEATURE = 'COMP-GSD-5-FIX';

const FIXTURE_BLUEPRINT = `# ${FEATURE}: Blueprint

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

// T01 owns lib/bar.js and has no deps → it dispatches first (concurrency:1).
// T02 owns lib/baz.js and depends on T01 → it is never reached once T01 sticks.
const TASKGRAPH = {
  tasks: [
    { id: 'T01', files_owned: ['lib/bar.js'], files_read: [], depends_on: [], description: 'bar' },
    { id: 'T02', files_owned: ['lib/baz.js'], files_read: ['lib/bar.js'], depends_on: ['T01'], description: 'baz' },
  ],
};

function scaffoldRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'gsd-stuck-resume-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name test', { cwd });
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(
    join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } }, null, 2),
  );
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/locks/\n');
  const featureDir = join(cwd, 'docs', 'features', FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
  execSync('git add . && git commit -q -m scaffold', { cwd });
  return cwd;
}

// A valid TaskResult JSON body (blackboard-parseable). Written by the resume
// execute agent for the re-dispatched task so runGsd sees it complete.
function taskResultBody(taskId, ownedFile) {
  return JSON.stringify({
    status: 'passed',
    files_changed: [ownedFile],
    summary: `${taskId} done`,
    produces: { [taskId.toLowerCase()]: 'function' },
    gates: [{ command: 'pnpm test', status: 'pass', output: '' }],
    attempts: 1,
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Scenario 1 — stuck halt writes real artifacts.
//
// decompose returns the two tasks; the first execute item emits 4 same-file
// Edit tool events, tripping the REAL detector (default threshold 3). The item
// never completes → runGsd halts and writes stuck.md/json + pause.json.
// ---------------------------------------------------------------------------
function stuckAgentFactory(seen) {
  return function factory(_agent, { cwd }) {
    return {
      async *run(prompt) {
        if (/Decompose it into independent tasks/i.test(prompt)) {
          yield { type: 'assistant', content: JSON.stringify(TASKGRAPH) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
        }
        // Execute item. Get stuck on the same file: 4 Edit events > threshold 3.
        const taskId = prompt.match(/results\/(T\d+)\.json/)?.[1] ?? 'T?';
        seen.executed.push(taskId);
        for (let i = 0; i < 4; i++) {
          yield { type: 'tool_use', tool: 'Edit', input: { file_path: 'lib/bar.js' } };
        }
        // The detector has tripped by now; the abort short-circuits this result.
        yield { type: 'assistant', content: JSON.stringify({ outcome: 'complete', summary: 'never accepted' }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

describe('runGsd stuck halt (real TS engine)', () => {
  test('a same-file edit loop trips the real detector → status:stuck + schema-valid artifacts', async () => {
    const cwd = scaffoldRepo();
    try {
      const seen = { executed: [] };
      const result = await runGsdWithAgentFactory(runGsd, FEATURE, {
        cwd,
        connectorFactory: stuckAgentFactory(seen),
        gateCommands: ['true'],
        preMergeGate: ['true'],
      });

      assert.equal(result.status, 'stuck', 'runGsd returns status:stuck');
      assert.equal(result.signal, 'same_file', 'the reported signal is same_file');
      assert.equal(result.stuckTaskId, 'T01', 'the first task (T01) is the one that stuck');
      // T02 depends on T01, which never completed → it was never dispatched.
      assert.deepEqual([...new Set(seen.executed)], ['T01'], 'only T01 was executed before the halt');

      const gsdDir = join(cwd, '.compose', 'gsd', FEATURE);
      assert.ok(existsSync(join(gsdDir, 'stuck.md')), 'stuck.md written');
      assert.ok(existsSync(join(gsdDir, 'stuck.json')), 'stuck.json written');
      assert.ok(existsSync(join(gsdDir, 'pause.json')), 'pause.json written');

      const stuckJson = JSON.parse(readFileSync(join(gsdDir, 'stuck.json'), 'utf-8'));
      assert.ok(compileDef('stuck')(stuckJson), 'stuck.json must be schema-valid');
      assert.equal(stuckJson.signal, 'same_file');
      assert.equal(stuckJson.taskId, 'T01');
      assert.equal(stuckJson.feature, FEATURE);

      const pauseJson = JSON.parse(readFileSync(join(gsdDir, 'pause.json'), 'utf-8'));
      assert.ok(compileDef('pause')(pauseJson), 'pause.json must be schema-valid');
      assert.equal(pauseJson.mode, 'gsd');
      assert.equal(pauseJson.stuckTaskId, 'T01');
      assert.equal(pauseJson.pid, process.pid, 'pause records the owning pid');
      assert.deepEqual(
        pauseJson.decomposedTasks.map((t) => t.id).sort(), ['T01', 'T02'],
        'the full task list is persisted for --resume',
      );
      assert.deepEqual(pauseJson.completedTaskIds, [], 'nothing completed (T01 stuck, T02 never ran)');

      const md = readFileSync(join(gsdDir, 'stuck.md'), 'utf-8');
      assert.match(md, /same_file/);
      assert.match(md, /--resume/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — resume re-dispatches only the unfinished task.
//
// The resume execute agent writes T02's owned file + a valid TaskResult and
// completes. decompose MUST NOT be called (resume uses the persisted graph).
// ---------------------------------------------------------------------------
function resumeAgentFactory(seen) {
  const owner = { T02: 'lib/baz.js' };
  return function factory(_agent, { cwd }) {
    return {
      async *run(prompt) {
        if (/Decompose it into independent tasks/i.test(prompt)) {
          seen.decomposed = true;
          throw new Error('resume must not re-decompose');
        }
        const taskId = prompt.match(/results\/(T\d+)\.json/)?.[1];
        assert.ok(taskId, `execute prompt must carry the exact TaskResult path: ${prompt.slice(0, 300)}`);
        seen.executed.push(taskId);
        const ownedFile = owner[taskId] ?? `lib/${taskId.toLowerCase()}.js`;
        mkdirSync(dirname(join(cwd, ownedFile)), { recursive: true });
        writeFileSync(join(cwd, ownedFile), `// ${taskId}\n`);
        const resultRel = `.compose/gsd/${FEATURE}/results/${taskId}.json`;
        mkdirSync(dirname(join(cwd, resultRel)), { recursive: true });
        writeFileSync(join(cwd, resultRel), taskResultBody(taskId, ownedFile));
        yield { type: 'assistant', content: JSON.stringify({ outcome: 'complete', summary: `${taskId} done`, files_changed: [ownedFile, resultRel] }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function seedPauseAndBlackboard(cwd, pauseOverrides = {}) {
  const gsdDir = join(cwd, '.compose', 'gsd', FEATURE);
  mkdirSync(join(gsdDir, 'results'), { recursive: true });
  // T01 already completed: seed its result so the blackboard recognizes it.
  writeFileSync(join(gsdDir, 'results', 'T01.json'), taskResultBody('T01', 'lib/bar.js'));
  const pause = {
    flowId: 'F1', stepId: 'execute', stuckTaskId: 'T02',
    signal: 'same_file', detail: 'lib/baz.js edited 3 times',
    decomposedTasks: TASKGRAPH.tasks,
    completedTaskIds: ['T01'],
    pid: 999999999, // a dead pid → passes the ownership guard
    mode: 'gsd',
    ts: new Date().toISOString(),
    ...pauseOverrides,
  };
  writeFileSync(join(gsdDir, 'pause.json'), JSON.stringify(pause, null, 2));
}

describe('runGsd --resume (real TS engine)', () => {
  test('skips completed T01 and re-dispatches only T02, then clears pause.json', async () => {
    const cwd = scaffoldRepo();
    try {
      seedPauseAndBlackboard(cwd);
      const seen = { executed: [], decomposed: false };
      const result = await runGsdWithAgentFactory(runGsd, FEATURE, {
        cwd,
        resume: true,
        connectorFactory: resumeAgentFactory(seen),
        gateCommands: ['true'],
        preMergeGate: ['true'],
      });

      assert.equal(seen.decomposed, false, 'resume must NOT re-decompose via the agent');
      assert.deepEqual(seen.executed, ['T02'], 'only T02 (not the completed T01) is re-dispatched');
      assert.equal(result.status, 'complete', 'a clean resume completes the flow');

      const pausePath = join(cwd, '.compose', 'gsd', FEATURE, 'pause.json');
      assert.equal(existsSync(pausePath), false, 'pause.json is deleted after a clean resume');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses to resume when the recorded pid is still alive', async () => {
    const cwd = scaffoldRepo();
    try {
      seedPauseAndBlackboard(cwd, { pid: process.pid }); // us — definitely alive
      await assert.rejects(
        () => runGsd(FEATURE, { cwd, resume: true }),
        /live|already|owns|running/i,
        'resume must refuse when another live pid owns the pause',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses to resume when the pause mode mismatches', async () => {
    const cwd = scaffoldRepo();
    try {
      seedPauseAndBlackboard(cwd, { mode: 'bug' });
      await assert.rejects(
        () => runGsd(FEATURE, { cwd, resume: true }),
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
        () => runGsd(FEATURE, { cwd, resume: true }),
        /no .*pause|nothing to resume|pause\.json/i,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a second --resume refuses while a claim is held (race-safe ownership)', () => {
    const cwd = scaffoldRepo();
    try {
      seedPauseAndBlackboard(cwd); // dead pid → passes the pid guard, reaches the claim
      const first = loadResumeTaskGraph(cwd, FEATURE); // claims via atomic mkdir of pause.lock
      assert.deepEqual(first.tasks.map((t) => t.id), ['T02'], 'first claim returns the remaining tasks');
      assert.ok(
        existsSync(join(cwd, '.compose', 'gsd', FEATURE, 'pause.lock')),
        'claim dir created',
      );
      assert.throws(
        () => loadResumeTaskGraph(cwd, FEATURE),
        /claim already exists|pause\.lock|owns/i,
        'a concurrent second resume must refuse while the claim is held',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
