/**
 * gsd-budget-run.test.js — COMP-GSD-4 budget wiring (TS re-expression).
 *
 * Spec source: the pre-deletion test at cc390a7. Its dispatch-path assertions
 * drove a python-era stub (execute_step / parallelPoll); the current runGsd uses
 * the TS ready-loop, so this re-expresses the COMPOSE-SIDE budget wiring that is
 * evaluated before/around plan and needs no dispatch harness:
 *   - no gsd.budget config → the spec handed to plan is byte-identical (identity);
 *   - a configured budget → flows.gsd.budget is injected with the v1 engine keys;
 *   - an over-cap cumulative ledger → runGsd REFUSES before planning.
 *
 * The dispatch-to-budget-terminal + ownership-release assertions require a full
 * TS consumer-fanout harness and are tracked separately.
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
const { recordGsdUsage } = await import(`${REPO_ROOT}/lib/budget-ledger.js`);

const RAW_SPEC = readFileSync(join(REPO_ROOT, 'pipelines', 'gsd.stratum.yaml'), 'utf-8');
const FEATURE = 'COMP-GSD-4-FIX';

const FIXTURE_BLUEPRINT = `# ${FEATURE}: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`lib/bar.js\` | new | Bar module |

## Boundary Map

### S01: Bar

File Plan: \`lib/bar.js\` (new)

Produces:
  lib/bar.js → bar (function)

Consumes: nothing
`;

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

// A TS stub whose plan captures the spec YAML and immediately terminates the run
// (status:'completed') so no dispatch loop is exercised — we only inspect what
// compose handed to plan.
function makeCaptureStub({ captured }) {
  return {
    connect: async () => {}, disconnect: async () => {}, close: async () => {},
    plan: async (specYaml) => { captured.specYaml = specYaml; return { status: 'completed', runId: 'F1' }; },
    resume: async () => ({ status: 'completed', runId: 'F1' }),
    stepDone: async () => ({ status: 'completed', runId: 'F1' }),
    audit: async () => ({}),
    runAgentText: async () => '',
    onEvent: () => () => {},
  };
}

describe('runGsd budget wiring (COMP-GSD-4) — compose-side', () => {
  test('no gsd.budget config → the spec handed to plan is byte-identical', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    try {
      await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeCaptureStub({ captured }) });
      assert.equal(captured.specYaml, RAW_SPEC, 'spec must be byte-identical when unbudgeted');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a configured budget injects flows.gsd.budget with the v1 engine keys', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    writeBudgetConfig(cwd, { max_tokens: 1000, per_run_ms: 600000 });
    try {
      await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeCaptureStub({ captured }) });
      assert.notEqual(captured.specYaml, RAW_SPEC, 'the spec must change when a budget is configured');
      const parsed = YAML.parse(captured.specYaml);
      assert.deepEqual(parsed.flows.gsd.budget, { tokens: 1000, ms: 600000 },
        'v1 flow budget uses the engine keys (tokens/ms), not the python gsd.budget.* keys');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('an over-cap cumulative ledger refuses before planning', async () => {
    const cwd = scaffoldRepo();
    const captured = {};
    writeBudgetConfig(cwd, { cumulative: { max_total_tokens: 1000 } });
    recordGsdUsage(join(cwd, '.compose'), FEATURE, { tokens: 5000 });
    try {
      const result = await runGsd(FEATURE, { cwd, allowDirtyWorkspace: true, stratum: makeCaptureStub({ captured }) });
      assert.equal(result.status, 'budget');
      assert.equal(result.axis, 'cumulative');
      assert.equal(captured.specYaml, undefined, 'plan must NOT be called when the cumulative ceiling is spent');
      assert.ok(existsSync(join(cwd, '.compose', 'gsd', FEATURE, 'budget.md')), 'a refusal diagnostic is written');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
