/**
 * decision-events-snapshot.js — Derive DecisionEvent[] from persisted lifecycle state.
 *
 * COMP-OBS-TIMELINE A6: on WS connect the server re-derives the current
 * feature's DecisionEvents from already-persisted sources so the client can
 * seed its store without waiting for a live replay.
 *
 * Sources:
 *   - kind=phase_transition  → lifecycle.phaseHistory[]  (populated by lifecycle-phase-history.js)
 *   - kind=iteration         → lifecycle.iterationState  (start + complete pairs)
 *   - kind=branch            → lifecycle.lifecycle_ext.branch_lineage.branches[]
 *
 * Deterministic ids: re-derive == identity with the live emitters because both
 * use the same id helpers from decision-event-id.js.
 */

import {
  phaseTransitionDecisionEventId,
  iterationDecisionEventId,
  branchDecisionEventId,
} from './decision-event-id.js';
import { buildPhaseTransitionEvent, buildIterationEvent } from './decision-event-emit.js';

/**
 * Derive all DecisionEvents for a given featureCode from persisted lifecycle state.
 *
 * @param {object} state — { items: Map<id, item> } (from VisionStore.getState or internal)
 * @param {string} featureCode — the feature to filter for
 * @returns {DecisionEvent[]} array sorted by timestamp ascending
 */
export function deriveDecisionEvents(state, featureCode) {
  const events = [];

  // state may expose items as Map (internal) or Array (getState). Handle both.
  const itemsIterable = state.items instanceof Map
    ? state.items.values()
    : (Array.isArray(state.items) ? state.items : []);

  for (const item of itemsIterable) {
    const lc = item?.lifecycle;
    if (!lc) continue;
    if (lc.featureCode !== featureCode) continue;

    // ── phase_transition events ─────────────────────────────────────────────
    for (const entry of lc.phaseHistory || []) {
      events.push(buildPhaseTransitionEvent({
        featureCode,
        from: entry.from,
        to: entry.to,
        outcome: entry.outcome,
        agent_id: entry.agent_id || null,
        timestamp: entry.timestamp,
      }));
    }

    // ── iteration events ────────────────────────────────────────────────────
    const iter = lc.iterationState;
    if (iter?.loopId) {
      // Always emit start event
      events.push(buildIterationEvent({
        featureCode,
        loopId: iter.loopId,
        loopType: iter.loopType,
        stage: 'start',
        attempt: null,
        outcome: 'retry',
        timestamp: iter.startedAt,
      }));

      // Emit complete event only when loop has actually completed
      if (iter.status === 'complete' && iter.completedAt) {
        events.push(buildIterationEvent({
          featureCode,
          loopId: iter.loopId,
          loopType: iter.loopType,
          stage: 'complete',
          attempt: iter.count,
          outcome: iter.outcome,
          timestamp: iter.completedAt,
        }));
      }
    }

    // ── branch events ───────────────────────────────────────────────────────
    // Production lineage is persisted at `item.lifecycle.lifecycle_ext.branch_lineage`
    // by `vision-store.updateLifecycleExt`. Earlier drafts read `item.lifecycle_ext`
    // (top-level), which is why test fixtures occasionally produced the wrong shape.
    const lineage = lc.lifecycle_ext?.branch_lineage;
    if (lineage?.branches) {
      // Compute sibling_branch_ids per branch — all branches sharing the same
      // non-null fork_uuid (the convention BRANCH's live emitter uses).
      const siblingsByFork = new Map();
      for (const b of lineage.branches) {
        if (!b.fork_uuid) continue;
        if (!siblingsByFork.has(b.fork_uuid)) siblingsByFork.set(b.fork_uuid, []);
        siblingsByFork.get(b.fork_uuid).push(b.branch_id);
      }
      for (const branch of lineage.branches) {
        const eventId = branchDecisionEventId(featureCode, branch.branch_id);
        const siblingIds = branch.fork_uuid ? siblingsByFork.get(branch.fork_uuid) ?? [] : [];
        events.push({
          id: eventId,
          feature_code: featureCode,
          timestamp: branch.started_at,
          kind: 'branch',
          title: `New branch ${branch.branch_id.slice(0, 8)}…`,
          metadata: {
            branch_id: branch.branch_id,
            fork_uuid: branch.fork_uuid || null,
            sibling_branch_ids: siblingIds,
          },
          roles: [],
        });
      }
    }
  }

  // Sort by timestamp ascending (oldest first — strip renders newest-right)
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}
