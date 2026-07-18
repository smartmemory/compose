/**
 * gsd-budget-terminal-golden.test.js — real-path re-expression of the GSD
 * budget dispatch terminal, deferred by gsd-budget-run.test.js ("The
 * dispatch-to-budget-terminal + ownership-release assertions require a full TS
 * consumer-fanout harness and are tracked separately").
 *
 * gsd-budget-run.test.js covers the COMPOSE-SIDE budget wiring evaluated
 * before/around plan (identity injection, key injection, cumulative pre-refusal).
 * This drives the REAL runGsd over the live TS bin via runGsdWithAgentFactory so
 * the STRATUM FLOW BUDGET actually trips mid-dispatch:
 *   - `gsd.budget.max_agent_dispatches` injects `dispatches` into the flow budget;
 *     the engine debits {dispatches:1} per step/fanout-item dispatch. With a cap of
 *     2 (decompose = 1, execute T01 = 2), dispatching T02 exceeds it → the engine
 *     returns `budget_exhausted`.
 *   - runGsd normalizes that to status:'budget', writes budget.json/budget.md +
 *     a kind:'budget' pause.json (schema-valid), records cumulative usage, and
 *     releases its resume claim (no pause.lock strand).
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
const { runGsd } = await import(`${REPO_ROOT}/lib/gsd.js`);
const { runGsdWithAgentFactory } = await import(`${REPO_ROOT}/test/helpers/ts-agent-harness.js`);
const { checkGsdCumulativeBudget } = await import(`${REPO_ROOT}/lib/budget-ledger.js`);
const Ajv = (await import('ajv')).default;

function compilePause() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'gsd-stuck.json'), 'utf-8'));
  ajv.addSchema(schema, 'gsd-stuck.json');
  return ajv.compile({ $ref: 'gsd-stuck.json#/definitions/pause' });
}

const FEATURE = 'COMP-GSD-4-FIX';

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

const TASKGRAPH = {
  tasks: [
    { id: 'T01', files_owned: ['lib/bar.js'], files_read: [], depends_on: [], description: 'bar' },
    { id: 'T02', files_owned: ['lib/baz.js'], files_read: ['lib/bar.js'], depends_on: ['T01'], description: 'baz' },
  ],
};

function scaffoldRepo(budget) {
  const cwd = mkdtempSync(join(tmpdir(), 'gsd-budget-terminal-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name test', { cwd });
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(
    join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true }, gsd: { budget } }, null, 2),
  );
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/locks/\n');
  const featureDir = join(cwd, 'docs', 'features', FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
  execSync('git add . && git commit -q -m scaffold', { cwd });
  return cwd;
}

function taskResultBody(taskId, ownedFile) {
  return JSON.stringify({
    status: 'passed', files_changed: [ownedFile], summary: `${taskId} done`,
    produces: { [taskId.toLowerCase()]: 'function' },
    gates: [{ command: 'pnpm test', status: 'pass', output: '' }], attempts: 1,
  }, null, 2);
}

// Every execute item writes its owned file + TaskResult and reports token usage
// (so the cumulative ledger is debited). No item gets stuck; the flow budget is
// what halts the run.
function budgetAgentFactory(seen) {
  const owner = { T01: 'lib/bar.js', T02: 'lib/baz.js' };
  return function factory(_agent, { cwd }) {
    return {
      async *run(prompt) {
        if (/Decompose it into independent tasks/i.test(prompt)) {
          yield { type: 'assistant', content: JSON.stringify(TASKGRAPH) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
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
        yield { type: 'usage', input_tokens: 40, output_tokens: 10, cost_usd: 0.03, model: 'claude-test' };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

describe('runGsd budget terminal (real TS engine)', () => {
  test('a max_agent_dispatches cap trips mid-fanout → status:budget + budget/pause artifacts + released claim', async () => {
    // The engine debits {dispatches:1} per dispatch: decompose=1, execute T01=2,
    // execute T02=3, ship=4. Cap = 2 lets decompose + T01 dispatch; reserving
    // T02 (dispatch 3) exceeds it → budget_exhausted DURING the execute fanout.
    // T01's agent RAN, but a worktree item's diff is applied only at execute_merge
    // (after the whole fanout), which the halt never reaches — so T01's work did
    // not durably land and correctly re-dispatches on resume (no lost/duplicate
    // merge). Hence completedTaskIds=[] and both tasks remain.
    const cwd = scaffoldRepo({ max_agent_dispatches: 2 });
    try {
      const seen = { executed: [] };
      const result = await runGsdWithAgentFactory(runGsd, FEATURE, {
        cwd,
        connectorFactory: budgetAgentFactory(seen),
        gateCommands: ['true'],
        preMergeGate: ['true'],
      });

      assert.equal(result.status, 'budget', 'runGsd returns status:budget on the flow-budget terminal');
      assert.equal(result.axis, 'max_agent_dispatches', 'the dispatch axis is the one that tripped');
      // T01's agent ran before the cap was hit; T02 was never dispatched.
      assert.deepEqual([...new Set(seen.executed)], ['T01'], 'only T01 was dispatched before the budget tripped');

      const gsdDir = join(cwd, '.compose', 'gsd', FEATURE);
      assert.ok(existsSync(join(gsdDir, 'budget.json')), 'budget.json written');
      assert.ok(existsSync(join(gsdDir, 'budget.md')), 'budget.md written');
      assert.ok(existsSync(join(gsdDir, 'pause.json')), 'pause.json written');

      const budgetJson = JSON.parse(readFileSync(join(gsdDir, 'budget.json'), 'utf-8'));
      assert.equal(budgetJson.kind, 'budget');
      assert.equal(budgetJson.feature, FEATURE);
      assert.equal(budgetJson.axis, 'max_agent_dispatches');
      assert.equal(budgetJson.caps.max_agent_dispatches, 2, 'the cap is echoed in the diagnostic');
      assert.equal(budgetJson.consumed.dispatches, 2, 'two dispatches (decompose + T01) were spent at the halt');
      // T01 ran in an ephemeral worktree; its diff never merged, so it re-runs.
      assert.deepEqual(budgetJson.remainingTaskIds, ['T01', 'T02'], 'unmerged T01 + never-dispatched T02 both remain');

      const pauseJson = JSON.parse(readFileSync(join(gsdDir, 'pause.json'), 'utf-8'));
      assert.ok(compilePause()(pauseJson), 'budget pause.json must be schema-valid (kind:budget requires a budget block)');
      assert.equal(pauseJson.kind, 'budget');
      assert.equal(pauseJson.mode, 'gsd');
      assert.equal(pauseJson.pid, process.pid);
      assert.deepEqual(pauseJson.completedTaskIds, [], 'nothing durably completed at a mid-fanout halt');
      assert.deepEqual(
        pauseJson.decomposedTasks.map((t) => t.id).sort(), ['T01', 'T02'],
        'the full task list is persisted for --resume',
      );
      assert.equal(pauseJson.budget.axis, 'max_agent_dispatches', 'pause carries the budget block with the tripped axis');

      // Ownership release: the resume claim is released on EVERY exit (finally),
      // so a budget halt must NOT strand pause.lock.
      assert.equal(existsSync(join(gsdDir, 'pause.lock')), false, 'no pause.lock stranded after the budget halt');

      // Cumulative usage was recorded for the dispatched item (T01's tokens).
      const usage = checkGsdCumulativeBudget(join(cwd, '.compose'), FEATURE, {}).usage;
      assert.ok(usage.totalTokens >= 50, `cumulative ledger debited the dispatched item's tokens, got ${usage.totalTokens}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
