/**
 * lib/colleague/writeback.js — COMP-FOH FOH-6 S4: Maya joins the discussion
 * trail, idempotently.
 *
 * When a colleague turn was about a record in focus, her reply is appended to
 * that idea's discussion as `author: 'maya'` through the same
 * `addDiscussion` op every other surface uses (migration gate + durable
 * record + projection render, in that order).
 *
 * THE CONTRACT (design §5):
 *   - The chat result is authoritative; a write-back failure must never
 *     surface as a failed turn. Callers get an OUTCOME, never a throw:
 *       'ok'                — appended (or already present: see idempotency)
 *       'landed-unrendered' — the durable record mutation succeeded but the
 *                             projection render failed; the ideabox file is
 *                             stale until repaired (`compose ideabox render` /
 *                             POST /api/ideabox/render)
 *       'failed'            — no append landed (as far as we can tell)
 *   - Idempotent, keyed on Maya's `message_id`. A 'failed' outcome does not
 *     prove the append didn't land (the durable write can succeed and the
 *     call still fail afterward), and the trail is append-only — a blind
 *     retry would duplicate her reply. Every entry embeds a marker comment,
 *     and every attempt is RECONCILE-THEN-APPEND: scan the record's
 *     discussion for the marker first, append only if absent.
 *
 * Marker encoding: a trailing HTML comment — invisible in rendered markdown,
 * greppable, zero schema change.
 */

import { findIdea, addDiscussion, IdeaboxRenderFailed } from '../fluid/ideabox-ops.js';

/** The idempotency marker embedded in every write-back entry. */
export function markerFor(messageId) {
  return `<!-- maya:msg_${messageId} -->`;
}

/**
 * One reconcile-then-append attempt. Never throws — the outcome IS the API.
 *
 * @param {object} ctx an ideabox ops context
 * @param {{focusId: string, messageId: string, text: string}} args
 * @returns {Promise<{outcome: 'ok'|'landed-unrendered'|'failed', focusId: string,
 *                    deduped?: boolean, reason?: string}>}
 */
export async function writebackReply(ctx, { focusId, messageId, text }) {
  try {
    const idea = await findIdea(ctx.provider, focusId);
    if (!idea) return { outcome: 'failed', focusId, reason: `idea not found: ${focusId}` };

    const marker = markerFor(messageId);
    const already = (idea.discussion ?? []).some(
      (d) => typeof d?.text === 'string' && d.text.includes(marker),
    );
    // Reconcile: the entry already landed (a prior attempt whose response was
    // lost, or a retry racing a success). Appending again would duplicate her
    // reply in an append-only trail.
    if (already) return { outcome: 'ok', focusId, deduped: true };

    await addDiscussion(ctx, idea.handle, { author: 'maya', text: `${text}\n\n${marker}` });
    return { outcome: 'ok', focusId };
  } catch (err) {
    if (err instanceof IdeaboxRenderFailed) {
      // The record IS durable — only the generated file is stale. Telling the
      // caller 'failed' here would invite a retry that dedups into a no-op
      // while the projection stays silently stale; the distinct outcome is
      // what makes the repair affordance render.
      return { outcome: 'landed-unrendered', focusId };
    }
    return { outcome: 'failed', focusId, reason: err?.message?.slice(0, 300) ?? 'unknown error' };
  }
}
