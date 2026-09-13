# COMP-COST-OWNER: One owner for the cost number — Design

**Renamed from COMP-PRICING 2026-09-12.** Filed as a pricing problem; tracing proved pricing
is the small part and nearly solved. The defect is that nothing owns the number. The original
code is SUPERSEDED and the full investigation history is kept below, corrections included.

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

## Prior art (2026-09-12): ccusage already ships this design

Checked against the real package (`npm pack ccusage`, v20.0.20) and the live transcripts on
this machine, not from recall.

**VERIFIED here:**

- **Claude Code's own transcripts carry NO cost field.** Inspected
  `~/.claude/projects/-Users-ruze-reg-my-forge/*.jsonl`: the `usage` object is
  `{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
  output_tokens_details:{thinking_tokens}}` plus a sibling `model`. A grep for any
  `*[Cc]ost*` key returns nothing. So ccusage **must** compute from tokens — it has no
  reported figure to read.
- ccusage v20.0.20 is a native-binary launcher with **zero JS dependencies**; the pricing
  logic is compiled, so it cannot be read from the tarball.
- Its shipped README states the mechanism (lines 122, 184-186, 231-239):
  - `--mode display` — cost MODES exist as a user-facing flag
  - `--offline` — "use **pre-cached** pricing data without network connectivity"
  - "Custom Pricing Overrides: override token pricing per raw model name in `ccusage.json`"
  - "Cache Token Support: tracks and displays cache creation and cache read tokens separately"
  - "Nix builds **embed the LiteLLM pricing file** from the **locked** `litellm flake input`,
    so sandboxed builds **do not fetch pricing at build time**"
  - "Non-Nix Cargo builds read the same **locked LiteLLM revision** from `flake.lock`"
  - "The **scheduled `update pricing` workflow** runs the same update and validation, then
    **opens a PR** when the pricing snapshot changes"

**That is S3 as filed, already in production in a tool this project's owner uses:** a PINNED
registry snapshot, never fetched at runtime, refreshed by a scheduled job that opens a PR on
divergence. The design was arrived at independently; the convergence is corroboration, and it
retires any remaining doubt about taking that shape.

The cost MODES are also our `usd_source` under another name — reported versus computed — with
one decisive difference: **ccusage surfaces the distinction to the user as a flag, where we
destroy it at `build-stream-bridge.js:481`.**

**NOT verified (compiled binary, stated so rather than assumed):** the exact semantics of each
mode, and how it resolves the OpenAI/Anthropic cached-token dialect. Do not cite those
without checking the Rust source.

### The structural lesson, which is the real one

**ccusage proves pricing from tokens is tractable. Our problem was never pricing.** ccusage is
a READER: file to parse to report, one hop, with no opportunity to lose provenance. Ours is a
five-layer pipeline (connector, normalizer, accumulator, history, bridge, UI) with a `?? 0` at
nearly every hop. The defect is the plumbing, not the arithmetic.

### Follow-up worth more than the rest of this feature

**Those transcripts are an independent oracle we have never used.** Claude Code writes a
per-call token record, provider-side, outside compose entirely. A ccusage-shaped computation
over them is a cross-check on our own ledger that does not share a single line of code with
it. If our receipts say $X for a run and the transcript says $Y, that is a real falsifier —
the kind COMP-MODEL-ROUTE gate 5 currently lacks, since `reconcile.mjs` only checks our
numbers against themselves. Filed as a follow-up, not scoped here.

---

## Root cause (2026-09-12): it is not a pipeline, it is an uncoordinated fan-out

The `?? 0`s are the symptom. The cause is that **nothing owns the number.** One measurement at
the connector fans out to five independent running totals, each accumulating a different
subset of events, and nothing reconciles them.

| # | Total | Lives | Population | Fails closed? |
|---|---|---|---|---|
| 1 | `usageTotals` | `result-normalizer.js` | one step's dispatches | omits at 0 — yes |
| 2 | `accumulator.usd` | `.compose/data` sidecar, persisted | **all 9 `recordBuildUsage` sites** incl. every repair | no, `?? 0` |
| 3 | `buildCostTotals` | in-memory `build.js` | **main steps only — one site, `:5273-5275`** | no, `?? 0` |
| 4 | routing receipts | the ledger | per dispatch | **yes — strips unprovenanced usd** |
| 5 | stream events | `build-stream.jsonl` → cockpit | per step | no, `?? 0` twice |

### The measurable consequence: the same build costs two different amounts

`recordBuildUsage` is called from **nine** sites (`:4849`, `:4861`, `:4985`, `:5043`, `:5079`,
`:5270`, `:5276`, `:5815`, `:5827`) — main step plus every fix, revise, gate-fix and
error-carried usage. `buildCostTotals` is incremented from **exactly one** (`:5273-5275`), the
main step, gated on `toEngineUsage`.

So repair spend reaches total 2 and never total 3. But total 3 is **seeded from total 2** at
`:3746-3749` on every invocation, including resume. Therefore:

- **Fresh run:** `build-history.jsonl`'s `cost_usd` omits all repair spend.
- **Resumed run:** it inherits the repairs banked before the resume, then omits the ones after.

**The history record's cost therefore depends on whether the build was resumed**, for
identical work. READ-VERIFIED from the call sites; NOT measured by running a build — the
measurement is a build with a forced repair wave, read `cost_usd`, resume across the repair,
read it again.

Same line carries a second conflation: `:3748` seeds `output_tokens` from
`selectedAccumulator.tokens_total`, and `tokens_total` is `input + output` summed
(`recordBuildUsage:4334-4339`). After a resume, `output_tokens` starts at the combined total
while `input_tokens` starts at 0, so the history record's split is wrong.

### Why it got this way

Each sink arrived with a different feature — the stream with COMP-OBS-COST, the history record
with COMP-MODEL-AB, receipts and the ledger with COMP-MODEL-ROUTE, the sidecar with resume
support. Each needed "what did this build cost", none found an existing owner to read from,
and each built its own accumulator plus its own defensive `?? 0` against a shape it did not
own. **Five features needed one number and there was never a single owner of it.**

That is also exactly what ccusage gets for free by being a reader rather than a pipeline: one
hop, one total, nowhere to diverge.

### What this does to the feature

**COMP-PRICING is misnamed.** Pricing is the small part and is nearly solved: the registry
shape is settled, the receipt path is already correct, and the table duplication turned out to
be dead code. The real work is **ownership of the cost number** — one accumulator that
distinguishes known from unknown, that every sink READS rather than re-derives, with the
receipt path's fail-closed discipline as the model.

Renaming and re-slicing on that basis is an owner call; the finding is recorded either way.

---

## Decision 4: two different contracts for "unknown cost"

The same words mean opposite policies on the two paths, and the difference must be stated or
someone will "fix" one to match the other.

- **Live receipts are evidence.** No producer-stated cost means REFUSE: record `missing-usd`
  and never guess. An estimate that nobody asked for is indistinguishable downstream from a
  measurement.
- **Experiment metrics are analytics.** ~~No recorded cost means ESTIMATE at the record's own
  timestamp, labelled as an estimate.~~ **AMENDED by S3 (2026-09-12): the analytics path no
  longer estimates either, because nothing reaches it with tokens and no cost.** The estimator
  was deleted with `experiment-pricing.js`; `usd` is the history record's own number or `null`.
  This half was written assuming a record could arrive carrying tokens and no cost. Probe 1
  showed it cannot: with a record present `cost_usd` is always numeric, and with no record
  present the token inputs are 0 too. **Do not restore `deriveUsd` on the strength of the
  struck sentence** — that is precisely the "someone will fix one to match the other" this
  decision exists to prevent. Measured: the S3 negative control has the restored estimator
  pricing a call at `actual: 18` that no producer can deliver.

Deleting the live fallback (Decision 2) is what makes the first contract true. It is not a
loss of coverage: the fallback could not fire.

---

## Slices

Re-sliced 2026-09-12 around ownership. The old S1-S3 (contract, stratum drift test, freshness
check) survive as S3-S4 — they are real but secondary to the loss of the number in transit.

### S1 — One owner, and it distinguishes unknown from zero

The measured defect. `build-history.jsonl` is short $0.0367685 and 218,629 tokens against a
ledger and accumulator that agree to the cent.

- [x] The persisted accumulator is the sole owner, at v3 with `input_tokens` / `output_tokens` / `usd_unknown_count`; an unpriced step increments the counter and never adds 0 to `usd` (pinned by test/build-cost-owner.test.js:39)
- [x] `buildCostTotals` deleted; history, the crash path and the cumulative stream event all read `buildCostSnapshot()` (pinned by test/build-cost-owner.test.js:214)
- [x] The old `output_tokens`-seeded-from-`tokens_total` conflation is gone; a v2 record migrates to a NULL split rather than a fabricated one (pinned by test/build-cost-owner.test.js:87)
- [x] The receipt path (`build.js:2280-2283`) is UNCHANGED — verified by diff; it was already correct and is the reference
- [x] **Negative control PASSED:** `scripts/negative-control.sh --prod lib/build.js -- --test test/build-cost-owner.test.js` reports **RED**, 7 of 10 failing on revert against a 10/10 green baseline
- [x] An unpriced step reports `usd_unknown_count > 0` in the history row and does NOT invent spend (pinned by test/build-cost-owner.test.js:230)
- [x] **Measurement DONE.** Part A (`c9bd15a`, $7.77): resume seeding exact, three sources to the cent. Part B (2026-09-13, $0, by tracing, no build run): the resumed segment's spend IS recorded — in `dispatch-ledger.jsonl`, not `build-history.jsonl`. Two paths write the ledger and not history (`abortBuild` `:7745-7750`; `terminalizeThrownBuild`'s `!flowId` bail `:3365`); which one fired here is undetermined. See open question 0b and `evidence/part-b-abort-path-2026-09-13.md`
- [ ] **Not done in S1:** `usd_source` is still not carried ON the accumulator; only the unpriced COUNT is. Provenance of the aggregate is S2 territory

### S2 — Stop destroying provenance on the way to the screen

- [x] `writeUsage` omits `cost_usd` when no provenance can be stated, and carries `usd_source` when it can — the amount and its provenance travel together or not at all, the receipt path's rule applied to the stream (pinned by test/build-stream-usage-provenance.test.js:44)
- [x] `build-stream-bridge.js` stops coercing the cost and carries `usd_source`; tokens still default to 0 because a missing token count genuinely IS zero tokens (pinned by test/build-stream-usage-provenance.test.js:82)
- [x] `build.js` derives step provenance with `aggregateUsdSource` — sticky, unknown dominates, an unlabelled dollar refuses
- [x] FOUR formatters (not two) collapsed into `src/lib/format-cost.js`, which can finally say unknown; `ContextStepDetail`'s `$0.00`-for-unknown is gone (pinned by test/build-stream-usage-provenance.test.js:92)
- [x] `ContextStepDetail.jsx:280`'s `cost_usd != null` filter stops being vacuous, with no change to it — the bridge no longer destroys the answer it asks for
- [x] **Negative control PASSED:** both `lib/build-stream-writer.js` and `server/build-stream-bridge.js` go **RED** on revert (4 and 2 failures respectively) against a 10/10 green baseline

### S3 — No pricer. compose stops pricing anything.

**Re-scoped 2026-09-12 (third amendment) after both filed deliverables probed unreachable.**
The original checklist is kept below, struck, because which items dissolved is the finding.

- [x] **Probe 1:** `deriveUsd` is still dead after S1 — and for a second, independent reason.
      Both `appendBuildHistory` sites (`lib/build.js:3336`, `:6438`) spread
      `buildCostSnapshot()`, whose amount is the accumulator's `usd`, always a finite number
      because S1 routes unpriced spend to `usd_unknown_count`. And with NO history record the
      token inputs read from that same absent record via `?? 0`, so the fallback could only
      ever be called as `deriveUsd(model, 0, 0)`. No input reaches it with non-zero tokens.
- [x] **Probe 2:** the `result-normalizer.js` fallback is REACHABLE but could only ever return
      0. `codex.ts:492` omits `cost_usd` exactly when stratum cannot price the model, and both
      tables carried the identical Codex key set (rates now agreeing — stratum's terra/sol are
      no longer the stale 2.5/15 and 5/30 recorded earlier in this doc). Claude never reaches
      it at all: `claude.ts:171` and `local-claude-connector.js:276` emit `cost_usd`
      unconditionally.
- [x] Evidence: `evidence/s3-reachability-probes-2026-09-12.md`
- [x] Live consumer-side fallback removed (Decision 2) — and with it `lib/model-pricing.js`
      and `lib/experiment-pricing.js`, which had no remaining caller
- [x] An unpriced step is COUNTED, never priced: the primary usage record OMITS `cost_usd`,
      so `recordBuildUsage` counts it and `reportUsageReceipts` refuses to stamp provenance
      (pinned by `test/unpriced-step-cost.test.js`)
- [x] One unpriced step poisons the run total to unknown. Previously it added 0 and the run
      still called itself an estimate — a sum SHORT by that step, presented as the total.
      This was the last instance of the S1 defect, one layer up
- [x] The connector result's authoritative total is still adopted when some steps were
      unpriced — widened from "the events totalled 0", so deleting the fallback never LOSES a
      figure the connector actually knew
- [x] The prefix defect DISSOLVES rather than being fixed: stratum's lookup is exact after
      `baseModel()` strips `/effort`, with no `gpt-5` catch-all to fall through to
- [x] The "every routable model is priced" invariant RETARGETED at stratum's table via the
      test-only deep import this design blessed (`test/model-tiers.test.js`), plus a control
      that fails if either compose table comes back
- [x] **Negative control PASSED (run by hand):** the script reverts one production file at a
      time, which here would break an import and prove nothing — the deleted-file mirror of
      the new-file case its own header calls out. Reverting `lib/result-normalizer.js` AND
      restoring `lib/model-pricing.js` to HEAD reports **RED**, 3 of 5 failing against a 5/5
      green baseline
- [x] **Second negative control PASSED (run by hand):** restoring `lib/experiment-metrics.js`
      and `lib/experiment-pricing.js` to HEAD reports **RED**, 2 failing — `actual: 18` where
      the new contract requires `null`. That is the empirical half the original "2.58x" claim
      never had: the arithmetic WAS real, and no producer can reach it
- [x] Two existing assertions were FAKE-PRODUCER tests and were corrected, not weakened:
      `cost-tracking.test.js` asserted $0.0105 derived here from a Claude event carrying no
      cost, and `usage-receipts.test.js` asserted an `estimated` label on the same. No real
      Claude producer can emit that shape

~~Filed, now dissolved:~~ ~~`contracts/model-rates.schema.json` + one current rate set;
`priceCall(model, usage)` with `dialect` on the rate row; exact-match-plus-alias lookup.~~
**Not built.** Both candidate consumers were dead code (Probe 1) and a fallback the same
slice deletes (Probe 2), so the pricer would have shipped with zero live callers — the
speculative generality this design's own first two amendments already killed twice.

### S4 — Freshness check (now a STRATUM-side slice)

**S3 moved the ground under this.** compose no longer ships a price table, so there is nothing
here to keep fresh. The pinned snapshot to diff is `stratum/ts/src/judge/pricing.ts` and the
scheduled job belongs in that repo. Retarget before starting.

- [ ] Scheduled diff of the pinned snapshot against the LiteLLM registry; opens an item
- [ ] Never at runtime. ccusage ships exactly this shape — see the prior-art section
- [ ] Spark excluded by name with its reason recorded

### S5 — The independent oracle (optional, highest value per effort)

- [x] A ccusage-shaped computation over `~/.claude/projects/*.jsonl` cross-checking our ledger
      — **SHIPPED** as `scripts/cost-oracle.mjs` (`5b2d2e4`). Satisfied more strictly than
      filed: it invokes **ccusage itself** rather than reimplementing its shape, so no rate
      table re-enters compose.
- [x] Shares no code with the ledger, so it is a real external falsifier — which gate 5 lacks
      — calibrated against Claude Code's own `cost-state.totalCostUSD` before use (2.57%
      aggregate, n=160). Evidence:
      `evidence/s5-oracle-calibration-2026-09-13.md` (`729f213`).

**S5 found THREE flows where the ledger records less than the best available lower bound**
(0.28x, 0.60x, 0.92x) — corroborated by stratum's `flowSpent.usd`, a second independent
accounting path. The controlled repro RAN (`c9bd15a`): per-flow accounting is **exact** (three
sources agree to the cent across a kill and resume), so the loss happens when a run **dies
before its terminal write**, not because a resume computes a wrong number. The repro also
falsified the tool's own SUM-across-rows aggregation. See the evidence file's VERDICT.

**Sequencing: S1 → S2 → S3 → S4.** S1 and S2 are the measured defect and its user-visible
end; S3 and S4 are the original feature and can wait. S5 is independent of all of them.

---

## Files

**Rewritten 2026-09-12 to what S3 ACTUALLY did.** The filed rows named two new files that
were never built; leaving them would read as a plan outstanding rather than one retired.

| File | Action | Purpose |
|------|--------|---------|
| ~~`contracts/model-rates.schema.json`~~ | **not built** | Dissolved with the pricer — no live caller (Probe 1 + Probe 2) |
| ~~`lib/model-rates.js`~~ | **not built** | Same |
| `lib/experiment-pricing.js` | **DELETED** | Its only consumer was unreachable; the `gpt-5` prefix defect goes with it |
| `lib/model-pricing.js` | **DELETED** | Its only live caller was the fallback removed in the same slice |
| `test/model-pricing.test.js` | **DELETED** | Tested a deleted module |
| `lib/result-normalizer.js` | changed | Counts an unpriced step instead of pricing it; omits the cost rather than reporting a short total |
| `lib/experiment-metrics.js` | changed | `usd` is the record's own number or `null`; no token-derived fallback |
| `test/unpriced-step-cost.test.js` | new | Pins the above; negative control RED 3/5 |
| `test/model-tiers.test.js` | changed | `KNOWN_DIVERGENT` retired; the priced-model invariant retargeted at stratum via the test-only deep import |
| `test/experiment-model-ab.test.js` | changed | Pricing-table tests replaced by cost-axis behaviour tests; negative control RED |
| `test/cost-tracking.test.js`, `test/usage-receipts.test.js` | changed | Two FAKE-PRODUCER assertions corrected — both asserted a cost derived here from a Claude event carrying none, a shape no real producer emits |
| ~~`scripts/check-rate-freshness.mjs`~~ | **moves to stratum** | compose holds no table to keep fresh, so S4 is a stratum-side slice |
| `stratum/ts/src/judge/pricing.ts` | existing (stratum) | **Unchanged**; is now the ONLY table on any live path |
| `scripts/cost-oracle.mjs` | new (S5) | External falsifier. Shells to `ccusage`; **no rate table, no price arithmetic**. Oracle is a strict lower bound (main-source steps unjoinable) |

## Open Questions

0. **The history row drops the cache tokens the accumulator already has.** Found by S5:
   `input_tokens` is 0 on 9/9 `build-history` rows, and with 1h caching on, genuinely
   uncached input really is 1-3 tokens per turn — so the near-zero is not itself the bug.
   The bug is that **cache tokens, 95%+ of the billed input, have no field on the row at all.**
   **CORRECTED 2026-09-13 — the first trace named the wrong site.** `lib/build.js:2238-2246`
   is `failureUsageFields`, a per-error aggregation for repair failures, NOT the persisted
   accumulator; and `buildCostSnapshot` cannot drop what it never receives. The real loss is
   upstream, in **`recordBuildUsage`** (`lib/build.js:4412`): its `accumulatorUsage` reduce
   (`:4414-4419`) collapses each entry to `input_tokens`/`output_tokens`/`cost_usd`, and the
   `updateBuildAccumulator` call (`:4457-4467`) writes only `tokens_total`, `usd`,
   `input_tokens`, `output_tokens`, `usd_unknown_count`. **The persisted accumulator has no
   cache fields at all** — confirmed by dumping a live one, whose complete key set is
   `v, build_id, feature_code, last_terminal, review_iterations, escalations, files_changed,
   ship_files_changed, test_count, pass_rate, tests_attested, evidence_root, tokens_total,
   usd, input_tokens, output_tokens, usd_unknown_count`. So a fix is additive across four
   layers (reduce → accumulator → `buildCostSnapshot` → row), not a one-line copy.

   **RESOLVED 2026-09-13.** The row now carries `cache_read_tokens` and
   `cache_creation_tokens`. Three corrections to the plan filed above, each found by tracing
   rather than by reading:

   - **It was not additive — it needed a version bump.** The accumulator is strict-validated
     both ways (an unknown field AND a missing field are "corrupt", and `v` must match
     exactly), so adding two fields to a v3 record makes every in-flight sidecar on disk
     unreadable. `BUILD_ACCUMULATOR_VERSION` is now **4**, with a v3→v4 migration that sets
     both to **null** — a v3 record cannot recover its cache totals, and a 0 there would read
     downstream as a measured "nothing was cached", which on a real build is the opposite of
     the truth. Same reasoning, and same shape, as v2→v3's refusal to invent the input/output
     split. A rotation writes **0**, not null: a fresh record's cache total is a measured
     nothing.
   - **The aggregate `usage` object is the wrong source, and the first implementation used
     it.** Cache is summed per ENTRY, selected exactly as `unknownEntries` is — because in the
     non-event path `result-normalizer` fills the cache fields on the RECORD
     (`usageRecordFromRaw:306-310`) while `usageTotals` keeps the 0 it was seeded with at
     `:409-410`. Reading the aggregate reports **no caching on a fully cached build**. The
     existing comment beside `unknownEntries` warns about this exact trap ("same trap as
     `usd_source` riding `usages[0]`") and the first draft walked into it anyway; the
     end-to-end producer-path test is what caught it, not review. **The non-event path is the
     production path** — traced afterwards rather than assumed, because the first write-up
     asserted the blast radius without checking it: `usageTotals` is filled only by
     `step_usage` events (`:484-492`), and `:697-699` records that the TS `agent_run` route
     returns a synchronous envelope and streams NO `step_usage` events, while only the retired
     python/factory-shim route did. Post-cutover that is every real dispatch.
   - **A cache-ONLY usage is reachable, so it joins the write guard.** Settled by tracing, not
     assumed: `hasReportedUsage` (`result-normalizer:282-283`) returns true on cache tokens
     alone, so `usageRecordFromRaw` builds a record with `input_tokens: 0`,
     `output_tokens: 0` and a cache field, and `:521` already treats that case as real when
     counting an unpriced step. Without the guard term such a usage would be dropped silently.

   `tokens_total` still means input+output. Cache is billed at a different rate and the S1
   ledger/accumulator reconciliation depends on that field keeping its meaning — do not fold
   cache in. **Scoped out, deliberately:** the stream's `build_end` event still emits
   input/output/cost only (`build-stream-writer.js:218` cherry-picks rather than spreading, so
   it was unaffected); adding cache totals there is a schema change with no current reader.
   **Falsifier: `test/build-cost-owner.test.js` — "cache tokens reported by the producer reach
   the history row", which drives a connector usage record through the real normalizer,
   `recordBuildUsage` and the accumulator onto the row. Negative control RED against
   `lib/build.js`.**
0b. **RESOLVED 2026-09-13 (`c9bd15a`) — the controlled repro ran.** A build was killed
   mid-flight and resumed to completion in a scratch project. Three independent sources agree
   to the cent on the resumed row (transcripts $7.1940, stratum `flowSpent.usd` $7.1940315,
   ledger $7.194031), so resume seeding is correct and per-segment accounting is exact. The
   cause of the loss is relocated: a run that **dies before its terminal write** leaves its
   spend unrecorded.

   **PART B RESOLVED 2026-09-13 — by tracing, at $0, no build run, and it INVERTS the
   finding.** `13fd190e`'s resumed segment IS recorded — in `dispatch-ledger.jsonl`
   (`aborted`, **$4.5037144**, **36354** tokens, the same 36354 `project_strat_learn_cost`
   records as a three-way census PASS). What is missing is only its `build-history.jsonl`
   row. **S5 measured `build-history` and read a surface gap as a loss;** its "the ledger
   loses money" should be restated as a history-completeness gap. Same shape on four more
   build_ids, incl. `fbf89460` ($4.02 ledger row, **no history row at all**).
   **Money-not-lost is proven for `13fd190e` only** — the others are ledger > history, which
   is not the same as ledger ≈ truth.

   Mechanism: there are exactly two history writers (`:6543`, `:3379`), both in-process, so a
   mid-step death leaves no row; the ledger is written from `finalizeBuildAttempt`'s `finally`
   (`:3532`) and from `abortBuild` (`:7748`). **Two paths record to the ledger and not to
   history, and which one produced `13fd190e` is NOT determined:** `abortBuild`
   (`:7745-7750`) never calls `appendBuildHistory` at all (but the flow file still reads
   `status: running`, which argues against it here), and `terminalizeThrownBuild` bails at
   `if (!flowId) return false` (`:3365`, `flowId = response?.runId`) before both its
   active-build write and its history append, while the enclosing `finally` still emits the
   ledger actuals. Evidence: `evidence/part-b-abort-path-2026-09-13.md`.

   **Next: re-run `scripts/cost-oracle.mjs` against the ledger, not `build-history.jsonl`** —
   cheap but NOT free (ledger rows carry `build_id`, not `flowId`; legacy history rows carry
   no `accumulator_build_id`, so the join must be built). **Open question 0d must be
   recomputed and its direction is unknown** — the ledger figure for the paired build
   ($6.9342) is *further* from `flowSpent` ($4.0447) than the history row was, so the
   over-count may widen. **Do not add an `appendBuildHistory` call to `abortBuild` before
   that:** a third writer is the shape this design has replaced with a deletion three times;
   price "history becomes a read over the ledger" against it.

0c. **FIXED 2026-09-13 — rows now carry `accumulator_build_id`.** Group by
   `(flowId, accumulator_build_id)`, LAST within a group, SUM across groups.
   Written at all THREE `lastOwnerCost` sites (`lib/build.js:3820`, `:3833`, and the
   **rotation path `:3885`**, which zeroes the mirror and would otherwise silently drop the
   field exactly when a build auto-resumes). Auto-resume of a terminal flow rotates the
   accumulator (`:4151`) and that is CORRECT for the rule: a new lifetime is a new group.
   `scripts/cost-oracle.mjs` uses the exact rule when every row carries the field and keeps
   the conservative `max(sum, last)` fallback for legacy rows (all existing data). Negative
   control RED 3/3 against a 3/3 green baseline. **Original problem statement:**
   `build-history.jsonl` cannot be aggregated per flow. Rows are cumulative WITHIN one
   accumulator lifetime and disjoint ACROSS lifetimes (`clearBuildAccumulator`,
   `lib/build.js:2820`), and **no field on the row says which**. Proof that neither rule works:
   `44c575e7`'s row sum ($11.6007) exceeds its own flow's total spend ($4.0447), which is
   impossible; `4122e695`'s last row ($0.6974) is below its earlier row ($1.6045), so it
   cannot be a running total. Any consumer summing or last-picking is wrong somewhere.
   **Falsifier: add a field distinguishing the two, or document the rule.**
0d-1. **RESOLVED 2026-09-13 — `runBuild` has an explicit terminal result.** Was: a failed
   build exits 0, and the obvious fix is INERT. `bin/compose.js:2885` read
   `result?.ok === false`, but `runBuild()` never returned that on a terminal failure — it
   wrote the failed history row, printed "Build failed", and fell through its cleanup blocks
   resolving `undefined`. Dropping the `abort &&` guard was therefore inert; it was tried,
   caught by an integration test (`0 !== 1`), and reverted rather than shipped as a dead path.
   **Fix:** `runBuild` now returns
   `{ ok, status, featureCode, flowId, failureReason }` as the last statement of its inner
   `try`, assembled beside the `build-history.jsonl` append so it shares that row's already
   computed `failureReason` and is read AFTER the health gate may have downgraded the build.
   A build that THROWS still rejects; this is the contract for terminal states the loop
   reaches without throwing, and it matches the shape `abortBuild` already returned. The three
   CLI exit sites (`build`, `fix`, `plan`) dropped their `abort &&` guard.
   **`ok` is true ONLY for `status === 'complete'`** — `killed` (the gate rejected the work)
   and `aborted` (the flow was cancelled) did not ship, so a caller gating CI on this must see
   them as failures. Do not re-litigate that to "any terminal state".
   **Falsifier: `test/build-exit-code.test.js`** drives the real CLI to a real process exit
   code with a loader stub at the `lib/build.js` boundary; negative control RED against
   `bin/compose.js`. The subtle case — flow completed, health gate downgraded, so `ok:false`
   — is pinned in `test/dispatch-build.test.js` (RED against `lib/build.js`).
0d-2. **RESOLVED 2026-09-13 — batch builds no longer count a failure as built.**
   `lib/build-all.js:128` counted every resolved result as success, including `{ok:false}`.
   It now branches on `ok`. Consequence worth stating: because a failure lands in `failed`,
   it also **blocks its dependents**, which same-phase roadmap entries implicitly are —
   previously a failed feature was reported as built and its dependents ran on top of it.
   Falsifier: `test/build-exit-code.test.js` drives the real `runBuildAll`; negative control
   RED against `lib/build-all.js`.
0d. **Unexplained ~8% over-count on `44c575e7`.** Its last row ($4.3556) sits 7.7% above two
   independent sources that agree with each other ($4.0316 ccusage, $4.0447 `flowSpent`).
   Outside the 5% tolerance and not accounted for by the summing bug.
0e. **A retried step cannot satisfy the contract if the failed attempt already committed.**
   Not a cost defect; found during the repro. `explore_design` attempt 1 returned an invalid
   `outcome: "success"` but HAD committed (`ffab7f2`); attempt 2 returned a valid outcome with
   `commit_hash: null` because nothing was left to commit, and the strict contract rejects the
   null, failing the whole flow terminally. Evidence:
   `evidence/s5-oracle-calibration-2026-09-13.md` run log. (The second half of that
   observation — `compose build` exits **0** while printing "Build failed." — was split out as
   `0d-1` and is RESOLVED; the contract half below is what remains open.)"
1. **Does effective dating ever earn its place?** Deferred in the amended Decision 1 because
   nothing reprices today. It would become real if either appears: a requirement to re-derive
   a historical receipt's figure from its token counts for audit, or a consumer that reads old
   sandbox artifacts after a rate change. Neither exists. Add `from`/`until` to the rate rows
   then — additively, with a real caller.
2. **Does removing the live fallback need a deprecation interval?** It cannot fire today, but
   that rests on the two key sets being identical. If stratum ever prices a model compose does
   not, nothing changes; the reverse is what the S2 test now catches.
3. **stratum's Claude connector can still stamp a REPORTED $0.** `claude.ts:171` does
   `costUsd = finiteNonnegative(raw.total_cost_usd)` and emits `cost_usd: costUsd`
   UNCONDITIONALLY, so an SDK turn omitting `total_cost_usd` becomes a provider-reported $0 —
   the defect S2 fixed on compose's own stream writer, still live one repo over. Found while
   running S3's Probe 2; it is WHY the fallback is unreachable for Claude. Out of scope here
   (stratum-side) and it needs a measurement first: does the SDK ever actually omit the field?
   Falsifier: `stratum/ts/src/connectors/claude.ts:171`.
4. **The bare `type: 'usage'` stream event is WRITE-ONLY.** Traced 2026-09-12, closing the
   "untraced lead" recorded earlier in this doc: `lib/result-normalizer.js:526` is its only
   writer, nothing in `lib/`, `server/` or `src/` reads it, and `lib/build-stream-schema.js`
   does not define it, so `BuildStreamWriter` never validates it. S3 changed it to omit an
   unstated cost for consistency with `writeUsage`; that change is inert either way. Either
   give it a reader or delete it — it is currently neither.
5. **Spark's cache rate stays inferred.** Both its 1.75/14 and its 0.175 cache rate have no
   external source. S3 cannot check it. Recorded, not solved.

---

## Amendment history

- **2026-09-12, third amendment (same day).** S3 inverted from "build one pricer" to "delete
  the pricing". Both claims it rested on were read-verified only, so both were probed before
  any code was written; both came back against the filed plan (see the S3 slice and
  `evidence/s3-reachability-probes-2026-09-12.md`). compose now prices nothing at all: every
  producer states its own cost, stratum is the sole authority for the one case that needs a
  table, and `lib/model-pricing.js` + `lib/experiment-pricing.js` are gone. This is the THIRD
  time this design has replaced a build with a deletion after tracing reachability — Decision
  1's effective dating, Decision 2's shared table, now S3's pricer. The pattern is worth
  naming: each was justified by a defect that was real in the arithmetic and unreachable on
  the value path. The one live defect the slice DID fix was found the same way, and was not
  about pricing at all — an unpriced step made the run total short while still labelling
  itself an estimate.


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
