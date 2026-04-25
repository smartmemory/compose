/**
 * decision-events-snapshot.test.js — deriveDecisionEvents re-derivation tests.
 *
 * COMP-OBS-TIMELINE A6: deriveDecisionEvents walks persisted lifecycle state and
 * reconstructs the same DecisionEvent ids that live emitters would have produced.
 * Re-derive == identity.
 *
 * Run: node --test test/decision-events-snapshot.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { deriveDecisionEvents } = await import(`${REPO_ROOT}/server/decision-events-snapshot.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);
const {
  phaseTransitionDecisionEventId,
  iterationDecisionEventId,
  branchDecisionEventId,
} = await import(`${REPO_ROOT}/server/decision-event-id.js`);

const v = new SchemaValidator();

const FC = 'COMP-TEST-1';

// ── fixture helpers ───────────────────────────────────────────────────────────

function makeState(overrides = {}) {
  return {
    items: new Map(),
    ...overrides,
  };
}

function makeItem({ featureCode = FC, phaseHistory = [], iterationState = null, branchLineage = null } = {}) {
  // Production stores lineage at item.lifecycle.lifecycle_ext.branch_lineage
  // (see vision-store.updateLifecycleExt). Test fixture mirrors that exactly.
  const lifecycle = {
    featureCode,
    currentPhase: 'execute',
    phaseHistory,
    iterationState,
    lifecycle_ext: branchLineage ? { branch_lineage: branchLineage } : {},
  };
  return { lifecycle };
}

function makePhaseHistory(...transitions) {
  return transitions.map(([from, to, ts]) => ({
    from: from ?? null,
    to,
    outcome: null,
    timestamp: ts || `2026-04-24T${String(transitions.indexOf([from, to, ts])).padStart(2, '0')}:00:00Z`,
  }));
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('deriveDecisionEvents — empty state', () => {
  test('returns empty array when no items in state', () => {
    const state = { items: new Map() };
    const events = deriveDecisionEvents(state, FC);
    assert.deepEqual(events, []);
  });

  test('returns empty array when item has no lifecycle', () => {
    const state = { items: new Map([['item-1', { lifecycle: null }]]) };
    const events = deriveDecisionEvents(state, FC);
    assert.deepEqual(events, []);
  });

  test('returns empty array when item featureCode does not match', () => {
    const item = makeItem({ featureCode: 'OTHER-1' });
    const state = { items: new Map([['item-1', item]]) };
    const events = deriveDecisionEvents(state, FC);
    assert.deepEqual(events, []);
  });
});

describe('deriveDecisionEvents — phase_transition events', () => {
  test('derives one phase_transition event per phaseHistory entry', () => {
    const phaseHistory = [
      { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' },
      { from: 'explore_design', to: 'prd', outcome: 'approved', timestamp: '2026-04-24T11:00:00Z' },
    ];
    const item = makeItem({ featureCode: FC, phaseHistory });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const ptEvents = events.filter(e => e.kind === 'phase_transition');
    assert.equal(ptEvents.length, 2);
  });

  test('derived phase_transition ids match live emitter ids', () => {
    const ts1 = '2026-04-24T10:00:00Z';
    const ts2 = '2026-04-24T11:00:00Z';
    const phaseHistory = [
      { from: null, to: 'explore_design', outcome: null, timestamp: ts1 },
      { from: 'explore_design', to: 'prd', outcome: 'approved', timestamp: ts2 },
    ];
    const item = makeItem({ featureCode: FC, phaseHistory });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const ptEvents = events.filter(e => e.kind === 'phase_transition');

    const expectedId1 = phaseTransitionDecisionEventId(FC, null, 'explore_design', ts1);
    const expectedId2 = phaseTransitionDecisionEventId(FC, 'explore_design', 'prd', ts2);

    assert.ok(ptEvents.some(e => e.id === expectedId1), `expected id ${expectedId1}`);
    assert.ok(ptEvents.some(e => e.id === expectedId2), `expected id ${expectedId2}`);
  });

  test('all derived phase_transition events validate against schema', () => {
    const phaseHistory = [
      { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' },
      { from: 'explore_design', to: 'prd', outcome: null, timestamp: '2026-04-24T11:00:00Z' },
      { from: 'prd', to: 'killed', outcome: 'killed', timestamp: '2026-04-24T12:00:00Z' },
    ];
    const item = makeItem({ featureCode: FC, phaseHistory });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    for (const ev of events.filter(e => e.kind === 'phase_transition')) {
      const r = v.validate('DecisionEvent', ev);
      assert.equal(r.valid, true, `event ${ev.id}: ${JSON.stringify(r.errors)}`);
    }
  });
});

describe('deriveDecisionEvents — iteration events', () => {
  test('derives start + complete pair from completed iterationState', () => {
    const iterationState = {
      loopId: 'iter-001',
      loopType: 'review',
      status: 'complete',
      outcome: 'clean',
      count: 3,
      startedAt: '2026-04-24T10:00:00Z',
      completedAt: '2026-04-24T10:30:00Z',
    };
    const item = makeItem({ featureCode: FC, iterationState });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const iterEvents = events.filter(e => e.kind === 'iteration');
    assert.equal(iterEvents.length, 2, 'expected start + complete');
  });

  test('derived iteration ids match live emitter ids', () => {
    const loopId = 'iter-007';
    const iterationState = {
      loopId,
      loopType: 'coverage',
      status: 'complete',
      outcome: 'clean',
      count: 4,
      startedAt: '2026-04-24T10:00:00Z',
      completedAt: '2026-04-24T10:45:00Z',
    };
    const item = makeItem({ featureCode: FC, iterationState });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const iterEvents = events.filter(e => e.kind === 'iteration');

    const expectedStartId = iterationDecisionEventId(FC, loopId, 'start');
    const expectedCompleteId = iterationDecisionEventId(FC, loopId, 'complete');

    assert.ok(iterEvents.some(e => e.id === expectedStartId), `missing start id ${expectedStartId}`);
    assert.ok(iterEvents.some(e => e.id === expectedCompleteId), `missing complete id ${expectedCompleteId}`);
  });

  test('running iterationState yields only a start event', () => {
    const iterationState = {
      loopId: 'iter-running',
      loopType: 'review',
      status: 'running',
      outcome: null,
      count: 1,
      startedAt: '2026-04-24T10:00:00Z',
      completedAt: null,
    };
    const item = makeItem({ featureCode: FC, iterationState });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const iterEvents = events.filter(e => e.kind === 'iteration');
    assert.equal(iterEvents.length, 1, 'running loop: only start event');
    assert.ok(!iterEvents[0].metadata?.outcome, 'start event should have no outcome');
  });

  test('iteration events validate against schema', () => {
    const iterationState = {
      loopId: 'iter-schema',
      loopType: 'review',
      status: 'complete',
      outcome: 'max_reached',
      count: 5,
      startedAt: '2026-04-24T10:00:00Z',
      completedAt: '2026-04-24T11:00:00Z',
    };
    const item = makeItem({ featureCode: FC, iterationState });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    for (const ev of events.filter(e => e.kind === 'iteration')) {
      const r = v.validate('DecisionEvent', ev);
      assert.equal(r.valid, true, `event ${ev.id}: ${JSON.stringify(r.errors)}`);
    }
  });
});

describe('deriveDecisionEvents — branch events from branch_lineage', () => {
  test('derives branch events from completed branches', () => {
    const branches = [
      { branch_id: 'branch-aaa', fork_uuid: 'fork-1', feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:00:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000001', open_loops_produced: [] },
      { branch_id: 'branch-bbb', fork_uuid: 'fork-1', feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:01:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000002', open_loops_produced: [] },
    ];
    const item = makeItem({ featureCode: FC, branchLineage: { feature_code: FC, branches, emitted_event_ids: [], in_progress_siblings: [] } });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const branchEvents = events.filter(e => e.kind === 'branch');
    assert.equal(branchEvents.length, 2);
  });

  test('branches sharing fork_uuid rehydrate with sibling_branch_ids populated', () => {
    // Regression guard: earlier draft hardcoded sibling_branch_ids: []
    // on rehydrate. After a cold reconnect that means BRANCH compare-view
    // metrics that depend on sibling context render against an empty list
    // even though the live emitter populated it correctly.
    const branches = [
      { branch_id: 'branch-aaa', fork_uuid: 'fork-shared', feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:00:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000010', open_loops_produced: [] },
      { branch_id: 'branch-bbb', fork_uuid: 'fork-shared', feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:01:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000011', open_loops_produced: [] },
      // A third branch on a different fork must NOT appear as a sibling.
      { branch_id: 'branch-zzz', fork_uuid: 'fork-other', feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:02:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000012', open_loops_produced: [] },
    ];
    const item = makeItem({ featureCode: FC, branchLineage: { feature_code: FC, branches, emitted_event_ids: [], in_progress_siblings: [] } });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const aEvent = events.find(e => e.kind === 'branch' && e.metadata.branch_id === 'branch-aaa');
    const bEvent = events.find(e => e.kind === 'branch' && e.metadata.branch_id === 'branch-bbb');
    const zEvent = events.find(e => e.kind === 'branch' && e.metadata.branch_id === 'branch-zzz');

    assert.deepEqual(aEvent.metadata.sibling_branch_ids.sort(), ['branch-aaa', 'branch-bbb']);
    assert.deepEqual(bEvent.metadata.sibling_branch_ids.sort(), ['branch-aaa', 'branch-bbb']);
    // No fork siblings → empty array (not undefined).
    assert.deepEqual(zEvent.metadata.sibling_branch_ids, ['branch-zzz']);
  });

  test('a fork_uuid-null branch (root) rehydrates with empty sibling_branch_ids', () => {
    const branches = [
      { branch_id: 'lone', fork_uuid: null, feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:00:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000020', open_loops_produced: [] },
    ];
    const item = makeItem({ featureCode: FC, branchLineage: { feature_code: FC, branches, emitted_event_ids: [], in_progress_siblings: [] } });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const ev = events.find(e => e.kind === 'branch');
    assert.deepEqual(ev.metadata.sibling_branch_ids, []);
  });

  test('branch event ids match branchDecisionEventId', () => {
    const bid = 'branch-ccc';
    const branches = [
      { branch_id: bid, fork_uuid: null, feature_code: FC, state: 'complete',
        started_at: '2026-04-24T10:00:00Z', cc_session_id: 'sess-1', leaf_uuid: '00000000-0000-0000-0000-000000000003', open_loops_produced: [] },
    ];
    const item = makeItem({ featureCode: FC, branchLineage: { feature_code: FC, branches, emitted_event_ids: [], in_progress_siblings: [] } });
    const state = { items: new Map([['item-1', item]]) };

    const events = deriveDecisionEvents(state, FC);
    const branchEvents = events.filter(e => e.kind === 'branch');
    const expectedId = branchDecisionEventId(FC, bid);
    assert.ok(branchEvents.some(e => e.id === expectedId), `expected id ${expectedId}`);
  });
});

describe('deriveDecisionEvents — idempotent re-derivation', () => {
  test('calling twice returns same event ids', () => {
    const phaseHistory = [
      { from: null, to: 'explore_design', outcome: null, timestamp: '2026-04-24T10:00:00Z' },
    ];
    const item = makeItem({ featureCode: FC, phaseHistory });
    const state = { items: new Map([['item-1', item]]) };

    const first = deriveDecisionEvents(state, FC).map(e => e.id).sort();
    const second = deriveDecisionEvents(state, FC).map(e => e.id).sort();
    assert.deepEqual(first, second);
  });
});
