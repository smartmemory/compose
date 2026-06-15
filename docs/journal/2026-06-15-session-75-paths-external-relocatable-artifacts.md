---
date: 2026-06-15
session_number: 75
slug: paths-external-relocatable-artifacts
summary: "COMP-PATHS-EXTERNAL: relocatable ROADMAP/features/journal/context/ideabox via one pure resolver; null-SHA commit-less completion; 4-round Codex impl-review"
feature_code: COMP-PATHS-EXTERNAL
closing_line: "The cleanest seam wasn't the one the design drew — implementation taught us the guard belongs in relative space, and the review loop taught us how many consumers a \"simple\" path change really touches."
---

# Session 75 — COMP-PATHS-EXTERNAL

**Date:** 2026-06-15
**Feature:** `COMP-PATHS-EXTERNAL`

## What happened

Ruze asked to let ROADMAP and the features folder live in a different folder from the workspace root (e.g. a shared smart-memory-docs repo), then expanded it to all artifact paths. We brainstormed the design, Codex-gated it (which promoted it M→L by surfacing the featuresDir relative-API contract, the ship→completion coupling, and alternate-root config-cache routes), wrote a sliced blueprint, Codex-gated that too, then ran the full /compose build. S1 (pure resolver + default table) and S2 (sweep ~25 consumers + the featuresDir API migration) landed with strict default-identity. S3 (ship/completion/enforcement git-awareness) was the risk; we paused at a real decision point and Ruze chose to proceed. The implementation review loop ran FOUR Codex rounds, surfacing 10 fixes — most importantly a completion_id aliasing bug, several missed sweep sites (file-watcher, bin/compose feature/promote/init), and the realization that the design's 'make the guard absolute' idea was backwards.

## What we built

New: lib/paths-core.js (pure DEFAULT_PATHS + resolvePathValue using path.resolve, not join + relForDisplay); absolute readers + *FromConfig forms in lib/project-paths.js; paths.roadmap config key. Migrated: feature-json/feature-write-guard to absolute-safe featuresDir; ~25 consumer sites across lib/server/bin; completion-writer to accept a commit-less (null-SHA) completion; build.js ship to record completion on every exit + log external artifacts + resolve the item dir absolutely while keeping the guard's featuresDir relative. Tests: paths-core, feature-json-external, completion-writer-nocommit, integration/paths-external. Docs: CHANGELOG, docs/configuration.md paths block.

## What we learned

1. A 'simple' path-config change is a wide blast radius: defaults were duplicated in 4 places and consumers split across hardcoded literals, join-based config reads, and a relative-string API contract (feature-json). 2. path.resolve vs path.join is the whole ballgame — join silently re-roots an absolute override under cwd; every site had to switch. 3. Implementation can invert a design decision: D6c said make the enforcement guard absolute; the guard matches repo-relative git status, so absolute would BREAK it — the correct fix was keeping the guard relative and fixing the filesystem resolver instead. Record the deviation, don't force the design. 4. A sentinel (git's null-SHA) beat a nullable schema field — schema-valid, no migration — but the completion_id must still be derived distinctly or all commit-less completions alias. 5. Multi-round Codex impl-review earns its keep: rounds 2-4 each found re-root sites the parallel sweep agents missed (file-watcher listing, init context/roadmap, CLI promote). The review loop is where unwired/half-swept deliverables surface.

## Open threads

- COMP-PATHS-EXTERNAL-1: cross-repo auto-commit of external artifacts + full external-canon enforcement coverage (both guard subsystems are workspace-relative).
- Absolute paths.docs through the /api/files canvas may not fully round-trip via safePath (file ids become absolute) — edge of an edge, not the core ask.
- Server (:4001) wasn't running this session, so session-bind was skipped; completion recorded via stdio MCP.

---

*The cleanest seam wasn't the one the design drew — implementation taught us the guard belongs in relative space, and the review loop taught us how many consumers a "simple" path change really touches.*
