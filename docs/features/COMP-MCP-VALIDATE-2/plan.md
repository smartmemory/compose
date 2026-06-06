# COMP-MCP-VALIDATE-2 — Implementation Plan

> Derived from [`blueprint.md`](./blueprint.md). Use symbols/signatures from the blueprint Boundary Map. TDD per task.

## Task 1 — Export shared builders (S1) `lib/feature-validator.js` (existing)
- [ ] Export `loadValidationContext`, `loadFeatureContext`, `effectiveStatus` (visibility only, no behavior change)
- [ ] Test: importing the three symbols works; `loadValidationContext(tmpRepo)` returns ctx with `narrativeOwned`, `featureJsonMode`, `foldersByCode`

## Task 2 — Atomic write + provider exports (S2) `lib/feature-json.js`, `lib/feature-writer.js` (existing)
- [ ] `writeFeature` writes via temp + `renameSync` (unlink-on-error); behavior otherwise identical
- [ ] Export `getProvider`, `isLocalProvider` from `feature-writer.js`
- [ ] Test: `writeFeature` round-trips; a forced write error leaves no `.tmp` file behind

## Task 3 — `rewriteLinks` + `resyncRoadmap` writers (S2) `lib/feature-writer.js` (existing)
- [ ] `rewriteLinks(cwd, {from_code, links, idempotency_key})` → `provider.putFeature(from_code, {...feature, links})`; audit `tool:'rewrite_links'`; `maybeIdempotent` envelope
- [ ] `resyncRoadmap(cwd, {code, idempotency_key})` → `provider.renderRoadmap()`; audit `tool:'resync_roadmap'`
- [ ] Test: `rewriteLinks` dropping a dangling entry + repairing an invalid kind in one call persists the corrected array and passes VALIDATE-1 (no new targets introduced)
- [ ] Test: `resyncRoadmap` regenerates a stale ROADMAP row from canonical feature.json

## Task 4 — Reconciler engine (S3) `lib/feature-reconciler.js` (new)
- [ ] `FIX_CLASSES` registry with `{default, source, mutatesFeatureJson, derive, apply}` per blueprint
- [ ] `nearestLinkKind(bad)` — Levenshtein ≤2, unique-min, else null
- [ ] `reconcileProject(cwd, {apply, classes, scope, code, featureJsonMode, externalPrefixes, external})`:
  - [ ] Provider guard: non-local → `{refused:'non_local_provider', plan:[], counts:{}}`, no writes
  - [ ] Runs `validateProject(cwd, opts)` for finding-sourced classes; builds `ctx` for ctx-sourced classes
  - [ ] Mode guard: `featureJsonMode===false` drops `mutatesFeatureJson` classes with a skip reason
  - [ ] Link fixes grouped per `feature_code` → single `rewriteLinks` plan entry
  - [ ] Dry-run (`apply:false`) returns plan, writes nothing
  - [ ] `apply:true` executes per-entry (best-effort), returns `{plan, counts, applied}`
- [ ] Default class set = `{dangling_link, invalid_link_kind (drop), status_fj_vision}`; opt-in = `{partial_age, roadmap_status_rewrite, invalid_link_kind_repair}`

## Task 5 — CLI surface (S4) `bin/compose.js` (existing)
- [ ] `--fix`, `--apply`, `--fix-class=<csv>` flags; `--help` updated
- [ ] Dry-run prints per-class `before → after`; `--apply` prints applied summary; `refused` → message + exit 2
- [ ] `--json` includes reconcile result; exit code reflects findings remaining after apply
- [ ] Test (spawn `bin/compose.js`): `--fix` writes nothing; `--fix --apply` clears the seeded drift on re-validate

## Task 6 — MCP surface (S4) `server/compose-mcp.js`, `server/compose-mcp-tools.js` (existing)
- [ ] `validate_project` inputSchema gains `fix`, `apply`, `fix_classes`
- [ ] `toolValidateProject` forwards `feature_json_mode`/`external_prefixes`/`external` to `reconcileProject`; returns `{...validateResult, reconcile}`
- [ ] Test: MCP `validate_project {fix:true}` returns a plan; `{fix:true, apply:true}` heals drift

## Task 7 — Golden closed-loop test (both modes' exit criterion)
- [ ] Seed a temp repo with all five drift classes (dangling link, invalid kind, fj↔vision status, PARTIAL-no-evidence, ROADMAP↔fj status on a non-narrative workspace)
- [ ] `reconcileProject(apply:true, classes:<all>)` → re-`validateProject` shows those findings cleared
- [ ] Narrative-owned variant: `roadmap_status_rewrite` is a no-op (finding suppressed); ROADMAP prose untouched
- [ ] Non-local provider: reconcile refuses, no writes

## Exit criteria (Phase 7)
- [ ] All tasks' tests pass (TDD: red → green per task)
- [ ] Full `npm test` green
- [ ] Codex review loop → REVIEW CLEAN
- [ ] Coverage sweep → TESTS PASSING
