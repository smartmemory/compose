/**
 * DayPhone.jsx — COMP-COCKPIT-RIBBON-NOW-1: the Day page below the phone breakpoint (I7 of the UX-ADJ-1 report). No ribbon:
 * the WHAT line, the cost meter and one "now" list. The alert chip lives in the header already. Everything here wraps; the
 * page never scrolls sideways.
 */
import React, { useMemo } from 'react';
import WhatLine from '../../cockpit/what/WhatLine.jsx';
import RibbonMeterLayer from '../meter/RibbonMeterLayer.jsx';
import { phoneLines, landedSince, agoWords, sinceWords, stripSegs, STRIP_HOURS } from './nowLists.js';
import { DayMissingSources, DaySourceNotes } from '../DaySourceNotes.jsx';

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

/** U3 (DV#15): the strip's fills, the same `--rb-*` tokens as the dot and the ribbon's spans. */
const STRIP_FILL = {
  working: 'var(--rb-work)', owner: 'hsl(var(--needs-you))', review: 'var(--rb-wait)', gate: 'var(--rb-gate)',
  quota: 'var(--rb-quota-bg)', unknown: 'hsl(var(--muted-foreground) / .45)',
};
const STRIP_W = 72;
const STRIP_H = 12;

/** U3 (DV#15): the last 12 h of one lane, so the phone keeps the shape of the day the ribbon draws. */
function LaneStrip({ lane, now }) {
  const segs = stripSegs(lane, now, { px: STRIP_W });
  return (
    <svg width={STRIP_W} height={STRIP_H} viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} className="block shrink-0" role="img"
      aria-label={`${lane?.lane ?? 'lane'}, last ${STRIP_HOURS} hours`} data-testid="day-phone-strip">
      <line x1="0" x2={STRIP_W} y1={STRIP_H / 2} y2={STRIP_H / 2} style={{ stroke: 'hsl(var(--border))' }} />
      {segs.map((g, i) => (g.tone === 'norec'
        ? <rect key={i} data-tone="norec" x={g.x} y="2.5" width={g.w} height={STRIP_H - 5} rx="1.5" style={{ fill: 'none', stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '2 1.5', strokeWidth: 0.8 }} />
        : <rect key={i} data-tone={g.tone} x={g.x} y={g.tone === 'owner' ? 0 : 2} width={g.w} height={g.tone === 'owner' ? STRIP_H : STRIP_H - 4} rx="1.5" style={{ fill: STRIP_FILL[g.tone] }} />))}
    </svg>
  );
}

/**
 * `feed` is the Now feed (DayView's `nowData`: the window that holds now, through the same owner-ask filter as the ribbon),
 * so this list and the ribbon's NOW words agree (U2 F1). `sources` is DayView's one source state (`daySources.js`): the
 * failed and stale lines and the missing-source lines, the same the desktop page and the Now drawer show (U3, review U2 F2).
 */
export default function DayPhone({ feed, index, meter, lastVisitAt, onOpenFleet, onNavigate, onCountOpen, now = Date.now(), sources = null }) {
  const lines = useMemo(() => phoneLines(feed, index, now), [feed, index, now]);
  const landed = useMemo(() => landedSince(index, lastVisitAt, null), [index, lastVisitAt]);
  const laneOf = useMemo(() => new Map((Array.isArray(feed?.lanes) ? feed.lanes : []).map((l) => [l.lane, l])), [feed]);
  const stripNow = typeof feed?.now === 'string' ? feed.now : now;
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
        <DaySourceNotes sources={sources} className="mb-1" />
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
                    <div className="flex items-center gap-2 pl-4 min-w-0">
                      <div className={`${sub} min-w-0 flex-1 break-words`} data-testid="day-phone-title">{l.title}</div>
                      <LaneStrip lane={laneOf.get(l.lane)} now={stripNow} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
        {lines !== null && indexDown && <p className={`m-0 mt-1 ${sub}`} data-testid="now-waits-unknown">waits unknown (unit index unavailable)</p>}
        <DayMissingSources sources={sources} className="mt-1" />
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
