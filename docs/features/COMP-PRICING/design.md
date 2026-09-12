# COMP-PRICING: One effective-dated cost model — Design

**Status:** DESIGN
**Date:** 2026-09-12

## Related Documents

- ROADMAP row: `COMP-PRICING` (phase "COMP-PRICING: One effective-dated cost model")
- [COMP-MODEL-ROUTE design](../COMP-MODEL-ROUTE/design.md) — surfaced this; owns the routing ledger and gate 5
- [COMP-MODEL-ROUTE gate-5 evidence](../COMP-MODEL-ROUTE/evidence/livefire-2026-09-12/README.md) — the reconciler whose reproducibility constrains Decision 3
- [COMP-MODEL-AB design](../COMP-MODEL-AB/design.md) — owns `experiment-metrics.js`, the sole consumer of `experiment-pricing.js`
- Contract convention precedent: `contracts/comp-obs-contract.schema.json` (`_source` / `_changelog` / `_consumers`)

---

## Problem

Three hand-maintained price tables disagree, and they disagree about more than numbers.

They are not three copies of one table. They are three different functions:

| | Prices | Token dialect | Cache model | Lookup |
|---|---|---|---|---|
| `compose/lib/model-pricing.js` | Claude (authoritative) + Codex (fallback) | Anthropic: `input_tokens` EXCLUDES cache | write 1.25x / read 0.1x, derived from input | prefix over all keys |
| `stratum/ts/src/judge/pricing.ts` | Codex only (authoritative) | OpenAI: `cachedInputTokens` ⊂ `inputTokens` | explicit per-model `cacheRead`, no write rate | exact, after `baseModel()` strips `/effort` |
| `compose/lib/experiment-pricing.js` | everything incl. retired models | none | none at all | prefix, order-dependent |

Two defects follow, and they are separable.

**Defect A — mechanism.** Two dialects and three cache models in one pipeline. Measured
2026-09-12 on a real live-fire review call (`gpt-5.3-codex-spark`, 216,385 input of which
179,200 cached, 5,836 output): pricing the raw OpenAI numbers under the Anthropic reading
gives **$0.49173775 against the connector's authoritative $0.17813775, 2.76x over**. This
was caught only because the producer began stating its own amount (`usd_source`, shipped
2026-09-12 in compose `3345591` / stratum `e1074aa`). The consumer-side pricer remains the
fallback whenever a producer sends tokens with no cost, so the hazard is dormant, not gone.

**Defect B — freshness.** `gpt-5.6-terra` and `gpt-5.6-sol` were stale by two upstream price
cuts (terra to 2/12 on 2026-07-30, sol to a promotional 4/20 on 2026-08-21), overstating both
by 20-33% for roughly six weeks. Nobody knew until the tables were diffed against an external
registry on 2026-09-12.

**These need different fixes, and conflating them is what made this look like a dependency
decision.** Consolidating three tables into one makes ONE table stale instead of three; it
does not tell anyone a price changed. The fact "terra fell to 2/12" originates outside the
repo and no internal component can derive it. The component is internal. Only the data
origin is external.

**Third, a lookup defect.** `experiment-pricing.js` resolves by first-prefix-match over
insertion order, and the legacy `gpt-5` key prefixes every `gpt-5.x` model. `gpt-5.6-luna`
fell through to it and priced at 10/40 instead of 0.2/1.2 — a silent **35.7x** overstatement
with no null to flag it. Currently held off by explicit keys placed above the catch-all and
a test (`test/model-tiers.test.js:311`); the precedence rule itself is unfixed.

### A finding that dissolves a deferred owner decision

`test/model-tiers.test.js:293` carries `KNOWN_DIVERGENT = new Set(['gpt-5.6-terra', 'gpt-5.6-sol'])`,
deferring reconciliation because "the experiment table is documented as retaining historical
rates for old receipts."

**That justification does not hold.** `deriveUsd(modelID, tokensIn, tokensOut)` takes no
timestamp, and the sole call site (`lib/experiment-metrics.js:224`) supplies none. The table
holds one rate per key and applies it to every receipt regardless of when the build ran. It
cannot price historically.

What it legitimately retains is old model *keys* (`gpt-4o`, `o3`, `gpt-4.1`, `gpt-5`,
`gpt-5.5`, `gpt-5.4`) so a record naming a retired model still prices. That is not the same
as keeping a stale rate on a *live* model. terra/sol at 2.5/15 and 5/30 are simply wrong for
any experiment run after the cut dates, and wrong-but-indistinguishable for ones before.

**There is no owner decision here — it is a bug with a plausible excuse attached.** Blast
radius is bounded: this path fires only when a history record carries no `cost_usd`.

---

## Goal

One internal pricing component, correct across dialects, reproducible across time, with an
external freshness alarm that can never reach runtime.

**In scope:** the effective-dated contract, one pricer, both compose tables as callers,
stratum aligned behind a drift test, the CI freshness diff, and the prefix-precedence fix.

**Not in scope:** a new npm package; stratum as a library; any runtime price lookup;
reconciling `gpt-5.3-codex-spark` (subscription-billed, no external source exists — it stays
explicitly flagged as unverified); and COMP-MODEL-ROUTE Q3.

---

## Decision 1: Effective-dated rates, not a flat map

A flat `model → rate` map cannot express "terra was 2.5/15 until 2026-07-30, then 2/12."
Prices change; receipts span time. The shape is:

```
model → [{ from, until, input, output, cacheRead, cacheWrite, dialect, source }]
```

and **a receipt prices at its own timestamp**: `priceCall(model, usage, at)`.

Once dates exist, the terra/sol "divergence" stops being a divergence and becomes two query
dates against one history. `KNOWN_DIVERGENT` is a hand-rolled two-element approximation of
exactly this, which is why Decision 1 retires it rather than ruling on it.

`dialect` is carried as DATA on the rate row, not inferred. Today `reportsInclusiveInput()`
branches on a `/^(gpt-|o3|o4)/` regex over the model ID — a provider's reporting convention
encoded as a naming convention, which breaks silently the first time a vendor renames or a
third provider appears.

## Decision 2: One contract file, owned by compose, mirrored by drift test

Follows the existing `contracts/` convention (`_source`, `_changelog`, `_consumers`,
versioned, additive) — the same mechanism `comp-obs-contract.schema.json` already uses for
the cross-repo producer/consumer data model where stratum produces and compose consumes.

**Rejected: export the table from stratum and have compose import it.** Unreachable as
stated. Stratum's `ts/package.json` carries `main: null`, `types: null`, `exports: null`,
`files: ["dist"]`, and compose consumes stratum by spawning its bin over MCP, never by
`import`. Taking this option means establishing stratum as a dual CLI-plus-library package
with a public API surface and its own semver discipline, on top of the existing three-package
version-sync rules. That is a project, not an export line.

**Rejected: a new shared npm package.** Same version-sync cost, plus a third publish target,
for one JSON file and one function.

So stratum keeps its own copy, and a drift test fails when its numbers disagree with the
contract for overlapping models — the same pattern as the tier-enum drift test landed
2026-09-12 in `test/model-tiers.test.js`.

## Decision 3: Reproducible, never live

**Receipts are evidence.** The routing ledger is tamper-evident, and
`lib/routing-runtime.js:187-196` refuses any forwarded field that differs from the
connector's own evidence. COMP-MODEL-ROUTE gate 5 rests on `$1.4257732` being that number
again next month.

A runtime registry lookup would make historical receipts silently non-reproducible: re-run
`evidence/livefire-2026-09-12/reconcile.mjs` after an upstream price change and it yields a
different total, while still exiting 0. **The falsifier would stop falsifying without
failing.** That is the worst available outcome and it rules out a live feed categorically,
independent of which registry.

Therefore the external source is a **pinned, checked-in snapshot**, and the only external
touch is a scheduled CI diff that opens an item on divergence. Nothing consults the network
at runtime. The LiteLLM community registry (`BerriAI/litellm`,
`model_prices_and_context_window.json`, 3889 keys) covers every model dispatched except
spark, verified 2026-09-12.

---

## Slices

### S1 — Contract + one pricer

- [ ] `contracts/model-rates.schema.json` + the rates data, effective-dated, with `_source` / `_changelog` / `_consumers`
- [ ] `priceCall(model, usage, at)` with `dialect` read from the rate row, never from a model-ID regex
- [ ] Exact-match-plus-explicit-alias lookup; the first-prefix-wins rule is removed, closing the `gpt-5` precedence defect
- [ ] `lib/model-pricing.js` and `lib/experiment-pricing.js` become callers; public signatures preserved for their existing consumers
- [ ] `KNOWN_DIVERGENT` retired, with terra/sol expressed as dated rows
- [ ] **Negative control:** the retained live-fire figure reproduces to floating-point noise ($0.17813775); reverting the dialect row reintroduces the 2.76x error
- [ ] **Negative control:** a `gpt-5.x` model with no exact key resolves to null, not to `gpt-5`'s 10/40

### S2 — Stratum alignment

- [ ] Stratum's `judge/pricing.ts` reshaped to the same effective-dated rows (own copy, no new package)
- [ ] Drift test fails when stratum and the contract disagree for any overlapping model
- [ ] **Negative control:** mutating one stratum rate turns the drift test red

### S3 — CI freshness check

- [ ] Scheduled diff of the pinned snapshot against the LiteLLM registry; opens an item on divergence
- [ ] Never invoked at runtime, and no build or test path may reach the network for a price
- [ ] Spark excluded by name with its reason recorded (subscription-billed, no cost fields upstream)
- [ ] **Negative control:** a deliberately stale snapshot entry is reported by the check

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `contracts/model-rates.schema.json` | new | Effective-dated rates contract + data |
| `lib/model-rates.js` | new | `priceCall(model, usage, at)`; dialect as data |
| `lib/model-pricing.js` | existing | Becomes a caller; keeps `calculateCost` / `calculateEventCost` signatures |
| `lib/experiment-pricing.js` | existing | Becomes a caller; `deriveUsd` gains an `at` argument |
| `lib/experiment-metrics.js` | existing | Supplies the receipt timestamp to `deriveUsd` |
| `test/model-tiers.test.js` | existing | `KNOWN_DIVERGENT` retired; precedence control retargeted |
| `stratum/ts/src/judge/pricing.ts` | existing (stratum) | Reshaped to dated rows; drift-tested against the contract |
| `scripts/check-rate-freshness.mjs` | new | CI-only registry diff |

## Open Questions

1. **Where does `at` come from for an experiment record with no timestamp?** `experiment-metrics.js`
   reads sandbox artifacts; if a history record carries no date, S1 must choose between the
   file mtime and refusing to price. Refusing is the honest default (yields `usd: null`,
   which that function already handles) but reduces coverage on old records.
2. **Does stratum need dates at all, or only compose?** Stratum prices a call as it happens,
   so "now" is always correct there. Dated rows may be dead weight on the producer side — but
   a single shape across both is what makes the drift test trivial.
3. **Spark's cache rate stays inferred.** Both its 1.75/14 and its 0.175 cache rate have no
   external source. S3 cannot check it. Recorded, not solved.
