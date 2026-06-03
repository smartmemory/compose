// lib/gsd-timing.js
//
// COMP-GSD-7 S1: per-task timing sidecar for the milestone report.
//
// Stratum's parallel_poll response does NOT carry per-task timing, and the
// blackboard is rebuilt from agent-written results/*.json validated against
// contracts/task-result.json (which forbids extra fields). So compose's own
// poll-loop observations have nowhere to land on the blackboard. This sidecar
// is the carrier: `.compose/gsd/<feature>/timing.json` = a plain
//   { [taskId]: { startedAt, completedAt, durationMs } }
// map, written by the gsd dispatch loop and read by the report assembler.
//
// Caveat: completedAt is bounded by the dispatch poll interval (seconds), so
// durations are approximate-to-poll-granularity. The report footer documents it.
//
// Atomic write: tmp+rename, mirrors lib/gsd-state.js:44.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const TERMINAL_STATES = new Set(['complete', 'failed', 'cancelled']);

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

export function timingSidecarPath(cwd, featureCode) {
  return join(gsdDir(cwd, featureCode), 'timing.json');
}

// Atomic write: write to a tmp sibling, rename into place. Clears a stale tmp
// from a previously-crashed write first.
export function writeTimingSidecar(cwd, featureCode, timingMap) {
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const target = timingSidecarPath(cwd, featureCode);
  const tmp = `${target}.tmp`;
  if (existsSync(tmp)) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  writeFileSync(tmp, JSON.stringify(timingMap, null, 2));
  renameSync(tmp, target);
  return target;
}

// Read-or-{}. Corrupt/unreadable JSON degrades to {} — the report renders an
// empty timing column rather than failing.
export function readTimingSidecar(cwd, featureCode) {
  const p = timingSidecarPath(cwd, featureCode);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Pure poll accumulator. Called once per poll with the current task-state map.
 *
 * - First sight of a task → record `startedAt = nowIso`.
 * - First time a task is seen in a terminal state (complete|failed|cancelled) →
 *   record `completedAt = nowIso` and `durationMs` (completedAt − startedAt,
 *   floored at 0). A task first seen already-terminal gets startedAt==completedAt
 *   and durationMs 0.
 *
 * Idempotent: an existing startedAt/completedAt is never overwritten (first
 * observation wins), so re-polling the same terminal task is a no-op.
 *
 * @returns the same `timingMap` reference (mutated in place).
 */
export function recordTaskStates(timingMap, pollTasks, nowIso) {
  if (!pollTasks || typeof pollTasks !== 'object') return timingMap;
  for (const [taskId, ts] of Object.entries(pollTasks)) {
    const state = ts?.state;
    let entry = timingMap[taskId];
    if (!entry) {
      entry = { startedAt: nowIso };
      timingMap[taskId] = entry;
    }
    if (entry.completedAt == null && TERMINAL_STATES.has(state)) {
      entry.completedAt = nowIso;
      const start = Date.parse(entry.startedAt);
      const end = Date.parse(nowIso);
      entry.durationMs = Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
    }
  }
  return timingMap;
}
