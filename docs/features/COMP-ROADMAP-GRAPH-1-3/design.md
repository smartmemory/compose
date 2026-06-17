# <Feature Name>: Design


## Why

Today lib/roadmap-graph/model.js DROP_STATUSES = {COMPLETE, SUPERSEDED, KILLED} removes completed nodes from the rendered graph, and collect.js:86 silently drops any edge whose endpoint was dropped. So when feature A completes, the A→B dependency edge vanishes from the graph even while B is still active — the graph stops being able to answer "what did this feature build on" once the dependency lands. The underlying provenance is NOT lost in storage (feature.json, deps.yaml, and ROADMAP/design prose all persist on disk regardless of status; there is no feature-archival step), but the live graph projection loses it. v1 scope is narrow: add an opt-in render mode that excludes only KILLED/SUPERSEDED (keeping COMPLETE as dimmed "historical" nodes) so completed-dependency edges remain traceable; default behavior (declutter to active forward structure) is unchanged. Surfaced 2026-06-17 during the COMP-PARITY batch ship, when reconciling 149 vision-state statuses to COMPLETE raised the question of whether completion loses dependency provenance. Related but out of scope: provenance is under-captured structurally to begin with — only 26/245 features carry typed links[], most dep facts are ROADMAP/design prose (cf. the UNREFERENCED_FOLLOWUP validate findings); converting prose deps to typed links/deps.yaml is a separate, larger effort.

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
