/** Plain-object adapters over the selected Stratum installation's shipped catalog.
 * Key enumeration is import-safe; the first value access loads the catalog once.
 * Budget is addressable, not part of the auto-escalation ladder.
 */
import { getModelCatalog, MODEL_TIER_KEYS } from '../lib/model-catalog.js';

function tierMap(loadCatalog, provider, thinking = false) {
  const map = {};
  for (const key of MODEL_TIER_KEYS) Object.defineProperty(map, key, {
    enumerable: true, configurable: true,
    get() {
      const tier = loadCatalog().catalog.tiers[provider][key];
      const value = tier === 'unavailable' ? null : thinking
        ? { mode: tier.mode === 'unavailable' ? null : tier.mode,
          effort: tier.effort === 'unavailable' ? null : tier.effort }
        : tier.model;
      // Materialize a normal value property once; thinking entries retain identity.
      Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
  });
  return map;
}

/** Independent catalog clients can exercise the same adapters in tests. */
export function createModelTierMaps(loadCatalog = getModelCatalog) {
  return {
    MODEL_TIERS: tierMap(loadCatalog, 'claude'),
    CODEX_MODEL_TIERS: tierMap(loadCatalog, 'codex'),
    DEVIN_MODEL_TIERS: tierMap(loadCatalog, 'devin'),
    TIER_THINKING: tierMap(loadCatalog, 'claude', true),
    CODEX_TIER_THINKING: tierMap(loadCatalog, 'codex', true),
    DEVIN_TIER_THINKING: tierMap(loadCatalog, 'devin', true),
  };
}

export const { MODEL_TIERS, CODEX_MODEL_TIERS, DEVIN_MODEL_TIERS,
  TIER_THINKING, CODEX_TIER_THINKING, DEVIN_TIER_THINKING } = createModelTierMaps();

/**
 * Resolve a tier name to a concrete model ID.
 *
 * @param {string|null|undefined} tier
 * @returns {string|null}  Model ID, or null if tier is unknown, unavailable for the provider, or not provided.
 */
export function resolveTierModel(tier, provider = 'claude') {
  if (!tier) return null;
  const models = provider === 'codex' ? CODEX_MODEL_TIERS : provider === 'claude' ? MODEL_TIERS : provider === 'devin' ? DEVIN_MODEL_TIERS : {};
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
  const thinking = provider === 'codex' ? CODEX_TIER_THINKING : provider === 'claude' ? TIER_THINKING : provider === 'devin' ? DEVIN_TIER_THINKING : {};
  return thinking[tier] ?? null;
}
