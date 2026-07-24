# COMP-JUDGMENT-GOAL-MIGRATE — S2 build progress

Blueprint authority: `blueprint.md` (S2 section + C5/C6/C11/C13). Design authority: `design.md` r4.
S2 gate: `node --test test/judgment-writer.test.js test/judgment-guard-integration.test.js`

## S2 scope (this slice)
- `lib/judgment-writer.js`:
  - `migrationCompletion(effective, raw)` — the r4 completion predicate, returning
    a discriminated status (`none` / `attribution_conflict` / `pending` /
    `revived` / `incomplete` / `complete`) plus the weaker `attested` flag the
    fence keys on.
  - `assertGoalMigrationFence(cwd, op)` — ONE central pre-executor fence for
    every non-`migrate` goal op, wired in `judgmentGoalWrite`'s `execute`.
    `goalWriteContext` runs first, so `JUDGMENT_INTENT_PENDING` keeps precedence.
  - `GOAL_EXECUTORS.cut` — the S1-shipped cut-local fence REMOVED (centralized).
  - `GOAL_EXECUTORS.migrate` — completion/repair diagnostics before the legality
    window; `already migrated` no-op (regenerate projections, no record); revived
    -objective conflict; non-empty-chain and non-live-objective conflicts.
  - `judgmentPositionCreate.execute` — `JUDGMENT_OBJECTIVE_RETIRED` for a
    post-cutover non-tombstone `objective` revision (C6), under the lock, after
    replay, via `effectiveStore` + `goalCutoverComplete`.
- `test/judgment-writer.test.js`: the 7 blueprint S2 tests + updated exact fence
  message in the pre-existing `legacy-live/no-goal requires migration` test.

## Deliberate extensions beyond the literal blueprint (both fail-closed)
- `migrate` calls `goalWriteContext`, so a migration intent that survived replay
  yields the exact existing `JUDGMENT_INTENT_PENDING` instead of building a
  SECOND intent. The blueprint only names the pending check for non-`migrate`
  ops; duplicating an intent is strictly worse and only reachable through the
  C13 injection seam. Pinned by test S2.6.
- The `already migrated` no-op wraps a regeneration failure as
  `JUDGMENT_PROJECTION_STALE` (the published-migration semantics: never roll a
  committed migration back for a projection failure), rather than letting an
  untyped generator error escape the writer. Pinned by test S2.2.

## Not in scope (verified, not defects)
- `judgmentPositionAmend` is not fenced by C6. It is naturally closed:
  post-cutover the latest `objective` revision is the tombstone with `claims: []`,
  so an amend refuses with `JUDGMENT_NOT_FOUND` on its `claim_id`.

## Status
- [x] Implementation written (completion predicate, central fence, migrate
      diagnostics, terminal retirement)
- [x] S2 tests written (7 blueprint tests, exact codes + messages)
- [x] S2 gate green: 74 pass
- [x] Full judgment set green: 207 pass (was 200 at S1)
- [x] Mutation-checked: disabling the fence fails 2 tests, disabling the
      retirement check fails 1, disabling the already-migrated branch fails 2
- [x] Codex sol/xhigh review R1: **CLEAN** — no defects against S2, the
      cross-slice contracts, C5/C6/C11/C13, or design r4. (Its sandbox could not
      run the gate — `EPERM` on `mkdtemp` — so the runtime gate is the local run
      above. Review loop stopped at R1: CLEAN is the exit, not a target.)
- [ ] Full node suite
- [ ] Committed

## Next: S3
MCP enum add `migrate` (keep 49/49 tool/case counts, nine judgment tools), make
`get_judgment_state`'s copy intent-generic, and replace the C10 gen/mcp fixtures
with the real migration payload. Then S4 — the owner-gated LIVE cutover of this
repo's store (NEVER auto-commit; show the owner the regenerated `OBJECTIVE.md`
diff first; idempotency_key `COMP-JUDGMENT-GOAL-MIGRATE-live-v1`).
