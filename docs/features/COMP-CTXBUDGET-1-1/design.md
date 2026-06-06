# <Feature Name>: Design


## Why

During COMP-CTXBUDGET-1 the full `npm test` hung for over an hour. Investigated root cause: `test/proof-run.test.js` runs a real ~25s stratum pipeline and is the suite's slowest test; under full parallel load it can starve, and because the `test` script omits `--test-timeout` (node's --test has no default), a starved test hangs forever instead of failing. In isolation proof-run passes; bounded with `--test-timeout=90000` the whole node suite is reliably green (3516 pass). The unbounded hang also threatens the pre-push hook, which runs the same bare `npm test` as a hard gate. Fix: add a sane `--test-timeout` to the node portion of the `test` script (and consider isolating real-pipeline integration tests so they don't contend). Independent of the context-budget skill; surfaced by it.

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
