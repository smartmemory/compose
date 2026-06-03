/**
 * gsd-budget-run.test.js — COMP-GSD-4 runGsd integration (stubbed Stratum).
 *
 * Run: node --test test/gsd-budget-run.test.js 2>&1 | tail -30
 *
 * Scenarios:
 *   1. Byte-identical: no gsd.budget config → the spec handed to stratum.plan is
 *      the raw gsd.stratum.yaml (injectBudget identity).
 *   2. Budget injected: gsd.budget config → flows.gsd.budget is set in the spec.
 *   3. Budget terminal: the execute poll returns budget_exhausted (+budget_state)
 *      → runGsd writes budget.{md,json} + pause.json(kind:budget), returns
 *      {status:'budget'}, and releases pause.lock (no strand).
 *   4. Cumulative refusal: ledger already over the cap → runGsd refuses BEFORE
 *      planning, returns {status:'budget',axis:'cumulative'}, writes budget.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runGsd } = await import(`${REPO_ROOT}/lib/gsd.js`);
const { recordGsdUsage, readLedger } = await import(`${REPO_ROOT}/lib/budget-ledger.js`);
const RAW_SPEC = readFileSync(join(REPO_ROOT, 'pipelines', 'gsd.stratum.yaml'), 'utf-8');

const FIXTURE_BLUEPRINT = `# ${'COMP-GSD-4-FIX'}: Blueprint

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

const FEATURE = 'COMP-GSD-4-FIX';

function scaffoldRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'gsd-budget-run-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name test', { cwd });
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/locks/\n');
  execSync('git add .gitignore && git commit -q -m initial', { cwd });
  const featureDir = join(cwd, 'docs', 'features', FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
  execSync('git add . && git commit -q -m scaffold', { cwd });
  return cwd;
}

function writeBudgetConfig(cwd, budget) {
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ gsd: { budget } }, null, 2));
}

const BUDGET_STATE = {
  caps: { max_tokens: 1000 },
  consumed: { tokens: 1001, dispatches: 2, wall_s: 30, dollars: 0.0 },
};

// Stub: plan → decompose → execute; the execute poll returns budget_exhausted.
function makeBudgetStub({ captured }) {
  let phase = 'plan';
  return {
    connect: async () => {}, disconnect: async () => {},
    plan: async (specYaml) => {
      captured.specYaml = specYaml;
      phase = 'decompose';
      return { status: 'execute_step', flow_id: 'F1', step_id: 'decompose_gsd', step_number: 1, total_steps: 3, agent: 'claude', intent: 'd', type: 'decompose' };
    },
    runAgentText: async () => JSON.stringify(TASKGRAPH),
    stepDone: async (flowId, stepId, result) => {
      if (stepId === 'decompose_gsd') {
        phase = 'execute';
        return { status: 'execute_step', flow_id: flowId, step_id: 'execute', step_number: 2, total_steps: 3, type: 'parallel_dispatch', tasks: result.tasks.map((t) => ({ id: t.id })), isolation: 'worktree', capture_diff: true };
      }
      throw new Error(`unexpected stepDone ${stepId}`);
    },
    parallelStart: async () => ({ status: 'started' }),
    onEvent: () => () => {},
    parallelPoll: async () => ({
      flow_id: 'F1', step_id: 'execute',
      summary: { pending: 0, running: 0, complete: 0, failed: 0, cancelled: 2 },
      tasks: { T01: { task_id: 'T01', state: 'cancelled' }, T02: { task_id: 'T02', state: 'cancelled' } },
      outcome: { status: 'budget_exhausted', flow_id: 'F1', step_id: 'execute', budget_state: BUDGET_STATE },
    }),
    parallelAdvance: async () => { throw new Error('should not advance on budget_exhausted'); },
  };
}

describe('runGsd budget wiring (COMP-GSD-4)', () => {
  test('byte-identical: no gsd.budget config → raw spec handed to plan', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    try {
      await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeBudgetStub({ captured }) });
      assert.equal(captured.specYaml, RAW_SPEC, 'spec must be byte-identical when unbudgeted');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('budget injected: flows.gsd.budget set when configured', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    writeBudgetConfig(cwd, { max_tokens: 1000, per_run_ms: 600000 });
    try {
      await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeBudgetStub({ captured }) });
      assert.notEqual(captured.specYaml, RAW_SPEC);
      const parsed = YAML.parse(captured.specYaml);
      assert.deepEqual(parsed.flows.gsd.budget, { max_tokens: 1000, ms: 600000 });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('budget terminal: writes diagnostics + pause(kind:budget), returns status budget, releases lock', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    writeBudgetConfig(cwd, { max_tokens: 1000 });
    try {
      const result = await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeBudgetStub({ captured }) });
      assert.equal(result.status, 'budget');
      assert.equal(result.axis, 'max_tokens');
      const gdir = join(cwd, '.compose', 'gsd', FEATURE);
      assert.ok(existsSync(join(gdir, 'budget.json')), 'budget.json written');
      assert.ok(existsSync(join(gdir, 'budget.md')), 'budget.md written');
      const pause = JSON.parse(readFileSync(join(gdir, 'pause.json'), 'utf-8'));
      assert.equal(pause.kind, 'budget');
      assert.equal(pause.budget.axis, 'max_tokens');
      assert.equal(pause.mode, 'gsd');
      assert.ok(!existsSync(join(gdir, 'pause.lock')), 'pause.lock must be released, not stranded');
      // cumulative ledger recorded the consumed usage
      const feat = readLedger(join(cwd, '.compose')).features[FEATURE];
      assert.equal(feat.totalTokens, 1001);
      // COMP-GSD-7-EVENTLOG: the real runGsd path emitted lifecycle events.
      const events = readFileSync(join(gdir, 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes('run_started'), 'run_started emitted');
      assert.ok(kinds.includes('phase'), 'phase emitted');
      const paused = events.find((e) => e.kind === 'paused');
      assert.ok(paused && paused.pauseKind === 'budget', 'paused(budget) emitted with pauseKind (not clobbered)');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('ownership-aware release: a NON-resume run must NOT delete a concurrent claim', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    writeBudgetConfig(cwd, { max_tokens: 1000 });
    // Simulate another process's live resume claim on this feature.
    const gdir = join(cwd, '.compose', 'gsd', FEATURE);
    mkdirSync(join(gdir, 'pause.lock'), { recursive: true });
    try {
      // This run does NOT pass resume:true, so it never claims the lock — and
      // must not release someone else's on its (budget-terminal) exit.
      const result = await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeBudgetStub({ captured }) });
      assert.equal(result.status, 'budget');
      assert.ok(existsSync(join(gdir, 'pause.lock')), 'a non-resume run must NOT delete a concurrent resume claim');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('cumulative refusal: over-cap ledger → refuse before planning', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    writeBudgetConfig(cwd, { cumulative: { max_total_tokens: 1000 } });
    recordGsdUsage(join(cwd, '.compose'), FEATURE, { tokens: 5000 });
    try {
      const result = await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeBudgetStub({ captured }) });
      assert.equal(result.status, 'budget');
      assert.equal(result.axis, 'cumulative');
      assert.equal(captured.specYaml, undefined, 'plan must NOT be called when cumulative ceiling is spent');
      assert.ok(existsSync(join(cwd, '.compose', 'gsd', FEATURE, 'budget.md')), 'refusal diagnostic written');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
