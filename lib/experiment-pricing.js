/**
 * experiment-pricing.js — Static model→$/MTok table for COMP-MODEL-AB.
 *
 * Used by experiment-metrics.js to derive a USD cost estimate from raw token
 * counts when build artifacts don't already carry a cost field.  Unknown
 * model IDs degrade to usd:null rather than crashing — a crashed / future
 * model still yields a record with partial metrics.
 *
 * Price source: Anthropic public pricing page + OpenAI pricing (as of 2026-06).
 * Keys are prefix-matched so dated variants (e.g. claude-sonnet-4-6-20250514)
 * resolve against the base key.
 */

/** @type {Record<string, { inputPerMTok: number, outputPerMTok: number }>} */
const EXPERIMENT_PRICING = {
  // Claude 4.x
  'claude-opus-4-8':    { inputPerMTok: 5,    outputPerMTok: 25  },
  'claude-opus-4-7':    { inputPerMTok: 5,    outputPerMTok: 25  },
  'claude-opus-4-6':    { inputPerMTok: 5,    outputPerMTok: 25  },
  'claude-sonnet-4-6':  { inputPerMTok: 3,    outputPerMTok: 15  },
  'claude-haiku-4-5':   { inputPerMTok: 1,    outputPerMTok: 5   },
  // GPT / Codex
  'gpt-5':              { inputPerMTok: 10,   outputPerMTok: 40  },
  'gpt-5.4':            { inputPerMTok: 10,   outputPerMTok: 40  },
  'gpt-4.1':            { inputPerMTok: 2,    outputPerMTok: 8   },
  'gpt-4o':             { inputPerMTok: 2.5,  outputPerMTok: 10  },
  'o3':                 { inputPerMTok: 10,   outputPerMTok: 40  },
  'o4-mini':            { inputPerMTok: 1.1,  outputPerMTok: 4.4 },
};

/**
 * Look up pricing for a model ID by exact match then prefix match.
 *
 * @param {string|null|undefined} modelID
 * @returns {{ inputPerMTok: number, outputPerMTok: number } | null}
 */
export function lookupExperimentPricing(modelID) {
  if (!modelID) return null;
  if (EXPERIMENT_PRICING[modelID]) return EXPERIMENT_PRICING[modelID];
  for (const [key, pricing] of Object.entries(EXPERIMENT_PRICING)) {
    if (modelID.startsWith(key)) return pricing;
  }
  return null;
}

/**
 * Derive a USD cost from token counts using the static pricing table.
 *
 * @param {string|null|undefined} modelID
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @returns {number|null}  USD cost, or null for unknown models
 */
export function deriveUsd(modelID, tokensIn, tokensOut) {
  const pricing = lookupExperimentPricing(modelID);
  if (!pricing) return null;
  const inputCost  = ((tokensIn  ?? 0) / 1_000_000) * pricing.inputPerMTok;
  const outputCost = ((tokensOut ?? 0) / 1_000_000) * pricing.outputPerMTok;
  return inputCost + outputCost;
}
