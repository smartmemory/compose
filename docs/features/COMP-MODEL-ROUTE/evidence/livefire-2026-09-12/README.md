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

## Reconciliation (added 2026-09-12, after the run)

`node reconcile.mjs` re-derives every claim below from `ledger.jsonl` and **exits non-zero if any
invariant fails**, so this section is checkable in one command rather than asserted:

```
rows                 16
complete / excluded  13 / 3  (exhaustive, disjoint)
receipt refs         16 total, 16 unique digests, 1 per row
exclusion reasons    missing-cost-provenance, missing-usd
excluded usd         null (never 0)
reported             n=10  $1.0815650
estimated            n=3   $0.3442082
TOTAL ATTRIBUTED     $1.4257732
```

Invariants checked: the partition is exhaustive AND disjoint; every paid receipt ref is unique by
both `payloadDigest` and `dispatchId` (so no row can double-count another's receipt); every row
carries exactly one receipt ref; excluded rows contribute nothing and keep `usd: null` rather than
a coerced 0; and the sum over complete rows equals the sum over all non-null `usd` in the file.

The script is a genuine falsifier, verified by tampering: duplicating one row's `payloadDigest`
onto another exits 1 with `duplicate payloadDigest — double-count possible`, and flipping one
excluded row's `usd` from `null` to `0.0` exits 1 with `an excluded row carries a non-null usd`.

**Row numbering note:** the "Result" table above refers to rows by ZERO-based index. Its rows
1/2/5 are file lines 2/3/6, and rows 9/10/13 are lines 10/11/14. Verified against the file.

## What this does and does not close

CLOSES: at least one complete attributable sample (many), on BOTH providers, from a real
provider run with original call/receipt/ledger evidence retained here.

DOES NOT close on its own: full complete-plus-excluded reconciliation against unique
receipt totals was not recomputed from this ledger. The run also produced no repair wave,
so uncredited/failed-repair exclusion paths are unexercised by this evidence. The reconciliation pass is now DONE and recorded above (`reconcile.mjs`, all invariants hold), so
that half of the outstanding work is closed. The repair-wave gap is NOT closed and cannot be closed
by this ledger: the run produced no repair wave, so the uncredited and failed-repair exclusion paths
have no evidence here either way. Closing it needs a run that actually produces a repair wave.

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
