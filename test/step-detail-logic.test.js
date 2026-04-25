/**
 * step-detail-logic.test.js — Pure-function tests for stepDetailLogic.js
 *
 * Run: node --test test/step-detail-logic.test.js
 *
 * Covers:
 *   - selectRetriesSummary: scalar int, array, absent/zero
 *   - selectViolations: non-empty array, empty, absent
 *   - findLoopForStep: matches stepId, returns null when absent
 *   - selectLiveCounters: running loop with budget, graceful degradation
 *   - formatBudgetCompact: compact string for OpsStrip pill
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  selectRetriesSummary,
  selectViolations,
  findLoopForStep,
  selectLiveCounters,
  formatBudgetCompact,
} = await import(`${REPO_ROOT}/src/components/cockpit/stepDetailLogic.js`);

// ── selectRetriesSummary ──────────────────────────────────────────────────────

describe('selectRetriesSummary', () => {
  test('returns null when step is null', () => {
    assert.equal(selectRetriesSummary(null), null);
  });

  test('returns null when step.retries is absent', () => {
    assert.equal(selectRetriesSummary({}), null);
  });

  test('returns null when step.retries is 0', () => {
    assert.equal(selectRetriesSummary({ retries: 0 }), null);
  });

  test('returns { count, isArray: false } when step.retries is a positive integer', () => {
    const result = selectRetriesSummary({ retries: 3 });
    assert.deepEqual(result, { count: 3, isArray: false, items: [] });
  });

  test('returns { count, isArray: true, items } when step.retries is an array', () => {
    const retries = [{ reason: 'timeout' }, { reason: 'exit-1' }];
    const result = selectRetriesSummary({ retries });
    assert.deepEqual(result, { count: 2, isArray: true, items: retries });
  });

  test('returns null when step.retries is empty array', () => {
    assert.equal(selectRetriesSummary({ retries: [] }), null);
  });
});

// ── selectViolations ──────────────────────────────────────────────────────────

describe('selectViolations', () => {
  test('returns empty array when step is null', () => {
    assert.deepEqual(selectViolations(null), []);
  });

  test('returns empty array when step.violations is absent', () => {
    assert.deepEqual(selectViolations({}), []);
  });

  test('returns empty array when step.violations is empty', () => {
    assert.deepEqual(selectViolations({ violations: [] }), []);
  });

  test('returns the violations array when non-empty', () => {
    const v = [{ name: 'ensure-tests', message: 'Tests failed' }];
    assert.deepEqual(selectViolations({ violations: v }), v);
  });

  test('handles string violations gracefully', () => {
    const v = ['something failed'];
    assert.deepEqual(selectViolations({ violations: v }), v);
  });
});

// ── findLoopForStep ───────────────────────────────────────────────────────────

describe('findLoopForStep', () => {
  test('returns null when iterationStates is null', () => {
    assert.equal(findLoopForStep(null, 'step-1'), null);
  });

  test('returns null when iterationStates is empty Map', () => {
    assert.equal(findLoopForStep(new Map(), 'step-1'), null);
  });

  test('returns null when no iteration matches stepId', () => {
    const states = new Map([
      ['loop-1', { loopId: 'loop-1', stepId: 'step-99', status: 'running' }],
    ]);
    assert.equal(findLoopForStep(states, 'step-1'), null);
  });

  test('returns the matching iteration when stepId matches', () => {
    const iter = { loopId: 'loop-1', stepId: 'step-1', status: 'running', loopType: 'review' };
    const states = new Map([['loop-1', iter]]);
    assert.deepEqual(findLoopForStep(states, 'step-1'), iter);
  });

  test('returns first matching when multiple entries share stepId', () => {
    const iter1 = { loopId: 'loop-1', stepId: 'step-1', status: 'done' };
    const iter2 = { loopId: 'loop-2', stepId: 'step-1', status: 'running' };
    const states = new Map([['loop-1', iter1], ['loop-2', iter2]]);
    const result = findLoopForStep(states, 'step-1');
    // Either is valid — just ensure we got one
    assert.ok(result !== null);
    assert.equal(result.stepId, 'step-1');
  });

  test('gracefully returns null when iterationStates entries lack stepId', () => {
    // Shipped iterationStates may not carry stepId — degrade gracefully
    const states = new Map([
      ['loop-1', { loopId: 'loop-1', status: 'running', loopType: 'review' }],
    ]);
    assert.equal(findLoopForStep(states, 'step-1'), null);
  });
});

// ── selectLiveCounters ────────────────────────────────────────────────────────

describe('selectLiveCounters', () => {
  const now = 1_000_000; // fixed ms timestamp

  test('returns null when loopState is null', () => {
    assert.equal(selectLiveCounters(null, null, now), null);
  });

  test('returns null when loop status is not running', () => {
    const loop = { loopId: 'l', status: 'done', count: 3, maxIterations: 5, startedAt: new Date(now - 10_000).toISOString(), loopType: 'review' };
    assert.equal(selectLiveCounters(loop, null, now), null);
  });

  test('returns counters when loop is running (no budget)', () => {
    const startedAt = new Date(now - 5_000).toISOString();
    const loop = {
      loopId: 'l', status: 'running', count: 2, maxIterations: 8,
      startedAt, loopType: 'review', wallClockTimeout: null,
    };
    const result = selectLiveCounters(loop, null, now);
    assert.ok(result !== null);
    assert.equal(result.count, 2);
    assert.equal(result.maxIterations, 8);
    assert.equal(result.loopType, 'review');
    assert.ok(result.elapsedMs >= 5000, `elapsedMs=${result.elapsedMs} should be >= 5000`);
    assert.equal(result.timeoutMs, null);
    assert.equal(result.usedIterations, null);
    assert.equal(result.maxTotal, null);
  });

  test('includes timeout when wallClockTimeout is set', () => {
    const startedAt = new Date(now - 2_000).toISOString();
    const loop = {
      loopId: 'l', status: 'running', count: 1, maxIterations: 10,
      startedAt, loopType: 'review', wallClockTimeout: 5, // 5 minutes
    };
    const result = selectLiveCounters(loop, null, now);
    assert.equal(result.timeoutMs, 5 * 60 * 1000);
  });

  test('includes budget fields when budget is provided for the loopType', () => {
    const startedAt = new Date(now - 1_000).toISOString();
    const loop = {
      loopId: 'l', status: 'running', count: 3, maxIterations: 10,
      startedAt, loopType: 'review', wallClockTimeout: null,
    };
    const budget = {
      per_loop_type: {
        review: { usedIterations: 7, maxTotal: 20, remaining: 13 },
      },
    };
    const result = selectLiveCounters(loop, budget, now);
    assert.equal(result.usedIterations, 7);
    assert.equal(result.maxTotal, 20);
  });

  test('budget fields are null when loopType not in budget', () => {
    const startedAt = new Date(now - 1_000).toISOString();
    const loop = {
      loopId: 'l', status: 'running', count: 1, maxIterations: 5,
      startedAt, loopType: 'coverage', wallClockTimeout: null,
    };
    const budget = {
      per_loop_type: {
        review: { usedIterations: 3, maxTotal: 10, remaining: 7 },
        // no coverage
      },
    };
    const result = selectLiveCounters(loop, budget, now);
    assert.equal(result.usedIterations, null);
    assert.equal(result.maxTotal, null);
  });
});

// ── formatBudgetCompact ───────────────────────────────────────────────────────

describe('formatBudgetCompact', () => {
  test('returns empty string when budget is null', () => {
    assert.equal(formatBudgetCompact(null), '');
  });

  test('returns empty string when no loopType has maxTotal', () => {
    const budget = {
      per_loop_type: {
        review: { usedIterations: 3, maxTotal: null, remaining: null },
        coverage: { usedIterations: 2, maxTotal: null, remaining: null },
      },
    };
    assert.equal(formatBudgetCompact(budget), '');
  });

  test('returns compact string for both loopTypes', () => {
    const budget = {
      per_loop_type: {
        review:   { usedIterations: 5, maxTotal: 20, remaining: 15 },
        coverage: { usedIterations: 8, maxTotal: 50, remaining: 42 },
      },
    };
    const result = formatBudgetCompact(budget);
    assert.ok(result.includes('r 5/20'), `expected "r 5/20" in: ${result}`);
    assert.ok(result.includes('c 8/50'), `expected "c 8/50" in: ${result}`);
  });

  test('omits loopType from pill when its maxTotal is null', () => {
    const budget = {
      per_loop_type: {
        review:   { usedIterations: 5, maxTotal: 20, remaining: 15 },
        coverage: { usedIterations: 0, maxTotal: null, remaining: null },
      },
    };
    const result = formatBudgetCompact(budget);
    assert.ok(result.includes('r 5/20'));
    assert.ok(!result.includes('c '), `should not include coverage: ${result}`);
  });
});
