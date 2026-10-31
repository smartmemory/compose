/**
 * DayPhone.jsx — COMP-COCKPIT-RIBBON-NOW-1: the Day page below the phone breakpoint (I7 of the UX-ADJ-1 report). No ribbon:
 * the WHAT line, the cost meter and one "now" list. The alert chip lives in the header already. Everything here wraps; the
 * page never scrolls sideways.
 */
import React, { useMemo, useState } from 'react';
import WhatLine from '../../cockpit/what/WhatLine.jsx';
import RibbonMeterLayer from '../meter/RibbonMeterLayer.jsx';
import { phoneLines, landedSince, agoWords, sinceWords } from './nowLists.js';

const sub = 'text-[12px] text-muted-foreground';

export default function DayPhone({ feed, index, meter, lastVisitAt, onOpenFleet, onNavigate, onCountOpen, now = Date.now() }) {
  const [meterOpen, setMeterOpen] = useState(false);
  const lines = useMemo(() => phoneLines(feed, index, now), [feed, index, now]);
  const landed = useMemo(() => landedSince(index, lastVisitAt, null), [index, lastVisitAt]);
  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden flex flex-col gap-3 p-3" data-testid="day-phone">
      <div className="shrink-0"><WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} onCountOpen={onCountOpen} /></div>
      {/* shrink-0: an overflow-x-hidden flex child may shrink to nothing in this column, which hid the meter in the live shot. */}
      <div className="shrink-0 min-w-0 max-w-full flex flex-col gap-1" data-testid="day-phone-meter">
        <div className={`${meterOpen ? 'max-h-[60vh]' : 'max-h-[120px]'} overflow-y-auto overflow-x-hidden`} data-testid="day-phone-meter-box"><RibbonMeterLayer meter={meter} onNavigate={onNavigate} /></div>
        <button type="button" className="self-start text-[12px] text-muted-foreground hover:text-foreground hover:underline outline-none" aria-expanded={meterOpen} data-testid="day-phone-meter-toggle" onClick={() => setMeterOpen((v) => !v)}>
          {meterOpen ? 'Show less ▴' : 'Show all seats and dollars ▾'}
        </button>
      </div>
      <section data-testid="day-phone-now" className="shrink-0 min-w-0">
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
