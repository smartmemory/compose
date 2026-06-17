/**
 * Tests for parseTestSummary (COMP-TEST-BOOTSTRAP-4)
 * Pure cross-framework test-summary parser. Run with:
 *   node --test test/parse-test-summary.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTestSummary, deriveTestsPass } from '../lib/test-bootstrap.js';

// ---------------------------------------------------------------------------
// Degrade behavior — the safety valve. Unparseable input must NEVER claim parsed.
// ---------------------------------------------------------------------------

describe('parseTestSummary — degrade path', () => {
  it('returns parsed:false for an unknown framework', () => {
    assert.deepEqual(parseTestSummary('ava', '5 tests passed'), {
      test_count: 0, pass_rate: 0, parsed: false,
    });
  });

  it('returns parsed:false for null/empty framework', () => {
    assert.equal(parseTestSummary(null, 'whatever').parsed, false);
    assert.equal(parseTestSummary('', 'whatever').parsed, false);
  });

  it('returns parsed:false for empty/non-string stdout', () => {
    assert.equal(parseTestSummary('vitest', '').parsed, false);
    assert.equal(parseTestSummary('vitest', null).parsed, false);
    assert.equal(parseTestSummary('vitest', undefined).parsed, false);
  });

  it('returns parsed:false when a known framework emits no recognizable summary', () => {
    assert.equal(parseTestSummary('jest', 'compilation error, nothing ran').parsed, false);
    assert.equal(parseTestSummary('pytest', 'ImportError: boom').parsed, false);
  });

  it('returns parsed:false for go output with no per-test verdicts (no -v)', () => {
    assert.equal(parseTestSummary('go-test', 'ok  \texample\t0.012s').parsed, false);
  });
});

// ---------------------------------------------------------------------------
// deriveTestsPass — the gate. The degrade contract: unparsed => true (no block).
// ---------------------------------------------------------------------------

describe('deriveTestsPass', () => {
  it('true when parsed, all tests pass, at least one test', () => {
    assert.equal(deriveTestsPass({ test_count: 12, pass_rate: 100, parsed: true }), true);
  });

  it('FALSE when parsed and any test failed (the gate fires)', () => {
    assert.equal(deriveTestsPass({ test_count: 12, pass_rate: 83.33, parsed: true }), false);
  });

  it('FALSE when parsed but zero tests ran', () => {
    assert.equal(deriveTestsPass({ test_count: 0, pass_rate: 0, parsed: true }), false);
  });

  it('TRUE when not parsed — degrade, never false-block on unreadable output', () => {
    assert.equal(deriveTestsPass({ test_count: 0, pass_rate: 0, parsed: false }), true);
  });

  it('TRUE for null/undefined summary (no signal)', () => {
    assert.equal(deriveTestsPass(null), true);
    assert.equal(deriveTestsPass(undefined), true);
  });
});

// ---------------------------------------------------------------------------
// vitest
// ---------------------------------------------------------------------------

describe('parseTestSummary — vitest', () => {
  it('all passing', () => {
    const out = ' Test Files  3 passed (3)\n      Tests  12 passed (12)\n';
    assert.deepEqual(parseTestSummary('vitest', out), {
      test_count: 12, pass_rate: 100, parsed: true,
    });
  });

  it('with failures', () => {
    const out = ' Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 10 passed (12)\n';
    const r = parseTestSummary('vitest', out);
    assert.equal(r.parsed, true);
    assert.equal(r.test_count, 12);
    assert.equal(r.pass_rate, 83.33);
  });

  it('strips ANSI color codes', () => {
    const out = ' \x1b[32mTests  12 passed\x1b[39m (12)\n';
    assert.deepEqual(parseTestSummary('vitest', out), {
      test_count: 12, pass_rate: 100, parsed: true,
    });
  });

  it('does not confuse the "Test Files" line for the "Tests" line', () => {
    // Test Files line alone (no Tests line) → nothing to count
    assert.equal(parseTestSummary('vitest', ' Test Files  3 passed (3)\n').parsed, false);
  });
});

// ---------------------------------------------------------------------------
// jest
// ---------------------------------------------------------------------------

describe('parseTestSummary — jest', () => {
  it('all passing', () => {
    const out = 'Tests:       12 passed, 12 total\n';
    assert.deepEqual(parseTestSummary('jest', out), {
      test_count: 12, pass_rate: 100, parsed: true,
    });
  });

  it('with failures', () => {
    const out = 'Tests:       2 failed, 10 passed, 12 total\n';
    const r = parseTestSummary('jest', out);
    assert.equal(r.test_count, 12);
    assert.equal(r.pass_rate, 83.33);
  });
});

// ---------------------------------------------------------------------------
// mocha
// ---------------------------------------------------------------------------

describe('parseTestSummary — mocha', () => {
  it('all passing', () => {
    const out = '\n  10 passing (24ms)\n';
    assert.deepEqual(parseTestSummary('mocha', out), {
      test_count: 10, pass_rate: 100, parsed: true,
    });
  });

  it('with failures and pending (pending excluded from count)', () => {
    const out = '\n  8 passing (2s)\n  2 failing\n  1 pending\n';
    const r = parseTestSummary('mocha', out);
    assert.equal(r.test_count, 10);
    assert.equal(r.pass_rate, 80);
  });
});

// ---------------------------------------------------------------------------
// pytest
// ---------------------------------------------------------------------------

describe('parseTestSummary — pytest', () => {
  it('all passing', () => {
    const out = '===================== 12 passed in 0.34s =====================\n';
    assert.deepEqual(parseTestSummary('pytest', out), {
      test_count: 12, pass_rate: 100, parsed: true,
    });
  });

  it('with failures and errors (errors count as failures)', () => {
    const out = '========== 2 failed, 9 passed, 1 error, 1 skipped in 0.50s ==========\n';
    const r = parseTestSummary('pytest', out);
    // passed=9, failed=2+1error=3 → total 12, skipped excluded
    assert.equal(r.test_count, 12);
    assert.equal(r.pass_rate, 75);
  });
});

// ---------------------------------------------------------------------------
// go test (-v)
// ---------------------------------------------------------------------------

describe('parseTestSummary — go-test', () => {
  it('counts --- PASS / --- FAIL verdict lines', () => {
    const out = [
      '=== RUN   TestA',
      '--- PASS: TestA (0.00s)',
      '=== RUN   TestB',
      '--- PASS: TestB (0.00s)',
      '=== RUN   TestC',
      '--- FAIL: TestC (0.01s)',
      'FAIL',
    ].join('\n');
    const r = parseTestSummary('go-test', out);
    assert.equal(r.test_count, 3);
    assert.equal(r.pass_rate, 66.67);
  });
});

// ---------------------------------------------------------------------------
// cargo test
// ---------------------------------------------------------------------------

describe('parseTestSummary — cargo-test', () => {
  it('all passing (single result line)', () => {
    const out = 'test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    assert.deepEqual(parseTestSummary('cargo-test', out), {
      test_count: 12, pass_rate: 100, parsed: true,
    });
  });

  it('sums multiple result lines (unit + integration + doc tests)', () => {
    const out = [
      'test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      'test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out',
      'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n');
    const r = parseTestSummary('cargo-test', out);
    // passed 5+3+2=10, failed 0+2+0=2 → total 12
    assert.equal(r.test_count, 12);
    assert.equal(r.pass_rate, 83.33);
  });
});
