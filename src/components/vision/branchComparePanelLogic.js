export function formatAge(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const ms = now - then;
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return '<1h ago';
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function fmtNum(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtUsd(n) {
  if (n == null) return '—';
  return `$${Number(n).toFixed(n < 1 ? 3 : 2)}`;
}

export function fmtWallClock(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h${rem ? ` ${rem}m` : ''}`;
}

export function lastForkAge(branches, now = Date.now()) {
  const withStart = (branches || []).filter(b => b?.started_at);
  if (!withStart.length) return null;
  let mostRecent = null;
  for (const b of withStart) {
    const t = Date.parse(b.started_at);
    if (!Number.isNaN(t) && (mostRecent == null || t > mostRecent)) mostRecent = t;
  }
  return mostRecent == null ? null : formatAge(new Date(mostRecent).toISOString(), now);
}

export function summarizeLineage(lineage, now = Date.now()) {
  const branches = lineage?.branches || [];
  const complete = branches.filter(b => b.state === 'complete');
  const running = branches.filter(b => b.state === 'running');
  const count = branches.length;
  const forkAge = lastForkAge(branches, now);

  const canCompare = complete.length >= 2;
  const summary = running.length > 0 && complete.length < 2
    ? `${complete.length} of ${count} branches ready`
    : `${count} branch${count === 1 ? '' : 'es'}${forkAge ? ` · last fork ${forkAge}` : ''}`;

  return {
    summary,
    canCompare,
    completeBranches: complete,
    runningCount: running.length,
    totalCount: count,
  };
}

export function pickInitialPair(completeBranches, stored = []) {
  const byId = new Map(completeBranches.map(b => [b.branch_id, b]));
  const a = stored[0] && byId.has(stored[0]) ? byId.get(stored[0]) : completeBranches[0] || null;
  const b = stored[1] && byId.has(stored[1]) ? byId.get(stored[1]) : completeBranches[1] || null;
  return [a, b];
}
