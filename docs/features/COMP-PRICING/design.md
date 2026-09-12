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

## Decision 1 (AMENDED 2026-09-12, second pass): ONE pricer, dating DEFERRED

The original Decision 1 made effective dating "the modeling core" on the assumption that
compose reprices historical records. **It does not. Nothing in either repo reprices
anything.**

Verified 2026-09-12:

- The routing ledger is append-only and tamper-evident. Receipts carry the cost stated at
  dispatch and are never recomputed — `routing-ledger.js`, `routing-runtime.js` and
  `consumer-fanout.js` contain no call to any pricing function; they only READ a persisted
  `usd`.
- `experiment-metrics.js`'s `collect()` is invoked exactly once, INLINE, at
  `lib/experiment.js:404` — immediately after the build it measures, before the run record is
  written at `:431`. Its only other callers are tests. There is no path that re-reads old
  sandbox artifacts and re-derives a cost.

So every pricing event in the system happens at the moment of the call, or seconds after it.
`at` is always "now". **Dating solves a problem this codebase does not have**, and building
it would be speculative generality.

What survives from the original Decision 1, and is the actual core:

- **One pricer, with `dialect` carried as DATA on the rate row** rather than inferred from a
  `/^(gpt-|o3|o4)/` regex over the model ID. The regex encodes a provider's reporting
  convention as a naming convention and breaks silently on a rename or a third provider.
- **One current rate table**, correct, with exact-match-plus-alias lookup.

Effective dating moves to an open question. If a repricing or audit-from-tokens requirement
ever appears, the rate rows gain `from`/`until` then — additively, and with a real caller.

---

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

## Decision 3 (ARGUMENT CORRECTED 2026-09-12): pin the rates, never fetch them live

**The conclusion stands. The original argument for it was wrong, and it shipped in
`b600901`'s commit message and CHANGELOG entry before being caught.**

What was claimed: a live price feed would make
`evidence/livefire-2026-09-12/reconcile.mjs` yield a total other than $1.4257732 while still
exiting 0, so "the falsifier would stop falsifying without failing."

**That is false.** The reconciler reads `r.cost.usd` from persisted ledger rows (`:35`,
`:38`, `:40`). It never recomputes a price, so no upstream rate change can move its output.
The ledger's immutability already protects it — which is exactly the point the owner raised.

The correct argument is at WRITE time, not read time:

- A live feed makes the same call price differently depending on *when it was dispatched*,
  with **no record of which rate was in effect**. The receipt freezes a number whose
  derivation is then unrecoverable.
- A pinned, checked-in table means a receipt's figure can always be re-derived from its token
  counts and audited. That is what makes the number evidence rather than an assertion.
- Secondary and still real: a network fetch in the dispatch hot path is a latency and
  failure-mode cost paid on every call, to obtain data that changes monthly.

Immutability freezes whatever the feed happened to say; it does not make it reproducible.
So: pinned snapshot, CI-checked, never consulted at runtime.

---

## Finding (2026-09-12): compose's own writer stamps a REPORTED $0

Found while auditing what else had been asserted without tracing. **The defect fixed at the
stratum boundary this morning is still live on compose's own stream writer**, and the schema
comment that justified this morning's change names it as the reason the change was safe:
"Compose's own writer always sets cost_usd." It does — including when it does not know it.

Traced by reading (not yet by running):

1. `result-normalizer.js:750` deliberately OMITS `cost_usd` from `usages[0]` when the total is
   0. That omission is the honest "cost unknown" signal, and it is the whole point of the
   morning's work.
2. `build.js:5281` passes the merged `stepUsage` to `streamWriter.writeUsage(stepId, ...)`.
3. `build-stream-writer.js:149` writes `cost_usd: usage.cost_usd ?? 0` — **coercing the
   omission back into an explicit 0** — and writes no `usd_source` at all.
4. A consumer then applies the presence fallback added this morning
   (`result-normalizer.js:506`): `cost_usd` is present, so the step is labelled
   **`'reported'`**. An unknown cost has become a provider-reported $0.

**Reachability confirmed by reading:** the `toEngineUsage(stepUsage)` gate at `build.js:5271`
returns non-null when `tokens > 0` OR `usd > 0` OR `ms > 0` (`:2225-2227`), so a step with
tokens and no known cost passes it on the token branch alone. This is the same reachability
argument I got wrong three times today, so it is stated as read-verified and NOT as measured.

**Blast radius, bounded:** the routing ledger reads `usages` and connector evidence, not the
build stream (`routing-runtime.js:55` reads `u.usd ?? u.cost_usd ?? null`), and `usages[0]`
omits correctly. So receipts look safe and the observability surface (`COMP-OBS-COST`, the
cockpit via `server/build-stream-bridge.js:473`) is what can show a false reported $0.
**"Looks safe" is read-verified, not measured** — pin it with a test before trusting it.

A softer second instance on the same line: `build.js:5274` does
`buildCostTotals.cost_usd += stepUsage.cost_usd ?? 0`, so a build's cost total cannot
distinguish "this step was free" from "we do not know what this step cost". The total
silently undercounts rather than reporting itself incomplete.

**This contradicts Decision 4 as written** (live paths REFUSE and record `missing-usd`), so it
is in scope for S1: `writeUsage` must omit `cost_usd` when it has none and carry `usd_source`
through, and the build total must track an unknown-cost count.

### Untraced lead, recorded rather than guessed

`result-normalizer.js:514` writes `{ type: 'usage', ... }` while `build-stream-writer.js:147`
writes `{ type: 'step_usage', ... }`. A grep for `case 'usage'` / `.type === 'usage'` across
`lib/` and `server/` returns nothing, so the first event kind may be written and read by
nobody, or may be normalized somewhere not found. Not chased; do not act on it until traced.

---

## Trace (2026-09-12): the two untraced paths, followed value-first

Both traced by following the number from where it is set to where it is read, rather than
from the import graph. That method is what found all of this; the import graph is what hid it.

### Path B1 — receipts and the ledger: SAFE, and deliberately so

`reportUsageReceipts` (`build.js:2260`) **reads and never derives**, and it fails closed:
`:2280-2283` accepts `usd_source` only as a literal `'reported'|'estimated'` and **DELETES
`usd` from the receipt** when it is absent, rather than manufacturing provenance. `:2310`
stamps `detail: { costUnknown: true }` under a cost ceiling. A coerced 0 cannot reach a
receipt anyway, because `toEngineUsage` (`:2226`) only emits `usd` when `usd > 0`.

**This is the correct pattern and the model for everything below.** Decision 4's live-path
contract is already implemented here.

### Path B2 — the accumulator chain: five coercions ending in a false number

| Step | Site | What it does |
|---|---|---|
| 1 | `build.js:4341` | `usd = accumulatorUsage.cost_usd ?? accumulatorUsage.usd ?? 0` |
| 2 | `build.js:4347` | `usd: accumulator.usd + usd` — unknown adds 0, no incompleteness marker |
| 3 | `build.js:3749` | `buildCostTotals.cost_usd = selectedAccumulator.usd` |
| 4 | `build.js:5275` | `buildCostTotals.cost_usd += stepUsage.cost_usd ?? 0` |
| 5 | `build.js:3288`, `:6328` | written to the history record as `cost_usd` |

So `build-history.jsonl` **always carries a numeric `cost_usd`**, and an unknown-cost step is
indistinguishable from a free one.

**Consequence — `deriveUsd` is unreachable with non-zero inputs.**
`experiment-metrics.js:216` reads `typeof historyRecord?.cost_usd === 'number'` and takes that
branch whenever a history record exists — which is always, by the chain above. `deriveUsd`
runs only in the `else`, i.e. when there is no history record; and in that case its inputs
`tokensIn`/`tokensOut` come from the same absent record (`:206-207`, `?? 0`), so it is called
as `deriveUsd(model, 0, 0)` and returns 0.

**This corrects a claim made earlier in this same design.** The "2.58x over, still unfixed on
the historical path" figure was produced by calling `deriveUsd` directly with live-fire token
counts — inputs the real producer path can never deliver. That is the fake-producer pattern,
and making it while documenting a fix for the same class of error is the point worth keeping.
The arithmetic is real; the reachability was not checked. `deriveUsd`'s cache-blindness is
therefore a latent defect in dead code, NOT a live overcharge, and its priority drops
accordingly.

### Path A — the cockpit: never derives, but destroys provenance

No rate arithmetic anywhere in `src/` (the only `1_000_000` is a token humanizer in
`branchComparePanelLogic.js:16`). There is no sixth table. But the provenance is destroyed in
transit and the final render makes an affirmative false claim:

1. `server/build-stream-bridge.js:481` — `cost_usd: event.cost_usd ?? 0`, and the projected
   object **omits `usd_source` entirely**. Whatever the producer stated is discarded here.
2. `src/components/cockpit/ContextStepDetail.jsx:280` filters `allSteps.filter(s => s.cost_usd != null)`
   — the UI asks exactly the right question, and the bridge has already made it vacuous.
3. `formatCost` (`src/components/agent/MessageCard.jsx:40`) **already has the correct branch**:
   `if (usd == null) return ''`. It can never fire, because of 1.
4. `:42` — `if (usd < 0.001) return '<$0.001'`. So an unknown-cost step renders as
   **`<$0.001`**: an affirmative claim of near-zero spend for a call that may have cost
   dollars. Worse than a blank, and worse than `$0.00`.
5. The two surfaces disagree: `PastBuildsView.jsx:43` returns `null` for `usd <= 0` and renders
   nothing.

**Fix shape is small and already modelled by Path B1:** stop coercing at the bridge, carry
`usd_source` through the projection, and let `formatCost`'s existing null branch do its job.

### Scope consequence

The live-path work is the accumulator chain, the stream writer and the bridge — not
`experiment-pricing.js`, which is dead. S1 is re-ordered accordingly.

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

- [ ] `contracts/model-rates.schema.json` + data, ONE current rate set, with `_source` / `_changelog` / `_consumers`
- [ ] `priceCall(model, usage)` with `dialect` read from the rate row, never from a model-ID regex — no `at` parameter (Decision 1, amended)
- [ ] Exact-match-plus-explicit-alias lookup; first-prefix-wins removed, closing the `gpt-5` precedence defect
- [ ] `experiment-pricing.js` becomes a caller and stops being cache-blind (measured 2.58x over on the live-fire call)
- [ ] **`model-pricing.js`'s live path is REMOVED, not made a caller** — `calculateEventCost` and the Codex rows go with it; `result-normalizer.js` records `missing-usd` when a producer states no cost
- [ ] `KNOWN_DIVERGENT` retired — terra/sol reconciled to the single correct current rate, since nothing prices historically
- [ ] **Negative control:** the experiment path reproduces $0.17813775 on the live-fire call; reverting the dialect row restores the measured 2.58x
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
| `lib/model-rates.js` | new | `priceCall(model, usage)`; dialect as data, no dating |
| `lib/experiment-pricing.js` | existing | Becomes a caller; stops being cache-blind |
| `lib/model-pricing.js` | existing | **Live pricing path removed**; Codex rows and `calculateEventCost` deleted |
| `lib/result-normalizer.js` | existing | Records `missing-usd` rather than pricing tokens itself |
| `test/model-tiers.test.js` | existing | `KNOWN_DIVERGENT` retired; precedence control retargeted |
| `test/model-pricing.test.js` | existing | Rewritten against the dated pricer; live-fallback cases removed |
| `scripts/check-rate-freshness.mjs` | new | CI-only registry diff, stratum's table first |
| `stratum/ts/src/judge/pricing.ts` | existing (stratum) | **Unchanged**; becomes the authority for live Codex rates |

## Open Questions

1. **Does effective dating ever earn its place?** Deferred in the amended Decision 1 because
   nothing reprices today. It would become real if either appears: a requirement to re-derive
   a historical receipt's figure from its token counts for audit, or a consumer that reads old
   sandbox artifacts after a rate change. Neither exists. Add `from`/`until` to the rate rows
   then — additively, with a real caller.
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

- **2026-09-12, second amendment (same day).** Owner asked why anything would reprice months
  later given the ledger is immutable. It does not, and the ledger is. Two corrections, both
  found by that question. (a) Decision 1's effective dating was speculative: nothing in either
  repo reprices — the ledger only reads persisted `usd`, and `experiment-metrics.collect()`
  runs once inline at `lib/experiment.js:404`. Dating deferred to an open question; the pricer
  loses its `at` parameter. (b) Decision 3's ARGUMENT was wrong and had already shipped in
  `b600901`: `reconcile.mjs` reads persisted `cost.usd` and never recomputes, so an upstream
  price change cannot move its output. The conclusion (pin, never fetch live) stands on a
  corrected write-time argument: a live feed leaves no record of which rate priced a call, so
  the receipt's figure becomes unauditable. "Historical repricing" was also the wrong name for
  what `experiment-pricing.js` does — it prices records that never carried a cost, in the same
  run that produced them. No code changed.
