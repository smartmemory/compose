# COMP-MCP-VALIDATE-3 — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4) — verified against source in the same session (see §Verification).
**Design:** `docs/features/COMP-MCP-VALIDATE-3/design.md`
**D1 resolved:** add `'superseded'` to vision `VALID_STATUSES` (lossless mapping).

## Strategy

Three code changes + one migration + tests, ordered to keep the app working at every step (additive first, then wire-in):

1. **`lib/status-projection.js` (new)** — the single shared mapping. Pure, no IO. Imported by the writer, the validator, and the migration.
2. **`server/vision-store.js`** — add `'superseded'` to `VALID_STATUSES` (D1).
3. **`lib/feature-writer.js:setFeatureStatus`** — best-effort vision projection after the audit append, on real transitions only.
4. **`lib/feature-validator.js`** — replace inline `projectToVisionStatus` with the shared helper; compare in vision's lowercase vocabulary. Must be finding-equivalent on the corpus.
5. **`scripts/backproject-vision-status.mjs` (new)** — one-time idempotent back-projection of historical drift.
6. **Tests** — unit + writer integration + validator symmetry + migration.

## File-by-file plan

### S1 — `lib/status-projection.js` (new)

```js
// Canonical projection: feature/ROADMAP UPPERCASE status -> vision-state lowercase status.
// Used on WRITE (feature-writer projection, migration) and on READ (validator comparison)
// so a projected status can never trip STATUS_MISMATCH_*_VS_VISION_STATE.
const MAP = {
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'in_progress',   // vision cannot represent "partially shipped"
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
  PARKED: 'parked',
  KILLED: 'killed',
  SUPERSEDED: 'superseded', // D1: store enum gains 'superseded'
};
export function featureStatusToVisionStatus(status) {
  if (!status) return null;
  return MAP[String(status).toUpperCase()] ?? null;
}
```
- **Pattern:** pure ESM module, mirrors the small-helper style of `lib/feature-code.js`.
- Returning `null` for unknown keeps callers defensive (writer skips projection; validator skips comparison).

### S2 — bless `'superseded'` across status consumers (D1)

**Data check (2026-06-05):** 2 features are `SUPERSEDED` and 1 vision item already carries `status:'superseded'` — so this is a real, present status, not forward-looking. The migration **must** be able to persist `superseded` (else those 2 stay drifted), which makes the store-enum addition required, not optional. Mapping `SUPERSEDED→killed` is rejected: it would mislabel 2 real superseded features as killed.

Wire `'superseded'` through every consumer that enumerates statuses:

- **`server/vision-store.js:11`** — append `'superseded'` to `VALID_STATUSES`. `updateItem` validates against it; this lets the projection/migration persist `superseded`. Schema (`contracts/vision-state.schema.json:26`) already lists it — no schema change.
- **`src/components/vision/constants.js`** — add `superseded` to `STATUS_COLORS` (`:22`, a muted violet-slate e.g. `'#6b5b8a'` — "replaced/archived"; adjustable) and to the `STATUSES` array so it renders + appears in the legend/dropdown (mirrors how `killed` is present).
- **`server/graph-export.js:14`** — add `superseded: 'complete'` to `STATUS_MAP` (terminal bucket, same as `killed→complete`); without it superseded falls back to `planned` (wrong).
- **TreeView/GraphView preset buckets — intentionally unchanged.** `killed` is *already* only in the `All` preset (not Active/Done/Blocked); `superseded` matches that existing terminal-status convention. No bucket edit (would also alter `killed` behavior — out of scope).

### S3 — `lib/feature-writer.js` (existing) — projection hook

Inside `setFeatureStatus` (`:293`), after `await safeAppendEvent(cwd, event);` (`:362`) and before `return …` (`:364`), insert a best-effort projection. The `from === to` early-return (`:310`) already excludes noops.

```js
// COMP-MCP-VALIDATE-3: project the new status into vision-state so the orphan
// surface stays in sync. Best-effort — vision-state is a downstream mirror, its
// failure must never fail the canonical feature.json/ROADMAP write.
try {
  const { VisionWriter } = await import('./vision-writer.js');
  const { featureStatusToVisionStatus } = await import('./status-projection.js');
  const visStatus = featureStatusToVisionStatus(to);
  if (visStatus) {
    const writer = new VisionWriter(join(cwd, '.compose', 'data'));
    const item = await writer.findFeatureItem(args.code);
    if (item) await writer.updateItemStatus(item.id, visStatus);
  }
} catch (err) {
  console.warn(`[feature-writer] vision-state projection failed for ${args.code}: ${err.message}`);
}
```
- `join` is already imported (`:20`). Lazy `import()` for `vision-writer.js` matches the file's existing lazy-import convention (`:31` comment — avoids server-ish module-load cycles).
- `.compose/data` resolution matches `feature-write-guard.js:resolvePaths` (`:87`).
- Dual-dispatch: server up → REST PATCH (single-authority `VisionStore`); down → atomic file write. No recursion (PATCH route `vision-routes.js:107` updates store only).
- Idempotent same-value write on `kill`/`complete` paths (route already set vision status) — accepted.

### S4 — `lib/feature-validator.js` (existing) — share the mapping (delegation, NOT lowercase rewrite)

A lowercase rewrite of the compare is **not finding-equivalent** — the existing regression `test/feature-validator.integration.test.js:260` proves a schema-invalid vision status of lowercase `"partial"` must still fold to `IN_PROGRESS` (it gets uppercased then projected). `vStatus.toLowerCase()` would yield `"partial"` and false-fire. So keep the comparison in the **UPPERCASE** space and only redirect the projection through the shared helper:

- Add import: `import { featureStatusToVisionStatus } from './status-projection.js';` (near `:36`).
- Redefine `projectToVisionStatus` (`:409–411`) to **delegate** to the shared helper, preserving UPPERCASE output and identity-fallback for non-feature-vocab values (`ready`/`review`):
  ```js
  function projectToVisionStatus(s) {
    if (!s) return s;
    const lower = featureStatusToVisionStatus(s);   // s is already UPPERCASE
    return lower ? lower.toUpperCase() : s;          // null (e.g. READY/REVIEW) → identity
  }
  ```
  The three call sites (`:439–441`) and `statusSeverity` (keyed on UPPERCASE) are **unchanged**.
- **Why this is provably finding-equivalent:** for every key the helper handles, `featureStatusToVisionStatus(k).toUpperCase()` equals the old `projectToVisionStatus(k)` (`PARTIAL→IN_PROGRESS`; all others identity). For `READY`/`REVIEW` (helper → null) it falls back to the original identity. The only *new* behavior is `SUPERSEDED`, which maps to `SUPERSEDED` (identity) — same as the old code's identity pass. ⇒ zero corpus change from the refactor itself; the migration is what clears the 2 superseded + other `*_VS_VISION_STATE` mismatches.
- **Gate:** full `validate_project` finding set identical before/after the refactor (run pre-migration), then re-run post-migration to confirm the `STATUS_MISMATCH_*_VS_VISION_STATE` set shrinks.

### S5 — `scripts/backproject-vision-status.mjs` (new) — one-time migration

- Mirrors `scripts/wire-orphans.mjs` (idempotent read-mutate-atomic-write) but parameterized on a project root (default `process.cwd()`), not `__dirname` — operates on the active project's `.compose/data/vision-state.json`, **not** compose's own `data/`.
- **Resolve the features dir via `loadFeaturesDir(cwd)`** (`lib/project-paths.js:24`), NOT a hardcoded `docs/features` — respects `.compose/compose.json` `paths.features` overrides, exactly as the validator does (`lib/feature-validator.js:110`). Hardcoding would silently skip canonical files on non-default-root projects and leave drift.
- Steps: read `.compose/data/vision-state.json` → for each item with `lifecycle?.featureCode` (fallback `item.featureCode`), read `<featuresDir>/<code>/feature.json`, compute `featureStatusToVisionStatus(feature.status)`; if it differs from `item.status`, stage the change.
- `--apply` writes atomically (temp + `renameSync`); dry-run default prints the reconciliation table (`code: old → new`). Idempotent: second run stages zero.
- Skips items with no bound feature.json (UI-only items) — absence of a local feature.json is sufficient to skip externals.

### S6 — Tests

- **`test/status-projection.test.js` (new, `node:test`):** table of all 8 statuses → expected vision value incl. `PARTIAL→in_progress`, `SUPERSEDED→superseded`, unknown→null.
- **`test/feature-writer-vision-projection.test.js` (new, `node:test` + `mkdtempSync`):** mirror `test/feature-write-guard.test.js` fixtures (`writeFolder`, `writeVision`). Cases: PLANNED→IN_PROGRESS projects `in_progress` (server-down file path); PARTIAL→`in_progress`; `from===to` noop leaves vision untouched; vision read/write failure does not throw from `setFeatureStatus`; item matched by `lifecycle.featureCode`.
- **Validator symmetry:** add a case to the validator test suite — a feature whose vision status was just projected yields no `STATUS_MISMATCH_*_VS_VISION_STATE`.
- **`test/backproject-migration.test.js` (new):** seed drifted vision-state + canonical feature.json, run apply, assert reconciled; re-run asserts zero changes (idempotent).
- Run via `npm test`.

## Corrections table (spec assumption → reality)

| Assumption | Reality | Resolution |
|---|---|---|
| A central `getDataDir(cwd)` resolves the data dir | `server/project-root.js:getDataDir()` is **arg-less** (process-global `_dataDir`); not cwd-scoped | Resolve `join(cwd,'.compose','data')` inline, matching `feature-write-guard.js:resolvePaths` (`:87`) |
| Migration scripts resolve data via `__dirname/../data` | `wire-orphans.mjs` targets legacy `data/`; canonical is `.compose/data/` | New script resolves `<root>/.compose/data/vision-state.json`, root defaults to `cwd` |
| `build.js` status writes are an uncovered vision gap | `build.js` already self-syncs vision via its own `VisionWriter` (`:922/1878/1900/1917`) | Out of scope; chokepoint must not double-write it |
| Validator compare can move to lowercase via the shared helper | Regression `feature-validator.integration.test.js:260` requires lowercase `"partial"` to fold to `IN_PROGRESS`; `vStatus.toLowerCase()` breaks it | S4 keeps UPPERCASE compare; `projectToVisionStatus` *delegates* to the helper (`.toUpperCase()`, identity-fallback) |
| `SUPERSEDED` is forward-looking only | **2 features are SUPERSEDED**, 1 already `superseded` in vision-state | Enum addition required (not optional); `→killed` fallback rejected (mislabels 2 real features) |
| Adding `superseded` to the store enum is sufficient | UI/server consumers (`constants.js`, `graph-export.js`) enumerate statuses and omit it | S2 wires it through `STATUS_COLORS`/`STATUSES`/`STATUS_MAP`; preset buckets match `killed` (All-only) by convention |
| Migration can hardcode `docs/features` | Features root is configurable (`paths.features`) | S5 uses `loadFeaturesDir(cwd)` |

## Boundary Map

- `featureStatusToVisionStatus` — **function** — `lib/status-projection.js` (new). Producer of the canonical status mapping.
- `VALID_STATUSES` — **const** — `server/vision-store.js` (existing). Gains `'superseded'`; consumed by `updateItem` validation.
- `STATUS_COLORS` — **const** — `src/components/vision/constants.js` (existing). Gains a `superseded` color + `STATUSES` entry.
- `STATUS_MAP` — **const** — `server/graph-export.js` (existing). Gains `superseded: 'complete'`.
- `setFeatureStatus` — **function** — `lib/feature-writer.js` (existing). Consumes `featureStatusToVisionStatus` `from S1` + `VisionWriter`; projects to vision-state.
- `VisionWriter` — **class** — `lib/vision-writer.js` (existing, untouched). Provides `findFeatureItem`/`updateItemStatus`; consumed by `setFeatureStatus` and the migration.
- `runStateMismatchChecks` — **function** — `lib/feature-validator.js` (existing). Consumes `featureStatusToVisionStatus` `from S1`, replacing inline `projectToVisionStatus`.

Endpoints/behaviors (prose, not Boundary Map entries): the projection rides the existing `PATCH /api/vision/items/:id` REST route; the migration writes `.compose/data/vision-state.json` atomically. Invariant: write-side and read-side status projection are the *same* function (S1).

## Sequencing

S1 → S2 (additive status-consumer wiring, independent) → S4 (validator delegates to S1) → S3 (writer consumes S1+S2 via VisionWriter) → S5 (migration consumes S1 + `loadFeaturesDir`) → S6 (tests) → **baseline** `validate_project` (pre-migration, confirm refactor is finding-equivalent) → run migration `--apply` on the live project → **re-run** `validate_project` to confirm `STATUS_MISMATCH_*_VS_VISION_STATE` set shrinks (incl. the 2 superseded).
