/**
 * agent-string.js — Centralized agent string parsing for COMP-AGENT-CAPS.
 *
 * The agent string format is "provider:template:tier" (e.g. "claude:read-only-reviewer:critical").
 * All three segments are optional after the provider:
 *   "claude"                          → provider only
 *   "claude:read-only-reviewer"       → provider + template
 *   "claude:read-only-reviewer:fast"  → provider + template + tier
 *   "claude::fast"                    → provider + tier (no template)
 *
 * Tiers: critical | standard | fast | budget | coordinator (via model-tiers.js).
 *   Claude: Opus / Sonnet / Haiku / -- / Fable
 *   Codex:  astra / terra  / spark / luna / --
 * The vocabulary is SHARED across providers: KNOWN_TIERS below is derived from the Claude
 * table, so a tier must appear in both maps to be a valid name. A tier that is null for a
 * provider is a known name that provider cannot serve (`claude::budget`, `codex::coordinator`),
 * and yields the "not available for provider" message rather than "unknown tier".
 */

import { resolveTemplate } from '../server/agent-templates.js';
import { MODEL_TIERS, resolveTierModel, resolveTierThinking } from '../server/model-tiers.js';

/** Known provider names — validated by validateAgentString. */
const KNOWN_PROVIDERS = new Set(['claude', 'codex']);

/** Known tier names — validated by validateAgentString (null = no tier = ok). */
const KNOWN_TIERS = new Set(Object.keys(MODEL_TIERS));

/**
 * Parse a raw agent string into provider, template, and tier parts.
 *
 * @param {string|null|undefined} raw
 * @returns {{ provider: string, template: string|null, tier: string|null }}
 *
 * Examples:
 *   "claude:read-only-reviewer"          → { provider: 'claude', template: 'read-only-reviewer', tier: null }
 *   "claude"                             → { provider: 'claude', template: null, tier: null }
 *   "claude:read-only-reviewer:critical" → { provider: 'claude', template: 'read-only-reviewer', tier: 'critical' }
 *   "claude::fast"                       → { provider: 'claude', template: null, tier: 'fast' }
 *   "codex"                              → { provider: 'codex', template: null, tier: null }
 *   null / undefined                     → { provider: 'claude', template: null, tier: null }  (backward compat)
 */
export function parseAgentString(raw) {
  if (!raw) {
    return { provider: 'claude', template: null, tier: null };
  }

  const parts = raw.split(':');
  const provider = parts[0] || 'claude';
  const template = parts[1] || null;
  const tier = parts[2] || null;

  return { provider, template, tier };
}

/**
 * Validate a raw agent string, throwing with a clear message on failure.
 *
 * Checks:
 *   - provider must be a known connector type (claude | codex)
 *   - tier, if present, must be a known tier (critical | standard | fast | budget | coordinator)
 *
 * COMP-MODEL-AB: used by --implementer / --reviewer flag validation.
 *
 * @param {string} raw
 * @throws {Error} on unknown provider or unknown tier
 */
export function validateAgentString(raw) {
  const { provider, tier } = parseAgentString(raw);
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(
      `Invalid agent string "${raw}": unknown provider "${provider}" ` +
      `(known: ${[...KNOWN_PROVIDERS].sort().join(', ')})`
    );
  }
  if (tier != null && !KNOWN_TIERS.has(tier)) {
    throw new Error(
      `Invalid agent string "${raw}": unknown tier "${tier}" ` +
      `(known: ${[...KNOWN_TIERS].sort().join(', ')})`
    );
  }
  if (tier != null && resolveTierModel(tier, provider) === null) {
    throw new Error(
      `Invalid agent string "${raw}": tier "${tier}" is not available for provider "${provider}"`
    );
  }
}

/**
 * Resolve an agent string to a full config including capability restrictions,
 * model ID, and tier-default thinking/effort config.
 *
 * @param {string|null|undefined} raw
 * @returns {{
 *   provider: string,
 *   template: string|null,
 *   tier: string|null,
 *   modelID: string|null,
 *   allowedTools: string[]|null,
 *   disallowedTools: string[]|null,
 *   thinking: { type: 'adaptive' }|{ type: 'disabled' }|null,
 *   effort: string|null,
 * }}
 */
export function resolveAgentConfig(raw) {
  const { provider, template, tier } = parseAgentString(raw);
  const resolved = resolveTemplate(template);
  const modelID = resolveTierModel(tier, provider);
  const tierThinking = resolveTierThinking(tier, provider);

  // Map tier thinking config to SDK shape.
  let thinking = null;
  let effort = null;
  if (tierThinking) {
    if (provider === 'claude') {
      thinking = tierThinking.mode === 'adaptive'
        ? { type: 'adaptive' }
        : { type: 'disabled' };
    }
    effort = tierThinking.effort;
  }

  return {
    provider,
    template,
    tier,
    modelID,
    allowedTools: resolved?.allowedTools ?? null,
    disallowedTools: resolved?.disallowedTools ?? null,
    thinking,
    effort,
  };
}
