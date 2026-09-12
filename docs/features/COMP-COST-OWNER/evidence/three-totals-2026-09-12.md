# Three totals, one run — measured 2026-09-12

Source: the retained COMP-MODEL-ROUTE live-fire run (`lf1`), real models, real spend.
Ledger figures from the committed
`docs/features/COMP-MODEL-ROUTE/evidence/livefire-2026-09-12/ledger.jsonl` (16 rows,
13 with non-null `cost.usd`). History and accumulator figures read from that run's
`.compose/data/`.

This is MEASURED on a real run, not read-verified.

## Result

| Total | Value | Delta vs ledger |
|---|---|---|
| Ledger receipts (13 non-null rows) | **$1.4257732** | — |
| Accumulators (`STATS-1` + `STATS-2`) | **$1.4257732** | **+0.0000000000** |
| `build-history.jsonl` (3 rows) | **$1.38900475** | **-0.0367684500** |

| Tokens | Value |
|---|---|
| Accumulator `tokens_total` | 808,002 |
| `build-history` input+output | 589,373 |
| **Missing from history** | **218,629 (27.1%)** |

**Two of the three agree to the cent. `build-history.jsonl` is the outlier**, short by
$0.0367685 (2.6% of spend) and 218,629 tokens (27.1%).

## Raw

```
build-accumulator/STATS-1.json   usd 0.5410395000000001   tokens_total 352394
build-accumulator/STATS-2.json   usd 0.8847336999999998   tokens_total 455608

build-history.jsonl (feature_code is null on all three rows)
  {status: failed, cost_usd: 0.129302,           input 52,     output 1966}
  {status: failed, cost_usd: 0.5410395000000001, input 114195, output 238199}
  {status: failed, cost_usd: 0.7186632499999999, input 216683, output 18278}
```

## What it confirms

The structural claim in the design's root-cause section: `accumulator.usd` is fed by all
nine `recordBuildUsage` sites while `buildCostTotals` — which becomes the history record's
`cost_usd` — is incremented from exactly one (`build.js:5273-5275`, the main step, gated on
`toEngineUsage`). Spend recorded through any of the seven fix / revise / gate-fix /
error-carried sites reaches the accumulator and the ledger, and never reaches history.

The accumulator matching the ledger EXACTLY is the strongest part of this result: it shows
the measurement itself is sound end to end, and that the loss is specific to the
history-record path rather than to pricing.

## Not established here

- **Which** of the seven non-main sites contributed the $0.0367685. The run ended `failed`,
  so an error-carried usage (`:4861`, `:5079`, `:5827`) is plausible but unverified.
- Row-to-feature pairing. `feature_code` is null on every history row; the pairing of row 2
  to `STATS-1` is inferred from its cost matching that accumulator exactly. The aggregate
  comparison above needs no pairing and does not depend on it.
- The resume half of the claim (that a resumed build inherits pre-resume repairs and so
  reports a different total than the same work unresumed). This run had no resume. Still
  read-verified only; needs a build with a forced repair wave, read `cost_usd`, resume
  across the repair, read again.
