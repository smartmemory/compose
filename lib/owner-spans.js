/**
 * owner-spans.js — one owner wait per ask on the Day ribbon (COMP-DAYVIEW-DESIGN-FIX-1 U2, F2 of the U1 post-land review). Pure.
 *
 * A lane's owner waits come from two producers: a unit's `owner_waits` stamps (`lib/ribbon-feed.js`, no `queueId`) and the
 * owner queue (`ownerWaits` in `server/ribbon-routes.js`, with `queueId`). They can describe the same ask (NOTIFY-NTFY-1's
 * stamp starts at its queue ask's `ts`), and stamps are never closed in practice (4 of 4 open on 2026-11-03), so a stamp
 * span runs to now long after the ask was answered. The queue is the one "at now" owner source:
 * - a stamp owner span still open (`open: true`, extended to now because the stamp has no end) is dropped: the queue
 *   draws the ask while it is open, and draws nothing once it is answered or closed;
 * - a closed stamp owner span that overlaps a queue owner span on the same lane is dropped (the same ask, drawn once);
 * - a closed stamp owner span with no queue span over it is history and stays.
 * Call this only when the queue was read; an unreadable queue leaves every stamp span as it is (unknown, not empty).
 */

const isOwner = (s) => s?.kind === 'wait' && s.cause === 'owner';
const t = (v) => Date.parse(v);
const overlaps = (a, b) => t(a.start) < t(b.end) && t(b.start) < t(a.end);

/** `spans`: one lane's spans, the queue's owner spans already merged in. Returns the spans to draw (same order). */
export function reconcileOwnerSpans(spans) {
  const list = Array.isArray(spans) ? spans : [];
  const queue = list.filter((s) => isOwner(s) && s.queueId);
  return list.filter((s) => {
    if (!isOwner(s) || s.queueId) return true;
    if (s.open) return false;
    return !queue.some((q) => overlaps(q, s));
  });
}
