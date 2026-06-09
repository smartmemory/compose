# COMP-MIGRATE-UNIFY-VISION — Fold vision-state migrations into the registry

**Status:** PLANNED · **Filed:** 2026-06-10 · follow-up to COMP-MIGRATE-ON-UPGRADE · Owner: compose

## Context
COMP-MIGRATE-ON-UPGRADE built a versioned feature.json migration registry (`lib/state-migrations.js`).
The inline vision-state migrations (`featureCode→lifecycle.featureCode`, gate-outcome normalize in
`server/vision-store.js` + `lib/vision-writer.js`) still live separately and run lazily on every load.

## Goal
Promote the vision-state transforms into the same registry so lazy-on-load and eager-on-upgrade share one
implementation and one `stateVersion` line. Not urgent — vision-state is already migrated on load — so this is
consolidation/maintainability, not a correctness gap.

## Acceptance Criteria
- [ ] Vision-state transforms expressed as registry entries (pure functions), reused by both the eager runner and the load-time path.
- [ ] No behavior change to existing lazy-on-load migration (byte-identical output on a corpus).
- [ ] `runStateMigrations` walks vision-state items too when a vision migration is pending.
- [ ] Tests: shared-implementation parity (load path vs eager path produce identical results).
