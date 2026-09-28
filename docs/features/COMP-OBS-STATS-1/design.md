# COMP-OBS-STATS-1: Usage statistics page — Design

**Status:** DESIGN
**Date:** 2026-09-28
**Reviewed:** Codex `gpt-6-sol/high`, 2026-09-28 — 4 findings upheld, all incorporated.
The substrate decision below is the reverse of this doc's first draft; see "Correction".
**Reference:** Claude Code's own "Usage statistics" page, supplied by the owner as the
shape to aim at (KPI tile grid, period comparison, stacked day-bucketed bar chart,
by-model breakdown table).

## Related Documents

- ROADMAP row: `COMP-OBS-STATS-1` (phase "COMP-OBS-STATS: Usage statistics")
- Parent: [COMP-OBS-COST-4](../COMP-OBS-COST-4/feature.json) — per-step cost table in the context panel
- [COMP-COST-OWNER design](../COMP-COST-OWNER/design.md) — owns the cost number this page reads
- `COMP-COST-OWNER-1` — BLOCKED; the reason `usd_unknown_count` can be nonzero
- **Prior art this feature extends:** `lib/dispatch-metrics.js` (`collectDispatchMetrics`, line 99) and the `compose metrics` command (`bin/compose.js:4338`)

---

## Problem

Compose can tell you what **one build** cost, and it can print a cost table **in the
terminal**. It has no view of what **last month** cost.

`COMP-OBS-COST-1..4` are COMPLETE and ship per-step tokens and cost in the audit record,
`cost_usd` on `build_step_done`, a running total in the ops strip, and a sortable
per-step table in the context panel. Every one is scoped to a single build and
disappears when you leave it.

## Correction: this design initially named the wrong substrate

The first draft of this doc proposed aggregating `.compose/data/build-history.jsonl`, and
stated that a by-model breakdown was "not implementable" because history drops the model
id. **Both halves were wrong**, and review caught it:

- Compose already aggregates across builds. `collectDispatchMetrics`
  (`lib/dispatch-metrics.js:99`) reads the **dispatch ledger** via `readEvents`
  (`lib/dispatch-ledger.js`), buckets by `model` × `effort_executed`, buckets by `site`,
  totals USD, and takes `since` and `feature` filters. It is exposed as
  `compose metrics [--since] [--feature] [--json]` (`bin/compose.js:4338`).
- The ledger carries the model id per dispatch, so the by-model table is not blocked at all.

Building a second aggregator over a weaker substrate would have been the mistake this
codebase already has a name for. **The page is a UI over an extended
`collectDispatchMetrics`, not a new rollup.**

## Substrate — verified on disk 2026-09-28

Two files, and the design needs both. Neither alone is sufficient.

### `.compose/data/dispatch-ledger.jsonl` — the primary source

162 rows, of which **76 `dispatch`**, 63 `settlement`, 22 `build-actuals`, 1
`triage-estimate`. Dispatch rows span 2026-08-18 to 2026-09-19 and carry:

| field | notes |
|---|---|
| `ts` | ISO 8601. The bucketing key. |
| `model` | **8 distinct values in the live sample** — `claude-sonnet-4-6` (54), `claude-sonnet-5` (8), `claude-haiku-4-5-20251001` (3), `gpt-6-astra` (3), `gpt-5.6-terra` (2), `gpt-5.4` (1), `claude-test` (1), and **`null` (4)** |
| `effort_intended` / `effort_executed` | the second breakdown axis `collectDispatchMetrics` already uses |
| `agent`, `site`, `step_id`, `feature_code`, `build_id` | `site` ∈ {build-step 38, consumer 26, unattributed 8, review-repair 2, review 2} |
| `tokens_in` / `tokens_out` / `tokens_total` | |
| `usd`, `usd_source` | **`usd_source` is absent on 54 of 76 dispatches**; present and `"reported"` on 22 |
| `duration_ms`, `outcome`, `attempt` | `attempt` makes retry cost visible |

**No cache fields.** `cache_read_tokens` / `cache_creation_tokens` do not appear on any
dispatch row.

### `.compose/data/build-history.jsonl` — the join partner

16 records, 2026-08-15 to 2026-09-19, written by `appendBuildHistory`
(`lib/build-history.js:24`), read by `readBuildHistory` (`lib/build-history.js:41`) and
served at `server/build-routes.js:54` with a **`limit` defaulting to 50**.

It contributes exactly two things the ledger lacks: **`cache_read_tokens` /
`cache_creation_tokens`**, and **build-level outcome** (`status`, `mode`, `failureReason`).
Its `steps[]` (`projectHistorySteps`, `lib/build-history.js:89`) carries only
`{id, status, agent, durationMs}` plus `summary` on a failed step — no model, no tokens,
no cost. It is the weaker source and is used only for what the ledger cannot supply.

`build_id` joins the two.

### Three facts from the live sample that shape the tiles

1. **Provenance is mostly unknown, not merely estimated.** 54/76 dispatches and 9/16
   build records have **no `usd_source` field at all**. A design that only distinguishes
   `reported` from `estimated` will render the majority of history as if it were measured.
2. **All 16 build records are terminal-unhappy** — `failed`, `aborted`, `killed`, with no
   successful build in the file. Any tile with a success count in its denominator divides
   by zero on this data.
3. **`model` is `null` on 4 dispatches.** The by-model table needs an explicit Unknown row,
   not a dropped row — dropping it would make the column totals disagree with the tiles.

## Design

### What the page is

A new top-level view, `UsageView.jsx`, alongside the existing
`src/components/vision/*View.jsx` family. Five bands, mirroring the reference:

1. **Header** — title, "Updated <time>", refresh.
2. **Controls** — range (Last 7 / 30 / 90 days, All), prev/next arrows, resolved span,
   filters, **Compare** toggle.
3. **KPI tile grid** — label, info tooltip stating the derivation, value, and (Compare on)
   the delta versus the immediately preceding window of equal length.
4. **Usage over time** — stacked day buckets, `Cost | Tokens` × `By model | By site` toggles.
5. **Breakdown table** — one row per model: name, cost, tokens, share, dispatch count,
   with a share bar. Plus an explicit **Unknown** row.

### The tiles

| Tile | Derivation | Source | Available? |
|---|---|---|---|
| Total cost | `Σ usd` over dispatches in range | ledger | ✅ |
| Total tokens | `Σ tokens_total` | ledger | ✅ |
| Output tokens | `Σ tokens_out` | ledger | ✅ |
| Dispatches | count | ledger | ✅ |
| Active days | distinct `ts` dates | ledger | ✅ |
| Cache hit rate | `cache_read / (cache_read + input)` | **history only** | ⚠️ build-level, cannot be attributed to a model |
| Retry cost | `Σ usd where attempt > 1` | ledger | ✅ — Compose-specific, has no analogue in the reference, and is the tile most likely to change behaviour |
| Wasted spend | `Σ usd` on builds whose `status` ∈ {failed, aborted, killed} | join | ✅ |

**Cut from slice 1:** "Net cache savings". It requires repricing cache-read tokens at the
full input rate, and **`lib/model-pricing.js` does not exist** — it was removed, and
`COMP-COST-OWNER/design.md:599` records that the live pricing table now lives in Stratum.
Reaching across into Stratum's pricer to synthesise a number is exactly the seam where a
2.76x error once hid. Not in this slice.

**Cut from slice 1:** "Cost per shipped feature". Zero successful builds in the live
sample means zero denominator; the tile would ship reading `∞` or `—` on the only data
available to test it.

### Provenance has three states, not two

`COMP-COST-OWNER` exists because five running totals once disagreed with nothing
reconciling them, and because an estimate was silently relabelled as a provider number.
With 54/76 rows carrying no provenance at all, the rule is:

| `usd_source` | render | tooltip |
|---|---|---|
| `"reported"` | `$X` | — |
| `"estimated"` | `~$X est.` | how many of N were estimated |
| **absent** | `~$X` + **unknown-provenance marker** | how many of N have no provenance record |

A range whose records include `usd_unknown_count > 0` additionally shows a "cost
incomplete" marker — `COMP-COST-OWNER-1` is BLOCKED, so this is live, not theoretical.

Records lacking `cache_read_tokens` are **excluded from the cache-rate denominator**, and
the excluded count is stated. Counting a missing field as a zero hit is how a cache tile lies.

### Decisions

**D1 — Extend `collectDispatchMetrics`; do not write a second aggregator.**
It already does model × effort × site bucketing with a `since` filter. What it lacks is
day bucketing, a `to` bound, and the history join. Add those there, so `compose metrics`
and the page can never disagree. *(Reversed from this doc's first draft, which proposed a
history-based aggregator. See "Correction".)*

**D2 — The ledger is primary; history is joined in for cache tokens and build outcome only.**
Consequence: cache metrics are **build-level and cannot be split by model**. The cache
tile must say so rather than implying a per-model figure it cannot compute.

**D3 — Hand-rolled SVG, no new dependency.**
`package.json` has no `chart`/`recharts`/`d3`/`visx`/`plot` dependency. A day-bucketed
stacked bar chart with two toggles is ~150 lines of SVG. Recharts adds ~500KB to a
local-first app that must render offline — the constraint that drove self-hosting Inter
in `bdf5c2d` rather than using a CDN. Revisit if a second chart lands.

**D4 — New route, not an extension of the builds route.**
`server/build-routes.js:54` is `limit`-bounded at 50 and returns raw records. The stats
endpoint takes a date range and returns aggregates. Do not overload the existing route.

### Open questions for the owner

- **Q1 — One workspace or all?** The reference has an "All projects" filter. Compose's
  ledger is per-workspace (`.compose/data/` under each root); `get_workspace` lists 5
  here. Recommend **current workspace only** for slice 1.
- **Q2 — Does "cost" mean Compose-dispatched spend only?** The ledger records dispatches
  Compose made. Spend from a Claude Code session you drove by hand is invisible. The page
  will understate real spend and should say so in the header rather than imply a complete
  ledger.
- **Q3 — Is 54/76-unknown provenance worth fixing first?** If most of history has no
  provenance, the page's headline number carries a permanent qualifier. Backfilling is
  impossible; the question is whether `COMP-COST-OWNER-1` should unblock before this
  ships, or whether a heavily-qualified page is still worth having now.

### Slices

- **COMP-OBS-STATS-1** (this): day/`to` bucketing + history join in
  `lib/dispatch-metrics.js`; `GET /api/usage/stats`; `UsageView` with tiles, chart, and
  by-model table. Current workspace. No cache-savings tile, no cost-per-feature tile.
- **COMP-OBS-STATS-2**: emit `usd_source` on every dispatch so provenance stops being
  absent going forward. Forward-only; does not repair existing rows. *(Replaces the first
  draft's slice 2, which proposed persisting `model` into build history — unnecessary,
  the ledger already has it.)*
- **COMP-OBS-STATS-3**: cache-savings tile, once a pricing owner is settled post-`model-pricing.js`.
- **COMP-OBS-STATS-4**: cross-workspace aggregation, if Q1 returns "all projects".

### Acceptance criteria (slice 1)

- [ ] `collectDispatchMetrics` gains day bucketing and a `to` bound; `compose metrics`
      output is unchanged for existing flags
- [ ] `GET /api/usage/stats?from=<iso>&to=<iso>` returns tiles, day buckets and model rows
      with no limit truncation
- [ ] Dispatches are filtered by `ts`, builds joined by `build_id`
- [ ] Dispatches with `model: null` appear as a single **Unknown** row whose cost is
      included in the tile totals
- [ ] Response reports three provenance populations separately: `reported`, `estimated`,
      and **absent**
- [ ] A range containing `usd_unknown_count > 0` is marked incomplete
- [ ] Records lacking `cache_read_tokens` are excluded from the cache-rate denominator,
      not coerced to zero, and the excluded count is in the response
- [ ] Cache metrics are labelled build-level and are **not** broken down by model
- [ ] Compare mode returns the same shape for the preceding window of equal length
- [ ] `UsageView.jsx` renders tiles, chart and table; empty ledger renders an empty state,
      not a row of zeros
- [ ] Chart bucketing is by local calendar day and renders zero-dispatch days
- [ ] Tests cover: empty ledger, malformed line, `model: null`, absent `usd_source`,
      missing cache fields, a range boundary, a zero-dispatch day, and a build with zero
      successful outcomes
