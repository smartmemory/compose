/**
 * DayPhone.jsx — COMP-COCKPIT-RIBBON-NOW-1: the Day page below the phone breakpoint (I7 of the UX-ADJ-1 report). No ribbon:
 * the WHAT line, the cost meter and one "now" list. The alert chip lives in the header already. Everything here wraps; the
 * page never scrolls sideways.
 */
import React, { useMemo } from 'react';
import WhatLine from '../../cockpit/what/WhatLine.jsx';
import RibbonMeterLayer from '../meter/RibbonMeterLayer.jsx';
import { phoneLines, landedSince, agoWords, sinceWords } from './nowLists.js';
import { sourceErrorLines } from '../ribbonLayout.js';

const sub = 'text-[12px] text-muted-foreground';

/** U2 M14: the state dot, in the ribbon's own state colors (`--rb-*` in index.css), so a phone reader learns one palette. */
const DOT = {
  working: { background: 'var(--rb-work)' },
  stale: { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--rb-work)' },
  owner: { background: 'hsl(var(--needs-you))' },
  review: { background: 'var(--rb-wait)' },
  gate: { background: 'var(--rb-gate)' },
  quota: { background: 'var(--rb-quota-bg)' },
  unknown: { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px hsl(var(--muted-foreground))' },
};
const NO_DOT = { background: 'hsl(var(--muted-foreground) / .45)' };

/**
 * `feed` is the Now feed (DayView's `nowData`: the window that holds now, through the same owner-ask filter as the ribbon),
 * so this list and the ribbon's NOW words agree (U2 F1). `sourceGood` is `useRibbonFeed().sourceGood` for the missing-source
 * lines, the same lines the desktop page shows (U2 NOW M1).
 */
export default function DayPhone({ feed, index, meter, lastVisitAt, onOpenFleet, onNavigate, onCountOpen, now = Date.now(), sourceGood = {} }) {
  const lines = useMemo(() => phoneLines(feed, index, now), [feed, index, now]);
  const landed = useMemo(() => landedSince(index, lastVisitAt, null), [index, lastVisitAt]);
  const missing = sourceErrorLines(feed?.sourceErrors, sourceGood, typeof feed?.now === 'string' ? feed.now : null);
  // U2 NOW M2: with the unit index down, no lane can read "waiting on review"; say so instead of implying nothing waits.
  const indexDown = !Array.isArray(index?.units);
  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden flex flex-col gap-3 p-4" data-testid="day-phone"
      style={{ paddingLeft: 'max(16px, env(safe-area-inset-left))', paddingRight: 'max(16px, env(safe-area-inset-right))', paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
      <div className="shrink-0"><WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} onCountOpen={onCountOpen} /></div>
      {/* shrink-0: an overflow-x-hidden flex child may shrink to nothing in this column, which hid the meter in the live shot.
          C5 (U1): no height cap and no inner scroll. The box grows to whole rows, so the hottest seat and Codex are never cut
          in half or hidden behind a nested scroll; the page itself scrolls. */}
      <div className="shrink-0 min-w-0 max-w-full flex flex-col gap-1" data-testid="day-phone-meter">
        <div className="overflow-x-hidden" data-testid="day-phone-meter-box"><RibbonMeterLayer meter={meter} onNavigate={onNavigate} /></div>
      </div>
      <section data-testid="day-phone-now" className="shrink-0 min-w-0">
        <h2 className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Now</h2>
        {lines === null ? <p className={`m-0 ${sub}`} data-testid="now-unavailable">source unavailable</p>
          : lines.length === 0 ? <p className={`m-0 ${sub}`} data-testid="now-empty">{indexDown ? 'Nothing current or queued.' : 'Nothing current, waiting or queued.'}</p>
            : (
              <ul className="m-0 p-0 list-none" data-testid="day-phone-lanes">
                {lines.map((l) => (
                  // M14: two lines. Line one: state dot, lane, state words, ETA right-aligned in tabular figures; line two: the unit.
                  <li key={l.lane} className="py-2 border-b border-border last:border-b-0 text-[length:var(--type-body)] min-w-0" data-testid="day-phone-lane"
                    data-tone={l.tone ?? ''} aria-label={`${l.lane}: ${l.text}`}>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span aria-hidden="true" data-testid="day-phone-dot" className="inline-block h-2 w-2 shrink-0 self-center rounded-full" style={DOT[l.tone] || NO_DOT} />
                      <span className="min-w-0 flex-1 truncate"><b>{l.lane}</b> <span className="text-muted-foreground">{l.state}</span></span>
                      {l.eta !== null && <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="day-phone-eta">{l.eta === 'on answer' ? '◆ on answer' : `ETA ${l.eta}`}</span>}
                    </div>
                    <div className={`${sub} pl-4 break-words`} data-testid="day-phone-title">{l.title}</div>
                  </li>
                ))}
              </ul>
            )}
        {lines !== null && indexDown && <p className={`m-0 mt-1 ${sub}`} data-testid="now-waits-unknown">waits unknown (unit index unavailable)</p>}
        {missing.length > 0 && (
          <ul className={`m-0 mt-1 pl-4 ${sub}`} data-testid="day-source-errors">
            {missing.map((m) => <li key={m.key} title={m.title}>{m.text}</li>)}
          </ul>
        )}
      </section>
      <section data-testid="day-phone-landed" className="shrink-0 min-w-0">
        <h2 className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {landed === null ? 'Landed since you left' : `Landed since you left (${landed.rows.length})`}
        </h2>
        {landed === null ? <p className={`m-0 ${sub}`} data-testid="now-unavailable">{lastVisitAt === null ? 'no earlier visit recorded' : 'source unavailable'}</p> : (
          <ul className="m-0 p-0 list-none">
            {landed.rows.map((r) => (
              <li key={r.unit} className="py-1.5 border-b border-border last:border-b-0 text-[13px] break-words" data-testid="day-phone-landed-row">
                <b>{r.lane ?? '?'}</b>: {[r.unit, r.title].filter(Boolean).join(' · ')}
                <span className={`block ${sub}`}>{r.state} · {sinceWords(r.landedAt, now)} ({agoWords(r.landedAt, now)} ago)</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
