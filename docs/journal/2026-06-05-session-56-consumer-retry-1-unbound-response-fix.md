---
date: 2026-06-05
session_number: 56
slug: consumer-retry-1-unbound-response-fix
summary: "CONSUMER-RETRY-1: fix unbound `response`→`dispatchResponse` in the executeParallelDispatch review scaffold; first test to drive a lens dispatch through the consumer-path scaffold."
feature_code: COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1
closing_line: A two-line fix that mostly taught us how a swallowed error hides in a green test suite — and how a careless sed almost added a second bug while removing the first.
---

# Session 56 — COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1

**Date:** 2026-06-05
**Feature:** `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1`

## What happened

A one-line follow-up the previous session had filed against itself: the golden integration test for COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY had surfaced (but deferred) a latent bug in `executeParallelDispatch`. The `if (isReview)` review-scaffold branch read `response.inputs?.task` / `response.inputs?.blueprint`, but `response` is unbound inside that function — only the parameter `dispatchResponse` is in scope. So any review/lens task that reached the scaffold on the consumer-dispatch path (the default for `compose build`) threw a `ReferenceError` that the per-task try/catch swallowed, silently failing the lens. We confirmed the bug on disk first: inside the function body (3735–4050) the *only* bare `response` tokens were the two buggy lines; everything else already used `dispatchResponse`. We wrote the failing test first (RED: `agentRuns === 0` because the throw beat the dispatch), applied the one-symbol fix, and went GREEN. A sloppy address-less `sed` during the revert-check over-applied and rewrote the two legitimate `startFresh` call sites (~1109/~1734) to `dispatchResponse` too — caught immediately via `git diff`, reverted with precise Edits so the net change is exactly the intended two lines. Full suite green, Codex review CLEAN in one round.

## What we built

- `lib/build.js`: `response.inputs` → `dispatchResponse.inputs` for `taskDescription`/`blueprint` in the `executeParallelDispatch` review scaffold (2 lines). The two `startFresh` scaffold call sites keep `response` (correct local there).
- `test/par-merge-consumer-retry.test.js`: new 'CONSUMER-RETRY-1' describe — drives an `isolation:none` lens dispatch with `dr.inputs={task,blueprint}` through the scaffold and asserts the task+blueprint sections thread into the dispatched prompt (`## Task\n\nGOLDEN_TASK_DESC`, `## Blueprint\n\nGOLDEN_BLUEPRINT_TEXT`). First test to exercise the scaffold on the consumer path.
- `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1/feature.json`: status PLANNED → COMPLETE, SHIPPED description, `group: Standalone`.
- CHANGELOG entry under 2026-06-05.

## What we learned

1. **A swallowing try/catch turns a ReferenceError into a silent capability gap.** The lens task didn't crash the build — it just quietly failed, which is exactly why the bug survived the parent feature's 17-test suite. The test that catches it has to assert the *positive* outcome (scaffold built, inputs threaded), not just "no throw."
2. **The existing isolation:none test gave false coverage confidence.** It ran lens-like tasks but never set `lens_name`/`review_mode`, so `isReview` stayed false and the scaffold branch was never entered. Coverage of a function ≠ coverage of its branches.
3. **Never use address-less `sed` to edit code.** A global `s/response/dispatchResponse/` during a revert-check silently corrupted two unrelated correct call sites. `git diff` is the cheap safety net — always diff after a scripted edit, and prefer the Edit tool with unique anchors.
4. **Assert on incidental counts at your peril.** `agentRuns === 1` failed at GREEN because review-mode `runAndNormalize` dispatches a repair pass when the stub returns non-`ReviewResult` JSON. Relaxing to `>= 1` + `prompts.some(...)` kept the guard strong while dropping the brittle exact-count coupling.

## Open threads

- [ ] The 'Standalone Tickets' feature family (COMP-PAR-MERGE-QUEUE*) is tracked via feature.json + CHANGELOG only, never ROADMAP.md rows. Intentional, but worth confirming the roadmap generator is meant to exclude `group: Standalone`.
- [ ] Pre-existing tracker WARN: `phase "P1" override "PLANNED" diverges from rollup "IN_PROGRESS"` — unrelated to this fix, but still unacknowledged in ROADMAP.md.

---

*A two-line fix that mostly taught us how a swallowed error hides in a green test suite — and how a careless sed almost added a second bug while removing the first.*
