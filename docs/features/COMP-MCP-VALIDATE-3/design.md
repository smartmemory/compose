# COMP-MCP-VALIDATE-3 — vision-state projection from the lifecycle source of truth

**Status:** DESIGN (Phase 1) — not yet implemented.
**Feature code:** COMP-MCP-VALIDATE-3
**Parent:** COMP-MCP-VALIDATE (Closed-Loop Hardening)
**Siblings:** COMP-MCP-VALIDATE-1 (write-time schema validation, SHIPPED) · COMP-MCP-VALIDATE-2 (`compose validate --fix`, PLANNED — **depends on this**)
**Related:** COMP-MCP-ENFORCE (lifecycle-as-truth projection)

## Related Documents
- Sibling design: `docs/features/COMP-MCP-VALIDATE-1/design.md`
- Surfacing triage: 2026-06-05 validate-backlog triage (13 errors, ~605 warnings)
- Contracts: `contracts/vision-state.schema.json`, `contracts/feature-json.schema.json`

---

## 1. Problem

A feature's **status** lives in three on-disk surfaces:

| Surface | Path | Status vocabulary | Authority |
|---|---|---|---|
| ROADMAP.md | `ROADMAP.md` | UPPERCASE (`PLANNED`…`KILLED`, incl. `PARTIAL`, `SUPERSEDED`) | projection of feature.json |
| feature.json | `docs/features/<code>/feature.json` | UPPERCASE (same set) | **canonical** |
| vision-state | `.compose/data/vision-state.json` | lowercase (`planned`…`killed`; **no `partial`**, store enum currently **omits `superseded`**) | tracker / UI surface |

The typed writers keep **feature.json (canonical) + ROADMAP.md** in lockstep but **never touch vision-state.json**. So vision-state drifts as an orphan — e.g. `COMP-GSD` / `COMP-GSD-3` read `COMPLETE` in ROADMAP + feature.json but `in_progress` in vision-state, indefinitely.

COMP-MCP-ENFORCE made the lifecycle the intended single source of truth that *projects* to all surfaces, but:
1. **Historical vision-state was never back-projected** — pre-existing drift just sits there.
2. **Nothing reconciles vision-state on write** for the status-mutation paths that bypass the lifecycle routes.

This produces the validator findings `STATUS_MISMATCH_ROADMAP_VS_VISION_STATE` and `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE`.

## 2. Gap Map (verified against source)

Scope: the **MCP + lifecycle-route status writers**. Each entry point and which surfaces it writes **today**:

| Entry point | feature.json | ROADMAP.md | vision-state | Gap? |
|---|:-:|:-:|:-:|---|
| `set_feature_status` (MCP → `lib/feature-writer.js:setFeatureStatus`) | ✅ | ✅ | ❌ | **YES** |
| `record_completion` (MCP → `lib/completion-writer.js:329`, internally calls `setFeatureStatus`) | ✅ | ✅ | ❌ | **YES** |
| lifecycle `start` route (`server/vision-routes.js:236`) — `projectFeatureStatus(explore_design)`; sets `item.lifecycle` but **not** `item.status` | ✅ | ✅ | ❌ | **YES** |
| lifecycle `advance` / `skip` routes (`server/vision-routes.js:308,348`) — update `lifecycle.currentPhase` + `projectFeatureStatus()`; **do not** set `item.status` | ✅ | ✅ | ❌ | **YES** |
| lifecycle `kill` route (`:389`) — `store.updateItem({status:'killed'})` **then** `projectFeatureStatus()` | ✅ | ✅ | ✅ | no |
| lifecycle `complete` route (`:445`) — `store.updateItem({status:'complete'})` **then** project / `recordCompletion` | ✅ | ✅ | ✅ | no |
| `seedFeatures()` (file-watch reseed, `server/feature-scan.js`) | ❌ | ❌ | ✅ | reverse only |

**Chokepoint observation:** every gap path above funnels through **`setFeatureStatus()`** (`lib/feature-writer.js:293`). `record_completion` calls it internally; `start`/`advance`/`skip` reach it via `projectFeatureStatus()` (`server/lifecycle-guard.js:144`). Fixing the projection **once** at `setFeatureStatus` closes all four gaps. This mirrors COMP-MCP-VALIDATE-1, which hooked one chokepoint (`writeFeature`) rather than each caller.

**Separately-managed surface — `lib/build.js` (not a gap):** the build flow raw-writes `feature.json.status` via `persistFeatureRaw()` (`:791` IN_PROGRESS, plus terminal writes at `:1881/1901/1918`), deliberately bypassing `setFeatureStatus` (no transition policy, no events, no `renderRoadmap` — build-internal transient states that settle on completion). It is **not** a vision-state gap: it already projects vision status in lockstep via its own `VisionWriter` (`:742`) — `updateItemStatus(itemId, …)` at `:922` (`in_progress`), `:1878` (`complete`), `:1900` (`killed`), `:1917` (`failed`). The chokepoint fix does **not** touch this surface and must not double-write it. (Aside: `:1917` writes `'failed'`, which is not in vision `VALID_STATUSES` — a pre-existing inconsistency to file as a separate follow-up, out of -3 scope.)

## 3. Approach

**Write-time projection at the `setFeatureStatus` chokepoint, plus a one-time back-projection migration.** Two deliverables:

### 3a. Shared status-mapping module — `lib/status-projection.js` (new)

One canonical function, used by **both** the writer projection **and** the validator's read-time comparison, so a value written by the projection can never itself trip the validator (the VALIDATE-1 principle: *single rule set, enforced on write and read*).

```
featureStatusToVisionStatus(upperStatus) -> lowercase vision status
  PLANNED      -> planned
  IN_PROGRESS  -> in_progress
  PARTIAL      -> in_progress      (vision cannot represent "partially shipped")
  COMPLETE     -> complete
  BLOCKED      -> blocked
  PARKED       -> parked
  KILLED       -> killed
  SUPERSEDED   -> superseded       (see Decision D1)
```

The validator's inline `projectToVisionStatus` (`lib/feature-validator.js:409`) is **refactored to consume this helper** so the two mappings can never diverge. This refactor must be **finding-equivalent** on the current corpus (verified by a full `validate_project` run before/after — see §6).

### 3b. Write-time projection inside `setFeatureStatus` (`lib/feature-writer.js`)

After feature.json is persisted and ROADMAP regenerated (after line 349, before/after the audit-event append), project the new status into vision-state, **best-effort** (wrapped like `safeAppendEvent` — a vision-state hiccup must never fail the canonical feature.json write):

```
try {
  const writer = new VisionWriter(dataDirFor(cwd), { workspaceId? });
  const item = await writer.findFeatureItem(code);
  if (item) await writer.updateItemStatus(item.id, featureStatusToVisionStatus(to));
} catch (err) { console.warn('[feature-writer] vision-state projection failed: …'); }
```

- Uses the **existing `VisionWriter` dual-dispatch** (REST-first when the server is up → the in-memory `VisionStore` stays the single writer authority; direct atomic file write when down). No new IO primitive.
- Runs **only on a real transition** (the `from === to` early-return at `:310` keeps noop writes from touching vision; pre-existing drift on an unchanged status is the migration's job, §3c).
- **No `syncVision` opt / no reentrancy hazard:** on `kill`/`complete` the route already set vision status, so the projection is an *idempotent* redundant write of the same value; on `advance`/`skip` it is the *fix*. The self-directed `PATCH /api/vision/items/:id` does **not** project back to feature.json (`vision-routes.js:107` updates the store only), so there is no recursion.

### 3c. One-time back-projection migration — `scripts/backproject-vision-status.mjs` (new)

Follows the established idempotent-mutation pattern (`scripts/wire-orphans.mjs`): read `vision-state.json`, read every `docs/features/<code>/feature.json` (canonical), and for each vision item bound by `lifecycle.featureCode`, set `item.status = featureStatusToVisionStatus(feature.status)`. Dry-run by default; `--apply` writes atomically (temp + rename). Prints a reconciliation report (item, old → new). Idempotent: a second run reports zero changes.

This eliminates the **historical** `STATUS_MISMATCH_*_VS_VISION_STATE` errors that the write-time hook cannot reach (they predate any new mutation).

## 4. Why this design

- **One chokepoint, four gaps closed.** Projecting at `setFeatureStatus` covers `set_feature_status`, `record_completion`, and lifecycle `start`/`advance`/`skip` without touching each call site; `build.js` already self-syncs vision and is left untouched.
- **Reuses the dual-dispatch writer** that already solves the "server-up single-authority vs server-down file-write" problem — no new concurrency surface.
- **Shared mapping = no self-inflicted drift.** Writer and validator share `featureStatusToVisionStatus`; a projected status is, by construction, what the validator expects.
- **Best-effort, non-blocking.** Canonical feature.json/ROADMAP writes are never gated on vision-state availability.

## 5. Decisions

### D1 — How does `SUPERSEDED` map into vision? **RESOLVED (2026-06-05): add `'superseded'` to `VALID_STATUSES`** (recommended option) — lossless identity mapping; verify UI renders it gracefully at implementation.

Vision `VALID_STATUSES` (`server/vision-store.js:11`) omits `superseded`, while `contracts/vision-state.schema.json:26` **lists it**. (Note the two enums are not otherwise aligned either: the store also permits `ready`/`review`, which the schema omits — full store↔schema reconciliation is a separate concern, not this feature.) Options for the `SUPERSEDED` case specifically:
- **(Recommended) Add `'superseded'` to `VALID_STATUSES`** so the store accepts the one value the schema already sanctions. Mapping is then lossless (identity + `PARTIAL→in_progress`), and the validator compares `superseded === superseded`. Blast radius: one enum array; verify the UI renders the schema-valid status gracefully (it already carries `ready`/`review` beyond the common set).
- **(Fallback) Map `SUPERSEDED→killed`** in the shared helper (terminal/obsolete) with no enum change — but `killed` semantically distorts "replaced", and the validator must use the *same* fold to stay consistent.

Resolve at blueprint after checking whether any current feature is `SUPERSEDED` (if zero, this is purely forward-looking). Default to the recommended option. This decision touches only the `SUPERSEDED` mapping, not the broader store↔schema enum mismatch.

### D2 — `workspaceId` threading (deferred)
`VisionWriter` accepts `opts.workspaceId` for multi-workspace REST routing; `setFeatureStatus` only receives `cwd`. `build.js` constructs `new VisionWriter(dataDir)` without it, so v1 omits it (same as existing callers). Note as a follow-up if multi-workspace REST projection proves necessary.

## 6. Out of scope

- **Reverse direction** (vision-state → feature.json): a direct `PATCH /api/vision/items/:id` (e.g. UI drag) still won't back-write feature.json. That is a separate gap, not part of -3.
- **Remediation UX** (`validate --fix`): that is COMP-MCP-VALIDATE-2, which consumes this feature's canonical projection as its status-class fixer.
- **Reconciling on noop** (`from === to`): handled by the migration, not the write-time hook.

## 7. Test plan (golden + contract)

- **Unit (`lib/status-projection.js`):** table-driven map of all 8 feature statuses → expected vision status, including `PARTIAL` and the D1 `SUPERSEDED` choice.
- **Writer integration (mirror `test/feature-write-guard.test.js`, `node:test` + temp dirs):**
  - `setFeatureStatus` PLANNED→IN_PROGRESS projects `in_progress` into vision-state (file-fallback path, server down).
  - PARTIAL projects `in_progress`; COMPLETE projects `complete`.
  - `from === to` noop does **not** touch vision-state.
  - vision-state read/write failure does **not** fail the feature.json write (best-effort).
  - item bound by `lifecycle.featureCode` is the one updated (not a same-id collision).
- **Validator symmetry:** a feature whose status was just projected yields **no** `STATUS_MISMATCH_*_VS_VISION_STATE` finding.
- **Migration (`scripts/backproject-vision-status.mjs`):** seed a drifted vision-state, run `--apply`, assert reconciled; re-run asserts idempotent (zero changes).
- **Regression guard:** full `validate_project` finding set is identical before/after the validator refactor, **minus** the `STATUS_MISMATCH_*_VS_VISION_STATE` errors the migration clears.

## 8. Acceptance criteria

- [ ] `lib/status-projection.js` exports `featureStatusToVisionStatus()` covering all 8 feature statuses.
- [ ] `lib/feature-validator.js` consumes the shared helper (inline `projectToVisionStatus` removed); finding-equivalent on the current corpus except intended cleared mismatches.
- [ ] `setFeatureStatus` projects status into vision-state via `VisionWriter`, best-effort, only on real transitions.
- [ ] `record_completion` and lifecycle `advance`/`skip` inherit the projection (no per-call-site changes needed) — verified by test.
- [ ] `kill`/`complete` routes still produce a single consistent vision status (idempotent redundant write; no recursion).
- [ ] `scripts/backproject-vision-status.mjs`: dry-run default, `--apply` writes atomically, idempotent, prints reconciliation report.
- [ ] D1 (`SUPERSEDED` mapping) resolved and reflected in helper + (if chosen) `VALID_STATUSES`.
- [ ] `STATUS_MISMATCH_ROADMAP_VS_VISION_STATE` + `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE` eliminated for all internally-owned features after migration.
- [ ] Full `npm test` green.
