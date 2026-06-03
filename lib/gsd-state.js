// lib/gsd-state.js
//
// COMP-GSD-6 S01: continuous gsd run-state checkpoint (.compose/gsd/<f>/state.json).
//
// The load-bearing primitive for headless crash recovery, `compose gsd query`,
// and the live-run lock. A run flushes this file continuously (init pre-plan,
// per-task heartbeat, post-decompose, terminal); a hard crash leaves the last
// checkpoint with status:"running" + a dead pid, which readers derive as
// "crashed". Plain JSON, atomic tmp+rename — no SQLite (mirrors writeActiveBuild
// in lib/build.js). `pidAlive` lives here canonically (gsd.js imports it) to
// keep the gsd.js <-> gsd-state.js dependency one-directional.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_STALE_MS = 90000;

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

export function gsdStatePath(cwd, featureCode) {
  return join(gsdDir(cwd, featureCode), 'state.json');
}

// Authoritative liveness probe. Signal 0 checks existence without delivering a
// signal. EPERM => the process exists but isn't ours (still alive) — this is the
// semantics crash detection needs (cf. build.js isProcessAlive, which returns
// false on EPERM and is therefore wrong for this purpose).
export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Atomic write: stamp heartbeatAt, write to a tmp sibling, rename into place.
// Returns the object as persisted (with heartbeatAt). The caller owns `pid`
// (the runtime sets process.pid; tests inject a synthetic pid) — unlike
// writeActiveBuild, we do NOT force process.pid here.
export function writeGsdState(cwd, featureCode, state) {
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const persisted = { ...state, heartbeatAt: new Date().toISOString() };
  const target = gsdStatePath(cwd, featureCode);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  renameSync(tmp, target);
  return persisted;
}

export function readGsdState(cwd, featureCode) {
  const p = gsdStatePath(cwd, featureCode);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Reader-side status derivation. Dead pid is the ONLY crash signal; a stale
// heartbeat on a live pid is advisory (heartbeatStale) — never a crash verdict,
// because a healthy long task legitimately sits in the dispatch poll loop.
//
// Returns { status, heartbeatStale }.
//   running + live pid + fresh hb  -> { running, false }
//   running + live pid + stale hb  -> { running, true }
//   running + dead pid             -> { crashed, false }
//   <terminal>                     -> { <terminal>, false }   (complete|stuck|budget|failed)
//   null/no status                 -> { absent, false }
export function deriveRunStatus(state, { staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  if (!state || !state.status) return { status: 'absent', heartbeatStale: false };
  if (state.status !== 'running') {
    return { status: state.status, heartbeatStale: false };
  }
  if (!pidAlive(state.pid)) {
    return { status: 'crashed', heartbeatStale: false };
  }
  const hb = state.heartbeatAt ? Date.parse(state.heartbeatAt) : null;
  const heartbeatStale = hb != null && !Number.isNaN(hb) && now - hb > staleMs;
  return { status: 'running', heartbeatStale };
}
