import React from 'react';
import { Tip } from './ProcessBadge.jsx';
import { BUCKETS, NOT_RECORDED, bucketText, splitSummary } from '../processLogic.js';

/**
 * TimeSplitBars — P6, the stamps-derived time split as one stacked bar per lane (POLISH). Segment widths are the
 * bucket minutes relative to each other (visual only, no share is printed); the exact minutes per bucket, the
 * unknown rules and the not-recorded buckets are in the row's tooltip. A lane with no known unit is hatched.
 * COMP-COCKPIT-FLEET-PROJECTS-1: `order` (the Fleet PROJECTS list, null = every lane) picks and orders the rows.
 */

const COLOURS = {
  authoring: 'hsl(var(--primary) / 0.75)',
  review: 'hsl(var(--artifact) / 0.75)',
  fix_rounds: 'hsl(var(--destructive) / 0.6)',
  gate: 'hsl(var(--success) / 0.7)',
  waiting_owner: 'hsl(var(--muted-foreground) / 0.7)',
  waiting: 'hsl(var(--warning))',
};
const HATCH = { backgroundImage: 'repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.35) 0 4px, transparent 4px 8px)' };
const warnStyle = { color: 'hsl(var(--warning))' };

function Bar({ ts }) {
  const known = ts.known > 0;
  const mins = BUCKETS.map(([k]) => [k, Number.isFinite(ts.minutes?.[k]) ? Math.max(0, ts.minutes[k]) : 0]);
  const total = mins.reduce((s, [, v]) => s + v, 0);
  if (!known || total <= 0) return <div className="h-3 w-full rounded opacity-60" style={HATCH} aria-hidden="true" />;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded" style={{ background: 'hsl(var(--muted))' }} aria-hidden="true">
      {mins.map(([k, v]) => (v > 0 ? (
        <span key={k} className="h-full" style={{ width: `${(v / total) * 100}%`, background: COLOURS[k], boxShadow: k === 'waiting' ? 'inset 0 0 0 1px hsl(var(--warning) / 0.9)' : undefined }} />
      ) : null))}
    </div>
  );
}

/** The row's tooltip: every bucket's minutes (`p6-<lane>-<bucket>`), the not-recorded buckets and the unit summary. */
function RowTip({ lane, ts, warnings }) {
  return (
    <span className="flex flex-col gap-0.5">
      {BUCKETS.map(([k, l]) => (
        <span key={k} className="flex justify-between gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: COLOURS[k] }} />{l}</span>
          <span data-testid={`p6-${lane}-${k}`}>{bucketText(ts, k)}</span>
        </span>
      ))}
      <span className="flex justify-between gap-3"><span>Escalation, other</span><span>{NOT_RECORDED}</span></span>
      <span className="mt-1 border-t border-border pt-1" data-testid={`p6-units-${lane}`}>{splitSummary(ts)}
        {warnings?.length ? <span style={warnStyle}> ({warnings.length} warning{warnings.length === 1 ? '' : 's'})</span> : null}</span>
    </span>
  );
}

export default function TimeSplitBars({ stamps, order = null }) {
  const all = stamps.value.lanes ?? {};
  const lanes = order ? order.filter((n) => Object.hasOwn(all, n)).map((n) => [n, all[n]]) : Object.entries(all);
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3" data-testid="process-p6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">Time split per lane</h3>
        <span className="text-[11px] text-muted-foreground">from unit stamps</span>
        {BUCKETS.map(([k, l]) => (
          <span key={k} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="h-2 w-2 rounded-sm" style={{ background: COLOURS[k] }} />{l}
          </span>
        ))}
      </div>
      <div className="flex flex-col" role="table" aria-label="Time split per lane" data-testid="process-p6-table">
        {lanes.map(([lane, l]) => (
          <div key={lane} role="row" className="grid items-center gap-2 py-0.5" style={{ gridTemplateColumns: '112px minmax(0, 1fr) 220px' }} data-testid={`p6-lane-${lane}`}>
            <span role="rowheader" className="truncate font-mono text-[12px]">{lane}</span>
            {l.error || !l.timeSplit ? (
              <span role="cell" className="col-span-2 truncate text-[11px]" style={warnStyle} data-testid={`p6-error-${lane}`}>unavailable: {l.error ?? 'no time split'}</span>
            ) : (<>
              <Tip as="div" role="cell" tip={<RowTip lane={lane} ts={l.timeSplit} warnings={l.warnings} />} align="left"
                className={`block rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${l.timeSplit.known > 0 ? '' : 'cursor-help'}`}>
                <Bar ts={l.timeSplit} />
              </Tip>
              <span role="cell" className="truncate text-right font-mono text-[11px] text-muted-foreground">
                {l.timeSplit.known} known · {l.timeSplit.unknown} unknown · {l.timeSplit.outside} out
                {l.warnings?.length ? <span style={warnStyle}> · {l.warnings.length}⚠</span> : null}
              </span>
            </>)}
          </div>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">Job buckets can overlap; waiting cannot. Lane totals sum known units only. An unknown unit adds to no bucket. Hover or focus a bar for its minutes; a hatched bar has no known unit.</div>
    </section>
  );
}
