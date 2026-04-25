/**
 * decision-event-emit.test.js — Builder shape + schema validation.
 *
 * COMP-OBS-TIMELINE: validates each builder's output against SchemaValidator
 * DecisionEvent definition, covering metadata-closure invariants from
 * COMP-OBS-CONTRACT v0.2.3.
 *
 * Run: node --test test/decision-event-emit.test.js
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  emitDecisionEvent,
  buildPhaseTransitionEvent,
  buildIterationEvent,
} = await import(`${REPO_ROOT}/server/decision-event-emit.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const v = new SchemaValidator();

const BASE_TS = '2026-04-24T10:00:00Z';

// ── buildPhaseTransitionEvent ────────────────────────────────────────────────

describe('buildPhaseTransitionEvent', () => {
  test('produces valid DecisionEvent shape (schema)', () => {
    const ev = buildPhaseTransitionEvent({
      featureCode: 'TEST-1',
      from: 'blueprint',
      to: 'plan',
      outcome: 'approved',
      agent_id: null,
      timestamp: BASE_TS,
    });
    const r = v.validate('DecisionEvent', ev);
    assert.equal(r.valid, true, `schema errors: ${JSON.stringify(r.errors)}`);
  });

  test('kind is phase_transition', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'blueprint', to: 'plan', timestamp: BASE_TS });
    assert.equal(ev.kind, 'phase_transition');
  });

  test('metadata contains from_phase and to_phase (closed — no extra fields)', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'blueprint', to: 'plan', timestamp: BASE_TS });
    assert.deepEqual(Object.keys(ev.metadata).sort(), ['from_phase', 'to_phase']);
    assert.equal(ev.metadata.from_phase, 'blueprint');
    assert.equal(ev.metadata.to_phase, 'plan');
  });

  test('roles contains PRODUCER', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'blueprint', to: 'plan', timestamp: BASE_TS });
    assert.ok(ev.roles.some(r => r.name === 'PRODUCER'), 'expected PRODUCER role');
  });

  test('agent_id propagated into roles when provided', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'plan', to: 'execute', agent_id: 'op-ruze', timestamp: BASE_TS });
    const producer = ev.roles.find(r => r.name === 'PRODUCER');
    assert.equal(producer.agent_id, 'op-ruze');
  });

  test('id is deterministic for same inputs', () => {
    const a = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'blueprint', to: 'plan', timestamp: BASE_TS });
    const b = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'blueprint', to: 'plan', timestamp: BASE_TS });
    assert.equal(a.id, b.id);
  });

  test('null from is allowed (lifecycleStarted — no previous phase)', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: null, to: 'explore_design', timestamp: BASE_TS });
    const r = v.validate('DecisionEvent', ev);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    // from_phase = 'null' string (the schema just requires a string)
    assert.ok(typeof ev.metadata.from_phase === 'string');
  });
});

// ── buildIterationEvent ──────────────────────────────────────────────────────

describe('buildIterationEvent', () => {
  test('produces valid DecisionEvent shape — review start', () => {
    const ev = buildIterationEvent({
      featureCode: 'TEST-1',
      loopId: 'iter-1699000000000',
      loopType: 'review',
      stage: 'start',
      attempt: 0,
      outcome: 'retry',
      timestamp: BASE_TS,
    });
    const r = v.validate('DecisionEvent', ev);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('produces valid DecisionEvent shape — coverage complete pass', () => {
    const ev = buildIterationEvent({
      featureCode: 'TEST-1',
      loopId: 'iter-1699000000001',
      loopType: 'coverage',
      stage: 'complete',
      attempt: 4,
      outcome: 'pass',
      timestamp: BASE_TS,
    });
    const r = v.validate('DecisionEvent', ev);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('kind is iteration', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'start', timestamp: BASE_TS });
    assert.equal(ev.kind, 'iteration');
  });

  test('metadata.iteration_id equals loopId', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-007', loopType: 'review', stage: 'start', timestamp: BASE_TS });
    assert.equal(ev.metadata.iteration_id, 'iter-007');
  });

  test('metadata is closed (only schema-defined fields)', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'start', timestamp: BASE_TS });
    const allowed = new Set(['iteration_id', 'attempt', 'outcome']);
    for (const k of Object.keys(ev.metadata)) {
      assert.ok(allowed.has(k), `unexpected metadata key: ${k}`);
    }
  });

  test('review loop → REVIEWER role', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'start', timestamp: BASE_TS });
    assert.ok(ev.roles.some(r => r.name === 'REVIEWER'));
  });

  test('coverage loop → IMPLEMENTER role', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'coverage', stage: 'start', timestamp: BASE_TS });
    assert.ok(ev.roles.some(r => r.name === 'IMPLEMENTER'));
  });

  test('unknown loopType → empty roles array', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'other', stage: 'start', timestamp: BASE_TS });
    assert.deepEqual(ev.roles, []);
  });

  test('id is deterministic for same loopId + stage', () => {
    const a = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'complete', timestamp: BASE_TS });
    const b = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'complete', timestamp: BASE_TS });
    assert.equal(a.id, b.id);
  });

  test('start and complete have different ids for the same loopId', () => {
    const s = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'start', timestamp: BASE_TS });
    const c = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'complete', timestamp: BASE_TS });
    assert.notEqual(s.id, c.id);
  });

  test('abort outcome validates (outcome=aborted is not in schema; use fail)', () => {
    // The schema's outcome enum for iteration is: pass | fail | retry
    // "aborted" maps to "fail" at build time
    const ev = buildIterationEvent({
      featureCode: 'TEST-1',
      loopId: 'iter-1',
      loopType: 'coverage',
      stage: 'complete',
      outcome: 'aborted',
      timestamp: BASE_TS,
    });
    const r = v.validate('DecisionEvent', ev);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});

// ── emitDecisionEvent ────────────────────────────────────────────────────────

describe('emitDecisionEvent', () => {
  let broadcasts;
  let broadcastMessage;

  beforeEach(() => {
    broadcasts = [];
    broadcastMessage = (msg) => broadcasts.push(msg);
  });

  test('wraps event in {type: decisionEvent, event: ...} envelope', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: 'plan', to: 'execute', timestamp: BASE_TS });
    emitDecisionEvent(broadcastMessage, ev);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'decisionEvent');
    assert.deepEqual(broadcasts[0].event, ev);
  });

  test('broadcasts exactly once per call', () => {
    const ev = buildPhaseTransitionEvent({ featureCode: 'TEST-1', from: null, to: 'explore_design', timestamp: BASE_TS });
    emitDecisionEvent(broadcastMessage, ev);
    emitDecisionEvent(broadcastMessage, ev);
    assert.equal(broadcasts.length, 2, 'each call emits one broadcast');
  });

  test('envelope matches BRANCH pattern exactly', () => {
    const ev = buildIterationEvent({ featureCode: 'TEST-1', loopId: 'iter-1', loopType: 'review', stage: 'start', timestamp: BASE_TS });
    emitDecisionEvent(broadcastMessage, ev);
    const msg = broadcasts[0];
    // Must have exactly these top-level keys
    assert.deepEqual(Object.keys(msg).sort(), ['event', 'type']);
    // event must have at minimum the required schema fields
    assert.ok('id' in msg.event);
    assert.ok('feature_code' in msg.event);
    assert.ok('timestamp' in msg.event);
    assert.ok('kind' in msg.event);
    assert.ok('title' in msg.event);
    assert.ok('metadata' in msg.event);
  });
});
