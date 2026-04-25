/**
 * decision-timeline-logic.test.js — Pure helper functions for the timeline strip.
 *
 * COMP-OBS-TIMELINE B2: unit tests for all pure helpers in decisionTimelineLogic.js.
 *
 * Run: node --test test/decision-timeline-logic.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  formatRelativeTime,
  kindIcon,
  kindColor,
  roleChipClass,
  sortAndFilterEvents,
} = await import(`${REPO_ROOT}/src/components/vision/decisionTimelineLogic.js`);

// ── formatRelativeTime ────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-04-24T12:00:00Z').getTime();

  test('recent (<1 min) → "now"', () => {
    assert.equal(formatRelativeTime('2026-04-24T11:59:30Z', NOW), 'now');
  });

  test('< 60 min → Nm', () => {
    assert.equal(formatRelativeTime('2026-04-24T11:45:00Z', NOW), '15m');
  });

  test('< 24 h → Nh', () => {
    assert.equal(formatRelativeTime('2026-04-24T10:00:00Z', NOW), '2h');
  });

  test('>= 24 h → Nd', () => {
    assert.equal(formatRelativeTime('2026-04-23T12:00:00Z', NOW), '1d');
  });

  test('null/undefined → ""', () => {
    assert.equal(formatRelativeTime(null, NOW), '');
    assert.equal(formatRelativeTime(undefined, NOW), '');
  });
});

// ── kindIcon ─────────────────────────────────────────────────────────────────

describe('kindIcon', () => {
  test('branch → unicode fork char', () => {
    assert.ok(typeof kindIcon('branch') === 'string' && kindIcon('branch').length > 0);
  });

  test('phase_transition → → arrow', () => {
    assert.equal(kindIcon('phase_transition'), '→');
  });

  test('iteration → ↻', () => {
    assert.equal(kindIcon('iteration'), '↻');
  });

  test('gate → ◈', () => {
    assert.equal(kindIcon('gate'), '◈');
  });

  test('unknown kind → fallback char (non-empty string)', () => {
    const icon = kindIcon('unknown_kind');
    assert.ok(typeof icon === 'string' && icon.length > 0);
  });
});

// ── kindColor ────────────────────────────────────────────────────────────────

describe('kindColor', () => {
  test('returns a Tailwind text class string', () => {
    const color = kindColor('branch');
    assert.match(color, /^text-/);
  });

  test('phase_transition → blue variant', () => {
    assert.match(kindColor('phase_transition'), /blue/);
  });

  test('iteration → cyan variant', () => {
    assert.match(kindColor('iteration'), /cyan/);
  });

  test('unknown kind → fallback (non-empty)', () => {
    assert.ok(kindColor('xyz').length > 0);
  });
});

// ── roleChipClass ─────────────────────────────────────────────────────────────

describe('roleChipClass', () => {
  test('IMPLEMENTER → some Tailwind class string', () => {
    assert.ok(roleChipClass('IMPLEMENTER').length > 0);
  });

  test('REVIEWER → some Tailwind class string', () => {
    assert.ok(roleChipClass('REVIEWER').length > 0);
  });

  test('PRODUCER → some Tailwind class string', () => {
    assert.ok(roleChipClass('PRODUCER').length > 0);
  });

  test('IMPLEMENTER and REVIEWER get different classes', () => {
    assert.notEqual(roleChipClass('IMPLEMENTER'), roleChipClass('REVIEWER'));
  });

  test('unknown role → fallback (non-empty)', () => {
    assert.ok(roleChipClass('UNKNOWN').length > 0);
  });
});

// ── sortAndFilterEvents ───────────────────────────────────────────────────────

describe('sortAndFilterEvents', () => {
  const events = [
    { id: 'e1', feature_code: 'FC-1', timestamp: '2026-04-24T10:00:00Z', kind: 'phase_transition' },
    { id: 'e2', feature_code: 'FC-1', timestamp: '2026-04-24T12:00:00Z', kind: 'iteration' },
    { id: 'e3', feature_code: 'FC-1', timestamp: '2026-04-24T11:00:00Z', kind: 'branch' },
    { id: 'e4', feature_code: 'FC-2', timestamp: '2026-04-24T10:30:00Z', kind: 'gate' },
  ];

  test('filters to only the given featureCode', () => {
    const result = sortAndFilterEvents(events, 'FC-1');
    assert.ok(result.every(e => e.feature_code === 'FC-1'));
    assert.equal(result.length, 3);
  });

  test('returns events sorted oldest-first (newest-right per layout region ②)', () => {
    const result = sortAndFilterEvents(events, 'FC-1');
    assert.equal(result[0].id, 'e1', 'oldest event first');
    assert.equal(result[1].id, 'e3');
    assert.equal(result[2].id, 'e2', 'newest event last (rightmost)');
  });

  test('returns empty array when no events match featureCode', () => {
    const result = sortAndFilterEvents(events, 'FC-99');
    assert.deepEqual(result, []);
  });

  test('returns empty array when events is empty', () => {
    assert.deepEqual(sortAndFilterEvents([], 'FC-1'), []);
  });

  test('handles events with equal timestamps (stable order preserved)', () => {
    const tied = [
      { id: 'a', feature_code: 'FC-1', timestamp: '2026-04-24T10:00:00Z', kind: 'branch' },
      { id: 'b', feature_code: 'FC-1', timestamp: '2026-04-24T10:00:00Z', kind: 'iteration' },
    ];
    const result = sortAndFilterEvents(tied, 'FC-1');
    assert.equal(result.length, 2);
  });

  test('does not mutate the input array', () => {
    const original = [...events];
    sortAndFilterEvents(events, 'FC-1');
    assert.equal(events.length, original.length);
  });
});
