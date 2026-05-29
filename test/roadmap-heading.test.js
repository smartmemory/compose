/**
 * Tests for splitPhaseHeading — disambiguating an em-dash in a phase TITLE from
 * the trailing status token. Regression coverage for issue #38.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPhaseHeading } from '../lib/roadmap-heading.js';

test('splitPhaseHeading: em-dash in title keeps the full title, status is the trailing token', () => {
  assert.deepEqual(
    splitPhaseHeading('Wave 6 — Situational Awareness — COMPLETE'),
    { title: 'Wave 6 — Situational Awareness', status: 'COMPLETE' },
  );
});

test('splitPhaseHeading: simple title — status', () => {
  assert.deepEqual(
    splitPhaseHeading('Phase 0: Bootstrap — COMPLETE'),
    { title: 'Phase 0: Bootstrap', status: 'COMPLETE' },
  );
});

test('splitPhaseHeading: status with parenthetical commentary is preserved whole', () => {
  assert.deepEqual(
    splitPhaseHeading('A — PARTIAL (1a COMPLETE, 2 PLANNED)'),
    { title: 'A', status: 'PARTIAL (1a COMPLETE, 2 PLANNED)' },
  );
});

test('splitPhaseHeading: status with em-dash commentary stays attached to status', () => {
  assert.deepEqual(
    splitPhaseHeading('A — PARKED — needs Claude Code adoption'),
    { title: 'A', status: 'PARKED — needs Claude Code adoption' },
  );
});

test('splitPhaseHeading: em-dash title with NO status is all title', () => {
  assert.deepEqual(
    splitPhaseHeading('Wave 6 — Situational Awareness'),
    { title: 'Wave 6 — Situational Awareness', status: '' },
  );
});

test('splitPhaseHeading: no em-dash at all', () => {
  assert.deepEqual(
    splitPhaseHeading('Phase 1'),
    { title: 'Phase 1', status: '' },
  );
});
