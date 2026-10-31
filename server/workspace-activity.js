import { readFileSync } from 'node:fs';
import path from 'node:path';

// Statuses nothing resumes from (lib/build.js decideBuildStart treats complete/aborted/killed as
// locally terminal); 'failed' and a 'running' record with a dead pid stay, they are the resume handle.
const ENDED_BUILD_STATUSES = new Set(['complete', 'completed', 'done', 'aborted', 'killed', 'cancelled']);
export const ENDED_BUILD_GRACE_MS = 15 * 60_000;

/**
 * The build GET /api/build/state serves. active-build.json keeps a build's last record after it ends
 * (the writer's contract), so an ended build is shown for a grace window and then becomes history
 * (Build > Past builds). BUG-27, aborted 2026-09-19, was still the "live build" on 2026-10-31
 * (COMP-COCKPIT-WIRING-1). Pid liveness cannot decide this: cockpit builds run in the API process.
 */
export function liveBuildState(build, now = Date.now()) {
  if (!build || !ENDED_BUILD_STATUSES.has(build.status)) return build ?? null;
  const endedAt = Date.parse(build.completedAt ?? build.startedAt ?? '');
  return Number.isFinite(endedAt) && now - endedAt < ENDED_BUILD_GRACE_MS ? build : null;
}

/** Persisted work is shared by CLI, vision and SDK processes. Missing is idle;
 * unreadable state is uncertain and must never authorize eviction. */
export function hasPersistedWork(dataDir) {
  const read = file => {
    try { return JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    const build = read('active-build.json');
    if (build && !['complete', 'completed', 'failed', 'aborted', 'cancelled'].includes(build.status)) return true;
    const agents = read('agents.json');
    const records = Array.isArray(agents) ? agents : Object.values(agents ?? {});
    return records.some(agent => agent?.status === 'running');
  } catch { return true; }
}
