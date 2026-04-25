/**
 * status-emit.test.js — Unit tests for emitStatusSnapshot.
 *
 * TDD red-phase: written before status-emit.js exists.
 *
 * Covers:
 *   - Broadcast capture: emitStatusSnapshot calls broadcastMessage with correct envelope
 *   - Envelope shape: { type: 'statusSnapshot', featureCode, snapshot }
 *   - Returns the snapshot for caller convenience
 *   - Snapshot is recomputed from state each call (no caching)
 *   - Works when featureCode is null (no-feature snapshot)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { emitStatusSnapshot } = await import(`${REPO_ROOT}/server/status-emit.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const NOW = '2026-04-25T12:00:00.000Z';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeState(phase = 'execute') {
  const item = {
    id: 'item-1',
    title: 'My Feature',
    lifecycle: {
      featureCode: 'COMP-OBS-EMIT-TEST',
      currentPhase: phase,
      iterationState: null,
      lifecycle_ext: {},
    },
  };
  const gates = new Map();
  return {
    items: new Map([['item-1', item]]),
    getItemByFeatureCode(fc) {
      for (const it of this.items.values()) {
        if (it.lifecycle?.featureCode === fc) return it;
      }
      return null;
    },
    getPendingGates(itemId) {
      const result = [];
      for (const gate of gates.values()) {
        if (gate.status !== 'pending') continue;
        if (itemId && gate.itemId !== itemId) continue;
        result.push(gate);
      }
      return result;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('emitStatusSnapshot — broadcast envelope', () => {
  test('calls broadcastMessage with { type, featureCode, snapshot }', () => {
    const broadcasts = [];
    const state = makeState('execute');
    emitStatusSnapshot((msg) => broadcasts.push(msg), state, 'COMP-OBS-EMIT-TEST', NOW);
    assert.equal(broadcasts.length, 1);
    const msg = broadcasts[0];
    assert.equal(msg.type, 'statusSnapshot');
    assert.equal(msg.featureCode, 'COMP-OBS-EMIT-TEST');
    assert.ok(typeof msg.snapshot === 'object', 'snapshot must be an object');
  });

  test('snapshot in envelope is schema-valid', () => {
    const broadcasts = [];
    const state = makeState('blueprint');
    emitStatusSnapshot((msg) => broadcasts.push(msg), state, 'COMP-OBS-EMIT-TEST', NOW);
    const v = new SchemaValidator();
    const { valid, errors } = v.validate('StatusSnapshot', broadcasts[0].snapshot);
    assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);
  });

  test('returns the snapshot for caller convenience', () => {
    const state = makeState('plan');
    const snap = emitStatusSnapshot(() => {}, state, 'COMP-OBS-EMIT-TEST', NOW);
    assert.ok(snap, 'must return snapshot');
    assert.equal(typeof snap.sentence, 'string');
    assert.equal(snap.computed_at, NOW);
  });
});

describe('emitStatusSnapshot — no feature code', () => {
  test('broadcasts no-feature snapshot when featureCode is null', () => {
    const broadcasts = [];
    const state = makeState();
    emitStatusSnapshot((msg) => broadcasts.push(msg), state, null, NOW);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].featureCode, null);
    assert.equal(broadcasts[0].snapshot.sentence, 'Select a feature to see status.');
  });
});

describe('emitStatusSnapshot — recomputes from state', () => {
  test('second call reflects updated state (no caching)', () => {
    const broadcasts = [];
    const state = makeState('execute');
    emitStatusSnapshot((msg) => broadcasts.push(msg), state, 'COMP-OBS-EMIT-TEST', NOW);

    // Mutate the phase directly (simulates post-transition state)
    const item = state.items.get('item-1');
    item.lifecycle.currentPhase = 'killed';

    const now2 = '2026-04-25T12:01:00.000Z';
    emitStatusSnapshot((msg) => broadcasts.push(msg), state, 'COMP-OBS-EMIT-TEST', now2);

    assert.equal(broadcasts.length, 2);
    const first = broadcasts[0].snapshot;
    const second = broadcasts[1].snapshot;
    // First should be execute-based, second should be killed
    assert.ok(first.sentence.includes('execute') || first.sentence.includes('Building'), `first: ${first.sentence}`);
    assert.ok(second.sentence.includes('killed'), `second: ${second.sentence}`);
  });
});

describe('emitStatusSnapshot — envelope shape completeness', () => {
  test('envelope has exactly type, featureCode, snapshot (no extra fields)', () => {
    const broadcasts = [];
    emitStatusSnapshot((msg) => broadcasts.push(msg), makeState(), 'COMP-OBS-EMIT-TEST', NOW);
    const msg = broadcasts[0];
    const keys = Object.keys(msg).sort();
    assert.deepEqual(keys, ['featureCode', 'snapshot', 'type'].sort());
  });
});
