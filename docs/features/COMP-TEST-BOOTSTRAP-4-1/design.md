# <Feature Name>: Design


## Why

COMP-TEST-BOOTSTRAP-4 shipped the test-count/pass-rate gate but the second deliverable — a review lens flagging auto-generated tests for human verification — is architecturally un-fireable in the current build lifecycle. Order is execute → review → codex_review → coverage → ship (coverage depends_on codex_review). The agent GENERATES the golden tests during coverage, AFTER both review passes, so a review lens has nothing to read in the same build and any 'tests scaffolded' signal is written too late to reach review triage. Enabling it requires a lifecycle change: either add a dedicated test-review pass after coverage, or reorder coverage before review. Caught by Codex review during the parent's implementation.

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
