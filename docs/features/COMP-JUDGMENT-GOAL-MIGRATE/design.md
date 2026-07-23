# COMP-JUDGMENT-GOAL-MIGRATE — objective → goal store migration

**Status:** GATE CLOSED r4 (2026-07-23, on the 3-round budget) — carved out of
COMP-JUDGMENT-STORES at its gate round 5 (2026-07-23). Seeded from the parent's
r6 state; r2 folded gate round 1 (3 HIGH + 2 MEDIUM — overruled the seeded host
choice and crash-guarantee wording); r3 folded round 2 (2 HIGH + 3 MEDIUM —
pre-migration lock, terminal retirement, replay error split, canonical joint
enumeration, projection narrowing); r4 folds round 3 (3 HIGH + 1 MEDIUM — all
self-consistency defects in r3's own fixes: migrate-op fence exemption,
sidecar absorbed by preimage instead of an unimplementable repair, tombstone
exemption restoring the revival repair, replay strengthened to payload
equality). Round 3's findings introduced no new design ground, so the gate
closes without a fourth review per the review-budget rule; the blueprint gets
its own review. Codex sol/xhigh all three rounds.
**Date:** 2026-07-23

## Related Documents

- Roadmap row: `ROADMAP.md` → Judgment Layer → COMP-JUDGMENT-GOAL-MIGRATE
- Parent: [`COMP-JUDGMENT-STORES`](../COMP-JUDGMENT-STORES/design.md) — ships the goal
  store and the `JUDGMENT_MIGRATION_REQUIRED` guard this migration unlocks; full gate
  history there
- Sibling: [`COMP-JUDGMENT-PACKAGES`](../COMP-JUDGMENT-PACKAGES/design.md)
- Domain spec: `docs/design/2026-07-20-judgment-layer-process-manual.md` — Goal box
  (seq 109)
- Code substrate: `lib/judgment-writer.js` (runOp, intents, reconciler,
  `RESERVED_INTENT_KINDS`), `lib/judgment/store/index.js` (`goalCutoverComplete`,
  intent-aware effective snapshot), `lib/judgment-gen.js` (`renderObjective`),
  `docs/judgment/records/positions/objective/r1.json`

## Problem

The live objective is a position chain whose one claim is explicitly a back-inferred,
owner-unconfirmed draft. Once the goal store exists (parent feature), the objective
must move into it — but the position schema has no cross-kind supersession, and a
naive multi-step migration can crash into an unrecoverable half-state. Until this
lands, `judgment_goal_write op=cut` rejects with `JUDGMENT_MIGRATION_REQUIRED`
(guard ships with the parent), so the goal store is present but deliberately locked.

## Design

- **Host: `judgment_goal_write op=migrate`** — a writer op riding the shipped `runOp`
  intent machinery, NOT a CLI flag. *(Overrules the seeded draft's
  "`--migrate-goal` on `bin/judgment-import.js`, not MCP-reachable" — gate r1
  finding 5: the parent classifies the importer as a **retired path** appearing in
  no registry row, the canon registry accepts only outer-tool identities, and the
  parent's direct-entry closure requires any maintenance entry point to be a
  registered typed surface. The writer already reserves the `goal_migration` intent
  kind (`RESERVED_INTENT_KINDS`) for exactly this op; this feature ships its
  `INTENT_APPLIERS` entry.)* MCP-reachability is safe because the op is fail-closed
  outside its one legality window (below) and can succeed at most once ever.
- **One intent-backed compound operation:** `op=migrate` persists a `goal_migration`
  **intent** (full payload: goal v1, tombstone revision, anchored note, goal-state
  joint links, and the `state.json` preimage — see legality window) BEFORE
  touching the store, applies all effects under the one advisory-lock acquisition
  `runOp` already holds, appends the deduped attestation event
  `{intent_id, tool, op}` (parent protocol), then clears the intent. `UndoLog`
  handles exceptions; **process death is handled by replay** — the reconciler
  (head of every write and read) re-applies remaining effects idempotently.
  Replay skip rules verify **full payload equality, not mere attribution** (gate
  r1 finding 2, strengthened r3 finding 4 to the shipped applier precedent —
  `applyPayload` compares the complete existing record and throws on any
  mismatch): an occupied slot (goal v1, tombstone, `state.json`, note) is
  skipped only when the existing artifact deterministically equals what the
  persisted intent payload would produce; any mismatch — including a
  same-`intent_id` artifact with a differing body — throws
  `JUDGMENT_MIGRATION_CONFLICT`. Every artifact is reconstructed from the
  persisted payload, so equality is well-defined on every path.
- **Pre-migration goal-store lock — fence extension** (gate r2 finding 1, exempt
  narrowed r3 finding 1): the parent fenced only `op=cut`; the shipped
  `joint_link`/`load_link` executors can create `goal/state.json` with no goal
  version, which would collide with the migration's own state write. This feature
  extends the `JUDGMENT_MIGRATION_REQUIRED` fence to **every non-`migrate`
  `judgment_goal_write` op** while the legacy chain is live and no
  migration-attested v1 exists — `op=migrate` itself is necessarily exempt (it is
  hosted on this tool and legal precisely inside the fenced state; without the
  exemption no migration intent could ever be created). The goal store is
  otherwise locked wholesale until migration, which is what the parent's problem
  statement always said ("present but deliberately locked").
- **Legality window (fail-closed both ways):** `op=migrate` executes only while
  the legacy `objective` position chain is live (un-tombstoned) AND the goal
  chain is empty. A pre-fence `goal/state.json` sidecar is **absorbed by
  preimage, not treated as a conflict** (gate r3 finding 2 — the fence blocks
  link removal, link removals never delete the file, and the store exposes no
  delete op, so "repair then rerun" was unimplementable): `op=migrate` captures
  the observed sidecar (or its absence) as a **preimage in the intent payload**;
  at apply time the current sidecar must equal the preimage byte-for-byte (else
  `JUDGMENT_MIGRATION_CONFLICT`), and the written state is the preimage's active
  entries plus the migration's enumerated joint links, deduped by joint id — a
  deterministic function of the payload, so replay stays exact. Outside the
  window:
  - goal chain non-empty with a **migration-attested** v1 (`provenance.via:
    "migration"` + durable attestation resolving its `intent_id`) AND the
    effective objective still retired → recorded no-op (`already migrated`).
    Reruns can never produce goal v2, a second tombstone, or a duplicate note.
  - every other state → reject `JUDGMENT_MIGRATION_CONFLICT`, write nothing. This
    covers: legacy chain tombstoned by an ordinary position op with a goal v1 cut
    through the normal writer (gate r1 finding 2); and a post-migration revived
    objective (gate r2 finding 2 — repair: re-tombstone via the fence's tombstone
    exception below, then rerun). "Cutover happened by other means" is surfaced
    to the owner, never silently blessed as a migration.
- **Retirement is terminal — tombstones exempt** (gate r2 finding 2, repair path
  fixed r3 finding 3): the shipped `judgment_position_create` appends new live
  revisions to a retracted chain without checking — post-cutover, a revived
  `objective` position would be silently hidden by the renderer
  (`goalCutoverComplete` skips the slug) while reruns report already-migrated.
  This feature adds a post-cutover fence: a new **non-tombstone** revision on the
  `objective` slug rejects with typed `JUDGMENT_OBJECTIVE_RETIRED` pointing at
  `judgment_goal_write`; a `retracted: true` tombstone revision stays legal —
  it is itself a new revision through `judgment_position_create`, and it is the
  prescribed repair for a revived objective (r3 finding 3: banning it would have
  made that repair impossible). The completion predicate above additionally
  requires the effective objective to remain retired, so a store that predates
  the fence fails to `JUDGMENT_MIGRATION_CONFLICT` with the repair named rather
  than no-opping.
- **Cutover marker:** goal chain non-empty AND no pending `goal_migration` intent —
  the shipped `goalCutoverComplete(store)` helper, evaluated INSIDE the renderer
  (`regenerateProjections` is a public entry point callable without
  reconciliation), driving all three consumers: `renderObjective` source selection,
  `positions/objective.md` removal, and index visibility. (The marker is
  deliberately broader than "migration completed" — it answers "which source
  renders", not "did the migration run"; the migration's own completion check is
  the attested predicate above.)
- **Crash guarantee — records atomic, projections eventually repaired** (gate r1
  finding 1, replacing the seeded "never a mixture" claim): the RECORD store never
  shows a mixture — the effective snapshot excludes every record whose
  `provenance.intent_id` matches a pending intent, so readers see fully
  pre-migration until the intent clears, fully post-migration after. PROJECTIONS
  follow the parent's shipped publish-then-regenerate semantics: regeneration
  writes files individually, so a kill inside the clear→regenerate window can
  transiently leave mixed projection files (e.g. goal-rendered `OBJECTIVE.md`
  beside a not-yet-removed `positions/objective.md`, or a stale index); the next
  regeneration — triggered by any judgment write or `get_judgment_state` — repairs
  the full set. This is the same window every shipped write has; it is tested, not
  promised away.
- **Pending-intent semantics — replay wins, conflicts throw, fence catches
  non-throwing survivors** (gate r1 finding 3 + r2 finding 3): shipped `runOp`
  replays pending intents BEFORE executing the presented op. A goal cut arriving
  while a `goal_migration` intent is pending therefore first COMPLETES the
  migration via replay, then proceeds as an ordinary post-migration cut (normally
  producing goal v2). Error split (r2 finding 3 — a thrown replay error
  propagates from `runOp` before the goal executor's fence is ever reached):
  a replay that detects conflicting artifacts throws
  `JUDGMENT_MIGRATION_CONFLICT` immediately — the presented op never runs.
  `JUDGMENT_INTENT_PENDING` is reserved for the applier's NON-THROWING blocked
  outcome (intent left pending without error); only then does the goal executor's
  shipped fence fire. The shipped fence order (`JUDGMENT_INTENT_PENDING` before
  `JUDGMENT_MIGRATION_REQUIRED`, parent invariant 7) is unchanged.
- **Content mapping:** `objective` position r1 → `goal/v1.json`; claim c1 becomes a
  clause with **`channel: "inferred"`** — the live claim is explicitly a
  "back-inferred draft — NOT owner-confirmed"; `ASSERT → said` would launder a known
  inference into owner speech and dodge the inferred-commit guard. Elicitation
  citation carries over; `via: "migration"` + no `ratification` → derived draft
  state; **`provocation: null`** — legal only under `via: migration|import`; the
  projection renders "provocation: unknown (migrated)", never a fabricated owner
  quote.
- **Joint and context carry-over** (gate r1 finding 4, narrowed r2 finding 4):
  the migration payload includes a **goal-state joint link for each of the
  objective's joint records** — enumerated **explicitly in the payload as
  `horizon`, `success-criteria`, `commercial-intent`** (the three joint records
  that exist under `docs/judgment/records/joints/`), each validated at execution
  against the canonical joint records (`JUDGMENT_REF` on failure). Enumeration is
  NOT parsed from projection markers — markdown projections are disposable output
  and carry two different reference grammars (r2 finding 4). This is a one-time
  migration of one known store; a fixed validated list is canonical and honest.
  `self-report-reliable` has **no joint record** — it survives in the ledger
  note's text only, named there as unmigrated. The legacy projection's **detailed
  health warning and observed trade-off rankings carry verbatim into the anchored
  ledger note**.
- **Projection narrowing, acknowledged** (r2 finding 5): the shipped goal
  renderer's draft warning states only that the goal is not owner-ratified; the
  legacy warning's operative instruction — "replace via P1b" — survives **only in
  the anchored ledger note** (and git history of the tombstoned projection). This
  narrowing is accepted; extending the renderer is explicitly out of scope.
- **Retirement:** the position chain gets a tombstone revision (`retracted: true`)
  plus the **anchored ledger note** pointing at the goal store (`supersedes` only
  accepts position refs; no cross-kind pointer exists).
- **Replay attribution:** all migration artifacts (goal v1, `state.json` links,
  tombstone, note) stamp `provenance.intent_id`; the attestation event makes the
  linkage durable past intent clearing (parent protocol).
- **Cutover commit is human-gated:** owner approves the regenerated `OBJECTIVE.md`
  diff (same protocol as the W3 cutover).

## Canon-manifest rows (merge into the parent's manifest)

Full repo-relative paths per the parent's registry base; authorizing outer tools
only, never internal functions (gate r1 finding 5). Replay surfaces are the
parent's enumerated reconciler list: every judgment write tool
(`judgment_person_write`, `judgment_situation_write`, `judgment_goal_write`,
`judgment_position_create`, `judgment_position_amend`, `judgment_joint_add`,
`judgment_transition`, `judgment_ledger_append`) plus `get_judgment_state`
(reconciler-on-read).

| Path (repo-relative) | Operations | Authorizing outer tools |
|---|---|---|
| `docs/judgment/records/goal/**` | migrate (once: v1 + `state.json` joint links) | `judgment_goal_write` (`op=migrate`); replay via the reconciler list above |
| `docs/judgment/records/positions/objective/**` | migration tombstone (once) | `judgment_goal_write` (`op=migrate`); replay via the reconciler list above |
| `docs/judgment/records/ledger.jsonl` | migration note + attestation event | `judgment_goal_write` (`op=migrate`); replay via the reconciler list above |
| `docs/judgment/records/intents/**` | `goal_migration` persist/clear | `judgment_goal_write` (`op=migrate`); reconciler list above |

## Acceptance criteria

- [ ] `judgment_goal_write op=migrate` inside the legality window produces `goal/v1.json` (inferred channel, null provocation, draft state) + `state.json` joint links for the three enumerated joint records (each validated against `records/joints/`); position tombstoned + anchored note carrying the health warning, trade-off rankings, and the unmigrated `self-report-reliable` naming; `positions/objective.md` gone; `OBJECTIVE.md` renders from the goal chain with populated joints
- [ ] Pre-migration, every non-`migrate` `judgment_goal_write` op (`cut`, `joint_link`, `load_link`, …) rejects `JUDGMENT_MIGRATION_REQUIRED`, while `op=migrate` passes the fence — the extension closes the sidecar-creation path without deadlocking the migration (test)
- [ ] A pre-existing `goal/state.json` is absorbed: preimage captured in the intent, active entries preserved + migration links merged (deduped by joint id); a preimage mismatch at apply time rejects `JUDGMENT_MIGRATION_CONFLICT` (test)
- [ ] Rerun against a migration-attested store is a recorded no-op; rerun against any other state — ordinary tombstone + ordinary cut, revived objective — rejects `JUDGMENT_MIGRATION_CONFLICT` and writes nothing (test)
- [ ] Post-cutover, a new non-tombstone revision on the `objective` slug rejects `JUDGMENT_OBJECTIVE_RETIRED`; a `retracted: true` tombstone revision succeeds (the revived-objective repair path) (test)
- [ ] Kill-mid-migration completes via reconciler replay; replay against an occupied slot whose artifact does not payload-equal the intent — including same-`intent_id`, differing body — throws `JUDGMENT_MIGRATION_CONFLICT` from the replay phase; the presented op never executes (test)
- [ ] A goal cut presented while a replayable migration intent is pending completes the migration via replay and proceeds to produce goal v2; `JUDGMENT_INTENT_PENDING` fires only on the applier's non-throwing blocked outcome (test)
- [ ] A partially-applied migration (pre-clear) renders the fully pre-migration projection (intent-aware snapshot test); a kill in the clear→regenerate window is repaired to fully post-migration by the next regeneration (test)
- [ ] After migration, `judgment_goal_write op=cut` with ratification succeeds (the `JUDGMENT_MIGRATION_REQUIRED` guard unlocks)
- [ ] Owner approves the regenerated `OBJECTIVE.md` diff before the cutover commit

## Open questions

None standing after r4. Depends on the parent's goal store, `migration` provenance
class, `intent_id` + attestation protocol, reserved `goal_migration` intent kind,
and cutover helper — all shipped @1dd2432.
