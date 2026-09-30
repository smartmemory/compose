/** Test-only projection. Tiers with identical observed values collapse to the first
 * matching tier when no tier label is present; wrong values survive and still fail oracles.
 */
import { catalog } from './model-catalog.js';
import { profilesDigest, resolveConsumerProfile } from '../../lib/pipeline-profiles.js';

const sdkThinking = (provider, entry) => provider !== 'claude' ? null
  : { type: entry.mode === 'adaptive' ? 'adaptive' : 'disabled' };
const effort = entry => entry.effort === 'unavailable' ? null : entry.effort;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function symbolicModelProjection(value, inherited = {}) {
  if (Array.isArray(value)) return value.map(v => symbolicModelProjection(v, inherited));
  if (!value || typeof value !== 'object') return value;
  const provider = value.provider ?? inherited.provider;
  let key = value.tier ?? value.profile?.split(':')[2] ?? inherited.tier;
  const model = value.modelID ?? value.model;
  const symbolic = typeof model === 'string' && /^<(claude|codex|devin):([a-z]+)>$/.exec(model);
  if (symbolic) key = symbolic[2];
  if (!key && provider && model) {
    key = Object.keys(catalog.tiers[provider] ?? {}).find(k => {
      const entry = catalog.tiers[provider][k];
      return entry !== 'unavailable' && entry.model === model
        && (!Object.hasOwn(value, 'effort') || value.effort === effort(entry))
        && (!Object.hasOwn(value, 'thinking') || equal(value.thinking, sdkThinking(provider, entry)));
    });
  }
  const entry = catalog.tiers[provider]?.[key];
  const token = `<${provider}:${key}>`;
  const result = {};
  for (const [field, child] of Object.entries(value)) {
    if (entry && entry !== 'unavailable' && (
      ['modelID', 'model'].includes(field) && child === entry.model
      || ['effort', 'effort_intended'].includes(field) && child === effort(entry)
      || field === 'thinking' && equal(child, sdkThinking(provider, entry))
      || field === 'mode' && child === (entry.mode === 'unavailable' ? null : entry.mode))) result[field] = token;
    else result[field] = symbolicModelProjection(child, { provider, tier: key });
  }
  return result;
}

/** Hash exactly production's digest input, after projecting selections by provider/tier. */
export function symbolicProfilesDigest(preflight) {
  const overrides = {};
  for (const [id, entry] of Object.entries(preflight.normalized)) {
    if (entry?.tier_from) overrides[id] = ['critical', 'standard', 'fast'].map(tier => resolveConsumerProfile(entry, { tier }));
  }
  // Build's public preflight exposes a legacy abbreviated resolved map. Its pins
  // retain the full winners used by the production digest, including spec defaults.
  const resolved = preflight.staticProvenance
    ? Object.fromEntries(Object.entries(preflight.staticProvenance).map(([id, pin]) => [id, pin.winner]))
    : preflight.resolved;
  return profilesDigest(symbolicModelProjection({ normalized: preflight.normalized, resolved, overrides }));
}
