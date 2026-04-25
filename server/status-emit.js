/**
 * status-emit.js — COMP-OBS-STATUS broadcast dispatcher (A2).
 *
 * Single choke point: emitStatusSnapshot(broadcastMessage, state, featureCode, now)
 * Recomputes the StatusSnapshot from current store state and broadcasts:
 *   { type: 'statusSnapshot', featureCode, snapshot }
 *
 * Returns the snapshot for caller convenience (mirrors decision-event-emit.js pattern).
 * No caching — recomputed on every call. The snapshot is cheap (~200 bytes, single scan).
 */

import { computeStatusSnapshot } from './status-snapshot.js';

/**
 * Emit a StatusSnapshot broadcast.
 *
 * @param {function} broadcastMessage — fn(msg) to dispatch to all WS clients
 * @param {object}   state            — VisionStore (getItemByFeatureCode, getPendingGates)
 * @param {string|null} featureCode   — the feature whose snapshot to recompute
 * @param {string}   [now]            — ISO timestamp (defaults to Date.now())
 * @returns {StatusSnapshot}
 */
export function emitStatusSnapshot(broadcastMessage, state, featureCode, now) {
  const snapshot = computeStatusSnapshot(state, featureCode, now || new Date().toISOString());
  broadcastMessage({ type: 'statusSnapshot', featureCode, snapshot });
  return snapshot;
}
