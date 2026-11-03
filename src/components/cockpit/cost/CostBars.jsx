/**
 * CostBars — the compact form of the one cost meter (COMP-COCKPIT-MONEY-COMPACT-1). F2: the seats block is a row of column-chart
 * PAIRS, one per seat then Codex: left = 5h used %, right = Fable weekly used % (Codex: 7d, plus 5h only when a reading exists; Codex has no 5h window today), same 0-100 height scale, two fills,
 * seat name under the pair and each bar's own reset under it. A pace/cap tick sits on the weekly bar only. Dollars is its bar with
 * the summary on the same line and the top three sessions inline. Layout only: every number comes from `meterRows` / `seatPairs` /
 * `fleetSpend`, and `CostMeter` renders this when it is given `bars`. Anything not printed is one hover (`title`) or one "more" click away.
 */
import React, { useState } from 'react';
import { cn } from '@/lib/utils.js';
import { fillPct, seatPairs, sessionChip, RETIRED_NOTE, CODEX_DAILY_NOT_REPORTED } from './costLogic.js';

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

/** `state`: 'ok' | 'warn' (amber) | 'full' (red, at the cap or the wall). */
const barState = (pct, over) => (pct !== null && pct >= 100 ? 'full' : over ? 'warn' : 'ok');
const FILL = { full: 'bg-destructive', warn: 'bg-[hsl(var(--warning))]' };

/** Horizontal bar, used by the Dollars line. Muted track, accent fill, existing tokens only. */
function Bar({ pct, state = 'ok', testId }) {
  return (
    <div className="h-1 w-full rounded bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct ?? 0)} data-state={state} data-testid={testId}>
      <div className={cn('h-full', FILL[state] ?? 'bg-primary')} style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

/**
 * One vertical bar with its value above and its own reset under it. `n` null renders the muted empty track labelled "n/a".
 * `base` is the ok fill (5h = primary, weekly = chart-2); amber and red replace it. `tick` is a 0-100 mark on the weekly bar.
 */
function Col({ n, state, base, tick = null, reset, title, testId, pctText }) {
  const h = fillPct(n);
  // U2 M10 + F4: 28 px columns (wide enough for "↻2.1h" under the bar), 4 px apart inside a pair.
  return (
    <div className="flex w-7 flex-col items-center gap-0.5" title={title} data-testid={testId}>
      <span className={cn('text-[10px] leading-3 font-mono', h === null ? MUTED : 'text-card-foreground')}>{h === null ? 'n/a' : pctText}</span>
      <div className="relative h-9 w-3 rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={h === null ? undefined : Math.round(h)} data-state={h === null ? 'empty' : state} data-height={h === null ? '' : Math.round(h)}>
        {h !== null && <div className={cn('absolute inset-x-0 bottom-0 rounded', FILL[state] ?? base)} style={{ height: `${h}%` }} />}
        {tick !== null && <div className="absolute -inset-x-0.5 h-0.5 bg-foreground" title="pace" style={{ bottom: `calc(${Math.min(100, Math.max(0, tick))}% - 1px)` }} data-testid={`${testId}-tick`} data-tick={Math.round(tick)} />}
      </div>
      <span className={cn('text-[10px] leading-3 tabular-nums', MUTED)} data-testid={`${testId}-reset`}>{h === null || reset === '—' || reset == null ? '\u00a0' : `↻${reset}`}</span>
    </div>
  );
}

/** U2 M10: under pace is a neutral fill (`--meter-ok`), so only amber (over pace) and red (at the cap) carry a color. */
const FIVE = 'bg-[hsl(var(--meter-ok))]';
const WEEK = 'bg-[hsl(var(--meter-ok)/0.5)]';

/** U2 M10: the key the pairs never had: which bar is which, and what the tick is. */
function Key() {
  return (
    <div className={cn('mt-1 flex flex-wrap items-center gap-x-3 text-[10px] leading-3', MUTED)} data-testid="cost-meter-key" aria-hidden="true">
      <span className="inline-flex items-center gap-1"><span className={cn('inline-block h-2 w-2 rounded-sm', FIVE)} />5h</span>
      <span className="inline-flex items-center gap-1"><span className={cn('inline-block h-2 w-2 rounded-sm', WEEK)} />week</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-2.5 bg-foreground" />pace</span>
      <span>↻ resets in</span>
    </div>
  );
}

/**
 * One seat's pair on its own shaded band (OWNER D-0043, COMP-DAYVIEW-DESIGN-FIX-1 U1): the band is the theme's muted token, the
 * two 24 px columns touch, so the bars sit 12 px apart inside a pair and 32 px apart across pairs (6 + 6 band padding + 8 gap
 * + 6 + 6), and the pairs read as groups.
 */
function Pair({ name, title, testId, flash, press, over = null, children }) {
  return (
    <div className={cn('flex shrink-0 flex-col items-center gap-0.5 rounded-md bg-muted/40 px-1.5 py-1', press && PRESS, flash && 'ring-2 ring-primary')} title={title} data-testid={testId} data-band="seat" data-flash={flash ? 'true' : undefined} {...(press ?? {})}>
      <div className="flex gap-1">{children}</div>
      <span className={cn('text-[11px] leading-4', MUTED)}>{name}</span>
      {/* U2 M10: a colored bar says why in words, so the color is never the only signal. */}
      {over && <span className={cn('text-[10px] leading-3', over === 'full' ? 'text-destructive' : 'text-[hsl(var(--warning-ink))]')} data-testid={`${testId}-over`}>{over === 'full' ? 'at cap' : 'over pace'}</span>}
    </div>
  );
}

/** The loudest state of a pair's bars: 'full' over 'warn', else null. */
const overOf = (...states) => (states.includes('full') ? 'full' : states.includes('warn') ? 'warn' : null);

function Row({ label, title, testId, children }) {
  return (
    <div className="flex items-start gap-2" data-testid={testId}>
      <span className={cn('w-10 shrink-0 whitespace-nowrap text-[11px] leading-4', MUTED)} title={title}>{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export default function CostBars({ rows, seats, seatsError, pending, spend, spendLoading, ceiling, barPct, onSeatOpen, onMoneyOpen, flashSeat }) {
  const [more, setMore] = useState(false);
  const retired = rows.retired;
  const shown = more && rows.hour ? rows.hour.all : rows.hour?.shown ?? [];
  const pairs = seatPairs(rows);
  const cx = rows.codex;
  return (
    <>
      <Row
        label={retired.count > 0 ? 'Seats ⓘ' : 'Seats'}
        title={retired.count > 0 ? `${RETIRED_NOTE(retired.count)}: ${retired.names.join(', ')}` : undefined}
        testId="cost-meter-seats"
      >
        {pending && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" data-testid="cost-meter-skeleton" aria-label="Loading seats" />}
        {/* U2 M4: plain words on screen, the tool's own reason one hover away. */}
        {seatsError && <span className="text-[12px] text-destructive" data-testid="cost-meter-seats-down" title={String(seatsError)}>Seat usage: not read, retrying</span>}
        {retired.count > 0 && <span className="sr-only" data-testid="cost-meter-retired">{RETIRED_NOTE(retired.count)}</span>}
        <div className="flex flex-wrap items-end gap-x-2 gap-y-1.5">
          {pairs.map((p) => {
            const w = p.week;
            const fiveState = barState(fillPct(p.five.n), false);
            const weekState = w ? barState(w.capN !== null && w.n !== null && w.n >= w.capN ? 100 : null, w.over) : 'ok';
            return (
              <Pair
                over={overOf(fiveState, weekState)}
                key={p.id}
                name={p.name}
                testId={`cost-meter-seat-${p.id}`}
                flash={flashSeat === p.id}
                title={`${p.label}: 5h ${p.five.pct}, resets in ${p.five.reset}. ${p.seven.fiveOnly ? p.seven.text : `7d ${p.seven.text}, resets in ${p.seven.reset}`}. Fable weekly ${w ? `${w.pct}${w.cap ? ` of ${w.cap} cap` : ''}, resets in ${w.reset}` : 'n/a'}`}
                press={pressable(onSeatOpen && ((rect) => onSeatOpen((Array.isArray(seats) && seats.find((r) => r.id === p.id)) || p, rect)), `${p.label}: where this seat stands`)}
              >
                <Col n={p.five.n} pctText={p.five.pct} reset={p.five.reset} base={FIVE} state={fiveState} testId={`cost-meter-5h-${p.id}`} title={`${p.label} 5h used ${p.five.pct}, resets in ${p.five.reset}`} />
                <Col
                  n={w ? w.n : null} pctText={w?.pct} reset={w?.reset} base={WEEK} tick={w ? w.tick : null}
                  state={weekState}
                  testId={`cost-meter-fable-${p.id}`} title={w ? `${p.label} Fable weekly ${w.pct}${w.cap ? ` of ${w.cap} cap` : ''}, resets in ${w.reset}${w.tick !== null ? `, pace line ${Math.round(w.tick)}%` : ''}` : `${p.label}: no Fable weekly reading`}
                />
              </Pair>
            );
          })}
          {cx && (
            <div className="border-l border-border pl-2">
              <Pair
                name="Codex"
                testId="cost-meter-codex"
                over={overOf(cx.five.n !== null ? barState(fillPct(cx.five.n), false) : 'ok', barState(null, cx.reported && cx.state !== 'ok'))}
                title={cx.reported ? `${cx.label}: ${cx.pts ?? '—'}/${cx.cap ?? '—'} pts today against the daily cap${cx.state !== 'ok' ? ` (${cx.state})` : ''}` : `${cx.label}: ${CODEX_DAILY_NOT_REPORTED}`}
              >
                {cx.five.n !== null && <Col n={cx.five.n} pctText={`${Math.round(cx.five.n ?? 0)}%`} reset={cx.five.reset} base={FIVE} state={barState(fillPct(cx.five.n), false)} testId="cost-meter-5h-codex" title={`Codex 5h used ${Math.round(cx.five.n)}%, resets in ${cx.five.reset}`} />}
                <Col n={cx.seven.n} pctText={`${Math.round(cx.seven.n ?? 0)}%`} reset={cx.seven.reset} base={WEEK} state={barState(null, cx.reported && cx.state !== 'ok')} testId="cost-meter-7d-codex" title={`Codex 7d used ${cx.seven.n === null ? 'n/a' : `${Math.round(cx.seven.n)}%`}, resets in ${cx.seven.reset}`} />
              </Pair>
              {!cx.reported && <span className={cn('block text-[10px]', MUTED)} data-testid="cost-meter-codex-unreported">{CODEX_DAILY_NOT_REPORTED}</span>}
            </div>
          )}
        </div>
        {pairs.length > 0 && <Key />}
      </Row>

      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', onMoneyOpen && PRESS)} data-testid="cost-meter-money" {...pressable(onMoneyOpen, 'Where the money stands')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 flex-1 text-[11px] leading-4" data-testid="cost-meter-dollars">
          {spendLoading && !spend && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" data-testid="cost-meter-dollars-skeleton" />}
          {ceiling?.down && <span className={MUTED} data-testid="cost-meter-dollars-down" title={ceiling.down}>Spend ceiling: not read, retrying</span>}
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
          {spend?.spend?.down && <span className={MUTED} data-testid="cost-meter-hour-down" title={spend.spend.down}>Hourly spend: not read, retrying</span>}
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
    </>
  );
}
