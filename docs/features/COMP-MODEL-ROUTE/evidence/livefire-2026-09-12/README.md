# LIVE-FIRE evidence — COMP-MODEL-ROUTE S1b gate 5 — 2026-09-12

Retained original ledger: `ledger.jsonl` (16 rows). Real providers, real spend, owner-authorized.

## Scenario

Throwaway repo (`node`, two genuinely failing tests) with two independent bugs in two
separately-ownable files, so the planner produced a parallel two-task wave:

- `src/stats.js` — `median` did not average the middle pair on even-length lists
- `src/text.js` — `truncate` was off by one on a string of exactly `max` length

Baseline before each run: 5 tests, 3 pass, 2 fail. After each run: **5/5 pass** — the agents
fixed both real bugs. Preset: fast tier (`claude::fast` = `claude-haiku-4-5-20251001`,
`codex::fast` = `gpt-5.3-codex-spark`), `_routing.mode = shadow`, `--cost-ceiling-usd 1.00`.

## Result — the fix is visible as a before/after inside ONE ledger

| Provenance | Completeness | Rows | Models |
|---|---|---|---|
| `reported` | complete | 10 | claude-haiku-4-5-20251001 |
| `estimated` | complete | 3 | gpt-5.3-codex-spark (rows 9, 10, 13) |
| `None` | incomplete | 3 | gpt-5.3-codex-spark (rows 1, 2, 5) |

Rows 1/2/5 were produced by the PRE-FIX connector: `usd: null`, `provenance: null`,
`reasons: [missing-cost-provenance, missing-usd]`. Rows 9/10/13 were produced after
stratum `00ff4db` + `npm run build`: complete, with amounts 0.073897 / 0.092173 / 0.178138
and provenance `estimated`. Zero `missing-usd` on any post-fix row.

Total attributed across all 16 rows: **$1.4258**.

## What this does and does not close

CLOSES: at least one complete attributable sample (many), on BOTH providers, from a real
provider run with original call/receipt/ledger evidence retained here.

DOES NOT close on its own: full complete-plus-excluded reconciliation against unique
receipt totals was not recomputed from this ledger. The run also produced no repair wave,
so uncredited/failed-repair exclusion paths are unexercised by this evidence. Treat gate 5
as SUBSTANTIALLY demonstrated, not ticked, until a reconciliation pass is run over
`ledger.jsonl` and recorded here.

## Root cause chain (all four were true, only the last unblocked it)

1. Codex reports NO cost — usage events carry token counts only. Confirmed against two real
   astra runs and externally (Codex CLI has no cost tracking; the feature request was closed
   without shipping).
2. `compose/lib/model-pricing.js` had zero `gpt-` entries. Fixed @`88d0601`. **Did not help** —
   the routing ledger reads RAW CONNECTOR evidence and never consults result-normalizer.
3. `ConnectorResult.usdSource` was typed `"reported"` only, so a connector could not express
   an estimate. Widened; `engine/state.ts:30` had always admitted `"estimated"`.
4. **`ts/dist` is gitignored and compose resolves the bin entries (`./dist/...`).** Editing
   `src` alone changed nothing. `npm run build` in `stratum/ts` is mandatory before any
   compose run can observe a connector change.
