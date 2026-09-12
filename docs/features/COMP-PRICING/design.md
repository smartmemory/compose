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

**In scope:** the effective-dated contract; one pricer serving the HISTORICAL path; removal
of the live consumer-side pricing path (see amended Decision 2); a narrow drift test over the
one remaining overlap; the CI freshness diff; and the prefix-precedence fix.

**Not in scope:** a new npm package; stratum as a library (nothing to import — Decision 2);
any runtime price lookup; changes to `stratum/ts/src/judge/pricing.ts`, which becomes the
authority for live Codex rates and is left alone;
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

## Decision 2 (AMENDED 2026-09-12): the two repos do not need the same table

**The original Decision 2 asked the wrong question.** It asked who should own a shared
price table, and answered "compose owns it, stratum keeps a copy, a drift test holds them
together." Re-examined after the owner asked why the table could not simply be exported from
stratum, and the answer is better than either option: **after the `usd_source` fix landed
this morning, compose has no live need for Codex prices at all.**

Every producer now states its own cost:

| Producer | Where the cost comes from | Table needed? |
|---|---|---|
| stratum `claude.ts` | Claude SDK's `total_cost_usd`, emitted `usd_source: "reported"` | no |
| compose `local-claude-connector.js` | same SDK field (`:276`, `:295`) | no |
| stratum `codex.ts` | OpenAI's figure when present, else `usdFromTokens` marked `estimated` (`:488`, `:623`) | **yes, stratum's** |
| any unpriced model | both keys deliberately OMITTED so cost stays UNKNOWN | n/a |

Consumer-side pricing in `result-normalizer.js:489` is therefore reachable only when a
producer sends tokens with no cost — which now happens only for a model stratum cannot
price. **And compose cannot price it either: the two tables hold the identical key set**
(`gpt-5.3-codex-spark`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-astra`), with
every rate in agreement, verified by direct diff 2026-09-12.

So compose's Codex rows are exactly redundant, the fallback that reads them cannot fire, and
the only thing it could ever do is silently mask a divergence between the two tables. A
fallback whose sole function is to hide the drift it also causes is worse than no fallback.

**Decision: delete the live consumer-side pricing path rather than unify it.** No export from
stratum, and not because exporting is hard — because there is nothing compose needs to import.
The duplication dissolves instead of being managed.

What each repo then owns, for genuinely different jobs:

- **stratum** owns live Codex pricing. It is the only place a live call is ever priced, it
  prices at "now", and it needs no dates.
- **compose** owns historical repricing of build artifacts that recorded no cost
  (`experiment-pricing.js` via `experiment-metrics.js`). Different job, different shape:
  Claude and Codex, retired models included, and it genuinely needs dates.

**The dialect complexity does not leave compose — it moves.** `deriveUsd` is cache-blind, so
it prices OpenAI-dialect `input_tokens` (which already include the cached portion) at full
rate with no discount. Measured on the same live-fire call: **$0.46037775 against the
authoritative $0.17813775, 2.58x over** — the identical class of error just fixed on the live
path, still present and unfixed on the historical one. So Decision 1's dated, dialect-aware
pricer is still needed in compose. It is needed for `experiment-pricing.js`, not for
`model-pricing.js`.

**On the deep import.** `import('@smartmemory/stratum/dist/judge/pricing.js')` from compose
*works today* — verified 2026-09-12. With no `exports` field there is no contract, so stratum
could break it silently at any time. That makes it unacceptable in production and fine in a
**test**, where a break surfaces loudly in compose's own suite. This is the mechanism for the
narrow drift test that survives in S2.

---

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

## Decision 4: two different contracts for "unknown cost"

The same words mean opposite policies on the two paths, and the difference must be stated or
someone will "fix" one to match the other.

- **Live receipts are evidence.** No producer-stated cost means REFUSE: record `missing-usd`
  and never guess. An estimate that nobody asked for is indistinguishable downstream from a
  measurement.
- **Experiment metrics are analytics.** No recorded cost means ESTIMATE at the record's own
  timestamp, labelled as an estimate. A missing number here costs a data point, not an audit.

Deleting the live fallback (Decision 2) is what makes the first contract true. It is not a
loss of coverage: the fallback could not fire.

---

## Slices

### S1 — Dated contract, one pricer, live fallback removed

- [ ] `contracts/model-rates.schema.json` + data, effective-dated, with `_source` / `_changelog` / `_consumers`
- [ ] `priceCall(model, usage, at)` with `dialect` read from the rate row, never from a model-ID regex
- [ ] Exact-match-plus-explicit-alias lookup; first-prefix-wins removed, closing the `gpt-5` precedence defect
- [ ] `experiment-pricing.js` becomes a caller; `deriveUsd` gains `at` and stops being cache-blind
- [ ] **`model-pricing.js`'s live path is REMOVED, not made a caller** — `calculateEventCost` and the Codex rows go with it; `result-normalizer.js` records `missing-usd` when a producer states no cost
- [ ] `KNOWN_DIVERGENT` retired, terra/sol expressed as dated rows
- [ ] **Negative control:** the historical path reproduces $0.17813775 on the live-fire call; reverting the dialect row restores the measured 2.58x
- [ ] **Negative control:** a `gpt-5.x` model with no exact key resolves to null, not to `gpt-5`'s 10/40
- [ ] **Negative control:** a `step_usage` event with tokens and no cost yields `missing-usd`, never an invented figure

### S2 — The narrow overlap drift test

Smaller than originally filed: the only overlap left is *current Codex rates*, and stratum is
authoritative for them.

- [ ] compose test deep-imports `@smartmemory/stratum/dist/judge/pricing.js` and asserts the dated contract's CURRENT Codex rows equal stratum's
- [ ] Same test asserts every routable tier model is priced in **stratum's** table — with compose's fallback gone, a stratum-side omission now surfaces as `missing-usd` instead of being masked
- [ ] **Negative control:** mutating one stratum rate, and separately removing one stratum key, each turn the test red
- [ ] No dated rows in stratum, no new package, no `exports` field required

### S3 — CI freshness check

- [ ] Scheduled diff of the pinned snapshot against the LiteLLM registry; opens an item on divergence
- [ ] **Covers stratum's table first** — post-S1 it is the only table on a live path, so it is the only one whose staleness can misprice a real call
- [ ] Never invoked at runtime; no build or test path may reach the network for a price
- [ ] Spark excluded by name with its reason recorded (subscription-billed, no cost fields upstream)
- [ ] **Negative control:** a deliberately stale snapshot entry is reported

**Sequencing.** S3 does not depend on S1 and can be pulled forward: the live-path bug is
dormant (producers state their own cost) while the staleness bug is active (terra/sol were
wrong for ~6 weeks and nothing watches). Recommended order is **S3 → S1 → S2**.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `contracts/model-rates.schema.json` | new | Effective-dated rates contract + data |
| `lib/model-rates.js` | new | `priceCall(model, usage, at)`; dialect as data |
| `lib/experiment-pricing.js` | existing | Becomes a caller; `deriveUsd` gains `at`, stops being cache-blind |
| `lib/experiment-metrics.js` | existing | Supplies the receipt timestamp to `deriveUsd` |
| `lib/model-pricing.js` | existing | **Live pricing path removed**; Codex rows and `calculateEventCost` deleted |
| `lib/result-normalizer.js` | existing | Records `missing-usd` rather than pricing tokens itself |
| `test/model-tiers.test.js` | existing | `KNOWN_DIVERGENT` retired; precedence control retargeted |
| `test/model-pricing.test.js` | existing | Rewritten against the dated pricer; live-fallback cases removed |
| `scripts/check-rate-freshness.mjs` | new | CI-only registry diff, stratum's table first |
| `stratum/ts/src/judge/pricing.ts` | existing (stratum) | **Unchanged**; becomes the authority for live Codex rates |

## Open Questions

1. **Where does `at` come from for an experiment record with no timestamp?** `experiment-metrics.js`
   reads sandbox artifacts; if a history record carries no date, S1 must choose between the
   file mtime and refusing to price. Refusing is the honest default (`usd: null`, already
   handled) but reduces coverage on old records.
2. **Does removing the live fallback need a deprecation interval?** It cannot fire today, but
   that rests on the two key sets being identical. If stratum ever prices a model compose does
   not, nothing changes; the reverse is what the S2 test now catches.
3. **Spark's cache rate stays inferred.** Both its 1.75/14 and its 0.175 cache rate have no
   external source. S3 cannot check it. Recorded, not solved.

---

## Amendment history

- **2026-09-12 (same day as filing).** Decision 2 reversed and Decision 4 added, after the
  owner asked why the table could not be exported from stratum. The original answer ("copies
  plus a drift test, because stratum exports nothing") was correct on its narrow point and
  answered the wrong question. Investigation found that no live path in either repo prices a
  Claude call from a table, that compose's Codex fallback is unreachable because the two key
  sets are identical, and that the dialect defect is still live on the historical path at
  2.58x. S1 changed from "both tables become callers" to "the live path is removed", S2
  narrowed to the overlap, S3 retargeted at stratum's table. No code changed.
