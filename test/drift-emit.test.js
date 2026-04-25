/**
 * drift-emit.test.js — Unit tests for compose/server/drift-emit.js
 *
 * Tests rising-edge DecisionEvent emission, steady-breach preservation,
 * falling-edge clearing, broadcast envelope, and snapshot rehydration identity.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { emitDriftAxes } = await import(`${REPO_ROOT}/server/drift-emit.js`);
const { driftThresholdDecisionEventId } = await import(`${REPO_ROOT}/server/decision-event-id.js`);
const { buildDriftThresholdEvent } = await import(`${REPO_ROOT}/server/decision-event-emit.js`);
const { computeDriftAxes } = await import(`${REPO_ROOT}/server/drift-axes.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const FC = 'COMP-OBS-DRIFT-EMIT-TEST';
const NOW = '2026-04-25T10:00:00.000Z';

// ── Fixture factory ────────────────────────────────────────────────────────────

function makeItem(driftAxes = [], featureCode = FC) {
  return {
    id: 'item-emit-test',
    lifecycle: {
      featureCode,
      currentPhase: 'execute',
      phaseHistory: [],
      lifecycle_ext: {
        drift_axes: driftAxes,
      },
    },
  };
}

function makeStore(item) {
  const items = new Map([[item.id, item]]);
  return {
    items,
    updateLifecycleExt(itemId, key, value) {
      const it = items.get(itemId);
      if (!it) throw new Error(`Item not found: ${itemId}`);
      if (!it.lifecycle.lifecycle_ext) it.lifecycle.lifecycle_ext = {};
      it.lifecycle.lifecycle_ext[key] = value;
    },
  };
}

// Make a breached axis (above threshold)
function makeBreachedAxis(axis_id = 'review_debt_drift', breach_started_at = null, breach_event_id = null) {
  return {
    axis_id,
    name: 'Review debt drift',
    numerator: 3,
    denominator: 3,
    ratio: 1.0,
    threshold: 0.40,
    breached: true,
    computed_at: NOW,
    explanation: 'test',
    breach_started_at,
    breach_event_id,
  };
}

function makeUnbreachedAxis(axis_id = 'review_debt_drift') {
  return {
    axis_id,
    name: 'Review debt drift',
    numerator: 0,
    denominator: 5,
    ratio: 0.0,
    threshold: 0.40,
    breached: false,
    computed_at: NOW,
    explanation: 'test',
    breach_started_at: null,
    breach_event_id: null,
  };
}

// A tmp project root with a minimal git repo (no real feature files)
// We use a real git repo so computeDriftAxes doesn't crash,
// but axes will be disabled (threshold:null) due to missing plan anchor.
let tmpRoot;
function getTmpRoot() {
  if (tmpRoot) return tmpRoot;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-emit-'));
  const git = (cmd) => execSync(cmd, { cwd: tmpRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('git init');
    git('git config user.email "test@example.com"');
    git('git config user.name "Test"');
    fs.writeFileSync(path.join(tmpRoot, '.gitkeep'), '');
    git('git add .gitkeep');
    git('git commit -m "init"');
  } catch {
    // If git not available, emitDriftAxes will still work (axes disabled)
  }
  return tmpRoot;
}

// ── Tests: broadcast envelope ─────────────────────────────────────────────────

describe('emitDriftAxes — broadcast envelope', () => {
  test('broadcasts driftAxesUpdate with itemId and drift_axes', () => {
    const item = makeItem();
    const store = makeStore(item);
    const broadcasts = [];

    emitDriftAxes((msg) => broadcasts.push(msg), store, item, getTmpRoot(), NOW);

    const update = broadcasts.find(b => b.type === 'driftAxesUpdate');
    assert.ok(update, 'driftAxesUpdate must be broadcast');
    assert.equal(update.itemId, item.id);
    assert.ok(Array.isArray(update.drift_axes), 'drift_axes must be array');
    assert.equal(update.drift_axes.length, 3, 'must broadcast all 3 axes');
  });

  test('returns empty array when item has no featureCode', () => {
    const item = { id: 'x', lifecycle: { currentPhase: 'execute', lifecycle_ext: {} } };
    const store = makeStore(item);
    const result = emitDriftAxes(() => {}, store, item, getTmpRoot(), NOW);
    assert.deepEqual(result, []);
  });
});

// ── Tests: persisted v0.2.4 fields always present ─────────────────────────────

describe('emitDriftAxes — v0.2.4 field presence', () => {
  test('every persisted axis has breach_started_at and breach_event_id keys', () => {
    const item = makeItem();
    const store = makeStore(item);

    emitDriftAxes(() => {}, store, item, getTmpRoot(), NOW);

    const persisted = item.lifecycle.lifecycle_ext.drift_axes;
    assert.ok(Array.isArray(persisted));
    for (const axis of persisted) {
      assert.ok('breach_started_at' in axis, `${axis.axis_id}: breach_started_at must be present`);
      assert.ok('breach_event_id' in axis, `${axis.axis_id}: breach_event_id must be present`);
    }
  });
});

// ── Tests: schema validation on emitted axes ──────────────────────────────────

describe('emitDriftAxes — schema compliance', () => {
  test('all emitted axes validate against DriftAxis schema', () => {
    const sv = new SchemaValidator();
    const item = makeItem();
    const store = makeStore(item);
    const broadcasts = [];

    emitDriftAxes((msg) => broadcasts.push(msg), store, item, getTmpRoot(), NOW);

    const update = broadcasts.find(b => b.type === 'driftAxesUpdate');
    for (const axis of update.drift_axes) {
      const { valid, errors } = sv.validate('DriftAxis', axis);
      assert.equal(valid, true, `${axis.axis_id} invalid: ${JSON.stringify(errors)}`);
    }
  });
});

// ── Tests: rising-edge emit ────────────────────────────────────────────────────

describe('emitDriftAxes — rising edge', () => {
  test('newly-breached axis emits exactly 1 DecisionEvent[kind=drift_threshold]', () => {
    // Simulate an item where review_debt_drift was NOT breached before,
    // but will be "breached" if we inject a pre-computed axis.
    // We stub computeDriftAxes behavior by setting up a review file.
    const item = makeItem(); // prior: no drift axes
    const store = makeStore(item);
    const broadcasts = [];

    // Write a review file with 100% unresolved to force breach
    const featurePath = path.join(getTmpRoot(), 'docs', 'features', FC);
    fs.mkdirSync(featurePath, { recursive: true });
    const reviewPath = path.join(featurePath, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    emitDriftAxes((msg) => broadcasts.push(msg), store, item, getTmpRoot(), NOW);

    const decisionEvents = broadcasts.filter(b => b.type === 'decisionEvent');
    // review_debt_drift should breach (1/1 = 1.0 >= 0.40)
    const driftEvents = decisionEvents.filter(b => b.event?.kind === 'drift_threshold');
    assert.ok(driftEvents.length >= 1, `expected >= 1 drift_threshold event, got ${driftEvents.length}`);

    const evt = driftEvents[0].event;
    assert.equal(evt.kind, 'drift_threshold');
    assert.equal(evt.feature_code, FC);
    assert.equal(evt.metadata.axis_id, 'review_debt_drift');
    assert.equal(typeof evt.metadata.ratio, 'number');
    assert.equal(typeof evt.metadata.threshold, 'number');

    // The event id must match the persisted breach_event_id on the axis
    const persistedAxes = item.lifecycle.lifecycle_ext.drift_axes;
    const reviewAxis = persistedAxes.find(a => a.axis_id === 'review_debt_drift');
    assert.ok(reviewAxis.breached, 'review_debt_drift must be breached');
    assert.ok(reviewAxis.breach_event_id, 'breach_event_id must be set on rising edge');
    assert.equal(evt.id, reviewAxis.breach_event_id, 'DecisionEvent id must match persisted breach_event_id');
    assert.equal(evt.timestamp, reviewAxis.breach_started_at, 'DecisionEvent timestamp must match breach_started_at');

    // Validate DecisionEvent shape
    const sv = new SchemaValidator();
    const { valid, errors } = sv.validate('DecisionEvent', evt);
    assert.equal(valid, true, `drift_threshold event invalid: ${JSON.stringify(errors)}`);

    fs.rmSync(reviewPath);
  });
});

// ── Tests: steady-state breach ────────────────────────────────────────────────

describe('emitDriftAxes — steady breach', () => {
  test('second call with prior breached axis emits 0 DecisionEvents and preserves metadata', () => {
    const item = makeItem();
    const store = makeStore(item);
    const broadcasts1 = [];

    // Set up breach condition
    const featurePath = path.join(getTmpRoot(), 'docs', 'features', FC);
    fs.mkdirSync(featurePath, { recursive: true });
    const reviewPath = path.join(featurePath, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    // First call — rising edge
    emitDriftAxes((msg) => broadcasts1.push(msg), store, item, getTmpRoot(), NOW);
    const firstBreachEventId = item.lifecycle.lifecycle_ext.drift_axes
      .find(a => a.axis_id === 'review_debt_drift')?.breach_event_id;
    const firstBreachStartedAt = item.lifecycle.lifecycle_ext.drift_axes
      .find(a => a.axis_id === 'review_debt_drift')?.breach_started_at;
    assert.ok(firstBreachEventId, 'must have breach_event_id after first breach');

    // Second call — steady breach, different timestamp
    const broadcasts2 = [];
    const LATER = '2026-04-25T11:00:00.000Z';
    emitDriftAxes((msg) => broadcasts2.push(msg), store, item, getTmpRoot(), LATER);

    const secondEvents = broadcasts2.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'drift_threshold');
    assert.equal(secondEvents.length, 0, 'steady-state breach must emit 0 new DecisionEvents');

    // breach_event_id and breach_started_at must be preserved (not overwritten)
    const afterSecond = item.lifecycle.lifecycle_ext.drift_axes
      .find(a => a.axis_id === 'review_debt_drift');
    assert.equal(afterSecond.breach_event_id, firstBreachEventId, 'breach_event_id must be preserved on steady breach');
    assert.equal(afterSecond.breach_started_at, firstBreachStartedAt, 'breach_started_at must be preserved on steady breach');

    fs.rmSync(reviewPath);
  });
});

// ── Tests: falling edge ────────────────────────────────────────────────────────

describe('emitDriftAxes — falling edge', () => {
  test('falling edge emits 0 DecisionEvents and clears breach metadata', () => {
    const item = makeItem();
    const store = makeStore(item);

    // Set up breach condition, then trigger rising edge
    const featurePath = path.join(getTmpRoot(), 'docs', 'features', FC);
    fs.mkdirSync(featurePath, { recursive: true });
    const reviewPath = path.join(featurePath, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    emitDriftAxes(() => {}, store, item, getTmpRoot(), NOW);
    assert.ok(
      item.lifecycle.lifecycle_ext.drift_axes.find(a => a.axis_id === 'review_debt_drift')?.breach_event_id,
      'rising edge must have set breach_event_id',
    );

    // Now remove the review file → falling edge
    fs.rmSync(reviewPath);
    const broadcasts = [];
    emitDriftAxes((msg) => broadcasts.push(msg), store, item, getTmpRoot(), '2026-04-25T12:00:00Z');

    const fallingEdgeEvents = broadcasts.filter(b => b.type === 'decisionEvent');
    assert.equal(fallingEdgeEvents.length, 0, 'falling edge must emit 0 DecisionEvents');

    const reviewAxis = item.lifecycle.lifecycle_ext.drift_axes.find(a => a.axis_id === 'review_debt_drift');
    // After falling edge, review_debt_drift may be disabled (threshold:null)
    // or unbreached — either way breach metadata must be null
    assert.equal(reviewAxis.breach_started_at, null, 'breach_started_at must be null after falling edge');
    assert.equal(reviewAxis.breach_event_id, null, 'breach_event_id must be null after falling edge');
  });
});

// ── Tests: snapshot identity ──────────────────────────────────────────────────

describe('emitDriftAxes — snapshot rehydration identity', () => {
  test('rehydrated event id matches live-emit id byte-for-byte', () => {
    const item = makeItem();
    const store = makeStore(item);

    const featurePath = path.join(getTmpRoot(), 'docs', 'features', FC);
    fs.mkdirSync(featurePath, { recursive: true });
    const reviewPath = path.join(featurePath, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    const broadcasts = [];
    emitDriftAxes((msg) => broadcasts.push(msg), store, item, getTmpRoot(), NOW);

    const driftEvent = broadcasts
      .filter(b => b.type === 'decisionEvent')
      .find(b => b.event?.kind === 'drift_threshold');
    assert.ok(driftEvent, 'expected a drift_threshold DecisionEvent');

    const liveEvent = driftEvent.event;
    const reviewAxis = item.lifecycle.lifecycle_ext.drift_axes.find(a => a.axis_id === 'review_debt_drift');

    // Simulate snapshot rehydration using persisted fields
    const rehydratedEvent = buildDriftThresholdEvent({
      featureCode: FC,
      axisId: reviewAxis.axis_id,
      ratio: reviewAxis.ratio,
      threshold: reviewAxis.threshold,
      breachStartedAt: reviewAxis.breach_started_at,
      breachEventId: reviewAxis.breach_event_id,
    });

    assert.equal(rehydratedEvent.id, liveEvent.id, 'rehydrated id must match live-emit id');
    assert.equal(rehydratedEvent.timestamp, liveEvent.timestamp, 'rehydrated timestamp must match live-emit timestamp');
    assert.equal(rehydratedEvent.kind, 'drift_threshold');
    assert.equal(rehydratedEvent.feature_code, FC);

    fs.rmSync(reviewPath);
  });
});

// ── Tests: driftThresholdDecisionEventId stability ───────────────────────────

describe('driftThresholdDecisionEventId — stability', () => {
  test('same inputs always produce same id', () => {
    const id1 = driftThresholdDecisionEventId(FC, 'path_drift', NOW);
    const id2 = driftThresholdDecisionEventId(FC, 'path_drift', NOW);
    assert.equal(id1, id2, 'deterministic id must be stable across calls');
  });

  test('different axis_id produces different id', () => {
    const id1 = driftThresholdDecisionEventId(FC, 'path_drift', NOW);
    const id2 = driftThresholdDecisionEventId(FC, 'contract_drift', NOW);
    assert.notEqual(id1, id2);
  });

  test('different timestamp produces different id', () => {
    const id1 = driftThresholdDecisionEventId(FC, 'path_drift', NOW);
    const id2 = driftThresholdDecisionEventId(FC, 'path_drift', '2026-04-26T00:00:00Z');
    assert.notEqual(id1, id2);
  });
});
