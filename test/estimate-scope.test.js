/**
 * estimate-scope.test.js — Tests for the doc-free front-seam scope estimator.
 *
 * `estimateScope` is the front seam: it must classify scope from request text
 * (+ caller-supplied repo signal hints) alone, WITHOUT reading design.md /
 * plan.md / blueprint.md. That's what makes it usable before any design doc
 * exists (COMP-TRIAGE-5 S01).
 *
 * Run with: node --test test/estimate-scope.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { estimateScope, tierToComplexity, narrowerLane } from '../lib/triage.js';

// ---------------------------------------------------------------------------
// estimateScope — lane classification
// ---------------------------------------------------------------------------

describe('estimateScope — lane classification', () => {
  test('one-line edit request with an explicit file path → lane trivial, confidence high', () => {
    const result = estimateScope('Fix a typo in `src/utils/format.js`', {});
    assert.equal(result.lane, 'trivial', `expected trivial, got ${result.lane}: ${result.rationale}`);
    assert.equal(result.confidence, 'high');
    assert.equal(typeof result.tier, 'number');
    assert.equal(typeof result.profile, 'object');
    assert.equal(typeof result.rationale, 'string');
  });

  test('ambiguous request with no file paths and a vague verb → confidence low, lane clamped to standard', () => {
    const result = estimateScope('Improve the general reliability of the system', {});
    assert.equal(result.confidence, 'low');
    assert.equal(result.lane, 'standard', 'low confidence must clamp lane up to standard, never trivial');
    assert.notEqual(result.lane, 'trivial');
  });

  test('ambiguous request with no repoSignals hints at all → confidence low, lane clamped to standard', () => {
    // repoSignals omitted entirely (undefined) — must not throw, must still clamp.
    const result = estimateScope('handle stuff eventually');
    assert.equal(result.confidence, 'low');
    assert.equal(result.lane, 'standard');
  });

  test('request touching a security-sensitive path (via backtick in text) → lane at least standard', () => {
    const result = estimateScope('Update `lib/auth/session.js` to rotate tokens', {});
    const laneOrder = { trivial: 0, standard: 1, complex: 2 };
    assert.ok(laneOrder[result.lane] >= laneOrder.standard, `expected >= standard, got ${result.lane}`);
  });

  test('request touching a core path (via repoSignals hint, vague text) → lane at least standard', () => {
    const result = estimateScope('adjust some settings', { files: ['lib/shared/config.js'] });
    const laneOrder = { trivial: 0, standard: 1, complex: 2 };
    assert.ok(laneOrder[result.lane] >= laneOrder.standard, `expected >= standard, got ${result.lane}`);
  });

  test('mid-size request touching several ordinary files → lane standard', () => {
    const result = estimateScope('Add a new settings panel', {
      files: ['src/components/Settings.jsx', 'src/components/Header.jsx', 'src/styles/settings.css'],
    });
    assert.equal(result.lane, 'standard', `expected standard, got ${result.lane}: ${result.rationale}`);
  });
});

// ---------------------------------------------------------------------------
// tierToComplexity
// ---------------------------------------------------------------------------

describe('tierToComplexity — tier → complexity mapping', () => {
  test('tier 0 → S', () => {
    assert.equal(tierToComplexity(0), 'S');
  });

  test('tier 1 → S', () => {
    assert.equal(tierToComplexity(1), 'S');
  });

  test('tier 2 → M', () => {
    assert.equal(tierToComplexity(2), 'M');
  });

  test('tier 3 → L', () => {
    assert.equal(tierToComplexity(3), 'L');
  });

  test('tier 4 → XL', () => {
    assert.equal(tierToComplexity(4), 'XL');
  });
});

// ---------------------------------------------------------------------------
// narrowerLane
// ---------------------------------------------------------------------------

describe('narrowerLane — picks the more conservative (smaller-scope) lane', () => {
  test('trivial vs standard → trivial', () => {
    assert.equal(narrowerLane('trivial', 'standard'), 'trivial');
  });

  test('standard vs trivial (order-independent) → trivial', () => {
    assert.equal(narrowerLane('standard', 'trivial'), 'trivial');
  });

  test('complex vs standard → standard', () => {
    assert.equal(narrowerLane('complex', 'standard'), 'standard');
  });

  test('equal lanes → same lane', () => {
    assert.equal(narrowerLane('standard', 'standard'), 'standard');
  });

  test('trivial vs complex → trivial', () => {
    assert.equal(narrowerLane('trivial', 'complex'), 'trivial');
  });
});
