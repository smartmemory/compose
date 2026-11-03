/**
 * sourceState.js — the ONE shape every cockpit poller and hook returns (COMP-COCKPIT-SOURCE-FAULTS-1). Pure.
 *
 * `{data, error, stale, fetchedAt, errorSince, loading}`:
 * - `data`: the last good body, kept across a failed refresh so a screen can still show it, marked.
 * - `error`: the last refresh's failure in words, or null once a read succeeds again.
 * - `stale`: true when `error` is set AND `data` is that retained last good copy (so it is old, not current).
 * - `fetchedAt`: epoch ms of the read that produced `data` (null before the first good read).
 * - `errorSince`: epoch ms of the first failure in the current run of failures (the "unreadable since HH:MM").
 * - `loading`: true until the first response or failure.
 * A consumer that draws `data` while `stale` is true must say so (`SourceNote.jsx`), never show it as current.
 */

export const INITIAL_SOURCE = Object.freeze({ data: null, error: null, stale: false, fetchedAt: null, errorSince: null, loading: true });

/** A successful read. */
export function sourceOk(data, at = Date.now()) {
  return { data, error: null, stale: false, fetchedAt: at, errorSince: null, loading: false };
}

/** A failed read on top of `prev`: the last good data is kept and marked stale. */
export function sourceFail(prev, error, at = Date.now()) {
  const data = prev?.data ?? null;
  return {
    data,
    error: String(error?.message ?? error),
    stale: data !== null && data !== undefined,
    fetchedAt: prev?.fetchedAt ?? null,
    errorSince: prev?.error && Number.isFinite(prev?.errorSince) ? prev.errorSince : at,
    loading: false,
  };
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * The note's words, or null when the source is healthy. "<source> unreadable since HH:MM: <reason>", plus
 * "; showing the last good read from HH:MM" when retained data is on screen; "<source> stale" for stale with no error.
 * `short` drops the reason and the retained-read clause (for a header chip; the full text goes in its title).
 */
export function sourceNoteText(source, state, { short = false } = {}) {
  if (!state) return null;
  const { error, stale, errorSince, fetchedAt } = state;
  if (error) {
    const since = Number.isFinite(errorSince) ? ` since ${hhmm(errorSince)}` : '';
    if (short) return `${source} unreadable${since}`;
    const kept = stale && Number.isFinite(fetchedAt) ? `; showing the last good read from ${hhmm(fetchedAt)}` : '';
    return `${source} unreadable${since}: ${error}${kept}`;
  }
  if (stale) return `${source} stale`;
  return null;
}
