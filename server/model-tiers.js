/**
 * model-tiers.js — Model tier routing for STRAT-TIER.
 *
 * Maps symbolic tier names to concrete Anthropic model IDs.
 * Tiers let pipeline specs declare intent (critical / standard / fast)
 * without hard-coding model strings — the map here is the single source of truth.
 */

/** @type {Record<string, string>} */
export const MODEL_TIERS = {
  critical: 'claude-opus-4-7',
  standard: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
};

/**
 * Default thinking config per tier.
 * - Opus 4.7 / Sonnet 4.6 support adaptive thinking and the effort parameter.
 * - Haiku 4.5 doesn't accept the effort parameter (400 error), so fast tier stays off.
 *
 * @type {Record<string, { mode: 'adaptive'|'off', effort: 'low'|'medium'|'high'|'xhigh'|'max'|null }>}
 */
export const TIER_THINKING = {
  critical: { mode: 'adaptive', effort: 'xhigh' },
  standard: { mode: 'adaptive', effort: 'high' },
  fast:     { mode: 'off',      effort: null   },
};

/**
 * Resolve a tier name to a concrete model ID.
 *
 * @param {string|null|undefined} tier
 * @returns {string|null}  Model ID, or null if tier is unknown / not provided.
 */
export function resolveTierModel(tier) {
  if (!tier) return null;
  return MODEL_TIERS[tier] ?? null;
}

/**
 * Resolve a tier name to its default thinking config.
 *
 * @param {string|null|undefined} tier
 * @returns {{ mode: string, effort: string|null }|null}
 */
export function resolveTierThinking(tier) {
  if (!tier) return null;
  return TIER_THINKING[tier] ?? null;
}
