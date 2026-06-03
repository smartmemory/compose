// lib/gsd-diff-capture.js
//
// COMP-GSD-7 S3: persist per-task diff snapshots for the milestone report.
//
// When a GSD parallel task runs in a worktree with capture_diff:true, Stratum
// returns the unified diff in the poll payload (ts.diff). build.js consumes it
// at the merge site and then drops it once the worktree is cleaned up. This
// helper snapshots that diff to .compose/gsd/<feature>/diffs/<taskId>.diff so
// the report (lib/gsd-milestone-report.js) can inline it. The path helper is the
// single source of truth shared with the report reader.
//
// Atomic write: tmp+rename, mirrors lib/gsd-state.js:44.

import { writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function gsdDiffsDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode, 'diffs');
}

export function gsdTaskDiffPath(cwd, featureCode, taskId) {
  return join(gsdDiffsDir(cwd, featureCode), `${taskId}.diff`);
}

/** Atomic write of a task's unified diff. Returns the path. */
export function writeGsdTaskDiff(cwd, featureCode, taskId, diffText) {
  mkdirSync(gsdDiffsDir(cwd, featureCode), { recursive: true });
  const target = gsdTaskDiffPath(cwd, featureCode, taskId);
  const tmp = `${target}.tmp`;
  if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
  writeFileSync(tmp, diffText);
  renameSync(tmp, target);
  return target;
}
