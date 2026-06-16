# <Feature Name>: Design


## Why

COMP-MCP-FOLLOWUP-1 added an actionable error + a contract test for the stale-server case, but the lazy `await import('../lib/followup-writer.js')` in toolProposeFollowup still means a real on-disk export break would only surface on first invocation, not at boot. Eager-loading the writer module during server initialization would make such breakage immediately visible at startup (fail-fast), complementing the CI contract test. Small, optional hardening.

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
