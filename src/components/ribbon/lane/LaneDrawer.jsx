import React, { useEffect, useRef } from 'react';
import { CAUSE_WORD, expectedLanding, lastLanded, minutesWord, nextLines, nowLine, timeLost } from './laneLogic.js';
import { when } from '../ribbonLayout.js';

const H = 'm-0 mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground';
const P = 'm-0 text-[13px] text-foreground';

function Section({ id, title, children }) {
  return <section className="py-2 border-b border-border" data-testid={`drawer-${id}`}><h3 className={H}>{title}</h3>{children}</section>;
}

/**
 * LaneDrawer — the right-hand side drawer for one lane (COMP-COCKPIT-RIBBON-LANE-1): NOW, NEXT, EXPECTED LANDING, LAST LANDED,
 * TIME LOST, WHO AND WHERE, then the link to the lane page. All wording comes from laneLogic.js; this file only lays it out.
 * Esc is handled by the layer, so it works the same on the page.
 */
export default function LaneDrawer({ lane, live, now, sessions = { status: 'ok', sessions: [] }, onClose, onOpenPage }) {
  const closeRef = useRef(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const landing = expectedLanding(lane, now);
  const landed = lastLanded(lane, 3);
  const lost = timeLost(lane);
  const causes = Object.entries(lost.byCause).filter(([, m]) => m > 0);
  return (
    <div className="fixed inset-0 z-40" data-testid="lane-drawer-root">
      <div className="absolute inset-0 bg-black/40" data-testid="lane-drawer-scrim" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={`${lane.lane} lane`} data-testid="lane-drawer"
        className="absolute right-0 top-0 h-full w-[400px] max-w-full bg-card border-l border-border shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="m-0 text-[15px] font-semibold text-foreground">{lane.lane} lane</h2>
          <button ref={closeRef} type="button" aria-label="Close lane drawer" data-testid="lane-drawer-close" onClick={onClose}
            className="text-[14px] text-muted-foreground hover:text-foreground px-2 py-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">✕</button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto px-4">
          <Section id="now" title="NOW"><p className={P}>{nowLine(lane, live, now)}</p></Section>
          <Section id="next" title="NEXT">{nextLines(lane, live).map((t, i) => <p key={i} className={P}>{t}</p>)}</Section>
          <Section id="landing" title="EXPECTED LANDING">
            <p className={P}>{landing.text}</p>
            {landing.sub && <p className="m-0 text-[12px] text-muted-foreground">{landing.sub}</p>}
          </Section>
          <Section id="landed" title="LAST LANDED">
            {landed.length === 0 && <p className={P}>nothing landed in this window</p>}
            {landed.map((l) => (
              <p key={`${l.unit}${l.at}`} className={P} data-testid="drawer-landed-row">{l.title} <span className="text-muted-foreground text-[12px]">· {when(l.at, now)} · {l.live}</span></p>
            ))}
          </Section>
          <Section id="lost" title="TIME LOST">
            {causes.length === 0 && lost.notRecorded === 0 && <p className={P}>none in this window</p>}
            {causes.map(([c, m]) => <p key={c} className={P} data-testid="drawer-lost-row">waiting on {CAUSE_WORD[c] || c}: {minutesWord(m)}</p>)}
            {lost.notRecorded > 0 && <p className="m-0 text-[13px] text-muted-foreground" data-testid="drawer-lost-notrecorded">not recorded: {minutesWord(lost.notRecorded)}</p>}
          </Section>
          <Section id="who" title="WHO AND WHERE">
            <p className={P}>{lane.seat ? `seat ${lane.seat.replace(/^seat/i, '')}` : 'no seat recorded'}</p>
            {sessions.status === 'loading' && <p className="m-0 text-[12px] text-muted-foreground" data-testid="drawer-sessions-loading">reading…</p>}
            {sessions.status === 'unavailable' && <p className="m-0 text-[12px] text-muted-foreground" data-testid="drawer-sessions-unavailable">sessions unavailable: {sessions.reason}</p>}
            {sessions.status === 'ok' && sessions.sessions.length === 0 && <p className="m-0 text-[12px] text-muted-foreground">no session found for this lane</p>}
            {sessions.sessions.map((s) => <p key={s.name} className={P}>{s.name} <span className="text-muted-foreground text-[12px]">· {s.busy ? 'busy' : 'idle'}</span></p>)}
          </Section>
        </div>
        <footer className="px-4 py-3 border-t border-border">
          <button type="button" data-testid="lane-open-page" onClick={onOpenPage}
            className="text-[13px] text-foreground hover:underline focus-visible:underline outline-none">Open lane page ▸</button>
        </footer>
      </aside>
    </div>
  );
}
