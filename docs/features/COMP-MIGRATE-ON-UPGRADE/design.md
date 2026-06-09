# COMP-MIGRATE-ON-UPGRADE — Design

**Status:** Phase 1 DESIGN (intent, not shipped code — review as a design doc, not an implementation)
**Date:** 2026-06-09 · **rev 2** (incorporates Codex design-gate findings 1–7)
**Owner:** compose
**Strategic row:** `/Users/ruze/reg/my/forge/docs/features/COMP-MIGRATE-ON-UPGRADE/plan.md` (forge-top pointer)

## Problem

`compose upgrade` (`bin/compose.js` → `runUpdate`) refreshes code, skills, and project scaffolding, but runs **no state migration**. State migration today is:
- **lazy/opportunistic** for vision-state — `server/vision-store.js` + `lib/vision-writer.js` migrate `featureCode→lifecycle.featureCode` and normalize gate outcomes **on every vision-state load**; and
- **manual** — `compose roadmap migrate` (ROADMAP→feature.json backfill) and `compose validate --fix`.

There is **no migration path for `feature.json` cold data at all.** Evidence: 12 live `FEATURE_JSON_SCHEMA_VIOLATION` errors = 4 features (COMP-UI-3/4/5/6) carrying **legacy free-text** `complexity` (`"high"`/`"medium"`) × 3 oneOf sub-errors each; the schema allows `string enum [S,M,L,XL] | number`, not free text. `validate --fix` doesn't cover the class; nothing rewrites a feature.json that isn't being mutated. (Initial read mistook the value for `null` — that was an absent-key artifact; corrected after a dry-run against real data.)

## Scope decision (narrower than the filed plan — ship-narrow-first)

The filed plan called for eager-walking **both** feature.json and vision-state. Investigation shows **vision-state cold data is already migrated eagerly on load** (the inline migrations run for every item whenever the store is read). So re-walking vision-state adds little. v1 targets the genuine gap:

- **IN v1:** a versioned, eager, idempotent **feature.json** migration runner, wired into `upgrade`/`init`, with dry-run + report and a durable migration-state file; first migration = the `complexity` null-drop class.
- **DEFERRED (follow-up `COMP-MIGRATE-UNIFY-VISION`):** fold the inline vision-state migrations into the same registry so lazy-on-load and eager share one implementation. Not urgent (vision-state is already migrated on load).

## Design

### Migration-state store (NOT compose.json) — finding 1 & 7
The stamp lives in a **dedicated** file `.compose/data/migration-state.json`, **not** `.compose/compose.json`:
```
{ "stateVersion": <int>, "applied": [ { "version": <int>, "id": "<kebab>" } ] }
```
Rationale:
- `runInit` rebuilds `compose.json` from a fixed object (merges only `capabilities`/`agents`/`paths`, `bin/compose.js:373–415`) — an unknown top-level `stateVersion` there would be **dropped on the next init/upgrade**. A separate file under `.compose/data/` (which init does not rewrite) is durable.
- `compose.json` is load-bearing tracker config; a torn write breaks workspace resolution. Keeping the stamp out of it removes that blast radius. The state file is still written **atomically** (temp + rename, mirroring `writeFeature`). Absent file ⇒ `stateVersion = 0`.

### Migration registry — `lib/state-migrations.js`
Ordered, append-only array. Each entry:
```
{ version: <int>,            // target stateVersion this migration brings the workspace to
  id: '<kebab>',
  describe: '<one line>',
  migrateFeature(feature) -> { changed: boolean, feature } }   // PURE, TOTAL: never throws on valid-JSON input, no I/O
```
v1 entry — `normalize-complexity`: map legacy free-text complexity to the `S/M/L/XL` enum (`low→S, medium→M, high→L, xl→XL`, case-insensitive, preserving ordinal intent); leave valid enum/number untouched; drop `null`/unmappable values (optional key). Idempotent (`high→L`, then `L` is stable).
Transforms are pure/total so they're unit-testable without disk and **cannot throw on parseable input** — which is what makes the stamp converge (see below).

### featuresDir resolution — finding 2
The runner resolves the features directory via `loadFeaturesDir(cwd)` (`lib/project-paths.js:17`) and passes it explicitly to all I/O — it does **not** rely on the hardcoded `docs/features` default in `listFeatures`/`writeFeature`. Workspaces with a `paths.features` override migrate the right tree.

### Runner — `runStateMigrations(cwd, { dryRun }) -> report`
1. **Local-provider only.** Resolve the tracker; if non-local, return `{ skipped: 'non-local-tracker' }` (github-tracked workspaces own state remotely).
2. Read `stateVersion` from `.compose/data/migration-state.json` (absent ⇒ 0). `pending = registry.filter(m => m.version > current)` sorted ascending. None ⇒ `{ migrated: [], from, to: from, noop: true }`.
3. **Own directory walk** (finding 4) — list `<featuresDir>/*/feature.json`; for each, `JSON.parse` inside try/catch. **Parse failures are recorded in `report.parseErrors[]`** (loud, not swallowed — does not reuse `listFeatures`, which silently skips unreadable files, `feature-json.js:121`).
4. For each parseable feature, apply each pending migration's `migrateFeature` in version order. If any returned `changed`, write atomically via `writeFeature(cwd, feature, featuresDir, { validate: false })` (validate:false — one migration may be a step toward validity; final validation is `compose validate`, not the migrator's job).
5. **Stamp advancement / convergence — finding 3.** A pure/total transform cannot throw on a parseable feature, so the only failures are *unparseable files* (data corruption) — which are **not** "stuck at version N-1", they're broken and need manual repair. Therefore:
   - If no `migrateFeature` threw (the expected case), advance `stateVersion` to `max(pending.version)` and append the applied entries — **even if some files were unparseable**. Parse errors are reported but do **not** pin the version (otherwise one permanently-corrupt file re-runs the whole stack forever and `stateVersion` loses meaning).
   - If a `migrateFeature` *does* throw (a developer bug — transforms are contractually total), **abort without bumping** and surface it as a migration-code error. That's a fail-fast on a broken migration, not on bad data.
   - Write the state file atomically only when not `dryRun`.
6. Return `{ from, to, dryRun, perMigration:[{id,version,touched:[codes]}], parseErrors:[{path,message}] }`.

### Safety / invariants
- **Idempotent** — `stateVersion` current ⇒ noop; transforms idempotent (null-drop on already-dropped key ⇒ `changed:false`).
- **Atomic per feature AND for the state file** — both via temp+rename (finding 7). A crash mid-run leaves migrated files valid and the stamp un-advanced ⇒ next run re-attempts the rest (idempotent).
- **Narrative-safe** — touches only `feature.json`; never regenerates `ROADMAP.md`.
- **Convergent** — see step 5: corrupt data is reported, not a permanent block.

### Wiring — finding 6 (explicit cwd, no reliance on runInit's process.cwd())
- **`runUpdate`** (`bin/compose.js`): it already resolves the workspace into a local `cwd` (`:593`). After `npm install` + `runSetup`, call `runStateMigrations(cwd, {})` **directly with that resolved `cwd`** (do NOT piggyback on `runInit`, which ignores the resolved root and uses `process.cwd()`, `:338`). Print a one-line summary.
- **`runInit`**: call `runStateMigrations(cwd, {})` with init's own resolved `cwd` after the config write, so a freshly-(re)initialised project reaches current `stateVersion`.
- **CLI — finding 5:** add a **new top-level verb** `compose migrate-state [--dry-run]`. Do **not** overload `compose roadmap migrate` (the existing backfill handler at `bin/compose.js:1079`) — they're unrelated. `migrate-state` resolves the workspace cwd and calls the runner.
- Per-workspace — forge-top / compose / stratum each migrate independently.

## Contracts touched
- New file `.compose/data/migration-state.json` (additive; absent ⇒ 0). No change to `compose.json` shape.
- No change to `feature-json.schema.json`. The null-drop makes existing files *pass* the current schema; schema tightening is the separate deferred `COMP-MCP-VALIDATE-SCHEMA-TIGHTEN`.

## Test plan (golden + unit)
- **Unit** (pure transforms): `drop-null-complexity` drops null, leaves `"M"`/`3`/absent untouched, idempotent.
- **Runner golden** (mkdtemp ws, custom `paths.features` to prove resolution): seed 3 feature.json (one null complexity, one valid, one already-migrated), no state file → run → null one rewritten, others untouched, `migration-state.json` stateVersion=1, report lists the touched one. Re-run → noop, no writes.
- **parseErrors**: seed a malformed feature.json → reported in `parseErrors[]`, other features still migrated, stamp still advances (convergence).
- **dryRun**: reports plan, writes nothing, no state file created.
- **migration-code fault**: a registry entry whose transform throws on valid input → run aborts, stamp NOT advanced, error surfaced.
- **Local-only**: github-tracker workspace → `skipped: non-local-tracker`, no writes.
- **Durability**: write state file, run `runInit` → state file survives (init doesn't touch `.compose/data/`).
- **Wiring**: `runInit` on a ws with a null-complexity feature → feature valid + state file stamped (reuses existing init test harness).

## Resolved questions
1. CLI shape → **new `compose migrate-state` verb** (not `--all` on roadmap migrate, which doesn't exist as `compose migrate`).
2. Run `validate` after migrating? No — keep migration and validation separate; the upgrade summary may *suggest* `compose validate`.
3. Stamp location → **`.compose/data/migration-state.json`**, not `compose.json` (durability + blast-radius).
