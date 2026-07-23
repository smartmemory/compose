# COMP-JUDGMENT-GOAL-MIGRATE — objective → goal store migration

**Status:** DRAFT r1 (seeded) — carved out of COMP-JUDGMENT-STORES at its gate round 5
(2026-07-23). Migration findings recurred in parent gate rounds 3–5; the owner ruled
the noisy corner splits. Material below is the parent's r6 state (all known findings
folded) but this doc has NOT passed a standalone gate.
**Date:** 2026-07-23

## Related Documents

- Roadmap row: `ROADMAP.md` → Judgment Layer → COMP-JUDGMENT-GOAL-MIGRATE
- Parent: [`COMP-JUDGMENT-STORES`](../COMP-JUDGMENT-STORES/design.md) — ships the goal
  store and the `JUDGMENT_MIGRATION_REQUIRED` guard this migration unlocks; full gate
  history there
- Sibling: [`COMP-JUDGMENT-PACKAGES`](../COMP-JUDGMENT-PACKAGES/design.md)
- Domain spec: `docs/design/2026-07-20-judgment-layer-process-manual.md` — Goal box
  (seq 109)
- Code substrate: `bin/judgment-import.js`, `lib/judgment-writer.js` (intents,
  reconciler), `lib/judgment-gen.js` (`renderObjective`),
  `docs/judgment/records/positions/objective/r1.json`

## Problem

The live objective is a position chain whose one claim is explicitly a back-inferred,
owner-unconfirmed draft. Once the goal store exists (parent feature), the objective
must move into it — but `bin/judgment-import.js` refuses to run when records exist
(this repo is post-cutover), the position schema has no cross-kind supersession, and
a naive multi-step migration can crash into an unrecoverable half-state. Until this
lands, `judgment_goal_write op=cut` rejects with `JUDGMENT_MIGRATION_REQUIRED`
(guard ships with the parent), so the goal store is present but deliberately locked.

## Design

- **One intent-backed compound operation** (`--migrate-goal`, internal code path,
  not MCP-reachable): persists a **migration intent** (full payload: goal v1,
  tombstone revision, anchored note) BEFORE touching the store, applies all effects
  under one advisory-lock acquisition, then clears the intent. `UndoLog` handles
  exceptions; **process death is handled by replay** — the reconciler (head of every
  write and read) re-applies remaining effects idempotently (goal v1 exists → skip;
  tombstone exists → skip; note deduped on title, the `dropIntentDurably` precedent).
- **Cutover marker:** goal chain non-empty **AND no pending migration intent** —
  evaluated by the shared `goalCutoverComplete(store)` helper INSIDE the renderer
  (`regenerateProjections` is a public entry point callable without reconciliation),
  driving all three consumers: `renderObjective` source selection,
  `positions/objective.md` removal, and index visibility.
- **Pending-migration artifacts are projection-isolated:** a crashed prefix may
  already have written the tombstone (legacy would render "retracted") or the note.
  The generator's snapshot EXCLUDES every record whose `provenance.intent_id`
  matches a pending intent (intent-aware effective snapshot — general, not
  migration-specific). Ordering: apply all effects → clear intent → regenerate; a
  crash leaves either a fully pre-migration or fully post-migration projection,
  never a mixture.
- **First-cut bypass is closed in the parent:** while a live (un-tombstoned) legacy
  `objective` chain exists and the goal chain is empty, ordinary cuts reject with
  `JUDGMENT_MIGRATION_REQUIRED` — a pre-migration ratified cut would otherwise
  satisfy the cutover predicate and strand the legacy position unretired.
- **Idempotence guard:** completed migration (chain non-empty, no intent) → recorded
  no-op (exit 0, "already migrated"). Reruns can never produce goal v2, a second
  tombstone, or a duplicate note.
- **Content mapping:** `objective` position r1 → `goal/v1.json`; claim c1 becomes a
  clause with **`channel: "inferred"`** — the live claim is explicitly a
  "back-inferred draft — NOT owner-confirmed"; `ASSERT → said` would launder a known
  inference into owner speech and dodge the inferred-commit guard. Elicitation
  citation carries over; `via: "migration"` + no `ratification` → derived draft
  state; the health warning survives in the projection. **`provocation: null`** —
  legal only under `via: migration|import`; the projection renders
  "provocation: unknown (migrated)", never a fabricated owner quote.
- **Retirement:** the position chain gets a tombstone revision (`retracted: true`)
  plus an **anchored ledger note** pointing at the goal store (`supersedes` only
  accepts position refs; no cross-kind pointer exists).
- **Replay attribution:** all three migration artifacts (goal v1, tombstone, note)
  stamp `provenance.intent_id` of the migration intent.
- **Cutover commit is human-gated:** owner approves the regenerated `OBJECTIVE.md`
  diff (same protocol as the W3 cutover).

## Canon-manifest rows (merge into the parent's manifest)

| Path | Legitimate mutations | Physical mutation surfaces |
|---|---|---|
| `records/goal/**` | + migration (once) | `--migrate-goal`; reconciler replay of a pending migration intent (any later writer op or read) |
| `records/positions/**` | + migration tombstone (once) | `--migrate-goal`; migration-intent replay |
| `ledger.jsonl` | + migration note | `--migrate-goal`; migration-intent replay |
| `records/intents/**` | + persist/clear (migration) | `--migrate-goal`, reconciler |

## Acceptance criteria

- [ ] `--migrate-goal` produces `goal/v1.json` (inferred channel, null provocation, draft state); position tombstoned + anchored note; `positions/objective.md` gone; `OBJECTIVE.md` renders from the goal chain with the health warning
- [ ] Rerun is a recorded no-op; kill-mid-migration completes via reconciler replay (test)
- [ ] A partially-applied migration renders the fully pre-migration projection (intent-aware snapshot test)
- [ ] After migration, `judgment_goal_write op=cut` with ratification succeeds (the `JUDGMENT_MIGRATION_REQUIRED` guard unlocks)
- [ ] Owner approves the regenerated `OBJECTIVE.md` diff before the cutover commit

## Open questions

Needs its own (small) Codex design gate before build. Depends on the parent's goal
store, `migration` provenance class, `intent_id` field, and cutover helper.
