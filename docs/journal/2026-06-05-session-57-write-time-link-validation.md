---
date: 2026-06-05
session_number: 57
slug: write-time-link-validation
summary: "COMP-MCP-VALIDATE-1: write-time feature.json link validation (chokepoint shape + delta-aware existence)"
feature_code: COMP-MCP-VALIDATE-1
closing_line: The schema we already had, finally enforced where the data is born — not just where it's read.
---

# Session 57 — COMP-MCP-VALIDATE-1

**Date:** 2026-06-05
**Feature:** `COMP-MCP-VALIDATE-1`

## What happened

We built COMP-MCP-VALIDATE-1, the first slice of the Closed-Loop Hardening umbrella. The validator's feature.json schema + dangling-link rule were enforced ONLY on read; the writers persisted whatever they were given. We wired the same rules in at write time. The interesting part was scoping: two Codex passes on the design/blueprint and three on the implementation kept tightening the boundary. The user asked us to also gate existence at the chokepoint (not just the typed link writer) for maximal closure on raw writes. That decision drove the hardest bug: a whole-object existence check at the chokepoint re-validated EVERY link on EVERY write, so a legitimately forced forward-ref poisoned all later status/build/completion writes to that feature. The fix was to make the chokepoint existence check delta-aware — only validate links a write introduces vs the on-disk prior. Codex round 3 confirmed clean.

## What we built

New lib/feature-write-guard.js (leaf module: assertValidLinkShape, assertLinkTargetsExist [delta-aware], knownFeatureCodes, scanRoadmapRows, FeatureWriteValidationError). Edits: writeFeature chokepoint (opts: validate/allowForwardRefs, reads prior links only when targets present), linkFeatures (early DANGLING error after source-exists guard, no-op precedes dangling check, forced_dangling audit marker), local+github providers (putFeature opts threading; github enforces shape too), feature-scan group write (shape-only by design), both ideabox promote paths routed through writeFeature. Repaired the one shape-invalid corpus file (COMP-ROADMAP-GRAPH-1). New test/feature-write-guard.test.js (25 tests) + updates to feature-linker/xref-sync tests.

## What we learned

1. Whole-object schema validation at a low-level chokepoint is the wrong scope when the schema is intentionally not-yet-tightened — the schema's own comments deferred complexity/artifacts/additionalProperties to SCHEMA-TIGHTEN, and enforcing them broke legitimate writers (build's String(tier), artifact-type enum). Scoping the gate to /links matched the feature's actual charter. 2. Existence checks at a chokepoint MUST be delta-aware (validate what the write introduces, not pre-existing state) or forced/legacy data poisons every subsequent unrelated write. This is the general lesson for any write-time cross-reference guard. 3. Deliberately-bad-data test fixtures (xref-sync's path-traversal repos) need a validate:false fixture-planting escape once write-time validation lands. 4. Source-before-target error ordering matters for UX: a missing source is the more fundamental error than a dangling target.

## Open threads

- COMP-MCP-VALIDATE-2 (reconcile / --fix) and -3 (vision-state projection) remain PLANNED; -2 is the remedy for the ~605-warning backlog this slice does not back-fill.
- COMP-MCP-VALIDATE-SCHEMA-TIGHTEN still owns whole-object schema convergence (complexity enum, artifacts type, additionalProperties:false).
- The GitHub provider enforces link-shape but not target existence (local-folder semantics); revisit if a github-backed workspace needs cross-ref existence.

---

*The schema we already had, finally enforced where the data is born — not just where it's read.*
