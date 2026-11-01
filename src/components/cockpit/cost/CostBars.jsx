/**
 * CostBars — the compact form of the one cost meter (COMP-COCKPIT-MONEY-COMPACT-1): seats and Fable weekly as a row of
 * four inline bars each, Codex as one small bar, Dollars as its progress bar with the summary on the same line and the top three
 * sessions inline. Layout only: every number comes from `meterRows` / `fleetSpend` exactly as `CostMeter`'s list form reads
 * them, and `CostMeter` renders this when it is given `bars`. A number the list form printed is inline here, or one hover
 * (`title`) or one "more" click away.
 */
import React, { useState } from 'react';
import { cn } from '@/lib/utils.js';
import { fillPct, shortSeat, sessionChip, RETIRED_NOTE, apiCreditText, DOLLARS_PER_SEAT_NOTE, asOfText } from './costLogic.js';

const MUTED = 'text-muted-foreground';
const WARN = 'text-[hsl(var(--warning))]';

/** Click and Enter/Space on a non-button block, handing the handler the block's rect. Plain props when there is no handler. */
export function pressable(handler, label) {
  if (!handler) return {};
  const fire = (el) => handler(el.getBoundingClientRect());
  return {
    role: 'button', tabIndex: 0, 'aria-label': label,
    onClick: (e) => fire(e.currentTarget),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e.currentTarget); } },
  };
}
export const PRESS = 'cursor-pointer rounded hover:bg-muted focus-visible:bg-muted outline-none';

/** `state`: 'ok' | 'warn' (amber) | 'full' (red, at the cap or the wall). Muted track, accent fill, existing tokens only. */
function Bar({ pct, state = 'ok', testId }) {
  const fill = state === 'full' ? 'bg-destructive' : state === 'warn' ? 'bg-[hsl(var(--warning))]' : 'bg-primary';
  return (
    <div className="h-1 w-full rounded bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct ?? 0)} data-state={state} data-testid={testId}>
      <div className={cn('h-full', fill)} style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

const barState = (pct, over) => (pct !== null && pct >= 100 ? 'full' : over ? 'warn' : 'ok');
const GRID = 'grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5';

function Row({ label, title, testId, children }) {
  return (
    <div className="flex items-start gap-2" data-testid={testId}>
      <span className={cn('w-12 shrink-0 text-[11px] leading-4', MUTED)} title={title}>{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export default function CostBars({ rows, seats, seatsError, pending, spend, spendLoading, ceiling, barPct, credit, asOfLine, onSeatOpen, onMoneyOpen, flashSeat }) {
  const [more, setMore] = useState(false);
  const retired = rows.retired;
  const shown = more && rows.hour ? rows.hour.all : rows.hour?.shown ?? [];
  return (
    <>
      <Row
        label={retired.count > 0 ? 'Seats 5h ⓘ' : 'Seats 5h'}
        title={retired.count > 0 ? `${RETIRED_NOTE(retired.count)}: ${retired.names.join(', ')}` : undefined}
        testId="cost-meter-seats"
      >
        {pending && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" data-testid="cost-meter-skeleton" aria-label="Loading seats" />}
        {seatsError && <span className="text-[12px] text-destructive" data-testid="cost-meter-seats-down">usage_watch unavailable: {seatsError}</span>}
        {retired.count > 0 && <span className="sr-only" data-testid="cost-meter-retired">{RETIRED_NOTE(retired.count)}</span>}
        <div className={GRID}>
          {rows.seats.map((s) => {
            const pct = fillPct(s.five.n);
            return (
              <div
                key={s.id}
                className={cn('flex flex-col gap-0.5 px-1 -mx-1 text-[11px] leading-4', onSeatOpen && PRESS, flashSeat === s.id && 'outline outline-2 outline-primary motion-safe:animate-pulse')}
                title={`${s.label}: 5h ${s.five.pct}, resets in ${s.five.reset}. ${s.seven.fiveOnly ? s.seven.text : `7d ${s.seven.text}, resets in ${s.seven.reset}`}`}
                data-testid={`cost-meter-seat-${s.id}`}
                data-flash={flashSeat === s.id ? 'true' : undefined}
                {...pressable(onSeatOpen && ((rect) => onSeatOpen((Array.isArray(seats) && seats.find((r) => r.id === s.id)) || s, rect)), `${s.label}: where this seat stands`)}
              >
                <span className="font-mono truncate" data-testid={`cost-meter-5h-${s.id}`}>
                  {shortSeat(s.label)} {s.five.pct}<span className={MUTED}> · {s.five.reset}</span>
                  {!s.seven.fiveOnly && <span data-testid={`cost-meter-7d-${s.id}`} className={MUTED}> · 7d {s.seven.text}</span>}
                </span>
                <Bar pct={pct} state={barState(pct, false)} />
              </div>
            );
          })}
        </div>
      </Row>

      {rows.fable.length > 0 && (
        <Row label="Fable wk" title="Fable weekly: used of cap, resets in" testId="cost-meter-fable">
          <div className={GRID}>
            {rows.fable.map((f) => {
              const pct = fillPct(f.n, f.capN ?? 100);
              return (
                <div key={f.id} className="flex flex-col gap-0.5 text-[11px] leading-4" title={`${f.label}: Fable ${f.text}${f.cap ? ` of ${f.cap} cap` : ''}, resets in ${f.reset}`} data-testid={`cost-meter-fable-${f.id}`}>
                  <span className={cn('font-mono truncate', f.over && WARN)}>
                    {shortSeat(f.label)} {f.text}<span className={MUTED}>{f.cap ? `/${f.cap}` : ''} · {f.reset}</span>
                  </span>
                  <Bar pct={pct} state={barState(pct, f.over)} />
                </div>
              );
            })}
          </div>
        </Row>
      )}

      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', onMoneyOpen && PRESS)} data-testid="cost-meter-money" {...pressable(onMoneyOpen, 'Where the money stands')}>
        {rows.codex && (
          <div className="flex items-center gap-2 text-[11px] leading-4 shrink-0" data-testid="cost-meter-codex" title={`${rows.codex.label}: Codex points today against the daily cap`}>
            <span className={MUTED}>Codex</span>
            <span className="font-mono">{rows.codex.pts ?? '—'}/{rows.codex.cap ?? '—'} pts</span>
            <span className="w-14"><Bar pct={fillPct(rows.codex.pts, rows.codex.cap)} state={barState(fillPct(rows.codex.pts, rows.codex.cap), rows.codex.state !== 'ok')} /></span>
            {rows.codex.state !== 'ok' && <span className={WARN}>{rows.codex.state}</span>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 flex-1 text-[11px] leading-4" data-testid="cost-meter-dollars">
          {spendLoading && !spend && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" data-testid="cost-meter-dollars-skeleton" />}
          {ceiling?.down && <span className={MUTED} data-testid="cost-meter-dollars-down">{ceiling.down}</span>}
          {ceiling && !ceiling.down && (
            <>
              <span className={cn(ceiling.warn && WARN)} data-testid="cost-meter-ceiling">{ceiling.text}</span>
              {barPct !== null && (
                <span className="w-24 min-w-16 flex-1"><Bar pct={barPct} state={barState(barPct, ceiling.warn)} testId="cost-meter-ceiling-bar" /></span>
              )}
            </>
          )}
        </div>
      </div>

      {(spend?.spend?.down || rows.hour) && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] leading-4" data-testid="cost-meter-hour">
          {spend?.spend?.down && <span className={MUTED} data-testid="cost-meter-hour-down">{spend.spend.down}</span>}
          {rows.hour && <span>{spend.spend.text}</span>}
          {rows.hour && (
            <span className={cn('font-mono', MUTED)} data-testid="cost-meter-sessions">{shown.map(sessionChip).join(' · ')}</span>
          )}
          {rows.hour && rows.hour.more > 0 && (
            <button type="button" className={cn('hover:underline focus-visible:underline outline-none', MUTED)} aria-expanded={more} data-testid="cost-meter-sessions-more" onClick={() => setMore((v) => !v)}>
              {more ? 'less' : `+${rows.hour.more} more`}
            </button>
          )}
        </div>
      )}

      <div className={cn('flex flex-wrap gap-x-3 text-[11px] leading-4', MUTED)} data-testid="cost-meter-foot">
        <span data-testid="cost-meter-per-seat-usd">{DOLLARS_PER_SEAT_NOTE}</span>
        <span data-testid="cost-meter-api-credit">{apiCreditText(credit)}</span>
        <span data-testid="cost-meter-asof">{asOfLine}</span>
      </div>
    </>
  );
}
