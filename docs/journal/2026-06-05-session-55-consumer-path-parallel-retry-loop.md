---
date: 2026-06-05
session_number: 55
slug: consumer-path-parallel-retry-loop
summary: Shipped the consumer-path parallel retry loop (model C) + mis-route fix + default-OFF gate opt-in; golden integration test caught two real cross-feature bugs.
feature_code: COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY
closing_line: The retry loop was the easy part; the merge-state plumbing it sits on is where the bodies were buried.
---

# Session 55 — COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY

**Date:** 2026-06-05
**Feature:** `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY`

## What happened

Resumed mid-Phase-7 (T1 done) on COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY — the deferred D4/D5 of the consumer-dispatch pre-merge work. The job: give executeParallelDispatch its own bounded, bounce-injected retry loop, fix the single-agent mis-route of a parallel ensure_failed, and add a default-OFF pre_merge_gate opt-in. We drove it TDD through T2 (opt-in wiring) → T6 (golden integration), then a 4-round Codex impl-review.

The design (model C) was PINNED — failed-only re-run, successful diffs replayed onto a per-round throwaway anchor commit, base restored to an entry snapshot between rounds. We implemented it exactly, with one deliberate deviation: the scratch git index lives in os.tmpdir(), not .compose/, because .compose/ isn't gitignored and `git add -A` for the snapshot would otherwise stage the temp-index file into the snapshot tree.

The golden integration test — the FIRST end-to-end exercise of multi-task worktree merge through executeParallelDispatch — earned its keep twice. First it deterministically failed because every task writes a `.owner` marker that `git add -A` captured into each task's diff, so the 2nd task's merge conflicted on `.owner`; a latent parent-feature bug in any repo not gitignoring it. Then the full suite caught a regression: an early cut tagged EVERY non-retryable terminal `_parallelRetriesExhausted`, which killed the review-lens fix-loop (isolation:none) — proof-run went red. We confined the retry/marker semantics to the worktree path. Codex then drove three more fixes: cap source (read the step's declared retries), isolation:none emit byte-identity, and the snapshot-required-for-retry invariant (never retry against a base we can't guarantee clean).

## What we built

- lib/build.js: the retry loop in executeParallelDispatch (per-round closure + bounded while-loop), buildAnchorCommit / captureEntrySnapshot / restoreToSnapshot / topoOrderedDiffs helpers (temp-index, base-untouched), the W1 bounce injection at the task-prompt hook, the isParallelRetriesExhausted marker + guards in runBuild and executeChildFlow, the D5 opt-in (resolvePreMergeGate threaded through an exported startFresh into planInputs only when capabilities.preMergeGate), and the `.owner` unstage-before-capture fix.
- lib/step-prompt.js: formatBounceForPrompt (T1, prior session).
- pipelines/build.stratum.yaml: pre_merge_gate input (workflow + flow) + execute.pre_merge_verify.
- test/par-merge-consumer-retry.test.js: 17 tests covering every blueprint test-plan row (D5 omit/present, anchor/snapshot/restore incl. untracked, golden retry, depth cap, base-clean-on-exhaustion, isolation:none byte-identical, no-bounce/schema_failed subset, conflict-loser retry).
- docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY/{report.md,feature.json}; CHANGELOG; forge-top ROADMAP row→COMPLETE.

## What we learned

1. Integration tests over a hot-path function find what unit tests and source assertions can't. The first true end-to-end run of multi-task worktree merge surfaced two real bugs (.owner capture, isolation:none mis-route) that 3400 existing tests never touched.
2. `.compose/` is not gitignored in the target repo — any scratch file written there during a `git add -A` window gets captured. Put temp git indexes in os.tmpdir().
3. 'Byte-identical' must be scoped precisely. The entry snapshot is a GC'd dangling commit (object-db only); the index/worktree/parallelDone/event-content are what the parity claim covers. The Codex gate held that line across 4 rounds rather than accepting hand-waving.
4. A retry that mutates shared state needs a guaranteed rollback point BEFORE it runs — gate retryability on snapshot-success and abort on restore-failure, never best-effort.
5. propose_followup clobbers the hand-authored COMP-GSD ROADMAP prose (same hazard as `roadmap generate`); checkout ROADMAP.md after, keep only the scaffolded folder.

## Open threads

- [ ] COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1 (filed): fix the undefined `response` ref in executeParallelDispatch's review-scaffold branch (typo for dispatchResponse) + add a consumer-path review-dispatch test.
- [ ] The D5 opt-in is wired but default-OFF and untested in a live `compose build` (no repo sets capabilities.preMergeGate yet); first real consumer will validate the end-to-end gate-in-worktree path.
- [ ] Entry-snapshot capture failure degrades to single-pass (documented, pre-feature-equivalent); no automated test for that path (hard to simulate cleanly).

---

*The retry loop was the easy part; the merge-state plumbing it sits on is where the bodies were buried.*
