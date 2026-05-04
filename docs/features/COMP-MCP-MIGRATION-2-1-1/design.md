# COMP-MCP-MIGRATION-2-1-1: Lossless ROADMAP.md Round-Trip — Design

**Status:** DESIGN
**Date:** 2026-05-04

## Related Documents

- Parent: [`COMP-MCP-MIGRATION-2-1`](../COMP-MCP-MIGRATION-2-1/) (PARTIAL — surfaces this ticket)
- Grandparent: [`COMP-MCP-MIGRATION-2`](../COMP-MCP-MIGRATION-2/) (COMPLETE)
- Sibling: [`COMP-MCP-ROADMAP-WRITER`](../COMP-MCP-ROADMAP-WRITER/) (the typed writer this ticket makes lossless)
- Roadmap row: `compose/ROADMAP.md` Phase 7 row 13

## Why

`COMP-MCP-MIGRATION-2-1` attempted bulk backfill of 189 historical compose features and discovered three structural blockers that each alone breaks lossless round-trip. The trial run dropped `compose/ROADMAP.md` from 1125 → 493 lines. Trial was reverted; the three blockers were diagnosed in MIG-2-1's design + report. This ticket is the proper redesign once those blockers are individually scoped.

The three blockers, with concrete examples observed in `compose/ROADMAP.md`:

1. **Anonymous-numbered tables.** Phases 0–4.5 use `| # | Item | Status |` (3-column) with `— ` in the # column instead of a feature code. The parser already emits `_anon_<n>` for these; the writer drops them. ~10 such rows in compose; representative sample: `| — | Discovery, requirements, PRD, UI-BRIEF | COMPLETE |`. Mass backfill cannot proceed without a policy for these rows.

2. **Phase-status overrides.** 9 phase headings carry curated status text richer than what `phaseStatus()` rollup can reconstruct. Examples: `PARKED (Claude Code dependency)`, `PARTIAL (1a–1d COMPLETE, 2 PLANNED)`, `SUPERSEDED by STRAT-1`, `PARTIAL (RT-1/2/3 complete, RT-4 deferred)`, `PARTIAL (SURFACE-4 complete; SURFACE-1/2/3 planned)`. Regen replaces these with whatever the rollup computes — silently lossy.

3. **Preserved non-feature sections.** Four sections have no `feature.json` equivalent and are stripped entirely on regen: `## Roadmap Conventions` (lines 11–19), `## Dogfooding Milestones` (859–870), `## Execution Sequencing` (871–981, includes a code-block dependency graph + 5 Wave tables), `## Key Documents` (982–1002).

After this ships, mass backfill of compose's 189 historical features becomes possible without data loss, and `ROADMAP_PARTIAL_WRITE` stops firing during normal typed-writer flips.

## Goal

Make `lib/roadmap-parser.js` + `lib/roadmap-gen.js` round-trip lossless for the three categories above. Specifically: every byte of curated content in `compose/ROADMAP.md` survives a parse → no-op mutate → stringify cycle. Drift between curated overrides and typed-tool state is detected and surfaced as a warning, not silently overwritten.

**Out of scope:**
- The `/compose migrate-anon` interactive flow for promoting historical anonymous rows to typed features (filed as follow-up `COMP-MCP-MIGRATION-2-1-1-1`).
- Bulk backfill of the 189 historical features. This ticket unblocks that work; the backfill itself is `COMP-MCP-MIGRATION-2-1`'s remaining scope.
- Round-trip fidelity for non-ROADMAP markdown (CHANGELOG, journal, etc.). Same parser swap could be reused later, not in scope here.

---

## Decision 1: Parser strategy — switch to remark/unified

**Picked:** Switch `lib/roadmap-parser.js` and `lib/roadmap-gen.js` from hand-rolled regex to `unified` + `remark-parse` + `remark-stringify` + `remark-gfm`.

**Rationale:** `remark-gfm` is already in `package.json` for react-markdown. Adopting it in `lib/` gives us proper AST + position tracking + lossless round-trip semantics that the ecosystem maintains. The three downstream decisions in this ticket assume an AST is available. Hand-rolled augmentation was the cheaper path (smaller diff) but doesn't fix lack of source-position tracking, so we'd be solving the same problem again the next time round-trip fidelity matters.

**Cost:** Refactor every importer of `lib/roadmap-parser.js` and `lib/roadmap-gen.js`. Estimated 5–8 files in `compose/lib/`, 2–3 server routes, 1 test file replaced + new tests written. Larger diff, one-time investment. Same parser plumbing then becomes available for future markdown round-trip needs (CHANGELOG, journal) without further work.

**Rejected:** Hand-rolled augmentation with three targeted patches. Dismissed because each of the three downstream decisions becomes substantially harder without a real AST (especially Decision 4's comment-marker handling).

---

## Decision 2: Phase-status override storage — heading node is canonical

**Picked:** The remark heading node *is* the canonical store for phase status. The writer reads the override directly from the AST node when present and falls back to `phaseStatus()` rollup only when absent.

**Rationale:** With a real AST in hand, anything else introduces a second source of truth. Override text typed by a human is authoritative; rollup is the fallback when no human has touched it.

**Drift policy:** When the rollup-computed status would differ from the curated override (e.g. all features in a `PARTIAL` phase are now `COMPLETE`), the writer:
1. Keeps the override (does not overwrite)
2. Emits a structured `RoadmapDrift` event into the same audit log used by other typed writers (`.compose/data/events.jsonl`)
3. Prints a warning to stderr of the form `WARN: phase "<name>" override "<text>" diverges from rollup "<text>". Edit ROADMAP.md or call set_phase_status_override to acknowledge.`

The drift event includes `{phase, override, computed, build_id}` so the cockpit drift surface (already wired for `ROADMAP_PARTIAL_WRITE`) can render it.

**Migration:** No schema change; no manifest file. First parse extracts every existing override into the AST naturally. Nothing to backfill.

**Rejected:** Sidecar `phases.json` manifest (introduces a second source of truth, requires migration extraction pass, needs a typed tool to mutate). `phaseStatusOverride` field on a "phase representative" feature.json (depends on position stability and the representative not being deleted — fragile coupling).

---

## Decision 3: Anonymous-row policy — verbatim passthrough; interactive promotion follow-up

**Picked:** Anonymous rows (any table row whose `#` cell is `—` or empty AND whose row position cannot be mapped to a `feature.json`) are preserved as raw remark `tableRow` AST nodes attached to their phase. On regen, the writer emits typed-feature rows from feature.json first, then appends the preserved anonymous rows verbatim in their parsed order at the end of the table.

**Properties:**
- No `feature.json` files generated for anonymous rows.
- No typed-tool path can mutate them. `set_feature_status("_anon_3", ...)` returns `not_found` (the `_anon_<n>` codes are no longer surfaced to typed tools — they're internal AST positions only).
- To edit an anonymous row, the human edits `ROADMAP.md` directly. The writer round-trips the edit unchanged.
- To promote an anonymous row to a typed feature, the human creates a `feature.json` whose phase + position matches the row, and the writer replaces the anonymous row with a typed row on next regen.

**Why this beats code-synthesis:** Slug codes generated from row titles (`phase0-discovery-requirements-prd-ui-brief`) are fragile across title edits, produce ghost feature.json files, and don't carry meaningful identity. The historical rows are shipped work — the code's not coming back to mutate them.

**Follow-up filed:** `COMP-MCP-MIGRATION-2-1-1-1` — `/compose migrate-anon` interactive flow that walks anonymous rows one at a time and prompts for a code (or "leave anonymous"). Optional, deferred. Filed at end of this design.

---

## Decision 4: Preserved-section anchors — HTML comment markers

**Picked:** Wrap each non-feature section with HTML comment markers:

```markdown
<!-- preserved-section: roadmap-conventions -->
## Roadmap Conventions

- **No co-author** ...

<!-- /preserved-section -->
```

The remark parser produces `html` AST nodes for these comments. The writer treats any subtree bounded by a `<!-- preserved-section: <id> -->` / `<!-- /preserved-section -->` pair as opaque — emitted byte-for-byte unchanged.

**Properties:**
- Section position is encoded structurally in the file itself. If a human rearranges sections, the markers move with the content; no external position map to drift.
- Markers are invisible in rendered markdown (HTML comments).
- Adding a new preserved section is a 2-line markup change; no code change.
- The `<id>` is used only for diagnostics (e.g. drift warnings, validation errors) — duplicate ids warn but don't block.

**One-time migration:** Wrap the four existing sections (`Roadmap Conventions`, `Dogfooding Milestones`, `Execution Sequencing`, `Key Documents`) with markers. ~8 lines of markup added across the file; no content change.

**Validation:** A `validate_roadmap` check (extends existing `validate_feature` / `validate_project` infra) flags unbalanced markers, empty marker bodies, and unknown `<id>` collisions. Pre-push hook gates drift before it leaves the dev's machine.

**Rejected:** Position-stable passthrough by heading text (implicit coupling — "after which heading?" map breaks when humans rearrange). Sibling `roadmap-extras.md` (worst authoring ergonomics — Conventions has to live in a separate file even though it currently sits at the top of ROADMAP.md, and append-point conventions get fragile).

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `compose/lib/roadmap-parser.js` | rewrite | Replace hand-rolled regex with unified/remark-parse + remark-gfm. Output schema unchanged where possible; adds `phaseStatusOverride`, `anonymousRows`, `preservedSections` to AST output. |
| `compose/lib/roadmap-gen.js` | rewrite | Replace string concatenation with remark-stringify. Honor `phaseStatusOverride`, append preserved anonymous rows, emit preserved sections verbatim from `html` AST nodes. |
| `compose/lib/migrate-roadmap.js` | update | Aware of anonymous-row passthrough — no longer skips them, no longer attempts to backfill them as feature.json. |
| `compose/lib/roadmap-drift.js` | new | Drift detection + event emission. Compares heading override against `phaseStatus()` rollup, writes `RoadmapDrift` events to audit log. |
| `compose/contracts/roadmap-row.schema.json` | extend | Add `phaseStatusOverride` (string, optional), drop schema constraint that anon rows must have a code. |
| `compose/contracts/preserved-section.schema.json` | new | Schema for preserved-section markup (id, content). |
| `compose/test/roadmap-roundtrip.test.js` | new | Round-trip golden test: parse `ROADMAP.md` → no-op stringify → bytes equal (modulo trailing whitespace normalization). Covers all 9 override patterns, 10 anonymous rows, 4 preserved sections. |
| `compose/test/roadmap-parser.test.js` | update | Migrate existing tests to AST-based assertions. Anonymous-row tests assert AST passthrough, not `_anon_<n>` codes. |
| `compose/test/roadmap-drift.test.js` | new | Drift event emission, override-vs-rollup divergence cases. |
| `compose/server/compose-mcp.js` | minor | Wire `set_phase_status_override(phase, text)` typed tool (writes the heading text directly via the AST). |
| `compose/ROADMAP.md` | edit | Wrap 4 preserved sections with `<!-- preserved-section: <id> -->` markers. One-time markup migration. |
| `compose/package.json` | update | Add `unified`, `remark-parse`, `remark-stringify` deps. `remark-gfm` already present. |

---

## Open Questions

1. **Position normalization.** When the writer reorders typed-feature rows by `position`, anonymous rows are appended at the end of the phase's table. Is that the right policy when the original file had an anonymous row interleaved between typed rows? **Proposed:** track each anonymous row's parsed-order position relative to its neighbors; on regen, insert anonymous rows at the same relative position. If neighbors have moved, anonymous row stays adjacent to its nearest surviving neighbor. Decide during blueprint.

2. **Comment-marker syntax for nested constructs.** `## Execution Sequencing` contains 5 sub-tables and a code block. Wrapping the entire section in `<!-- preserved-section -->` works for opaque preservation, but if any of those Wave tables ever needs to become a typed-feature surface, the marker has to move. **Proposed:** acceptable risk for now; revisit if Waves are promoted to typed features (separate ticket).

3. **`set_phase_status_override` MCP tool — needed in v1?** Decision 2 says headings are canonical; humans edit them directly. Adding a typed tool to set the override is a convenience for cockpit/automation use. **Proposed:** ship the tool in v1 (small addition once the AST is wired) but no UI surface yet. Cockpit gets it for free if/when needed.

4. **Drift-event SLA.** When the writer detects override-vs-rollup drift, should it (a) write the event silently and continue, (b) write the event and exit non-zero, or (c) write the event and require explicit `--accept-drift` flag? **Proposed:** (a) by default, with a config flag `enforcement.roadmapDrift: 'warn' | 'block' | 'silent'` mirroring the existing `enforcement.mcpForFeatureMgmt` three-mode pattern. Decide during blueprint.

---

## Follow-ups Filed

- `COMP-MCP-MIGRATION-2-1-1-1` — `/compose migrate-anon` interactive flow for promoting historical anonymous rows to typed features. Walks rows one at a time, prompts for a feature code, scaffolds `feature.json`. Optional, deferred.
