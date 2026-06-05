# <Feature Name>: Design


## Why

In `lib/build.js` `executeParallelDispatch`, the review-scaffold branch (`if (isReview)`) builds `buildReviewPrompt({ ..., taskDescription: response.inputs?.task ?? '', blueprint: response.inputs?.blueprint ?? '' })`. `response` is NOT a parameter or local of `executeParallelDispatch` (it's only defined in `startFresh`), so this is a latent ReferenceError that throws (caught by the per-task try/catch → the lens task fails) whenever a consumer-dispatch review/lens task reaches the scaffold path. Almost certainly a typo for `dispatchResponse`. Surfaced 2026-06-05 by the COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY golden integration test (a synthetic isolation:none + lens dispatch triggered it; proof-run's mocked review shape does not). Orthogonal to the merge-retry feature so deferred. Fix: change `response.inputs` → `dispatchResponse.inputs` (verify the intended source) and add a consumer-path review-dispatch test that exercises the scaffold.

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->
