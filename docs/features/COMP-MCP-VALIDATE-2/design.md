# COMP-MCP-VALIDATE-2 — Reconcile / `compose validate --fix`

> **Status: DESIGN (Phase 1).** This is a pre-implementation intent document, not shipped code. It describes *what* and *why*; file:line targets and exact signatures are pinned in `blueprint.md` (Phase 4). Review for design soundness, not code-completeness.

## Related Documents

- **Parent umbrella:** [`../COMP-MCP-VALIDATE/`](../COMP-MCP-VALIDATE/design.md) — the cross-artifact validator (`validate_feature`/`validate_project`)
- **Sibling (SHIPPED):** [`../COMP-MCP-VALIDATE-1/`](../COMP-MCP-VALIDATE-1/design.md) — write-time link validation (stops *new* drift)
- **Sibling (SHIPPED):** [`../COMP-MCP-VALIDATE-3/`](../COMP-MCP-VALIDATE-3/design.md) — vision-state status projection (the canonical status source this feature consumes)
- ROADMAP row: `compose/ROADMAP.md` → `COMP-MCP-VALIDATE-2`
- Forward: `blueprint.md`, `plan.md`, `report.md` (this folder)

## Problem Statement

`validate_project` reports drift but offers no remediation. Every finding becomes manual JSON surgery: the 2026-06-05 validate-backlog triage (13 errors, ~605 warnings) hand-fixed 4 errors and stalled on 9 more. Detection without remediation means a human keeps mopping a leak that the detector keeps re-reporting.

VALIDATE-1 stops *new* drift at write time; VALIDATE-3 gives status classes a canonical source. This feature closes the loop: a **reconcile mode** that applies the canonical fix for the mechanical finding classes, so the backlog drains instead of accreting.

## Goals & Non-Goals

### Goals
- A reconcile pass that applies canonical fixes for the four spec-named classes, plus the ROADMAP-row status rewrite.
- **Dry-run by default.** Nothing writes unless the caller opts in with `--apply`.
- **Per-class opt-in.** Judgment-heavy classes can be enabled/disabled independently; a conservative default class-set is safe to run unattended.
- Exposed on both surfaces: `compose validate --fix` (CLI) and `validate_project` with a `fix` arg (MCP).
- Every applied fix routes through an existing typed writer (or one new symmetric removal writer) — never raw JSON surgery — so VALIDATE-1 guards and audit events apply.
- Re-running validate after `--apply` shows the fixed findings cleared (closed-loop property).

### Non-Goals
- **The validator stays detect-only.** `validateProject`/`validateFeature` are unchanged in behavior. Reconcile is a *sibling* pass that reuses the validator's context-building, not a mutation hook inside detection.
- No fix for judgment-heavy non-target classes (missing artifacts, successor links, schema violations beyond link-kind, cross-feature ref gaps). Those stay manual.
- No interactive prompt-per-fix UX in v1 — the contract is dry-run → review plan → `--apply`.
- No git commit / staging from the fixer. It edits the working tree; the human commits.

## The Drift the Detector Already Knows

The validator emits `{severity, kind, detail, feature_code?, source?}` findings — **no structured fix payload**. The reconcile pass therefore does not parse `detail` strings; it rebuilds the same `ctx` the validator builds (`foldersByCode`, `roadmapByCode`, `visionByCode`, `narrativeOwned`, …) and re-derives each fix from live artifact data, dispatching on finding `kind`.

Two of the five target classes have **no finding today** and require additive detection (detection only — still detect-only validator):

| Target class | Existing finding? | Detection change needed |
|---|---|---|
| Dangling link → drop | `DANGLING_LINK_FEATURES_TARGET` ✓ | none |
| feature.json ↔ vision-state status → reproject | `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE` ✓ | none |
| ROADMAP row ↔ feature.json status → rewrite | `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON` ✓ | none (respect `narrativeOwned`) |
| PARTIAL without artifact → age to PLANNED | **none** — `assess()` result at ~L543 is computed then discarded | add `PARTIAL_WITHOUT_ARTIFACT` (wire up dead `assessment`) |
| Invalid link `kind` → repair/drop | **none** — hidden in generic `FEATURE_JSON_SCHEMA_VIOLATION` | add dedicated `INVALID_LINK_KIND` finding so reconcile can target it |

## Approaches Considered

### A. Structured fix payload on every finding (rejected)
Extend `finding()` with an optional `fix:{action,…}` emitted at each fixable site; a thin applier dispatches on `fix.action`. **Rejected:** payload is sparse (only ~5 of 32+ kinds fixable), and it changes the validator's finding contract — the read-side surface every consumer depends on — to serve the write side. Couples the detector to remediation knowledge.

### B. Shared-context reconcile pass (CHOSEN)
A new `reconcileProject(cwd, {apply, classes})` lives in the validator's module family. It rebuilds the same `ctx`, runs the checks to get findings, and for each fixable finding re-derives the canonical fix **with `ctx` in scope** (no re-read, no payload threading), producing a fix plan. Dry-run returns the plan; `apply` executes it via writers, then the caller can re-validate.

- Validator stays pure detect-only — its contract is untouched.
- No detail-string parsing; fixes derive from live `ctx`/artifact data.
- One module family, one context-builder shared between detect and reconcile.

### C. Standalone fixer that re-reads per finding (rejected)
A separate `lib/validate-fixer.js` that re-reads each feature's artifacts independently. **Rejected:** duplicates the validator's artifact-loading and containment logic, drifting from the detector over time. B gets the same isolation by *sharing* the context-builder instead of duplicating it.

## Chosen Design

### Reconcile engine — `reconcileProject(cwd, opts)`
- Builds `ctx` via the same internal path `validateProject` uses (refactor the context-build into a shared helper if not already callable standalone — Phase 4 confirms).
- Collects findings, filters to the **enabled fixable classes** (`opts.classes`), and for each builds a `FixPlanEntry`:
  `{ feature_code, kind, action, target, before, after, applied: false, skipped_reason? }`.
- `opts.apply === false` (default): returns `{ scope, plan: [...], counts }` — a dry-run report. Nothing writes.
- `opts.apply === true`: executes each entry's writer call, sets `applied`/`error`, returns the same shape with results. Best-effort per entry — one failed fix does not abort the batch.
- Returns enough for the caller to re-run `validateProject` and confirm convergence (closed-loop assertion in tests).

### Per-class fix actions

> **Link fixes are per-feature, not per-finding (convergence).** `putFeature` re-validates the *entire* `links[]` array on write (VALIDATE-1 `assertValidLinkShape` + dangling-target check). A per-entry mutation therefore cannot converge: dropping one dangling link fails if a *different* link on the same feature still has an invalid `kind`. So the reconcile pass groups **all** link-class findings (dangling + invalid-kind) **by `feature_code`**, rescans `featureJson.links` from `ctx`, computes one corrected array in memory, and writes it **once** via a new `rewriteLinks(cwd, {from_code, links})` writer (routes through `provider.putFeature` → VALIDATE-1 + audit). This single writer replaces a per-entry `removeLink` primitive and covers both drop and repair.

1. **Dangling link → drop.** `DANGLING_LINK_FEATURES_TARGET`. In the per-feature link rewrite: re-confirm each link's `to_code` resolves against none of the three `ctx` sources, drop those entries from the computed array.

2. **feature.json ↔ vision-state status → reproject.** `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE`. feature.json is canonical (`effectiveStatus`). Apply `featureStatusToVisionStatus(featureJson.status)` to the vision item. Because the validator compares *post-projection*, applying the same shared map deterministically clears the finding. Reuse `setFeatureStatus` (it heals feature.json + ROADMAP + vision-state in one call) or, when feature.json is already canonical and only vision drifted, a direct `VisionWriter.updateItemStatus`. Survives narrative suppression — safe everywhere.

3. **ROADMAP row ↔ feature.json status → rewrite.** `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON`. **Guarded by `ctx.narrativeOwned`:** on narrative-owned workspaces this finding is suppressed and the fixer must *never* rewrite hand-authored rows. On non-narrative workspaces, rewrite the row's status from canonical feature.json. **Neither `setFeatureStatus` nor a full `renderRoadmap` can serve this** (impl finding): the former short-circuits when feature.json is already canonical; the latter appends a generated section beside hand-authored rows, producing duplicate conflicting rows. So a dedicated **`setRoadmapRowStatus(cwd, {code, status})` writer** does a **surgical single-cell edit** — locates the row by code (column-aware, mirroring the validator) and rewrites only the Status token, leaving every other byte untouched + audit event.

4. **PARTIAL without artifact → age to PLANNED.** New `PARTIAL_WITHOUT_ARTIFACT` finding, scoped strictly to `status === 'PARTIAL'`. **Detection predicate must respect *all* evidence the validator already treats as real**, not just the six canonical docs `assess()` knows about: fire only when there are **no canonical docs AND no `feature.json.artifacts[]` entries AND no CHANGELOG evidence** for the code. (Keying off `assess()` alone would wrongly downgrade a PARTIAL feature that has linked artifacts or a CHANGELOG line, erasing real state.) Fix: `setFeatureStatus(code, {from:'PARTIAL', to:'PLANNED', derived:true})` — cascades to ROADMAP + vision-state. Because it mutates status destructively, this class is **opt-in** (not in the default class set).

5. **Invalid link `kind` → repair to nearest allowed / drop.** New `INVALID_LINK_KIND` finding (detection only). **Consistent with the no-payload contract:** the finding does not carry structured data; the reconcile pass independently rescans `featureJson.links` from `ctx` (the same per-feature link rewrite as class 1) to locate the offending entries and their bad `kind` values. Fix heuristic: compute edit distance from the bad `kind` to each `LINK_KINDS` member; if the nearest is within a conservative, unambiguous threshold (≤2), repair to it; otherwise drop the link (the spec's "reject" fallback). The repair-vs-drop threshold is per-class-tunable, and *nearest-allowed repair* is opt-in (the **drop** fallback is the default behavior). Applied in the single per-feature `rewriteLinks` call.

### Class set & safety defaults
- `classes` is a set of class keys. The default `--fix` set enables the **non-destructive deterministic** classes only: `dangling_link` (drop), `status_fj_vision` (reproject), and the **drop** path of `invalid_link_kind`. Everything that mutates status or hand-rendered surfaces, or that applies a heuristic, requires explicit opt-in (`--fix-class=…` / `fix_classes` arg):
  - `partial_age` — destructive status downgrade; opt-in.
  - `roadmap_status_rewrite` — touches the ROADMAP surface (narrative-guarded even when enabled); opt-in.
  - `invalid_link_kind` *nearest-allowed repair* — heuristic; opt-in (drop is the default behavior for this class).
- An unattended default run therefore never downgrades a status, never rewrites a ROADMAP row, and never applies the edit-distance heuristic.
- Dry-run prints, per class: count, and for each entry a `before → after` line. `--apply` is the only thing that writes.

### Surfaces
- **CLI** (`bin/compose.js` validate block): add `--fix` (dry-run reconcile), `--apply` (write), `--fix-class=<csv>` (override class set). `--json` extends to include the fix plan. Exit code reflects *remaining* (unfixable) findings after apply.
- **MCP** (`validate_project`): add `fix` (bool), `apply` (bool), `fix_classes` (array) to the input schema; thread through `toolValidateProject` to `reconcileProject`. Reuses existing writer plumbing — no new MCP tools.

### Atomicity hardening
The canonical-store writer `writeFeature` (`lib/feature-json.js`) is a bare `writeFileSync`. A bulk reconcile can touch many features; harden it to temp-write + `rename` (matching `VisionWriter._atomicWrite` / `putChangelog`) so a crash mid-reconcile can't leave a half-written feature.json. Small, in-scope correctness fix.

## Risks & Assumptions

- **Convergence assumption:** applying the shared projection clears the status findings because detection runs post-projection. Verified by a golden closed-loop test (drift in → `--apply` → re-validate → zero target findings), not assumed.
- **Narrative guard is load-bearing.** A bug that rewrites ROADMAP rows on a narrative workspace corrupts hand-authored prose. The `narrativeOwned` check gates class 3 at both detection (already) and reconcile (new) — tested explicitly.
- **Two new mutation primitives** (`rewriteLinks`, `resyncRoadmap`) must enforce the same audit discipline as `linkFeatures`/`setFeatureStatus` and route through `provider.putFeature`/the roadmap renderer so VALIDATE-1 guards still fire on the rewritten array.
- **Edit-distance heuristic** for invalid-kind repair can mis-guess; that's why repair is opt-in and drop is the default fallback.
- Unproven technical assumptions requiring a spike: none. All primitives (projection map, writers, ctx-builder) exist or are thin additions.

## Success Criteria

- [ ] `compose validate --fix` (no `--apply`) prints a fix plan and writes nothing.
- [ ] `compose validate --fix --apply` applies the enabled classes; re-running `validate` shows those findings cleared.
- [ ] All five fix actions implemented, each routed through a typed writer.
- [ ] `narrativeOwned` workspaces never get ROADMAP-row rewrites.
- [ ] Destructive/heuristic/surface-touching classes (`partial_age`, `roadmap_status_rewrite`, `invalid_link_kind` repair) are opt-in, not in the default class set.
- [ ] Link fixes for a feature with multiple link issues converge in a single `rewriteLinks` write (no per-entry blocking).
- [ ] `PARTIAL_WITHOUT_ARTIFACT` fires only when there are no canonical docs, no `artifacts[]`, and no CHANGELOG evidence.
- [ ] MCP `validate_project` exposes `fix`/`apply`/`fix_classes` with parity to the CLI.
- [ ] Golden closed-loop test + per-class unit tests green; full suite green.
