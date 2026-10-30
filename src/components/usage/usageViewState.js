/**
 * usageViewState.js — pure helpers for UsageView (COMP-OBS-STATS-1). No React.
 */
import { formatCost } from '../../lib/format-cost.js';

export const RANGES = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All', days: null },
];

const UNKNOWN_KEY = 'unknown';
const OTHER_KEY = 'other';
const PALETTE = ['--chart-1', '--chart-2', '--chart-3', '--chart-4'];

function localDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * A window of `days` local calendar days ending today, stepped back `offset`
 * windows. Returns ISO bounds for the API ([from, to)) and a display span.
 */
export function resolveRange(rangeKey, offset = 0, now = new Date()) {
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];
  if (range.days === null) return { from: null, to: null, label: 'All time' };
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1 - offset * range.days);
  const start = new Date(end);
  start.setDate(start.getDate() - range.days);
  const last = new Date(end);
  last.setDate(last.getDate() - 1);
  return { from: start.toISOString(), to: end.toISOString(), label: `${localDate(start)} – ${localDate(last)}` };
}

/**
 * Render a dollar amount by provenance (design "Provenance has three states"):
 * reported -> $X, estimated -> ~$X est., absent -> ~$X plus an unknown marker.
 */
export function costDisplay(usd, counts = {}) {
  const reported = counts.reported ?? 0;
  const estimated = counts.estimated ?? 0;
  const absent = counts.absent ?? 0;
  const total = reported + estimated + absent;
  const amount = formatCost(usd, { digits: 2 });
  const notes = [];
  if (estimated) notes.push(`${estimated} of ${total} dispatches were estimated`);
  if (absent) notes.push(`${absent} of ${total} dispatches have no provenance record`);
  if (absent) return { text: `~${amount}`, unknownProvenance: true, tip: notes.join('; ') };
  if (estimated) return { text: `~${amount} est.`, unknownProvenance: false, tip: notes.join('; ') };
  return { text: amount, unknownProvenance: false, tip: total ? `all ${total} dispatches reported by the provider` : '' };
}

export function provenanceCounts(provenance = {}) {
  return {
    reported: provenance.reported?.dispatch_count ?? 0,
    estimated: provenance.estimated?.dispatch_count ?? 0,
    absent: provenance.absent?.dispatch_count ?? 0,
  };
}

export function formatCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatRate(r) {
  return typeof r === 'number' && Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : '—';
}

/** Delta vs the previous window; null when there is nothing to compare. */
export function delta(current, previous) {
  if (typeof current !== 'number' || typeof previous !== 'number') return null;
  const diff = current - previous;
  return { diff, pct: previous === 0 ? null : diff / previous };
}

/**
 * Chart series for a split ('model' | 'site') and metric ('cost' | 'tokens'):
 * the four largest keys get their own colour, the rest fold into Other, and the
 * Unknown model keeps its own muted series (never dropped).
 */
export function chartSeries(days = [], split = 'model', metric = 'cost') {
  const field = metric === 'cost' ? 'usd' : 'tokens_total';
  const group = split === 'site' ? 'by_site' : 'by_model';
  const totals = new Map();
  for (const day of days) {
    for (const [key, cell] of Object.entries(day[group] ?? {})) {
      totals.set(key, (totals.get(key) ?? 0) + (cell[field] ?? 0));
    }
  }
  const hasUnknown = split === 'model' && totals.has(UNKNOWN_KEY);
  const ranked = [...totals.entries()]
    .filter(([key]) => !(split === 'model' && key === UNKNOWN_KEY))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  const own = ranked.slice(0, PALETTE.length);
  const folded = new Set(ranked.slice(PALETTE.length));
  const series = own.map((key, i) => ({ key, label: key, color: `hsl(var(${PALETTE[i]}))` }));
  if (folded.size) series.push({ key: OTHER_KEY, label: `Other (${folded.size})`, color: 'hsl(var(--chart-5))' });
  if (hasUnknown) series.push({ key: UNKNOWN_KEY, label: 'Unknown model', color: 'hsl(var(--muted-foreground))' });
  const stacks = days.map((day) => {
    const values = Object.fromEntries(series.map((s) => [s.key, 0]));
    for (const [key, cell] of Object.entries(day[group] ?? {})) {
      const target = split === 'model' && key === UNKNOWN_KEY ? UNKNOWN_KEY : folded.has(key) ? OTHER_KEY : key;
      values[target] += cell[field] ?? 0;
    }
    return { date: day.date, values, total: Object.values(values).reduce((a, b) => a + b, 0) };
  });
  return { series, stacks };
}
