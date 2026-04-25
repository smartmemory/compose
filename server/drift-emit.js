/**
 * drift-emit.js — COMP-OBS-DRIFT broadcast dispatcher.
 *
 * Single choke point: emitDriftAxes(broadcastMessage, store, item, projectRoot, now)
 *
 *   1. Compute new axes via computeDriftAxes.
 *   2. Read prior persisted axes from item.lifecycle.lifecycle_ext.drift_axes[].
 *   3. For axes that were ALREADY breached: copy breach_started_at + breach_event_id forward.
 *   4. For axes that are NEWLY breached: assign fresh breach_started_at + breach_event_id.
 *   5. For axes that are NEWLY UNBREACHED: clear both fields to null.
 *   6. Persist merged axes via store.updateLifecycleExt.
 *   7. Broadcast { type: 'driftAxesUpdate', itemId, drift_axes }.
 *   8. Emit DecisionEvent[kind=drift_threshold] for each newly-breached axis (rising edge only).
 *
 * v1 always populates breach_started_at and breach_event_id (even when null) on
 * every DriftAxis so consumers have a consistent shape.
 *
 * Falling-edge → no DecisionEvent. Steady-state breached → no new DecisionEvent.
 */

import { computeDriftAxes } from './drift-axes.js';
import { driftThresholdDecisionEventId } from './decision-event-id.js';
import { emitDecisionEvent, buildDriftThresholdEvent } from './decision-event-emit.js';

/**
 * Compute, persist, and broadcast drift axes for a single item.
 * Emits rising-edge DecisionEvents when an axis newly breaches its threshold.
 *
 * @param {function} broadcastMessage — fn(msg) WS broadcast
 * @param {object}   store — VisionStore (must expose updateLifecycleExt)
 * @param {object}   item — vision item (pre-loaded; must have lifecycle.featureCode)
 * @param {string}   projectRoot — absolute path of the project root (for git)
 * @param {string}   [now] — ISO timestamp (defaults to Date.now())
 * @returns {DriftAxis[]} the merged axes that were persisted
 */
export function emitDriftAxes(broadcastMessage, store, item, projectRoot, now) {
  if (!item?.lifecycle?.featureCode) return [];

  const ts = now || new Date().toISOString();
  const featureCode = item.lifecycle.featureCode;

  // 1. Compute fresh axes
  let newAxes;
  try {
    newAxes = computeDriftAxes(item, projectRoot, ts);
  } catch (err) {
    // Computation failure must not crash the event loop — log and skip
    console.warn(`[drift-emit] computeDriftAxes failed for ${featureCode}: ${err.message}`);
    return [];
  }

  // 2. Read prior persisted axes (indexed by axis_id for O(1) lookup)
  const prior = item.lifecycle.lifecycle_ext?.drift_axes ?? [];
  const priorByAxisId = new Map(prior.map(a => [a.axis_id, a]));

  // 3–5. Merge breach-edge metadata; collect newly-breached axes for event emission
  const newlyBreached = [];

  const mergedAxes = newAxes.map(axis => {
    const priorAxis = priorByAxisId.get(axis.axis_id);
    const wasBreached = priorAxis?.breached === true;
    const isBreached = axis.breached === true;

    let breach_started_at = null;
    let breach_event_id = null;

    if (isBreached) {
      if (wasBreached && priorAxis.breach_started_at && priorAxis.breach_event_id) {
        // Steady breach — preserve the original breach-edge metadata
        breach_started_at = priorAxis.breach_started_at;
        breach_event_id = priorAxis.breach_event_id;
      } else if (!wasBreached) {
        // Rising edge — assign fresh breach-edge metadata
        breach_started_at = ts;
        breach_event_id = driftThresholdDecisionEventId(featureCode, axis.axis_id, ts);
        newlyBreached.push({ ...axis, breach_started_at, breach_event_id });
      } else {
        // wasBreached but prior metadata is missing (edge case: upgraded from old schema)
        breach_started_at = priorAxis.breach_started_at || ts;
        breach_event_id = priorAxis.breach_event_id || driftThresholdDecisionEventId(featureCode, axis.axis_id, breach_started_at);
      }
    }
    // Falling edge or never breached: both stay null (already null from buildAxis)

    return { ...axis, breach_started_at, breach_event_id };
  });

  // 6. Persist merged axes
  try {
    store.updateLifecycleExt(item.id, 'drift_axes', mergedAxes);
  } catch (err) {
    console.warn(`[drift-emit] updateLifecycleExt failed for ${featureCode}: ${err.message}`);
    return mergedAxes;
  }

  // 7. Broadcast driftAxesUpdate
  try {
    broadcastMessage({ type: 'driftAxesUpdate', itemId: item.id, drift_axes: mergedAxes });
  } catch (err) {
    console.warn(`[drift-emit] broadcast failed for ${featureCode}: ${err.message}`);
  }

  // 8. Emit DecisionEvent for each newly-breached axis
  for (const axis of newlyBreached) {
    try {
      const event = buildDriftThresholdEvent({
        featureCode,
        axisId: axis.axis_id,
        ratio: axis.ratio,
        threshold: axis.threshold,
        breachStartedAt: axis.breach_started_at,
        breachEventId: axis.breach_event_id,
      });
      emitDecisionEvent(broadcastMessage, event);
    } catch (err) {
      console.warn(`[drift-emit] DecisionEvent emit failed for ${featureCode}/${axis.axis_id}: ${err.message}`);
    }
  }

  return mergedAxes;
}
