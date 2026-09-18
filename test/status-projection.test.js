import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  featureStatusToExternalExpect,
  featureStatusToVisionStatus,
} from '../lib/status-projection.js';

test('status-projection: maps every feature/roadmap status to its vision status', () => {
  const cases = [
    ['PLANNED', 'planned'],
    ['IN_PROGRESS', 'in_progress'],
    ['PARTIAL', 'in_progress'],   // vision cannot represent "partially shipped"
    ['COMPLETE', 'complete'],
    ['BLOCKED', 'blocked'],
    ['PARKED', 'parked'],
    ['KILLED', 'killed'],
    ['SUPERSEDED', 'superseded'], // D1: store enum gains 'superseded'
  ];
  for (const [input, expected] of cases) {
    assert.equal(featureStatusToVisionStatus(input), expected, `${input} → ${expected}`);
  }
});

test('status-projection: is case-insensitive on input', () => {
  assert.equal(featureStatusToVisionStatus('complete'), 'complete');
  assert.equal(featureStatusToVisionStatus('In_Progress'), 'in_progress');
});

test('status-projection: returns null for null/undefined/unknown', () => {
  assert.equal(featureStatusToVisionStatus(null), null);
  assert.equal(featureStatusToVisionStatus(undefined), null);
  assert.equal(featureStatusToVisionStatus(''), null);
  assert.equal(featureStatusToVisionStatus('NONSENSE'), null);
  // vision-native statuses with no feature-vocab key fold to null (callers treat
  // null as "no opinion" — validator falls back to identity, writer skips).
  assert.equal(featureStatusToVisionStatus('READY'), null);
  assert.equal(featureStatusToVisionStatus('REVIEW'), null);
});

test('status-projection: maps every feature/roadmap status to its external issue state', () => {
  const cases = [
    ['PLANNED', 'open'],
    ['IN_PROGRESS', 'open'],
    ['PARTIAL', 'open'],
    ['COMPLETE', 'closed'],
    ['BLOCKED', 'open'],
    ['PARKED', null], // parked features leave their external issue unchanged
    ['KILLED', 'closed'],
    ['SUPERSEDED', 'closed'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(featureStatusToExternalExpect(input), expected, `${input} → ${expected}`);
  }
});
