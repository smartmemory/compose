# COMP-JUDGMENT-STORES — Implementation Blueprint

**Status:** BLUEPRINT — Phase 4 draft, grounded against the 2026-07-23 checkout
**Date:** 2026-07-23
**Design authority:** [design.md](design.md), GATED r12 (binding)
**Scope:** person, situation, and goal records; three op-discriminated MCP tools; `goal/state.json`; projections and effective reads; durable intent attribution; state counts; canon-manifest handoff. Resolution packages, transition coupling, and migration execution remain child-feature work.

The implementation must preserve the existing writer's validate-before-idempotency and single-lock entry path while changing its intent publication protocol. In particular, the current transition/replay ordering is not a precedent: r12's `apply → attest → clear → regenerate` order is binding.

## File Plan

| File | Action | Marker | Slice | Purpose |
|---|---|---|---:|---|
| `contracts/judgment-record.schema.json` | modify | (existing) | S1 | Add closed person, situation, goal-version, goal-state, trace/removal, stable-id, goal-ref, intent attribution, and attestation shapes; add `migration`, `intent_id`, and commit `rests_on`. |
| `test/judgment-schema.test.js` | modify | (existing) | S1 | Add valid/invalid fixtures for every new closed definition, base-field parity, conditional fields, stable IDs, intent `{kind, tool, op}`, attestation, and `rests_on`. |
| `lib/judgment/store/records.js` | modify | (existing) | S2 | Add person/situation aggregate persistence, parameterized revision-chain primitives, goal versions, mutable `goal/state.json`, and checked intent deletion. |
| `lib/judgment/store/index.js` | modify | (existing) | S2, S4, S5 | Export the effective-store adapter and shared goal-cutover predicate without changing provider selection. |
| `test/judgment-store.test.js` | modify | (existing) | S2 | Cover aggregate CRUD, `r<N>`/`v<N>` chain parity, goal state, atomic replacement, effective exclusion, cutover behavior, and checked intent clear. |
| `lib/judgment-writer.js` | modify | (existing) | S3, S4, S5 | Add the three family writers, stable-id allocation, all I/O invariants, typed intent dispatch/attestation/publication, guard precedence, `rests_on`, and state counts. |
| `test/judgment-writer.test.js` | modify | (existing) | S3, S4, S5 | Add person/situation golden flows, correction closure, goal operations and fences, counts, rollback, replay, and exact error code/message assertions. |
| `test/judgment-guard-integration.test.js` | modify | (existing) | S4 | Pin live and replayed intent ordering, durable deduped attestation, unknown-kind fail-closed behavior, and retained-intent recovery. |
| `lib/judgment-gen.js` | modify | (existing) | S5 | Snapshot only through the effective view; add people, situation, dual-read objective, audit rendering, deterministic stale-projection pruning, and people orphan detection. |
| `test/judgment-gen.test.js` | modify | (existing) | S5 | Add effective-view, dual-read/cutover cleanup, full audit-surface, orphan, overwrite, and fixed-point tests. |
| `server/compose-mcp-tools.js` | modify | (existing) | S6 | Add three thin target-root shims. |
| `server/compose-mcp.js` | modify | (existing) | S6 | Add three tool definitions/imports/dispatch cases, taking parity from 46/46 to 49/49 and judgment tools from 6 to 9. |
| `server/mcp-tool-policy.js` | modify | (existing) | S6 | Change only the stale “five judgment write tools” comment to eight; add no reviewer allowlist entry. |
| `test/judgment-writer-mcp.test.js` | modify | (existing) | S6 | Expand `JUDGMENT_TOOLS`, exercise all three op-discriminated tools, counts, typed errors, and reviewer denial. |

There are no `(new)` source files in this feature. Verified unchanged dependencies are `lib/judgment/schema.js`, `lib/judgment-write-guard.js`, `test/judgment-write-guard.test.js`, `.mcp.json`, and `package.json`. The new JSON records, sidecar, and Markdown projections are runtime artifacts written beneath a target workspace's `docs/judgment/`; they are file formats, not Boundary Map symbols.

## Corrections Table

All rows are binding on implementation. “Confirmed” rows pin audit facts that must not be reinterpreted during implementation; “Corrected” rows identify behavior or structure that differs from r12's required end state.

| # | Design assumption | Code reality | Binding correction |
|---|---|---|---|
| C1 | Intent-attributed effects publish in the order `apply → attest → clear → regenerate`. | Live transition apply runs inside `commitWithProjections`, so projection regeneration occurs before `clearIntent`; replay applies, clears, and only then performs one final regeneration. No success attestation exists. (`lib/judgment-writer.js:194-202`, `lib/judgment-writer.js:305-310`, `lib/judgment-writer.js:734-742`) | **Corrected:** split intent publication from ordinary compensating commits. Both inline success and replay must use one helper that applies idempotently, appends/dedupes the durable `{intent_id, tool, op}` attestation, clears the intent as the publication point, and only then regenerates. A post-publication regen failure must not roll canonical records back; surface it as projection-stale/partial publication and rely on next-op/read regeneration. |
| C2 | Replay can coexist safely with future migration intents. | The reconciler interprets every intent payload as a transition, optionally calls the transition guard, then calls the transition-specific `applyPayload` and deletes the intent. An unknown future migration intent could therefore be silently “applied” and cleared. (`lib/judgment-writer.js:222-232`, `lib/judgment-writer.js:264-310`) | **Corrected:** add a required typed intent `kind` and a fail-closed dispatcher. Only the registered `transition` handler may run current guard/payload logic. Recognized reserved-but-unimplemented child kinds (`goal_migration`, `package_transition`) remain on disk and return a blocked replay result so their feature-specific fences can run; truly unknown kinds remain on disk and raise a typed intent-kind error. |
| C3 | Every durable intent and its success attestation carry authorizing `{tool, op}`. | `pending_intent` requires only `id`, `op`, `payload`, `created_at`; the current transition writes `op: "judgment_transition"` and no `tool`, conflating the outer tool with an operation. Provenance also has neither `migration` nor `intent_id`. (`contracts/judgment-record.schema.json:24-34`, `contracts/judgment-record.schema.json:387-397`, `lib/judgment-writer.js:691-699`) | **Corrected:** require `kind`, `tool`, and `op` on intents; reserve `tool` for the outer MCP name and `op` for its discriminant. Add optional `provenance.intent_id`, allow provenance `via: "migration"`, and define a writer-only ledger attestation event whose structured fields include exactly `{intent_id, tool, op}`. Caller-facing ledger append must reject forging that reserved event. |
| C4 | Goal `v<N>` can reuse an existing parameterized chain reader. | The store has a position-only `REV_FILE_RE`, `_positionDir`, `_revNumbers`, and `r<N>.json` read/write logic. (`lib/judgment/store/records.js:47-47`, `lib/judgment/store/records.js:61-100`) | **Corrected:** factor a prefix- and number-field-aware chain primitive, retain position wrappers and refs unchanged, and build goal `v<N>.json`/`version` wrappers on it. Never special-case goal inside the position chain. |
| C5 | New sub-entry IDs can be safely allocated by the writer and never reused. | `RecordsStore` has no aggregate entry allocator/counter. The only nearby allocator derives a prediction ID from collection length, which is not a safe precedent for permanent IDs. (`lib/judgment/store/records.js:49-59`, `lib/judgment-writer.js:761-763`) | **Corrected:** add a writer-owned, lock-protected high-water allocator per record and prefix (`f`, `e`, `of`, `o`, `l`, `c`, `gj`, `gl`). It must inspect all live and retired entries, reject duplicate/malformed IDs as `JUDGMENT_CONFLICT`, and allocate `max + 1`; callers never supply IDs on create. Because retired entries remain in place, IDs cannot be reused. |
| C6 | Commit events can declare goal clause dependencies through typed `rests_on`. | `ledger_event` has no `rests_on` property, and `LEDGER_PASSTHROUGH_KEYS` cannot carry it. (`contracts/judgment-record.schema.json:295-329`, `lib/judgment-writer.js:754-759`) | **Corrected:** add `rests_on` as an array of strict `goal:v<N>#c<id>` refs and pass it through. For commit-moment `decide` events, resolve every ref through the effective goal chain inside `execute`; missing/hidden refs are `JUDGMENT_REF`, inferred clauses are `JUDGMENT_INFERRED_COMMIT`. Completeness remains unenforced process discipline. |
| C7 | `effectiveStore(store)` is already the common read contract. | It does not exist. Generator snapshot loading calls raw list/read/status methods; `derivePositionStatus` itself traverses raw chains; `getJudgmentState` also reconstructs results from a fresh raw store. (`lib/judgment-gen.js:53-65`, `lib/judgment/store/records.js:123-134`, `lib/judgment-writer.js:839-867`) | **Corrected:** implement one adapter that snapshots pending intent IDs and filters every record-file/ledger-line read whose top-level `provenance.intent_id` is pending. Reimplement derived status on the adapter's own filtered reads; never delegate that method to the raw store. Generator, cutover, goal refs/links, `rests_on`, cut guard, and counts consume the adapter only. Raw store access remains write-side only. |
| C8 | `goalCutoverComplete(store)` controls all objective surfaces and cleans up the old projection. | `renderObjective` always selects the legacy `objective` position; position generation and the index always include every position. Regeneration writes emitted files but deletes none, while roundtrip checking only reports stale `positions/*.md` files. (`lib/judgment-gen.js:251-280`, `lib/judgment-gen.js:291-315`, `lib/judgment-gen.js:323-340`) | **Corrected:** centralize the effective predicate `goal chain non-empty AND no pending goal-migration intent`; use it for OBJECTIVE source selection, legacy `positions/objective.md` suppression/deletion, and index visibility. Regeneration must deterministically prune generated orphans after successful writes, including post-cutover `positions/objective.md` and `people/*.md`; roundtrip must report the same stale set. |
| C9 | `UndoLog` has one unambiguous contract for mutable and newly created files. | `note(path)` snapshots current bytes, but new files are handled three different ways: note after write then overwrite `prior`, direct `{prior:null}` pushes, and mutable pre-write snapshots. (`lib/judgment-writer.js:172-187`, `lib/judgment-writer.js:397-404`, `lib/judgment-writer.js:468-473`, `lib/judgment-writer.js:523-527`) | **Corrected:** expose explicit `capture(path)` and `created(path)` operations (or equivalent named methods) and eliminate direct `entries` mutation. Mutable aggregates/sidecars are captured before overwrite; new goal versions/person/entity files are marked created and deleted on compensation. Add failure-injection tests for both paths. |
| C10 | `runOp` makes every nested provenance field safe and commits projections automatically. | `runOp` rejects only top-level caller `provenance`, and it supplies lock/replay/execute/audit but no undo or commit wrapper. Existing ops build records explicitly and each execute owns its commit. (`lib/judgment-writer.js:331-359`, `lib/judgment-writer.js:389-405`) | **Confirmed and pinned:** each family op constructs every nested fact/edge/link/trace/removal provenance block from allowlisted scalar input and writer stamps; never spread nested caller objects. Each `execute` explicitly owns `UndoLog` plus the appropriate ordinary commit or intent-publication helper. |
| C11 | Three MCP tools can be added at the already-verified registration seam. | The live server has 46 tool definitions and 46 dispatch cases; six are judgment tools. Judgment shims are thin dynamic imports using `getTargetRoot`. (`server/compose-mcp.js:92-115`, `server/compose-mcp.js:691-803`, `server/compose-mcp.js:849-908`, `server/compose-mcp-tools.js:809-841`) | **Confirmed and pinned:** add exactly three shim imports, tool definitions, shims, and dispatch cases; assert 49 definitions / 49 cases and nine judgment tools. Do not add a second registry. |
| C12 | Package metadata may contain a second per-tool schema/export registry. | `.mcp.json` only launches `server/compose-mcp.js`; `package.json` exports the server as `./mcp` and has no per-tool entries. (`.mcp.json:2-14`, `package.json:8-13`) | **Confirmed and pinned:** no edits to either file. |
| C13 | Reviewer policy needs entries for the new write tools. | Reviewer policy is allowlist-mode and contains only `get_judgment_state`; all unknown writes are denied. Its comment still says there are five judgment write tools. (`server/mcp-tool-policy.js:32-45`, `server/mcp-tool-policy.js:97-105`) | **Corrected:** add no allowlist entries. Update only the stale comment to eight judgment write tools and expand the existing judgment policy test literal. |
| C14 | Existing tests already pin the required replay attribution and future-intent safety. | Replay tests use intents with only `op`, assert apply/clear/idempotency, and guard tests cover durable refusal notes but no success attestation or unknown-kind retention. (`test/judgment-writer.test.js:456-541`, `test/judgment-guard-integration.test.js:55-121`) | **Corrected:** update all crafted intents to the new schema and add ordering/failure-window assertions: attestation dedupes before clear; unknown kinds are retained; a pending migration intent hides its new records and wins error precedence over migration-required. |
| C15 | Clearing an intent can serve as a checked durable publication point. | `clearIntent` catches and ignores every unlink error, not only “already absent”; callers cannot distinguish a durable clear from permission/I/O failure. (`lib/judgment/store/records.js:221-245`) | **Corrected:** make clear idempotent only for `ENOENT` and rethrow every other failure. `publishIntentLocked` must not regenerate or report success unless clear returns successfully. |

## Boundary Map

The map names code symbols only. JSON definitions, record paths, projection formats, error precedence, and canon-manifest rows remain in the slice prose below. `regenerateProjections` is an existing stable import used by S3/S4; its extension is owned by S5 and is therefore not represented as a forbidden forward edge.

### S01: contracts and validation surface
Produces:
  lib/judgment/schema.js → getJudgmentValidator (function)
  lib/judgment-write-guard.js → assertValidRecord (function)
  lib/judgment-write-guard.js → JudgmentWriteValidationError (class)

Consumes: nothing (leaf node)

### S02: records store and effective read view
Produces:
  lib/judgment/store/records.js → RecordsStore (class)
  lib/judgment/store/index.js → createJudgmentStore, effectiveStore, goalCutoverComplete (function)

Consumes: nothing (leaf node)

### S03: person and situation writer families
Produces:
  lib/judgment-writer.js → judgmentPersonWrite, judgmentSituationWrite, allocateStableEntryId (function)

Consumes:
  from S01: lib/judgment-write-guard.js → assertValidRecord
  from S02: lib/judgment/store/index.js → createJudgmentStore

### S04: goal writer, goal-aware ledger checks, and durable intents
Produces:
  lib/judgment-writer.js → judgmentGoalWrite, judgmentLedgerAppend, replayPendingIntents, publishIntentLocked (function)
  lib/judgment-writer.js → INTENT_APPLIERS (const)

Consumes:
  from S01: lib/judgment-write-guard.js → assertValidRecord
  from S02: lib/judgment/store/index.js → createJudgmentStore, effectiveStore, goalCutoverComplete
  from S03: lib/judgment-writer.js → allocateStableEntryId

### S05: projections and compact state counts
Produces:
  lib/judgment-gen.js → generateFromRecords, regenerateProjections, checkProjectionRoundtrip (function)
  lib/judgment-writer.js → getJudgmentState (function)

Consumes:
  from S02: lib/judgment/store/index.js → createJudgmentStore, effectiveStore, goalCutoverComplete

### S06: MCP surface and policy pin
Produces:
  server/compose-mcp-tools.js → toolJudgmentPersonWrite, toolJudgmentSituationWrite, toolJudgmentGoalWrite (function)
  server/compose-mcp.js → TOOLS (const)

Consumes:
  from S03: lib/judgment-writer.js → judgmentPersonWrite, judgmentSituationWrite
  from S04: lib/judgment-writer.js → judgmentGoalWrite
  from S05: lib/judgment-writer.js → getJudgmentState

## Cross-Slice Implementation Contracts

### Writer entry and validation boundary

- Keep `runOp(cwd, args, {tool, validate, execute})` as the sole family-writer entry pattern: reject top-level caller provenance, perform synchronous shape/input checks before idempotency, then lock, replay, execute, release, and append best-effort audit after commit (`lib/judgment-writer.js:331-359`).
- `validate` may inspect only the supplied argument shape and construct sanitized scalar input. Any check requiring records—aggregate existence, reference resolution, lifecycle, dependency scans, goal cutover, pending migration, or clause channel—belongs in `execute` after replay while the advisory lock is held. The current prediction lookup is the direct pattern (`lib/judgment-writer.js:772-809`).
- Each new family function is one exported op-discriminated tool function, not one function per MCP operation. Use a closed internal dispatch table so an unknown `op` is `JUDGMENT_INPUT` before idempotency.
- Every final record is validated with `assertValidRecord` immediately before persistence. JSON Schema protects canonical shape; bespoke prechecks emit the design's semantic codes before schema validation would collapse them into `JUDGMENT_SCHEMA_VIOLATION` (`lib/judgment-write-guard.js:43-57`).

### Provenance, traces, removals, and IDs

- `stampProvenance` gains internal-only `via: "migration"` and `intentId` support; MCP callers still cannot supply either (`lib/judgment-writer.js:132-145`).
- New operations reconstruct nested records from allowlisted scalar fields. They stamp provenance on facts, clauses, edges, open fields, owed entries, load links, goal-state associations, trace entries, and removal blocks; an input object is never spread into canonical JSON.
- Any newly created record file or ledger line applied from an intent stamps `provenance.intent_id` with that intent's ID. The existing transition's in-place joint mutation is protected by the locked publisher/UndoLog path; the new-record effective adapter does not claim to reconstruct an in-place preimage.
- Unified correction trace: `{prior: {changed_field: old_value, ...}, corrected_at, provenance}`. Record every changed or cleared value in the same entry. A `secondhand → other` change records and removes old `via` atomically; `other → secondhand` requires a non-empty new `via`.
- Removable entries remain in their arrays with `removed: {at, reason, provenance}`; repeated removal conflicts. Fill/give/reopen transitions append the unified trace and preserve the stable entry ID.
- `allocateStableEntryId(record, collection, prefix)` runs under the writer lock, verifies every existing ID is unique and prefix-conforming, includes retired entries in the high-water scan, and returns the next positive integer suffix. It never uses array length (`lib/judgment-writer.js:761-763` is explicitly not the pattern).

### Intent durability and publication

- Extend the intent envelope to `{id, kind, tool, op, payload, created_at}`. `kind` selects the reconciler handler; `tool` and `op` are copied unchanged into the attestation.
- `INTENT_APPLIERS` initially registers only the existing transition handler. Reserve the child-feature kinds `goal_migration` and `package_transition`; if their handlers are absent, retain the intent and report it blocked. A truly unknown kind fails closed with a typed intent-kind error and is never cleared.
- The success attestation is a reserved internal ledger event carrying structured `intent_id`, `tool`, and `op`. Dedupe by `intent_id` plus the exact authorizing pair. If an event exists for the same ID with different attribution, raise `JUDGMENT_CONFLICT`.
- `publishIntentLocked` is the one inline/replay success path: idempotently apply effects with explicit undo coverage; append/dedupe the attestation; durably clear the intent; regenerate all projections. Before clear, any failure leaves the intent for replay and compensates only where doing so is safe. After clear, canonical records are published and must not be rolled back because projection regeneration failed.
- Preserve refusal durability: the refusal/divergence note lands before clear (`lib/judgment-writer.js:242-262`). Refusal is not a success and therefore gets no success attestation.

### Effective read and goal-fence precedence

- `effectiveStore(rawStore)` takes one coherent pending-intent snapshot. It excludes a whole record file or ledger line when its top-level `provenance.intent_id` names a still-pending intent. It exposes the same read/list/status methods consumers use and no mutation methods.
- Derived methods must call adapter reads. In particular, position status may not fall through to raw `RecordsStore.derivePositionStatus`, whose internal traversal currently bypasses filtering (`lib/judgment/store/records.js:123-134`).
- `goalCutoverComplete(store)` returns true only when the effective goal chain is non-empty and no goal-migration intent is pending. The caller may pass a raw store; the helper must establish/use the effective view itself.
- After replay, every goal-consuming write checks for a surviving goal-migration intent first and raises `JUDGMENT_INTENT_PENDING`. Only with no such intent may `cut` evaluate `(legacy objective is live) AND (effective goal chain is empty)` and raise `JUDGMENT_MIGRATION_REQUIRED`. This ordering is not interchangeable.
- Goal reads for `correct`, `joint_link`, `load_link`, commit `rests_on`, cut guards, state counts, and rendering use the same effective view. Raw-but-hidden goal artifacts never satisfy a reference.
- `getJudgmentState` keeps the writer lock through replay, unconditional projection regeneration, effective snapshot construction, and result assembly. The unconditional read-side regen is what repairs the documented clear→regen crash/failure window even when no intent remains.

## S1 — Contract definitions and validation

**Files:** `contracts/judgment-record.schema.json`, `lib/judgment/schema.js`, `lib/judgment-write-guard.js`, `test/judgment-schema.test.js`; edit `test/judgment-write-guard.test.js` only if a pure helper is extracted.

**Pattern to follow:**

- Add definitions beneath the existing Draft-07 `definitions` object and preserve the contract's closed-object convention (`contracts/judgment-record.schema.json:11-16`, `contracts/judgment-record.schema.json:69-87`).
- Extend the shared provenance definition in place (`contracts/judgment-record.schema.json:24-34`).
- Follow the current conditional-required idiom for state-dependent fields (`contracts/judgment-record.schema.json:247-257`, `contracts/judgment-record.schema.json:330-383`), but run designed semantic prechecks before final schema validation when r12 requires a non-schema error code.
- Reuse the memoized loader unchanged: it already resolves any named definition (`lib/judgment/schema.js:15-23`). `assertValidRecord` already converts Ajv failures into the typed canonical error (`lib/judgment-write-guard.js:43-57`).

**Contract additions:**

1. Add shared scalar/object definitions:
   - `entry_id` plus prefix-specific patterns for `f<N>`, `e<N>`, `of<N>`, `o<N>`, `l<N>`, `c<N>`, `gj<N>`, and `gl<N>`.
   - `fact_text`, `fact_channel`, `fact_at`, `fact_via`, and strict `goal_clause_ref` (`goal:v<N>#c<N>`).
   - `correction_trace`: required `prior`, `corrected_at`, `provenance`; closed at the trace-entry level. `prior` is non-empty and holds only writer-produced old values.
   - `removed_block`: required `at`, `reason`, `provenance`, closed.
   - Attestation-citation shape for goal `ratification`, extending the existing elicitation triplet with required `quote`; a separate `provocation` shape with `quote` and `at`.
2. Extend `provenance`:
   - `via` enum becomes `import | migration`.
   - Optional `intent_id` is a non-empty string.
   - Keep `actor`, `session`, and `written_at` unchanged.
3. Define two complete, closed fact schemas without `allOf`:
   - `person_fact`: `id`, `section`, `text`, `channel`, conditional `via`, `at`, optional `diverges_with`, writer provenance, and `trace`.
   - `situation_fact`: the same base fields and no `section` or `diverges_with`.
   - Both independently list the base properties via shared property-level `$ref`s and set `additionalProperties: false`; a contract test compares their base-property keys and referenced definitions.
4. Define closed sub-entry shapes:
   - Person `edge` and fact `load_link`: stable ID, target/ref, content, writer provenance, and required `removed` (`null` or `removed_block`).
   - `open_field`: stable ID, name, `open | filled`, conditional `filled_by`, writer provenance, and trace.
   - `owed`: stable ID, name, `why_load_bearing`, `open | given`, conditional `filled_by`, writer provenance, and trace.
   - Goal `joint_link` and goal `load_link`: stable ID, target/ref, writer provenance, and required traced `removed`.
5. Define the four record roots:
   - `person`: `slug`, `display_name`, facts, edges, open fields, load links, record provenance.
   - `situation_entity`: `slug`, `display_name`, facts, owed entries, load links, record provenance.
   - `goal_version`: positive `version`, non-empty clauses, nullable provocation, nullable/optional ratification only for internal import/migration drafts, required `diff_note`, record provenance. Each clause has stable ID, text, channel/conditional via, required elicitation, trace, and provenance.
   - `goal_state`: joints, load links, record provenance. State is mutable, but every nested association is stable and retirement-only.
6. Extend existing roots:
   - `ledger_event.properties` gains `rests_on` as strict goal clause refs.
   - Add reserved internal attestation kind/fields so a canonical ledger attestation structurally carries `intent_id`, `tool`, and `op`; conditional requirements make the triple mandatory for that kind and forbid it on ordinary caller events.
   - `pending_intent` requires `kind`, `tool`, and `op` separately, in addition to the current complete payload and timestamps (`contracts/judgment-record.schema.json:387-397` is the replacement seam).

**Tests to write:**

- Extend the fixture-builder + `check(defName, obj)` idiom in `test/judgment-schema.test.js:10-100`.
- For every new root and sub-entry: one valid record, every required field removed once, unknown property rejected, invalid enum/pattern rejected, and nested caller provenance garbage rejected.
- Assert `secondhand` requires non-empty `via` and non-secondhand records reject a stale `via`; writer tests separately assert these surface as `JUDGMENT_INPUT`.
- Assert filled/given states require `filled_by`; open states reject it. Assert all removable entries carry `removed`, and trace/removal objects are closed.
- Assert `person_fact` and `situation_fact` base properties stay in parity while `section`/`diverges_with` exist only on person facts.
- Assert goal import/migration draft shapes accept null provocation/no ratification only with the sanctioned internal provenance; ordinary goal versions require both citations.
- Update the pending-intent builder at `test/judgment-schema.test.js:83-90`; add missing-`kind`, missing-`tool`, missing-`op`, attestation-triple, provenance `intent_id`, `via: migration`, and `rests_on` cases beside `test/judgment-schema.test.js:400-410`.
- If no new pure helper is extracted, leave `test/judgment-write-guard.test.js` unchanged; its `refusal(fn, kind)` helper remains the idiom for any extracted typed guard test (`test/judgment-write-guard.test.js:53-74`).

**S1 gate:** `node --test test/judgment-schema.test.js test/judgment-write-guard.test.js`.

## S2 — RecordsStore aggregates, goal chain, and sidecar

**Files:** `lib/judgment/store/records.js`, `lib/judgment/store/index.js`, `test/judgment-store.test.js`.

**Pattern to follow:**

- Preserve `atomicWrite`'s pid-qualified temp + rename and cleanup behavior (`lib/judgment/store/records.js:28-45`).
- Mutable aggregate files follow the current joint write/read/list pattern (`lib/judgment/store/records.js:137-161`).
- Revision-chain factoring starts at the position-only regex/directory/read/write seam (`lib/judgment/store/records.js:47-117`); position public methods and `<slug>#r<N>` refs must remain behaviorally identical.
- Keep provider selection unchanged; add helpers alongside `createJudgmentStore`, not a new backend or registry (`lib/judgment/store/index.js:17-48`).

**Store surface:**

1. Person aggregates:
   - `records/people/<slug>.json`.
   - `writePerson(record)`, `readPerson(slug)`, `listPeople()` (deterministic slug order), and a path accessor usable by rollback.
   - Create and later correction use the same atomic overwrite method; the writer enforces create-vs-update semantics under lock.
2. Situation aggregates:
   - `records/situation/<slug>.json`.
   - Symmetric `writeSituationEntity`, `readSituationEntity`, `listSituationEntities`, and path access.
3. Parameterized chains:
   - Replace `REV_FILE_RE`/`_revNumbers` internals with helpers parameterized by directory, filename prefix, and numeric record field.
   - Existing positions remain `positions/<slug>/r<N>.json`, field `rev`, ref `<slug>#r<N>`.
   - Goal is a single chain at `goal/v<N>.json`, field `version`, with `writeGoalVersion`, `readGoalVersion`, `readGoalChain`, and `latestGoalVersion`.
   - Append methods calculate the next suffix from on-disk filenames and never overwrite an existing revision. Goal wording correction gets a separate explicit `replaceGoalVersion(version, record)` path; it must reject non-current versions at the writer layer.
4. Goal state:
   - `records/goal/state.json`.
   - `readGoalState()` returns `null` when absent; `writeGoalState(record)` atomically creates/replaces it.
   - Version scanning ignores `state.json` by prefix regex, so state mutation never advances the meaning version.
5. Effective adapter substrate:
   - `effectiveStore(rawStore)` snapshots raw pending intents once, builds the pending-ID set, and exposes filtered reads for positions, joints, predictions, ledger, people, situation, goal chain, and goal state.
   - A record/line is visible unless its **top-level** `provenance.intent_id` is pending. Do not recursively filter nested provenance; this feature's seam is deliberately for whole new artifacts.
   - Adapter list methods derive from adapter read methods, and adapter status derivation traverses adapter chains. Do not call raw composite/derived reads.
   - Expose pending intent metadata read-only so S4 can distinguish `goal_migration` without granting a mutation surface.
6. Cutover predicate:
   - `goalCutoverComplete(store)` establishes an effective view if needed and returns `effective.readGoalChain().length > 0 && !effective.hasPendingIntentKind("goal_migration")`.
   - It does not require or execute migration and does not inspect projections.
7. Intent deletion:
   - Change `clearIntent(id)` so only `ENOENT` is treated as already-cleared success; permission and I/O failures propagate.
   - Keep persist/list/clear paths under `records/intents/`; no second intent store is introduced.

**Tests to write:**

- Extend `freshCwd()` and direct `RecordsStore` idioms at `test/judgment-store.test.js:21-48`.
- Mirror the existing revision-chain test at `test/judgment-store.test.js:50-64` for `v1`, `v2`, sorted reads, ignored `state.json`, non-overwrite, and current-version replacement.
- Mirror joint aggregate tests at `test/judgment-store.test.js:86-94` for people and situation; cover create, atomic update, list order, and missing reads.
- Add state create/read/replace tests proving `joint_link`/`load_link` persistence does not add a goal version.
- Extend rename-failure cleanup coverage at `test/judgment-store.test.js:140-150` to one new aggregate and `goal/state.json`.
- Add clear-intent tests proving `ENOENT` is idempotent while a non-`ENOENT` unlink failure propagates; this is required for S4's publication point.
- Effective-view matrix:
  - pending-intent person/entity/goal-version files and ledger lines are hidden;
  - the same artifacts become visible after intent clear;
  - unrelated and nested-only `intent_id` values remain visible;
  - a pending tombstone cannot change effective legacy objective status;
  - raw goal v1 plus pending `goal_migration` does not complete cutover.
- Keep provider tests at `test/judgment-store.test.js:153-180` unchanged except for asserting the new helpers wrap the same `RecordsStore`; no provider/config expansion.

**S2 gate:** `node --test test/judgment-store.test.js`.

## S3 — Person and situation writer operations

**Files:** `lib/judgment-writer.js`, `test/judgment-writer.test.js`.

**Pattern to follow:**

- Add two exported family functions beside the existing transport-free writers and route both through `runOp` (`lib/judgment-writer.js:331-359`, `lib/judgment-writer.js:371-407`).
- Use `typedError(code, message, cause)` for semantic/I/O failures (`lib/judgment-writer.js:55-64`) and `assertValidRecord` for the final canonical record.
- Follow the explicit `UndoLog` + `commitWithProjections` ownership visible in current execute callbacks (`lib/judgment-writer.js:518-529`, `lib/judgment-writer.js:811-825`), after replacing direct undo-entry mutation per C9.
- Record existence/reference checks run after `createJudgmentStore(cwd)` inside `execute`, as current supersedes and prediction references do (`lib/judgment-writer.js:389-405`, `lib/judgment-writer.js:783-809`).

### `judgmentPersonWrite(cwd, args, internal = {})`

`validate` requires a known `op` and only the scalar fields for that branch. `execute` loads one aggregate, performs exactly one state change, validates the entire post-mutation record, captures/marks the file in `UndoLog`, writes atomically, and regenerates.

| `op` | Input branch | Required behavior |
|---|---|---|
| `create` | `slug`, `display_name` | Reject existing slug with `JUDGMENT_CONFLICT`; create empty `facts`, `edges`, `open_fields`, and `load_links`; stamp record provenance. Lifecycle is not stored. |
| `add_fact` | `slug`, `section`, `text`, `channel`, optional `via`, `at` | Precheck `secondhand ↔ non-empty via` as `JUDGMENT_INPUT`; allocate `f<N>`; initialize trace; stamp nested and record provenance. Caller-supplied `id`, `diverges_with`, trace, or provenance is ignored/rejected, never copied. |
| `correct` | `slug`, `fact_id`; one or more of `text`, `at`, `channel`/`via`, `section`, `pair_with`, `clear:["diverges_with"]` | Build one trace entry per touched fact containing every prior/cleared field. Pair setup mutates and traces both endpoints; clear mutates/traces both endpoints. Pair endpoints must be stated↔revealed and both currently unpaired; otherwise `JUDGMENT_REF` or `JUDGMENT_CONFLICT`. |
| `open_field` | create: `name`; fill: `open_field_id`, `filled_by`; reopen: `open_field_id`, `reopen:true`, `reason` | Enforce exactly one branch. Create `open` with `of<N>`; fill only `open → filled` and require an existing `said` fact; reopen only `filled → open`, remove `filled_by`, and trace the prior state/ref. |
| `edge` | create: `to`, `kind`; remove: `edge_id`, `remove:true`, `reason` | Create only when target person exists; allocate `e<N>` and set `removed:null`. Removal finds the entry by ID, does not require the target still to resolve, and retires it in place. |
| `load_link` | create: `fact`, `carries`; remove: `load_link_id`, `remove:true`, `reason` | Create only if aggregate lifecycle is `spoken` (some `said` fact) and the source fact is `said` or `observed`; otherwise `JUDGMENT_LOAD_CHANNEL`. Allocate `l<N>`. Removal finds by ID without revalidating the source and retires in place. |

After every person mutation, run whole-record semantic validation before schema validation:

- All entry IDs are prefix-valid and unique, including retired entries.
- Every active `fact`, `filled_by`, and reciprocal `diverges_with` resolves.
- Each divergence is exactly one stated↔revealed pair with reciprocal IDs.
- Each filled open field resolves to a `said` fact.
- Each active edge resolves to a person.
- If the aggregate is a stub, it has no active load links. Every active load link's source channel is `said|observed`.
- A correction that would violate any dependent invariant rejects with the designed code and names all blocking entry IDs. This includes changing the only `said` fact when any active load link would make the resulting aggregate a stub. The corresponding remove/reopen/clear op must remain callable even if its target is stale.

### `judgmentSituationWrite(cwd, args, internal = {})`

Use the same branch/commit structure, with these op-specific differences:

| `op` | Input branch | Required behavior |
|---|---|---|
| `create` | `slug`, `display_name` | Reject existing slug; create empty `facts`, `owed`, and `load_links`. |
| `add_fact` | `slug`, `text`, `channel`, optional `via`, `at` | Allocate `f<N>`; there is no `section` and no divergence field. Apply the same secondhand precheck and trace/provenance rules. |
| `correct` | `slug`, `fact_id`; one or more of `text`, `at`, `channel`/`via` | Trace every old/cleared value. Reject a channel change that would invalidate an active load link, naming dependents. |
| `owed` | create: `name`, `why_load_bearing`; give: `owed_id`, `filled_by`; reopen: `owed_id`, `reopen:true`, `reason` | Allocate `o<N>` on create. Give only `open → given` and require an existing fact. Reopen only `given → open`, remove `filled_by`, and trace. |
| `load_link` | create: `fact`, `carries`; remove: `load_link_id`, `remove:true`, `reason` | No spoken lifecycle exists. Source fact must be `said|observed`, else `JUDGMENT_LOAD_CHANNEL`; allocate `l<N>`. Removal is retirement-only and does not re-resolve the source. |

Situation whole-record validation pins unique IDs, conditional `via`, owed references/transitions, and active load-link channels. It does not implement a People↔Situation typed xref or inside-out classifier.

**Tests to write:**

- Use `freshCwd`, `refusedWith`, and fixed-point assertions from `test/judgment-writer.test.js:29-52`.
- Add the complete person golden flow beside the current writer-only golden-flow idiom (`test/judgment-writer.test.js:54-112`): stub create → secondhand fact with `via` → load rejection → `said` fact → open field fill → allowed load → correction trace.
- Add the complete situation flow: entity → channel-varied facts → owed create/give/reopen → load-link channel matrix → correction after dependent removal.
- Rejection matrix with exact code **and message fragment**:
  - missing/stale `via`: `JUDGMENT_INPUT`;
  - load on stub or disallowed source: `JUDGMENT_LOAD_CHANNEL`;
  - missing aggregate/entry: `JUDGMENT_NOT_FOUND`;
  - broken `filled_by`, edge target, pair endpoint, or active entry reference: `JUDGMENT_REF`;
  - duplicate IDs, duplicate aggregate, invalid transition, already-paired endpoint, repeat removal: `JUDGMENT_CONFLICT`.
- Correctable-field matrix: text, at, channel/via, person section, reciprocal pair set, reciprocal clear. Assert old values are visible in trace and `secondhand → said` removes `via` in the same write.
- Dependency closure: a channel correction rejects and names all active blockers; remove/reopen/clear them; retry succeeds. Include the only-`said` aggregate-lifecycle case.
- Stable ID property test: create/retire/create across each prefix, inject an on-disk duplicate/malformed ID, and assert no retired ID is reused and corruption refuses.
- Mutable rollback test: force projection regeneration failure after an aggregate overwrite and assert exact preimage restoration. New-file rollback test: force failure after create and assert the aggregate file is removed.
- Preserve and extend the idempotency idiom at `test/judgment-writer.test.js:319-332`: repeated family call with one key produces one sub-entry and one trace transition.

**S3 gate:** `node --test test/judgment-writer.test.js`.

## S4 — Goal writer, goal-aware commits, and durable intents

**Files:** `lib/judgment-writer.js`, `lib/judgment/store/index.js`, `test/judgment-writer.test.js`, `test/judgment-guard-integration.test.js`.

**Pattern to follow:**

- Refactor the current transition intent creation/apply/clear seam rather than building a second reconciler (`lib/judgment-writer.js:691-745`).
- Replace replay's unconditional transition payload application with `INTENT_APPLIERS` dispatch (`lib/judgment-writer.js:264-312`).
- Generalize the durable-drop ordering into success attestation without weakening the existing refusal path (`lib/judgment-writer.js:242-262`).
- Add `rests_on` resolution where `judgmentLedgerAppend.execute` already performs store-backed prediction lookup and mutation planning under the lock (`lib/judgment-writer.js:772-820`).

### `judgmentGoalWrite(cwd, args, internal = {})`

Every branch runs through `runOp` with outer `tool: "judgment_goal_write"`. After replay, establish `rawStore` plus one coherent effective view. If a `goal_migration` intent remains, all four ops reject `JUDGMENT_INTENT_PENDING` before reading any raw goal artifact.

| `op` | Input branch | Required behavior |
|---|---|---|
| `cut` | `clauses[]` (caller scalar fields only), `provocation`, `ratification`, `diff_note` | For ordinary MCP calls, require non-empty clauses, per-clause elicitation, provocation, and ratification citation; bare/unratified cut is `JUDGMENT_UNRATIFIED_CUT`. Internal `via:import|migration` may omit ratification and use null provocation. With no pending migration intent, reject `legacy objective live ∧ effective goal empty` as `JUDGMENT_MIGRATION_REQUIRED`. Allocate `c<N>` within the new version, append `v<N>.json`, and never clear goal state/load links. |
| `correct` | `clause_id`, `text` | Only the current effective version is addressable. Replace wording in place, append a trace with prior text, preserve `version`, provocation, ratification, diff note, and other clauses, and do not create a version or require a new ratification. |
| `joint_link` | create: `joint`; remove: `joint_link_id`, `remove:true`, `reason` | Create/update `goal/state.json` without a cut. Active create requires an effective existing joint (`JUDGMENT_REF`), allocates `gj<N>`, and sets `removed:null`. Removal resolves the association ID only and retires it in place. |
| `load_link` | create: `clause`, `carries`; remove: `load_link_id`, `remove:true`, `reason` | Parse and resolve the version-qualified clause through the effective goal chain (`JUDGMENT_REF`), allocate `gl<N>`, and set `removed:null`. Removal resolves only the association ID. Superseded-version links remain valid and render in the bill. |

For `goal/state.json`, a first association creates `{joints:[], load_links:[], provenance}`; later operations capture and atomically replace it. Every mutation restamps record provenance while nested create/remove history keeps its own stamps. Validate unique IDs and every active association after mutation.

### Goal-aware `judgmentLedgerAppend`

- Add `rests_on` to `LEDGER_PASSTHROUGH_KEYS` at `lib/judgment-writer.js:754-759`.
- Only a commit-moment `decide` (existing definition: `kind === "decide"` with `trigger`) performs the clause-channel rule.
- If it supplies any `rests_on`, first apply the surviving migration-intent fence. Then resolve every strict goal ref through `effectiveStore`; missing/hidden version or clause is `JUDGMENT_REF`, and any `channel: "inferred"` clause is `JUDGMENT_INFERRED_COMMIT`.
- An empty/omitted `rests_on` stays legal. The writer does not claim to prove that the commit declared every dependency.

### Typed replay and success attestation

1. Existing transition intents become:
   ```json
   {
     "kind": "transition",
     "tool": "judgment_transition",
     "op": "transition"
   }
   ```
   plus the existing complete payload/timestamps. Update every test-crafted intent.
2. Move transition guard logic and `applyPayload` behind the `transition` handler. The dispatcher, not payload shape, decides which code can run.
3. `goal_migration` is a recognized reserved kind for fencing but has no applier in this feature. Replay retains it and reports it blocked; goal-consuming operations then return `JUDGMENT_INTENT_PENDING`. Other unknown kinds are retained and fail closed with a typed intent-kind error.
4. Add `appendIntentAttestation(store, intent)` (internal helper is allowed even if not a Boundary Map export):
   - reads ledger events and finds `kind: "attest"` plus `intent_id`;
   - exact existing `{intent_id, tool, op}` is success/idempotent;
   - mismatched attribution for the same ID is `JUDGMENT_CONFLICT`;
   - otherwise appends a schema-valid reserved event with writer provenance whose `provenance.intent_id` is the same ID, so the effective view hides the line until clear publishes it.
5. `publishIntentLocked` owns undo coverage for the transition's joint, ledger, and predictions; runs the selected idempotent applier; attests; clears; then regenerates. Inline transition and replay call the same helper.
6. Regeneration occurs after publication. If it fails, return a typed error that says canonical effects are committed and projections are stale; do not restore records or recreate the cleared intent. The next writer call, reconciler read, or explicit regeneration repairs projections.
7. Keep the outer best-effort `appendEvent` audit after `runOp` success (`lib/judgment-writer.js:347-359`); it is not the durable intent attestation.

**Tests to write:**

- Goal cut:
  - unrated ordinary cut → `JUDGMENT_UNRATIFIED_CUT`;
  - a `secondhand` goal clause without non-empty `via`, or a non-secondhand clause with stale `via`, → `JUDGMENT_INPUT` with a message naming the clause/channel contract;
  - legacy objective live + no goal + no migration intent → `JUDGMENT_MIGRATION_REQUIRED`;
  - pending migration intent + physically present goal v1 → `JUDGMENT_INTENT_PENDING` (wins);
  - fresh no-legacy workspace ratified cut succeeds;
  - internal import/migration draft derives from missing ratification and never opens the public MCP path.
- Goal correction proves current-version-only wording trace, unchanged version count, no new ratification, and old-version rejection.
- State-sidecar flow proves joint ref validation, clause ref validation, create/remove retirement, monotonic IDs, no version change, and a link to a superseded version survives a later cut.
- `rests_on` matrix: said/observed/secondhand clauses accepted, inferred rejected with `JUDGMENT_INFERRED_COMMIT`, missing/hidden refs rejected with `JUDGMENT_REF`, omitted list accepted, pending migration fenced.
- Extend kill-between-steps tests at `test/judgment-writer.test.js:456-541`: exact success attestation exists once after inline apply and once after replay; repeated replay does not duplicate it.
- Extend injected guard-client tests at `test/judgment-guard-integration.test.js:78-121` and `test/judgment-guard-integration.test.js:175-209`:
  - refusal still writes only its durable drop note and clears;
  - guard outage retains intent and later success attests before clear;
  - already-advanced replay uses the same publication helper;
  - mismatched pre-existing attestation conflicts and preserves the intent.
- Failure windows:
  - make attestation append fail after apply; assert compensation/preimage as applicable and intent retained;
  - make intent clear fail; assert no projection publication and retry dedupes effects/attestation;
  - make regeneration fail after clear; assert effects + attestation remain, intent is gone, and next read/regen repairs.
- Persist an unregistered kind with a payload that resembles a transition; replay must not mutate its joint/ledger/predictions and must not delete it.

**S4 gate:** `node --test test/judgment-writer.test.js test/judgment-guard-integration.test.js`.

## S5 — Projections, dual-read cutover, effective snapshot, and counts

**Files:** `lib/judgment-gen.js`, `lib/judgment-writer.js`, `test/judgment-gen.test.js`, `test/judgment-writer.test.js`.

**Pattern to follow:**

- Replace raw snapshot reads at `lib/judgment-gen.js:53-65` with one raw store, one `effectiveStore(raw)`, and all projection data loaded from the adapter.
- Preserve deterministic pure rendering: the current core accepts a plain snapshot and emits no wall-clock bytes (`lib/judgment-gen.js:284-302`).
- Extend the existing frontmatter/render-helper style (`lib/judgment-gen.js:68-105`) and position-history rendering style (`lib/judgment-gen.js:108-152`).
- Refactor regeneration and roundtrip together so they share emitted paths and managed-orphan discovery (`lib/judgment-gen.js:304-342`).
- Extend `getJudgmentState` only after replay, and use an effective view instead of the fresh raw reads at `lib/judgment-writer.js:839-876`.

### Effective snapshot

`loadSnapshot(cwd)` remains internal and returns projection-ready plain data:

- effective positions with effective derived status;
- effective joints and ledger;
- effective people and situation entities;
- effective goal chain and effective goal state;
- a single `goalCutoverComplete` result;
- SmartMemory team ID as today.

No render helper receives the raw store. A pending intent's excluded tombstone therefore cannot retract the effective legacy objective, and a raw-but-hidden goal v1 cannot flip cutover.

### Projection formats

1. `docs/judgment/people/<slug>.md`
   - Deterministic OKF frontmatter, title/display name, and explicit `stub`/`spoken` banner derived from `said` facts.
   - Sections in order: role, life, stated, revealed.
   - Every fact renders ID, text, channel, conditional `via`, `at`, and every correction as a visible “corrected from …” line.
   - Render divergence pairs adjacent without duplicating their pair explanation.
   - Render complete active and historical edge, open-field, and load-link state, including fill/reopen traces and removal reason/time.
2. `docs/judgment/SITUATION.md`
   - Deterministic entity order and grouping by display name/slug.
   - Every fact gets the same channel/via/at/trace audit surface as person facts.
   - Owed entries are prominent and include open/given status, `filled_by`, and give/reopen trace.
   - Render active/removed load links with their complete retirement history.
3. `docs/judgment/OBJECTIVE.md`
   - Call the shared cutover predicate inside rendering. Before cutover, render the effective legacy objective through the existing position renderer.
   - After cutover, render the effective goal chain: current version; every clause's channel, conditional `via`, elicitation citation, and wording traces; current ratification citation; linked goal-joint associations; the full load-link bill including superseded-version links; and trajectory rows for every version.
   - Trajectory columns: version, provenance date, provocation quote (`unknown (migrated)` when null), `diff_note`, and wording-fix mark.
   - Imported/migrated unratified current version renders the derived draft health warning. No stored draft field.
4. Existing surfaces:
   - `REGISTER.md` and `LEDGER.md` remain complete effective projections. Ledger attestation events must be auditable without dumping payloads.
   - Before cutover, `positions/objective.md` and the objective position index row remain. After cutover, neither is emitted.
   - Other position projections and index behavior remain unchanged.

### Regeneration, pruning, and roundtrip

- `generateFromRecords(snapshot)` returns the complete desired file map, including zero or more people files.
- After all desired files are atomically written, `regenerateProjections` computes managed stale files and deletes them:
  - any `docs/judgment/people/*.md` not emitted;
  - any `docs/judgment/positions/*.md` not emitted, including legacy `objective.md` after cutover.
- Pruning is limited to those generated Markdown directories/files; never recursively delete a broad directory. A prune failure surfaces and participates in ordinary write compensation when publication has not occurred.
- `checkProjectionRoundtrip` uses the same managed stale-file function. It reports content drift, missing desired files, and orphans; it never mutates.
- A hand-edit to any new projection is overwritten on the next successful regeneration. No marker preservation.

### `getJudgmentState.counts`

Preserve every existing top-level field and add exactly:

```json
{
  "counts": {
    "people": { "spoken": 0, "stub": 0 },
    "entities": 0,
    "goal": { "version": null, "ratified": false }
  }
}
```

- Count each effective person once using derived lifecycle.
- `entities` is the effective situation aggregate count.
- `goal.version` is the latest effective version or `null`; `ratified` is `Boolean(latest.ratification)`.
- Pending-excluded records never contribute. Do not add names, facts, clauses, or projection text to counts.
- Keep the advisory lock until replay, unconditional regeneration, and all effective reads are complete. Do not release at the current pre-read boundary in `lib/judgment-writer.js:839-847`.

**Tests to write:**

- Extend `seededCwd` and `PROJECTIONS` in `test/judgment-gen.test.js:20-99` with person, entity, goal, state, traces, removed entries, and pending-intent fixtures.
- Preserve the fixed-point and overwrite idioms at `test/judgment-gen.test.js:101-134`; run them against every new projection class.
- Audit-surface assertions:
  - person/situation channel, via, at, corrected-from text, fill/reopen history, and removal reasons;
  - objective per-clause elicitation, ratification, diff note, null-provocation fallback, wording-fix mark, goal-joint link, and superseded-version bill.
- Dual-read matrix:
  - legacy only → legacy OBJECTIVE plus `positions/objective.md` and index row;
  - synthetic effective goal chain/no pending migration → goal OBJECTIVE and old projection/index row removed;
  - physical goal v1 with pending migration intent → legacy surfaces remain;
  - pending tombstone → legacy objective remains live.
- Pruning tests seed stale `people/ghost.md` and post-cutover `positions/objective.md`; roundtrip reports both, regeneration removes both, and unrelated non-Markdown files remain.
- Keep current derived-status/raw-record assertion style at `test/judgment-gen.test.js:146-153` for the effective tombstone case.
- Extend OKF checks at `test/judgment-gen.test.js:156-207` to people and the post-cutover objective without inventing provider resources.
- In `test/judgment-writer.test.js`, assert the exact counts object for empty, stub, spoken, entity, draft-goal, and ratified-goal states; preserve the small-result discipline used by existing state assertions (`test/judgment-writer.test.js:305-315`).

**S5 gate:** `node --test test/judgment-gen.test.js test/judgment-writer.test.js`.

## S6 — MCP registration, policy pin, and end-to-end coverage

**Files:** `server/compose-mcp-tools.js`, `server/compose-mcp.js`, `server/mcp-tool-policy.js`, `test/judgment-writer-mcp.test.js`; verify-only `.mcp.json` and `package.json`.

**Pattern to follow:**

- Add three thin dynamic-import shims beside the six current judgment shims (`server/compose-mcp-tools.js:809-841`).
- Add the shim imports beside current judgment imports (`server/compose-mcp.js:69-83`), terse advisory schemas beside the existing judgment definitions (`server/compose-mcp.js:691-803`), and cases beside current judgment dispatch (`server/compose-mcp.js:849-908`).
- Keep enforcement in the writer contract; MCP input schemas are advisory, as the server comment already states (`server/compose-mcp.js:691-696`).
- Preserve reviewer allowlist semantics (`server/mcp-tool-policy.js:32-45`, `server/mcp-tool-policy.js:90-112`).

### Tool definitions and shims

Add exactly:

1. `judgment_person_write` → `toolJudgmentPersonWrite` → `judgmentPersonWrite`.
   - `op` required and enumerated: `create | add_fact | correct | open_field | edge | load_link`.
   - Schema lists the union of branch scalar fields and `idempotency_key`; descriptions document create/fill/reopen and create/remove branch pairs.
2. `judgment_situation_write` → `toolJudgmentSituationWrite` → `judgmentSituationWrite`.
   - `op`: `create | add_fact | correct | owed | load_link`.
3. `judgment_goal_write` → `toolJudgmentGoalWrite` → `judgmentGoalWrite`.
   - `op`: `cut | correct | joint_link | load_link`.
   - Describe goal cuts as migration-locked while a live legacy objective requires migration; do not expose internal `via`, provenance, or intent controls.

All shims call `getTargetRoot()` and return the writer promise. Do not export internal per-op handlers.

### Registration and policy assertions

- Start from the confirmed 46 `TOOLS` entries / 46 switch cases and six judgment tools. After the change there must be exactly 49/49 and the nine judgment tools must be exactly the six existing names plus these three.
- `.mcp.json` remains a server-command registration only (`.mcp.json:2-14`); `package.json` remains a single `./mcp` export (`package.json:8-13`).
- `REVIEWER_ALLOW` gets no new names. Change its line-39 comment from five to eight judgment write tools. Implementer deny-mode and orchestrator unrestricted behavior require no policy edits.

**Tests to write:**

- Expand `JUDGMENT_TOOLS` at `test/judgment-writer-mcp.test.js:87-94` from six to nine and update description/count text.
- Extend the existing spawned-stdio `McpClient` idiom (`test/judgment-writer-mcp.test.js:20-84`)—no GUI browser—to:
  - assert `tools/list` exposes all nine;
  - call person create/add-fact, situation create/add-fact, and a ratified goal cut in a fresh no-legacy workspace;
  - call `get_judgment_state` and assert typed counts;
  - assert representative `JUDGMENT_INPUT`, `JUDGMENT_LOAD_CHANNEL`, `JUDGMENT_UNRATIFIED_CUT`, and `JUDGMENT_MIGRATION_REQUIRED` codes survive the MCP boundary.
- Add a source-parity assertion in this test file that counts `TOOLS` definitions and dispatch cases as 49/49, and separately asserts the nine judgment names. Keep the parsing narrowly anchored to the `TOOLS` array and dispatch switch.
- Extend the reviewer end-to-end test at `test/judgment-writer-mcp.test.js:207-228` to call each new write name and assert `PHASE_TOOL_DENIED` before writer validation.
- The pure policy loops at `test/judgment-writer-mcp.test.js:231-244` automatically assert all eight writes denied to reviewer and all nine tools allowed to implementer/orchestrator once the literal changes.
- Do not edit `test/mcp-tool-policy.test.js`; the feature-specific literal is the intended policy test seam.

**S6 gate:** `node --test test/judgment-writer-mcp.test.js`.

## Canon-Manifest Handoff

This feature does not implement a private PreToolUse hook or edit a registry. COMP-CANON-GUARD must merge these repo-relative path rows into its path → outer tool → operation registry:

| Path | Operations | Authorizing outer tools |
|---|---|---|
| `docs/judgment/records/people/**` | create, add_fact, correct, open_field, edge, load_link, traced remove/reopen | `judgment_person_write` |
| `docs/judgment/records/situation/**` | create, add_fact, correct, owed, load_link, traced remove/reopen | `judgment_situation_write` |
| `docs/judgment/records/goal/**` | cut, wording correct, joint_link, load_link, traced remove; covers versions and `state.json` | `judgment_goal_write`; COMP-JUDGMENT-GOAL-MIGRATE later adds its migration tool |
| `docs/judgment/people/*.md`, `docs/judgment/SITUATION.md` | full regeneration side effect | `judgment_person_write`, `judgment_situation_write`, `judgment_goal_write`, `judgment_position_create`, `judgment_position_amend`, `judgment_joint_add`, `judgment_transition`, `judgment_ledger_append`, `get_judgment_state` |
| `docs/judgment/REGISTER.md`, `docs/judgment/LEDGER.md`, `docs/judgment/OBJECTIVE.md`, `docs/judgment/index.md`, `docs/judgment/positions/*.md` | full regeneration side effect | the same nine write/read authorizers in the preceding row |

The manifest names outer MCP tools, never `regenerateProjections`, `replayPendingIntents`, or internal op handlers. Those two module functions remain exported for writer/recovery/test use (`lib/judgment-gen.js:304-323`, `lib/judgment-writer.js:314-325`) but gain no standalone MCP or CLI surface in this feature. The retired importer remains outside the registry, and child features own their additional canonical rows.

## Implementation Exit Checks

Run slice gates after each slice, then the affected judgment suite together:

```bash
node --test \
  test/judgment-schema.test.js \
  test/judgment-write-guard.test.js \
  test/judgment-store.test.js \
  test/judgment-writer.test.js \
  test/judgment-guard-integration.test.js \
  test/judgment-gen.test.js \
  test/judgment-writer-mcp.test.js
npm test
```

Before implementation sign-off:

- Confirm tool-definition/dispatch parity is 49/49 and `JUDGMENT_TOOLS` has nine exact names.
- Confirm all designed semantic rejection tests assert both `code` and a useful message fragment.
- Confirm fixed point, hand-edit overwrite, orphan pruning, rollback for new/mutable files, all intent failure windows, and read-side projection repair.
- Confirm `git diff --name-only` contains only File Plan write targets plus any separately approved release documentation; no package, migration executor, resolution package, transition-coupling, or private canon-guard work.
- No GUI/browser test is needed for this server/storage feature. If browser tooling is added later, use a headless-only executable under the stated sandbox constraint.

## Verification Table

Every anchor below was re-read from the 2026-07-23 checkout after the blueprint body was written. `VERIFIED` means the cited lines exist and support the stated extension point; there are zero stale references.

| File / check | Re-checked anchors | Verdict | What the lines establish |
|---|---|---|---|
| Contract schema | `contracts/judgment-record.schema.json:11-16`<br>`contracts/judgment-record.schema.json:24-34`<br>`contracts/judgment-record.schema.json:69-87`<br>`contracts/judgment-record.schema.json:247-257`<br>`contracts/judgment-record.schema.json:295-329`<br>`contracts/judgment-record.schema.json:330-383`<br>`contracts/judgment-record.schema.json:387-397` | VERIFIED | Definitions container, closed-schema idiom, provenance, conditional idiom, ledger extension point, and incomplete current intent envelope all match the blueprint claims. |
| Schema loader | `lib/judgment/schema.js:15-23` | VERIFIED | Contract path and memoized generic definition validator need no registration change. |
| Write guard | `lib/judgment-write-guard.js:43-57` | VERIFIED | `assertValidRecord` is generic and emits `JUDGMENT_SCHEMA_VIOLATION` with Ajv paths. |
| Records store primitives | `lib/judgment/store/records.js:28-45`<br>`lib/judgment/store/records.js:47-47`<br>`lib/judgment/store/records.js:47-117`<br>`lib/judgment/store/records.js:49-59`<br>`lib/judgment/store/records.js:61-100` | VERIFIED | Atomic write/read, RecordsStore boundary, and position-only `r<N>` chain implementation are exactly where S2 extends. |
| Records store reads/aggregates/intents | `lib/judgment/store/records.js:123-134`<br>`lib/judgment/store/records.js:137-161`<br>`lib/judgment/store/records.js:221-245` | VERIFIED | Raw derived status self-traverses, joint methods provide the mutable aggregate pattern, and `clearIntent` currently swallows all unlink errors. |
| Store registry | `lib/judgment/store/index.js:17-48` | VERIFIED | Provider config/factory is small and has no effective adapter or cutover helper yet. |
| Writer errors/provenance/undo | `lib/judgment-writer.js:55-64`<br>`lib/judgment-writer.js:132-145`<br>`lib/judgment-writer.js:172-187`<br>`lib/judgment-writer.js:194-202` | VERIFIED | Typed errors, current provenance fields, ambiguous UndoLog contract, and mutation-inside-regeneration commit behavior match C1/C3/C9. |
| Writer replay core | `lib/judgment-writer.js:222-232`<br>`lib/judgment-writer.js:242-262`<br>`lib/judgment-writer.js:264-310`<br>`lib/judgment-writer.js:264-312`<br>`lib/judgment-writer.js:305-310`<br>`lib/judgment-writer.js:314-325` | VERIFIED | Payload application and replay are transition-specific; refusal is durable-before-clear; success clears before one replay regen; public replay export is module-only. |
| Writer wrapper/create patterns | `lib/judgment-writer.js:331-359`<br>`lib/judgment-writer.js:347-359`<br>`lib/judgment-writer.js:371-407`<br>`lib/judgment-writer.js:389-405`<br>`lib/judgment-writer.js:397-404`<br>`lib/judgment-writer.js:468-473`<br>`lib/judgment-writer.js:518-529`<br>`lib/judgment-writer.js:523-527` | VERIFIED | Validate-before-idempotency, lock/replay/execute/audit, create/reference checks, and the three inconsistent new-file undo idioms are present as described. |
| Writer live intent path | `lib/judgment-writer.js:691-699`<br>`lib/judgment-writer.js:691-745`<br>`lib/judgment-writer.js:734-742` | VERIFIED | Current transition intent has no kind/tool split or attestation, regenerates inside commit, and clears afterward. |
| Writer ledger/state paths | `lib/judgment-writer.js:754-759`<br>`lib/judgment-writer.js:761-763`<br>`lib/judgment-writer.js:772-809`<br>`lib/judgment-writer.js:772-820`<br>`lib/judgment-writer.js:783-809`<br>`lib/judgment-writer.js:811-825`<br>`lib/judgment-writer.js:839-847`<br>`lib/judgment-writer.js:839-867`<br>`lib/judgment-writer.js:839-876` | VERIFIED | `rests_on` is absent, length-based ID allocation is a bad precedent, store-backed checks occur inside execute, and state releases the lock before raw reads/count construction. |
| Generator snapshot/rendering | `lib/judgment-gen.js:53-65`<br>`lib/judgment-gen.js:68-105`<br>`lib/judgment-gen.js:108-152`<br>`lib/judgment-gen.js:251-280` | VERIFIED | Snapshot uses raw store reads; rendering helpers/position history are reusable; objective/index are legacy-position-only. |
| Generator output/roundtrip | `lib/judgment-gen.js:284-302`<br>`lib/judgment-gen.js:291-315`<br>`lib/judgment-gen.js:304-323`<br>`lib/judgment-gen.js:304-342`<br>`lib/judgment-gen.js:323-340` | VERIFIED | Pure file-map core, write-only regeneration, public exports, and report-only position orphan scan match S5/C8. |
| MCP shims | `server/compose-mcp-tools.js:809-841` | VERIFIED | Six current thin target-root shims; exact insertion point for three more. |
| MCP definitions/dispatch | `server/compose-mcp.js:69-83`<br>`server/compose-mcp.js:92-115`<br>`server/compose-mcp.js:691-696`<br>`server/compose-mcp.js:691-803`<br>`server/compose-mcp.js:849-908` | VERIFIED | Import, `TOOLS`, advisory judgment schemas, and switch dispatch are the four live registration sites. Count script confirmed 46 definitions / 46 cases and six judgment tools. |
| MCP policy | `server/mcp-tool-policy.js:32-45`<br>`server/mcp-tool-policy.js:90-112`<br>`server/mcp-tool-policy.js:97-105` | VERIFIED | Reviewer is deny-by-default allowlist mode; only read state is allowed, so no new write entry is required. |
| MCP/package metadata | `.mcp.json:2-14`<br>`package.json:8-13` | VERIFIED | One server command and one `./mcp` export; no second per-tool registry. |
| Schema tests | `test/judgment-schema.test.js:10-100`<br>`test/judgment-schema.test.js:83-90`<br>`test/judgment-schema.test.js:400-410` | VERIFIED | Fixture/check helper and current incomplete pending-intent tests are the S1 idiom/seam. |
| Guard unit tests | `test/judgment-write-guard.test.js:53-74` | VERIFIED | Typed refusal helper asserts class, kind, and violations. |
| Store tests | `test/judgment-store.test.js:21-48`<br>`test/judgment-store.test.js:50-64`<br>`test/judgment-store.test.js:86-94`<br>`test/judgment-store.test.js:140-150`<br>`test/judgment-store.test.js:153-180` | VERIFIED | Temp workspace fixtures, chain/aggregate/atomicity/provider idioms are current. |
| Writer tests | `test/judgment-writer.test.js:29-52`<br>`test/judgment-writer.test.js:54-112`<br>`test/judgment-writer.test.js:305-315`<br>`test/judgment-writer.test.js:319-332`<br>`test/judgment-writer.test.js:456-541` | VERIFIED | Refusal/fixed-point helpers, golden flow, compact state, idempotency, and replay tests are the extension seams. |
| Guard integration tests | `test/judgment-guard-integration.test.js:55-121`<br>`test/judgment-guard-integration.test.js:78-121`<br>`test/judgment-guard-integration.test.js:175-209` | VERIFIED | Crafted intents, already-advanced replay, durable refusal, outage retention, and recovery are present; success attestation is absent. |
| Generator tests | `test/judgment-gen.test.js:20-99`<br>`test/judgment-gen.test.js:101-134`<br>`test/judgment-gen.test.js:146-153`<br>`test/judgment-gen.test.js:156-207` | VERIFIED | Seed/projection inventory, fixed point, overwrite, status, and OKF checks are current S5 idioms. |
| MCP tests | `test/judgment-writer-mcp.test.js:20-84`<br>`test/judgment-writer-mcp.test.js:87-94`<br>`test/judgment-writer-mcp.test.js:207-228`<br>`test/judgment-writer-mcp.test.js:231-244` | VERIFIED | Headless stdio client, six-name literal, reviewer e2e, and policy loops are the exact S6 seams. |
| Boundary Map validator | Parsed this blueprint with `validateBoundaryMap({ blueprintText, blueprintPath, repoRoot })`. | VERIFIED | `ok: true`; zero violations; zero warnings. Every consume edge points backward and matches an upstream producer. |
