# COMP-MCP-VALIDATE-2 — Implementation Report

> Status: COMPLETE. Closes the umbrella COMP-MCP-VALIDATE closed-loop hardening (with siblings -1 and -3, both shipped).

## 1. Summary

Turned the detect-only cross-artifact validator into a closed loop. `compose validate --fix` (and `validate_project {fix:true}` over MCP) reconciles five mechanical drift classes through typed, audited writers. Dry-run by default; `--apply` writes; per-class opt-in keeps destructive/heuristic classes off unless explicitly selected. v1 is local-provider only.

## 2. Delivered vs Planned

| Planned (design) | Delivered |
|---|---|
| Shared-context reconcile pass (validator untouched) | ✅ `reconcileProject` reuses `loadValidationContext`/`loadFeatureContext`; validator unchanged in behavior |
| dangling link → drop | ✅ per-feature `rewriteLinks` (single write, converges) |
| invalid link kind → drop / nearest-allowed | ✅ drop default; `invalid_link_kind_repair` opt-in via `nearestLinkKind` |
| feature.json ↔ vision-state status → reproject | ✅ via `featureStatusToVisionStatus` + `VisionWriter` |
| PARTIAL-without-artifact → age to PLANNED | ✅ opt-in; predicate respects canonical docs + `artifacts[]` + CHANGELOG |
| ROADMAP row status → rewrite | ✅ opt-in; **surgical single-cell edit** (`setRoadmapRowStatus`) after full-regen proved corrupting |
| CLI + MCP surfaces | ✅ `--fix/--apply/--fix-class`; `fix/apply/fix_classes` |

## 3. Architecture Deviations

- **`resyncRoadmap` (full `renderRoadmap`) → `setRoadmapRowStatus` (surgical cell edit).** Implementation probe showed `renderRoadmap()` appends a generated `## Features` section beside hand-authored rows, producing duplicate conflicting rows. Replaced with a column-aware single-cell rewrite that leaves every other byte untouched. (User-approved deviation.)
- **No new validator finding kinds.** Design floated `PARTIAL_WITHOUT_ARTIFACT` / `INVALID_LINK_KIND`; both would double-report and modify the validator. The reconciler derives those conditions from `ctx` instead — validator stays byte-for-byte unchanged.
- **v1 local-provider only.** `GitHubProvider.putFeature`/`renderRoadmap` skip the local existence + narrative guarantees the fixes rely on; reconcile refuses on non-local providers (follow-up for remote support).

## 4. Key Implementation Decisions

- **Link fixes are per-feature, not per-finding** — `putFeature` validates the whole `links[]` array, so one bad link would block fixing another. One corrected array, one write.
- **Status/ROADMAP classes dispatch on validator findings** (post-projection, narrative-suppressed); **link/partial classes derive from ctx**. This inherits the validator's exact semantics and makes `roadmap_status_rewrite` automatically narrative-safe (the finding is suppressed there).
- **Surgical writer mirrors the validator's row parser** and patches the **last** matching row (validator's `Map` last-wins), requires an **alpha** status token, and **refuses escaped-pipe rows** — guaranteeing convergence without corruption.
- **Honest no-op reporting** — guarded refusals are surfaced as `noop`, never claimed as fixes; callers re-validate to confirm convergence.
- **Atomic `writeFeature`** — hardened from bare `writeFileSync` to temp+rename for bulk reconcile safety.

## 5. Test Coverage

- `test/feature-reconciler.test.js` — 18 tests: nearestLinkKind, default class set, dry-run no-write, per-feature link convergence, invalid-kind drop/repair, vision reproject, partial-age (+evidence negative), roadmap surgical apply (no duplicate rows, converges), narrative suppression, mode guard, golden closed-loop, surgical edge cases (last-of-duplicates, non-alpha skip, non-canonical alpha convergence, escaped-pipe refusal, emphasis preservation).
- `test/cli-validate-fix.test.js` — 4 tests: dry-run plan/no-write, `--apply` heals, `--json` includes reconcile, `--help`.
- `test/mcp-validate-fix.test.js` — 4 tests: no-fix plain, dry-run, apply+re-validate, atomic write.
- Full suite: 3483 core + 100 tracker + 146 UI, 0 failures.

## 6. Files Changed

- `lib/feature-reconciler.js` (new) — engine, class registry, `nearestLinkKind`
- `lib/feature-writer.js` — `rewriteLinks`, `setRoadmapRowStatus`, exports `getProvider`/`isLocalProvider`
- `lib/feature-json.js` — atomic `writeFeature`
- `lib/feature-validator.js` — exports `loadValidationContext`/`loadFeatureContext`/`effectiveStatus`
- `bin/compose.js` — `--fix`/`--apply`/`--fix-class`
- `server/compose-mcp-tools.js`, `server/compose-mcp.js` — `fix`/`apply`/`fix_classes`
- 3 new test files

## 7. Known Issues & Tech Debt

- **Remote-provider reconcile** unsupported (local-only). Follow-up if needed.
- **`invalid_link_kind_repair`** edit-distance heuristic (≤2) is conservative; rare typos may fall through to drop.
- Escaped-pipe ROADMAP rows are refused (surfaced as no-ops) rather than fixed — acceptable, the validator mis-parses them too.

## 8. Lessons Learned

- **Implement-time probes catch what blueprint review can't.** The ROADMAP-regeneration corruption only surfaced by actually running `renderRoadmap` on a synthetic fixture — three Codex impl-review iterations then hardened the surgical replacement (duplicate-row last-wins, alpha guard, escaped-pipe refusal, honest no-op).
- **Mirror the detector exactly when building a fixer.** Every convergence bug (external links, duplicate rows, both-side projection) came from the fixer's predicate diverging from the validator's. Matching the validator's semantics is the invariant.
