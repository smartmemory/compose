/**
 * WhatLine.jsx — COMP-COCKPIT-WHAT-LINE-1: the first line of Home. One sentence answering "is anything running":
 * "<State>: <n> working · <n> waiting on review · <n> waiting on you · <n> landed since your last visit".
 *
 * The state word and counts come from whatRules.js (a rule table, no model call); hovering the state word shows the
 * table with the matching row marked. An unknown source reads "?" with "source unavailable", never 0. While the fleet
 * or the unit index is still loading it draws a skeleton. Each count links to the place that lists those things.
 */
import React from 'react';
import { useFleet } from '../../../lib/fleetPoller.js';
import { useUnitIndex } from '../../../lib/useUnitIndex.js';
import { useAgentState } from './useAgentState.js';
import { WHAT_RULES, LAST_VISIT_KEY, whatRule, whatCounts, readLastVisit } from './whatRules.js';

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** The older of the two source times, as "as of HH:MM"; null when neither source has a time. */
function freshness(fleetData, index) {
  const times = [Date.parse(fleetData?.generated ?? ''), Date.parse(index?.asOf ?? '')].filter(Number.isFinite);
  return times.length ? `as of ${hhmm(Math.min(...times))}` : null;
}

function Count({ id, n, label, why, onClick }) {
  const shown = n === null ? '?' : n;
  const text = `${shown} ${label}`;
  return (
    <button
      type="button"
      data-testid={`what-count-${id}`}
      className="tabular-nums whitespace-nowrap hover:underline focus-visible:underline outline-none"
      title={n === null ? why : text}
      aria-label={n === null ? `${text} (${why})` : text}
      onClick={onClick}
    >
      {shown} {label}
    </button>
  );
}

export default function WhatLine({ onOpenFleet, onNavigate }) {
  const { data: fleet, loading: fleetLoading } = useFleet();
  const { data: index, loading: indexLoading } = useUnitIndex();
  const agent = useAgentState();
  const [lastVisitAt] = React.useState(() => readLastVisit());

  // Written when the page is hidden or unloaded, never on load: "since your last visit" must not move while you look.
  React.useEffect(() => {
    const stamp = () => { try { localStorage.setItem(LAST_VISIT_KEY, String(Date.now())); } catch { /* storage denied */ } };
    const onVis = () => { if (document.visibilityState === 'hidden') stamp(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', stamp);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', stamp);
    };
  }, []);

  const raw = React.useMemo(
    () => ({ fleet, agent, index, now: Date.now(), lastVisitAt }),
    [fleet, agent, index, lastVisitAt],
  );
  const rule = React.useMemo(() => whatRule(raw), [raw]);
  const counts = React.useMemo(() => whatCounts(raw), [raw]);

  if (fleetLoading || indexLoading) {
    return <div data-testid="what-line-skeleton" aria-busy="true" className="h-5 w-2/3 max-w-xl rounded bg-muted animate-pulse" />;
  }

  const openInbox = () => {
    const ev = new CustomEvent('compose:open-inbox', { cancelable: true });
    if (window.dispatchEvent(ev)) onOpenFleet?.(); // nobody handled it yet (before NOTIFY-INBOX-1): the fleet pane lists owner questions
  };
  const unknown = 'source unavailable';
  const asOf = freshness(fleet, index);

  return (
    <div data-testid="what-line" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="group relative">
        <button
          type="button"
          data-testid="what-state"
          className="font-semibold underline decoration-dotted underline-offset-4 outline-none"
          aria-describedby="what-rules"
        >
          {rule.state}
        </button>
        <span
          id="what-rules"
          role="tooltip"
          data-testid="what-rules"
          className="hidden group-hover:block group-focus-within:block absolute left-0 top-full z-50 mt-1 w-96 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
        >
          <span className="block mb-1 font-semibold">How this word is chosen (first match wins)</span>
          <ol className="list-decimal pl-4 space-y-1">
            {WHAT_RULES.map((r) => (
              <li key={r.state} data-testid="what-rule" data-current={r.state === rule.state ? 'true' : 'false'} className={r.state === rule.state ? 'font-semibold' : 'text-muted-foreground'}>
                {r.state === rule.state ? '▶ ' : ''}<b>{r.state}</b>: {r.when}
              </li>
            ))}
          </ol>
        </span>
        <span>:</span>
      </span>
      <Count id="working" n={counts.working} label="working" why={unknown} onClick={() => onOpenFleet?.()} />
      <span aria-hidden="true">·</span>
      <Count id="review" n={counts.waitingReview} label="waiting on review" why={unknown} onClick={() => onNavigate?.('process')} />
      <span aria-hidden="true">·</span>
      <Count id="you" n={counts.waitingYou} label="waiting on you" why={unknown} onClick={openInbox} />
      <span aria-hidden="true">·</span>
      <Count
        id="landed"
        n={counts.landedSinceVisit}
        label="landed since your last visit"
        why={lastVisitAt === null && index?.units ? 'no earlier visit recorded' : unknown}
        onClick={() => onNavigate?.('process')}
      />
      {asOf && <span data-testid="what-asof" className="text-[11px] text-muted-foreground">{asOf}</span>}
    </div>
  );
}
