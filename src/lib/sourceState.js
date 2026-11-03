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
 * - `partial` (COMP-SOURCE-ENVELOPE-1): the producer's own reasons the body is incomplete (it answered 200 but says it
 *   could not read everything), or null/absent (read it as `partial?.length`). `data` is still the body, so a lookup that finds its row may use it, but a
 *   consumer that counts or says "none" must treat the population as unknown while `partial` is set.
 * A consumer that draws `data` while `stale` is true must say so (`SourceNote.jsx`), never show it as current.
 */

export const INITIAL_SOURCE = Object.freeze({ data: null, error: null, stale: false, fetchedAt: null, errorSince: null, loading: true, partial: null });

/** A successful read of a body with no producer envelope. */
export function sourceOk(data, at = Date.now()) {
  return { data, error: null, stale: false, fetchedAt: at, errorSince: null, loading: false, partial: null };
}

const text = (v) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The producer envelope's faults, in its own words, or null when the body says it is whole: top-level `error`, top-level
 * `warnings` and `coverage[part].error` (the GET /api/units/index shape, `lib/unit-index.js` buildUnitIndex). Per-source
 * `sources[name].error` (/api/fleet, /api/process) is not read here: those consumers read it per panel (`fleetLogic.js`).
 */
export function envelopeFaults(body) {
  if (!body || typeof body !== 'object') return null;
  const out = [
    text(body.error),
    ...(Array.isArray(body.warnings) ? body.warnings.map(text) : []),
    ...(body.coverage && typeof body.coverage === 'object' ? Object.values(body.coverage).map((c) => text(c?.error)) : []),
  ].filter(Boolean);
  return out.length ? out : null;
}

/** A successful read of a JSON body: every poller wraps its body through this, so a producer-reported fault is `partial`. */
export function sourceFromBody(body, at = Date.now()) {
  return { ...sourceOk(body, at), partial: envelopeFaults(body) };
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
    // The retained body is still the incomplete one; the key is only added then, so a whole source's failure shape is unchanged.
    ...(data !== null && data !== undefined && prev?.partial?.length ? { partial: prev.partial } : {}),
  };
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * The note's words, or null when the source is healthy. "<source> unreadable since HH:MM: <reason>", plus
 * "; showing the last good read from HH:MM" when retained data is on screen; "<source> incomplete: <reasons>" when the
 * producer said its body is partial; "<source> stale" for stale with no error. The first that applies wins.
 * `short` drops the reason and the retained-read clause (for a header chip; the full text goes in its title).
 */
export function sourceNoteText(source, state, { short = false } = {}) {
  if (!state) return null;
  const { error, stale, errorSince, fetchedAt, partial } = state;
  if (error) {
    const since = Number.isFinite(errorSince) ? ` since ${hhmm(errorSince)}` : '';
    if (short) return `${source} unreadable${since}`;
    const kept = stale && Number.isFinite(fetchedAt) ? `; showing the last good read from ${hhmm(fetchedAt)}` : '';
    return `${source} unreadable${since}: ${error}${kept}`;
  }
  if (partial?.length) return short ? `${source} incomplete` : `${source} incomplete: ${partial.join('; ')}`;
  if (stale) return `${source} stale`;
  return null;
}
