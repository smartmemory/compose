# <Feature Name>: Design


## Why

Two v1 exclusions that cap data quality: (1) claude-route dispatches record effort_intended only — the local SDK supports the effort parameter for Opus/Sonnet but v1 deliberately made no behavior changes, so the executed-effort curve only covers codex runs; (2) test suites that dispatch without project_cwd fall back to process.cwd() and pollute the repo's live ledger with fixture rows (observed: 345 unattributed claude-test rows after one full-suite run) — redirect the fallback under NODE_TEST_CONTEXT like the worktree bases, or thread project_cwd through the remaining harnesses.

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
