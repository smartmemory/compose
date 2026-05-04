# COMP-MCP-MIGRATION-2-1 — Implementation Report

## Summary

Originally scoped to bulk-backfill `feature.json` for every legacy `compose/ROADMAP.md` row so typed writers could own roadmap regen. A trial run revealed the data-loss surface (anonymous-row layouts, curated phase-status overrides, non-phase preamble sections) is too large for the simple `migrateRoadmap()` path. Scope reduced to two infrastructure fixes that **prepare** for proper backfill:

1. `migrateRoadmap()` honors `paths.features` overrides.
2. `roadmap-gen.js` no longer truncates feature descriptions to 80 chars on regen — typed writers now round-trip full prose.

Status: **PARTIAL**. Bulk migration deferred to a follow-up that needs design work (parser changes, phase-status overrides, preamble preservation).

## Delivered vs Planned

| Item | Status |
|---|---|
| `migrate-roadmap.js` honors `paths.features` via `loadFeaturesDir` | ✓ |
| `roadmap-gen.js` drops 80-char description truncation | ✓ |
| Bulk backfill of 189 legacy features | DEFERRED (see Architecture Deviations) |
| `compose roadmap backfill` CLI subcommand | DEFERRED — `compose roadmap migrate` already exists |

## Architecture Deviations

The original plan was to run `migrateRoadmap` end-to-end and ship the resulting `feature.json` files. Trial run output:

- 189 features the parser could extract from ROADMAP rows.
- ~226 directories under `docs/features/` after the backfill (some pre-existing folders for in-flight features that the parser doesn't see).
- Regen against the populated tree dropped ROADMAP from 1125 lines → 493 lines because:
  - Phases 0–6 use `# | Item | Status` (anonymous-numbered) tables; the parser emits `_anon_<n>` codes that `migrateRoadmap` correctly skips. ~80% of historical entries can't be migrated this way.
  - Curated phase headings carry richer statuses than the simple rollup `phaseStatus()` computes: `PARKED (Claude Code dependency)`, `PARTIAL (1a–1d COMPLETE, 2 PLANNED)`, `SUPERSEDED by STRAT-1`. These were silently overwritten.
  - `Roadmap Conventions`, `Dogfooding Milestones`, `Execution Sequencing`, and `Key Documents` sections have no `feature.json` equivalent and were dropped entirely.

Reverted the bulk backfill (227 directories restored from HEAD) and shipped only the two narrow fixes. The deferred work needs:
- Parser updates to extract codes from anonymous-numbered rows when surrounding context provides them.
- A `phaseStatusOverride` mechanism (or separate phases manifest) so curated phase statuses survive regen.
- Preserved-section anchors so non-phase content round-trips.

## Files Changed

Edited:
- `compose/lib/migrate-roadmap.js` — default `featuresDir` to `loadFeaturesDir(cwd)` (matches the writer pattern from `COMP-MCP-MIGRATION-2`).
- `compose/lib/roadmap-gen.js` — `renderPhase()` simple-table branch emits the description verbatim (no truncation).

New:
- `compose/docs/features/COMP-MCP-MIGRATION-2-1/{design,report}.md`.

## Test Coverage

No new tests. Both edits are tiny mechanical changes; existing `feature-writer-paths.test.js` (added in `COMP-MCP-MIGRATION-2`) already covers the path-respect behavior, and existing roadmap-parser/regen tests catch any regression in the table-rendering code.

Full suite: 2570 + 92 UI = 2662 tests, all green.

## Known Limitations

- Bulk backfill of legacy ROADMAP rows is **not** delivered. Hand-edit `compose/ROADMAP.md` after typed-writer flips that touch curated phases (Phase 0–6, the milestone-nested phases, top-level non-phase sections) until a proper migration design exists.
- The two infrastructure fixes work in isolation but don't change the practical workflow for compose's own roadmap.

## Lessons Learned

- The "use the existing tool to do the obvious thing" reading of this ticket was wrong. The real work is in lossless round-trip — and that's a much bigger ticket. Recognizing this early (after one trial migration + 226-dir revert) was cheaper than shipping the lossy version.
- Shipping the no-truncation fix is genuinely useful in isolation. Any project that uses typed writers with prose descriptions now keeps that prose through a regen, where previously they'd silently get cut at 80 chars.
- `migrateRoadmap` was already in the codebase, with a similar `featuresDir` default-bug to the writers MIG-2 fixed. Reused it instead of writing a parallel `roadmap-backfill.js`. The original `lib/roadmap-backfill.js` I wrote was deleted before commit.
