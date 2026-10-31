import React from 'react';

/**
 * KpiTrend — the sparkline and 7-day delta on a KPI tile (COMP-COCKPIT-13-POLISH U5), drawn only from the days the
 * status builder has recorded in `kpi-history.jsonl` (GET /api/process `sources.history`). One day draws one dot;
 * the delta stays hidden until two recorded days exist, and its label says the real span (`3d`) until a full week
 * is there. Nothing is sampled or filled in: a day with no value is a gap.
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const dayOf = (d) => { const [y, m, dd] = String(d).split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const hsl = (v) => `hsl(var(${v}))`;

/** Which way is better per tile, for the delta colour. */
export const BETTER = { waiting_share: 'low', first_pass_clean: 'high', review_rounds: 'low', gate_minutes: 'low', standard: 'high' };

/**
 * Pure: `{ points: [{date, value}], delta: {value, days, from, to} | null }` for one tile key. `delta` compares the
 * newest recorded value with the oldest recorded value at most 7 days before it; null under two recorded days.
 */
export function trendOf(history, key) {
  const points = (Array.isArray(history) ? history : []).map((p) => ({ date: p?.date, value: typeof p?.[key] === 'number' ? p[key] : null }));
  const known = points.filter((p) => p.value !== null);
  if (known.length < 2) return { points, delta: null };
  const last = known[known.length - 1];
  const base = known.find((p) => dayOf(last.date) - dayOf(p.date) <= WINDOW_DAYS * DAY_MS);
  if (!base || base === last) return { points, delta: null };
  const value = Math.round((last.value - base.value) * 10) / 10;
  return { points, delta: { value, days: Math.round((dayOf(last.date) - dayOf(base.date)) / DAY_MS), from: base, to: last } };
}

/** Spark line over every recorded day, oldest left; `testId` carries `data-points` (recorded days with a value). */
export function Sparkline({ points, color, testId, title }) {
  const known = points.filter((p) => p.value !== null);
  const vals = known.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const n = points.length;
  const x = (i) => (n <= 1 ? 100 : (i / (n - 1)) * 100);
  const y = (v) => (hi === lo ? 50 : 90 - ((v - lo) / (hi - lo)) * 80);
  const segs = [];
  let cur = [];
  points.forEach((p, i) => {
    if (p.value === null) { if (cur.length) segs.push(cur); cur = []; return; }
    cur.push(`${x(i).toFixed(2)},${y(p.value).toFixed(2)}`);
  });
  if (cur.length) segs.push(cur);
  const lastIdx = points.findLastIndex((p) => p.value !== null);
  return (
    <div className="relative h-[18px] w-full" data-testid={testId} data-points={known.length} title={title}>
      {known.length ? (<>
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {segs.filter((s) => s.length > 1).map((s, i) => (
            <polyline key={i} points={s.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          ))}
        </svg>
        <span className="absolute h-[5px] w-[5px] rounded-full" aria-hidden="true"
          style={{ left: `calc(${x(lastIdx)}% - 2.5px)`, top: `calc(${y(points[lastIdx].value)}% - 2.5px)`, background: color }} />
      </>) : null}
    </div>
  );
}

/** `▲ 1.2 3d`, green when the move is the better way, red when worse, muted when flat. */
export function Delta({ delta, better, testId, unit = '' }) {
  if (!delta) return null;
  const { value, days, from, to } = delta;
  const good = value === 0 ? null : (value < 0) === (better === 'low');
  const color = good === null ? hsl('--muted-foreground') : good ? hsl('--success') : hsl('--destructive');
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '±';
  return (
    <span className="ml-auto shrink-0 font-mono text-[11px]" style={{ color }} data-testid={testId}
      title={`change over ${days} day${days === 1 ? '' : 's'}: ${from.value}${unit} on ${from.date} to ${to.value}${unit} on ${to.date} (daily history)`}>
      {arrow} {Math.abs(value)} <span className="text-muted-foreground">{days}d</span>
    </span>
  );
}
