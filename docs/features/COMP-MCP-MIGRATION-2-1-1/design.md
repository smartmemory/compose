# <Feature Name>: Design


## Why

COMP-MCP-MIGRATION-2-1 attempted bulk backfill and discovered three structural blockers that each alone breaks lossless round-trip. Trial run dropped compose/ROADMAP.md from 1125 to 493 lines. Reverted the trial; documented the three blockers in MIG-2-1 design + report. This ticket is the proper redesign once those blockers are individually scoped: (1) ~80% of Phase 0-6 entries use # | Item | Status anonymous tables with no feature code to migrate, (2) curated phase-status overrides (PARKED with reason, PARTIAL with parenthetical, SUPERSEDED by X) cannot be reconstructed by phaseStatus rollup, (3) Roadmap Conventions / Dogfooding Milestones / Key Documents sections have no feature.json equivalent and get stripped. All three need design decisions, not just code.

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
