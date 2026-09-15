# <Feature Name>: Design


## Why

Observed on a live COMP-TUI-4 build 2026-09-15 (flow 8d8f1001-eabf-48bb-8184-b6da85664c8e). Both execute fanout items failed with FILES_OWNED_VIOLATION, and `attempts: 2` retried each one — producing byte-identical failures:

  item 0 attempt 1: "Task COMP-TUI-4-1 changed unowned paths: test/cli-progress-grid.test.js"
  item 0 attempt 2: "Task COMP-TUI-4-1 changed unowned paths: test/cli-progress-grid.test.js"
  item 1 attempt 1: "Task COMP-TUI-4-2 changed unowned paths: node_modules, test/build-emission.test.js"
  item 1 attempt 2: "Task COMP-TUI-4-2 changed unowned paths: node_modules, test/build-emission.test.js"

An ownership violation is deterministic by construction: the retry re-runs the same item with the same files_owned against the same TDD instruction, so it cannot produce a different outcome. Every such retry is a paid implementer dispatch thrown away, and the fanout ran the waste once per item.

This is distinct from the root causes fixed alongside it (decompose not allocating test paths; compose's own node_modules symlink bridge being attributed to the agent). Those fixes remove the common trigger, but the retry policy itself would still burn a dispatch on any future deterministic contract failure.

Suggested shape: classify failureKind 'contract' (already recorded in the flow state) as non-retryable, and let attempts apply only to transient/agent failures. Worth confirming which other failure kinds are deterministic before choosing the predicate.

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
