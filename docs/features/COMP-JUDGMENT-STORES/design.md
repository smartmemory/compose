# COMP-JUDGMENT-STORES — Writer extensions: the only door for every store

**Status:** DRAFT r6 — post gate round 5 (finding curve 9 → 8 → 7 → 6 → 6; round-5 cap hit, surfaced to owner per protocol. Round-5 fixes folded: intent-aware effective snapshot, migration-required guard on first cut, seals preserve grades, method trace, projection prediction source, manifest outer-tool enumeration)
**Date:** 2026-07-23

## Related Documents

- Roadmap row: `ROADMAP.md` → Judgment Layer → COMP-JUDGMENT-STORES
- Parent: [`COMP-JUDGMENT-WRITER`](../COMP-JUDGMENT-WRITER/design.md) — built the writer for positions/joints/ledger; this feature extends it to the remaining stores
- Guard dependency: [`COMP-CANON-GUARD`](../COMP-CANON-GUARD/design.md) — owns the canon registry + PreToolUse hook (S1/S4); this feature hands it a registration manifest, it does NOT build a guard (gate round 1, finding 7)
- Domain spec (BINDING): `docs/design/2026-07-20-judgment-layer-process-manual.md` — Writer box (seq 112), People (107), Situation (108), Goal (109), Resolutions (111)
- Rulings: `docs/judgment/LEDGER.md` seq 106 (only-door, fix-in-place-with-trace), 107–113
- Code substrate: `lib/judgment-writer.js`, `contracts/judgment-record.schema.json` (record defs live HERE — `lib/judgment/schema.js` only loads/memoizes the validator), `lib/judgment/store/records.js`, `lib/judgment-write-guard.js`, `lib/judgment-gen.js`, `bin/judgment-import.js`

## Problem

The Writer is the ruled only door for ALL judgment stores (seq 106), but today it owns
only three: positions, joints, ledger (+predictions/intents). The four stores sketched
at level 2 — People, Situation, Goal, Resolution packages — have no record kinds, no
write ops, no projections, and their rules exist only as prose. Prose rules are promised
habits; the whole point of seq 112 is to make them **rejected writes**.

## Goals

1. Four new record-kind families behind the existing writer: person, situation entity,
   goal version, resolution package.
2. Generated projections: `docs/judgment/people/<slug>.md`, `SITUATION.md`,
   `OBJECTIVE.md` (goal-owned), `docs/judgment/resolutions/<joint>.md` — pure output,
   no marker carve-outs (COMP-JUDGMENT-WRITER precedent).
3. The session's rules enforced as typed rejections (see Invariants) — with the
   *honestly unenforceable* remainder listed as such, never presented as enforced.
4. Migration: the existing back-inferred objective becomes goal v1; the `objective`
   position chain is retired (tombstone + anchored ledger note — the schema has no
   cross-kind supersession).
5. A canon-guard registration manifest: every new canonical path + projection, with
   its covering tool per legitimate mutation (COMP-CANON-GUARD's lockout invariant
   precondition), ready for `canon-registry.js` when its S1 lands.

## Non-Goals

- Building a PreToolUse guard — COMP-CANON-GUARD owns the registry + hook (its G2
  already names `docs/judgment/**`); shipping a second independent partial guard was
  rejected at gate round 1. Until it lands, protection remains regen-overwrite +
  roundtrip guard, stated honestly.
- Instruments/quiz engine (delivery product; People box lists it, separate feature)
- Poke machinery, integrations adapters (separate boxes; seq 113/114)
- SmartMemory enrichment of new kinds (W4-family follow-up)
- Whole-cast map projection (render when the cast outgrows single files)
- Oscillation detection, invariant projection, commit *presentation* rules (P4) —
  agent judgment at runtime, not writer-enforceable
- Psychometrics / evidence-grading research debt (owner-flagged, paid before those
  boxes go level 3 — not blocking storage)

## Record kinds

All records live under `docs/judgment/records/` (canonical, git-tracked, atomic
tmp+rename writes — the `RecordsStore` idiom). Definitions land in
`contracts/judgment-record.schema.json` (strict `additionalProperties: false`, the
existing convention). Every record carries top-level writer-stamped provenance.
**Nested provenance** (per fact, edge, load-link, evidence item) is reconstructed by
the writer from allowlisted scalar caller fields — caller-supplied provenance objects
are never passed through at any depth (`runOp` only strips the top level; new ops own
the rest).

### Person — `records/people/<slug>.json` (one aggregate per human)

```jsonc
{
  "slug": "jane", "display_name": "Jane",
  "facts": [ {
    "id": "f1",
    "section": "role|life|stated|revealed",     // sub-boxes 1–4 of seq 107
    "text": "…their words where possible…",
    "channel": "said|observed|secondhand|inferred",
    "via": "partner",                            // REQUIRED iff channel=secondhand
    "at": "2026-07-23",                          // when the fact was true/heard
    "diverges_with": "f3",                       // stated↔revealed pair; writer keeps it reciprocal
    "provenance": { /* writer-stamped */ },
    "trace": [ { "prior_text": "…", "corrected_at": "…", "provenance": {} } ]
  } ],
  "edges": [ { "to": "<person-slug>", "kind": "married-to", "provenance": {} } ],
  "open_fields": [ { "id": "of1", "name": "her actual yes", "status": "open|filled",
                     "filled_by": "f9" } ],
  "load_links": [ { "id": "l1", "fact": "f1", "carries": "plan/claim text or ref",
                    "provenance": {} } ],
  "provenance": { /* record-level, writer-stamped */ }
}
```

- **Lifecycle is DERIVED, never stored:** `spoken` iff ≥1 fact with `channel: "said"`
  (first person — secondhand is a channel, not a section, so "partner says she said
  yes" is `secondhand` + `via`, and the person stays a stub). Binary until a process
  demands more (seq 107).
- Stated and revealed never merge: `section` keeps them apart; divergence is a
  **pair** — `diverges_with` must join a `stated` fact to a `revealed` fact (or
  vice versa), both sides written by the writer, never a score.
- Edges live on person files; an edge target must be an existing person file
  (create the stub first — `create` is cheap). Cast map projection deferred.

### Situation entity — `records/situation/<entity-slug>.json` (one per entity)

```jsonc
{
  "slug": "trustflow", "display_name": "TrustFlow",
  "facts": [ /* same fact shape as person: channel, via, at, trace */ ],
  "owed": [ { "id": "o1", "name": "monthly revenue number",
              "why_load_bearing": "…", "status": "open|given", "filled_by": "f4" } ],
  "load_links": [ /* same shape */ ],
  "provenance": {}
}
```

- Entities are the aggregate; `SITUATION.md` groups by entity. Facts about a person go
  in their person file; shared things live here, cross-referenced, never duplicated.
- **Inside-out only is UNENFORCED DEBT** (gate round 1, finding 9): the writer cannot
  distinguish what the cast owns from world facts — provenance stamping records who
  and when, not scope. Recorded here so it is never mistaken for enforced; the
  integrations feature (seq 114) adds source-typed fencing for adapter-written facts,
  which still will not stop a direct write. Intake triage stays a process rule.

### Goal version — `records/goal/v<N>.json` (append-only immutable chain)

```jsonc
{
  "version": 3,
  "clauses": [ { "id": "c1", "text": "…",
                 "channel": "said|observed|secondhand|inferred",  // full grammar (seq 109: clauses are facts)
                 "via": "…",                                       // iff secondhand
                 "elicitation": { "asked": "…", "answered_at": "…", "answer_ref": "…" },
                                                    // REQUIRED — which question/instrument produced it
                 "trace": [ /* wording-only corrections, same shape as fact trace
                               (gate round 4, finding 2) */ ],
                 "provenance": {} } ],
  "provocation": { "quote": "owner's words that provoked this cut", "at": "…" },
  "ratification": { "asked": "…", "answered_at": "…", "answer_ref": "…", "quote": "…" },
                  // REQUIRED for new cuts — an ATTESTATION CITATION (see below), import exempt
  "load_links": [ { "id": "l1", "clause": "c1", "carries": "…", "provenance": {} } ],
  "diff_note": "what changed vs v2 and why",
  "provenance": {}
}
```

- Versions are immutable in MEANING once cut; a meaning change is a new cut.
  **Wording-only fixes get a legal path** (gate round 3, finding 6): a `correct` op
  amends clause text on the current version fix-in-place-with-trace (no new version,
  no ratification required — the trace shows exactly what wording moved, and the
  projection's trajectory marks it as a wording fix). Meaning-vs-wording remains
  agent judgment, honestly listed as unenforced; the trace is the audit surface.
- **Ratification is an attestation, not proof** (gate round 1, finding 4): the writer
  cannot verify a human acted — what it enforces is that the cut *cites* the owner
  exchange (the existing ASSERT elicitation-citation convention: `asked`,
  `answered_at`, `answer_ref`). Same honesty stance as ASSERT grounding today.
- **Draft state is DERIVED:** `provenance.via ∈ {"import", "migration"} &&
  !ratification` → the projection renders the imported-draft health warning. No
  stored draft field. (`migration` becomes a first-class provenance class alongside
  `import` — schema, writer exemption, and projection rule all name both; gate
  round 2, finding 6.)
- **A separate record kind, not a special-cased position.** The objective is
  philosophically a position (`THE-GOAL-IS-A-POSITION`) but its lifecycle differs:
  cuts are owner-ratified, clauses carry the four-channel grammar + elicitation refs,
  every cut stores its provocation and load-links. Slug-keyed special cases inside
  the position writer were rejected (see Decisions).

### Resolution package — `records/resolutions/<joint-slug>/p<N>.json` (chain per joint; each package mutable-until-sealed)

```jsonc
{
  "joint": "<joint-slug>", "package": 2,        // p2 = re-dispose after p1 sealed inconclusive
  "disposed_by": "EXT|INT|CONSTRUCT|ASSERT|STRADDLE",   // the method this package serves
  "method_trace": [ /* prior disposed_by values + correction provenance */ ],
  "question": { "restatement": "falsifiable form", "bar": "pre-written bar",
                "no_looks_like": "what NO looks like",
                "trace": [ /* pre-evidence corrections */ ] },
  "prediction": { "prediction_id": "p-7", "made_at": "…" },
                  // the TEXT lives in the prediction store — single canonical body
                  // (gate round 2, finding 5); created atomically with the package
  "spend_ceiling": "hours|days|weeks|months",    // VOI cap in the EXISTING coarse buckets
  "evidence": [ { "id": "e1", "source": "…", "reliability": "…", "at": "…",
                  "points_at": "true|false|both",  // diagnosticity (ACH)
                  "weight_zero": true,             // WRITER-STAMPED iff points_at=both
                  "note": "…", "provenance": {} } ],
  "seal": { "at": "…", "edge_to": "resolved|inconclusive|superseded|dissolved|open",
            "artifact_kind": "resolution|dissolution",
            "artifact": { /* the FULL resolution or dissolution object, embedded
                             verbatim — the package is the DURABLE OWNER of
                             disposition history (gate round 2, finding 4): the
                             joint's copy is transient (deleted on reopen/redispose),
                             the package's copy survives */ },
            "adjudicated_by": "owner|agent",
            "provenance": { /* writer-stamped; carries intent_id — see manifest,
                               replay attribution */ } },
  "provenance": {}
}
```

- **The seal is written by `judgment_transition`, never by a package op** — see
  "Single lifecycle authority" below. A package without a `seal` is *open*; at most
  one open package per joint.
- **Prediction: one canonical body, one spawner per context, full lifecycle** (gate
  round 3, finding 3). Package `create` spawns the prediction record (context:
  `package`) and stores only its id — ONE feed, no second text to drift.
  Pre-evidence prediction `correct` mutates the prediction RECORD
  fix-in-place-with-trace (the record gains an optional `trace[]`), in the same
  locked commit. **CONSTRUCT-disposition spawning retires for joint dispositions:**
  a disposition ledger event on a packaged joint must carry `prediction_ref` to the
  package's prediction instead of an embedded `prediction` (rejected otherwise) —
  the spawn path survives only for commit-moment decides (context `commit`, no
  joint). Prediction `status` grows `open | graded | void`: a seal whose artifact is
  `failed_to_run`, `superseded`, or a dissolution flips the package's prediction to
  `void` in the same intent — nothing impossible ever lingers in the P6 open feed.
  **The prediction state machine is `open → graded | void`, both terminal** (gate
  round 4, finding 3): postmortem grading rejects a non-`open` prediction
  (`JUDGMENT_CONFLICT`) — today's grading path overwrites unconditionally and gains
  this check. **Invalidating seals only void `open` predictions — an existing grade
  is PRESERVED** (gate round 5, finding 3): the manual lets a prediction come due
  and be graded while its package is still open; a later `failed_to_run` /
  `superseded` / dissolution exit must not fail on `graded → void`, so the seal's
  prediction-status effect is `open → void`, no-op otherwise. A CONSTRUCT
  disposition's `prediction_ref` is **bound to its joint** (round 4, finding 5):
  the event must anchor `joint:<slug>` and the ref must equal that joint's open
  package prediction — checked in `execute` under the lock.
- Verdict vocabulary is the EXISTING resolution enum (`resolved | inconclusive |
  failed_to_run | superseded`); dissolution is the separate artifact it already is
  (gate round 1, finding 2). `learned` / `would_have_settled` / reasons live inside
  the embedded artifact — after the first re-dispose wipes the joint's transient
  copy, the sealed package still resolves them.

## Single lifecycle authority (gate round 1, finding 1 — restructure)

The joint state machine (`judgment_transition`: guarded, intent-first, crash-safe)
remains the ONLY authority over dispositions and outcomes. Packages attach to it:

- `judgment_package_write` ops: `create` · `correct` (question/prediction, pre-evidence
  only, traced) · `evidence`. **There is no verdict op.**
- **Joint-state × package-op matrix** (gate round 2, finding 1 — every cell explicit):

  | Joint state | `create` | `correct` | `evidence` | Transition effect on open package |
  |---|---|---|---|---|
  | `open` | ✓ (if no open pkg) | ✓ pre-evidence | ✗ `JUDGMENT_JOINT_STATE` | `→ under_test`: requires open pkg (dispose); `→ superseded/dissolved`: SEALS open pkg (`edge_to` + artifact) |
  | `under_test` | ✗ (open pkg exists for post-rule dispositions) | ✓ pre-evidence | ✓ | every exit edge SEALS the open pkg in the same intent |
  | `inconclusive` | ✓ p<N+1> (prior pkg sealed) | ✓ on the new open pkg | ✗ | `→ under_test\|open` (re-dispose): requires a NEW open pkg |
  | `resolved` | ✗ `JUDGMENT_JOINT_STATE` | ✗ | ✗ | reopenable: `resolved → open` on shaken evidence (`SHAKE-GROUNDING`) — the only reopen edge that exists |
  | `superseded` / `dissolved` | ✗ `JUDGMENT_JOINT_STATE` | ✗ | ✗ | terminal — NO reopen edge exists and this feature adds none (gate round 4, finding 6) |

  Evidence only flows while the disposition is actually running (`under_test`);
  **every edge that permanently invalidates an open package seals it** — including
  `open → superseded|dissolved` on a sharpened-but-never-disposed joint.
- **Grandfather rule** (gate round 3, finding 2): sealing and `evidence` apply to *an
  open package if one exists*. The one pre-rule `under_test` joint
  (`joint-is-non-obvious`) has none — its exit edges stay legal with NO seal written;
  its disposition artifact lives on the joint + ledger exactly as today. No backfill,
  no fabricated package. Package-required checks bind new dispositions only.
- **Sealing and package creation are intent-backed** (gate round 3, finding 1):
  `UndoLog` compensates exceptions, not process death, so BOTH multi-file package
  operations ride the existing persist-intent → apply → clear pipeline —
  `create` (package + prediction record) and seal (package + joint edge + prediction
  status). The reconciler replays an interrupted write whole; `applyPayload` gains
  package/prediction-status entries.
- **Intent fencing** (gate round 2, finding 2): while a pending transition intent
  references a joint, ALL `judgment_package_write` ops for that joint reject with
  `JUDGMENT_INTENT_PENDING` (checked in `execute` under the writer lock, where the
  reconciler has already run). A guard outage can therefore never interleave a
  package mutation between the persisted seal snapshot and its replay.
- **Method binding** (gate round 2 finding 3; grounded in the REAL schema at gate
  round 3, finding 4): at every dispose edge the writer checks
  `openPackage.disposed_by === (redispose?.new_resolve_by ?? joint.resolve_by)` —
  `JUDGMENT_METHOD_MISMATCH`. A wrong `disposed_by` is fixable: pre-disposition
  `correct` (joint `open`/`inconclusive`) may rebind it, and the package carries a
  **`method_trace[]`** (prior value + correction provenance — gate round 5,
  finding 4) so the rebind is representable, not just promised. The resolution package is the **single sharpening
  authority**: today's `ext_package` is either `{sharpened_question, bar, falsifier}`
  or `{judgment_dispatch, reason}` — on new dispositions the sharpening variant is
  superseded by the package (question/bar/no-looks-like live there; a supplied
  sharpening-variant ext payload is rejected), while the `judgment_dispatch/reason`
  **exception stamp stays on the joint's ext**, so the `BAR-OR-JUDGMENT` gate in
  `judgment-write-guard.js` keeps its stamp source; its bar-presence side reads the
  open package. Straddle keeps its signal fields (method legitimacy, not sharpening).
- **Sharpen-first made mechanical** (seq 111: "sharpen-first gates EVERY
  disposition"): both dispose edges (`open → under_test`, `inconclusive →
  under_test`) REQUIRE an open package (question + prediction + bar pre-written) —
  `JUDGMENT_NO_PACKAGE`. (The one currently-under-test joint predates this rule;
  enforcement applies to new dispositions.)

## Op surface (MCP)

**Four op-discriminated tools** — the session-start context budget is a real
constraint (CLAUDE.md), and these ops share validation + locking:

| Tool | `op` values |
|---|---|
| `judgment_person_write` | `create` · `add_fact` · `correct` · `open_field` · `edge` · `load_link` |
| `judgment_situation_write` | `create` · `add_fact` · `correct` · `owed` · `load_link` |
| `judgment_goal_write` | `cut` (ratified version cut) · `correct` (wording-only, traced, current version) |
| `judgment_package_write` | `create` · `correct` (question/prediction/`disposed_by`, pre-evidence) · `evidence` |

- All route through the existing `runOp` wrapper (sync validation before idempotency,
  advisory lock, intent replay, audit event). Each op's `execute` explicitly uses
  `UndoLog` + `commitWithProjections` — `runOp` does NOT do this for free (grounding
  pass, correction 5).
- Invariants needing store I/O (joint lookup, clause-channel checks, open-package
  checks) run inside `execute` under the writer lock, never in pre-idempotency
  `validate` (the prediction-lookup precedent in `judgmentLedgerAppend`).
- Designed error codes (`JUDGMENT_LOAD_CHANNEL` etc.) are emitted by bespoke
  prechecks; pure JSON-Schema conditionals would surface as
  `JUDGMENT_SCHEMA_VIOLATION` (grounding pass, correction 19). Blueprint assigns
  precheck-vs-schema per invariant.
- `correct` ops take `(fact_id, new_text, …)`; the writer moves the old value into
  `trace` itself — there is structurally no overwrite-without-trace path.
- Reads: projections are the read surface. `get_judgment_state` gains a typed
  `counts` field: `{ people: { spoken, stub }, entities, goal: { version, ratified },
  packages_open }` — exact JSON, no prose lines (grounding pass, correction 23). No
  new read tool.
- MCP registration: the verified sites are the writer module's tool functions, the
  MCP server dispatch/tool-list, `.mcp.json`/package export (no per-tool schema
  registry), plus `server/mcp-tool-policy.js` — new write tools are correctly denied
  to reviewers by the allowlist default; add them to the policy TEST list. The MCP
  e2e literal `JUDGMENT_TOOLS` list gains all four (blueprint grounds exact lines).

## Invariants — rules as rejected writes

| # | Rule (source) | Enforcement | Error code |
|---|---|---|---|
| 1 | **A stub may not carry load** (107): person `load_link` requires the person `spoken` AND source fact channel ∈ {`said`, `observed`} — both the aggregate lifecycle and the fact channel (gate round 1, finding 6). Situation `load_link`: channel check only (entities don't speak) | precheck in `execute` | `JUDGMENT_LOAD_CHANNEL` |
| 2 | `secondhand` requires a named source (107) — facts AND goal clauses | precheck | `JUDGMENT_INPUT` |
| 3 | A package cannot accept evidence before its prediction exists — CONSTRUCTION-TRAP (111/112) | structural: `create` requires question+prediction, empty evidence; `evidence` op re-checks | `JUDGMENT_EVIDENCE_BEFORE_PREDICTION` |
| 4 | Grading against a moved bar is outcome switching (111) | `correct` on question/prediction rejected once ANY evidence exists (trace before that); seal makes the whole package immutable | `JUDGMENT_BAR_FROZEN` |
| 5 | Evidence consistent with both branches carries zero weight (111) | writer stamps `weight_zero: true` on `points_at: "both"` (recorded + surfaced, not rejected) | — |
| 6 | A goal version without owner ratification does not cut (109/112) | `judgment_goal_write op=cut` requires the ratification attestation citation (exempt via `via: 'import'|'migration'` → derived draft) | `JUDGMENT_UNRATIFIED_CUT` |
| 7 | An inferred clause may not carry a commit (109) — **partially enforceable**: commit-moment `decide` events gain an optional typed `rests_on: ["goal:v<N>#c<id>"]`; any listed clause is channel-checked in `execute` (inferred → reject). That commits DECLARE what they rest on is P4 process discipline, honestly listed below as not writer-enforceable (gate round 1, finding 5) | precheck in `judgmentLedgerAppend.execute` under lock | `JUDGMENT_INFERRED_COMMIT` |
| 8 | Corrections fix in place with the old value traced (106) | structural: `correct` is the only mutation op and always writes `trace` | — |
| 9 | Sharpen-first gates every disposition (111): BOTH dispose edges (`open → under_test`, `inconclusive → under_test`) require an open package | precheck in `judgment_transition.execute` | `JUDGMENT_NO_PACKAGE` |
| 10 | Package belongs to a real joint; at most one open package per joint | `create` resolves the joint and checks the chain | `JUDGMENT_NOT_FOUND` / `JUDGMENT_CONFLICT` |
| 10a | Package ops obey the joint-state matrix: `evidence` only while `under_test`; `create`/`correct` never on terminal joints | prechecks per the matrix | `JUDGMENT_JOINT_STATE` |
| 10b | Package writes reject while a pending transition intent references the joint (intent fencing) | precheck in `execute` after reconciler | `JUDGMENT_INTENT_PENDING` |
| 10c | The open package's `disposed_by` must equal the disposition method at every dispose edge; ext/straddle payloads may not carry duplicate sharpening fields | precheck in `judgment_transition.execute` | `JUDGMENT_METHOD_MISMATCH` |
| 11 | **Referential integrity** (gate round 1, finding 8): every intra-record id ref resolves (`fact`, `filled_by`, `diverges_with`, `clause`); `diverges_with` joins stated↔revealed and the writer writes both sides; `open_field` fill requires a `said`-channel fact ("filled by interview, never by inference", 107); `owed` → `given` requires `filled_by`; `edge.to` names an existing person file | prechecks | `JUDGMENT_REF` |
| 12 | Seal only via transition; package seal + joint edge atomic in one intent | structural (no verdict op exists; seal rides the intent payload) | — |
| 13 | ONE-UNDER-TEST, provenance stamping, projection purity | unchanged — inherited | — |

Deliberately NOT writer-enforced (process rules, listed so the gate doesn't re-add
them and no one mistakes them for enforced): inside-out intake triage (finding 9 —
debt, see Situation); commit `rests_on` completeness (finding 5); sharpening
*quality*; VOI arithmetic (ceiling recorded, comparison is judgment);
oscillation-to-joint conversion; commit-guard *presentation* of flipped clauses;
meaning-vs-wording version calls.

## Projections (extend `lib/judgment-gen.js`)

| Projection | Source | Notes |
|---|---|---|
| `docs/judgment/people/<slug>.md` | person record | sections in sub-box order; stub/spoken banner; divergence pairs rendered adjacent; load-links listed with their facts |
| `docs/judgment/SITUATION.md` | all situation entities | grouped by entity; owed facts get a prominent block (they are the sweep's feedstock) |
| `docs/judgment/OBJECTIVE.md` | goal chain | current version + clause channels + trajectory table (version, date, provocation quote); imported-draft health warning until first ratified cut |
| `docs/judgment/resolutions/<joint>.md` | package chain **+ referenced prediction records** (gate round 5, finding 5 — prediction text lives only in the prediction store, so the generator snapshot loads them; a missing/mismatched ref renders an explicit integrity-warning line, never silently omits) | question/prediction/bar first, evidence table with weight-zero column, seal; linked from REGISTER.md joint rows |

Pure output, regenerated on every write, hand-edits overwritten — no marker blocks.
The gen's **orphan scan extends to the new directories** (`people/`, `resolutions/`) —
today it only knows `positions/*.md` (grounding pass, correction 18). The chain
accessor generalizes: positions hardcode `r<N>`; goal (`v<N>`) and packages (`p<N>`)
share a parameterized chain reader rather than copy-pasting it.

## Migration & cutover (was "Import" — gate round 1, finding 4 + grounding corrections 15–17)

`bin/judgment-import.js` REFUSES when `docs/judgment/records/` exists — and this repo
is post-cutover. The objective conversion is therefore a **new idempotent migration
mode** (`--migrate-goal`), not a pass in the one-time importer:

- **One intent-backed compound operation** (internal, not MCP-reachable), not a
  sequence of independent tool calls (gate round 2 finding 7; made process-crash
  durable at gate round 3, finding 1): the migration persists a **migration intent**
  (full payload: goal v1, tombstone revision, anchored note) BEFORE touching the
  store, applies all effects under one advisory-lock acquisition, then clears the
  intent. `UndoLog` handles exceptions; **process death is handled by replay** — the
  reconciler (which runs at the head of every write and read) re-applies the
  remaining effects idempotently (goal v1 exists → skip; tombstone exists → skip;
  note deduped on title, the `dropIntentDurably` precedent).
- **Cutover marker:** goal chain non-empty **AND no pending migration intent** —
  and the RENDERER ITSELF evaluates the full predicate (gate round 4, finding 1):
  `regenerateProjections` is a public entry point callable without reconciliation,
  so a shared `goalCutoverComplete(store)` helper (chain non-empty ∧ no migration
  intent on disk) drives all three consumers — `renderObjective` source selection,
  `positions/objective.md` removal, and index visibility. Deploying the renderer
  before migrating changes nothing.
- **Pending-migration artifacts are projection-isolated** (gate round 5, finding 1):
  selecting the legacy source is not enough — a crashed prefix may already have
  written the tombstone (legacy would render "retracted") or the ledger note. The
  generator's snapshot therefore EXCLUDES every record whose
  `provenance.intent_id` matches a pending intent (an intent-aware effective
  snapshot — general, not migration-specific). Ordering is fixed: apply all
  effects → clear intent → regenerate; a crash anywhere leaves either a fully
  pre-migration or fully post-migration projection, never a mixture.
- **A first ordinary cut cannot bypass migration** (gate round 5, finding 2): while
  a live (un-tombstoned) legacy `objective` position chain exists and the goal
  chain is empty, `judgment_goal_write op=cut` rejects with
  `JUDGMENT_MIGRATION_REQUIRED` — otherwise a pre-migration ratified cut would
  satisfy the cutover predicate and strand the legacy position unretired forever.
- **Idempotence guard:** completed migration (chain non-empty, no intent) → recorded
  no-op (exit 0, "already migrated"). Reruns can never produce goal v2, a second
  tombstone, or a duplicate note.
- After migration, `positions/objective.md` is removed and the index/orphan handling
  covers it (grounding pass, correction 17).
- **Provocation is honest** (gate round 3, finding 7): the source was never
  owner-provoked, so migrated v1 carries `provocation: null` — legal only under
  `via: migration|import` — and the projection renders "provocation: unknown
  (migrated)" instead of a fabricated owner quote.
- `objective` position r1 → `goal/v1.json`: claim c1 maps to a clause with
  **`channel: "inferred"`** — the live claim is explicitly a "back-inferred draft —
  NOT owner-confirmed", so `ASSERT → said` would launder a known inference into
  owner speech and dodge the inferred-commit guard (gate round 1, finding 3). The
  elicitation citation carries over; `via: "migration"` + `ratification` absent →
  derived draft state; the health warning survives in the projection.
- Retirement: the position chain gets a tombstone revision (`retracted: true`) plus
  an **anchored ledger note** pointing at the goal store — `supersedes` only accepts
  position refs, there is no cross-kind pointer (grounding pass, correction 16).
- People/situation start EMPTY in this repo — person files hold a *user's* cast and
  are never authored here (seq 107).
- Cutover commit is human-gated: owner approves the regenerated `OBJECTIVE.md` diff
  (same protocol as the W3 cutover).

## Canon-guard registration manifest (replaces the r1 hook slice)

COMP-CANON-GUARD owns prevention (registry + PreToolUse hook + ship-time scan; its
G2 names `docs/judgment/**`). A named-tool hook alone cannot stop Bash writes or
non-Claude runtimes, so a private guard here would be a second partial door — exactly
the architecture that feature exists to kill (gate round 1, finding 7). This feature
contributes what its lockout invariant needs — **every legitimate mutation of every
new path has a covering tool**:

| Path | Legitimate mutations | Physical mutation surfaces (gate round 2, finding 8) |
|---|---|---|
| `records/people/**` | create/add_fact/correct/open_field/edge/load_link | `judgment_person_write` |
| `records/situation/**` | create/add_fact/correct/owed/load_link | `judgment_situation_write` |
| `records/goal/**` | version cut; wording correct; migration (once) | `judgment_goal_write`; `--migrate-goal`; **reconciler replay of a pending migration intent** — any later writer op or read |
| `records/positions/**` | (already registered) + migration tombstone (once) | existing tools; `--migrate-goal`; migration-intent replay (gate round 4, finding 4) |
| `ledger.jsonl` | (already registered) + migration note; seal-related events | existing tools; `judgment_transition`; `--migrate-goal`; migration-intent replay |
| `records/resolutions/**` | create/correct/evidence; seal | `judgment_package_write`; `judgment_transition`; **reconciler replay** — which runs inside EVERY writer op AND `get_judgment_state` (a nominal read that can physically write) |
| `records/predictions/**` | spawn (package create / commit decide); trace-correct; void-on-seal; grade | `judgment_package_write`, `judgment_ledger_append`, `judgment_transition` (seal), reconciler replay |
| `records/intents/**` | persist/clear (transition, package create/seal, migration) | `judgment_transition`, `judgment_package_write`, `--migrate-goal`, reconciler |
| ALL projections — existing `REGISTER.md`, `LEDGER.md`, `OBJECTIVE.md`, `index.md`, `positions/*.md` AND new `people/*.md`, `SITUATION.md`, `resolutions/*.md` | regeneration only — `regenerateProjections` rewrites the FULL set on every invocation (gate round 4, finding 4) | `regenerateProjections` — invoked by every writer op, the reconciler (incl. on read), and the migration |

**Replay attribution — structurally representable** (gate round 3, finding 5): the
shared provenance schema gains an optional `intent_id`, and the seal carries its own
writer-stamped `provenance` (the r3 seal had none). Applied-inline and replayed
writes stamp the originating intent's id — seals to their transition intent, and
ALL THREE migration artifacts (goal v1, tombstone revision, ledger note) to the
migration intent (gate round 4, finding 4) — so canon-guard attestation binds every
physical write back to its authorizing call no matter which op's reconciler pass
performed it.

**Outer authorizing surfaces** (gate round 5, finding 6 — the registry maps paths to
TOOLS, not internal functions): replay and regeneration are only ever caused by a
closed set of outer entries — the nine judgment MCP tools (five existing + four
new), `get_judgment_state`, and the code-path CLIs (`bin/judgment-import.js`,
`--migrate-goal`). The registry rows name THOSE, with `intent_id` provenance binding
each replayed write to its authorizing tool call. Any direct maintenance entry point
to `regenerateProjections` outside that set either gets a registered typed surface
or is closed — no anonymous regen.

Blueprint carries this table forward; registration itself lands in COMP-CANON-GUARD
S1/S4. Until then: regen-overwrite + roundtrip guard, stated as the actual protection.

## Slices

| Slice | Contents | Gate |
|---|---|---|
| S1 | `contracts/judgment-record.schema.json`: person / situation_entity / goal_version / resolution_package defs + shared fact/clause/evidence sub-schemas; validation tests | schema tests green |
| S2 | `RecordsStore`: people/situation aggregates, parameterized chain accessor (`v<N>`/`p<N>`), package chain; store tests | store tests green |
| S3 | Writer ops: person + situation (+ invariants 1, 2, 8, 11); writer tests | writer tests green |
| S4 | Writer ops: goal cut + package create/correct/evidence; transition coupling (seal-in-intent + embedded artifact, state matrix, intent fencing, method binding, `JUDGMENT_NO_PACKAGE`, `rests_on` check); prediction-store spawn + trace (+ invariants 3–7, 9, 10, 10a–10c, 12) | writer tests green |
| S5 | Projections + orphan-scan extension + `get_judgment_state.counts`; gen tests | fixed-point + overwrite tests green |
| S6 | MCP registration (4 tools) + policy test list + MCP e2e | e2e green |
| S7 | `--migrate-goal` intent-backed compound op (replay-durable, idempotent, dual-read cutover) + objective retirement | owner approves OBJECTIVE.md diff |

## Decisions

1. **Three op-discriminated tools + one single-op tool over per-op tools.** Context
   budget; shared validation/lock path. *Rejected:* per-op tools (≈18 schemas of
   session-start cost); one mega `judgment_record_write` (kind × op matrix too wide).
2. **Goal is its own record kind.** *Rejected:* slug-keyed special cases on the
   position chain — different lifecycle (owner ratification, provocation, clause
   grammar, load-links) smuggled into a store whose rules are agent-writable grounding.
3. **Bar freeze over bar-edit-with-trace.** Fix-in-place-with-trace (106) governs
   *facts*; a resolution bar is a pre-registration, where the named failure is edits
   after evidence arrives. Freeze-on-first-evidence honors both. *Rejected:* full
   immutability at create (punishes sharpening typos with package churn).
4. **`points_at: both` records rather than rejects.** Zero weight ≠ may not exist;
   zeroed-but-visible is itself the confirmation-by-pile measure the WATCH-FOR wants.
5. **Aggregate-mutable-with-trace (person/entity), immutable chain (goal),
   mutable-until-sealed chain (package).** Fact tracing is NEW behavior — the current
   store has no in-record trace (joints rely on ledger + git); the design owns that
   novelty rather than claiming precedent (grounding pass, correction 6).
6. **No new read tool.** Projections are the read surface; state gains typed counts.
7. **Seal via transition, not a verdict op.** One lifecycle authority, one crash-safe
   path; packages and joints can never disagree about an outcome. *Rejected:*
   independent package verdict (second authority — gate round 1, finding 1).
8. **Guard by registration handoff, not a private hook.** *Rejected:* per-feature
   PreToolUse hook (partial, duplicative, false "only door" claim — finding 7).
9. **The package is the durable owner of disposition history.** The seal embeds the
   full resolution/dissolution artifact; the joint's copy stays transient (wiped on
   reopen/re-dispose, as today). *Rejected:* seal-by-reference to the joint artifact
   (dangling after the first re-dispose — gate round 2, finding 4) and a new
   transition-identity scheme (more machinery for the same durability).
10. **Prediction text lives only in the prediction store.** The package holds the id;
    corrections are fix-in-place-with-trace on the record. *Rejected:* dual copies
    with sync semantics (gate round 2, finding 5); package-local text with sweep
    special-casing (second feed).

## Acceptance criteria

- [ ] Every enforced invariant row (1–4, 6, 7, 9, 10, 10a–10c, 12) has a rejection test asserting code + message; structural rows (5, 8, 13) have property tests
- [ ] Joint-state × package-op matrix: every ✗ cell has a rejection test; `open → superseded|dissolved` with an open package seals it (test)
- [ ] Intent fencing: with a pending transition intent on the joint, `correct`/`evidence` reject with `JUDGMENT_INTENT_PENDING` (test)
- [ ] `--migrate-goal` is a no-op on rerun; a forced mid-migration failure rolls back ALL effects (test)
- [ ] A hand-edit to any new projection is overwritten by the next regen (test)
- [ ] `judgment_goal_write op=cut` without the ratification citation rejects; with it, cuts v(N+1) and regenerates `OBJECTIVE.md`; `op=correct` traces a wording fix without versioning
- [ ] CONSTRUCT disposition on a packaged joint with an embedded `prediction` rejects (must use `prediction_ref`); a `failed_to_run`/`superseded`/dissolution seal voids the package's prediction
- [ ] The grandfathered under-test joint can exit legally with no package; a crashed migration or package write completes via reconciler replay (kill-mid-write test)
- [ ] A ratified cut while the legacy objective chain is live rejects with `JUDGMENT_MIGRATION_REQUIRED`; a partially-applied migration renders the pre-migration projection (intent-aware snapshot test)
- [ ] Sealing a package whose prediction is already `graded` preserves the grade; grading a `void` prediction rejects
- [ ] Load-link on a stub person rejects regardless of fact channel; on a spoken person from a `said`/`observed` fact succeeds; from `secondhand`/`inferred` rejects (`JUDGMENT_LOAD_CHANNEL`)
- [ ] Package golden flow: create (question+prediction+bar, spawns prediction record) → evidence (incl. one `both`, stamped weight-zero) → joint transition seals package + resolves joint atomically; evidence-before-prediction, bar-edit-after-evidence, dispose-without-package, and second-open-package all reject
- [ ] Crash-window test: an interrupted seal transition replays package seal + joint edge together via the reconciler
- [ ] `--migrate-goal` produces `goal/v1.json` with the inferred-channel clause + draft state; position chain tombstoned + ledger note; `positions/objective.md` gone; regenerated `OBJECTIVE.md` diff approved by owner
- [ ] Full suite green; MCP e2e exercises all four tools; policy test asserts reviewer denial for all four
- [ ] `get_judgment_state.counts` matches the typed shape and stays small (AUDIT-19)

## Open questions

None blocking. Parked (owner, later): dossier consent/privacy for non-consenting cast
members (seq 107, product question); read-half feeder fencing (integrations, seq 114);
canon-registry registration timing rides COMP-CANON-GUARD sequencing.
