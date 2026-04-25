/**
 * decision-event-id.test.js — Determinism + namespace isolation for all id helpers.
 *
 * COMP-OBS-TIMELINE: extends BRANCH's existing branchDecisionEventId with
 * phaseTransitionDecisionEventId and iterationDecisionEventId.
 *
 * Run: node --test test/decision-event-id.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  branchDecisionEventId,
  phaseTransitionDecisionEventId,
  iterationDecisionEventId,
} = await import(`${REPO_ROOT}/server/decision-event-id.js`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('branchDecisionEventId (existing)', () => {
  test('returns a UUID v5 string', () => {
    const id = branchDecisionEventId('FC-1', 'branch-abc');
    assert.match(id, UUID_RE);
  });

  test('same inputs → same id', () => {
    assert.equal(
      branchDecisionEventId('FC-1', 'branch-abc'),
      branchDecisionEventId('FC-1', 'branch-abc'),
    );
  });

  test('different branch_id → different id', () => {
    assert.notEqual(
      branchDecisionEventId('FC-1', 'branch-abc'),
      branchDecisionEventId('FC-1', 'branch-xyz'),
    );
  });

  test('different featureCode → different id', () => {
    assert.notEqual(
      branchDecisionEventId('FC-1', 'branch-abc'),
      branchDecisionEventId('FC-2', 'branch-abc'),
    );
  });
});

describe('phaseTransitionDecisionEventId', () => {
  const TS = '2026-04-24T10:00:00Z';

  test('returns a UUID string', () => {
    const id = phaseTransitionDecisionEventId('FC-1', null, 'explore_design', TS);
    assert.match(id, UUID_RE);
  });

  test('same inputs → same id (deterministic)', () => {
    assert.equal(
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', TS),
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', TS),
    );
  });

  test('different from → different id', () => {
    assert.notEqual(
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', TS),
      phaseTransitionDecisionEventId('FC-1', 'architecture', 'plan', TS),
    );
  });

  test('different to → different id', () => {
    assert.notEqual(
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', TS),
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'execute', TS),
    );
  });

  test('different timestamp → different id', () => {
    assert.notEqual(
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', '2026-04-24T10:00:00Z'),
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', '2026-04-24T11:00:00Z'),
    );
  });

  test('different featureCode → different id', () => {
    assert.notEqual(
      phaseTransitionDecisionEventId('FC-1', 'blueprint', 'plan', TS),
      phaseTransitionDecisionEventId('FC-2', 'blueprint', 'plan', TS),
    );
  });

  test('namespace separation: phaseTransition ≠ branch for same featureCode', () => {
    assert.notEqual(
      phaseTransitionDecisionEventId('FC-1', null, 'explore_design', TS),
      branchDecisionEventId('FC-1', 'explore_design'),
    );
  });
});

describe('iterationDecisionEventId', () => {
  test('returns a UUID string', () => {
    const id = iterationDecisionEventId('FC-1', 'iter-001', 'start');
    assert.match(id, UUID_RE);
  });

  test('same inputs → same id (deterministic)', () => {
    assert.equal(
      iterationDecisionEventId('FC-1', 'iter-001', 'complete'),
      iterationDecisionEventId('FC-1', 'iter-001', 'complete'),
    );
  });

  test('start vs complete → different ids for same loopId', () => {
    assert.notEqual(
      iterationDecisionEventId('FC-1', 'iter-001', 'start'),
      iterationDecisionEventId('FC-1', 'iter-001', 'complete'),
    );
  });

  test('different loopId → different id', () => {
    assert.notEqual(
      iterationDecisionEventId('FC-1', 'iter-001', 'start'),
      iterationDecisionEventId('FC-1', 'iter-002', 'start'),
    );
  });

  test('different featureCode → different id', () => {
    assert.notEqual(
      iterationDecisionEventId('FC-1', 'iter-001', 'start'),
      iterationDecisionEventId('FC-2', 'iter-001', 'start'),
    );
  });

  test('namespace separation: iteration ≠ branch for same inputs', () => {
    assert.notEqual(
      iterationDecisionEventId('FC-1', 'iter-001', 'start'),
      branchDecisionEventId('FC-1', 'iter-001'),
    );
  });
});
