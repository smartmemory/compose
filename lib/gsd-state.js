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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_STALE_MS = 90000;

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

export function gsdStatePath(cwd, featureCode) {
  return join(gsdDir(cwd, featureCode), 'state.json');
}

// COMP-GSD-6-WATCHDOG: best-effort removal of pause.json. After the supervisor
// kills a hung child, clearing pause.json lets loadResumeTaskGraph's crash-bridge
// recover from the current state.json (it prefers pause.json when present). A
// path+rm helper lives here (gsd-state owns the gsd dir layout) so the supervisor
// needn't import the heavy gsd.js.
export function clearGsdPause(cwd, featureCode) {
  const p = join(gsdDir(cwd, featureCode), 'pause.json');
  try { if (existsSync(p)) rmSync(p, { force: true }); } catch { /* best-effort */ }
}

// COMP-GSD-7-EVENTLOG: best-effort removal of a prior run's halt artifacts
// (stuck.{json,md}, budget.{json,md}). A fresh run clears these at its planning
// checkpoint so the milestone report's timeline — and its snapshot fallback,
// which reads these files — reflects only the current run, not a stale earlier
// halt. A clean complete clears only pause.json, so these can otherwise linger.
export function clearGsdHaltArtifacts(cwd, featureCode) {
  const dir = gsdDir(cwd, featureCode);
  for (const name of ['stuck.json', 'stuck.md', 'budget.json', 'budget.md']) {
    const p = join(dir, name);
    try { if (existsSync(p)) rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
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

// COMP-GSD-6: synthesize the `compose gsd query` snapshot (contracts/
// gsd-state.json#/definitions/query). Fixed source precedence so the
// pre-dispatch cumulative-budget refusal (budget.json, no state.json) isn't
// mislabeled 'absent': state.json -> pause.json -> budget.json -> absent.
// Pure synchronous reads — no LLM/server/Stratum (~ms).
export function buildGsdQuery(cwd, featureCode, { staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  const dir = gsdDir(cwd, featureCode);

  // 1. state.json
  const state = readGsdState(cwd, featureCode);
  if (state) {
    const { status, heartbeatStale } = deriveRunStatus(state, { staleMs, now });
    const total = Array.isArray(state.decomposedTasks) ? state.decomposedTasks.length : 0;
    const completed = Array.isArray(state.completedTaskIds) ? state.completedTaskIds.length : 0;
    return {
      feature: featureCode,
      status,
      phase: state.phase ?? null,
      heartbeatStale,
      progress: { completed, total },
      resumeReady: !!state.resumeReady,
      pid: state.pid ?? null,
      flowId: state.flowId ?? null,
      heartbeatAt: state.heartbeatAt ?? null,
      budget: state.budget ?? null,
    };
  }

  // 2. pause.json (paused, no live state.json — e.g. a pre-GSD-6 halt)
  const pausePath = join(dir, 'pause.json');
  if (existsSync(pausePath)) {
    try {
      const p = JSON.parse(readFileSync(pausePath, 'utf-8'));
      const kind = p.kind === 'budget' ? 'budget' : 'stuck';
      return {
        feature: featureCode,
        status: kind,
        phase: 'execute',
        pause: { kind, detail: p.detail ?? null, stuckTaskId: p.stuckTaskId ?? null },
      };
    } catch { /* fall through */ }
  }

  // 3. budget.json (pre-dispatch cumulative refusal — writes budget.json, no state)
  const budgetPath = join(dir, 'budget.json');
  if (existsSync(budgetPath)) {
    try {
      const b = JSON.parse(readFileSync(budgetPath, 'utf-8'));
      return { feature: featureCode, status: 'budget', budget: b };
    } catch { /* fall through */ }
  }

  // 4. absent
  return { feature: featureCode, status: 'absent' };
}
