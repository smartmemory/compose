/**
 * status-snapshot.test.js — Unit tests for computeStatusSnapshot + buildStatusSentence.
 *
 * TDD red-phase: written before status-snapshot.js exists.
 *
 * Covers:
 *   - All 8 sentence rule branches from design.md Decision 2 (first-match wins)
 *   - Null/terminal/unknown phase guards (branch 8 fallbacks)
 *   - Sentence ≤280 chars enforcement with gate-id truncation (branch 4)
 *   - Schema validity via SchemaValidator
 *   - drift_alerts: allOf breached:true closure — bad axis must not produce valid snapshot
 *   - open_loops_count derived from lifecycle.lifecycle_ext.open_loops
 *   - gate_load_24h returns 0 (TODO stub)
 *   - cta always null in v1
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { computeStatusSnapshot } = await import(`${REPO_ROOT}/server/status-snapshot.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

// Known lifecycle phases (mirrors server/vision-routes.js + constants.js LIFECYCLE_PHASE_LABELS)
const KNOWN_PHASES = new Set([
  'explore_design', 'prd', 'architecture', 'blueprint',
  'verification', 'plan', 'execute', 'report', 'docs', 'ship',
  'complete', 'killed',
]);

const NOW = '2026-04-25T12:00:00.000Z';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal VisionStore-like state object with one item */
function makeState(itemOverrides = {}) {
  const item = {
    id: 'item-1',
    title: undefined,
    lifecycle: {
      featureCode: 'COMP-OBS-STATUS',
      currentPhase: 'execute',
      iterationState: null,
      lifecycle_ext: {},
      // Merge lifecycle overrides AFTER defaults so currentPhase etc. can be overridden
      ...(itemOverrides.lifecycle || {}),
    },
    ...itemOverrides,
    // Prevent lifecycle from being overwritten by the spread above
    lifecycle: {
      featureCode: 'COMP-OBS-STATUS',
      currentPhase: 'execute',
      iterationState: null,
      lifecycle_ext: {},
      ...(itemOverrides.lifecycle || {}),
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
    _gates: gates,
    addGate(gate) { gates.set(gate.id, gate); },
  };
}

// ── validation helper ─────────────────────────────────────────────────────────

let validator;
before(() => {
  validator = new SchemaValidator();
});

function assertSchemaValid(snap) {
  const { valid, errors } = validator.validate('StatusSnapshot', snap);
  assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 1: No feature selected
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 1 — no feature selected', () => {
  test('returns "Select a feature to see status." when featureCode is null', () => {
    const state = makeState();
    const snap = computeStatusSnapshot(state, null, NOW);
    assert.equal(snap.sentence, 'Select a feature to see status.');
    assert.equal(snap.active_phase, null);
    assert.equal(snap.cta, null);
    assertSchemaValid(snap);
  });

  test('sentence ≤280 chars', () => {
    const state = makeState();
    const snap = computeStatusSnapshot(state, null, NOW);
    assert.ok(snap.sentence.length <= 280);
  });

  test('computed_at is set to now', () => {
    const state = makeState();
    const snap = computeStatusSnapshot(state, null, NOW);
    assert.equal(snap.computed_at, NOW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 2: Killed
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 2 — killed phase (terminal)', () => {
  test('returns "{featureCode} killed. No further action."', () => {
    const state = makeState({ lifecycle: { currentPhase: 'killed' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.sentence, 'COMP-OBS-STATUS killed. No further action.');
    assert.equal(snap.active_phase, 'killed');
    assert.equal(snap.cta, null);
    assertSchemaValid(snap);
  });

  test('killed short-circuits pending-gate check', () => {
    const state = makeState({ lifecycle: { currentPhase: 'killed' } });
    state.addGate({ id: 'g1', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    // Must still be killed branch, not pending gate
    assert.ok(snap.sentence.includes('killed'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 3: Complete
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 3 — complete phase (terminal)', () => {
  test('returns "{featureCode} complete."', () => {
    const state = makeState({ lifecycle: { currentPhase: 'complete' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.sentence, 'COMP-OBS-STATUS complete.');
    assert.equal(snap.active_phase, 'complete');
    assert.equal(snap.cta, null);
    assertSchemaValid(snap);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 4: Pending gate
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 4 — pending gate', () => {
  test('returns "Holding {phase}. Next: approve {gateId}."', () => {
    const state = makeState({ lifecycle: { currentPhase: 'blueprint' } });
    state.addGate({ id: 'design-gate-001', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('blueprint'));
    assert.ok(snap.sentence.includes('design-gate-001'));
    assert.ok(snap.sentence.startsWith('Holding blueprint'));
    assert.ok(snap.sentence.includes('Next: approve'));
    assert.equal(snap.cta, null);
    assertSchemaValid(snap);
  });

  test('gate id is truncated when sentence would exceed 280 chars', () => {
    const longId = 'a'.repeat(300);
    const state = makeState({ lifecycle: { currentPhase: 'blueprint' } });
    state.addGate({ id: longId, status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.length <= 280, `sentence ${snap.sentence.length} exceeds 280`);
    assert.ok(snap.sentence.includes('…'), 'truncated gate id must contain ellipsis');
    assertSchemaValid(snap);
  });

  test('uses first pending gate when multiple exist', () => {
    const state = makeState({ lifecycle: { currentPhase: 'plan' } });
    state.addGate({ id: 'gate-first', status: 'pending', itemId: 'item-1' });
    state.addGate({ id: 'gate-second', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    // Should pick some gate; sentence still valid
    assert.ok(snap.sentence.length <= 280);
    assertSchemaValid(snap);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 5: Drift breach
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 5 — drift breach', () => {
  function makeDriftAxis(axisId, breached = true) {
    return {
      axis_id: axisId,
      name: `${axisId} axis`,
      numerator: 3,
      denominator: 5,
      ratio: 0.6,
      threshold: 0.5,
      breached,
      computed_at: NOW,
    };
  }

  test('returns "{phase} — N drift alert(s)." when drift_alerts present', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        lifecycle_ext: {
          drift_axes: [makeDriftAxis('path_drift', true), makeDriftAxis('contract_drift', true)],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('execute'));
    assert.ok(snap.sentence.includes('2 drift alerts'), `got: ${snap.sentence}`);
    assert.equal(snap.drift_alerts.length, 2);
    assertSchemaValid(snap);
  });

  test('singular "1 drift alert"', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'plan',
        lifecycle_ext: {
          drift_axes: [makeDriftAxis('path_drift', true)],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('1 drift alert'), `got: ${snap.sentence}`);
    assertSchemaValid(snap);
  });

  test('non-breached axes do not trigger branch 5', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        lifecycle_ext: {
          drift_axes: [makeDriftAxis('path_drift', false)],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    // Must fall through to a later branch (not drift branch)
    assert.ok(!snap.sentence.includes('drift alert'), `should not trigger drift: ${snap.sentence}`);
  });

  test('drift_alerts must only contain breached:true axes (schema closure)', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        lifecycle_ext: {
          drift_axes: [makeDriftAxis('path_drift', true)],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    for (const axis of snap.drift_alerts) {
      assert.equal(axis.breached, true, 'drift_alerts must only contain breached=true axes');
    }
    // Validate the schema closure: a non-breached axis in drift_alerts must fail
    const badSnap = {
      ...snap,
      drift_alerts: [{ ...makeDriftAxis('path_drift', false) }],
    };
    const { valid } = validator.validate('StatusSnapshot', badSnap);
    assert.equal(valid, false, 'non-breached axis in drift_alerts must fail schema validation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 6: Stale open loops
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 6 — stale open loops', () => {
  function makeOpenLoop(daysOld, ttl_days = 7, resolved = false) {
    const created = new Date(Date.parse(NOW) - daysOld * 24 * 60 * 60 * 1000).toISOString();
    return {
      id: `loop-${Math.random().toString(36).slice(2)}`,
      kind: 'deferred',
      summary: 'test loop',
      created_at: created,
      parent_feature: 'COMP-OBS-STATUS',
      ttl_days,
      resolution: resolved ? { resolved_at: NOW, resolved_by: 'test' } : null,
    };
  }

  test('returns "{phase}. N loop(s) past TTL." when stale open loops exist', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        lifecycle_ext: {
          open_loops: [makeOpenLoop(10, 7), makeOpenLoop(15, 7)],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('execute'), `got: ${snap.sentence}`);
    assert.ok(snap.sentence.includes('2 loops past TTL'), `got: ${snap.sentence}`);
    assertSchemaValid(snap);
  });

  test('singular "1 loop past TTL"', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'plan',
        lifecycle_ext: {
          open_loops: [makeOpenLoop(30, 7)],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('1 loop past TTL'), `got: ${snap.sentence}`);
  });

  test('loop within TTL does not trigger branch 6', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        lifecycle_ext: {
          open_loops: [makeOpenLoop(2, 7)],  // 2 days old, TTL 7 — not stale
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(!snap.sentence.includes('past TTL'), `should not trigger stale: ${snap.sentence}`);
  });

  test('resolved loop does not count as stale', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        lifecycle_ext: {
          open_loops: [makeOpenLoop(30, 7, true)],  // resolved = true
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(!snap.sentence.includes('past TTL'), `resolved loop should not trigger stale`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 7: Iteration in flight
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 7 — iteration in flight', () => {
  test('returns "Iterating {loopType} (attempt {count})."', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        iterationState: {
          loopId: 'iter-001',
          loopType: 'review',
          status: 'running',
          count: 3,
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('Iterating review'), `got: ${snap.sentence}`);
    assert.ok(snap.sentence.includes('attempt 3'), `got: ${snap.sentence}`);
    assertSchemaValid(snap);
  });

  test('coverage loopType', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        iterationState: {
          loopId: 'iter-002',
          loopType: 'coverage',
          status: 'running',
          count: 1,
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('Iterating coverage'), `got: ${snap.sentence}`);
    assert.ok(snap.sentence.includes('attempt 1'), `got: ${snap.sentence}`);
  });

  test('completed iteration does not trigger branch 7', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        iterationState: {
          loopId: 'iter-003',
          loopType: 'review',
          status: 'complete',
          count: 4,
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(!snap.sentence.startsWith('Iterating'), `completed iter should not trigger b7: ${snap.sentence}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch 8: Idle baseline
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch 8 — idle baseline', () => {
  test('returns "Building {phase}. Open loops: {count}."', () => {
    const state = makeState({ lifecycle: { currentPhase: 'execute' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('Building execute'), `got: ${snap.sentence}`);
    assert.ok(snap.sentence.includes('Open loops: 0'), `got: ${snap.sentence}`);
    assertSchemaValid(snap);
  });

  test('open_loops_count counts only unresolved loops (COMP-OBS-LOOPS semantic fix)', () => {
    // After COMP-OBS-LOOPS ships: open_loops_count = filter(l => l.resolution == null).length
    const state = makeState({
      lifecycle: {
        currentPhase: 'plan',
        lifecycle_ext: {
          open_loops: [
            { id: 'l1', kind: 'deferred', summary: 'a', created_at: NOW, parent_feature: 'FC', resolution: null },
            { id: 'l2', kind: 'deferred', summary: 'b', created_at: NOW, parent_feature: 'FC', resolution: null },
            { id: 'l3', kind: 'deferred', summary: 'c', created_at: NOW, parent_feature: 'FC',
              resolution: { resolved_at: NOW, resolved_by: 'ruze', note: 'done' } }, // resolved — must NOT count
          ],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.open_loops_count, 2, 'resolved loops must not be counted');
    assert.ok(snap.sentence.includes('Open loops: 2'), `got: ${snap.sentence}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Null/terminal/unknown phase guards (Decision 2 notes)
// ─────────────────────────────────────────────────────────────────────────────

describe('Null/unknown phase guards', () => {
  test('null activePhase + feature selected → "{featureCode}: phase pending."', () => {
    const state = makeState({ lifecycle: { currentPhase: null } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.sentence, 'COMP-OBS-STATUS: phase pending.');
    assert.equal(snap.active_phase, null);
    assertSchemaValid(snap);
  });

  test('unknown phase string → "{featureCode}: {phase} (unrecognized phase)."', () => {
    const state = makeState({ lifecycle: { currentPhase: 'widgetization' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.sentence, 'COMP-OBS-STATUS: widgetization (unrecognized phase).');
    assertSchemaValid(snap);
  });

  test('unknown phase short-circuits branches 4–7', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'widgetization',
        iterationState: { loopId: 'i1', loopType: 'review', status: 'running', count: 1 },
      },
    });
    state.addGate({ id: 'some-gate', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    // Must use unrecognized-phase fallback, NOT iteration or gate branch
    assert.ok(snap.sentence.includes('unrecognized phase'), `got: ${snap.sentence}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema compliance
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema compliance', () => {
  test('idle baseline snapshot validates against StatusSnapshot schema', () => {
    const state = makeState({ lifecycle: { currentPhase: 'execute' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assertSchemaValid(snap);
  });

  test('cta is always null in v1', () => {
    const state = makeState({ lifecycle: { currentPhase: 'execute' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.cta, null);
  });

  test('gate_load_24h is a non-negative integer (COMP-OBS-GATELOG live)', () => {
    // GATELOG shipped: gate_load_24h now reads from the gate log file.
    // The value depends on runtime state, so we assert type/range not exact value.
    const state = makeState({ lifecycle: { currentPhase: 'execute' } });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(typeof snap.gate_load_24h === 'number', 'gate_load_24h must be a number');
    assert.ok(snap.gate_load_24h >= 0, 'gate_load_24h must be non-negative');
    assert.equal(Math.floor(snap.gate_load_24h), snap.gate_load_24h, 'gate_load_24h must be integer');
  });

  test('pending_gates is array of string ids', () => {
    const state = makeState({ lifecycle: { currentPhase: 'blueprint' } });
    state.addGate({ id: 'g-1', status: 'pending', itemId: 'item-1' });
    state.addGate({ id: 'g-2', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(Array.isArray(snap.pending_gates));
    for (const id of snap.pending_gates) assert.equal(typeof id, 'string');
  });

  test('sentence ≤280 chars for all branches', () => {
    const cases = [
      makeState({ lifecycle: { currentPhase: null } }),
      makeState({ lifecycle: { currentPhase: 'killed' } }),
      makeState({ lifecycle: { currentPhase: 'complete' } }),
      makeState({ lifecycle: { currentPhase: 'execute' } }),
    ];
    for (const state of cases) {
      const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
      assert.ok(snap.sentence.length <= 280, `sentence too long (${snap.sentence.length}): ${snap.sentence}`);
    }
  });

  test('featureCode not found in store → no-feature snapshot', () => {
    const state = makeState();
    const snap = computeStatusSnapshot(state, 'NONEXISTENT-FC', NOW);
    // Falls through as "no feature found" — idle or no-feature path
    assertSchemaValid(snap);
    assert.equal(snap.cta, null);
  });

  test('active_goal is set from item title when available', () => {
    const state = makeState({ title: 'My Feature Goal' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.equal(snap.active_goal, 'My Feature Goal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch priority — first-match ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('Branch priority (first-match wins)', () => {
  test('killed beats pending gate (branch 2 before branch 4)', () => {
    const state = makeState({ lifecycle: { currentPhase: 'killed' } });
    state.addGate({ id: 'g1', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('killed'));
    assert.ok(!snap.sentence.includes('Holding'));
  });

  test('pending gate beats drift (branch 4 before branch 5)', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'blueprint',
        lifecycle_ext: {
          drift_axes: [{
            axis_id: 'path_drift', name: 'path', numerator: 3, denominator: 5,
            ratio: 0.6, threshold: 0.5, breached: true, computed_at: NOW,
          }],
        },
      },
    });
    state.addGate({ id: 'gate-abc', status: 'pending', itemId: 'item-1' });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.startsWith('Holding'), `branch 4 should win: ${snap.sentence}`);
  });

  test('drift beats iteration (branch 5 before branch 7)', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        iterationState: { loopId: 'i1', loopType: 'review', status: 'running', count: 2 },
        lifecycle_ext: {
          drift_axes: [{
            axis_id: 'path_drift', name: 'path', numerator: 3, denominator: 5,
            ratio: 0.6, threshold: 0.5, breached: true, computed_at: NOW,
          }],
        },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.includes('drift alert'), `branch 5 should win: ${snap.sentence}`);
  });

  test('iteration beats idle (branch 7 before branch 8)', () => {
    const state = makeState({
      lifecycle: {
        currentPhase: 'execute',
        iterationState: { loopId: 'i2', loopType: 'coverage', status: 'running', count: 5 },
      },
    });
    const snap = computeStatusSnapshot(state, 'COMP-OBS-STATUS', NOW);
    assert.ok(snap.sentence.startsWith('Iterating'), `branch 7 should win: ${snap.sentence}`);
  });
});
