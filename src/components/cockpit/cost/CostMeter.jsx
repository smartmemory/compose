/**
 * CostMeter — the one cost meter (COMP-COCKPIT-COST-METER-1): seat quota, Fable weekly, Codex points against the
 * daily cap, and dollars against our own ceiling, rounded one way. Presentational: the caller owns the fetches
 * (`usageClient.getSeats()` and the shared `useFleet` poll) and passes the results, so the same component sits on
 * Home and in Usage > Seats and fleet without a second reader.
 *
 * Props: `seats` (rows array, null until the call answers), `seatsError`, `loading` (seats call pending),
 * `spend` (`fleetSpend(...)` or null), `spendLoading`, `asOf` (seats reader `generated_at`), `now` (ISO, tests), `compact`.
 */
import React from 'react';
import { cn } from '@/lib/utils.js';
import {
  meterRows, fmtPct, asOfText, RETIRED_NOTE, API_CREDIT_NOTE, DOLLARS_PER_SEAT_NOTE,
} from './costLogic.js';

const MUTED = 'text-muted-foreground';

function Line({ title, testId, children }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <h4 className="text-[11px] font-medium text-card-foreground">{title}</h4>
      {children}
    </div>
  );
}

export default function CostMeter({ seats, seatsError = null, loading = false, spend = null, spendLoading = false, asOf = null, now, compact = false }) {
  const at = now ? Date.parse(now) : Date.now();
  const rows = meterRows(seats, spend, at);
  const pending = seats === null && !seatsError;
  const ceiling = spend?.ceiling;
  const barPct = typeof ceiling?.pct === 'number' && Number.isFinite(ceiling.pct) ? Math.min(100, Math.max(0, ceiling.pct)) : null;
  return (
    <section
      className={cn('rounded-lg border border-border bg-card flex flex-col', compact ? 'p-2 gap-2' : 'p-3 gap-3')}
      data-testid="cost-meter"
    >
      <Line title="Seats" testId="cost-meter-seats">
        {pending && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" data-testid="cost-meter-skeleton" aria-label="Loading seats" />}
        {seatsError && <span className="text-[12px] text-destructive" data-testid="cost-meter-seats-down">usage_watch unavailable: {seatsError}</span>}
        {rows.seats.map((s) => (
          <div key={s.id} className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[12px]" data-testid={`cost-meter-seat-${s.id}`}>
            <span>{s.label}</span>
            <span className="font-mono" data-testid={`cost-meter-5h-${s.id}`}>5h {s.five.pct}<span className={MUTED}> · {s.five.reset}</span></span>
            <span className={cn('font-mono', s.seven.fiveOnly && MUTED)} data-testid={`cost-meter-7d-${s.id}`}>
              {s.seven.fiveOnly ? s.seven.text : <>7d {s.seven.text}<span className={MUTED}> · {s.seven.reset}</span></>}
            </span>
          </div>
        ))}
        {rows.retired.count > 0 && (
          <span className={cn('text-[11px]', MUTED)} title={rows.retired.names.join(', ')} data-testid="cost-meter-retired">
            {RETIRED_NOTE(rows.retired.count)}
          </span>
        )}
      </Line>

      {rows.fable.length > 0 && (
        <Line title="Fable weekly" testId="cost-meter-fable">
          {rows.fable.map((f) => (
            <div key={f.id} className="grid grid-cols-[1fr_auto] gap-x-3 text-[12px]" data-testid={`cost-meter-fable-${f.id}`}>
              <span>{f.label}</span>
              <span className={cn('font-mono', f.over && 'text-[hsl(var(--warning))]')}>
                {f.text}<span className={MUTED}>{f.cap ? ` of ${f.cap} cap` : ''} · {f.reset}</span>
              </span>
            </div>
          ))}
        </Line>
      )}

      {rows.codex && (
        <Line title="Codex points today" testId="cost-meter-codex">
          <span className="text-[12px] font-mono">
            {rows.codex.pts ?? '—'} / {rows.codex.cap ?? '—'} pts{' '}
            <span className={cn(rows.codex.state !== 'ok' && 'text-[hsl(var(--warning))]', rows.codex.state === 'ok' && MUTED)}>{rows.codex.state}</span>
          </span>
        </Line>
      )}

      <Line title="Dollars" testId="cost-meter-dollars">
        {spendLoading && !spend && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" data-testid="cost-meter-dollars-skeleton" />}
        {ceiling?.down && <span className={cn('text-[12px]', MUTED)} data-testid="cost-meter-dollars-down">{ceiling.down}</span>}
        {ceiling && !ceiling.down && (
          <>
            <span className={cn('text-[12px]', ceiling.warn && 'text-[hsl(var(--warning))]')} data-testid="cost-meter-ceiling">{ceiling.text}</span>
            {barPct !== null && (
              <div className="h-1.5 w-full rounded bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(barPct)} data-testid="cost-meter-ceiling-bar">
                <div className={cn('h-full', ceiling.warn ? 'bg-[hsl(var(--warning))]' : 'bg-primary')} style={{ width: `${barPct}%` }} />
              </div>
            )}
          </>
        )}
        {spend?.spend?.down && <span className={cn('text-[12px]', MUTED)} data-testid="cost-meter-hour-down">{spend.spend.down}</span>}
        {rows.hour && (
          <div className="flex flex-col" data-testid="cost-meter-hour">
            <span className="text-[12px]">{spend.spend.text}</span>
            {rows.hour.shown.map((r) => <span key={r} className="font-mono text-[11px] text-muted-foreground whitespace-pre">{r}</span>)}
            {rows.hour.more > 0 && <span className={cn('text-[11px]', MUTED)}>+{rows.hour.more} more</span>}
          </div>
        )}
        <span className={cn('text-[11px]', MUTED)} data-testid="cost-meter-per-seat-usd">{DOLLARS_PER_SEAT_NOTE}</span>
      </Line>

      <span className={cn('text-[11px]', MUTED)} data-testid="cost-meter-api-credit">{API_CREDIT_NOTE}</span>
      <span className={cn('text-[11px]', MUTED)} data-testid="cost-meter-asof">{loading && pending ? 'reading…' : asOfText(asOf, at)}</span>
    </section>
  );
}
