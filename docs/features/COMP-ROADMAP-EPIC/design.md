# COMP-ROADMAP-EPIC — First-class epic/umbrella entity

**Status:** PLANNED
**Epic:** COMP-ROADMAP (COMP-ROADMAP-MODEL: Structured + Composable Roadmaps)

## Related Documents

- Parent epic anchor: [COMP-ROADMAP planning-model design](../../plans/2026-06-21-roadmap-planning-model-design.md)
- Sibling: COMP-ROADMAP-COMPOSE (composable nested workspaces, parent→child rollup) — shares the rollup machinery this feature formalizes.
- Surfaced by: the COMP-PLAN-RIGOR filing session (2026-07-20) — filing that epic revealed epics have no first-class representation.

## Problem

An epic/umbrella has **no first-class entity** in the roadmap model. Today an epic is represented as two things that fight:

1. A **free-text `phase` string** on each constituent `feature.json` (e.g. `"phase": "COMP-ROADMAP-MODEL: Structured + Composable Roadmaps"`). It is a grouping label, not a node — no code, no status, no description, no anchor-doc link, no ordering.
2. A **status override smuggled into the ROADMAP.md heading** (`roadmap-gen.js:62` `readPhaseOverrides`). The override always wins over the computed rollup (`phaseStatus()`, `roadmap-gen.js:33`); when authored status and rollup diverge, drift is emitted (`roadmap-gen.js:151`). This is the source of the persistent divergence WARNs (~16 at last count).

Consequences:
- Epic status has nowhere to live as authored data, so it is hand-written into a markdown heading and then perpetually fights the rollup (drift noise that never resolves).
- Epic provenance — anchor design doc, north-star/vision link, owner, ordered constituents — lives in prose, not on a tracked object.
- The `track` vision type (`server/vision-store.js:10`) already exists but is **stranded** — unwired to the `phase`-string grouping, an unused primitive for exactly this job.

## Direction (for build-time design)

Promote the epic to a first-class node — most likely by **wiring the existing `track` vision type** as the epic entity rather than inventing a new type. An epic node carries: `code`, `description`, `status` (derived from constituent rollup by default, with an explicit authored-status field **on the entity** for deliberate overrides), `anchorDoc`, `northStar` link, and ordered constituent refs. Constituents reference their epic by code (replacing the free-text `phase` string). Retire the markdown-heading override mechanism and its drift path once status is authored on the entity.

## Acceptance criteria (draft — ratify at build design)

- [ ] Epic is a tracked entity (code + description + status + anchor + constituents), not a free-text `phase` string.
- [ ] Constituent features reference their epic by code; the `phase` grouping is derived, not authored per-feature.
- [ ] Epic status derives from the constituent rollup by default; authored override is a field on the epic entity, not a markdown-heading hack.
- [ ] The `readPhaseOverrides` heading-override mechanism and its drift WARNs are retired (or reduced to a migration-era bridge).
- [ ] Existing `phase`-string groupings migrate to epic entities (one-time).
- [ ] Decision recorded: reuse `track` vision type vs. new `epic` type.

## Non-goals

- Cross-workspace epic rollup (that is COMP-ROADMAP-COMPOSE).
- GTM/initiative metadata on epics (COMP-ROADMAP-META, deferred).
