---
date: 2026-07-24
session_number: 97
slug: judgment-goal-migrate-cutover
summary: "COMP-JUDGMENT-GOAL-MIGRATE S1-S4: intent-backed objective→goal migration, wholesale fence, owner-gated live cutover. Compose's own objective is now goal:v1; the legacy position is a retracted tombstone with its prose preserved verbatim in canon."
feature_code: COMP-JUDGMENT-GOAL-MIGRATE
closing_line: We didn't delete the old objective — we retired it, kept every word, and let the goal store inherit the mind.
---

# Session 97 — COMP-JUDGMENT-GOAL-MIGRATE

**Date:** 2026-07-24
**Feature:** `COMP-JUDGMENT-GOAL-MIGRATE`

## What happened

This closes COMP-JUDGMENT-GOAL-MIGRATE — the slice that migrated Compose's own judgment from the legacy `objective` position to the new goal store, and then ran the migration live against this very repo. It was split out of COMP-JUDGMENT-STORES at design gate round 5 (the goal store had to ship first) and carried its own three-round Codex sol/xhigh design gate before any code.

The hard part was never the data move — it was making the move *safe*. A cutover that mutates a store in place is a one-way door: get it wrong and you've lost the reasoning the store existed to hold. So the design refused to treat migration as a mutation. It's an intent-backed, replay-durable compound op: capture a validated preimage, build the merged goal state, and apply it through the same intent-replay machinery every other judgment write uses, so a crash mid-cutover replays to the identical result instead of a torn one.

S4 was the live cutover, and it was deliberately the only slice with no test gate: a single owner-gated mutation of this repo's own `docs/judgment/`. We ran it through the registered MCP surface (never a module import, never the retired importer), and the objective at r1 became `goal:v1` with three joints — horizon, success-criteria, commercial-intent — while `objective#r2` became a retracted tombstone. The owner reviewed the full regenerated `OBJECTIVE.md` diff and approved before the commit.

## What we built

- `lib/judgment-writer.js` (S1) — the migration machinery: preimage capture, merged-state build, artifact-equality, attestation resolution, `buildGoalMigrationIntent`/`applyGoalMigrationIntent`, registered in `INTENT_APPLIERS`, plus a non-MCP-reachable `internal.appliers` injection seam (C13) so replay determinism is testable without exposing it to callers.
- `lib/judgment-writer.js` (S2) — `migrationCompletion()`, the r4 completion predicate returning a discriminated status (none / attribution_conflict / pending / revived / incomplete / complete), and `assertGoalMigrationFence()`, ONE central pre-executor fence: every non-migrate goal op is migration-locked until the cutover lifts it, guarded in a single place rather than copied into the four executors. Terminal `JUDGMENT_OBJECTIVE_RETIRED` in `judgmentPositionCreate`.
- `server/compose-mcp.js` (S3) — three single-line edits: the `judgment_goal_write` op enum gains `migrate`, the description reframes the fence as wholesale, and `migrate` is documented as the one-shot, fail-closed, payload-free cutover. No new arguments.
- The live store (S4) — `goal/v1.json` (channel inferred, elicitation verbatim, `via: migration`), `goal/state.json` (gj1-gj3), `positions/objective/r2.json` (retracted, claims emptied, conviction carried from r1), and a 3,645-byte migration note anchored at `position:objective` carrying the entire legacy `OBJECTIVE.md` verbatim.
- Progress ledgers: `docs/features/COMP-JUDGMENT-GOAL-MIGRATE/s{1,2,3,4}-progress.md`. Commits `857a721` (S1) → `de2719d` (S2) → `a31eb30` (S3) → `acfe226` (S4).

## What we learned

1. **A live MCP server goes stale the moment you ship a tool change.** This session's compose server started at 08:52; the S3 enum edit landed at 10:08. Its advertised `judgment_goal_write` enum was still the pre-S3 four ops, so running the cutover through it would have proven nothing about S3 reachability. We spawned a fresh `server/compose-mcp.js` over stdio with `COMPOSE_TARGET` pinned — same binary, current code — and asserted `tools/list` advertised `migrate` BEFORE the write. Any session predating `a31eb30` needs an MCP reconnect. This is the single most reusable operational lesson.
2. **Migration is an intent, not a mutation.** Routing the cutover through intent-replay is what makes a one-way door survivable: a crash replays to the same state. The applier never re-stamps — it uses the persisted payload verbatim with one shared captured timestamp — so replay is byte-identical.
3. **Nothing was lost, only relocated.** The projection narrows from the imported essay to the structured goal surface, and the prose the projection no longer renders lives verbatim in the ledger note — moved from a generated surface into canon, where it belongs.
4. **Review-budget discipline held.** S1 stopped at Codex R2 (remaining edges pathological — `__proto__` canonicalization, 2^53 id float imprecision — both fixed with regression tests); S2 was CLEAN at R1. CLEAN is the exit, not a target.
5. **The fence is wholesale and central.** One pre-executor guard locks every non-migrate op until cutover, mutation-checked (disabling it fails exactly the tests that should fail). Correctness lives in one place, not four.

## Open threads

- [ ] **Tracker flip to COMPLETE is BLOCKED by the guard.** The feature.json row is still PLANNED. `set_feature_status(COMPLETE)` is refused by capabilities.guard (COMP-MCP-ENFORCE): COMPLETE is lifecycle-owned, and this feature was built out-of-band (direct S1-S4 commits, no lifecycle item), so there is no ship-phase lifecycle item to drive `complete_feature` through, and no `STRATUM_GUARD_OVERRIDE_TOKEN` is set (out-of-band, not agent-mintable). Resolve by setting the override token, or by giving out-of-band-built features a sanctioned completion path. Forcing is doubly wrong (same token gate + it would clobber the parked ROADMAP row).
- [ ] `self-report-reliable` is named in the migration note as unmigrated — no canonical joint record exists for it yet.
- [ ] The COMP-JUDGMENT-STORES PACKAGES gate remains pending (tracked on the parent).
- [ ] `docs/judgment/SITUATION.md` was included in the cutover commit (a first-time projection of an empty situation store), owner-approved, to keep the store at a committed fixed point.

---

*We didn't delete the old objective — we retired it, kept every word, and let the goal store inherit the mind.*
