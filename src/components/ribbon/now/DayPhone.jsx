/**
 * DayPhone.jsx — COMP-COCKPIT-RIBBON-NOW-1: the Day page below the phone breakpoint (I7 of the UX-ADJ-1 report). No ribbon:
 * the WHAT line, the cost meter and one "now" list. The alert chip lives in the header already. Everything here wraps; the
 * page never scrolls sideways.
 */
import React, { useMemo } from 'react';
import WhatLine from '../../cockpit/what/WhatLine.jsx';
import CostMeter from '../../cockpit/cost/CostMeter.jsx';
import { phoneLines, landedSince, agoWords, sinceWords } from './nowLists.js';

const sub = 'text-[12px] text-muted-foreground';

export default function DayPhone({ feed, index, meter, lastVisitAt, onOpenFleet, onNavigate, onCountOpen, now = Date.now() }) {
  const lines = useMemo(() => phoneLines(feed, index), [feed, index]);
  const landed = useMemo(() => landedSince(index, lastVisitAt, null), [index, lastVisitAt]);
  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden flex flex-col gap-3 p-3" data-testid="day-phone">
      <WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} onCountOpen={onCountOpen} />
      <div className="min-w-0 max-w-full overflow-x-hidden" data-testid="day-phone-meter"><CostMeter compact {...meter} /></div>
      <section data-testid="day-phone-now" className="min-w-0">
        <h2 className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Now</h2>
        {lines === null ? <p className={`m-0 ${sub}`} data-testid="now-unavailable">source unavailable</p>
          : lines.length === 0 ? <p className={`m-0 ${sub}`}>Nothing current, waiting or queued.</p>
            : (
              <ul className="m-0 p-0 list-none" data-testid="day-phone-lanes">
                {lines.map((l) => (
                  <li key={l.lane} className="py-1.5 border-b border-border last:border-b-0 text-[13px] break-words" data-testid="day-phone-lane"><b>{l.lane}</b>: {l.text}</li>
                ))}
              </ul>
            )}
      </section>
      <section data-testid="day-phone-landed" className="min-w-0">
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
