# COMP-MCP-VALIDATE-1 — Implementation Blueprint

**Status:** Phase 4 blueprint + Phase 5 verification
**Design:** `./design.md` · **Parent:** COMP-MCP-VALIDATE

## Overview

One new module + edits to the chokepoint, the typed link writer, the local
provider, and the three bypass writers, plus a one-file corpus repair. The new
`lib/feature-write-guard.js` owns the reusable primitives (shape validation via
the existing Ajv `SchemaValidator`, the known-codes index, the error type). The
chokepoint (`writeFeature`) and the typed link writer (`linkFeatures`) call into
it; the bypass writers are routed through the guard. `feature-validator.js` is
**not** modified (the read path stays exactly as-is).

## Corrections table (spec assumption vs reality)

| Design said | Reality | Resolution |
|---|---|---|
| `writeFeature(cwd, feature, featuresDir, opts)` | Today only `(cwd, feature, featuresDir='docs/features')` — `feature-json.js:52` | Add optional 4th `opts = {}` param; back-compat (all existing 3-arg callers unaffected) |
| Reuse the validator's `getValidator`/`FEATURE_JSON_SCHEMA` | Both are **module-private** in `feature-validator.js:49,97` | Guard constructs its **own** memoized `new SchemaValidator(schemaPath)`; `schemaPath = resolve(__dirname,'../contracts/feature-json.schema.json')` (same file) |
| `knownFeatureCodes` mirrors `loadValidationContext` union | The 3 sources are inline in private `loadValidationContext` (`feature-validator.js:205,215,222`); the union is recomputed at `:1095` | Extract the ROADMAP row scanner (`:144-202`) into the shared module as `scanRoadmapRows`; guard's `knownFeatureCodes` reads folders + `scanRoadmapRows` + vision-state; `loadValidationContext` consumes `scanRoadmapRows` too (converge) |
| Ideabox promote writes a normal feature.json | Writes a **divergent shape** `{code,description,status,promotedFrom,createdAt}` (no `created`/`updated`), raw `fs.writeFileSync`, no newline — `ideabox-routes.js:186`, `bin/compose.js:2332` | Schema is `additionalProperties:true` / only `code` required → the shape **passes**. Route both through `writeFeature` (stamps `updated`, adds newline, inherits guard). No new links ⇒ existence scan never runs here |
| `linkFeatures` `force` already covers dangling | `force` only stamps `forced` on duplicate-overwrite (`feature-writer.js:583,601`); `external` kind is delegated *before* the guards (`:555`) | Add existence check after `LINK_KINDS` guard (non-external only); on `force` persist via `writeFeature`-equiv with `allowForwardRefs` semantics and stamp `forced_dangling` in the event |
| `writeFeatureGroupToDisk` just needs a guard call | It only mutates `group`, does atomic tmp+rename, returns `false` on any failure (`feature-scan.js:358-407`) | Validate `spec` shape before the atomic write; on invalid → `console.warn` + `return false` (no partial write), matching its best-effort contract. Legacy-invalid files are -2's cleanup |

## Boundary Map

- `assertValidFeatureShape` (function) — in `lib/feature-write-guard.js` (new).
  `(feature, opts?) → void`; throws `FeatureWriteValidationError` when the
  Ajv `validateRoot` reports `!valid`. Consumed by `writeFeature` (S1 from S0),
  `linkFeatures` via `writeFeature`, `writeFeatureGroupToDisk`, ideabox writers.
- `assertLinkTargetsExist` (function) — in `lib/feature-write-guard.js` (new).
  `(cwd, feature, opts?) → void`; for each non-`external` `links[].to_code`
  missing from `knownFeatureCodes(cwd) ∪ {feature.code}`, throws unless
  `opts.allowForwardRefs`. Consumed by `writeFeature`.
- `knownFeatureCodes` (function) — in `lib/feature-write-guard.js` (new).
  `(cwd) → Set<string>`; union of feature folders + `scanRoadmapRows` + vision
  items. Consumed by `assertLinkTargetsExist` and `linkFeatures`. Memoized per
  `cwd`.
- `scanRoadmapRows` (function) — in `lib/feature-write-guard.js` (new).
  `(roadmapPath) → string[]` (strict codes); self-contained, **not** extracted
  from the validator's dual-purpose loop. Consumed by `knownFeatureCodes`.
- `FeatureWriteValidationError` (class) — in `lib/feature-write-guard.js` (new).
  Extends `Error`; carries `.kind` (`FEATURE_JSON_SCHEMA_VIOLATION` |
  `DANGLING_LINK_FEATURES_TARGET`) and `.violations[]`. Consumed by callers that
  surface structured errors (MCP handlers, CLI).
- `writeFeature` (function) — in `lib/feature-json.js` (existing). Gains 4th
  param `opts = {}` (`{validate?, allowForwardRefs?}`); calls
  `assertValidFeatureShape` + `assertLinkTargetsExist` before `writeFileSync`.
- `putFeature` (function) — in `lib/tracker/local-provider.js` (existing). Gains
  4th param `opts = {}`, forwarded to `writeFeature`. `github-provider.putFeature`
  accepts+ignores it for parity. Consumed by `linkFeatures` (S2 from S0).

## Per-file plan

### S0 — `lib/feature-write-guard.js` *(new)*
Exports `FeatureWriteValidationError`, `assertValidFeatureShape`,
`knownFeatureCodes`, `assertLinkTargetsExist`, `scanRoadmapRows`.
- Module-level memoized `SchemaValidator` (one instance, keyed by schema path)
  mirroring `feature-validator.js:97-101`.
- `assertValidFeatureShape(feature)`: `const {valid,errors}=validator.validateRoot(feature)`;
  if `!valid` throw `FeatureWriteValidationError('FEATURE_JSON_SCHEMA_VIOLATION',
  errors.map(e=>`${e.instancePath||'/'}: ${e.message}`))`.
- `scanRoadmapRows(roadmapPath)`: lift `feature-validator.js:144-202` verbatim
  (column-aware table scan, strict-code filter).
- `knownFeatureCodes(cwd)`: resolve paths from `.compose/compose.json`
  (`paths.features|roadmap|visionState`, defaults `docs/features` /
  `ROADMAP.md` / `.compose/data/vision-state.json`); build a `Set` from folder
  dirnames (strict regex), `scanRoadmapRows` codes, and vision items
  (`item.lifecycle?.featureCode||item.featureCode`). **No memoization** (Codex
  finding 3: ROADMAP/vision change independently of `writeFeature` in the
  long-lived server → a write-invalidated cache goes stale and false-rejects).
  Reads are fresh; the cost is bounded because existence runs **only** on the
  rare link-bearing write. **No import of `feature-validator.js` or
  `feature-json.js`** (cycle-free).
- `scanRoadmapRows(roadmapPath)`: a **self-contained lean code scan** — read
  ROADMAP.md, match table rows, collect strict-regex codes. **Do NOT extract
  from `loadValidationContext`** (Codex finding 1: that loop is dual-purpose —
  it also builds `citationRows` consumed by `collectExternalRefs` for
  `XREF_MALFORMED`; lifting only the row scan would silently change read-validator
  behavior). The guard only needs the code set, so it computes its own; minor
  duplication is the correct trade vs. perturbing XREF parsing.
- `assertLinkTargetsExist(cwd, feature, {allowForwardRefs}={})`: if no
  non-external `to_code` links → return immediately (zero I/O — the cheap path);
  else `const known = knownFeatureCodes(cwd)`; for each missing target (not in
  `known` and `!== feature.code`) collect; if any and `!allowForwardRefs` throw
  `FeatureWriteValidationError('DANGLING_LINK_FEATURES_TARGET', missing)`.

**Resolved:** no reusable exported project-paths helper exists —
`readProjectConfig`/`resolveProjectPaths` are private to `feature-validator.js:105,110`.
The guard **inlines** a tiny `.compose/compose.json` read for
`paths.{features,roadmap,visionState}` with defaults (cycle-free, self-contained).

### S1 — `lib/feature-json.js` `writeFeature` *(edit, :52)*
Add `opts = {}`. Before `writeFileSync`:
```js
if (opts.validate !== false) {
  assertValidFeatureShape(feature);
  assertLinkTargetsExist(cwd, feature, { allowForwardRefs: opts.allowForwardRefs });
}
```
No cache to invalidate (existence reads fresh). Import from
`./feature-write-guard.js`.

### S2 — `lib/feature-writer.js` `linkFeatures` *(edit, :549-607)*
After the `LINK_KINDS` guard (`:568`), before `maybeIdempotent`:
```js
if (!args.force && !knownFeatureCodes(cwd).has(args.to_code)) {
  throw new FeatureWriteValidationError('DANGLING_LINK_FEATURES_TARGET',
    [`${args.to_code} does not exist in any source (pass force to override)`]);
}
```
**Resolved — opts threading.** `local-provider.putFeature(code, obj)` calls
`writeFeature(this.cwd, {...obj, code}, this.featuresDir)` with **no 4th arg**
(`lib/tracker/local-provider.js:65-70`). So a `force`d dangling link persisted
via `putFeature` would be **re-blocked** by the chokepoint existence check.
Fix (option a, minimal): add an optional `opts = {}` 4th param to
`LocalFileProvider.putFeature` (and `github-provider.putFeature` for parity —
accept+ignore), forwarded as `writeFeature(..., opts)`. `linkFeatures` then
persists with `provider.putFeature(args.from_code, {...feature, links},
{ allowForwardRefs: !!args.force })`. For the non-force path, the target already
exists (validated above) so the chokepoint check passes anyway — threading only
matters for `force`.
Event marker: in `safeAppendEvent` (`:595-603`) add
`forced_dangling: (args.force && !knownFeatureCodes(cwd).has(args.to_code)) || undefined`
alongside the existing `forced`.

### S3 — `server/feature-scan.js` `writeFeatureGroupToDisk` *(edit, :398)*
Before the tmp write (`:399`):
```js
try { assertValidFeatureShape(spec); }
catch (err) { console.warn(`[feature-scan] invalid feature.json at ${specPath}: ${err.message}`); return false; }
```
Import from `../lib/feature-write-guard.js`.

### S4 — ideabox promote ×2 *(edit)*
- `server/ideabox-routes.js:184-193`: replace the raw `fs.writeFileSync` with
  `writeFeature(projectRoot, {code:resolvedCode, description:sourceIdea.title,
  status:'PLANNED', promotedFrom:sourceIdea.id, createdAt:new Date().toISOString()},
  featuresRel)`. Import `writeFeature` from `../lib/feature-json.js`.
- `bin/compose.js:2330-2338`: same, via the existing lazy-import pattern
  (`const { writeFeature } = await import('../lib/feature-json.js')`).

### S5 — *(removed)*
The `loadValidationContext` refactor is **dropped** — see Codex finding 1. The
guard owns its own `scanRoadmapRows`; `feature-validator.js` is left untouched.

### S6 — repair the one shape-invalid corpus file *(edit, required to land the guard)*
Codex finding 2: a corpus scan (`SchemaValidator` over every
`docs/features/*/feature.json`) found **exactly one** shape-invalid file —
`docs/features/COMP-ROADMAP-GRAPH-1/feature.json:11-17`: a `kind:external`,
`provider:local` link with `repo`+`path` but **no `to_code`** (schema:104
requires `repo`+`to_code` for local). Once the chokepoint validates, any rewrite
of this feature (status/completion via `persistFeatureRaw`, `build.js:791/1889`,
`completion-writer.js:321`) would throw. Repair: add `"to_code": "META-GRAPH-1"`
(the feature the `note`/`path` reference); keep `repo`; `path` stays as tolerated
extra (`additionalProperties` on link items is not `false`). This is a genuine
malformed cross-repo ref, bounded to one file — not the -2 bulk reconcile.
A regression test asserts the **whole corpus is shape-clean** so a new invalid
file can't silently reintroduce the blocker.

**Cycle check:** `feature-json → feature-write-guard → {server/schema-validator,
feature-code, fs}`; `feature-writer → feature-write-guard`. `feature-write-guard`
imports none of `{feature-json, feature-validator, feature-writer}` → no cycle.
`feature-validator.js` is no longer touched (S5 removed).

## Test plan — `test/feature-write-guard.test.js` *(new, `node:test`)*

Mirror `test/feature-validator.test.js` fixtures (`newFixture`, real temp dirs).
- **Golden (happy):** valid feature with a `depends_on` link to an existing
  folder writes cleanly via `writeFeature`.
- **Error harness (reject):** bad `kind` (`informs`), missing `to_code` on
  non-external, dangling `to_code`, bad `code` pattern → each throws
  `FeatureWriteValidationError` with the right `.kind`.
- **External link** with no `to_code` → passes (no existence error).
- **Forward-ref:** dangling target + `{allowForwardRefs:true}` (writeFeature) and
  `force` (linkFeatures) → writes, event carries `forced_dangling:true`.
- **Opt-out:** `{validate:false}` writes an invalid shape (migration path).
- **Cheap path:** a link-less write does not read ROADMAP/vision (assert via a
  fixture with no ROADMAP.md present → still succeeds, no throw).
- **Convergence:** `knownFeatureCodes` returns the same union the read
  validator's dangling check uses (folder-only, roadmap-only, vision-only codes
  each count as existing).
- **Ideabox/bypass:** `writeFeatureGroupToDisk` on an invalid spec returns
  `false` and does not write; routed ideabox promote produces a guard-valid file.

## Phase 5 — Verification table

| Claim | File:line | Verified |
|---|---|---|
| `writeFeature` is `(cwd, feature, featuresDir='docs/features')`, no validation | `lib/feature-json.js:52-58` | ✅ |
| `SchemaValidator.validateRoot(obj) → {valid,errors}`, no `load()` precondition | `server/schema-validator.js:33,74-85` | ✅ |
| `getValidator`/`FEATURE_JSON_SCHEMA` private to feature-validator | `lib/feature-validator.js:49,97-101` | ✅ |
| 3 existence sources inline in `loadValidationContext`; union at `:1095` | `lib/feature-validator.js:205,215,222,1095` | ✅ |
| ROADMAP scanner is inline `:144-202`, not `parseRoadmap` | `lib/feature-validator.js:144-202` | ✅ |
| dangling check = `to_code` ∈ folders∪roadmap∪vision | `lib/feature-validator.js:586-588` | ✅ |
| `linkFeatures` delegates `external` pre-guards; `LINK_KINDS` at `:563`; `forced` at `:601` | `lib/feature-writer.js:555,563,601` | ✅ |
| `LINK_KINDS` = 6 (no `external`) | `lib/feature-writer.js:409-412` | ✅ |
| `writeFeatureGroupToDisk` atomic tmp+rename, returns false on failure | `server/feature-scan.js:398-407` | ✅ |
| ideabox promote raw `fs.writeFileSync`, divergent shape, `writeFeature` not imported | `server/ideabox-routes.js:186`, `bin/compose.js:2332` | ✅ |
| schema `additionalProperties:true`, only `code` required → divergent shape passes | `contracts/feature-json.schema.json` | ✅ |
| tests are `node:test`, picked up by `test/*.test.js` glob | `test/feature-validator.test.js:1`, `package.json:22` | ✅ |
| corpus has exactly ONE shape-invalid file (the blocker) | `docs/features/COMP-ROADMAP-GRAPH-1/feature.json:11` | ✅ (live `SchemaValidator` scan) |
| `loadValidationContext` roadmap loop is dual-purpose (also builds `citationRows`) → don't extract | `lib/feature-validator.js:139,789` | ✅ |
| `local-provider.putFeature` does not forward a 4th arg to `writeFeature` | `lib/tracker/local-provider.js:65-70` | ✅ |

Open verification — both **resolved** (see S0/S2 above):
1. ✅ No reusable project-paths helper (`feature-validator.js:105,110` private) → guard inlines compose.json read.
2. ✅ `local-provider.putFeature:65-70` does **not** forward opts → thread `opts` param through `putFeature` → `writeFeature`; `linkFeatures` passes `allowForwardRefs` on `force`.

Zero stale references. Zero Boundary Map violations expected.
