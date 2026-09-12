/**
 * model-pricing.js — Token cost lookup and USD calculation.
 *
 * Prices are per-million tokens (MTok) updated for COMP-FABLE-ASTRA slice 1 (2026-09).
 * Input price includes standard prompt tokens.
 * Cache write tokens (cache_creation_input_tokens) are billed at 1.25x input rate.
 * Cache read tokens (cache_read_input_tokens) are billed at 0.1x input rate.
 */

/**
 * Pricing map: modelID → { inputPerMTok, outputPerMTok } in USD.
 * Keys are matched by prefix so 'claude-sonnet-4-6' matches 'claude-sonnet-4-6-20250514' etc.
 */
export const MODEL_PRICING = {
  'claude-fable-5-1':  { inputPerMTok: 10,  outputPerMTok: 50 },
  'claude-opus-5':     { inputPerMTok: 5,   outputPerMTok: 25 },
  'claude-sonnet-5':   { inputPerMTok: 2,   outputPerMTok: 10 },
  'claude-opus-4-7':    { inputPerMTok: 5,   outputPerMTok: 25 },
  'claude-opus-4-6':    { inputPerMTok: 5,   outputPerMTok: 25 },
  'claude-sonnet-4-6':  { inputPerMTok: 3,   outputPerMTok: 15 },
  'claude-haiku-4-5':   { inputPerMTok: 1,   outputPerMTok: 5  },
  // Codex / GPT. Added 2026-09-12: this table feeds routing usage evidence via
  // result-normalizer.js, and it held NO gpt- entry, so every Codex call was
  // priced at $0. Codex compounds this by reporting no cost of its own (its
  // usage events carry token counts only -- verified against two real astra
  // runs), so the estimate here is the ONLY cost a Codex call ever gets. Without
  // these entries a Codex call surfaces as `missing-usd` / incomplete -- honest,
  // but it means no Codex call can ever be a COMPLETE attributable sample, which
  // is what COMP-MODEL-ROUTE gate 5 requires. gpt-6-astra was absent from BOTH of
  // compose's pricing tables despite being the flagship dispatch model.
  // Figures mirror stratum/ts/src/judge/pricing.ts and lib/experiment-pricing.js.
  // VERIFIED 2026-09-12 against the LiteLLM community registry
  // (github.com/BerriAI/litellm, model_prices_and_context_window.json, 3889 keys)
  // and OpenAI's published rate card. The figures previously carried by
  // lib/experiment-pricing.js and stratum/ts/src/judge/pricing.ts were STALE by two
  // price cuts: terra fell to 2/12 on 2026-07-30, sol to 4/20 on 2026-08-21. Those
  // two tables still overstate terra and sol by ~20-33% -- see the follow-up note.
  'gpt-6-astra':        { inputPerMTok: 10,   outputPerMTok: 50 },
  // PROMOTIONAL RATE, asserted 2026-09-12: sol's 4/20 is a promotion OpenAI has
  // stated runs at least through 2026-11-21. It is expected to move. Re-check at
  // that date against the registry; do not treat this line as durable.
  'gpt-5.6-sol':        { inputPerMTok: 4,    outputPerMTok: 20 },
  'gpt-5.6-terra':      { inputPerMTok: 2,    outputPerMTok: 12 },
  // Luna is the budget tier of the 5.6 family. Priced here so a luna dispatch is
  // attributable; it is NOT in server/model-tiers.js, so nothing routes to it yet.
  'gpt-5.6-luna':       { inputPerMTok: 0.2,  outputPerMTok: 1.2 },
  // UNVERIFIED against the registry: spark is subscription-billed there
  // (`chatgpt/gpt-5.3-codex-spark` carries mode/limits but NO cost fields), which
  // matches its separate-quota behaviour. This 1.75/14 is inherited from
  // lib/experiment-pricing.js and has no external confirmation.
  'gpt-5.3-codex-spark':{ inputPerMTok: 1.75, outputPerMTok: 14 },
};

/**
 * Look up pricing for a model ID.
 * Tries exact match first, then prefix match (handles dated variants).
 *
 * @param {string} modelID
 * @returns {{ inputPerMTok: number, outputPerMTok: number } | null}
 */
function lookupPricing(modelID) {
  if (!modelID) return null;

  // Exact match
  if (MODEL_PRICING[modelID]) return MODEL_PRICING[modelID];

  // Prefix match — handles e.g. 'claude-sonnet-4-6-20250514'
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelID.startsWith(key)) return pricing;
  }

  return null;
}

/**
 * Calculate the USD cost for a single agent call.
 *
 * @param {string} modelID
 * @param {number} inputTokens         Standard prompt tokens
 * @param {number} outputTokens        Completion tokens
 * @param {number} [cacheWriteTokens]  cache_creation_input_tokens (billed at 1.25x input)
 * @param {number} [cacheReadTokens]   cache_read_input_tokens (billed at 0.1x input)
 * @returns {number} USD cost. 0 for unknown models or zero-token calls; see the
 *   note in the body for why 0 is not read as "free" downstream.
 */
/**
 * Does this model's provider report `input_tokens` INCLUSIVE of cached tokens?
 *
 * OpenAI/Codex does: `input_tokens` already contains `cached_input_tokens`.
 * Anthropic does NOT: `input_tokens` is the uncached portion and the cache fields are
 * additional to it. `calculateCost` below implements the ANTHROPIC reading, so an
 * OpenAI usage record must have its cached portion subtracted before being priced or
 * the cached tokens are billed twice.
 *
 * @param {string|null|undefined} modelID
 * @returns {boolean}
 */
function reportsInclusiveInput(modelID) {
  return typeof modelID === 'string' && /^(gpt-|o3|o4)/.test(modelID);
}

/**
 * Price a streamed `step_usage` event, accounting for the PRODUCER's token dialect.
 *
 * Why this exists rather than normalizing at the producer: compose's routing evidence
 * guard (lib/routing-runtime.js:187-196) refuses with ROUTING_CALL_EVIDENCE_CONFLICT
 * when any forwarded field differs from the connector's own evidence -- tokens, input,
 * cacheRead. The event and the connector result MUST carry identical raw provider
 * numbers; that identity is what makes the routing ledger tamper-evident. Translating
 * in the stratum emitter was tried (stratum d006278) and reverted (1c2646c) after it
 * failed 15 tests here. So the raw numbers stay raw and the DIALECT IS APPLIED HERE.
 *
 * Measured on the retained 2026-09-12 live-fire review call (gpt-5.3-codex-spark,
 * 216,385 input of which 179,200 cached, 5,836 output): pricing the raw OpenAI numbers
 * with calculateCost gives $0.49173775 against the connector's authoritative
 * $0.17813775 -- 2.76x over. With the subtraction this returns 0.17813774999999998,
 * reproducing the connector's figure to floating-point noise.
 *
 * @param {string|null|undefined} modelID
 * @param {number} inputTokens    As reported by the provider, in ITS dialect.
 * @param {number} outputTokens
 * @param {number} [cacheWriteTokens]
 * @param {number} [cacheReadTokens]
 * @returns {number} USD cost; 0 for unknown models (see calculateCost).
 */
export function calculateEventCost(modelID, inputTokens, outputTokens, cacheWriteTokens = 0, cacheReadTokens = 0) {
  const uncached = reportsInclusiveInput(modelID)
    ? Math.max(0, (inputTokens ?? 0) - (cacheReadTokens ?? 0))
    : (inputTokens ?? 0);
  return calculateCost(modelID, uncached, outputTokens, cacheWriteTokens, cacheReadTokens);
}

export function calculateCost(modelID, inputTokens, outputTokens, cacheWriteTokens = 0, cacheReadTokens = 0) {
  const pricing = lookupPricing(modelID);
  // 0 for an unpriced model is SAFE here, verified 2026-09-12, and deliberately
  // left alone. It does not read downstream as "this call was free": a zero total
  // makes result-normalizer.js:733-735 OMIT cost_usd from the usage record, so
  // routing-runtime.js:55 (`u.usd ?? u.cost_usd ?? null`) yields null, presence.usd
  // is false, and routing-ledger.js:1286 marks the sample incomplete with
  // `missing-usd`. An unpriced model is therefore reported as UNKNOWN cost, not
  // free. Returning null instead would change nothing at the one caller (`total +=
  // null` coerces to 0) while breaking this function's documented contract.
  if (!pricing) return 0;

  const totalInput = (inputTokens ?? 0) + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0);
  const totalOutput = outputTokens ?? 0;

  if (totalInput === 0 && totalOutput === 0) return 0;

  const inputCost  = ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMTok;
  const writeCost  = ((cacheWriteTokens ?? 0) / 1_000_000) * pricing.inputPerMTok * 1.25;
  const readCost   = ((cacheReadTokens ?? 0) / 1_000_000) * pricing.inputPerMTok * 0.1;
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMTok;

  return inputCost + writeCost + readCost + outputCost;
}
