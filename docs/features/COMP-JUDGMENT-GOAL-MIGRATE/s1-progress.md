# COMP-JUDGMENT-GOAL-MIGRATE — S1 build progress

Blueprint authority: `blueprint.md` (13 corrections C1-C13). Design authority: `design.md` r4.
S1 gate: `node --test test/judgment-store.test.js test/judgment-writer.test.js`

## S1 scope (this slice)
- lib/judgment-writer.js: migration helpers (preimage capture, merged-state build,
  artifact equality, attestation resolution, buildGoalMigrationIntent,
  applyGoalMigrationIntent), register in INTENT_APPLIERS, C13 injection seam
  (appliers param threaded runOp→replay→publishIntentLocked + replayPendingIntents).
- lib/judgment/store/index.js: effectiveStore.readGoalState preimage substitution (C3).
- Minimal migrate executor happy-path (validateGoalDispatch `migrate` branch +
  GOAL_EXECUTORS.migrate) so S1 tests call the real op and get `{status:"migrated"}`.
  FENCE / no-op / revived-conflict / retirement are S2 — do NOT add here.
- Fix existing broken fixture test 1990 (C10): the JUDGMENT_INTENT_PENDING half now
  needs the C13 injection (blocked applier) since a real applier completes migration.

## Front-loaded from S2 (noted so S2 does not duplicate)
- migrate validation branch (zero-arg) + GOAL_EXECUTORS.migrate happy path.
- S2 still owns: central pre-executor fence on non-migrate ops, legality-window
  guard, migrationCompletion no-op/already-migrated, revived-objective conflict,
  JUDGMENT_OBJECTIVE_RETIRED in judgmentPositionCreate.

## Status
- [x] Implementation written (writer migration machinery + C3 store substitution + C13 seam + minimal migrate executor)
- [x] S1 tests written (6 in writer test + 2 C3 preimage tests in store test)
- [x] S1 gate green: `node --test test/judgment-store.test.js test/judgment-writer.test.js` → 76 pass
- [x] Full judgment set green (194 pass): schema+store+writer+guard-integration+gen+mcp
- [x] Codex sol/xhigh review R1 folded (5 findings, all real, all fixed + regression-tested)
- [x] Codex R2 verification: confirmed R1 fixes correct; 2 exotic MEDIUM edges found + fixed
- [x] Full node suite green: 4948 pass, 0 fail
- [x] Committed + pushed to main @857a721 (pre-push full npm test green)

## Next: S2 — DONE, see [s2-progress.md](s2-progress.md)
See blueprint S2 — central pre-executor fence (do NOT copy into the 4 executors),
zero-arg migrate validation is ALREADY front-loaded, legality-window guard,
migrationCompletion (no-op/already-migrated + revived-objective conflict),
JUDGMENT_OBJECTIVE_RETIRED in judgmentPositionCreate.execute. Also: S2 should give
the migrate executor a real result derived from migrationCompletion instead of the
unconditional {status:'migrated'} (S1-minimal; only ever wrong under injection).
S2 gate: `node --test test/judgment-writer.test.js test/judgment-guard-integration.test.js`

## Codex R2 findings folded (both exotic, both fixed + regression-tested)
- R2-M1 canonicalize dropped own `__proto__` (acc[k]= hit prototype setter) →
  replaced with stableStringify (direct string assembly, never writes to an
  object). Two records differing only in `__proto__` now conflict.
- R2-M2 large ids (gj beyond 2^53) bypassed ambiguity via float imprecision →
  buildGoalMigrationIntent now runs allocateStableEntryId on the MERGED state
  (string-duplicate check) → JUDGMENT_MIGRATION_CONFLICT. Preimage-only check
  was insufficient (collision emerges only in the merge).
- Regression tests added (2): __proto__ injection, 2^53 preimage id.
- Full judgment set: 200 pass. Review loop stopped at R2 (budget: ~3 rounds,
  remaining edges pathological — diminishing returns).

## Codex R1 findings folded (all confirmed real vs design/blueprint)
- H1 malformed occupied slot → wrong file: occupancy now filename-based
  (highestChainNumberOnDisk); occupied-but-unparseable/differing → conflict.
- H2 C13 exported-injection bypass: appliers no longer on exported
  publishIntentLocked/replayPendingIntents; internal publishIntentWith seam only,
  reachable via writers' internal.appliers (not MCP).
- M1 ambiguous preimage ids: captureGoalStatePreimage runs allocateStableEntryId
  (joints+load_links) → JUDGMENT_MIGRATION_CONFLICT before persist.
- M2 note identity: preflight keys on (kind:note + intent_id) alone → title/anchor
  tamper conflicts (design r4:66 same-intent differing-body).
- M3 key-order equality: artifactsEqual canonicalizes (sorted keys); state.json byte-level.
- Regression tests added (4): malformed-slot, ambiguous-ids, note-title-tamper,
  reorder-equal-skip. Full judgment suite: 198 pass.

## Self-adversary notes (pre-Codex)
- artifactsEqual uses JSON.stringify → key-order sensitive. Verified write→read
  round-trip preserves payload key order for goal (version-first) + tombstone
  (rev-last via {...record, rev}). Green tests confirm.
- Replay determinism: applier NEVER re-stamps; uses persisted payload verbatim
  (one captured timestamp shared across all artifacts + created_at).
- captureGoalStatePreimage validates the preimage (wrapped as MIGRATION_CONFLICT),
  so buildMigrationState only ever preserves valid gj<N> ids → merged schema-valid.
- KNOWN S1-minimal gaps (S2 owns, not defects): migrate executor ignores
  publication status (real applier never blocks so always 'migrated'); no
  legality-window guard / no wholesale fence / no already-migrated no-op.
- C13 seam is `internal.appliers` (3rd positional), NOT MCP-reachable;
  validateGoalMigrateArgs rejects an `appliers` key in args.

## Landmines (from resume doc)
- Do NOT touch ROADMAP.md (row 192) or docs/features/COMP-TRIAGE-POOL/ — parked, not ours.
- Codex review output ~475KB: read verdicts with `tail -c 8000 <file>`, never Read whole.
- NO schema edits, NO judgment-gen.js edits (C7/C8 — parent pre-shipped).
