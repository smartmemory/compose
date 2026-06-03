// test/gsd-report-wiring.test.js
//
// COMP-GSD-7 S4: completion-side wiring. writeBudgetFinalSnapshot persists the
// clean-complete budget snapshot the milestone report reads (a clean complete
// writes no budget.json — only halts do), and the report assembler joins it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE = 'COMP-GSD-7';

let gsd, report;
let cwd;

const BUDGET_STATE = {
  caps: { max_tokens: 100000, usd: 5 },
  consumed: { tokens: 42000, dispatches: 4, wall_s: 100, dollars: 1.23 },
};

describe('gsd report wiring (S4)', () => {
  beforeEach(async () => {
    gsd = await import(`${REPO_ROOT}/lib/gsd.js`);
    report = await import(`${REPO_ROOT}/lib/gsd-milestone-report.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-report-wiring-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test('writeBudgetFinalSnapshot writes budget-final.json with caps+consumed', () => {
    const ctx = { cwd, featureCode: FEATURE, runState: { decomposedTasks: [{ id: 'T01' }, { id: 'T02' }] } };
    gsd.writeBudgetFinalSnapshot(ctx, BUDGET_STATE);

    const p = join(cwd, '.compose', 'gsd', FEATURE, 'budget-final.json');
    assert.ok(existsSync(p), 'budget-final.json written');
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    assert.deepEqual(j.caps, BUDGET_STATE.caps);
    assert.deepEqual(j.consumed, BUDGET_STATE.consumed);
    assert.equal(j.feature, FEATURE);
  });

  test('budget-final.json is distinct from the halt artifact budget.json', () => {
    const ctx = { cwd, featureCode: FEATURE, runState: { decomposedTasks: [] } };
    gsd.writeBudgetFinalSnapshot(ctx, BUDGET_STATE);
    assert.ok(existsSync(join(cwd, '.compose', 'gsd', FEATURE, 'budget-final.json')));
    assert.ok(!existsSync(join(cwd, '.compose', 'gsd', FEATURE, 'budget.json')),
      'must not write the halt artifact on a clean complete');
  });

  test('writeBudgetFinalSnapshot leaves no .tmp behind (atomic)', () => {
    const ctx = { cwd, featureCode: FEATURE, runState: { decomposedTasks: [] } };
    gsd.writeBudgetFinalSnapshot(ctx, BUDGET_STATE);
    assert.ok(!existsSync(join(cwd, '.compose', 'gsd', FEATURE, 'budget-final.json.tmp')));
  });

  test('the report assembler then reads budget-final.json as configured budget', async () => {
    // Seed a minimal completed run + the snapshot, then assemble.
    const { writeGsdState } = await import(`${REPO_ROOT}/lib/gsd-state.js`);
    writeGsdState(cwd, FEATURE, {
      feature: FEATURE, status: 'complete', phase: 'done',
      startedAt: '2026-06-03T00:00:00.000Z', completedAt: '2026-06-03T00:00:50.000Z',
      decomposedTasks: [], completedTaskIds: [],
    });
    gsd.writeBudgetFinalSnapshot({ cwd, featureCode: FEATURE, runState: { decomposedTasks: [] } }, BUDGET_STATE);

    const model = report.assembleReportModel(FEATURE, cwd);
    assert.equal(model.budget.configured, true);
    assert.equal(model.budget.caps.max_tokens, 100000);
    assert.equal(model.budget.consumed.tokens, 42000);
  });
});
