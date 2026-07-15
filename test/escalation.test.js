/**
 * escalation.test.js — Tests for the pure escalation decision function.
 *
 * Run with: node --test test/escalation.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escalate, LANE_ORDER } from '../lib/escalation.js';

describe('escalate — lane ladder export', () => {
  test('LANE_ORDER is the trivial→standard→complex ladder', () => {
    assert.deepEqual(LANE_ORDER, ['trivial', 'standard', 'complex']);
  });
});

describe('escalate — passing gate', () => {
  test('review gate passed=true → null (no escalation needed)', () => {
    const result = escalate({ gate: 'review', passed: true }, 'trivial', 0, 'implement');
    assert.equal(result, null);
  });

  test('test gate passed=true → null regardless of lane/count', () => {
    const result = escalate({ gate: 'test', passed: true }, 'complex', 5, 'ship');
    assert.equal(result, null);
  });
});

describe('escalate — ladder progression on failure', () => {
  test('trivial + fail → {nextLane: standard, reEntryPhase: blueprint}', () => {
    const result = escalate({ gate: 'review', passed: false }, 'trivial', 0, 'implement');
    assert.deepEqual(result, { nextLane: 'standard', reEntryPhase: 'blueprint' });
  });

  test('standard + fail → {nextLane: complex, reEntryPhase: design}', () => {
    const result = escalate({ gate: 'test', passed: false }, 'standard', 0, 'ship');
    assert.deepEqual(result, { nextLane: 'complex', reEntryPhase: 'design' });
  });

  test('complex + fail → STOP (cannot escalate further)', () => {
    const result = escalate({ gate: 'review', passed: false }, 'complex', 0, 'implement');
    assert.equal(result, 'STOP');
  });
});

describe('escalate — bounded escalation count', () => {
  test('escalationCount >= 2 → STOP even on trivial lane', () => {
    const result = escalate({ gate: 'review', passed: false }, 'trivial', 2, 'implement');
    assert.equal(result, 'STOP');
  });

  test('escalationCount >= 2 → STOP even on standard lane', () => {
    const result = escalate({ gate: 'test', passed: false }, 'standard', 2, 'ship');
    assert.equal(result, 'STOP');
  });

  test('escalationCount > 2 → STOP (bound fires, not just equality)', () => {
    const result = escalate({ gate: 'review', passed: false }, 'trivial', 3, 'implement');
    assert.equal(result, 'STOP');
  });

  test('escalationCount === 1 → still escalates normally (bound not yet reached)', () => {
    const result = escalate({ gate: 'review', passed: false }, 'trivial', 1, 'implement');
    assert.deepEqual(result, { nextLane: 'standard', reEntryPhase: 'blueprint' });
  });
});

describe('escalate — purity', () => {
  test('does not mutate the normalizedGate argument', () => {
    const gate = { gate: 'review', passed: false };
    const frozen = JSON.parse(JSON.stringify(gate));
    escalate(gate, 'trivial', 0, 'implement');
    assert.deepEqual(gate, frozen);
  });

  test('same inputs produce the same output (no hidden state)', () => {
    const first = escalate({ gate: 'test', passed: false }, 'trivial', 0, 'implement');
    const second = escalate({ gate: 'test', passed: false }, 'trivial', 0, 'implement');
    assert.deepEqual(first, second);
  });
});
