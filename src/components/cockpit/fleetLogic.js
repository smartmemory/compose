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
 * Cadence's "proposed" line (cadence-main addendum 2026-10-30): never an empty panel.
 * Non-empty would_launch units: list them. Empty: "none" plus the top 4 blocker rules from belt readiness,
 * and the wall when one is set.
 */
export function proposedLine(cadence) {
  const wl = cadence?.wouldLaunch?.value;
  const units = Array.isArray(wl?.units) ? wl.units : [];
  if (units.length > 0) return `Cadence would start: ${units.join(', ')}`;
  const parts = ['Cadence would start: none'];
  const byRule = cadence?.readiness?.byRule ?? {};
  const top = Object.entries(byRule)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4);
  if (top.length) parts.push(`top blockers: ${top.map(([rule, n]) => `${rule} ${n}`).join(', ')}`);
  if (wl?.at_wall) parts.push(`held: ${wl.at_wall}`);
  return parts.join(' · ');
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
