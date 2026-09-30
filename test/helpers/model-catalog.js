/** Test expectations read the same engine-selected catalog as production. */
import { getModelCatalog } from '../../lib/model-catalog.js';
export const { catalog, catalogDigest, path: catalogPath } = getModelCatalog();
export const tier = (provider, key) => catalog.tiers[provider][key];
export function thinking(provider, key) {
  const value = tier(provider, key);
  return value === 'unavailable' ? null : {
    mode: value.mode === 'unavailable' ? null : value.mode,
    effort: value.effort === 'unavailable' ? null : value.effort,
  };
}
export const claudeDefault = catalog.claude.default.model;
export const codexDefault = catalog.codex.default.model;
// Unknown identities exercise receipt parsing/pricing, without tying tests to releases.
export const unpricedCodex = `${codexDefault}-unpriced-fixture`;
