# Part B — resolved by tracing + existing data. Cost: $0. No build run.

**2026-09-13.** Owed item 0b Part B was "kill the RESUME mid-flight and confirm no row
appears — that is `13fd190e`'s exact shape." It did not need a build. The answer is on disk
already, and it **inverts the finding it was meant to confirm**.

## Result

**The money was not lost.** `13fd190e`'s resumed segment is recorded in
`dispatch-ledger.jsonl`. What is missing is its `build-history.jsonl` row. S5 measured
`build-history` and read a surface gap as a loss.

## The measurement — `13fd190e` / COMP-SEMVER-STRICT

`build-history.jsonl` holds **one** row for this flow. `dispatch-ledger.jsonl` holds **two**
terminal `build-actuals` rows under the same `build_id` (`1db4350e`):

| Source | ts | status | usd | tokens |
|---|---|---|---|---|
| history **and** ledger | 06:57:04 | `failed` | **$1.8406624** | 5663 |
| ledger **only** | 07:03:56 | `aborted` | **$4.5037144** | **36354** |

The resumed segment's cumulative spend was recorded all along. The `36354` is independently
corroborated: it is the same figure `project_strat_learn_cost` records as a three-way census
PASS (`36354/36354/36354`) on this exact flow.

## It generalises — COMP-GUARD-CLAIM-1

Ledger `build-actuals` vs the last history row. **Caveat: legacy history rows carry no
`accumulator_build_id`** (that field shipped in `10f46ea`), so history rows were matched to
ledger `build_id`s by cost and timing, not by a key. Treat the pairings as indicative.

| build_id | ledger final | history last row | history holds |
|---|---|---|---|
| `f9309dc4` | $18.9300601 (failed, 182860 tok) | $2.4726621 | 13% |
| `678e6a58` | $6.9341944 (aborted, 44562 tok) | $4.35561315 | 63% |
| `fbf89460` | $4.0245687 (aborted, 77205 tok) | **no row at all** | 0% |
| `3e95eb77` | $0.6973779 (aborted) | $0.6973779 | agrees |

`fbf89460` is the cleanest: a terminal build with a full ledger row and no history row at all.
An earlier build on the other flow (`ac5547aa`, 06:51:39, `aborted`, usd 0) is a fifth
instance of the same shape.

## Trace — there are exactly two history writers, both in-process

`grep -rn appendBuildHistory` over the repo (excluding tests/docs) returns two call sites,
both in `lib/build.js`:

| Site | Function | Writes on |
|---|---|---|
| `:6543` | the normal terminal | `complete`, `aborted`, `failed`, `killed` |
| `:3379` | `terminalizeThrownBuild` (`:3346`) | the throw path, guarded by `historyWritten` and by `if (!flowId) return false` (`:3365`) |

Nothing else appends a row: no startup reconciler, no server route, no recovery pass.
`decideBuildStart` (`:2959`) only decides. So a process killed mid-step reaches neither
writer and leaves no row — certain from the writer set, not inferred from shape.

The ledger, by contrast, is written from `finalizeBuildAttempt`'s `finally` (`:3532`) and
from `abortBuild` (`:7748`). **That asymmetry is the defect class: paths that record to the
ledger but not to history.**

## Two such paths exist. Which one produced `13fd190e` is NOT determined.

> **RESOLVED 2026-09-14: `abortBuild`.** The session transcript records the `--abort` command at
> 07:03:52 and "Build aborted." at 07:03:56.601; the ledger row is stamped 07:03:56.455. The
> "`status: running` argues against it" point below is UNSOUND for this event: the
> settle-before-write guard arrived in `d0a07c1` (2026-09-10), six weeks after the build.
> Candidate 2 is eliminated by the persisted `build_resume` event carrying `runId`. See
> `evidence/13fd190e-writer-attributed-2026-09-14.md`. Text below kept as written.

Stated honestly because the first draft of this document asserted `abortBuild` and the
evidence does not support a unique attribution.

1. **`abortBuild` (`lib/build.js:7745-7750`)** stamps `active-build.json` terminal, reads the
   surviving accumulator, emits a `build-actuals` ledger row, and **never calls
   `appendBuildHistory`** — then `emitBuildActuals` `clearBuildAccumulator`s on `aborted`, so
   the row can never be reconstructed afterwards. A real gap on its own terms.
   **Evidence against it for this flow:** `~/.stratum/ts/flows/13fd190e-*.json` still reads
   `status: running`. `abortBuild` reaches `:7745` only after `cancelAbortFlow` reports the
   flow settled, and an unreachable stratum returns `refuse('transport')` long before it.
2. **`terminalizeThrownBuild` bailing at `:3365`.** `const flowId = response?.runId ?? null;
   if (!flowId) return false;` runs *before* both the `active-build` write and the history
   append. `response` is `let`-declared at `:3838` and only assigned at `:4175`
   (`stratum.resume`), so a throw during a resume before that call leaves it undefined. The
   enclosing `finally` still runs `finalizeBuildAttempt` (`:6671`/`:6709`), which emits the
   ledger actuals — `aborted` whenever `buildCancel.teardown || buildCancel.cancelled`
   (`:3497`). Ledger row, no history row.

**Checked and withdrawn:** the tempting claim that a stable run-wide `flowId` is in scope at
the call site and simply not passed. There is no such variable — every `flowId` in `runBuild`
is block-scoped and derived from `response` (`:4226`, `:4872`). Asserting it would have been
the shape-not-trace error this design keeps paying for.

## What this changes

- **S5's "the ledger loses money when a run dies before its terminal write" is wrong in its
  strong form** and should be restated as a `build-history` completeness gap.
- **The oracle is pointed at the wrong surface.** `scripts/cost-oracle.mjs` compares ccusage
  against `build-history.jsonl`.
- **Part B's build is not needed.** The pre-registered outcome "no row 2 at all" is confirmed
  from data, and Part A already showed per-segment accounting exact to the cent.

## Owed — and the strong claim is n=1

- **"Money not lost" is proven for `13fd190e` only** (token census). The other four are the
  same *shape* (ledger > history), but ledger-vs-oracle was never compared, and ledger >
  history alone does not prove ledger ≈ truth.
- **Re-run the oracle against the ledger.** Cheap, **not free**: ledger rows carry `build_id`
  and `feature_code`, not `flowId`, and legacy history rows have no `accumulator_build_id`,
  so the ledger→flow join has to be built before the comparison can run.
- **Open question 0d must be recomputed, direction unknown.** Its "unexplained 7.7%
  over-count" compared a history row ($4.3556) against `flowSpent` ($4.0447). The ledger
  figure for the paired build is **$6.9342** — *further* from `flowSpent`, not closer. The
  over-count may widen rather than dissolve, or the `build_id`↔`flowId` pairing may be wrong.
- **Do not add an `appendBuildHistory` call to `abortBuild` yet.** A third writer is exactly
  the shape this design has replaced with a deletion three times. The alternative worth
  pricing first: `build-history` becomes a *read* over the ledger, which already carries
  `usd`, `tokens_total` and `terminal_status` per `build_id`.

**Falsifier:** `lib/build.js:7745-7750` and `:3365`. If either path gains a history write,
these numbers should re-converge.
