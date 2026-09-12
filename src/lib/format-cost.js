/**
 * format-cost.js — the ONE way a dollar amount is rendered (COMP-COST-OWNER S2).
 *
 * There were four of these, and they disagreed about the case that matters most:
 *
 *   MessageCard.jsx      null -> ''        <0.001 -> '<$0.001'
 *   PastBuildsView.jsx   <=0  -> null      (renders nothing)
 *   opsStripLogic.js     <=0  -> ''
 *   ContextStepDetail.jsx <=0 -> '$0.00'   <- states a measured zero
 *
 * None could say "unknown", because by the time a cost reached them it had already
 * been coerced to 0 twice (the stream writer and the cockpit bridge). So a call
 * whose cost nobody could state rendered as `$0.00` on one surface and `<$0.001` on
 * another — both affirmative claims of near-zero spend for a call that may have cost
 * dollars.
 *
 * The distinction this function exists to preserve:
 *
 *   null / undefined / NaN  ->  we do not know        (never a number)
 *   0                       ->  it genuinely cost nothing
 *
 * Precision and the unknown marker stay per-surface, because an ops strip and a
 * per-step table legitimately want different ones. The SEMANTICS do not.
 */

/** What every surface shows when the cost is unknown, unless it asks for another. */
export const UNKNOWN_COST = '—';

/**
 * @param {number|null|undefined} usd
 * @param {{ digits?: number, unknown?: string|null }} [options]
 *   `digits`  fixed decimal places; omit for the adaptive default.
 *   `unknown` what to render when the amount is not known (default `'—'`). Pass `''`
 *             or `null` on surfaces that hide the element entirely.
 * @returns {string|null}
 */
export function formatCost(usd, { digits, unknown = UNKNOWN_COST } = {}) {
  // A negative cost is not a cheaper call, it is a broken record. Say unknown rather
  // than rendering it, and never let it subtract from a displayed total.
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return unknown;
  if (digits != null) return `$${usd.toFixed(digits)}`;
  if (usd === 0) return '$0.00';
  // Not rounded away: '$0.000' would read as free, which is the bug one layer up.
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}
