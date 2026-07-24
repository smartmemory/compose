# COMP-JUDGMENT-GOAL-MIGRATE — S3 build progress

Blueprint authority: `blueprint.md` (S3 section + C9/C10). Design authority: `design.md` r4.
S3 gate: `node --test test/judgment-gen.test.js test/judgment-writer-mcp.test.js`

## S3 scope (this slice)
- `server/compose-mcp.js` — three single-line edits, nothing else:
  - `judgment_goal_write` op enum gains `migrate`
    (`["cut","correct","joint_link","load_link","migrate"]`). NO new arguments.
  - `judgment_goal_write` description: the fence is described as **wholesale**
    ("Every non-migrate op is migration-locked…"), and `migrate` as the
    one-shot, fail-closed cutover that lifts it and takes no payload.
  - `get_judgment_state` description: "Replays pending judgment intents first"
    (was "pending transition intents") — intent-generic, per r4.
- `test/judgment-writer-mcp.test.js` — the four S3 MCP tests, plus the shared
  `NEW_JUDGMENT_TOOL_OPS` enum constant.
- `test/judgment-gen.test.js` — C10: the pending-migration fixture's intent is
  now the REAL S1 payload under `tool:"judgment_goal_write"`, `op:"migrate"`
  (was `tool:"judgment_goal_migrate"`, `payload:{}`), plus the S3.4 test.

Unchanged, deliberately: `toolJudgmentGoalWrite`, imports, dispatch,
`mcp-tool-policy.js`, `.mcp.json`, package exports, `renderObjective`, pruning,
`lib/judgment-writer.js`, `lib/judgment-gen.js`, and the schema (C7/C8).

## Reachability findings (recorded, not defects)
- **Two of the three `JUDGMENT_MIGRATION_CONFLICT` messages are unreachable
  across stdio**, and that is the system being tight, not a gap. C6 retires the
  objective as soon as ANY goal version exists, so neither the non-empty-chain
  conflict (needs a live objective beside an ordinary cut) nor the revived
  conflict (needs a post-cutover live objective) can be constructed through the
  registered tools. S3.3 therefore pins the reachable one — "legacy objective is
  not live and no durable migration is complete" — and names why in a comment.
  The other two stay pinned at writer level in `judgment-writer.test.js`.
- **The clear-to-regenerate obstruction must not be `OBJECTIVE.md`.**
  `buildGoalMigrationIntent` reads that file to build the note, so obstructing it
  fails *before* any canonical write (raw `EISDIR`), which is a different window
  than the one S3.5 tests. S3.5 obstructs `index.md` instead: the records commit,
  the intent clears, and only the regeneration dies —
  `JUDGMENT_PROJECTION_STALE`, repaired by the next `get_judgment_state`.
- **`seededCwd()` must leave the fixture un-regenerated.** Generating the real
  pre-migration `OBJECTIVE.md` to fill `payload.source.legacy_projection` was
  tried and reverted: it breaks the precondition the pruning and
  emits-all-projection-files tests key off. The field holds a literal, with the
  reason in a comment.

## Status
- [x] `server/compose-mcp.js` enum + both descriptions
- [x] S3 tests written (5 blueprint tests: 4 MCP + 1 gen)
- [x] S3 gate green: 35 pass
- [x] Full judgment set green: 212 pass (was 207 at S2)
- [x] Full node suite green: 4960 pass (was 4955 at S2)
- [x] Mutation-checked: dropping `migrate` from the enum fails 2 subtests,
      reverting the wholesale-fence copy fails 1, reverting the
      `get_judgment_state` copy fails 1, restoring the skeletal fixture
      `tool` fails 1
- [x] Codex sol/xhigh review R1: two findings, one accepted, one refuted (below)
- [ ] Committed

## Review R1 adjudication

**ACCEPTED — "the exact MCP error contract is only tested by substring."** Right,
and it mattered. S3.3 paired a regex for the code with `includes()` for the
message, so any prefix, suffix, or duplication would still have passed while
S3.3's whole job is that the full strings cross stdio unchanged. All three now
assert equality against `` `Error [<CODE>]: <message>` `` (the exact boundary
format, verified against a live server). Mutation-checked: appending `". "` to
the `JUDGMENT_OBJECTIVE_RETIRED` message now fails the test — under `includes()`
it passed.

**REFUTED — "the pending migration fixture is not producible by S1."** The facts
are right (inferred channel, dropped removed entries, the three fixed joints, the
`position:objective` note) but the conclusion does not hold, on two counts:

1. The stated consequence — that projection behavior against a real r4 payload
   goes unproven — is already false. `judgment-writer.test.js`, "migration
   records are atomic and projections repair after publication" (part A), drives
   the REAL writer through the C13 seam to a genuinely S1-produced pending
   migration and asserts `OBJECTIVE.md` still renders the legacy projection
   BYTE-for-byte, with `positions/objective.md` still present.
2. The fixture **cannot** be S1-faithful without destroying its own coverage.
   Its goal state carries a REMOVED association precisely so the generator's
   removed-association rendering is exercised (`judgment-gen.test.js`, "dual-read
   matrix…" asserts the `gj2`/`okf-parse` removal line and its reason), and
   `buildMigrationState` always DROPS removed entries. A real S1 payload can
   never contain one. Same tension for the note: a distinctive hidden body is
   what proves note hiding.

The legitimate kernel — the comment OVERCLAIMED, calling it "the REAL S1
payload" — is fixed: the fixture now states plainly that it is a complete-shape
intent under the real tool/op, deliberately not byte-identical to an S1 output,
and points at where the real-payload behavior is pinned instead.

Round budget: stopped at R1. Both fixes are assertion-tightening and comment
text, no behavior change, so no re-review.

## Next: S4 — the owner-gated LIVE cutover
Invoke the registered MCP surface (never a module import):
`judgment_goal_write {"op":"migrate","idempotency_key":"COMP-JUDGMENT-GOAL-MIGRATE-live-v1"}`
against this repo's `docs/judgment/` store. Show the owner the regenerated
`OBJECTIVE.md` diff and STOP. Never auto-commit the cutover.
