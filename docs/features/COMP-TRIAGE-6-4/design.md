# COMP-TRIAGE-6-4 — Rotate build-accumulator identity BEFORE the fallible `startFresh`

**Status:** design
**Complexity:** S
**Parent:** COMP-TRIAGE-6
**Surfaced by:** b6ecbd5 codex belt-and-braces review (2026-07-23), P2 reachable single-process.

## Problem

On a **fresh-over-failed retry** (re-run a build whose prior attempt left a
`failed` accumulator on disk), the accumulator-identity rotation runs *after*
the fallible `startFresh` call, not before:

- `lib/build.js:2467` — `startFresh(...)` (direct `fresh` verdict)
- `lib/build.js:2482` — rotation block (`isFreshStart && !isNewAccumulator`):
  `createBuildAccumulator` → new `build_id`, zeroed cost totals, `shipStepTestData = null`.

Because `selectBuildAccumulator` **reuses** the old failed record on a retry
(`isNew=false`), at entry `build_id` = the OLD failed id and that record is
still on disk. If `startFresh` throws (spec compile error, stratum down) before
the rotation runs, control jumps to the `finally` → `finalizeBuildAttempt`
(~1965), which:

1. `readBuildAccumulator` → returns the OLD failed record (`build_id` = OLD),
2. guard `accumulator.build_id === build_id` (OLD === OLD) is **true**,
3. `emitBuildActuals(cwd, accumulator, 'failed')` emits a **duplicate**
   `build-actuals` failed row under the OLD `build_id` carrying the prior
   attempt's stale counters.

The OLD build already emitted its own terminal `failed` row, so this is a
second row for the same `build_id` → **double-counts in ACRR**.
`emitBuildActuals` does not clear the sidecar on `'failed'` (only
complete/aborted), so the failed record persists to be re-finalized.

### Two exposed call sites, not one

`startFresh` is also called at `lib/build.js:2434` — the `resume` verdict that
discovers a terminal flow and falls back to fresh (`isFreshStart = true` at
2435). It also flows through to the same post-`startFresh` rotation at 2482, so
it has the identical exposure. The fix must cover **both** sites.

## Fix

Rotate the stale accumulator identity **before** each `startFresh` call, via an
idempotent guarded helper `rotateStaleAccumulatorForFreshStart()`:

- Guard: run only when `!isNewAccumulator && !accumulatorRotated`.
- Body (unchanged from today's 2482 rotation): `createBuildAccumulator`
  (writes the new record to disk), set `build_id` + `COMPOSE_BUILD_ID`, zero
  `buildCostTotals`, `shipStepTestData = null`, re-stamp + re-emit the triage
  estimate under the new id, mark `accumulatorPersisted = true`.
- Set `accumulatorRotated = true` so the post-`startFresh` block cannot rotate
  a second time.

Call it immediately before `startFresh` at both 2434 and 2467. The
post-`startFresh` ownership block then keeps only the `isNewAccumulator`
candidate-persist branch (brand-new builds — unaffected by this bug, since a
throw there hits the existing `1977` write-and-emit fallback under a distinct
candidate id, never a duplicate).

### Why this is correct

After rotation, on a `startFresh` throw, `finalizeBuildAttempt`:

- `readBuildAccumulator` → returns the NEW rotated record (rotation persisted
  it), `build_id` = NEW,
- emits one clean `failed` row under the NEW `build_id` with **zeroed**
  counters — a legitimate terminal row for the new attempt that failed to
  start,
- the OLD build's single `failed` row is untouched.

No second row under the OLD `build_id`; no stale counters double-counted. The
`emitBuildActuals` identity check (`persisted.build_id !== accumulator.build_id`
throws) is satisfied because rotation persisted the new record before the throw.

## Belt: ownership-aware finalization (Codex design review, 2026-07-23)

Rotation-before-`startFresh` closes the `startFresh`-throws window, but a
fresh-over-failed retry can die *earlier* — between reusing the failed
accumulator (`accumulatorPersisted = true` at ~1941) and the fresh/resume
verdict. The reachable in-`try` case is `stratum.audit()` (~2369) throwing while
probing the prior flow's terminality. That runs before the rotation helper, so
`finalizeBuildAttempt` still matched the reused `build_id` and re-emitted the
old failed row — the same double-count, one step upstream.

Fix (belt to the rotation's braces): `finalizeBuildAttempt` suppresses a
terminal emission only when a fresh, not-yet-rotated attempt reuses a record
whose row **already exists in the ledger**:

```
mayReemitReused = !isNewAccumulator && !accumulatorRotated && isFreshStart
alreadyEmitted  = mayReemitReused && ledger has a build-actuals row for build_id
emit unless alreadyEmitted
```

- `isNewAccumulator` — brand-new build; its story is this attempt's → emit.
- `accumulatorRotated` — rotated to a new (unemitted) identity → emit the NEW id.
- `!isFreshStart` — a genuine resume that continues and owns the reused build
  (the failed→resume→complete path, which intentionally emits a second row
  under the same id) → emit.
- Reused, fresh, not rotated, **no ledger row yet** (a hard-killed build,
  `last_terminal===null`, that never finalized) → emit its one terminal row.

The signal is the **ledger itself**, not the reused record's `last_terminal`
(Codex final review): `emitBuildActuals` writes `last_terminal` and the row
non-atomically, so trusting the marker would wrongly suppress when a crash set
the marker without a row, or wrongly double-emit when a crash cleared the marker
after a row. Checking `build_id` against the ledger is authoritative and costs
one read at terminal time (once per build). `isFreshStart` and
`accumulatorRotated` are hoisted to function scope so the (outer-`try`) finalize
closure can read them.

**resume→fresh fallback ownership timing (Codex Medium).** At the
resume-verdict→terminal→fresh fallback, `isFreshStart` was `false` (resume
verdict) until *after* `startFresh` returned. If rotation itself threw there,
the guard would see `isFreshStart===false`, treat it as a resume, and re-emit
the reused failed row. Fix: set `isFreshStart = true` **before** calling the
rotation helper, so a rotation throw is correctly finalized as a fresh
(suppressed) start. The direct `fresh` verdict site is already safe —
`isFreshStart` is set true from the verdict before rotation there.

Pre-`try` throw sites (triage, spec load — cited at 2038/2123/2193/2237) never
reach `finalizeBuildAttempt` (the `finally` isn't registered yet), so they carry
no double-emit risk. The two `startFresh` call sites (2434, 2467) are the only
ones in `lib/build.js` (Codex-confirmed).

## Root cause: row-first ordering in `emitBuildActuals`

The ledger-backed guard reads the **ledger** rather than `last_terminal` because
`emitBuildActuals` wrote `last_terminal='failed'` *then* appended the row — two
non-atomic sync writes. Successive Codex rounds kept finding narrower crash
corners of that one root cause: a crash between the two writes strands a
`last_terminal='failed'` marker with no row, and depending on the next entry
path (`--fresh`, resume, fresh-over-failed) that orphan is either lost or, if
recovered, only recovered on that specific path.

Rather than armor each entry path, fix the root cause. `emitBuildActuals` now
**appends the durable ledger row FIRST, then does the best-effort marker/clear**:

```
append build-actuals row          // durable — the ACRR-consumed artifact
if failed:   set last_terminal='failed'   // best-effort, after the row
if complete: clear the sidecar            // best-effort, after the row
```

Every row field is read from the persisted snapshot (none depends on
`last_terminal`), so this is byte-identical on the happy path. Because
`emitBuildActuals` is the **only** writer of `last_terminal='failed'`, row-first
makes the "marker without row" orphan **unreachable on every path** — a crash
between the two writes can leave only a stale marker or an uncleared sidecar
(both harmless: rotation overwrites them on the next build), never a lost row or
a stranded marker. This obviates per-path orphan reconciliation entirely (an
earlier draft added a reconcile step per entry path — `--fresh`, resume,
fresh-over-failed — which Codex kept finding gaps in; row-first at the single
writer covers them all at once). The finalize guard stays ledger-backed (correct
regardless of ordering): row-first removes the *source* of orphans, the
ledger-read removes any *dependence* on the marker.

## Out of scope

P1a (`finalizeBuildAttempt` clobbers a foreign live sidecar on pre-ownership
failure) and P1b (post-verdict ownership non-atomic) from the same review —
both require two concurrent same-feature builds and are accepted as PID
advisory-lock limitations (recorded in `feature.json`). Not addressed here.

## Test (TDD)

Two regressions in `test/dispatch-build.test.js`, both driving `runBuild` on a
fresh-over-failed retry:

1. **`startFresh` throws** (the plan call) → assert no duplicate `build-actuals`
   row under the old `build_id`; the retry's terminal row lands under a fresh,
   distinct id.
2. **flow-audit throws** (dies before the verdict, upstream of rotation) →
   assert exactly one `build-actuals` row remains (the prior attempt's), no
   second row under the reused id. Exercises the ownership guard.
3. **interrupted (`last_terminal=null`) reuse dies before the verdict** →
   assert the still-open build DOES get its one terminal row (guard-boundary:
   suppression must not swallow a record that never emitted).
4. **row-first ordering in `emitBuildActuals`** → for both `failed` and
   `complete`, assert the durable ledger row is written and the marker/clear
   outcome is unchanged (root-cause fix; the crash-window between the two writes
   is a code-review-evident property of the ordering, not fault-injected).

## Files

- `lib/build.js` (existing) — (a) `emitBuildActuals`: append the ledger row
  before the best-effort marker/clear (root-cause row-first ordering);
  (b) hoist rotation to a guarded helper called before both `startFresh` sites;
  (c) ledger-backed ownership guard in `finalizeBuildAttempt`;
  (d) `isFreshStart`/`accumulatorRotated` hoisted to function scope.
- `test/dispatch-build.test.js` (existing) — four regressions (above).
