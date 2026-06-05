# COMP-MCP-VALIDATE-1 — Write-Time feature.json Validation

**Status:** Phase 1 design (awaiting gate approval)
**Parent:** COMP-MCP-VALIDATE — Closed-Loop Hardening
**Complexity:** M
**Siblings:** -2 (`--fix`/reconcile, depends on this) · -3 (vision-state projection)

## Problem

The `feature.json` schema (`contracts/feature-json.schema.json`) and the
cross-reference existence rule are enforced **only on read**, by `validate_*`
in `lib/feature-validator.js`. Nearly all `feature.json` writes funnel through
`writeFeature()` (`lib/feature-json.js:52`) — which calls `writeFileSync` with
**no validation** — and a few writers (vision route, ideabox promote) bypass even
that with their own direct `fs.writeFileSync`. Invalid data lands on disk and is only caught later (the
2026-06-05 triage found 13 errors / ~605 warnings). The two recurring,
*mechanically preventable* classes:

- `FEATURE_JSON_SCHEMA_VIOLATION` — bad shape: link `kind` outside the enum
  (`informs`, `unblocks`), missing `to_code` on a non-`external` link, bad
  `code` pattern, bad `provider` value.
- `DANGLING_LINK_FEATURES_TARGET` — a link `to_code` that resolves to no known
  feature (e.g. `COMP-SPECFLOW`, `COMP-BOUNDARY-MAP`).

The typed `linkFeatures` writer *already* guards `kind` against `LINK_KINDS`
(`feature-writer.js`). The leak is the **bypass paths** that call
`writeFeature` / `persistFeatureRaw` directly without those guards — `xref-sync.js`,
raw status writes in `build.js`, `completion-writer.js`, CLI scaffold/triage,
`migrate-roadmap.js` — plus two **direct `fs.writeFileSync`** writers that skip
the chokepoint entirely (ideabox promote: `server/ideabox-routes.js:183` HTTP and
`bin/compose.js:2330` CLI) — plus hand-edits. A guard at the typed-writer layer
alone would miss all of them.

## Goal / Non-Goals

**Goal:** Enforce the *same rule set* the read validator uses, at write time, so
invalid `kind` / shape / dangling `to_code` is rejected **before commit**.
Single source of truth (`contracts/feature-json.schema.json` +
existence-of-target), enforced on write not just read.

**Non-Goals:**
- **No auto-normalization / repair.** -1 is a pure *gate* (reject). Repairing
  the existing backlog and judgment-heavy normalization is **-2** (`--fix`).
  This keeps the -2-depends-on-`-1` boundary clean.
- **No back-fill of existing invalid files.** -1 stops *new* drift only. The
  605-warning backlog is -2's remediation target.
- **No atomicity change.** `writeFeature` is non-atomic today (`writeFileSync`,
  no tmp+rename). Worth fixing but out of scope — filed as a note, not a blocker.

## Approach

Two injection points, one shared guard, reusing existing primitives.

### 1. Shared guard — `lib/feature-write-guard.js` (new)

A small module exporting:

- `assertValidFeatureShape(feature)` — runs the **existing** Ajv validator
  (`new SchemaValidator(FEATURE_JSON_SCHEMA).validateRoot(feature)` from
  `server/schema-validator.js`) and, on `!valid`, throws a structured
  `FeatureWriteValidationError` whose message lists every Ajv violation as
  `<instancePath>: <message>`. Same schema, same Ajv instance the read path
  compiles — zero rule duplication.
- `featureCodeExists(cwd, code)` / `knownFeatureCodes(cwd)` — existence helper
  reading the authoritative trio (`docs/features/*` folders, ROADMAP rows,
  vision-state items), mirroring `loadValidationContext`'s
  `foldersByCode ∪ roadmapByCode ∪ visionByCode`. Extracted so the read
  validator and the write path converge on one implementation.

### 2. Shape + existence validation at the chokepoint — `writeFeature()` (`lib/feature-json.js`)

`writeFeature(cwd, feature, featuresDir, opts)` gains a guard call **before**
the `writeFileSync`, covering *every* path that funnels through the chokepoint —
CLI, all three providers, xref-sync, migrate, build raw writes, completion-writer:

- **Shape** — `assertValidFeatureShape(feature)` unless `opts.validate === false`.
  Schema is `additionalProperties: true` / only `code` required, so it is
  permissive: rejects the genuinely-malformed (bad kind/provider, missing
  `to_code`, bad code pattern) without tripping on legitimate field variety.
- **Existence (target gating, per gate decision #2 — maximal closure)** — if the
  feature carries any `links[]` entry with a `to_code` and `kind !== 'external'`,
  assert each target is in `knownFeatureCodes(cwd) ∪ { feature.code }`. On a miss,
  throw `DANGLING_LINK_FEATURES_TARGET` unless `opts.allowForwardRefs === true`.
  This closes dangling targets on **raw** `writeFeature`/`persistFeatureRaw`
  writes too, not just the typed link writer.

**Cost control (the reason this is cheap):** the existence scan runs **only when
the feature being written actually has non-external `to_code` links** — the
common writes (status mutations, completions, scaffolds) have none and pay zero
added I/O. When it does run, `knownFeatureCodes(cwd)` is memoized per-`cwd` for
the process (invalidated when `writeFeature` persists a new code) so a
link-heavy batch doesn't re-scan `docs/features/*` on every write.

**Opt-outs:** `opts.validate === false` skips *all* guarding (migration/back-fill
tooling only). `opts.allowForwardRefs === true` keeps shape validation but lets a
known-good forward-reference (link A→B written before B is scaffolded) through —
used by the typed `force` path and any legitimate batch creator.

### 3. Early existence check + audit marker at the typed link writer — `linkFeatures()` (`lib/feature-writer.js`)

The chokepoint (step 2) is now the safety net for dangling targets on *all*
paths, but `linkFeatures` keeps its own check for two reasons: a **clearer early
error** (named `to_code`, before mutating the links array) and **audit
observability**.

After the existing `kind` check, if `to_code` is set (non-`external` kinds),
assert `featureCodeExists(cwd, to_code)`. On a miss without `force`, throw
`DANGLING_LINK_FEATURES_TARGET: <to_code> does not exist in any source (pass
force to override)`. When `force` is set, persist via `writeFeature(..., {
allowForwardRefs: true })` so the chokepoint does not re-block the intentional
forward-reference.

**`force` override observability.** `linkFeatures` currently stamps `forced` only
on the duplicate-overwrite case (`matchIdx !== -1`). Broadening `force` to mean
"persist a dangling target anyway" must be visible: the emitted link event gains
a `forced_dangling: true` marker (distinct from the overwrite `forced`) so the
one case -1 intentionally allows is auditable rather than silent. Tests assert
the marker.

**DANGLING closure (now maximal).** Existence is enforced at **both** the typed
writer (early, friendly, audited) and the chokepoint (catches raw
`writeFeature`/`persistFeatureRaw` writes that embed a `links[]` array directly).
Together they close `DANGLING_LINK_FEATURES_TARGET` for every programmatic write
path; only out-of-band hand-edits remain a read-validator concern.
`FEATURE_JSON_SCHEMA_VIOLATION` (shape) is fully closed at the chokepoint.

### 4. Close the bypass writes — `writeFeatureGroupToDisk()` + ideabox promote

- `writeFeatureGroupToDisk()` (`server/feature-scan.js`) does its own atomic
  `tmp+rename` and skips `writeFeature`. Call `assertValidFeatureShape` on each
  feature before its write so the vision route can't persist a malformed shape.
- **Ideabox promote** writes a fresh `feature.json` via direct `fs.writeFileSync`
  in two places — `server/ideabox-routes.js:183` (HTTP) and `bin/compose.js:2330`
  (CLI). Route both through `writeFeature` (preferred — they construct a plain
  feature object anyway) so they inherit the chokepoint shape guard, or guard
  inline with `assertValidFeatureShape` if routing is too invasive. Without this,
  Phase 1 leaves a real write-time hole.

## Key Decisions (for the gate)

1. **Chokepoint vs typed-writer-only injection** → **chokepoint** for shape.
   Rationale: the leak is the bypass paths; only the chokepoint covers them with
   one rule set. Recommended.
2. **Reject vs normalize** → **reject** (throw). Normalization is -2. Keeps -1 a
   clean gate and the dependency boundary honest.
2b. **Existence at the chokepoint too** (gate decision, approved) → existence is
   enforced at the chokepoint *and* the typed writer for maximal DANGLING
   closure on raw writes. Kept cheap by running the scan only for link-bearing
   writes + per-`cwd` memoization; forward-refs pass `allowForwardRefs`.
3. **Existing-invalid-files risk.** If a flow rewrites a *currently-invalid*
   feature.json unchanged, the new chokepoint guard will now throw. This is rare
   (most writes are read-modify-write of valid data) and is the *correct*
   signal, but it means landing -1 may surface latent bad files. Mitigation:
   the `{ validate: false }` opt-out exists for migration, and -2 reconcile is
   the backlog remedy. Surfaced here so it's a conscious choice, not a surprise.
4. **Existence check strictness** → blocks by default, `force` overrides. Mirrors
   the read validator's `error` severity for `DANGLING_LINK_FEATURES_TARGET`.

## Unproven assumptions

- That no hot-path flow legitimately writes a feature.json the schema would
  reject (verified-low risk given `additionalProperties: true`; full test suite
  in Phase 7 is the proof). If Phase 7 surfaces a legitimate rejection, that file
  or that writer is the bug to fix — not the guard to weaken.

## Affected files

- `lib/feature-write-guard.js` *(new)* — shared guard + existence helper
- `lib/feature-json.js` *(existing)* — `writeFeature` calls the shape guard
- `lib/feature-writer.js` *(existing)* — `linkFeatures` calls the existence guard
- `server/feature-scan.js` *(existing)* — `writeFeatureGroupToDisk` calls the shape guard
- `server/ideabox-routes.js` *(existing)* — promote: route through `writeFeature` / guard
- `bin/compose.js` *(existing)* — ideabox promote CLI: route through `writeFeature` / guard
- `lib/feature-validator.js` *(existing)* — refactor `loadValidationContext` to
  consume the shared `knownFeatureCodes` (converge, don't duplicate)
- `test/feature-write-guard.test.js` *(new, `node:test`)* — golden + error harness
