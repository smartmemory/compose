/**
 * status-band-logic.test.js — Unit tests for statusBandLogic.js pure helpers.
 *
 * TDD red-phase: written before statusBandLogic.js exists.
 *
 * Covers:
 *   - truncateForSentence: edge cases, ellipsis, no-op when fits
 *   - formatExpansionPanel: labelled rows from snapshot fields
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { truncateForSentence, formatExpansionPanel } = await import(
  `${REPO_ROOT}/src/components/vision/statusBandLogic.js`
);

// ── truncateForSentence ──────────────────────────────────────────────────────

describe('truncateForSentence', () => {
  test('returns string unchanged when it fits within headroom', () => {
    assert.equal(truncateForSentence('hello', 10), 'hello');
  });

  test('truncates to headroom-1 chars + ellipsis', () => {
    const result = truncateForSentence('abcdefghij', 7);
    assert.equal(result, 'abcdef…');
    assert.equal(result.length, 7);
  });

  test('returns just ellipsis when headroom is 1', () => {
    assert.equal(truncateForSentence('hello', 1), '…');
  });

  test('returns empty string when headroom is 0', () => {
    const result = truncateForSentence('hello', 0);
    // headroom <= 0 or 1 edge case: ellipsis or empty
    assert.ok(result.length <= 1);
  });

  test('no truncation when string length equals headroom', () => {
    assert.equal(truncateForSentence('abcde', 5), 'abcde');
  });

  test('handles empty string', () => {
    assert.equal(truncateForSentence('', 10), '');
  });
});

// ── formatExpansionPanel ──────────────────────────────────────────────────────

describe('formatExpansionPanel', () => {
  const NOW = '2026-04-25T12:00:00.000Z';

  function makeSnap(overrides = {}) {
    return {
      sentence: 'Building execute. Open loops: 2.',
      active_phase: 'execute',
      active_goal: 'My Feature',
      pending_gates: ['g-1', 'g-2'],
      drift_alerts: [],
      open_loops_count: 2,
      gate_load_24h: 0,
      cta: null,
      computed_at: NOW,
      ...overrides,
    };
  }

  test('returns an array of row objects', () => {
    const rows = formatExpansionPanel(makeSnap());
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length > 0);
  });

  test('each row has a label and value', () => {
    const rows = formatExpansionPanel(makeSnap());
    for (const row of rows) {
      assert.ok(typeof row.label === 'string', `row missing label: ${JSON.stringify(row)}`);
      assert.ok('value' in row, `row missing value: ${JSON.stringify(row)}`);
    }
  });

  test('includes open_loops_count row', () => {
    const rows = formatExpansionPanel(makeSnap({ open_loops_count: 3 }));
    const row = rows.find(r => r.label.toLowerCase().includes('loop'));
    assert.ok(row, 'expected a row about open loops');
    assert.ok(String(row.value).includes('3'), `value should include 3: ${row.value}`);
  });

  test('includes pending_gates row', () => {
    const rows = formatExpansionPanel(makeSnap({ pending_gates: ['gate-abc', 'gate-xyz'] }));
    const row = rows.find(r => r.label.toLowerCase().includes('gate'));
    assert.ok(row, 'expected a gates row');
  });

  test('handles null snapshot gracefully (returns empty array)', () => {
    const rows = formatExpansionPanel(null);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 0);
  });

  test('includes drift_alerts row when alerts present', () => {
    const snap = makeSnap({
      drift_alerts: [{
        axis_id: 'path_drift', name: 'path_drift axis', numerator: 3, denominator: 5,
        ratio: 0.6, threshold: 0.5, breached: true, computed_at: NOW,
      }],
    });
    const rows = formatExpansionPanel(snap);
    const row = rows.find(r => r.label.toLowerCase().includes('drift'));
    assert.ok(row, 'expected a drift row when alerts present');
  });
});
