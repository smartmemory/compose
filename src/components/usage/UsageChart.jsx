/**
 * UsageChart — hand-rolled stacked day-bucket bar chart (COMP-OBS-STATS-1, design D3:
 * no chart dependency). One bar per local calendar day, zero-dispatch days included.
 */
import React from 'react';
import { chartSeries, formatCount } from './usageViewState.js';
import { formatCost } from '../../lib/format-cost.js';

const W = 800;
const H = 220;
const PAD = { top: 10, right: 8, bottom: 22, left: 56 };

export default function UsageChart({ days = [], metric = 'cost', split = 'model' }) {
  const { series, stacks } = chartSeries(days, split, metric);
  const fmt = (v) => (metric === 'cost' ? formatCost(v, { digits: 2 }) : formatCount(v));
  const max = Math.max(0, ...stacks.map((s) => s.total));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = stacks.length ? plotW / stacks.length : plotW;
  const barW = Math.max(1, slot * 0.72);
  const y = (v) => (max > 0 ? (v / max) * plotH : 0);
  const labelEvery = Math.max(1, Math.ceil(stacks.length / 8));

  return (
    <div className="flex flex-col gap-2" data-testid="usage-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label={`${metric === 'cost' ? 'Cost' : 'Tokens'} per day by ${split}`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH - f * plotH} y2={PAD.top + plotH - f * plotH}
              stroke="hsl(var(--border))" strokeWidth="1" />
            <text x={PAD.left - 6} y={PAD.top + plotH - f * plotH + 3} textAnchor="end" fontSize="10"
              fill="hsl(var(--muted-foreground))">{fmt(max * f)}</text>
          </g>
        ))}
        {stacks.map((stack, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          let base = PAD.top + plotH;
          return (
            <g key={stack.date} data-day={stack.date}>
              <title>{`${stack.date}: ${fmt(stack.total)}`}</title>
              {series.map((s) => {
                const h = y(stack.values[s.key]);
                if (h <= 0) return null;
                base -= h;
                return <rect key={s.key} x={x} y={base} width={barW} height={h} fill={s.color} />;
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="10"
                  fill="hsl(var(--muted-foreground))">{stack.date.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="flex flex-wrap gap-3 text-[11px] text-muted-foreground" aria-label="Chart legend">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
