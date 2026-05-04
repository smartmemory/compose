# COMP-MCP-MIGRATION-2-1: Backfill prep + lossless regen

## Why

Both `COMP-MCP-FOLLOWUP` and `COMP-MCP-MIGRATION` shipping had to manually restore `compose/ROADMAP.md` after typed-writer regens wiped curated history. The original plan was to backfill `feature.json` files for every legacy ROADMAP row so the typed writers fully own roadmap regen and `ROADMAP_PARTIAL_WRITE` stops firing during normal flips.

**Status:** PARTIAL
**Date:** 2026-05-04
**Parent:** COMP-MCP-MIGRATION-2

## Reality

Running the existing `migrateRoadmap()` against `compose/` revealed three structural reasons the bulk backfill cannot complete cleanly without significant additional work:

1. **Anonymous-row layouts.** Phases 0–6 use `# | Item | Status` tables where the first column is a row number, not a feature code. The roadmap parser correctly emits `_anon_<n>` codes for these and `migrateRoadmap` skips them. Result: ~80% of historical entries cannot be migrated by the existing tool.
2. **Curated phase status overrides.** Phase headings carry rich, human-set statuses (`PARKED (Claude Code dependency)`, `PARTIAL (1a–1d COMPLETE, 2 PLANNED)`, `SUPERSEDED by STRAT-1`). `roadmap-gen.js`'s `phaseStatus()` recomputes status from member rollups, losing this nuance.
3. **Top-level non-phase sections.** `Roadmap Conventions`, `Dogfooding Milestones`, `Execution Sequencing`, `Key Documents` have no equivalent in `feature.json` and are stripped by regen.

Bulk backfill is therefore a larger ticket than originally scoped. It needs:
- Parser updates to extract codes from anonymous-numbered rows when context permits
- A `phaseStatusOverride` field on representative feature.json entries (or a separate phases manifest)
- Preserved-section anchors in the regen output

That's its own design work, not a few hours of code.

## What this ticket actually ships

Two infrastructure fixes that prepare the ground without committing to the full migration:

### 1. `lib/migrate-roadmap.js` honors `paths.features`

The existing `migrateRoadmap()` defaulted `featuresDir` to the literal `'docs/features'`, ignoring `.compose/compose.json` overrides. After this change it uses `loadFeaturesDir(cwd)` (introduced in `COMP-MCP-MIGRATION-2`), so any future invocation respects the configured root.

### 2. `lib/roadmap-gen.js` no longer truncates descriptions

Previously `renderPhase()` cut descriptions at 80 chars + `'…'`. Curated rows are routinely 200–500 chars, so any regen against a project with rich descriptions silently mangled them. The truncation served no documented purpose; markdown tables tolerate long cells fine. After this change, regen preserves full descriptions verbatim — meaning typed-writer flips no longer corrupt content even when `feature.json` has a long description.

## Decisions

1. **Don't run the bulk backfill in this ticket.** The data-loss surface is too large to ship cleanly. Acknowledge it explicitly and file proper follow-up work.
2. **Keep migrate-roadmap as-is otherwise.** It's still the right tool for green-field migrations of repos with simple `# | Code | Description | Status` tables; just not for compose's own ROADMAP.
3. **No truncation in regen.** Markdown tables handle long cells; truncation was lossy by design.

## Files (delivered)

| File | Action | Purpose |
|------|--------|---------|
| `lib/migrate-roadmap.js` | edit | Default `featuresDir` to `loadFeaturesDir(cwd)` |
| `lib/roadmap-gen.js` | edit | Drop the 80-char truncation |
| `docs/features/COMP-MCP-MIGRATION-2-1/{design,report}.md` | new | This document + report |

## Out of scope

- Parser updates for anonymous-numbered tables.
- Phase-status override mechanism (curated `PARKED`/`SUPERSEDED` text preserved across regen).
- Preamble / footer / non-phase-section preservation.
- Actual mass-backfill of compose's 189 historical features.

These should be filed as their own ticket once a proper design exists. Until then, hand-edit `compose/ROADMAP.md` directly when needed; typed writers' regen remains a known-lossy operation against the curated portions of the file.

## Lessons

- The "just run migrateRoadmap on the existing repo" reading of this ticket was too easy. The real work is in lossless round-trip — and it's bigger than the original scope.
- Shipping the no-truncation fix is genuinely useful in isolation: any project that uses typed writers with descriptive prose now keeps that prose through a regen.
