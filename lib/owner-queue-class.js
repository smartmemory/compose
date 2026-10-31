/**
 * owner-queue-class.js — the ONE owner-queue classifier, shared by the cockpit UI (`notifyLogic.js` re-exports it) and the
 * server's answer route (`server/fleet-routes.js` POST /api/fleet/owner-answer). It lives in `lib/` because the published
 * package ships `server/**` and `lib/**` but not `src/**` (COMP-COCKPIT-NOTIFY-ACTIONS-1 moved it here from
 * `src/components/cockpit/notify/notifyLogic.js`, verbatim). Pure, no imports.
 */

/** Leading owner-queue tag -> display class. A display convention, not typing (phase 2 reads the envelope). */
export const TAGS = {
  SECURITY: 'security',
  CREDENTIAL: 'security',
  QUESTION: 'ask',
  APPLIED: 'decided',
  FYI: 'fyi',
  UPDATED: 'fyi',
};

/** The leading word when it is an exact TAGS word followed by `:`, `,`, whitespace or the end (a `-` never matches: unit ids; the live queue has "SECURITY, credential ..."). */
export function tagWord(text) {
  const m = /^\s*([A-Za-z]+)(?=[:,\s]|$)/.exec(String(text ?? ''));
  return m && Object.hasOwn(TAGS, m[1]) ? m[1] : null;
}

/** `security | ask | decided | fyi | untyped`. */
export function tagOf(text) {
  const w = tagWord(text);
  return w ? TAGS[w] : 'untyped';
}

/** The text without its leading tag and colon ("SECURITY: leaked key" -> "leaked key"). */
export function stripTag(text) {
  const w = tagWord(text);
  if (!w) return String(text ?? '').trim();
  return String(text).replace(/^\s*[A-Za-z]+\s*[:,]?\s*/, '').trim() || String(text).trim();
}

/**
 * The ONE classifier: owner-queue text -> `security | asks | decided | fyi`. The chip counts `security` and `asks`; the
 * inbox drawer (inboxLogic.js `groupInbox`) groups by it; the answer route accepts `asks` (and `security` to resolve).
 * An untyped row is an ask so nothing is missed. Phase 2 replaces the tag parse here with the envelope's `type/kind`:
 * this is the only place to touch.
 */
export function groupOf(text) {
  const tag = tagOf(text);
  if (tag === 'security') return 'security';
  if (tag === 'decided') return 'decided';
  if (tag === 'fyi') return 'fyi';
  return 'asks';
}
