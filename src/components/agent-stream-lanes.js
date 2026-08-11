/**
 * COMP-AGENT-LANES — pure per-worker lane reducer.
 *
 * One lane per parallel fanout worker slot. Lane identity is
 * `flowId:stepId:itemIndex` (stepId/itemIndex recur across builds, so flowId is
 * load-bearing). Lane version is the ordered tuple `(generation, attempt)`: an
 * event with a higher version resets the lane (supersession/retry); a lower
 * version is stale and rejected — a late terminal event from a superseded
 * attempt must not close the new attempt.
 *
 * Terminal rule: a lane closes ONLY on (a) a build_step_done carrying an
 * explicit status, or (b) an error event explicitly marked `laneTerminal`.
 * Advisory errors append as in-lane diagnostics without closing.
 *
 * Pure module (no React, no module state) so the reducer is testable under
 * node --test — same pattern as agent-stream-helpers.js. AgentStream.jsx owns
 * the Map and calls these on each SSE message.
 */

export const MAX_LANE_MESSAGES = 200;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'skipped']);

export function laneKey(lane) {
  return `${lane.flowId}:${lane.stepId}:${lane.itemIndex}`;
}

/** Order two [generation, attempt] tuples: negative, zero, or positive. */
export function compareLaneVersion(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

function versionOf(lane) {
  return [lane.generation ?? 0, lane.attempt ?? 1];
}

function appendMessage(entry, msg) {
  entry.messages.push(msg);
  if (entry.messages.length > MAX_LANE_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_LANE_MESSAGES);
  }
}

/**
 * Apply one bridge-forwarded SSE message to the lane map.
 * Only messages carrying a `lane` envelope participate; everything else is
 * ignored (legacy aggregate bookkeeping handles lane-less streams).
 *
 * @param {Map} lanes  key → {key, lane, status, version, messages, joinedMidBuild, summary}
 * @param {object} msg bridge-shaped SSE message
 * @returns {boolean}  whether the map changed
 */
export function applyLaneEvent(lanes, msg) {
  const lane = msg?.lane;
  if (!lane || typeof lane !== 'object') return false;

  const key = laneKey(lane);
  const version = versionOf(lane);
  const isStart = msg.type === 'system' && msg.subtype === 'build_step';
  const isDone = msg.type === 'system' && msg.subtype === 'build_step_done';
  const isError = msg.type === 'error';

  let entry = lanes.get(key);
  if (!entry) {
    entry = {
      key,
      lane,
      status: 'working',
      version,
      messages: [],
      // No start seen for this lane — the cockpit connected mid-build
      // (reconnect is forward-only in v1; no replay).
      joinedMidBuild: !isStart,
    };
    lanes.set(key, entry);
  } else {
    const cmp = compareLaneVersion(version, entry.version);
    if (cmp < 0) return false; // stale event from a superseded version
    if (cmp > 0) {
      // Newer (generation, attempt) supersedes: reset in place.
      entry.lane = lane;
      entry.version = version;
      entry.status = 'working';
      entry.messages = [];
      entry.joinedMidBuild = !isStart;
      delete entry.summary;
    }
  }

  if (isStart) {
    // The start for the entry's current version — the lane is fully observed.
    entry.joinedMidBuild = false;
    entry.lane = lane;
    return true;
  }

  if (isDone) {
    if (typeof msg.summary === 'string') entry.summary = msg.summary;
    // Terminal only with an explicit status; a bare done leaves the lane open.
    if (TERMINAL_STATUSES.has(msg.status)) entry.status = msg.status;
    return true;
  }

  if (isError) {
    appendMessage(entry, msg);
    if (msg.laneTerminal === true) entry.status = 'failed';
    return true;
  }

  // Output events: assistant text / tool_use wrappers / tool_use_summary.
  appendMessage(entry, msg);
  return true;
}

/**
 * Legacy `parallelTasks` summary derived from the lane map, so existing
 * consumers (AgentBar counter) keep working unchanged. A failed worker counts
 * as failed — fixing the old reducer's "every done = complete" bug.
 */
export function deriveParallelSummary(lanes) {
  if (!lanes || lanes.size === 0) return null;
  const summary = { total: lanes.size, completed: 0, failed: 0, active: 0, tasks: {} };
  for (const entry of lanes.values()) {
    if (entry.status === 'working') {
      summary.active++;
      summary.tasks[entry.lane.stepId] = 'working';
    } else if (entry.status === 'failed') {
      summary.failed++;
      summary.tasks[entry.lane.stepId] = 'failed';
    } else {
      summary.completed++;
      summary.tasks[entry.lane.stepId] = 'complete';
    }
  }
  return summary;
}
