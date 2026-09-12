# S3 reachability probes — 2026-09-12

Both claims S3 rests on were READ-VERIFIED ONLY in design.md. Probed before building, per the
method note ("when a check does not fire, PROBE — do not reason about why"). Both probes trace the
value from set-site to read-site rather than asserting from the import graph.

## Probe 1 — is `deriveUsd` still dead AFTER S1? YES, and for a second independent reason.

The original "DEAD CODE" trace predated S1 and rested on `build-history.jsonl` always carrying a
numeric `cost_usd`. S1 rewrote that write path, so the claim had to be re-established.

**Set-site.** `build-history.jsonl` has exactly two write sites — `lib/build.js:3336` and
`:6438` (`grep -rn appendBuildHistory lib/ server/ bin/`). Both spread `...buildCostSnapshot()`
(`:3825`), whose `cost_usd` is `accumulator.usd`. `recordBuildUsage` (`:4457`) only ever does
`usd: accumulator.usd + usd` where `usd = statedUsd ?? 0`, and the v3 seed is `usd: 0`
(`:2754`). **`cost_usd` is therefore ALWAYS a finite number**, including when
`usd_unknown_count > 0` — S1 deliberately put unknown spend in the COUNTER, not in the amount.

**Read-site.** `lib/experiment-metrics.js:216` branches on
`typeof historyRecord?.cost_usd === 'number'`, so with a history record present it never reaches
`deriveUsd`.

**And the no-record case is dead too, independently.** `tokensIn`/`tokensOut` (`:206-207`) read
from the SAME absent record with `?? 0`, so the else branch calls `deriveUsd(model, 0, 0)`,
which returns `0`. There is no input under which the live path reaches `deriveUsd` with non-zero
tokens.

**Consequence:** `experiment-pricing.js` has no live consumer, so its `gpt-5` prefix defect
cannot misprice anything on any live path, and its cache-blindness stays latent. Building
`priceCall` for it would give the new pricer **zero live callers**.

## Probe 2 — does the `result-normalizer.js:504` fallback fire? Reachable, but it can only ever return 0.

**Codex.** `stratum/ts/src/connectors/codex.ts:492` emits `step_usage` WITH `cost_usd` +
`usd_source`, omitting both keys only when `usdFromTokens` yields 0 — i.e. the model is absent
from stratum's table. So the fallback is reached exactly for a model stratum cannot price.

**And compose cannot price it either.** Read directly today, both tables carry the identical
Codex key set — `{gpt-5.3-codex-spark, gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol, gpt-6-astra}` —
and the rates now agree (stratum `pricing.ts:28-32` carries terra 2/12 and sol 4/20, no longer
the stale 2.5/15 and 5/30 design.md recorded). So `calculateEventCost` returns 0 on every input
that can actually reach it.

**Claude never reaches it.** `stratum/ts/src/connectors/claude.ts:171` sets
`costUsd = finiteNonnegative(raw.total_cost_usd)` and emits `cost_usd: costUsd`
UNCONDITIONALLY; `lib/local-claude-connector.js:276` does the same. `m.cost_usd != null` always
holds for a Claude step, so the fallback is never taken on that path.

**Consequence:** the fallback's only live effect is the LABEL. An unpriceable step takes
`stepSource = 'estimated'` (`:505-507`), poisons `primaryUsdSource`, and adds 0 to
`usageTotals.cost_usd` — so a run mixing priced and unpriceable steps emits a sum that is SHORT
by the unknown step while calling itself an estimate. That is the "partial sum with a soft
label" S1 removed from the accumulator, still present one layer up. Removing the fallback is a
behaviour change on the LABEL only, never on an amount.

## What this does to S3 as filed

`contracts/model-rates.schema.json` + `priceCall(model, usage)` with dialect-as-data would ship
with no live caller: its two candidate consumers are dead code (Probe 1) and a fallback the same
slice deletes (Probe 2). That is the speculative generality this design's own amendments killed
twice (Decision 1's dating, Decision 2's shared table). Scope ruling owed from the owner.
