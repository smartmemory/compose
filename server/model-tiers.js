/**
 * model-tiers.js — Model tier routing for STRAT-TIER.
 *
 * Maps symbolic tier names to provider-specific model IDs.
 * Tiers let pipeline specs declare intent (critical / standard / fast / budget / coordinator)
 * without hard-coding model strings — the map here is the single source of truth,
 * including the agent-string tier allow-list. Coordinator lets one preset role
 * explicitly name Fable while critical stays Opus 5; other presets do not move
 * silently to Fable.
 *
 * Tier names describe INTENT, never a model. `budget` is the Codex-only mirror of
 * `coordinator`: it appears in BOTH maps so the shared vocabulary admits the name
 * (agent-string.js derives KNOWN_TIERS from MODEL_TIERS), and is null on the Claude side
 * because no Claude model sits at that price point — so `claude::budget` fails with the
 * standard "not available for provider" message rather than "unknown tier".
 *
 * SCOPE (COMP-MODEL-ROUTE, 2026-09-12): budget is ADDRESSABLE, not LADDERED. It is
 * deliberately absent from the cost ladder in lib/routing-ledger.js (`['fast','standard',
 * 'critical']`) and the item-tier list in lib/pipeline-profiles.js, so it is nameable in a
 * profile sidecar but is not an auto-escalation candidate and does not enter floor
 * computation. Ladder membership is an S2/S3 decision, entangled with open question Q3.
 */

/**
 * Null = the tier name is known but this provider has no model at it.
 * @type {Record<string, string|null>}
 */
export const MODEL_TIERS = {
  critical: 'claude-opus-5',
  standard: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5-20251001',
  // Codex-only tier: no Claude model is priced near gpt-5.6-luna (0.2/1.2).
  budget: null,
  coordinator: 'claude-fable-5-1',
};

export const CODEX_MODEL_TIERS = {
  critical: 'gpt-6-astra',
  standard: 'gpt-5.6-terra',
  fast: 'gpt-5.3-codex-spark',
  // ~10x cheaper than terra on both axes. Distinct from `fast`: spark draws a SEPARATE
  // upstream quota (effectively free capacity), so fast stays spark and budget is the
  // cheapest tier that bills against the main pool.
  budget: 'gpt-5.6-luna',
  coordinator: null,
};

// C12: codex efforts follow the routing convention — `low` is for trivial
// mechanical work only, and the fast tier is a model choice, not a
// reasoning-quality choice. Fast runs the cheap model at routine effort.
const CODEX_TIER_THINKING = {
  critical: { mode: null, effort: 'high' },
  standard: { mode: null, effort: 'high' },
  fast: { mode: null, effort: 'medium' },
  // Same convention as fast: the tier picks a cheap MODEL, it does not floor reasoning.
  budget: { mode: null, effort: 'medium' },
  coordinator: null,
};

/**
 * Default thinking config per tier.
 * - Opus 5 / Sonnet 5 support adaptive thinking and the effort parameter.
 * - Fable 5.1 thinking is always on; adaptive thinking uses effort to control depth.
 * - Haiku 4.5 doesn't accept the effort parameter (400 error), so fast tier stays off.
 *
 * @type {Record<string, { mode: 'adaptive'|'off', effort: 'low'|'medium'|'high'|'xhigh'|'max'|null }|null>}
 */
export const TIER_THINKING = {
  critical: { mode: 'adaptive', effort: 'xhigh' },
  standard: { mode: 'adaptive', effort: 'high' },
  fast:     { mode: 'off',      effort: null   },
  budget:   null,
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
