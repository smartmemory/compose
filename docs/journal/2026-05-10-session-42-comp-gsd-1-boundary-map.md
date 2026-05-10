---
date: 2026-05-10
session_number: 42
slug: comp-gsd-1-boundary-map
summary: COMP-GSD initiative filed (gsd-build/gsd-2 parity); GSD-1 Boundary Map shipped end-to-end through Compose's own lifecycle.
feature_code: COMP-GSD-1
closing_line: Compose's first feature delivered through Compose's own lifecycle.
---

# Session 42 — COMP-GSD-1

**Date:** 2026-05-10
**Feature:** `COMP-GSD-1`

## What happened

Started from a question — "can we have parity with gsd-build/gsd-2 and a `/compose gsd <X>` mode?" Pushed back on scoping that as one ticket: it's actually 7 distinct capabilities (per-task fresh context, worktree isolation, budget ceilings, stuck detection, milestone reports, headless CLI, plus the boundary map already on the roadmap). Filed COMP-GSD as an initiative with 4-wave sequencing, scaffolded all 8 feature folders, then pushed Wave 1 (COMP-GSD-1 Boundary Map) through the full lifecycle end-to-end.

Along the way, the scaffold tool surfaced a real bug — `mcp__compose__scaffold_feature` writes vision-item defaults of `status: complete, phase: verification` for fresh features. Filed as `COMP-SCAFFOLD-DEFAULTS`. Since there's no public MCP tool to update vision items directly, patched `.compose/data/vision-state.json` with a Python one-liner; server didn't overwrite the edit.

Design phase converged after 15 Codex review iterations. Each round was small but real — symbol-presence semantics for edited files, action-verb decoration (`MODIFY (existing, 119 lines)`), sink-slice form, the `tsc` claim that doesn't hold in this repo, parse-error vs entry-error shape splits, validator-vs-authoring contract alignment. The design that emerged is precise to the field-shape level. Plan and implementation each converged in 3 rounds.

Phase 5 verification surfaced that the original dogfood target (`COMP-OBS-STREAM`) had no `## File Plan`, which would have made the worked example fail its own validator. Swapped to `COMP-MCP-MIGRATION-2-1-1` — that blueprint has a real `## File-by-File Plan` (alias support paid off immediately) and three natural slices.

Feature shipped: 41 dedicated tests, full suite 2878 passing, REVIEW CLEAN at every gate, four post-merge follow-ups filed for v1's deliberate trade-offs (substring-grep, no tsc pipeline, markdown-anchor self-dogfood, nested File Plan tables).

## What we built

**New code & artifacts**
- `lib/boundary-map.js` — parser + 4-check validator. Returns `{ ok, violations, warnings }` per the design's exact Violation/Warning shape (parse vs entry vs blueprint vs file-plan scopes). Four checks: file-or-FilePlan (with action-verb extraction so `MODIFY (existing, 119 lines)` normalizes to `modify`), symbol-presence (substring grep, only for pre-existing files NOT in File Plan), topology (every `from S##:` references earlier slice; document-order acyclic), producer/consumer match.
- `test/boundary-map.test.js` — 41 tests covering parser, all four checks, both warning kinds, parse violations, leaf+sink forms, both `→` and `->` arrow alternatives, duplicate slice IDs, post-`nothing` malformation, File Plan duplicate-row write detection, contract field shape.
- `.claude/skills/compose/templates/boundary-map.md` — author template with format spec and worked example.

**Modified**
- `.claude/skills/compose/SKILL.md` — Phase 4 prompt teaches authors to write the section when feature has 2+ work units (kind-restricted). Phase 5 prompt invokes the validator.
- `pipelines/build.stratum.yaml` — verification step intent extended; results summarized in existing `PhaseResult.summary` (no schema widening).
- `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` — first retroactive Boundary Map annotation.

**Initiative + bookkeeping**
- `forge/ROADMAP.md` — COMP-GSD initiative section (8 features, 4 waves), GSD-1 flipped to COMPLETE, follow-ups filed, COMP-SCAFFOLD-DEFAULTS filed.
- All 8 GSD feature folders scaffolded at `compose/docs/features/COMP-GSD*/`; `feature.json` files written with correct statuses (umbrella + GSD-1 IN_PROGRESS at start, GSD-2..7 PLANNED).
- `vision-state.json` patched directly to fix scaffold defaults until COMP-SCAFFOLD-DEFAULTS lands.
- `CHANGELOG.md` entry above the COMP-MOBILE entry.

## What we learned

1. **Scoping debt comes due in Codex iterations.** Design needed 15 review rounds to converge. Each finding was real, but the *shape* of the spec (validator + authoring contract + Phase 5 integration + downstream test guidance + dogfood) is broad enough that codex kept finding leaf gaps. Per `feedback_codex_review_convergence.md`, this is the "spec too broad" signal — the cure is narrower v1 scope, not more iterations. v1 ended up correctly narrow (opt-in, no Phase 5 gate on absence, name-mention symbol check, no type compat) but the design doc itself tried to be exhaustive.
2. **Two-store mismatch.** `feature.json` (canonical, drives ROADMAP regen) and `vision-state.json` (cockpit UI state) are separate. `set_feature_status` only updates the former. Scaffold writes both, but with different defaults — bad. The MCP doesn't expose a vision-item updater. Filing COMP-SCAFFOLD-DEFAULTS is the right fix.
3. **Heading aliases were the right call.** v1 supports `## File Plan` / `## Files` / `## File-by-File Plan` because three different blueprint corpora use three different headings. Standardizing to one would have broken the dogfood. Validator's job is to meet the corpus where it is, not legislate.
4. **Action-verb decoration is real.** Existing blueprints use `MODIFY (existing, 119 lines)`, not bare `modify`. Leading-verb extraction before allow-list match is the cheapest correct rule — found via Codex review, not foresight.
5. **Parse violations need their own scope.** Adding `scope: "parse" | "entry"` to Violation, and `scope: "blueprint" | "file-plan" | "entry"` to Warning, was a Codex finding that turned the validator output from a flat list into a debuggable contract. Worth doing in any future structured-output validator.
6. **`set_feature_status` writes feature.json AND ROADMAP.md transactionally.** That's what made the lifecycle ergonomic — one call per status flip and the ROADMAP table updates itself.
7. **Subagents kept the orchestrator's context lean.** Phase 4 (blueprint), Phase 6 (plan), Phase 7 (impl), and the two contract-fix passes were all dispatched. The orchestrator only ran the design loop and the gate dialogues directly. With ~80% of the writing delegated, a 15-round Codex design plus 3-round plan plus 3-round impl review fit comfortably.

## Open threads

- [ ] Commit the changes (left uncommitted per skill — orchestrator handles in Phase 10 / user authorizes)
- [ ] `COMP-GSD-1-FU-EXPORT-CHECK` — tighten symbol-presence from substring-grep to definition/export-anchored regex per kind
- [ ] `COMP-GSD-1-FU-TYPECHECK` — real `tsc --noEmit` for type-only entries (compose package needs TS pipeline)
- [ ] `COMP-GSD-1-FU-MARKDOWN-DOGFOOD` — COMP-GSD-1's self-Boundary-Map declares markdown anchors with kind `(const)`; revisit when FU-EXPORT-CHECK lands
- [ ] `COMP-GSD-1-FU-FILEPLAN-HEADER-DETECT` — validator picks up nested `| Section | Lines | ... |` tables under `## File-by-File Plan` as File Plan rows; tighten parser to require recognized `| File | Action | Purpose |` header
- [ ] `COMP-SCAFFOLD-DEFAULTS` — fix scaffold's bad vision-item defaults (1-line fix in the scaffold handler)
- [ ] Wave 2 — COMP-GSD-2 (per-task fresh-context dispatch) + COMP-GSD-3 (worktree-per-task isolation) batched. The load-bearing autonomy primitives.
- [ ] Wave 3 — COMP-GSD-4 (budget ceilings) + COMP-GSD-5 (stuck detection)
- [ ] Wave 4 — COMP-GSD-6 (headless CLI + crash recovery) + COMP-GSD-7 (HTML milestone reports)

---

*Compose's first feature delivered through Compose's own lifecycle.*
