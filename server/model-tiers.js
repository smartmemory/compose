/**
 * model-tiers.js — Model tier routing for STRAT-TIER.
 *
 * Maps symbolic tier names to provider-specific model IDs.
 * Tiers let pipeline specs declare intent (critical / standard / fast / coordinator)
 * without hard-coding model strings — the map here is the single source of truth,
 * including the agent-string tier allow-list. Coordinator lets one preset role
 * explicitly name Fable while critical stays Opus 5; other presets do not move
 * silently to Fable.
 */

/** @type {Record<string, string>} */
export const MODEL_TIERS = {
  critical: 'claude-opus-5',
  standard: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5-20251001',
  coordinator: 'claude-fable-5-1',
};

export const CODEX_MODEL_TIERS = {
  critical: 'gpt-6-astra',
  standard: 'gpt-5.6-terra',
  fast: 'gpt-5.3-codex-spark',
  coordinator: null,
};

// C12: codex efforts follow the routing convention — `low` is for trivial
// mechanical work only, and the fast tier is a model choice, not a
// reasoning-quality choice. Fast runs the cheap model at routine effort.
const CODEX_TIER_THINKING = {
  critical: { mode: null, effort: 'high' },
  standard: { mode: null, effort: 'high' },
  fast: { mode: null, effort: 'medium' },
  coordinator: null,
};

/**
 * Default thinking config per tier.
 * - Opus 5 / Sonnet 5 support adaptive thinking and the effort parameter.
 * - Fable 5.1 thinking is always on; adaptive thinking uses effort to control depth.
 * - Haiku 4.5 doesn't accept the effort parameter (400 error), so fast tier stays off.
 *
 * @type {Record<string, { mode: 'adaptive'|'off', effort: 'low'|'medium'|'high'|'xhigh'|'max'|null }>}
 */
export const TIER_THINKING = {
  critical: { mode: 'adaptive', effort: 'xhigh' },
  standard: { mode: 'adaptive', effort: 'high' },
  fast:     { mode: 'off',      effort: null   },
  coordinator: { mode: 'adaptive', effort: 'high' },
};

/**
 * Resolve a tier name to a concrete model ID.
 *
 * @param {string|null|undefined} tier
 * @returns {string|null}  Model ID, or null if tier is unknown, unavailable for the provider, or not provided.
 */
export function resolveTierModel(tier, provider = 'claude') {
  if (!tier) return null;
  const models = provider === 'codex' ? CODEX_MODEL_TIERS : provider === 'claude' ? MODEL_TIERS : {};
  return models[tier] ?? null;
}

/**
 * Resolve a tier name to its default thinking config.
 *
 * @param {string|null|undefined} tier
 * @returns {{ mode: string, effort: string|null }|null}
 */
export function resolveTierThinking(tier, provider = 'claude') {
  if (!tier) return null;
  const thinking = provider === 'codex' ? CODEX_TIER_THINKING : provider === 'claude' ? TIER_THINKING : {};
  return thinking[tier] ?? null;
}
