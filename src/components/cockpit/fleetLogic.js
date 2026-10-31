/**
 * fleetLogic.js — pure helpers for the Fleet view, Ops pills and mobile Status tab (COMP-COCKPIT-12).
 * Input is the GET /api/fleet body: `{generated, sources: {stratum, sm_status, cadence}}`, each `{value, error, ts, stale}`.
 * No React imports.
 */

export const CTX_YELLOW = 200_000;
export const CTX_RED = 250_000;
export const DISK_RED_GB = 100;

/** A reader is up when it answered; a down reader hides its panels and pills. */
export function readerUp(data, name) {
  const src = data?.sources?.[name];
  return Boolean(src && src.error == null && src.value != null);
}

export function anyReaderUp(data) {
  return ['stratum', 'sm_status', 'cadence'].some((n) => readerUp(data, n));
}

/** One sm_status panel `{value, error}`, or null when the sm_status reader is down. */
export function smPanel(data, name) {
  if (!readerUp(data, 'sm_status')) return null;
  return data.sources.sm_status.value[name] ?? { value: null, error: `no ${name} source` };
}

export function ctxLevel(ctx) {
  if (!Number.isFinite(ctx)) return null;
  if (ctx >= CTX_RED) return 'red';
  if (ctx >= CTX_YELLOW) return 'yellow';
  return null;
}

export function fmtK(ctx) {
  return Number.isFinite(ctx) ? `${Math.round(ctx / 1000)}K` : '?';
}

export function fmtAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

/** Ops strip pills: red for sessions over 250K and disk under 100 GB, amber for open owner questions. */
export function fleetPills(data) {
  const pills = [];
  const sessions = smPanel(data, 'sessions');
  if (Array.isArray(sessions?.value)) {
    const hot = sessions.value.filter((s) => ctxLevel(s?.ctx) === 'red').length;
    if (hot > 0) pills.push({ key: 'fleet:ctx', tone: 'red', label: `${hot} session${hot === 1 ? '' : 's'} >250K` });
  }
  const queue = smPanel(data, 'queue');
  if (Array.isArray(queue?.value) && queue.value.length > 0) {
    const n = queue.value.length;
    pills.push({ key: 'fleet:owner', tone: 'amber', label: `${n} owner question${n === 1 ? '' : 's'}` });
  }
  const df = smPanel(data, 'df');
  const free = df?.value?.free_gb;
  if (Number.isFinite(free) && free < DISK_RED_GB) {
    pills.push({ key: 'fleet:disk', tone: 'red', label: `disk ${Math.floor(free)} GB free` });
  }
  return pills;
}

/**
 * Cadence's "proposed" line (cadence-main addendum 2026-10-30): ONE line, never an empty panel.
 * The proposed units (or "none"), then the top 4 blocker rules from belt readiness.byRule,
 * then the wall when the last would_launch line was held at one (at_wall empties the list).
 */
export function proposedLine(cadence) {
  const wl = cadence?.wouldLaunch?.value;
  const units = Array.isArray(wl?.units) ? wl.units : [];
  const parts = [`Cadence would start: ${units.length ? units.join(', ') : 'none'}`];
  const byRule = cadence?.readiness?.byRule ?? {};
  const top = Object.entries(byRule)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4);
  if (top.length) parts.push(`top blockers: ${top.map(([rule, n]) => `${rule} ${n}`).join(', ')}`);
  if (wl?.at_wall) parts.push(`held: ${wl.at_wall}`);
  return parts.join(' · ');
}

/** A ready unit's blocker reasons: every belt `blockers` entry, else the single `blocker`, else the verdict. */
export function blockerReasons(u) {
  if (Array.isArray(u?.blockers) && u.blockers.length) return u.blockers.join(', ');
  return u?.blocker ?? u?.decision ?? '';
}

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Ready units, launchable first, then by priority, then id. */
export function sortReady(units) {
  return [...(units ?? [])].sort((a, b) => (
    (a.decision === 'launchable' ? 0 : 1) - (b.decision === 'launchable' ? 0 : 1)
    || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
    || String(a.id).localeCompare(String(b.id))
  ));
}

/** Open jobs, youngest first (running time ascending). */
export function sortJobs(jobs) {
  return [...(jobs ?? [])].sort((a, b) => (a?.age ?? Infinity) - (b?.age ?? Infinity));
}

export const CATEGORY_LABELS = {
  reading: 'Reading', writing: 'Writing', executing: 'Running',
  searching: 'Searching', fetching: 'Fetching', delegating: 'Delegating',
  thinking: 'Thinking',
};

/**
 * COMP-COCKPIT-WHAT-LINE-1: the one source for "is anything running". Compose's own agent (`agentState`, the
 * `compose:agent-status` event detail) plus the fleet's busy sessions (sm_status `sessions[].busy === true`) and live
 * jobs (`jobs[].alive === true`). `busy` and `jobs` are null when `fleetKnown` is false (sm_status down or neither panel
 * is a list), so a caller shows "unknown" instead of 0. `text` is the fleet part of the header line.
 */
export function runningNow(fleetData, agentState) {
  const sessions = smPanel(fleetData, 'sessions');
  const jobs = smPanel(fleetData, 'jobs');
  const okS = Array.isArray(sessions?.value);
  const okJ = Array.isArray(jobs?.value);
  const fleetKnown = okS || okJ;
  const composeWorking = agentState?.status === 'working';
  const composeLabel = composeWorking ? (CATEGORY_LABELS[agentState.category] || 'Working') : 'Idle';
  if (!fleetKnown) return { composeWorking, composeLabel, busy: null, jobs: null, fleetKnown, text: '' };
  const busy = okS ? sessions.value.filter((s) => s?.busy === true).length : 0;
  const alive = okJ ? jobs.value.filter((j) => j?.alive === true).length : 0;
  const parts = [];
  if (busy > 0) parts.push(`${busy} session${busy === 1 ? '' : 's'} busy`);
  if (alive > 0) parts.push(`${alive} job${alive === 1 ? '' : 's'}`);
  return { composeWorking, composeLabel, busy, jobs: alive, fleetKnown, text: parts.join(' · ') };
}

/**
 * COMP-COCKPIT-PROCESS-DATA-1: the header pill's fleet line, now a thin wrapper over `runningNow`; null when sm_status is
 * down or neither panel is a list, so the pill never shows an error.
 */
export function fleetActivity(data) {
  const r = runningNow(data, null);
  return r.fleetKnown ? { busy: r.busy, jobs: r.jobs, text: r.text } : null;
}
