# COMP-MCP-VALIDATE-2 — Implementation Blueprint

> **Status: BLUEPRINT (Phase 4–5).** File:line references verified against the working tree on 2026-06-06. Pins exact symbols, signatures, and insertion points for implementation.

## Related Documents
- [`design.md`](./design.md) — Phase 1 design & approach decisions
- Forward: [`plan.md`](./plan.md), [`report.md`](./report.md)

## Architecture summary

A new **`lib/feature-reconciler.js`** module exports `reconcileProject(cwd, opts)`. It runs the **real validator** (`validateProject(cwd, opts)`) to get authoritative, post-projection, narrative-suppressed findings, and also builds the *same* `ctx` via the validator's (now-exported) `loadValidationContext`/`loadFeatureContext`. **Status/ROADMAP fix classes dispatch on the validator's findings** (so they inherit exact post-projection semantics and narrative suppression); **link + partial classes derive from `ctx`** (no clean finding exists for them — see C1). It produces a dry-run fix plan and on `apply:true` executes each fix through a typed writer. Two new writers (`rewriteLinks`, `resyncRoadmap`) are added to `lib/feature-writer.js`; `writeFeature` is hardened to an atomic write. CLI and MCP surfaces gain `fix`/`apply`/`fix-class` parameters.

**v1 is local-provider only.** Every fix flows through provider writes whose safety guarantees (delta-aware existence guard, narrative-aware `renderRoadmap`) hold for `LocalFileProvider` but **not** for `GitHubProvider` (which skips local existence semantics and writes merged ROADMAP content directly — github-provider.js:125-129, :517-524). `reconcileProject` therefore refuses (clear error, no writes) when the active provider is not local; GitHub-backed reconcile is a documented follow-up. This resolves the provider-divergence and narrative-on-GitHub hazards in one guard.

The validator (`validateProject`/`validateFeature`/`finding`) is **not modified in behavior** — see Correction C1.

## Corrections table (spec assumption vs reality)

| # | Design assumption | Reality | Resolution |
|---|---|---|---|
| C1 | Add new validator finding kinds `PARTIAL_WITHOUT_ARTIFACT` and `INVALID_LINK_KIND`. | Invalid link `kind` already surfaces as `FEATURE_JSON_SCHEMA_VIOLATION` (`runSchemaChecks`, feature-validator.js:360-365) — a second kind would **double-report**. Adding kinds also *modifies the validator*, contradicting the "validator untouched / pure detect" decision. | **Do not add finding kinds.** The reconciler derives both conditions from `ctx` during its own pass (invalid kind: rescan `links[].kind ∉ LINK_KINDS∪{external}`; partial: `status==='PARTIAL'` + evidence-absent). Validator stays byte-for-byte unchanged. |
| C2 | A per-feature `rewriteLinks` writer handles drop + repair in one write. | `linkFeatures` (feature-writer.js:572) is add/upsert-only; `putFeature`→`writeFeature` re-validates the **whole** `links[]` array (feature-json.js:57-68) with a **delta-aware** existence check (only links the write *introduces* are existence-checked, :64-67). | A `rewriteLinks` that drops danglings and repairs kinds introduces **no** new targets, so the delta-aware guard passes. Confirmed safe. |
| C3 | `setFeatureStatus` can rewrite a stale ROADMAP row; failing that, a `resyncRoadmap` that calls `renderRoadmap()`. | `setFeatureStatus` short-circuits as noop when `from===to` (feature-writer.js:310-312). **AND** `renderRoadmap()` does NOT cleanly replace a hand-authored ROADMAP — it appends a generated `## Features` section beside the original rows, leaving duplicate conflicting rows (verified in impl via probe). Full regeneration is unsafe on any ROADMAP not already in exact generated form. | New **`setRoadmapRowStatus(cwd, {code, status})`** writer does a **surgical single-cell edit**: mirrors the validator's column-aware parser to locate the row by code, rewrites only the Status token (preserving spacing/emphasis), atomic write, audit event. Leaves every other byte untouched → converges on `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON` without touching roundtrip/lossy state. |
| C4 | PARTIAL predicate keys off `ArtifactManager.assess()`. | `assess()` only knows the 6 canonical docs; the validator also treats `featureJson.artifacts[]` (feature-validator.js:567) and CHANGELOG mentions as real evidence. | Predicate = `status==='PARTIAL'` AND `assess()` shows no canonical docs AND `featureJson.artifacts[]` empty AND CHANGELOG.md does not mention the code. |
| C5 | Dangling-link drop is always safe. | The validator flags **all** unresolved `to_code`s as `DANGLING_LINK_FEATURES_TARGET` (feature-validator.js:593-601), including intentional forced forward-refs (no "intentional" marker is persisted). | Acceptable: the validator already reports these as **errors**, so a clean workspace has none. Documented in design Risks; dropping is consistent with the reported drift. |
| C6 | Status drift can be re-derived from `ctx` as `featureStatusToVisionStatus(fj.status) !== visionStatus`. | The validator projects **both** sides before comparing (`rVis/vVis`, feature-validator.js:441, :459), so a legacy vision value like `partial` is treated as aligned with feature `PARTIAL` — a naive re-derive would over-report. | Status/ROADMAP classes **dispatch on the validator's emitted findings**, not a re-derive, inheriting exact semantics + narrative suppression. |
| C7 | Reconcile can call `loadValidationContext(cwd, {})`. | `validate_project` accepts `feature_json_mode`/`external_prefixes` (compose-mcp.js:376) which `loadValidationContext` consumes (:256). In `feature_json_mode:false`, feature.json isn't canonical. | `reconcileProject` forwards the same options; when `featureJsonMode===false` it **skips all feature.json-mutating classes** (a clear no-op with reason), since feature.json is not the source of truth in legacy mode. |
| C8 | A GitHub-backed provider is safe behind `putFeature`/`renderRoadmap`. | `GitHubProvider.putFeature` enforces only link shape, skips local existence (github-provider.js:125-129); `GitHubProvider.renderRoadmap` writes merged ROADMAP with no narrative no-op (:517-524). | v1 **local-provider only** — reconcile refuses on non-local providers. |
| C9 | Dangling-link derive can exclude `kind:"external"` links. | The validator's cross-feature check (feature-validator.js:593-601) flags **any** link with an unresolved `to_code` as dangling — it does NOT special-case external. Excluding external in the fixer means a malformed `{kind:'external', to_code:…}` link is reported as dangling but never fixed → non-convergence (found by Codex impl-review). | Reconciler's dangling predicate mirrors the validator **exactly** (no external exclusion). Well-formed external links carry no `to_code` so the `link.to_code &&` guard skips them; only a malformed external link with an unresolved target is dropped — matching what the validator flags. |

## Boundary Map

| Symbol | Kind | Slice | Producer / Consumer | Notes |
|---|---|---|---|---|
| `loadValidationContext` | function | S1 | producer (export from feature-validator.js:127) | Currently module-private; add to exports. Consumed by `reconcileProject`. |
| `loadFeatureContext` | function | S1 | producer (export from feature-validator.js:275) | Add to exports. Builds per-feature `fctx`. |
| `effectiveStatus` | function | S1 | producer (export from feature-validator.js:270) | Add to exports. Canonical status resolution reused by reconciler. |
| `rewriteLinks` | function | S2 | producer (new, feature-writer.js) | `rewriteLinks(cwd, {from_code, links, idempotency_key})` → `provider.putFeature`; audit event `tool:'rewrite_links'`. Consumed by reconciler link fixers. |
| `setRoadmapRowStatus` | function | S2 | producer (new, feature-writer.js) | `setRoadmapRowStatus(cwd, {code, status, idempotency_key})` → surgical single-cell edit of the ROADMAP row's Status cell + audit `tool:'set_roadmap_row_status'`. **Replaced the originally-planned `resyncRoadmap`/`renderRoadmap` approach** — full regeneration appends a generated section beside hand-authored rows, producing duplicate conflicting rows (discovered in impl; see C3). Consumed by `roadmap_status_rewrite` fixer. |
| `featureStatusToVisionStatus` | function | S3 | consumer (status-projection.js:33) | Existing. Used by `status_fj_vision` fixer. |
| `FIX_CLASSES` | const | S3 | producer (new, feature-reconciler.js) | Registry: `{key → {default: bool, derive(ctx,fctx), apply(cwd,plan)}}`. |
| `reconcileProject` | function | S3 | producer (new, feature-reconciler.js) | `reconcileProject(cwd, {apply, classes, scope, code}) → {scope, plan, counts, applied}`. Consumed by CLI (from S2 writers) + MCP. |
| `nearestLinkKind` | function | S3 | producer (new, feature-reconciler.js) | Edit-distance → nearest `LINK_KINDS` member or null. |

Topology: S2 writers depend on no earlier new symbol; S1 exports precede S3 (`reconcileProject` consumes S1 + S2); CLI/MCP wiring (S4) consumes S3.

## Slices

### S1 — Export the shared context builders (`lib/feature-validator.js`)
- Add `loadValidationContext`, `loadFeatureContext`, `effectiveStatus` to the module's `export` surface (functions at :127, :275, :270). **No behavior change** — pure visibility.
- Confirm `ctx` carries everything the reconciler needs: `cwd, paths, roadmapByCode, visionByCode, foldersByCode, featureJsonMode, narrativeOwned, externalPrefixes` (returned at :243-264). ✓ verified.

### S2 — New writers (`lib/feature-writer.js`) + atomic hardening (`lib/feature-json.js`)
- **`rewriteLinks(cwd, {from_code, links, idempotency_key})`**: validate `from_code`; load feature via `getProvider(cwd).getFeature`; `await provider.putFeature(from_code, {...feature, links}, {})`; `safeAppendEvent(cwd, {tool:'rewrite_links', code:from_code, count:links.length, idempotency_key})`. Mirror `linkFeatures`' `maybeIdempotent` envelope (:593).
- **`setRoadmapRowStatus(cwd, {code, status, idempotency_key})`**: surgical single-cell edit (NOT `renderRoadmap` — see C3). Scan ROADMAP.md lines, track the header row to find the Feature/Status column indices (same logic as feature-validator.js:164-178), find the data row whose code matches, replace the first status token in the raw status cell (preserving whitespace/emphasis), atomic temp+rename write, `safeAppendEvent({tool:'set_roadmap_row_status', code, from, to})`. No-op (`changed:false`) when the row is absent or already correct.
- **Atomic `writeFeature`** (feature-json.js:73): replace bare `writeFileSync(path, …)` with temp-write + `renameSync` (mirror `VisionWriter._atomicWrite` / `LocalFileProvider.putChangelog`). Tmp name `${path}.tmp.${process.pid}`; unlink-on-error.
- **Export `getProvider` (feature-writer.js:32) and `isLocalProvider` (:212)** — both module-private today; the reconciler needs them for the provider guard. Pure visibility change.

### S3 — Reconciler engine (`lib/feature-reconciler.js`, new)
- `FIX_CLASSES` registry. Each class: `{default, source: 'finding'|'ctx', mutatesFeatureJson, derive, apply}`. Keys:
  - `dangling_link` — **default on**, `source:'ctx'`. derive: per-feature, links whose `to_code` resolves in none of `foldersByCode/roadmapByCode/visionByCode`. apply: part of per-feature link rewrite.
  - `invalid_link_kind` — **default on (drop only)**, `source:'ctx'`. derive: per-feature, links with `kind ∉ LINK_KINDS∪{external}`. apply: in link rewrite — drop, OR (opt-in `invalid_link_kind_repair`) `nearestLinkKind` if within edit-distance ≤2 and unambiguous.
  - `status_fj_vision` — **default on**, `source:'finding'`, `mutatesFeatureJson:false`. dispatch on each `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE` finding (post-projection, survives narrative suppression — safe everywhere). apply: `VisionWriter.updateItemStatus(item.id, featureStatusToVisionStatus(fj.status))` (fj is canonical → vision-only write).
  - `partial_age` — **opt-in**, `source:'ctx'`, `mutatesFeatureJson:true`. derive: predicate C4. apply: `setFeatureStatus(cwd, {code, status:'PLANNED', derived:true})` (local provider's narrative-aware renderRoadmap applies; non-local already refused by the engine guard).
  - `roadmap_status_rewrite` — **opt-in**, `source:'finding'`. dispatch on each `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON` finding. **Because `validateProject` narrative-suppresses this kind (feature-validator.js:69, :1193), it never fires on a narrative-owned workspace — the suppression IS the guard.** apply: `setRoadmapRowStatus(cwd, {code, status: feature.json status})` (surgical cell edit; ROADMAP uses the same UPPERCASE vocabulary as feature.json so no projection).
- **Link fixes are grouped by `feature_code`**: collect `dangling_link` + `invalid_link_kind` for a feature, compute one corrected `links[]`, emit a single `rewriteLinks` plan entry (Codex convergence fix).
- `reconcileProject(cwd, {apply=false, classes=<defaults>, scope='project', code, featureJsonMode, externalPrefixes, external})`:
  1. **Provider guard:** `if (!isLocalProvider(await getProvider(cwd))) return {refused:'non_local_provider', plan:[], counts:{}}` — no writes (C8).
  2. `const opts = {featureJsonMode, externalPrefixes, external}`; `const {findings} = await validateProject(cwd, opts)`; `ctx = loadValidationContext(cwd, opts)`.
  3. **Mode guard:** if `ctx.featureJsonMode === false`, drop every enabled class with `mutatesFeatureJson` from the active set, recording a skip reason (C7).
  4. Build plan: finding-sourced classes iterate matching findings; ctx-sourced classes iterate codes (or just `code` when `scope==='feature'`, via `loadFeatureContext`). Each → `FixPlanEntry{feature_code, class, action, target, before, after}`.
  5. `apply===false`: return `{scope, plan, counts}`.
  6. `apply===true`: execute each entry's writer (best-effort; capture `applied`/`error`); return `{scope, plan, counts, applied}`.
- `nearestLinkKind(bad)`: Levenshtein vs each `LINK_KINDS` member; return nearest if distance ≤2 and unique-min, else null.
- `isLocalProvider` is already exported/used in feature-writer.js:334 — reuse it.

### S4 — Surfaces
- **CLI** (`bin/compose.js`:1624-1726): add `--fix` (bool), `--apply` (bool), `--fix-class=<csv>` to the parse loop (:1631-1668). After `result` (:1696), when `--fix`: `const { reconcileProject } = await import('../lib/feature-reconciler.js')`; call with `{apply: applyFlag, classes, scope, code, external: externalXref}` (forward the same `external` already passed to `validateProject` at :1688). Print the plan (per-class `before → after`) or applied summary; if `refused` print the non-local-provider message and exit 2; extend `--json` to include the reconcile result. Exit code reflects findings **remaining after apply** (re-validate when `--apply`). Update `--help` text (:1634-1646).
- **MCP** (`server/compose-mcp.js`:374-381): add `fix` (bool), `apply` (bool), `fix_classes` (array) to `validate_project` inputSchema. **`server/compose-mcp-tools.js`** `toolValidateProject` (:432): when `args.fix`, import + call `reconcileProject(getTargetRoot(), {apply: args.apply===true, classes: args.fix_classes, featureJsonMode: args.feature_json_mode, externalPrefixes: args.external_prefixes, external: args.external===true})` — **forwarding the same options already passed to `validateProject`** (C7) — and return `{...validateResult, reconcile}`.

## Verification Table (Phase 5)

| Claim | File:line | Verified |
|---|---|---|
| `loadValidationContext` is module-private, returns full ctx | feature-validator.js:127, :243-264 | ✓ |
| `validateProject` calls `loadValidationContext(cwd, options)` | feature-validator.js:1101 | ✓ |
| `effectiveStatus` = feature.json canonical, roadmap fallback (null if narrative) | feature-validator.js:270-273 | ✓ |
| `NARRATIVE_SUPPRESSED_KINDS` includes `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON`; excludes `…FEATUREJSON_VS_VISION_STATE` | feature-validator.js:66-74 | ✓ |
| `setFeatureStatus` noops on `from===to` (C3) | feature-writer.js:310-312 | ✓ |
| `setFeatureStatus` projects vision via `featureStatusToVisionStatus` on real transition | feature-writer.js:372-384 | ✓ |
| `setFeatureStatus` accepts `derived:true` to bypass transition table | feature-writer.js:315-325 | ✓ |
| `LocalFileProvider.renderRoadmap()` regenerates ROADMAP from feature.json (called by setFeatureStatus at :342) | feature-writer.js:342 → local-provider.js renderRoadmap | ✓ |
| `linkFeatures` is add/upsert-only; no removal primitive (C2) | feature-writer.js:601-633 | ✓ |
| `putFeature`→`writeFeature` validates whole links array, delta-aware existence | feature-json.js:57-68 | ✓ |
| `writeFeature` is a bare `writeFileSync` (atomicity target) | feature-json.js:73 | ✓ |
| `LINK_KINDS` set (kinds the rewriter validates against) | feature-writer.js:432 (`_internals` export :904) | ✓ |
| Validator computes `assess()` (canonical docs) at :545; treats `featureJson.artifacts[]` as evidence at :567; design.md presence check at :550 (C4) | feature-validator.js:545, :550, :567 | ✓ |
| `DANGLING_LINK_FEATURES_TARGET` flags all unresolved to_codes (C5) | feature-validator.js:593-601 | ✓ |
| Validator projects **both** status sides before comparing; `…FEATUREJSON_VS_VISION_STATE` fires only on post-projection mismatch (C6) | feature-validator.js:448-460 | ✓ |
| `getProvider` (:32) and `isLocalProvider` (:212) are module-private — must export (S2) | feature-writer.js:32, :212 | ✓ |
| `GitHubProvider.putFeature` enforces only link shape, skips local existence (C8) | github-provider.js:125-133 | ✓ |
| `GitHubProvider.renderRoadmap` writes merged ROADMAP (no narrative no-op) (C8) | github-provider.js:517 | ✓ |
| CLI validate flag-parse + invoke + print/exit block | bin/compose.js:1624-1726 | ✓ |
| `validate_project` MCP inputSchema | server/compose-mcp.js:372-381 | ✓ |
| `toolValidateProject` handler | server/compose-mcp-tools.js:432 | ✓ |

Zero stale entries. No Boundary Map violations (all producer symbols are new or existing-and-verified; topology S1→S2→S3→S4 is acyclic).
