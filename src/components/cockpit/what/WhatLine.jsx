/**
 * WhatLine.jsx — COMP-COCKPIT-WHAT-LINE-1: the first line of Home. One sentence answering "is anything running":
 * "<State>: <n> working · <n> waiting on review · <n> waiting on you · <n> landed since your last visit".
 *
 * The state word and counts come from whatRules.js (a rule table, no model call); hovering the state word shows the
 * table with the matching row marked. The optional `onCountOpen(kind)` (RIBBON-NOW-1, `working` | `waiting` | `landed`)
 * takes those three counts instead of navigating; waiting-on-you always opens the inbox. An unknown count is never 0 and never a bare
 * "?" (C6, COMP-DAYVIEW-DESIGN-FIX-1): it shows the last value this page read with its age, muted, or words saying why. The owner
 * count leads the line (C3): a filled chip in the one loud hue naming the first ask, or "Nothing needs you" at zero. While the fleet
 * or the unit index is still loading it draws a skeleton. Each count links to the place that lists those things.
 * COMP-COCKPIT-SOURCE-FAULTS-1 (WHAT-LINE M1): a source whose last refresh failed counts as unknown (its retained body
 * is not current), so its counts take the C6 words, and the shared SourceNote under the line names the source and why.
 * COMP-SOURCE-ENVELOPE-1: so does an index that answered but whose producer reported it incomplete (`partial`).
 */
import React from 'react';
import { useFleet } from '../../../lib/fleetPoller.js';
import { useUnitIndex } from '../../../lib/useUnitIndex.js';
import { useAgentState } from './useAgentState.js';
import { WHAT_RULES, LAST_VISIT_KEY, whatRule, whatCounts, readLastVisit } from './whatRules.js';
import { useNotifyState } from '../notify/useNotifyState.js';
import { ownerAsks, stripTag } from '../notify/notifyLogic.js';
import { smPanel, runningNow } from '../fleetLogic.js';
import SourceNote from '../SourceNote.jsx';
import { sourceNoteText } from '../../../lib/sourceState.js';

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** The older of the two source times, as "as of HH:MM"; null when neither source has a time. */
function freshness(fleetData, index) {
  const times = [Date.parse(fleetData?.generated ?? ''), Date.parse(index?.asOf ?? '')].filter(Number.isFinite);
  return times.length ? `as of ${hhmm(Math.min(...times))}` : null;
}

/** WHAT-LINE M3: one fleet list read and the other not: name the unreadable list, so the unknown total says why. */
function partialWhy(fleet) {
  const r = runningNow(fleet, null);
  if (r.fleetKnown || (r.busy === null && r.jobs === null)) return null;
  return r.busy === null ? 'the sessions list is unreadable' : 'the jobs list is unreadable';
}

/** Last known value of each count, kept for the page's life so Home and Day share it: `{id: {n, at}}`. */
const LAST_KNOWN = new Map();

/** "4 min", "2 h" for the last-known age. */
function ageWords(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/**
 * The words for one count. Known: "<n> <label>". Unknown (C6): the last value read with its age, "1 waiting on you, 4 min
 * ago", muted; with no earlier value, "<label>: <why>". `why` is the reason in words, never a bare "?".
 */
export function countWords({ n, label, why, last, now }) {
  if (n !== null && n !== undefined) return { text: `${n} ${label}`, known: true };
  if (last) return { text: `${last.n} ${label}, ${ageWords(now - last.at)} ago`, known: false, why };
  return { text: `${label}: ${why}`, known: false, why };
}

function Count({ id, n, label, why, onClick }) {
  if (n !== null && n !== undefined) LAST_KNOWN.set(id, { n, at: Date.now() });
  const w = countWords({ n, label, why, last: LAST_KNOWN.get(id), now: Date.now() });
  return (
    <button
      type="button"
      data-testid={`what-count-${id}`}
      data-known={w.known ? 'true' : 'false'}
      className={`tabular-nums whitespace-nowrap hover:underline focus-visible:underline outline-none${w.known ? '' : ' text-muted-foreground'}`}
      title={w.known ? w.text : `${w.text} (${why})`}
      aria-label={w.known ? w.text : `${w.text} (${why})`}
      onClick={onClick}
    >
      {w.text}
    </button>
  );
}

/**
 * C3: the owner count leads the line. Above zero, a filled chip in the one loud hue (`--needs-you`, the ribbon's owner
 * color) naming the first ask, which opens it; at zero, "Nothing needs you" in muted text; unknown, the C6 words.
 */
function NeedsYou({ n, rows, why, onClick }) {
  if (n === null || n === undefined) return <Count id="you" n={null} label="waiting on you" why={why} onClick={onClick} />;
  if (n === 0) {
    LAST_KNOWN.set('you', { n, at: Date.now() });
    return (
      <button type="button" data-testid="what-count-you" data-known="true" onClick={onClick}
        className="whitespace-nowrap text-muted-foreground outline-none hover:underline focus-visible:underline">Nothing needs you</button>
    );
  }
  LAST_KNOWN.set('you', { n, at: Date.now() });
  const first = rows?.[0] ? stripTag(rows[0].text) : '';
  const title = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return (
    <button
      type="button"
      data-testid="what-count-you"
      data-known="true"
      className="max-w-full truncate rounded-full bg-[hsl(var(--needs-you))] px-2.5 py-0.5 font-semibold text-background outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring"
      title={first ? `${n} needs you: ${first}` : `${n} needs you`}
      onClick={onClick}
    >
      {n} needs you{title ? `: ${title}` : ''}
    </button>
  );
}

export default function WhatLine({ onOpenFleet, onNavigate, onCountOpen }) {
  const fleetSrc = useFleet();
  const indexSrc = useUnitIndex();
  const { loading: fleetLoading } = fleetSrc;
  const { loading: indexLoading } = indexSrc;
  const fleet = fleetSrc.error ? null : fleetSrc.data;
  // COMP-SOURCE-ENVELOPE-1: an index the producer says is partial is not a count either ("0 waiting" would be a guess).
  const indexUnknown = Boolean(indexSrc.error || indexSrc.partial?.length);
  const index = indexUnknown ? null : indexSrc.data;
  const fleetWhy = fleetSrc.error ? sourceNoteText('fleet', fleetSrc, { short: true }) : null;
  const indexWhy = indexUnknown ? sourceNoteText('unit index', indexSrc, { short: true }) : null;
  const agent = useAgentState();
  const [lastVisitAt] = React.useState(() => readLastVisit());
  const { state: notifyState } = useNotifyState(); // NOTIFY-ACTIONS-1: the chip's state, so the owner counts agree

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
    () => ({ fleet, agent, index, now: Date.now(), lastVisitAt, notifyState }),
    [fleet, agent, index, lastVisitAt, notifyState],
  );
  const rule = React.useMemo(() => whatRule(raw), [raw]);
  const counts = React.useMemo(() => whatCounts(raw), [raw]);
  // The same rows `whatCounts` counts (ownerAsks over the fleet queue panel with the chip's notify state), for the chip's title.
  const ownerRows = React.useMemo(() => ownerAsks(smPanel(fleet, 'queue')?.value, notifyState, raw.now)?.rows ?? null, [fleet, notifyState, raw.now]);

  if (fleetLoading || indexLoading) {
    return <div data-testid="what-line-skeleton" aria-busy="true" className="h-5 w-2/3 max-w-xl rounded bg-muted animate-pulse" />;
  }

  const openInbox = () => {
    const ev = new CustomEvent('compose:open-inbox', { cancelable: true });
    if (window.dispatchEvent(ev)) onOpenFleet?.(); // nobody handled it yet (before NOTIFY-INBOX-1): the fleet pane lists owner questions
  };
  const asOf = freshness(fleet, index);

  return (
    <div data-testid="what-line" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <NeedsYou n={counts.waitingYou} rows={ownerRows} why={fleetWhy ?? 'owner queue not reachable, retrying'} onClick={openInbox} />
      <span className="group relative">
        <button
          type="button"
          data-testid="what-state"
          className="font-semibold cursor-help outline-none focus-visible:underline focus-visible:decoration-dotted underline-offset-4"
          aria-describedby="what-rules"
          title={rule.reason ? `Unknown because ${rule.reason}` : undefined}
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
      <Count id="working" n={counts.working} label="working" why={fleetWhy ?? partialWhy(fleet) ?? 'fleet not reachable, retrying'} onClick={() => (onCountOpen ? onCountOpen('working') : onOpenFleet?.())} />
      <span aria-hidden="true">·</span>
      <Count id="review" n={counts.waitingReview} label="waiting on review" why={indexWhy ?? 'unit index not loaded, retrying'} onClick={() => (onCountOpen ? onCountOpen('waiting') : onNavigate?.('process'))} />
      <span aria-hidden="true">·</span>
      <Count
        id="landed"
        n={counts.landedSinceVisit}
        label="landed since your last visit"
        why={indexWhy ?? (lastVisitAt === null && index?.units ? 'no earlier visit recorded' : 'unit index not loaded, retrying')}
        onClick={() => (onCountOpen ? onCountOpen('landed') : onNavigate?.('process'))}
      />
      {asOf && <span data-testid="what-asof" className="text-[11px] text-muted-foreground">{asOf}</span>}
      {(fleetSrc.error || indexUnknown) && (
        <span className="basis-full">
          <SourceNote source="Fleet" state={fleetSrc} />
          <SourceNote source="Unit index" state={indexSrc} />
        </span>
      )}
    </div>
  );
}
