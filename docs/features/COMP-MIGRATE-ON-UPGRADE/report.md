# COMP-MIGRATE-ON-UPGRADE — Implementation Report

**Status:** COMPLETE · **Date:** 2026-06-09 · **Mode:** `/compose build`

## Summary

`compose upgrade` refreshed code but ran no `feature.json` state migration — cold data (legacy free-text `complexity`) sat erroring on every validate. This adds a versioned, eager, idempotent migration runner wired into `upgrade`/`init` plus an explicit `compose migrate-state` verb, with a durable state stamp. v1 migration normalizes legacy `complexity` to the `S/M/L/XL` enum; it cleared the 12 live schema-violation errors at forge-top (0 error-level findings remain).

## Delivered vs planned

- **`lib/state-migrations.js`** — registry of pure/total transforms + `runStateMigrations(cwd,{dryRun})` + `readMigrationState` + `summarizeMigrationReport`.
- **Migration v1 `normalize-complexity`** — `low→S, medium→M, high→L, xl→XL` (case-insensitive); valid enum/number untouched; null/unmappable dropped; idempotent.
- **Durable stamp** at `.compose/data/migration-state.json` (`{stateVersion, applied[]}`), atomic temp+rename — deliberately NOT in `compose.json` (init rewrites it; torn write would break tracker config).
- **Wiring** — `runInit` (threaded `cwdOverride`), `runUpdate` (`runInit([], cwd)`), new `compose migrate-state [--dry-run]` verb.
- **Tests** — 13 in `test/state-migrations.test.js` + 1 regression in `test/init.test.js`.

Scope narrowed from the filed plan (ship-narrow-first): vision-state is already migrated eagerly on load, so v1 targets the genuine gap (feature.json). Unifying vision-state into the registry is deferred to `COMP-MIGRATE-UNIFY-VISION`.

## Key decisions / corrections

- **Real-data dry-run corrected the migration.** Initial design assumed the violation was `complexity: null`; running `migrate-state --dry-run` against forge-top showed the real values are free-text `"high"`/`"medium"` (the "null" was an absent-key jq artifact). Migration changed from null-drop to enum-normalization.
- **Convergence** — corrupt/unparseable feature.json is *reported* (`parseErrors[]`), not a permanent block; the stamp still advances so one bad file can't re-run the stack forever. Transforms are pure/total (never throw on parseable input); a throwing transform is a migration-code bug → fail-fast without bumping.
- **Latent config-clobber fixed (review-caught).** `runInit` rebuilt `compose.json` from a fixed shape, silently dropping unknown top-level keys — it would have wiped the `roadmap.narrative` flag from FORGE-ROADMAP-SYNC and any `tracker` config on the next upgrade. Now spreads `...existing` to preserve them; corrupt prior config → migration skipped with a warning.

## Review

Codex gate ×3: design gate found 7 (durability, paths-override, convergence, swallowed errors, nonexistent CLI shape, cwd mismatch, atomicity) — all fixed in design rev 2; impl round 1 found 3 (non-object throw, runInit cwd, permissive tracker gate); impl round 2 found the config-clobber. Round 3 → REVIEW CLEAN.

## Test coverage

`test/state-migrations.test.js` (13): transform mapping/drop/idempotency/totality; runner golden (migrate+stamp+idempotent re-run), paths.features override, parseError convergence, dryRun, throwing-migration abort, non-local skip, unreadable-config skip, no-workspace skip, summary. `test/init.test.js` (+1): re-init preserves unknown top-level keys. Full `npm test` green.

## Files changed
- `lib/state-migrations.js` (new), `test/state-migrations.test.js` (new)
- `bin/compose.js` (runInit signature + `...existing` preserve + step 5a migration; runUpdate cwd threading; `migrate-state` verb)
- `test/init.test.js` (+1 regression)
- `docs/features/COMP-MIGRATE-ON-UPGRADE/{design,report}.md`

## Known issues / follow-ups
- `COMP-MIGRATE-UNIFY-VISION` — fold the inline vision-state migrations into the registry (deferred; vision-state already migrates on load).
- Pre-existing: `runInit` silently *overwrites* a corrupt `compose.json` with a default (we now skip migration in that case and preserve keys on the happy path, but a "refuse/back up before overwriting corrupt config" hardening is out of scope here).
