/**
 * daySources.js — COMP-DAYVIEW-DESIGN-FIX-1 U3: the Day page's source state, computed ONCE from every feed it renders. Pure.
 *
 * Two rounds fixed "old data shown as current" one view at a time (U1: the desktop note; U2: the phone's missing-source
 * lines) and each left a branch out (review U2 F2: the phone and the Now feed behind a past window). So DayView computes this
 * object once and every branch (desktop ribbon, phone, Now drawer) renders the whole of it; no view takes its own subset.
 *
 * Inputs are the hook states: `feed` and `nowFeed` (`useRibbonFeed`: `{data, error, stale, fetchedAt, errorSince,
 * sourceGood, retrying}`), `live` (the ribbon's window holds now, so `nowFeed` is unused and `feed` stands in), and `index`
 * (`useUnitIndex`: the cockpit source shape plus `partial`).
 *
 * Returns `{failed, notes, missing}`:
 * - `failed`: `[{key, text, title}]` a feed with no body at all, in words that say whether it is read again (U2 F4).
 * - `notes`: `[{key, source, state}]` for `SourceNote`: a failed refresh over a kept body ("unreadable since HH:MM ...;
 *   showing the last good read from HH:MM"), or a unit index that failed or answered partial ("incomplete: <reasons>").
 * - `missing`: `sourceErrorLines` of each body read, deduped by key (the first feed's line wins).
 */
import { sourceErrorLines } from './ribbonLayout.js';

const feeds = (feed, nowFeed, live) => [
  { key: 'ribbon', source: 'The ribbon', state: feed },
  ...(live ? [] : [{ key: 'now', source: 'The Now list', state: nowFeed }]),
];

/** The no-body line: a live window is read again every 2 minutes; a past one is not, so say how to try again (U2 F4). */
export function failedText(source, retrying) {
  return retrying
    ? `${source} could not be read; retrying every 2 minutes.`
    : `${source} could not be read. A past window is not read again: change the window to try again.`;
}

export function daySources({ feed, nowFeed, live = true, index = null }) {
  const failed = [];
  const notes = [];
  const missing = [];
  const seen = new Set();
  for (const f of feeds(feed, nowFeed, live)) {
    const s = f.state;
    if (!s) continue;
    if (s.error && !s.data) failed.push({ key: f.key, text: failedText(f.source, s.retrying !== false), title: s.error });
    if (s.stale) notes.push({ key: f.key, source: f.source, state: s });
    const ref = typeof s.data?.now === 'string' ? s.data.now : null;
    for (const m of sourceErrorLines(s.data?.sourceErrors, s.sourceGood, ref, { retrying: s.retrying !== false })) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      missing.push(m);
    }
  }
  // SOURCE-ENVELOPE-1: an index that failed (kept or not) or said its body is partial; the Now lists count from it.
  if (index && (index.error || index.partial?.length)) notes.push({ key: 'index', source: 'The unit index', state: index });
  return { failed, notes, missing };
}

/** True when there is nothing to say (a branch can skip its wrapper). */
export const sourcesQuiet = (s) => !s || (!s.failed.length && !s.notes.length && !s.missing.length);
