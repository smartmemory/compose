# COMP-JUDGMENT-STORES — Writer extensions: person, situation, and goal stores

**Status:** GATED r12 — design gate CLOSED 2026-07-23. Narrowed-scope curve
7 → 6 → 6 → 6 → 2, where the final verification round's two findings were stale-text
inconsistencies from the round-4 fold (removed-xref residue; error-code precedence),
both fixed in this revision — no new design substance remained. Wide-scope history:
five sol/xhigh rounds (9 → 8 → 7 → 6 → 6), split at round 5 by owner ruling —
packages/coupling and migration carved out to
[`COMP-JUDGMENT-PACKAGES`](../COMP-JUDGMENT-PACKAGES/design.md) and
[`COMP-JUDGMENT-GOAL-MIGRATE`](../COMP-JUDGMENT-GOAL-MIGRATE/design.md), each seeded
with the r6 material and gated separately. THIS doc covers only the narrowed scope.
**Date:** 2026-07-23

## Related Documents

- Roadmap row: `ROADMAP.md` → Judgment Layer → COMP-JUDGMENT-STORES
- Parent: [`COMP-JUDGMENT-WRITER`](../COMP-JUDGMENT-WRITER/design.md) — built the writer for positions/joints/ledger; this feature extends it to the people/situation/goal stores
- Children (split at gate round 5): [`COMP-JUDGMENT-PACKAGES`](../COMP-JUDGMENT-PACKAGES/design.md) (resolution packages + transition coupling), [`COMP-JUDGMENT-GOAL-MIGRATE`](../COMP-JUDGMENT-GOAL-MIGRATE/design.md) (objective→goal migration)
- Guard dependency: [`COMP-CANON-GUARD`](../COMP-CANON-GUARD/design.md) — owns the canon registry + PreToolUse hook; this feature hands it a registration manifest, it does NOT build a guard (gate round 1, finding 7)
- Domain spec (BINDING): `docs/design/2026-07-20-judgment-layer-process-manual.md` — Writer box (seq 112), People (107), Situation (108), Goal (109)
- Rulings: `docs/judgment/LEDGER.md` seq 106 (only-door, fix-in-place-with-trace), 107–112
- Code substrate: `lib/judgment-writer.js`, `contracts/judgment-record.schema.json` (record defs live HERE — `lib/judgment/schema.js` only loads/memoizes the validator), `lib/judgment/store/records.js`, `lib/judgment-write-guard.js`, `lib/judgment-gen.js`

## Problem

The Writer is the ruled only door for ALL judgment stores (seq 106), but today it owns
only three: positions, joints, ledger (+predictions/intents). The People, Situation,
and Goal stores sketched at level 2 have no record kinds, no write ops, no
projections, and their rules exist only as prose. Prose rules are promised habits;
the whole point of seq 112 is to make them **rejected writes**.

## Goals

1. Three new record-kind families behind the existing writer: person, situation
   entity, goal version.
2. Generated projections: `docs/judgment/people/<slug>.md`, `SITUATION.md`,
   `OBJECTIVE.md` (goal-owned via dual-read) — pure output, no marker carve-outs.
3. The stores' rules enforced as typed rejections (see Invariants) — with the
   *honestly unenforceable* remainder listed as such, never presented as enforced.
4. The shared plumbing the children build on: `migration` provenance class,
   `provenance.intent_id` field, `goalCutoverComplete` dual-read helper,
   parameterized chain accessor, new-record snapshot exclusion hook,
   `JUDGMENT_MIGRATION_REQUIRED` guard on first cut.
5. A canon-guard registration manifest for the new paths (children merge their rows).

## Non-Goals

- Resolution packages, transition coupling, prediction lifecycle —
  **COMP-JUDGMENT-PACKAGES**
- The objective→goal migration execution — **COMP-JUDGMENT-GOAL-MIGRATE** (this
  feature ships the goal store LOCKED: cuts reject `JUDGMENT_MIGRATION_REQUIRED`
  until the migration lands)
- Building a PreToolUse guard — COMP-CANON-GUARD owns the registry + hook; until it
  lands, protection remains regen-overwrite + roundtrip guard, stated honestly
- Instruments/quiz engine (delivery product; separate feature)
- Poke machinery, integrations adapters (separate boxes; seq 113/114)
- SmartMemory enrichment of new kinds (W4-family follow-up)
- Whole-cast map projection (render when the cast outgrows single files)
- Oscillation detection, invariant projection, commit *presentation* rules (P4) —
  agent judgment at runtime, not writer-enforceable
- Psychometrics research debt (owner-flagged; not blocking storage)

## Record kinds

All records live under `docs/judgment/records/` (canonical, git-tracked, atomic
tmp+rename writes — the `RecordsStore` idiom). Definitions land in
`contracts/judgment-record.schema.json` (strict `additionalProperties: false`, the
existing convention). Every record carries top-level writer-stamped provenance.
**Nested provenance** (per fact, edge, load-link) is reconstructed by the writer from
allowlisted scalar caller fields — caller-supplied provenance objects are never
passed through at any depth (`runOp` only strips the top level; new ops own the rest).

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
    "trace": [ { "prior": { "text": "…" }, "corrected_at": "…", "provenance": {} } ]
  } ],
  "edges": [ { "id": "e1", "to": "<person-slug>", "kind": "married-to",
               "provenance": {}, "removed": null } ],
  "open_fields": [ { "id": "of1", "name": "her actual yes", "status": "open|filled",
                     "filled_by": "f9",
                     "trace": [ /* fill/reopen history, unified trace shape */ ] } ],
  "load_links": [ { "id": "l1", "fact": "f1", "carries": "plan/claim text or ref",
                    "provenance": {}, "removed": null } ],
  "provenance": { /* record-level, writer-stamped */ }
}
```

**Sub-entry shapes are DECLARED, not implied** (narrowed gate round 3, finding 1):
EVERY sub-entry (facts, edges, open_fields, owed, load_links, goal-state entries)
carries a stable `id`. Removable entries (`edges`, `load_links`, goal-state
associations) carry `removed: null | { at, reason, provenance }` — retired in
place, never deleted. Transitioning entries (`open_fields`, `owed`) carry the
unified `trace[]` recording every fill/reopen with prior values. All shapes land
in S1's closed schemas.

**IDs are writer-allocated, unique, and never reused** (narrowed gate round 4,
finding 4): the writer owns allocation (monotonic per-record counters — `f<N>`,
`e<N>`, …); callers never supply ids on create. Uniqueness within a record is a
writer invariant checked on every write (Draft-07 cannot express it) — a duplicate
id is `JUDGMENT_CONFLICT`; a retired id is never reallocated, so historical traces
and removed entries keep their identity forever.

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
- **The People↔Situation written-once boundary is RECORDED PROCESS DEBT, not a
  typed mechanism** (narrowed gate round 4, finding 3 — reversing round 3's typed
  xref): a typed cross-store reference needs terminal-target/acyclicity rules,
  consumer semantics (a `said` fact dereferenced from another store must not make a
  person "spoken"), repair paths, and rendering rules — a whole contract that is
  disproportionate while this repo's cast files start EMPTY and user projects have
  no duplication pressure yet. v1 rule: cross-references are prose mentions in fact
  text ("see trustflow"); "written once" is agent discipline, listed in the
  not-enforced block. Revisit trigger: the first real duplicated fact observed in
  practice.
- Situation facts are `situation_fact` — NO `section` field (that is a People-only
  specialization; entity grouping is the situation's structure, seq 108). Two closed
  schemas sharing per-property definitions, base-field parity contract-tested — see
  S1 (Draft-07 realizability, narrowed gate round 2, finding 2).
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
                 "trace": [ /* wording-only corrections, same shape as fact trace */ ],
                 "provenance": {} } ],
  "provocation": { "quote": "owner's words that provoked this cut", "at": "…" },
                  // null legal ONLY under via: migration|import
  "ratification": { "asked": "…", "answered_at": "…", "answer_ref": "…", "quote": "…" },
                  // REQUIRED for new cuts — an ATTESTATION CITATION (see below), migration/import exempt
  "diff_note": "what changed vs v2 and why",
  "provenance": {}
}
```

### Goal state — `records/goal/state.json` (mutable sidecar, traced)

**Mutable associations live OFF the meaning-version chain** (narrowed gate round 3,
finding 4): a newly discovered goal joint or a new plan resting on a clause must not
require a fake owner-ratified meaning cut, and must not leave `OBJECTIVE.md` stale.

```jsonc
{
  "joints": [ { "id": "gj1", "joint": "<joint-slug>",   // the goal's own uncertainties —
                "provenance": {}, "removed": null } ],   // the JOINTS LIVE IN THE REGISTER
                                                         // (seq 109); this is only the
                                                         // association (refs validated,
                                                         // JUDGMENT_REF)
  "load_links": [ { "id": "gl1", "clause": "v3#c1", "carries": "…",
                    "provenance": {}, "removed": null } ],
  "provenance": {}
}
```

Maintained by `judgment_goal_write` ops `joint_link` / `load_link` (each with the
traced `remove` variant). Clause refs are version-qualified; a cut does NOT clear
load-links — that is exactly the "bill" (seq 109: load links price every flip), and
the projection renders links whose clause belongs to a superseded version as part
of the flip's cost.

- Versions are immutable in MEANING once cut; a meaning change is a new cut.
  **Wording-only fixes get a legal path**: `correct` amends clause text on the
  current version fix-in-place-with-trace (no new version, no ratification — the
  trace shows exactly what wording moved, and the projection's trajectory marks it
  as a wording fix). Meaning-vs-wording remains agent judgment, honestly listed as
  unenforced; the trace is the audit surface.
- **Ratification is an attestation, not proof** (gate round 1, finding 4): the writer
  cannot verify a human acted — what it enforces is that the cut *cites* the owner
  exchange (the existing ASSERT elicitation-citation convention: `asked`,
  `answered_at`, `answer_ref`). Same honesty stance as ASSERT grounding today.
- **Draft state is DERIVED:** `provenance.via ∈ {"import", "migration"} &&
  !ratification` → the projection renders the imported-draft health warning. No
  stored draft field. (`migration` ships here as a first-class provenance class —
  schema, writer exemption, and projection rule all name both.)
- **The store ships LOCKED — on the EFFECTIVE predicate** (wide gate round 5
  finding 2; narrowed round 3, finding 2): `op=cut` rejects with
  `JUDGMENT_MIGRATION_REQUIRED` while EITHER the legacy `objective` chain is live
  (un-tombstoned) in the effective view with an effectively-empty goal chain, OR
  **any goal-migration intent is pending**. The raw goal chain being non-empty
  cannot unlock cuts — a crashed migration leaves goal v1 on disk but hidden by
  `effectiveStore`, and the writer guard reads the same effective view the
  renderer does, never the raw store. COMP-JUDGMENT-GOAL-MIGRATE unlocks it.
- **The effective view is the writer-wide read contract for goal artifacts**
  (narrowed gate round 4, finding 2): EVERY op consuming goal state — goal
  `load_link`, `rests_on` channel checks, the cut guard — reads through
  `effectiveStore`; additionally, while a goal-migration intent survives replay
  (guard-unreachable case), goal-consuming ops reject with
  `JUDGMENT_INTENT_PENDING` (the same fencing pattern the packages feature uses
  for joints). A raw-but-hidden migration artifact can never satisfy a reference.
- **A separate record kind, not a special-cased position.** The objective is
  philosophically a position (`THE-GOAL-IS-A-POSITION`) but its lifecycle differs:
  cuts are owner-ratified, clauses carry the four-channel grammar + elicitation refs,
  every cut stores its provocation and load-links. Slug-keyed special cases inside
  the position writer were rejected (see Decisions).

## Op surface (MCP)

**Three op-discriminated tools** — the session-start context budget is a real
constraint (CLAUDE.md), and these ops share validation + locking. (The fourth,
`judgment_package_write`, ships with COMP-JUDGMENT-PACKAGES.)

| Tool | `op` values |
|---|---|
| `judgment_person_write` | `create` · `add_fact` · `correct` · `open_field` · `edge` · `load_link` |
| `judgment_situation_write` | `create` · `add_fact` · `correct` · `owed` · `load_link` |
| `judgment_goal_write` | `cut` (ratified version cut) · `correct` (wording-only, traced, current version) · `joint_link` · `load_link` (state sidecar, each with traced `remove`) |

- All route through the existing `runOp` wrapper (sync validation before idempotency,
  advisory lock, intent replay, audit event). Each op's `execute` explicitly uses
  `UndoLog` + `commitWithProjections` — `runOp` does NOT do this for free (grounding
  pass, correction 5).
- Invariants needing store I/O (clause-channel checks, ref resolution) run inside
  `execute` under the writer lock, never in pre-idempotency `validate` (the
  prediction-lookup precedent in `judgmentLedgerAppend`).
- Designed error codes (`JUDGMENT_LOAD_CHANNEL` etc.) are emitted by bespoke
  prechecks; pure JSON-Schema conditionals would surface as
  `JUDGMENT_SCHEMA_VIOLATION` (grounding pass, correction 19). Blueprint assigns
  precheck-vs-schema per invariant.
- **`correct` covers the whole fact contract, not just text** (narrowed gate
  round 1, finding 6): correctable fields are `text`, `at`, `channel` (+`via`), and
  — person facts only — `section`. One trace shape EVERYWHERE (facts, clauses):
  `{ prior: { <field>: <old> }, corrected_at, provenance }` — the writer builds it
  itself; there is structurally no overwrite-without-trace path. **Removal
  semantics** (narrowed gate round 2, finding 5): a transition that obsoletes a
  field removes it atomically with the old value in `prior` (`secondhand → said`
  clears `via`; the iff constraint never breaks mid-record).
- **No correction dead-ends — every dependent has a traced removal path** (narrowed
  gate round 2, finding 1): a correction that would break a dependent invariant
  (e.g. `said → secondhand` on a fact carrying a load-link) REJECTS naming the
  dependents — and each dependent is removable through the same door:
  `load_link`/`edge` ops accept `{<id>, remove: true, reason}` (the entry is
  retired in place with a traced `removed` block, never deleted); `open_field` /
  `owed` accept `{<id>, reopen: true, reason}` (filled/given → open, traced);
  `correct` accepts `clear: ["diverges_with"]` for same-fact pair fields (both
  sides cleared, traced) — and the symmetric **`pair_with: <fact_id>`** SETS a
  divergence pair after both facts exist (the normal case: divergence is
  discovered later), reciprocally, traced on both sides, validating the
  stated↔revealed constraint. **`pair_with` rejects if either endpoint already has
  a partner** (`JUDGMENT_CONFLICT`) — clear first, then set; no four-endpoint
  replacement transaction exists (narrowed gate round 4, finding 6: simpler rule,
  no dangling reciprocal claims possible). Records can never reach an illegal
  state through a side door, and never become uncorrectable through the only
  legal one.
- **`open_field` and `owed` are two-phase ops** (narrowed gate round 1, finding 5):
  `open_field` with `{name}` creates an `open` field; with
  `{open_field_id, filled_by}` transitions `open → filled` (invariant 6 validates
  the filling fact). `owed` with `{name, why_load_bearing}` creates `open`; with
  `{owed_id, filled_by}` transitions `open → given`. Plus the traced `reopen`
  above. No other transitions exist.
- Reads: projections are the read surface. `get_judgment_state` gains a typed
  `counts` field: `{ people: { spoken, stub }, entities, goal: { version, ratified } }`
  — exact JSON, no prose lines. (`packages_open` joins with the packages feature.)
  No new read tool.
- MCP registration: the verified sites are the writer module's tool functions, the
  MCP server dispatch/tool-list, `.mcp.json`/package export (no per-tool schema
  registry), plus `server/mcp-tool-policy.js` — new write tools are correctly denied
  to reviewers by the allowlist default; add them to the policy TEST list. The MCP
  e2e literal `JUDGMENT_TOOLS` list gains all three (blueprint grounds exact lines).

## Invariants — rules as rejected writes

| # | Rule (source) | Enforcement | Error code |
|---|---|---|---|
| 1 | **A stub may not carry load** (107): person `load_link` requires the person `spoken` AND source fact channel ∈ {`said`, `observed`} — both the aggregate lifecycle and the fact channel (gate round 1, finding 6). Situation `load_link`: channel check only (entities don't speak) | precheck in `execute` | `JUDGMENT_LOAD_CHANNEL` |
| 2 | `secondhand` requires a named source (107) — facts AND goal clauses | precheck | `JUDGMENT_INPUT` |
| 3 | A goal version without owner ratification does not cut (109/112) | `op=cut` requires the ratification attestation citation (exempt via `via: 'import'|'migration'` → derived draft) | `JUDGMENT_UNRATIFIED_CUT` |
| 4 | An inferred clause may not carry a commit (109) — **partially enforceable**: commit-moment `decide` events gain an optional typed `rests_on: ["goal:v<N>#c<id>"]`; any listed clause is channel-checked in `execute` (inferred → reject). That commits DECLARE what they rest on is P4 process discipline, honestly listed below as not writer-enforceable (gate round 1, finding 5) | precheck in `judgmentLedgerAppend.execute` under lock | `JUDGMENT_INFERRED_COMMIT` |
| 5 | Corrections fix in place with the old value traced (106) | structural: `correct` is the only mutation op and always writes `trace` | — |
| 6 | **Referential integrity** (gate round 1, finding 8): every intra-record id ref resolves (`fact`, `filled_by`, `diverges_with`, `clause`); `diverges_with` joins stated↔revealed and the writer writes both sides; `open_field` fill requires a `said`-channel fact ("filled by interview, never by inference", 107); `owed` → `given` requires `filled_by`; `edge.to` names an existing person file | prechecks | `JUDGMENT_REF` |
| 7 | First cut cannot bypass migration (wide round 5 finding 2; effective predicate per narrowed round 4, finding 2) | Precedence: while a goal-migration intent survives replay, the fence rejects FIRST (`JUDGMENT_INTENT_PENDING`, invariant-fencing rule); with no pending intent, `op=cut` rejects while (legacy objective chain live ∧ goal chain empty) in the effective view | `JUDGMENT_MIGRATION_REQUIRED` (no-intent case) / `JUDGMENT_INTENT_PENDING` (pending-intent case) |
| 8 | ONE-UNDER-TEST, provenance stamping, projection purity | unchanged — inherited | — |

Deliberately NOT writer-enforced (process rules, listed so the gate doesn't re-add
them and no one mistakes them for enforced): inside-out intake triage (round 1
finding 9 — debt, see Situation); commit `rests_on` completeness (finding 5);
oscillation-to-joint conversion; commit-guard *presentation* of flipped clauses;
meaning-vs-wording version calls.

## Projections (extend `lib/judgment-gen.js`)

| Projection | Source | Notes |
|---|---|---|
| `docs/judgment/people/<slug>.md` | person record | sections in sub-box order; stub/spoken banner; **every fact renders its channel (+`via`), its `at`, and its trace as visible "corrected from …" lines** — the visibly-traced prior value is a binding operational fact, not JSON metadata (narrowed gate round 2, finding 4); divergence pairs rendered adjacent; COMPLETE edge / open-field / owed / load-link state incl. traced removals |
| `docs/judgment/SITUATION.md` | all situation entities | grouped by entity; same per-fact audit rendering as person files (channel, `via`, `at`, traces); owed facts get a prominent block (they are the sweep's feedstock) incl. given/reopened history |
| `docs/judgment/OBJECTIVE.md` | goal chain via `goalCutoverComplete(store)` dual-read: goal chain iff (non-empty ∧ no pending migration intent), else legacy `objective` position — the helper ships HERE, evaluated inside the renderer itself (public entry point), consumed by all three surfaces (source selection, `positions/objective.md` removal, index visibility) | FULL audit surface (narrowed gate rounds 1–2, findings 4/4): current version with clause channels, **per-clause elicitation citations** (which question constructed each clause — binding, seq 109), collapsed wording-fix traces; **the ratification citation** for the current version; the goal's `joints` linked to their register rows; the load-link "bill"; trajectory table (version, date, provocation quote — "unknown (migrated)" when null — AND `diff_note`, with wording-fix marks); draft health warning until first ratified cut |

Pure output, regenerated on every write, hand-edits overwritten — no marker blocks.
The gen's **orphan scan extends to `people/`** (today it only knows `positions/*.md`;
`resolutions/` joins with the packages feature). The chain accessor generalizes:
positions hardcode `r<N>`; goal (`v<N>`) shares a parameterized chain reader (the
packages feature reuses it for `p<N>`). The generator's snapshot gains the
**new-record exclusion hook** (narrowed gate round 1, finding 1 — the seam is
honest about what it can carry): whole record FILES and ledger LINES whose
top-level `provenance.intent_id` matches a pending intent are excluded. That is
sufficient for the MIGRATE child, whose intent writes only NEW artifacts (goal v1,
tombstone revision, note line). It is NOT sufficient for in-place mutations — a
package seal mutates an existing file and attributes only the nested
`seal.provenance` — so the PACKAGES feature specifies its own
preimage/effective-snapshot contract at its own gate; this seam explicitly does
not claim to cover it.

**The exclusion is an EFFECTIVE STORE VIEW, not a spot filter** (narrowed gate
round 2, finding 3): filtering chains alone is insufficient when derived state
reads the raw store — `derivePositionStatus` on the raw store would mark the
legacy objective `retracted` from a pending (excluded!) tombstone. The hook is
therefore a store adapter (`effectiveStore(store)`) through which the generator
reads EVERYTHING — chains, joints, status derivation, cutover predicate, index
visibility. No renderer decision may touch the raw store.

## Canon-guard registration manifest

COMP-CANON-GUARD owns prevention (registry + PreToolUse hook + ship-time scan; its
G2 names `docs/judgment/**`). A named-tool hook alone cannot stop Bash writes or
non-Claude runtimes, so a private guard here would be a second partial door — exactly
the architecture that feature exists to kill (gate round 1, finding 7). This feature
contributes what its lockout invariant needs — **every legitimate mutation of every
new path has a covering tool** (children merge their rows):

The registry maps **path → authorizing outer tools → operations** (never internal
functions — narrowed gate round 1, finding 3). The concrete rows this feature hands
over:

| Path (repo-relative — the registry's base; narrowed gate round 2, finding 6) | Operations | Authorizing outer tools |
|---|---|---|
| `docs/judgment/records/people/**` | create / add_fact / correct / open_field / edge / load_link (+ traced remove/reopen) | `judgment_person_write` |
| `docs/judgment/records/situation/**` | create / add_fact / correct / owed / load_link (+ traced remove/reopen) | `judgment_situation_write` |
| `docs/judgment/records/goal/**` | cut / correct (wording) / joint_link / load_link (+ traced remove) — versions AND `state.json` (narrowed round 4, finding 5) | `judgment_goal_write` (COMP-JUDGMENT-GOAL-MIGRATE adds its migration row) |
| `docs/judgment/people/*.md`, `docs/judgment/SITUATION.md` (new projections) | regeneration (side-effect) | every judgment write tool (`judgment_person_write`, `judgment_situation_write`, `judgment_goal_write`, `judgment_position_create`, `judgment_position_amend`, `judgment_joint_add`, `judgment_transition`, `judgment_ledger_append`), `get_judgment_state` (reconciler-on-read) |
| `docs/judgment/REGISTER.md`, `docs/judgment/LEDGER.md`, `docs/judgment/OBJECTIVE.md`, `docs/judgment/index.md`, `docs/judgment/positions/*.md` (existing projections) | regeneration (side-effect) — `regenerateProjections` rewrites the FULL set on every invocation; the same authorizer list above gains the three new tools | same list |

**Importer classification** (narrowed gate round 2, finding 6): `bin/judgment-import.js`
is a one-time pre-cutover CLI that REFUSES to run once `records/` exists — this repo
is post-cutover, so it is a **retired path**, not an authorizing tool; it appears in
no registry row. (Fresh-workspace first imports predate any registry registration.)

**Direct-entry closure:** `regenerateProjections` and `replayPendingIntents` are
exported module functions with no CLI or MCP surface of their own today — the
blueprint VERIFIES that remains true, and any direct maintenance entry point found
(or added later) either gets a registered typed surface or is closed. No anonymous
regen.

**Replay attribution — structurally representable AND durable** (narrowed gate
round 3, finding 3): the shared provenance schema gains an optional `intent_id`
(ships here; the children stamp it). An opaque id alone is not attribution —
clearing the intent would destroy the op/tool linkage, and an interrupted original
`runOp` never reaches its post-success audit append. So intent records carry their
authorizing `{tool, op}`, and **applying any intent (inline or replayed) appends a
deduped attestation event `{intent_id, tool, op}` BEFORE the intent is cleared**
(the `dropIntentDurably` pattern generalized to the success path). The artifact's
`intent_id` then always resolves against a durable attestation, no matter which
op's reconciler pass physically performed the write.

**Publication point and the clear→regen window** (narrowed gate round 4,
finding 1): for intent-attributed artifacts the ordering is apply effects →
attestation → **clear intent (= publication)** → regenerate projections. A crash
between clear and regen leaves projections exactly one regeneration behind the
records — which is ALREADY this writer's recovery contract ("projections follow
restored records on next regen", the compensating-rollback rule): records are
canonical, projections are pure output, and the very next op or read regenerates.
No dirty-state machinery is added; the transient staleness is documented,
self-healing, and bounded at one regen.

Blueprint carries this table forward; registration itself lands in COMP-CANON-GUARD
S1/S4. Until then: regen-overwrite + roundtrip guard, stated as the actual protection.

## Slices

| Slice | Contents | Gate |
|---|---|---|
| S1 | `contracts/judgment-record.schema.json`: person / situation_entity / goal_version defs; **two fully-declared CLOSED fact schemas** — `person_fact` (base fields + `section` + `diverges_with`) and `situation_fact` (base fields only), each with its own complete property whitelist and `additionalProperties: false`, sharing per-property `definitions` refs (`fact_text`, `fact_channel`, …). Draft-07 cannot merge closed schemas via `allOf` (narrowed gate round 2, finding 2), so "one contract" is held by construction: a contract test asserts base-field parity between the two. Clause sub-schema; `goal_state` def; universal sub-entry ids + `removed` blocks + fill/reopen traces; `migration` provenance class; `intent_id` field + attestation event shape; unified trace shape; validation tests | schema tests green |
| S2 | `RecordsStore`: people/situation aggregates, parameterized chain accessor (`v<N>`), `goal/state.json` sidecar persistence; store tests | store tests green |
| S3 | Writer ops: person + situation (+ invariants 1, 2, 5, 6); writer tests | writer tests green |
| S4 | Writer ops: goal cut + wording correct + joint_link/load_link sidecar writers with their referential invariant (+ invariants 3, 4, 7); effective-view read contract + migration-intent fencing; writer tests | writer tests green |
| S5 | Projections (people, SITUATION, OBJECTIVE full audit surface + dual-read helper) + orphan-scan extension + new-record snapshot exclusion hook + `get_judgment_state.counts`; gen tests | fixed-point + overwrite tests green |
| S6 | MCP registration (3 tools) + policy test list + MCP e2e | e2e green |

## Decisions

1. **Op-discriminated family tools over per-op tools.** Context budget; shared
   validation/lock path. *Rejected:* per-op tools (≈18 schemas of session-start
   cost); one mega `judgment_record_write` (kind × op matrix too wide).
2. **Goal is its own record kind.** *Rejected:* slug-keyed special cases on the
   position chain — different lifecycle (owner ratification, provocation, clause
   grammar, load-links) smuggled into a store whose rules are agent-writable grounding.
3. **Aggregate-mutable-with-trace (person/entity), immutable chain (goal).** Fact
   tracing is NEW behavior — the current store has no in-record trace (joints rely
   on ledger + git); the design owns that novelty rather than claiming precedent.
4. **No new read tool.** Projections are the read surface; state gains typed counts.
5. **Guard by registration handoff, not a private hook.** *Rejected:* per-feature
   PreToolUse hook (partial, duplicative, false "only door" claim).
6. **Ship the goal store locked behind `JUDGMENT_MIGRATION_REQUIRED`.** The store,
   its guard, and the children's shared plumbing land here; the unlock is the
   migration feature's one job. *Rejected:* holding the goal store hostage to the
   migration gate (blocks people/situation for no reason); shipping cuts unlocked
   (first-cut bypass, round 5 finding 2).
7. **Split at the finding cluster** (owner ruling, gate round 5): packages +
   transition coupling and migration each get their own gate. The five-round
   history and all 30 adjudicated findings are preserved in this doc's git history
   and the children's seeds.

## Acceptance criteria

- [ ] Every enforced invariant row (1–4, 6, 7) has a rejection test asserting code + message; structural rows (5, 8) have property tests
- [ ] A hand-edit to any new projection is overwritten by the next regen (test)
- [ ] `judgment_goal_write op=cut` without the ratification citation rejects; `op=correct` traces a wording fix without versioning; cut while the legacy objective chain is live rejects with `JUDGMENT_MIGRATION_REQUIRED`
- [ ] Load-link on a stub person rejects regardless of fact channel; on a spoken person from a `said`/`observed` fact succeeds; from `secondhand`/`inferred` rejects (`JUDGMENT_LOAD_CHANNEL`)
- [ ] Person golden flow: create stub → add secondhand fact (+`via`) → load-link rejects → person speaks (`said` fact) → open_field filled by that fact → load-link on it succeeds → correct traces
- [ ] Situation golden flow: entity → facts (channels) → owed → given via filled_by → load-link channel rules hold
- [ ] `diverges_with` reciprocity + stated↔revealed constraint enforced; `edge.to` to a missing person rejects (`JUDGMENT_REF`)
- [ ] `OBJECTIVE.md` renders from the legacy position until migration (dual-read helper test with a synthetic goal chain); post-cutover it renders diff_note, wording-fix marks, the load-link bill, and goal joints linked to register rows
- [ ] Goal `joints` refs to a missing joint reject (`JUDGMENT_REF`); correcting a fact's channel out from under a load-link rejects naming the dependent
- [ ] `open_field`/`owed` two-phase transitions: create-then-fill flows pass; filling with a non-`said` fact rejects (open_field) and a missing `filled_by` rejects (owed → given)
- [ ] Correction-dead-end closure: after `remove`-ing a dependent load-link (traced), the previously-rejected channel correction succeeds; `secondhand → said` clears `via` atomically with `via` in the trace's `prior`
- [ ] Person/situation projections render channel, `via`, `at`, and visible correction lines for every fact; OBJECTIVE.md renders per-clause elicitation + the ratification citation (audit-surface tests)
- [ ] A pending-intent tombstone does NOT flip the legacy objective's derived status (effective-store view test); with a pending migration intent AND goal v1 physically on disk, `op=cut` rejects `JUDGMENT_INTENT_PENDING` (fence precedence); with no intent and the legacy chain live, it rejects `JUDGMENT_MIGRATION_REQUIRED`
- [ ] `pair_with` sets a reciprocal traced divergence after both facts exist; a stated↔stated pair rejects; `joint_link`/goal `load_link` maintain `goal/state.json` without a version cut, and a superseded-version load-link renders in the bill
- [ ] Replayed writes resolve to a durable attestation `{intent_id, tool, op}`
- [ ] Full suite green; MCP e2e exercises all three tools; policy test asserts reviewer denial for all three
- [ ] `get_judgment_state.counts` matches the typed shape and stays small (AUDIT-19)

## Open questions

None blocking. Parked (owner, later): dossier consent/privacy for non-consenting cast
members (seq 107, product question); read-half feeder fencing (integrations, seq 114);
canon-registry registration timing rides COMP-CANON-GUARD sequencing.
