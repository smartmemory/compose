# COMP-JUDGMENT-GOAL-MIGRATE — Implementation Blueprint

**Status:** BLUEPRINT — Phase 4 draft, grounded against the 2026-07-23 checkout
**Date:** 2026-07-23
**Design authority:** [design.md](design.md), GATE CLOSED r4 (binding)
**Scope:** add `judgment_goal_write op=migrate`; publish one intent-backed objective-to-goal cutover; extend the pre-migration goal fence; make objective retirement terminal; preserve pre-cutover effective reads and repair projections after publication; expose `migrate` through the already-registered MCP tool; perform the live cutover only after owner approval. No CLI/importer surface, renderer redesign, package-transition work, canon-guard implementation, or unrelated judgment cleanup.

The implementation must use the shipped `runOp` lock/replay/publication path. The r4 design is authoritative where a current helper is narrower: migration conflicts are typed `JUDGMENT_MIGRATION_CONFLICT`, every occupied migration artifact is skipped only on full equality, and `JUDGMENT_INTENT_PENDING` is only the post-replay fence for a non-throwing blocked applier outcome.

## File Plan

| File | Action | Marker | Slice | Purpose |
|---|---|---|---:|---|
| `lib/judgment/store/index.js` | modify | (existing) | S1 | Restore a pending migration's captured `goal/state.json` preimage through `effectiveStore`; keep all other intent-attributed artifacts hidden. |
| `lib/judgment-writer.js` | modify | (existing) | S1, S2 | Add migration payload construction, `goal_migration` applier/equality checks, attested completion, wholesale goal fencing, replay-outcome injection seam, and terminal objective retirement. |
| `test/judgment-store.test.js` | modify | (existing) | S1 | Pin effective sidecar preimage substitution and publication visibility. |
| `test/judgment-writer.test.js` | modify | (existing) | S1, S2 | Cover exact migrated content, state absorption, equality-only replay, crash windows, conflict/no-op states, fences, retirement, and post-cutover v2. |
| `server/compose-mcp.js` | modify | (existing) | S3 | Add `migrate` to the existing `judgment_goal_write` advisory schema, describe the one-shot operation, and make the read tool's reconciler copy intent-generic. |
| `test/judgment-writer-mcp.test.js` | modify | (existing) | S3 | Pin the five-op enum and prove migration/error propagation through the existing tool registration. |
| `test/judgment-gen.test.js` | modify | (existing) | S3 | Replace obsolete standalone-tool fixtures and cover pending/preimage and clear-to-regenerate repair against the real migration payload. |
| `docs/judgment/records/goal/v1.json` | create | (new) | S4 | Owner-gated live migrated goal version. |
| `docs/judgment/records/goal/state.json` | create | (new) | S4 | Owner-gated live links to `horizon`, `success-criteria`, and `commercial-intent`. |
| `docs/judgment/records/positions/objective/r2.json` | create | (new) | S4 | Owner-gated live objective tombstone. |
| `docs/judgment/records/ledger.jsonl` | modify | (existing) | S4 | Append the anchored migration note and durable `{intent_id, tool, op}` attestation. |
| `docs/judgment/OBJECTIVE.md` | modify | (existing) | S4 | Regenerate from goal v1 after publication. |
| `docs/judgment/LEDGER.md` | modify | (existing) | S4 | Regenerate the migration note and attestation audit surface. |
| `docs/judgment/index.md` | modify | (existing) | S4 | Remove the legacy objective position row after cutover. |
| `docs/judgment/positions/objective.md` | modify | (existing) | S4 | Remove the retired legacy projection during generated-output pruning after cutover. |

Verified unchanged substrate: `lib/judgment/store/records.js`, `lib/judgment-gen.js`, `contracts/judgment-record.schema.json`, `server/compose-mcp-tools.js`, and `test/judgment-schema.test.js`. A transient `docs/judgment/records/intents/<id>.json` is created and cleared by S4 but must not appear in the cutover commit.

## Corrections Table

All corrections are binding implementation instructions, not redesigns.

| # | Design assumption | Code reality | Binding correction |
|---|---|---|---|
| C1 | The migration can register on the shipped typed intent dispatcher. | `goal_migration` is reserved, but `INTENT_APPLIERS` contains only `transition`; reserved kinds currently return a non-throwing blocked result. (`lib/judgment-writer.js:287-287`, `lib/judgment-writer.js:410-412`, `lib/judgment-writer.js:457-470`) | **Corrected:** register `goal_migration: applyGoalMigrationIntent`. Keep `package_transition` reserved/blocked. Do not route migration through transition-shaped `applyPayload`. |
| C2 | The shipped payload applier establishes full-artifact equality precedent. | `applyPayload` overwrites a joint, dedupes ledger events by serialized equality, and compares complete prediction records; it has no goal, position, state, or anchored-note slots. (`lib/judgment-writer.js:240-263`) | **Corrected:** the migration applier gets artifact-specific preflight and apply logic. Goal v1, the exact tombstone revision, state output, and migration note each skip only on full equality; any occupied mismatch throws `JUDGMENT_MIGRATION_CONFLICT` before the presented op executes. |
| C3 | Effective reads can remain fully pre-migration by hiding intent-attributed artifacts. | `effectiveStore` hides a top-level attributed record by returning `null`; `readGoalState` has no preimage substitution. Overwriting a pre-existing state file would therefore expose absence, not the pre-migration state. (`lib/judgment/store/index.js:63-71`, `lib/judgment/store/index.js:159-180`) | **Corrected:** only for a pending `goal_migration`, if raw `state.json` is attributed to that intent, return the payload's captured parsed preimage (or `null` when it was absent). This is required by r4's records-atomic guarantee; after clear, return the merged state normally. |
| C4 | Parsed store reads are sufficient for the sidecar preimage guard. | `readJson` collapses missing, unreadable, and malformed JSON to `null`; `readGoalState` exposes no bytes, although `_goalStatePath` is available. (`lib/judgment/store/records.js:43-48`, `lib/judgment/store/records.js:223-235`) | **Corrected:** capture `{bytes, record}` directly from `_goalStatePath()` under the writer lock, or `null` for absence. At apply, compare raw bytes exactly. Validate the parsed preimage before intent persistence; do not change `RecordsStore`. |
| C5 | The parent already fenced the whole goal store before migration. | `validateGoalDispatch` has four ops, and only `GOAL_EXECUTORS.cut` checks `JUDGMENT_MIGRATION_REQUIRED`; `joint_link` can create `state.json` with no goal version. (`lib/judgment-writer.js:1972-2000`, `lib/judgment-writer.js:2059-2069`, `lib/judgment-writer.js:2149-2194`) | **Corrected:** add `migrate` to validation and centralize a pre-executor fence for every non-`migrate` op. Preserve `JUDGMENT_INTENT_PENDING` precedence after replay. |
| C6 | Objective retirement is already enforced by the position writer. | `judgmentPositionCreate` validates before lock, then appends any schema-valid objective revision; it does not inspect goal cutover. (`lib/judgment-writer.js:2262-2296`) | **Corrected:** inside `execute`, use an effective store and reject a post-cutover non-tombstone `objective` revision with `JUDGMENT_OBJECTIVE_RETIRED`; allow `retracted:true` as the repair path. |
| C7 | The migration requires new record schema shapes. | Provenance already allows `via:"migration"` and `intent_id`; goal versions allow null provocation/no ratification for migration; goal state, tombstones, note refs, attestations, and the open intent payload are already representable. (`contracts/judgment-record.schema.json:76-87`, `contracts/judgment-record.schema.json:393-446`, `contracts/judgment-record.schema.json:491-520`, `contracts/judgment-record.schema.json:696-733`, `contracts/judgment-record.schema.json:789-818`) | **Confirmed:** make no schema edit. Validate every constructed artifact with the existing definitions and keep the migration payload internal inside `pending_intent.payload`. |
| C8 | Projection source selection and pruning still need implementation. | The generator already reads through `effectiveStore`, selects goal rendering with `goalCutoverComplete`, emits migrated draft warnings/null-provocation fallback, suppresses the objective position, and prunes stale Markdown. (`lib/judgment-gen.js:58-75`, `lib/judgment-gen.js:500-568`, `lib/judgment-gen.js:571-630`, `lib/judgment-gen.js:658-668`) | **Confirmed:** no generator source edit. Extend tests with real migration artifacts and rely on the shipped clear-then-regenerate/read-repair behavior. |
| C9 | `judgment_goal_write` needs a new registration/shim. | The import, thin target-root shim, and dispatch case already exist; the advisory op enum omits `migrate`, and `get_judgment_state` still says it replays only transition intents. (`server/compose-mcp.js:71-79`, `server/compose-mcp.js:866-893`, `server/compose-mcp.js:988-996`, `server/compose-mcp-tools.js:848-850`) | **Corrected:** edit only the existing tool definitions and their tests: add `migrate`, describe the wholesale pre-cutover fence, and change the read copy to “pending judgment intents.” Tool/case counts stay 49/49 and judgment tool count stays nine. |
| C10 | Existing tests model the future migration identity accurately. | Crafted intents use the overruled `judgment_goal_migrate` tool name and skeletal payloads that will stop being blocked once the applier is registered. (`test/judgment-writer.test.js:2026-2032`, `test/judgment-gen.test.js:364-370`, `test/judgment-writer-mcp.test.js:99-103`) | **Corrected:** use `tool:"judgment_goal_write"`, `op:"migrate"`, and a complete payload. Replace blocked-by-absence fixtures with an explicit injected non-throwing blocked-applier test. |
| C11 | Attribution-only attestation matching is enough for every migration conflict. | `appendIntentAttestation` throws generic `JUDGMENT_CONFLICT` only when the same intent ID has different `{tool, op}`; otherwise it dedupes. (`lib/judgment-writer.js:414-440`) | **Corrected:** migration preflight/completion must check that any attestation resolving the migration intent is exactly `judgment_goal_write/migrate`; mismatch is `JUDGMENT_MIGRATION_CONFLICT`. The shared append helper remains unchanged for transition intents. |
| C12 | The projection markers can enumerate all objective joints. | The live projection names four joints, but only `horizon`, `success-criteria`, and `commercial-intent` have canonical joint records; `self-report-reliable` does not. (`docs/judgment/OBJECTIVE.md:59-66`, `docs/judgment/records/joints/horizon.json:1-3`, `docs/judgment/records/joints/success-criteria.json:1-3`, `docs/judgment/records/joints/commercial-intent.json:1-3`) | **Confirmed and pinned:** enumerate the three slugs in code/payload, validate each through `readJoint`, and name `self-report-reliable` as unmigrated in the note. Never parse Markdown markers for links. |
| C13 | The blocked-applier/error-phase split is directly testable through the frozen runtime table. | The table is frozen and every currently registered applier applies, refuses, or throws; registering migration removes its natural reserved-kind blocked path. (`lib/judgment-writer.js:410-412`, `lib/judgment-writer.js:457-487`, `lib/judgment-writer.js:532-550`) | **Corrected:** add a narrow internal applier-map dependency parameter defaulting to `INTENT_APPLIERS`, threaded through replay/runOp only for unit failure injection. It is not an MCP argument or exported mutation surface. Test blocked return versus thrown conflict without weakening the runtime table. |

## Boundary Map

The map names code symbols only. Runtime records/projections and canon-manifest rows are specified below, not modeled as symbols.

### S01: migration payload, applier, and effective preimage
Produces:
  lib/judgment-writer.js → buildGoalMigrationIntent, applyGoalMigrationIntent (function)
  lib/judgment-writer.js → INTENT_APPLIERS (const)
  lib/judgment-writer.js → publishIntentLocked, replayPendingIntents (function)
  lib/judgment/store/index.js → effectiveStore (function)

Consumes: nothing (extends shipped leaf boundaries)

### S02: completion predicates and writer fences
Produces:
  lib/judgment-writer.js → migrationCompletion, assertGoalMigrationFence (function)
  lib/judgment-writer.js → judgmentGoalWrite, judgmentPositionCreate (function)

Consumes:
  from S01: lib/judgment-writer.js → buildGoalMigrationIntent, INTENT_APPLIERS, publishIntentLocked
  from S01: lib/judgment/store/index.js → effectiveStore

### S03: MCP and projection closure
Produces:
  server/compose-mcp.js → TOOLS (const)

Consumes:
  from S02: lib/judgment-writer.js → judgmentGoalWrite, judgmentPositionCreate
  from S01: lib/judgment/store/index.js → effectiveStore

### S04: owner-gated live cutover
Produces: no code symbols (canonical runtime artifacts only)

Consumes:
  from S02: lib/judgment-writer.js → judgmentGoalWrite

## Cross-Slice Implementation Contracts

### Entry, payload, and authority

- `judgmentGoalWrite(cwd, {op:"migrate", idempotency_key?})` remains the only entry. `validateGoalDispatch` rejects every other migrate argument before idempotency with `JUDGMENT_INPUT`; callers cannot provide records, provenance, intent IDs, joint lists, or note content.
- `runOp` keeps its current order: validate, idempotency, acquire one lock, replay pending intents, execute, release, best-effort audit (`lib/judgment-writer.js:570-599`). The migrate executor performs legality/completion checks and captures every input under that held lock.
- Persist this complete intent before any canonical effect:

```json
{
  "id": "<writer id>",
  "kind": "goal_migration",
  "tool": "judgment_goal_write",
  "op": "migrate",
  "payload": {
    "source": {"objective_ref": "objective#r1", "objective": {}, "legacy_projection": "<exact bytes>"},
    "goal_version": {},
    "objective_tombstone": {},
    "goal_state_preimage": null,
    "goal_state": {},
    "note": {}
  },
  "created_at": "<one captured timestamp>"
}
```

- `goal_state_preimage` is `null` for absence or `{bytes, record}`. `goal_state`, goal v1, tombstone, and note are final artifacts, not recipes requiring live-source reads on replay. All writer-created records share the intent timestamp and `provenance:{actor:"agent", session, written_at, via:"migration", intent_id}`.
- The projection bytes are input only to the archival note. Goal meaning comes from the effective objective record; joints come only from the fixed canonical slug list. This does not make Markdown canonical.

### Exact content mapping

- Goal v1 has exactly one clause `c1`: source claim `c1.text`; `channel:"inferred"`; the source elicitation copied byte-for-value; `trace:[]`; migration provenance. It has `provocation:null`, no `ratification` property, and `diff_note:"Migrated from legacy objective objective#r1."`.
- The tombstone is the next exact objective revision, with `claims:[]`, `retracted:true`, source conviction, and migration provenance. It does not invent cross-kind `supersedes`.
- State output is the preimage's active `joints` and active `load_links`, preserving IDs/content/order but re-stamping every output link with migration provenance, followed by missing fixed joints in this order: `horizon`, `success-criteria`, `commercial-intent`. Dedupe by `link.joint`, not association ID. Allocate new `gj<N>` IDs above the high-water mark of all preimage joints, including removed entries, then drop removed preimage entries from the merged output. New links have `removed:null`; top-level state provenance is migration-attributed.
- Before intent persistence, every fixed slug must resolve through canonical `records/joints`; missing means `JUDGMENT_REF`. Validate the final goal, state, tombstone, and note with the shipped schema. Wrap malformed/ambiguous preimage IDs or invalid sidecar content as `JUDGMENT_MIGRATION_CONFLICT`, not generic allocator/schema collapse.
- The note is `kind:"note"`, title `Legacy objective migrated to goal:v1`, anchor `position:objective`, refs `["objective#r1","goal:v1"]`, and migration provenance. Its body begins with the goal pointer and `` `self-report-reliable` was not migrated because no canonical joint record exists.`` followed by `Legacy OBJECTIVE.md follows verbatim:` and the exact captured legacy projection bytes.
- The body therefore preserves, without paraphrase, the detailed health warning including “First run of P1b should replace it” and the complete five-row trade-off table (`docs/judgment/OBJECTIVE.md:23-57`), plus the explicit `self-report-reliable` row/context (`docs/judgment/OBJECTIVE.md:59-74`).

### Replay equality and error phase

Preflight every target before the first mutation:

| Artifact identity | Skip only when | Conflict message |
|---|---|---|
| `goal/v1.json` | complete parsed record equals `payload.goal_version` and no later goal version exists | `goal migration <id>: goal/v1.json differs from the persisted payload` |
| `positions/objective/r<N>.json` | complete parsed record equals `payload.objective_tombstone` and no later objective revision exists | `goal migration <id>: objective tombstone differs from the persisted payload` |
| `goal/state.json` | raw bytes equal deterministic `payload.goal_state` bytes; otherwise current raw bytes must equal `goal_state_preimage.bytes` (or both absent) before writing | `goal migration <id>: goal/state.json no longer matches the persisted preimage` |
| migration note | no event occupies its title/anchor/intent identity, or exactly one such event exists and the complete event equals `payload.note` | `goal migration <id>: anchored migration note differs from the persisted payload` |
| migration attestation | none, or exact same intent ID with `tool:"judgment_goal_write"` and `op:"migrate"` | `goal migration <id>: durable attestation attribution conflicts` |

- A mismatch throws from `applyGoalMigrationIntent` during replay. `publishIntentLocked` preserves the intent and `runOp` never reaches the presented executor.
- A non-throwing `{status:"blocked"}` leaves the intent and lets execution reach `goalWriteContext`, whose exact existing error remains `JUDGMENT_INTENT_PENDING: judgment_goal_write: goal_migration intent is still pending`.
- On apply/attestation failure, `UndoLog` restores this attempt and retains the intent. On clear failure, restore overwritten state to its preimage but leave new attributed artifacts/attestation hidden for equality-checked replay. After successful clear, never roll records back for projection failure; keep `JUDGMENT_PROJECTION_STALE` and repair on the next regeneration/read.

### Completion, fencing, and retirement

- `migrationCompletion(effective, raw)` is true only when goal v1 has `provenance.via:"migration"` and a non-empty `intent_id`, the ledger has the exact durable `judgment_goal_write/migrate` attestation for that ID, no matching intent remains, and `effective.derivePositionStatus("objective")==="retracted"`. Later ordinary goal versions do not invalidate the completed migration.
- `op=migrate` legality is effective objective live plus empty effective/raw goal chain. A sidecar does not close the window. Successful publication returns exactly `{op:"migrate", status:"migrated", version:1, ref:"goal:v1", intent_id}`. Completion true returns the same shape with `status:"already migrated"` and regenerates projections without adding a record.
- A non-empty chain without the exact completion predicate fails `JUDGMENT_MIGRATION_CONFLICT: judgment_goal_write migrate: goal chain is non-empty without a durable migration-attested v1`. An empty chain with a non-live objective fails `JUDGMENT_MIGRATION_CONFLICT: judgment_goal_write migrate: legacy objective is not live and no durable migration is complete`. The revived-objective and mismatched-attestation diagnostics below take precedence over these generic state messages. Every branch performs no canonical write.
- Before completion, every non-`migrate` goal op checks: pending migration first; then live legacy objective plus no migration-attested v1. The exact fence is `JUDGMENT_MIGRATION_REQUIRED: judgment_goal_write <op>: legacy objective is live; run judgment_goal_write op=migrate before any other goal operation`.
- After cutover, a new non-tombstone objective revision fails exactly `JUDGMENT_OBJECTIVE_RETIRED: judgment_position_create: objective is retired after goal cutover; use judgment_goal_write for goal changes (retracted:true remains legal)`.
- A revived objective makes migration completion false. Rerun fails exactly `JUDGMENT_MIGRATION_CONFLICT: judgment_goal_write migrate: migration-attested goal v1 exists but objective is live; append retracted:true through judgment_position_create, then retry`. The allowed tombstone repair restores the no-op predicate.

### Crash visibility

- Before clear, effective reads expose source objective r1, no goal v1, no migration tombstone/note/attestation, and the captured preimage sidecar. Direct `regenerateProjections` therefore emits the complete legacy projection set.
- After clear, effective reads expose all four migration artifacts. Per-file projection writes/pruning may be interrupted; this is accepted eventual repair. Any judgment write or `getJudgmentState` completes replay and regeneration, yielding goal-rendered `OBJECTIVE.md`, no `positions/objective.md`, and no objective index row.

## S1 — Migration intent, sidecar absorption, replay, and atomic reads

**Tests first — exact names and assertions:**

1. `migrate publishes the exact r4 payload once` — assert the complete four artifacts, inferred c1/null provocation/no ratification, the fixed joint order, note verbatim blocks, one exact attestation, cleared intent, and result `{status:"migrated"}`.
2. `migrate validates all three canonical joints before persisting intent` — for each slug assert exact code `JUDGMENT_REF` and exact message `judgment_goal_write migrate: required joint <slug> does not resolve`; assert records and intent directory unchanged.
3. `state preimage is absorbed and remains effective until publication` — seed active/removed/deduping links; assert active entry content/IDs preserved with migration attribution, removed entries excluded, fixed links deduped by `joint`, IDs allocated above all preimage IDs, and `effectiveStore` returns the exact original preimage during pending apply.
4. `state preimage byte drift conflicts before mutation` — alter only whitespace after intent persistence; assert exact code `JUDGMENT_MIGRATION_CONFLICT`, exact dynamic message `goal migration <id>: goal/state.json no longer matches the persisted preimage`, retained intent, and no new migration artifact.
5. `replay skips only full-equal migration artifacts` — crash after each artifact, replay, and assert one copy; for goal, tombstone, state, and note mutate one non-attribution field while keeping the same `intent_id`, then assert the exact table message and that a presented goal op never executes.
6. `migration records are atomic and projections repair after publication` — regenerate during a partially applied pending intent and assert the full pre-state; inject clear→regen failure, assert committed records plus `JUDGMENT_PROJECTION_STALE`, then assert `getJudgmentState` repairs the full post-state.

**Implementation:**

- Add pure helpers for preimage capture, stable merged-state construction, artifact equality, attestation resolution, and complete intent construction near the existing intent section.
- Register `applyGoalMigrationIntent` in `INTENT_APPLIERS`. Use both undo logs consistently: new goal/tombstone files are `created`, ledger/state are `capture`, and state is also an unpublished in-place preimage.
- Extend `effectiveStore.readGoalState` with the one migration-preimage substitution described in C3. Do not expose mutation methods or make other record families intent-aware recursively.
- Keep `RecordsStore` serialization and append primitives unchanged.

**S1 gate:**

```bash
node --test test/judgment-store.test.js test/judgment-writer.test.js
```

## S2 — Goal fence, fail-closed completion, and terminal retirement

**Tests first — exact names and assertions:**

1. `legacy-live fences every non-migrate goal op without fencing migrate` — table-drive `cut`, `correct`, create/remove `joint_link`, and create/remove `load_link`; assert exact `JUDGMENT_MIGRATION_REQUIRED` code/message per op and unchanged sidecar. Assert `migrate` reaches its executor.
2. `rerun no-ops only for attested migration plus retired objective` — assert the exact no-op result and byte-identical records both immediately after migration and after a legal v2; missing/wrong `via`, missing attestation, and ordinary tombstone plus ordinary goal assert the exact non-empty-chain conflict above; no live legacy/empty goal asserts the exact non-live-objective conflict; wrong attestation asserts the exact dynamic attribution conflict; every case writes zero bytes.
3. `revived objective conflicts, tombstone repair is legal` — assert the exact revived-objective message above; append `retracted:true`; rerun and assert `already migrated`.
4. `post-cutover objective revival is terminally retired` — assert exact `JUDGMENT_OBJECTIVE_RETIRED` code/message for a non-tombstone revision and byte-identical chain; assert a tombstone revision succeeds.
5. `replayable migration wins before a presented cut` — persist an unapplied complete intent, present a ratified cut, assert replay publishes v1 then the presented op creates v2.
6. `blocked migration maps to intent pending while thrown replay conflict escapes` — inject only the internal applier outcome; assert the exact existing pending message for blocked, then exact migration-conflict code/message for throw and a spy proving the executor was not called.
7. `post-migration ratified cut is unlocked` — migrate, then cut; assert v2 and absence of `JUDGMENT_MIGRATION_REQUIRED`.

**Implementation:**

- Add the zero-argument `migrate` validation branch and central pre-executor fence. Do not copy the fence into four ordinary executors.
- Build the initial intent only after checking the one legality window and the completion predicate. Persist, then call the shared `publishIntentLocked`; return the stable migration result.
- Add completion/repair diagnostics before generic non-empty-chain conflict handling so the owner receives the prescribed tombstone repair.
- Add the objective retirement check inside `judgmentPositionCreate.execute`, after replay and under the lock. Use `effectiveStore` plus `goalCutoverComplete`; do not move a store-backed check into synchronous validation.

**S2 gate:**

```bash
node --test test/judgment-writer.test.js test/judgment-guard-integration.test.js
```

## S3 — MCP reachability and projection recovery closure

**Tests first — exact names and assertions:**

1. `judgment_goal_write advertises migrate on the existing 49/49 registry` — assert exact enum `["cut","correct","joint_link","load_link","migrate"]`, 49 definitions/cases, the same nine judgment tool names, wholesale-fence copy, and `get_judgment_state` copy saying “pending judgment intents.”
2. `MCP migrate publishes the typed cutover` — seed the known legacy fixture, call the existing tool with `{op:"migrate"}`, assert result/artifacts; call again and assert `already migrated`.
3. `MCP migration errors preserve exact code and message` — assert the full `JUDGMENT_MIGRATION_REQUIRED`, `JUDGMENT_MIGRATION_CONFLICT`, and `JUDGMENT_OBJECTIVE_RETIRED` strings cross stdio unchanged.
4. `real pending migration payload keeps legacy projections until clear` — replace skeletal fixtures with the complete S1 payload and `tool:"judgment_goal_write"`; assert legacy objective/position/index before clear and goal objective/pruning after clear.
5. `next read repairs a killed clear-to-regenerate window` — obstruct one generated file, publish and assert `JUDGMENT_PROJECTION_STALE`, remove obstruction, call `get_judgment_state`, then assert roundtrip fixed point.

**Implementation:**

- In `server/compose-mcp.js`, add only `migrate` to the goal op enum, describe it as a no-payload, one-shot, fail-closed migration, and make `get_judgment_state`'s description intent-generic. Do not add provenance, intent, note, source, or joint arguments.
- Leave `toolJudgmentGoalWrite`, imports, dispatch, policy, `.mcp.json`, and package exports unchanged.
- Update generator fixtures and assertions only; `renderObjective`, pruning, and read-side regeneration already implement r4.

**S3 gate:**

```bash
node --test test/judgment-gen.test.js test/judgment-writer-mcp.test.js
```

## S4 — Owner-gated live cutover

**Tests/checks first:**

1. `live migration preflight matches the pinned source` — all S1-S3 gates and the full judgment suite pass; objective is live at r1; goal chain is empty; the three joint files resolve; no intent exists.
2. `live migration diff contains only the enumerated cutover artifacts` — after the MCP call, assert no pending intent, one attestation/note, fixed-point projections, and the exact S4 File Plan paths.
3. `owner approves regenerated OBJECTIVE.md before cutover commit` — present the full `OBJECTIVE.md` diff and note the accepted renderer narrowing; do not commit without explicit approval.

**Execution contract:**

- Invoke the registered MCP surface, not a direct module import or importer: `judgment_goal_write` with `{"op":"migrate","idempotency_key":"COMP-JUDGMENT-GOAL-MIGRATE-live-v1"}`.
- Verify the live c1 text/elicitation against `docs/judgment/records/positions/objective/r1.json:3-24`, all three joint records, and the note's verbatim warning/trade-off content before accepting the result.
- Run `get_judgment_state` once after publication, then fixed-point and full tests. The cutover diff must contain no intent file and no unrelated record/projection changes.
- Stop for owner review. The owner-gated cutover commit is a distinct, explicit action; never commit or push automatically.

## Canon-Manifest Handoff

Merge these rows into COMP-CANON-GUARD's parent manifest. Paths are repo-relative and authorizers are outer tools, never internal appliers.

| Path | Operations | Authorizing outer tools |
|---|---|---|
| `docs/judgment/records/goal/**` | migrate once (`v1.json` plus merged `state.json`) | `judgment_goal_write` (`op=migrate`); replay via every judgment write plus `get_judgment_state` |
| `docs/judgment/records/positions/objective/**` | migration tombstone once | `judgment_goal_write` (`op=migrate`); replay via every judgment write plus `get_judgment_state` |
| `docs/judgment/records/ledger.jsonl` | migration note and attestation | `judgment_goal_write` (`op=migrate`); replay via every judgment write plus `get_judgment_state` |
| `docs/judgment/records/intents/**` | persist/clear `goal_migration` | `judgment_goal_write` (`op=migrate`); every judgment write plus `get_judgment_state` reconciles |

The replay list is exactly `judgment_person_write`, `judgment_situation_write`, `judgment_goal_write`, `judgment_position_create`, `judgment_position_amend`, `judgment_joint_add`, `judgment_transition`, `judgment_ledger_append`, and `get_judgment_state`.

## Acceptance Coverage

| Design acceptance criterion | Named coverage |
|---|---|
| Exact v1/state/tombstone/note/projections | S1.1, S3.4, S4.2 |
| Wholesale non-migrate fence and migrate exemption | S2.1 |
| State preimage absorption, active merge/dedupe, byte drift | S1.3, S1.4 |
| Attested no-op; ordinary/revived conflict and no writes | S2.2, S2.3 |
| Terminal objective retirement with tombstone exception | S2.3, S2.4 |
| Kill/replay, full payload equality, replay-phase conflict | S1.5, S2.6 |
| Pending replay then v2; blocked-only intent pending | S2.5, S2.6 |
| Pre-clear pre-state; clear→regen eventual repair | S1.3, S1.6, S3.5 |
| Post-migration ratified cut succeeds | S2.7 |
| Owner approves `OBJECTIVE.md` before cutover commit | S4.3 |

## Implementation Exit Checks

- Run each slice gate before the combined suite; every designed rejection asserts both exact `code` and exact `message`.
- Audit replay at four kill points: after goal, tombstone, state, and note; audit publication failures at attestation, clear, and regeneration.
- Assert same-`intent_id`/different-body conflicts for every migration artifact and no presented-op side effect after replay throws.
- Assert `effectiveStore` returns the state preimage, not absence, while the migration intent is pending.
- Confirm schema/tool/case counts are unchanged except the goal op enum; no new CLI, shim, registry, or policy entry.
- Run `validateBoundaryMap({blueprintText, blueprintPath, repoRoot})` and require zero violations/warnings.
- Before S4 sign-off, require `git diff --name-only` to match the approved code/test files plus the exact live cutover artifact set.

## Verification Table

Every anchor below was re-read from this checkout while authoring. `VERIFIED` means the cited lines exist and support the stated seam.

| File/check | Re-checked anchors | Verdict |
|---|---|---|
| Writer intent/replay core | `lib/judgment-writer.js:240-287`, `lib/judgment-writer.js:410-550`, `lib/judgment-writer.js:570-599` | VERIFIED |
| Goal executors/fence | `lib/judgment-writer.js:1972-2012`, `lib/judgment-writer.js:2059-2249` | VERIFIED |
| Position retirement seam | `lib/judgment-writer.js:2262-2296` | VERIFIED |
| Store goal/intents | `lib/judgment/store/records.js:43-48`, `lib/judgment/store/records.js:188-235`, `lib/judgment/store/records.js:376-404` | VERIFIED |
| Effective/cutover view | `lib/judgment/store/index.js:53-71`, `lib/judgment/store/index.js:159-197` | VERIFIED |
| Contract sufficiency | `contracts/judgment-record.schema.json:76-87`, `contracts/judgment-record.schema.json:393-446`, `contracts/judgment-record.schema.json:491-520`, `contracts/judgment-record.schema.json:696-733`, `contracts/judgment-record.schema.json:789-818` | VERIFIED |
| Projection behavior | `lib/judgment-gen.js:58-75`, `lib/judgment-gen.js:500-630`, `lib/judgment-gen.js:658-691` | VERIFIED |
| MCP registration | `server/compose-mcp.js:71-79`, `server/compose-mcp.js:866-893`, `server/compose-mcp.js:988-996`, `server/compose-mcp-tools.js:848-850` | VERIFIED |
| Test seams | `test/judgment-writer.test.js:1793-1866`, `test/judgment-writer.test.js:1990-2050`, `test/judgment-writer.test.js:2337-2527`, `test/judgment-gen.test.js:300-378`, `test/judgment-gen.test.js:651-779`, `test/judgment-writer-mcp.test.js:87-103` | VERIFIED |
| Live source/content | `docs/judgment/records/positions/objective/r1.json:1-27`, `docs/judgment/OBJECTIVE.md:23-74`, `docs/judgment/records/joints/horizon.json:1-28`, `docs/judgment/records/joints/success-criteria.json:1-28`, `docs/judgment/records/joints/commercial-intent.json:1-28` | VERIFIED |

## Tests

| Changed Code | Test File | Action |
|---|---|---|
| `lib/judgment/store/index.js` | `test/judgment-store.test.js` | Update |
| `lib/judgment-writer.js` | `test/judgment-writer.test.js` | Update |
| `lib/judgment-writer.js` | `test/judgment-guard-integration.test.js` | Verify replay regression suite |
| `server/compose-mcp.js` | `test/judgment-writer-mcp.test.js` | Update |
| Projection/effective behavior | `test/judgment-gen.test.js` | Update |

**Commands:**

```bash
node --test \
  test/judgment-schema.test.js \
  test/judgment-store.test.js \
  test/judgment-writer.test.js \
  test/judgment-guard-integration.test.js \
  test/judgment-gen.test.js \
  test/judgment-writer-mcp.test.js
npm test
```

## Documentation

- [ ] `docs/features/COMP-JUDGMENT-GOAL-MIGRATE/design.md` — no edit; remains the binding r4 authority.
- [ ] `ROADMAP.md` — update feature status only in the separately authorized release/status step, not during implementation slices.
- [ ] `docs/judgment/OBJECTIVE.md`, `LEDGER.md`, `index.md`, and `positions/objective.md` — generated only by the owner-approved S4 cutover; never hand-edit.
- [ ] Canon manifest — hand the four rows above to COMP-CANON-GUARD; do not add a private registry here.
