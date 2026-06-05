# COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY — Implementation Report

**Status:** COMPLETE · **Date:** 2026-06-05 · **Repo:** `compose/` only
**Design:** [design.md](design.md) (retry model **C**) · **Blueprint:** [blueprint.md](blueprint.md) (Codex CLEAN)
**Parent:** [COMP-PAR-MERGE-QUEUE-CONSUMER](../COMP-PAR-MERGE-QUEUE-CONSUMER/report.md) (gate + conflict-bounce v1)

## Summary

The consumer-dispatch path (`executeParallelDispatch`, `lib/build.js`) now owns a bounded,
bounce-injected **retry loop** (model C): each round re-runs only the failed subset, replays the
round's successful diffs onto a throwaway per-round **anchor commit** so re-run tasks see prior good
work, and restores the real base to an **entry snapshot** between rounds so there is no cross-round
double-apply. The single-agent **mis-route** is fixed for both outer loops (`runBuild`,
`executeChildFlow`) via an explicit `_parallelRetriesExhausted` marker, and `build.stratum.yaml`
gains a **default-OFF** `pre_merge_gate` opt-in (D5). No Stratum change.

## Delivered vs Planned

| Unit | Planned | Delivered |
|------|---------|-----------|
| W1 | `formatBounceForPrompt` + consumer-side injection | ✅ T1 (prior session) + injected at the task-prompt hook |
| W2 | `buildAnchorCommit` + entry-snapshot/restore helpers | ✅ `buildAnchorCommit`, `captureEntrySnapshot`, `restoreToSnapshot`, `topoOrderedDiffs` |
| W3 | Retry loop in `executeParallelDispatch` | ✅ per-round loop, subset math, anchor seeding, apply-before-`parallelDone`, restore-between-rounds, single terminal emit |
| W4 | Mis-route guard at both outer loops | ✅ `isParallelRetriesExhausted` marker, guards at `runBuild` + `executeChildFlow` |
| W5 | D5 opt-in (config gate + `startFresh` param + YAML) | ✅ `resolvePreMergeGate` wired, `startFresh` threads `preMergeGate`, YAML inputs + `pre_merge_verify` |
| W6 | Tests | ✅ 17 tests in `test/par-merge-consumer-retry.test.js` (every blueprint test-plan row) |

## Key Implementation Decisions

- **Temp index in `os.tmpdir()`, not `.compose/`.** The blueprint's illustrative `.compose/par-snap-index`
  path is unsafe: `.compose/` is not guaranteed gitignored, so `git add -A` for the snapshot would stage
  the temp-index file itself into the snapshot tree. Moving the scratch index outside the worktree
  sidesteps the self-capture. (Merge-state model unchanged.)
- **Retry is worktree-only.** The retry loop, entry snapshot, and `_parallelRetriesExhausted` marker apply
  ONLY to the worktree consumer-merge path. `isolation: none` steps (the review lenses) return the raw
  envelope with the pre-feature emit (before `parallelDone`, mergeStatus summary) — byte-identical.
- **Retry requires a guaranteed-clean base.** `retryable` is gated on `entrySnapshot !== null`; a restore
  failure aborts the retry (falls through to the tagged terminal). A round never runs against residual state.
- **Cap source.** `RETRY_CAP = dispatchResponse.retries ?? max_par_retries ?? 2`, ceilinged at 10.
- **Single terminal `build_step_done`** on the worktree path, emitted after the terminal `parallelDone`
  (mirrors `executeParallelDispatchServer`); the one intentional ordering change, asserted in tests.

## Bugs Surfaced by the Golden Integration Test

1. **`.owner` diff-capture conflict (parent-feature latent bug, fixed).** Every task writes a `.owner`
   ownership marker at its worktree root; `git add -A` captured it into each task's diff, so applying
   the 2nd task's diff conflicted (`'.owner' already exists`). Multi-task consumer-dispatch merges would
   conflict in any repo not gitignoring `.owner`. Fixed by unstaging `.owner` before diff capture.
2. **`isolation: none` regression (caught + fixed pre-merge).** An early cut tagged every non-retryable
   terminal `_parallelRetriesExhausted`, which killed the review-lens fix-loop (proof-run failed). Fixed
   by confining retry/marker semantics to the worktree path.

## Known Issues & Tech Debt

- **`executeParallelDispatch` references an undefined `response`** in the review-scaffold branch
  (`response.inputs?.task`/`.blueprint`) — almost certainly a typo for `dispatchResponse`. Pre-existing,
  orthogonal (review path, not the merge-retry path); proof-run's mocked review shape doesn't trigger it.
  Filed as a follow-up.
- **Entry-snapshot capture failure** (unborn HEAD / broken git) degrades to single-pass with no rollback,
  identical to pre-feature behavior; warned + documented. A coarse `checkout/clean` is not a safe fallback
  (it would discard the user's entry uncommitted changes).

## Test Coverage

`test/par-merge-consumer-retry.test.js` — 17 tests: D5 opt-in omit/present, anchor/snapshot/restore helpers
(incl. untracked preservation), golden retry (subset, anchor seeding, bounce injection, single emit,
no-doubling), depth cap, base-clean-on-exhaustion, `isolation:none` byte-identical, no-bounce/schema_failed
subset selection, merge-conflict-loser retry. Full JS suite green (3426); Codex impl-review CLEAN (4 rounds).

## Lessons Learned

- Integration tests over the full `executeParallelDispatch` (first end-to-end exercise of multi-task
  worktree merge) caught two real cross-feature bugs that unit tests and source assertions missed.
- "Byte-identical" must be scoped precisely (index/worktree/`parallelDone`/event-content) — the dangling
  snapshot commit and the deliberate emit-ordering change are within that scope; the Codex gate held the line.
