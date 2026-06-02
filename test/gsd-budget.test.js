/**
 * gsd-budget.test.js — COMP-GSD-4 unit tests.
 *
 * Run: node --test test/gsd-budget.test.js 2>&1 | tail -30
 *
 * Coverage:
 *   gsd-budget.js:  injectBudget identity (byte-identical), block + task_timeout
 *                   injection, buildBudgetBlock mapping, trippedAxis,
 *                   composeBudgetDiagnostic shape.
 *   budget-ledger.js (gsd): recordGsdUsage extend + back-compat,
 *                   checkGsdCumulativeBudget (tokens & cost), resetGsdUsage.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  readGsdBudgetConfig, buildBudgetBlock, injectBudget, trippedAxis, composeBudgetDiagnostic,
} = await import(`${REPO_ROOT}/lib/gsd-budget.js`);
const {
  recordGsdUsage, checkGsdCumulativeBudget, resetGsdUsage, readLedger, recordIteration,
} = await import(`${REPO_ROOT}/lib/budget-ledger.js`);

const GSD_SPEC = readFileSync(join(REPO_ROOT, 'pipelines', 'gsd.stratum.yaml'), 'utf-8');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'gsd-budget-'));
}
function writeConfig(cwd, obj) {
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify(obj, null, 2));
}

// ─────────────────────────────────────────────────────────────── gsd-budget ──

describe('readGsdBudgetConfig', () => {
  test('returns {} when no config file', () => {
    const cwd = tmp();
    try { assert.deepEqual(readGsdBudgetConfig(cwd), {}); } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test('returns {} when gsd.budget absent', () => {
    const cwd = tmp();
    try { writeConfig(cwd, { gsd: { stuck: { same_file_edits: 3 } } }); assert.deepEqual(readGsdBudgetConfig(cwd), {}); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test('reads gsd.budget when present', () => {
    const cwd = tmp();
    try { writeConfig(cwd, { gsd: { budget: { max_tokens: 500000 } } }); assert.deepEqual(readGsdBudgetConfig(cwd), { max_tokens: 500000 }); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe('buildBudgetBlock', () => {
  test('empty config → no budget, no taskTimeout', () => {
    assert.deepEqual(buildBudgetBlock({}), {});
  });
  test('maps snake_case axes incl. per_run_ms→ms and usd', () => {
    const out = buildBudgetBlock({ max_tokens: 100, max_agent_dispatches: 5, usd: 2.5, per_run_ms: 600000 });
    assert.deepEqual(out.budget, { max_tokens: 100, max_agent_dispatches: 5, usd: 2.5, ms: 600000 });
  });
  test('ms alias works', () => {
    assert.deepEqual(buildBudgetBlock({ ms: 1000 }).budget, { ms: 1000 });
  });
  test('per_task_ms → taskTimeoutSec in seconds, floored at 1', () => {
    assert.equal(buildBudgetBlock({ per_task_ms: 90000 }).taskTimeoutSec, 90);
    assert.equal(buildBudgetBlock({ per_task_ms: 500 }).taskTimeoutSec, 1);
  });
  test('cumulative maps to camelCase', () => {
    assert.deepEqual(buildBudgetBlock({ cumulative: { max_total_tokens: 9, max_total_cost_usd: 1.5 } }).cumulative,
      { maxTotalTokens: 9, maxTotalCostUsd: 1.5 });
  });
});

describe('injectBudget', () => {
  test('IDENTITY when nothing configured (byte-identical guarantee)', () => {
    assert.equal(injectBudget(GSD_SPEC, {}), GSD_SPEC);
    assert.equal(injectBudget(GSD_SPEC, { cumulative: { max_total_tokens: 9 } }), GSD_SPEC); // cumulative-only is compose-side, not a flow block
  });
  test('injects flow budget block when axes configured', () => {
    const out = injectBudget(GSD_SPEC, { max_tokens: 500000, per_run_ms: 600000 });
    assert.notEqual(out, GSD_SPEC);
    const parsed = YAML.parse(out);
    assert.deepEqual(parsed.flows.gsd.budget, { max_tokens: 500000, ms: 600000 });
  });
  test('injects task_timeout (seconds) on the execute step when per_task_ms set', () => {
    const out = injectBudget(GSD_SPEC, { per_task_ms: 120000 });
    const parsed = YAML.parse(out);
    const execute = parsed.flows.gsd.steps.find((s) => s.id === 'execute');
    assert.equal(execute.task_timeout, 120);
  });
});

describe('trippedAxis', () => {
  test('detects the over-cap axis in precedence order', () => {
    assert.equal(trippedAxis({ caps: { max_tokens: 100 }, consumed: { tokens: 100 } }), 'max_tokens');
    assert.equal(trippedAxis({ caps: { ms: 1000 }, consumed: { wall_s: 1 } }), 'ms');
    assert.equal(trippedAxis({ caps: { usd: 2 }, consumed: { dollars: 3 } }), 'usd');
    assert.equal(trippedAxis({ caps: { max_agent_dispatches: 5 }, consumed: { dispatches: 5 } }), 'max_agent_dispatches');
  });
  test('returns null when nothing over', () => {
    assert.equal(trippedAxis({ caps: { max_tokens: 100 }, consumed: { tokens: 1 } }), null);
  });
});

describe('composeBudgetDiagnostic', () => {
  test('json carries axis/caps/consumed/remaining; md renders rows + resume', () => {
    const bs = { caps: { max_tokens: 100, ms: 600000 }, consumed: { tokens: 100, wall_s: 42, dispatches: 3, dollars: 0 } };
    const { json, md } = composeBudgetDiagnostic(bs, {
      feature: 'COMP-X', decomposedTasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], completedTaskIds: ['t1'],
    });
    assert.equal(json.kind, 'budget');
    assert.equal(json.axis, 'max_tokens');
    assert.deepEqual(json.caps, bs.caps);
    assert.deepEqual(json.consumed, bs.consumed);
    assert.deepEqual(json.remainingTaskIds, ['t2', 't3']);
    assert.match(md, /GSD budget halt — COMP-X/);
    assert.match(md, /tokens \| 100 \| 100/);
    assert.match(md, /compose gsd COMP-X --resume/);
  });
});

// ─────────────────────────────────────────────────────────── budget-ledger ──

describe('recordGsdUsage + checkGsdCumulativeBudget', () => {
  test('records tokens/cost and accumulates', () => {
    const dir = join(tmp(), '.compose');
    try {
      recordGsdUsage(dir, 'F1', { tokens: 1000, costUsd: 0.5, dispatches: 2, timeMs: 5000 });
      recordGsdUsage(dir, 'F1', { tokens: 500, costUsd: 0.25 });
      const feat = readLedger(dir).features.F1;
      assert.equal(feat.totalTokens, 1500);
      assert.equal(feat.totalCostUsd, 0.75);
      assert.equal(feat.sessions.filter((s) => s.kind === 'gsd').length, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('back-compat: adds onto a legacy iteration-only entry without clobbering', () => {
    const dir = join(tmp(), '.compose');
    try {
      recordIteration(dir, 'F2', { iterations: 3, actions: 10, timeMs: 1000 });
      recordGsdUsage(dir, 'F2', { tokens: 200, costUsd: 0.1 });
      const feat = readLedger(dir).features.F2;
      assert.equal(feat.totalIterations, 3);   // preserved
      assert.equal(feat.totalActions, 10);     // preserved
      assert.equal(feat.totalTokens, 200);     // added
      assert.equal(feat.totalCostUsd, 0.1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('checkGsdCumulativeBudget: token ceiling', () => {
    const dir = join(tmp(), '.compose');
    try {
      recordGsdUsage(dir, 'F3', { tokens: 1000 });
      assert.equal(checkGsdCumulativeBudget(dir, 'F3', { maxTotalTokens: 1500 }).exceeded, false);
      recordGsdUsage(dir, 'F3', { tokens: 600 });
      assert.equal(checkGsdCumulativeBudget(dir, 'F3', { maxTotalTokens: 1500 }).exceeded, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('checkGsdCumulativeBudget: cost ceiling', () => {
    const dir = join(tmp(), '.compose');
    try {
      recordGsdUsage(dir, 'F4', { costUsd: 2.0 });
      const r = checkGsdCumulativeBudget(dir, 'F4', { maxTotalCostUsd: 1.5 });
      assert.equal(r.exceeded, true);
      assert.match(r.reason, /cost ceiling/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('no limits → never exceeded; missing feature → zero usage', () => {
    const dir = join(tmp(), '.compose');
    try {
      assert.equal(checkGsdCumulativeBudget(dir, 'NOPE', {}).exceeded, false);
      assert.deepEqual(checkGsdCumulativeBudget(dir, 'NOPE', {}).usage, { totalTokens: 0, totalCostUsd: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('resetGsdUsage zeroes gsd counters, preserves iteration fields', () => {
    const dir = join(tmp(), '.compose');
    try {
      recordIteration(dir, 'F5', { iterations: 2 });
      recordGsdUsage(dir, 'F5', { tokens: 9000, costUsd: 3 });
      resetGsdUsage(dir, 'F5');
      const feat = readLedger(dir).features.F5;
      assert.equal(feat.totalTokens, 0);
      assert.equal(feat.totalCostUsd, 0);
      assert.equal(feat.totalIterations, 2); // preserved
      assert.equal(feat.sessions.filter((s) => s.kind === 'gsd').length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
