# COMP-MIGRATE-UNIFY-VISION — Implementation Report

**Status:** COMPLETE · **Shipped:** 2026-06-15 · follow-up to COMP-MIGRATE-ON-UPGRADE · Owner: compose

## What shipped

The two legacy vision-state transforms — `featureCode: "feature:X"` → `lifecycle.featureCode: "X"`
and gate-outcome normalization (`approved→approve`, `killed→kill`, `revised→revise`) — were inlined
and **duplicated** in three-ish places (`server/vision-store.js`, `lib/vision-writer.js`, plus
`vision-writer`'s own `normalizeOutcome` helper). They are now a **single implementation** in
`lib/state-migrations.js`, reused by:

- both server load-time paths (`VisionStore._load`, `VisionWriter._load`), and
- the eager `runStateMigrations` runner, which now also walks `.compose/data/vision-state.json`.

The registry gained a `target` discriminator (`'feature'` default, `'vision'` for the new entry), so
one ordered `stateVersion` sequence and one durable stamp now cover both file kinds. The vision
migration is registry **version 2** (`normalize-vision-legacy`).

## Acceptance criteria

- [x] Vision-state transforms expressed as registry entries (pure transforms), reused by the eager
      runner **and** the load-time path — `migrateVisionItemFeatureCode`, `normalizeGateOutcome`,
      `migrateVisionState` exported from `lib/state-migrations.js`.
- [x] No behavior change to existing lazy-on-load migration (byte-identical output) — locked by a
      golden test asserting exact serialized key order, plus a load-path-vs-eager-path parity test.
- [x] `runStateMigrations` walks vision-state items too when a vision migration is pending — gated on
      the shared stamp; absent file advances the stamp as a no-op; corrupt file is reported, never
      blocks the stamp (same convergence rule as feature.json).
- [x] Tests: shared-implementation parity (load path vs eager path produce identical results).

## Design decisions

- **Same registry, one stamp** (not a parallel `VISION_MIGRATIONS` array): the plan said "fold into
  the same registry … one stateVersion line." Entries dispatch by `target`; the runner splits pending
  into feature/vision walks. `compose upgrade`/`init`/`migrate-state` pick the vision walk up with no
  additional wiring (they already call `runStateMigrations`).
- **Scope is exactly the two named transforms.** Each load path's *other* work — gate/pending-key
  dedup (which differs: vision-store keeps-first + dedups pending keys, vision-writer keeps-latest) and
  slug/files/group derivation — is intentionally left in place. Unifying it would be a behavior change,
  out of scope.
- **Transforms mutate in place** (and report `changed`), mirroring the prior inline code, so the
  on-disk byte image is preserved exactly. The one intentional hardening: a `typeof featureCode ===
  'string'` guard before `.startsWith` — a non-string `featureCode` (never seen on real data) used to
  throw and lose the whole store; it is now a safe no-op. Byte-identical on any real corpus.
- **Load-time stays unconditional.** The server still migrates on every load regardless of the stamp;
  the eager walk is only a cold-data safety net (e.g. a frozen forge-top store the server never opens).
  A vision-state created *after* an upgrade is already current, so the stamp-then-absent ordering has
  no gap.

## Files

- `lib/state-migrations.js` — added `target` to the registry, the `normalize-vision-legacy` entry,
  exported vision transforms, `writeVisionStateAtomic`, vision walk in `runStateMigrations`,
  target-aware `summarizeMigrationReport`.
- `lib/vision-writer.js` — `_load` featureCode loop + `normalizeOutcome` now delegate to the shared impl.
- `server/vision-store.js` — `_load` featureCode + gate-outcome blocks now delegate to the shared impl.
- `test/state-migrations.test.js` — unit tests for the transforms, byte-identity golden, load-vs-eager
  parity, eager vision-walk golden (migrate / already-current / absent / corrupt / dry-run); existing
  feature golden tests made robust to the new latest version.

## Verification

- `test/state-migrations.test.js` + `test/vision-writer.test.js`: 49 pass.
- All vision-related + migration-adjacent suites green (`vision-store`, `vision-store-server`,
  `feature-writer-vision-projection`, `proof-run`, `build`, `session-binding`, etc.).
- Full suite run before commit.
