/**
 * Tests for lib/model-pricing.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { MODEL_PRICING, calculateCost, calculateEventCost } = await import(`${REPO_ROOT}/lib/model-pricing.js`);

// ---------------------------------------------------------------------------
// MODEL_PRICING table
// ---------------------------------------------------------------------------

test('MODEL_PRICING contains expected models', () => {
  assert.ok(MODEL_PRICING['claude-opus-4-7'], 'opus-4-7 should be present');
  assert.ok(MODEL_PRICING['claude-opus-4-6'], 'opus-4-6 should be present');
  assert.ok(MODEL_PRICING['claude-sonnet-4-6'], 'sonnet-4-6 should be present');
  assert.ok(MODEL_PRICING['claude-haiku-4-5'], 'haiku-4-5 should be present');
});

test('MODEL_PRICING has correct opus-4-7 rates', () => {
  assert.equal(MODEL_PRICING['claude-opus-4-7'].inputPerMTok, 5);
  assert.equal(MODEL_PRICING['claude-opus-4-7'].outputPerMTok, 25);
});

test('MODEL_PRICING has correct opus-4-6 rates', () => {
  assert.equal(MODEL_PRICING['claude-opus-4-6'].inputPerMTok, 5);
  assert.equal(MODEL_PRICING['claude-opus-4-6'].outputPerMTok, 25);
});

test('MODEL_PRICING has correct sonnet rates', () => {
  assert.equal(MODEL_PRICING['claude-sonnet-4-6'].inputPerMTok, 3);
  assert.equal(MODEL_PRICING['claude-sonnet-4-6'].outputPerMTok, 15);
});

test('MODEL_PRICING has correct haiku rates', () => {
  assert.equal(MODEL_PRICING['claude-haiku-4-5'].inputPerMTok, 1);
  assert.equal(MODEL_PRICING['claude-haiku-4-5'].outputPerMTok, 5);
});

// ---------------------------------------------------------------------------
// calculateCost — known inputs
// ---------------------------------------------------------------------------

test('calculateCost sonnet: 1M input + 1M output', () => {
  // 1M input × $3/MTok + 1M output × $15/MTok = $18
  const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
  assert.equal(cost, 18);
});

test('calculateCost opus: 1M input + 1M output', () => {
  // 1M × $5 + 1M × $25 = $30
  const cost = calculateCost('claude-opus-4-6', 1_000_000, 1_000_000);
  assert.equal(cost, 30);
});

test('calculateCost opus-4-7: 1M input + 1M output', () => {
  // 1M × $5 + 1M × $25 = $30
  const cost = calculateCost('claude-opus-4-7', 1_000_000, 1_000_000);
  assert.equal(cost, 30);
});

test('calculateCost haiku: 1M input + 1M output', () => {
  // 1M × $1 + 1M × $5 = $6
  const cost = calculateCost('claude-haiku-4-5', 1_000_000, 1_000_000);
  assert.equal(cost, 6);
});

test('calculateCost sonnet: small call (10k input, 2k output)', () => {
  // 10k × $3/MTok + 2k × $15/MTok = 0.03 + 0.03 = $0.06
  const cost = calculateCost('claude-sonnet-4-6', 10_000, 2_000);
  assert.ok(Math.abs(cost - 0.06) < 0.0001, `expected ~$0.06 got ${cost}`);
});

test('calculateCost includes cache write at 1.25x input rate', () => {
  // 1M cache_write tokens × $3/MTok × 1.25 = $3.75
  const cost = calculateCost('claude-sonnet-4-6', 0, 0, 1_000_000, 0);
  assert.equal(cost, 3.75);
});

test('calculateCost includes cache read at 0.1x input rate', () => {
  // 1M cache_read tokens × $3/MTok × 0.1 = $0.30
  const cost = calculateCost('claude-sonnet-4-6', 0, 0, 0, 1_000_000);
  assert.ok(Math.abs(cost - 0.3) < 0.0001, `expected ~$0.30 got ${cost}`);
});

test('calculateCost with dated model variant (prefix match)', () => {
  // 'claude-sonnet-4-6-20250514' should match 'claude-sonnet-4-6' by prefix
  const cost = calculateCost('claude-sonnet-4-6-20250514', 1_000_000, 0);
  assert.equal(cost, 3);
});

// ---------------------------------------------------------------------------
// calculateCost — unknown models
// ---------------------------------------------------------------------------

test('calculateCost returns 0 for unknown model', () => {
  const cost = calculateCost('gpt-99-ultra', 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for null model', () => {
  const cost = calculateCost(null, 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for undefined model', () => {
  const cost = calculateCost(undefined, 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for empty model string', () => {
  const cost = calculateCost('', 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

// ---------------------------------------------------------------------------
// calculateCost — zero tokens
// ---------------------------------------------------------------------------

test('calculateCost returns 0 for zero input and output tokens', () => {
  const cost = calculateCost('claude-sonnet-4-6', 0, 0);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for null token counts', () => {
  const cost = calculateCost('claude-sonnet-4-6', null, null);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for undefined token counts', () => {
  const cost = calculateCost('claude-sonnet-4-6', undefined, undefined);
  assert.equal(cost, 0);
});


for (const [model, input, output] of [
  ['claude-fable-5-1', 10, 50],
  ['claude-opus-5', 5, 25],
  ['claude-sonnet-5', 2, 10],
]) {
  test(`${model} prices input, output, cache tokens and dated variants`, () => {
    assert.deepEqual(MODEL_PRICING[model], { inputPerMTok: input, outputPerMTok: output });
    assert.equal(calculateCost(model, 1_000_000, 0), input);
    assert.equal(calculateCost(model, 0, 1_000_000), output);
    assert.equal(calculateCost(`${model}-20260909`, 1_000_000, 1_000_000), input + output);
    assert.equal(calculateCost(model, 0, 0, 1_000_000, 0), input * 1.25);
    assert.equal(calculateCost(model, 0, 0, 0, 1_000_000), input * 0.1);
  });
}

// ---------------------------------------------------------------------------
// Codex / GPT pricing — COMP-MODEL-ROUTE gate-5 prerequisite (added 2026-09-12)
//
// This table feeds routing usage evidence through result-normalizer.js, and it
// held NO gpt- entry, so every Codex call priced at 0. Codex reports no cost of
// its own (its usage events carry token counts only), so this estimate is the
// only cost a Codex call ever gets. A 0 total makes result-normalizer.js:733-735
// omit cost_usd, which routing-ledger.js:1286 marks `missing-usd` / incomplete —
// honest, but it means no Codex call can be a COMPLETE attributable sample,
// which is exactly what gate 5 requires.
// ---------------------------------------------------------------------------

test('calculateCost prices every Codex model compose dispatches (non-zero)', () => {
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.3-codex-spark']) {
    const cost = calculateCost(model, 1_000_000, 100_000);
    assert.ok(cost > 0, `${model} must carry a non-zero price; 0 makes it indistinguishable from an unpriced model`);
  }
});

test('calculateCost codex spark: 1M input + 100k output', () => {
  // 1.75/MTok input, 14/MTok output → 1.75 + 1.4
  assert.equal(calculateCost('gpt-5.3-codex-spark', 1_000_000, 100_000).toFixed(4), '3.1500');
});

test('calculateCost codex astra: 1M input + 100k output', () => {
  // 10/MTok input, 50/MTok output → 10 + 5
  assert.equal(calculateCost('gpt-6-astra', 1_000_000, 100_000), 15);
});

// Terra and sol carry the CURRENT rates, verified 2026-09-12 against the LiteLLM
// registry and OpenAI's rate card. The repo's two other pricing tables still hold
// the pre-cut figures (terra 2.5/15, sol 5/30) and overstate spend by ~20-33%.
// These assertions exist so a copy-paste from those stale tables fails loudly.
test('calculateCost codex terra uses the post-2026-07-30 rate, not the stale 2.5/15', () => {
  // 2/MTok input, 12/MTok output → 2 + 1.2
  assert.equal(calculateCost('gpt-5.6-terra', 1_000_000, 100_000).toFixed(4), '3.2000');
});

test('calculateCost codex sol uses the promotional 4/20, not the stale 5/30', () => {
  // 4/MTok input, 20/MTok output → 4 + 2. Promotional through at least 2026-11-21.
  assert.equal(calculateCost('gpt-5.6-sol', 1_000_000, 100_000), 6);
});

test('calculateCost prices gpt-5.6-luna', () => {
  // 0.2/MTok input, 1.2/MTok output → 0.2 + 0.12
  assert.equal(calculateCost('gpt-5.6-luna', 1_000_000, 100_000).toFixed(4), '0.3200');
});

test('MODEL_PRICING covers the tier map so no dispatched model is unpriced', async () => {
  const { MODEL_TIERS, CODEX_MODEL_TIERS } = await import(`${REPO_ROOT}/server/model-tiers.js`);
  const dispatched = [...Object.values(MODEL_TIERS), ...Object.values(CODEX_MODEL_TIERS)].filter(Boolean);
  for (const model of dispatched) {
    assert.ok(calculateCost(model, 1_000_000, 0) > 0,
      `tier map dispatches ${model} but MODEL_PRICING cannot price it — it would reach the ledger as missing-usd`);
  }
});

// ---------------------------------------------------------------------------
// calculateEventCost — the PRODUCER token dialect (2026-09-12)
//
// OpenAI reports input_tokens INCLUDING cached_input_tokens; Anthropic reports it
// EXCLUDING them, with the cache fields additional. calculateCost implements the
// Anthropic reading, so pricing raw OpenAI numbers with it bills the cached portion
// twice. The fix lives HERE and not in the stratum emitter because compose's routing
// evidence guard (lib/routing-runtime.js:187-196) refuses with
// ROUTING_CALL_EVIDENCE_CONFLICT when any forwarded field differs from the connector's
// own evidence -- translating at the producer was tried (stratum d006278) and reverted
// (1c2646c) after failing 15 tests here.
// ---------------------------------------------------------------------------

// Real numbers from the retained 2026-09-12 live-fire review call, whose connector
// estimate was $0.17813775.
const LIVEFIRE = { model: 'gpt-5.3-codex-spark', input: 216385, output: 5836, cacheRead: 179200 };

test('calculateEventCost subtracts cached tokens for OpenAI-dialect models', () => {
  const { model, input, output, cacheRead } = LIVEFIRE;
  const priced = calculateEventCost(model, input, output, 0, cacheRead);
  assert.ok(Math.abs(priced - 0.17813775) < 1e-9,
    `expected the connector's $0.17813775, got ${priced}`);
});

test('pricing the RAW OpenAI numbers double-bills the cache — the bug this prevents', () => {
  const { model, input, output, cacheRead } = LIVEFIRE;
  const raw = calculateCost(model, input, output, 0, cacheRead);
  const fixed = calculateEventCost(model, input, output, 0, cacheRead);
  assert.ok(raw > fixed * 2.5,
    `raw pricing must be the inflated one (raw ${raw} vs fixed ${fixed})`);
  assert.ok(Math.abs(raw - 0.49173775) < 1e-9, `expected the 2.76x figure, got ${raw}`);
});

test('calculateEventCost leaves Anthropic-dialect models untouched', () => {
  // Real claude row from the same run: input EXCLUDES the 422,507 cached tokens.
  const args = ['claude-haiku-4-5-20251001', 66, 2310, 29325, 422507];
  assert.equal(calculateEventCost(...args), calculateCost(...args),
    'claude pricing must not change — its input_tokens is already the uncached portion');
});

test('every Codex tier model is treated as OpenAI dialect', async () => {
  const { CODEX_MODEL_TIERS } = await import(`${REPO_ROOT}/server/model-tiers.js`);
  for (const model of Object.values(CODEX_MODEL_TIERS)) {
    if (model === null) continue;
    // 1000 input of which 1000 cached => the uncached portion is 0, so the input term
    // vanishes entirely. Under the Anthropic reading it would still be charged.
    const ev = calculateEventCost(model, 1000, 0, 0, 1000);
    const raw = calculateCost(model, 1000, 0, 0, 1000);
    assert.ok(ev < raw, `${model} must be treated as OpenAI dialect (ev ${ev} vs raw ${raw})`);
  }
});
