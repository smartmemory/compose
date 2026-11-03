/**
 * owner-spans.js — one owner wait per ask on the Day ribbon (COMP-DAYVIEW-DESIGN-FIX-1 U2 F2, replaced in U3-DATA). Pure.
 *
 * A lane's owner waits come from two producers: a unit's `owner_waits` stamps (`lib/ribbon-feed.js`, no `queueId`) and the
 * owner queue (`ownerWaits` in `server/ribbon-routes.js`, with `queueId`). They can describe the same ask, and a stamp is
 * often never closed, so its span runs to now. One rule, no patches on top:
 * - a stamp matches a queue ask by IDENTITY: the same unit, and a true start (`since`, else `start`) within
 *   `OWNER_MATCH_TOLERANCE_MS`. Time overlap alone never matches (a different ask on the lane is not this stamp's ask);
 * - for a matched pair the queue is the source for the time it covers: the stamp keeps only its time outside the queue's
 *   coverage, as its own span(s) (interval subtraction), never dropped whole;
 * - an unmatched stamp is drawn as it is, except an OPEN one: its end is "now" only because a stamp has no end, so it is
 *   clipped at `asOf`, the owner-queue read, and is `open: false` after the clip;
 * - `asOf` not finite means the queue was not readable: every stamp span stays as it is (open stays open), and the reason
 *   is in `sourceErrors.ownerQueue` (unknown, not empty).
 */
const isOwner = (s) => s?.kind === 'wait' && s.cause === 'owner';
const t = (v) => Date.parse(v);

/** A stamp and a queue ask are the same ask when the unit is the same and they started this close together. */
export const OWNER_MATCH_TOLERANCE_MS = 10 * 60_000;

const trueStart = (s) => t(s.since ?? s.start);

/** `[a, b]` minus the union of `cuts`, as `[start, end]` ms pairs (non-empty pieces only). */
function subtractAll(a, b, cuts) {
  let pieces = [[a, b]];
  for (const [c0, c1] of cuts) {
    pieces = pieces.flatMap(([p0, p1]) => (c1 <= p0 || c0 >= p1 ? [[p0, p1]] : [[p0, Math.min(p1, c0)], [Math.max(p0, c1), p1]]))
      .filter(([p0, p1]) => p1 > p0);
  }
  return pieces;
}

/**
 * `spans`: one lane's spans, the queue's owner spans already merged in. `asOf`: the owner-queue read, ms (not finite =
 * unreadable). Returns the spans to draw, in the order given (a stamp's pieces take its place).
 */
export function reconcileOwnerSpans(spans, { asOf } = {}) {
  const list = Array.isArray(spans) ? spans : [];
  if (!Number.isFinite(asOf)) return list;
  const queue = list.filter((s) => isOwner(s) && s.queueId);
  return list.flatMap((s) => {
    if (!isOwner(s) || s.queueId) return [s];
    const matched = queue.filter((q) => q.unit && q.unit === s.unit && Math.abs(trueStart(q) - trueStart(s)) <= OWNER_MATCH_TOLERANCE_MS);
    const a = t(s.start);
    const b = s.open && matched.length === 0 ? Math.min(t(s.end), asOf) : t(s.end);
    if (matched.length === 0) return s.open ? (b > a ? [{ ...s, end: new Date(b).toISOString(), open: false }] : []) : [s];
    return subtractAll(a, b, matched.map((q) => [t(q.start), t(q.end)]))
      .map(([p0, p1]) => ({ ...s, start: new Date(p0).toISOString(), end: new Date(p1).toISOString(), open: false }));
  });
}
