/**
 * experiment-pricing.js — Static model→$/MTok table for COMP-MODEL-AB.
 *
 * Used by experiment-metrics.js to derive a USD cost estimate from raw token
 * counts when build artifacts don't already carry a cost field.  Unknown
 * model IDs degrade to usd:null rather than crashing — a crashed / future
 * model still yields a record with partial metrics.
 *
 * Claude 5 rates: COMP-FABLE-ASTRA slice 1 (2026-09). Earlier rates retained
 * for historical receipts (Anthropic / OpenAI, 2026-07).
 * Keys are prefix-matched so dated variants (e.g. claude-sonnet-4-6-20250514)
 * resolve against the base key.
 */

/** @type {Record<string, { inputPerMTok: number, outputPerMTok: number }>} */
const EXPERIMENT_PRICING = {
  'claude-fable-5-1':  { inputPerMTok: 10,  outputPerMTok: 50 },
  'claude-opus-5':     { inputPerMTok: 5,   outputPerMTok: 25 },
  'claude-sonnet-5':   { inputPerMTok: 2,   outputPerMTok: 10 },
  // Claude 4.x
  'claude-opus-4-8':    { inputPerMTok: 5,    outputPerMTok: 25  },
  'claude-opus-4-7':    { inputPerMTok: 5,    outputPerMTok: 25  },
  'claude-opus-4-6':    { inputPerMTok: 5,    outputPerMTok: 25  },
  'claude-sonnet-4-6':  { inputPerMTok: 3,    outputPerMTok: 15  },
  'claude-haiku-4-5':   { inputPerMTok: 1,    outputPerMTok: 5   },
  // GPT / Codex
  // ORDER MATTERS: lookup falls back to the FIRST key that prefixes the model ID, and
  // the legacy `gpt-5` key prefixes every gpt-5.x model. Before `gpt-5.6-luna` was listed
  // here it fell through to `gpt-5` and priced at 10/40 instead of 0.2/1.2 — a silent 35.7x
  // overstatement with no null to flag it. Any new gpt-5.x model MUST get an explicit key
  // above `gpt-5`; test/model-tiers.test.js pins that for every routable tier model.
  'gpt-6-astra':        { inputPerMTok: 10,   outputPerMTok: 50  },
  'gpt-5.6-sol':        { inputPerMTok: 5,    outputPerMTok: 30  },
  'gpt-5.6-terra':      { inputPerMTok: 2.5,  outputPerMTok: 15  },
  'gpt-5.6-luna':       { inputPerMTok: 0.2,  outputPerMTok: 1.2 },
  'gpt-5':              { inputPerMTok: 10,   outputPerMTok: 40  },
  'gpt-5.5':            { inputPerMTok: 5,    outputPerMTok: 30  },
  'gpt-5.4':            { inputPerMTok: 2.5,  outputPerMTok: 15  },
  'gpt-5.3-codex-spark':{ inputPerMTok: 1.75, outputPerMTok: 14  },
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
