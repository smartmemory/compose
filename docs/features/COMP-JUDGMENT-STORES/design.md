# COMP-JUDGMENT-STORES — Writer extensions: person, situation, and goal stores

**Status:** DRAFT r7 — NARROWED at gate round 5 (2026-07-23, owner ruling). Five
sol/xhigh gate rounds (finding curve 9 → 8 → 7 → 6 → 6) showed the simple stores went
quiet by round 2 while every late finding clustered in resolution-package/transition
coupling and migration. Those split out:
[`COMP-JUDGMENT-PACKAGES`](../COMP-JUDGMENT-PACKAGES/design.md) and
[`COMP-JUDGMENT-GOAL-MIGRATE`](../COMP-JUDGMENT-GOAL-MIGRATE/design.md), each seeded
with the r6 material (all 30 adjudicated findings folded) and each getting its own
gate. THIS doc now covers only the narrowed scope.
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
   parameterized chain accessor, intent-aware effective snapshot hook,
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
                 "trace": [ /* wording-only corrections, same shape as fact trace */ ],
                 "provenance": {} } ],
  "provocation": { "quote": "owner's words that provoked this cut", "at": "…" },
                  // null legal ONLY under via: migration|import
  "ratification": { "asked": "…", "answered_at": "…", "answer_ref": "…", "quote": "…" },
                  // REQUIRED for new cuts — an ATTESTATION CITATION (see below), migration/import exempt
  "load_links": [ { "id": "l1", "clause": "c1", "carries": "…", "provenance": {} } ],
  "diff_note": "what changed vs v2 and why",
  "provenance": {}
}
```

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
- **The store ships LOCKED:** while a live (un-tombstoned) legacy `objective`
  position chain exists and the goal chain is empty, `op=cut` rejects with
  `JUDGMENT_MIGRATION_REQUIRED` (gate round 5, finding 2) — otherwise a
  pre-migration ratified cut would satisfy the cutover predicate and strand the
  legacy position unretired forever. COMP-JUDGMENT-GOAL-MIGRATE unlocks it.
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
| `judgment_goal_write` | `cut` (ratified version cut) · `correct` (wording-only, traced, current version) |

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
- `correct` ops take `(fact_id, new_text, …)`; the writer moves the old value into
  `trace` itself — there is structurally no overwrite-without-trace path.
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
| 7 | First cut cannot bypass migration (gate round 5, finding 2) | `op=cut` rejects while the legacy objective chain is live and the goal chain empty | `JUDGMENT_MIGRATION_REQUIRED` |
| 8 | ONE-UNDER-TEST, provenance stamping, projection purity | unchanged — inherited | — |

Deliberately NOT writer-enforced (process rules, listed so the gate doesn't re-add
them and no one mistakes them for enforced): inside-out intake triage (round 1
finding 9 — debt, see Situation); commit `rests_on` completeness (finding 5);
oscillation-to-joint conversion; commit-guard *presentation* of flipped clauses;
meaning-vs-wording version calls.

## Projections (extend `lib/judgment-gen.js`)

| Projection | Source | Notes |
|---|---|---|
| `docs/judgment/people/<slug>.md` | person record | sections in sub-box order; stub/spoken banner; divergence pairs rendered adjacent; load-links listed with their facts |
| `docs/judgment/SITUATION.md` | all situation entities | grouped by entity; owed facts get a prominent block (they are the sweep's feedstock) |
| `docs/judgment/OBJECTIVE.md` | goal chain via `goalCutoverComplete(store)` dual-read: goal chain iff (non-empty ∧ no pending migration intent), else legacy `objective` position — the helper ships HERE, evaluated inside the renderer itself (public entry point), consumed by all three surfaces (source selection, `positions/objective.md` removal, index visibility) | current version + clause channels + trajectory table (version, date, provocation quote — "unknown (migrated)" when null); draft health warning until first ratified cut |

Pure output, regenerated on every write, hand-edits overwritten — no marker blocks.
The gen's **orphan scan extends to `people/`** (today it only knows `positions/*.md`;
`resolutions/` joins with the packages feature). The chain accessor generalizes:
positions hardcode `r<N>`; goal (`v<N>`) shares a parameterized chain reader (the
packages feature reuses it for `p<N>`). The generator's snapshot gains the
**intent-aware exclusion hook** (records whose `provenance.intent_id` matches a
pending intent are excluded) — inert until the children write attributed records,
but the seam ships here so both children plug into it.

## Canon-guard registration manifest

COMP-CANON-GUARD owns prevention (registry + PreToolUse hook + ship-time scan; its
G2 names `docs/judgment/**`). A named-tool hook alone cannot stop Bash writes or
non-Claude runtimes, so a private guard here would be a second partial door — exactly
the architecture that feature exists to kill (gate round 1, finding 7). This feature
contributes what its lockout invariant needs — **every legitimate mutation of every
new path has a covering tool** (children merge their rows):

| Path | Legitimate mutations | Physical mutation surfaces |
|---|---|---|
| `records/people/**` | create/add_fact/correct/open_field/edge/load_link | `judgment_person_write` |
| `records/situation/**` | create/add_fact/correct/owed/load_link | `judgment_situation_write` |
| `records/goal/**` | version cut; wording correct | `judgment_goal_write` (migration row joins via COMP-JUDGMENT-GOAL-MIGRATE) |
| ALL projections — existing `REGISTER.md`, `LEDGER.md`, `OBJECTIVE.md`, `index.md`, `positions/*.md` AND new `people/*.md`, `SITUATION.md` | regeneration only — `regenerateProjections` rewrites the FULL set on every invocation | `regenerateProjections` — invoked by every writer op, the reconciler (incl. on read), and code-path CLIs |

**Replay attribution — structurally representable:** the shared provenance schema
gains an optional `intent_id` (ships here; the children stamp it). **Outer
authorizing surfaces:** replay and regeneration are only ever caused by a closed set
of outer entries — the judgment MCP tools (five existing + three new here + one with
packages), `get_judgment_state`, and the code-path CLIs (`bin/judgment-import.js`;
`--migrate-goal` when it lands). The registry rows name THOSE, never internal
functions. Any direct maintenance entry point to `regenerateProjections` outside
that set either gets a registered typed surface or is closed — no anonymous regen.

Blueprint carries this table forward; registration itself lands in COMP-CANON-GUARD
S1/S4. Until then: regen-overwrite + roundtrip guard, stated as the actual protection.

## Slices

| Slice | Contents | Gate |
|---|---|---|
| S1 | `contracts/judgment-record.schema.json`: person / situation_entity / goal_version defs + shared fact/clause sub-schemas; `migration` provenance class; `intent_id` field; validation tests | schema tests green |
| S2 | `RecordsStore`: people/situation aggregates, parameterized chain accessor (`v<N>`); store tests | store tests green |
| S3 | Writer ops: person + situation (+ invariants 1, 2, 5, 6); writer tests | writer tests green |
| S4 | Writer ops: goal cut + wording correct (+ invariants 3, 4, 7); writer tests | writer tests green |
| S5 | Projections (people, SITUATION, OBJECTIVE dual-read helper) + orphan-scan extension + intent-aware snapshot hook + `get_judgment_state.counts`; gen tests | fixed-point + overwrite tests green |
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
- [ ] `OBJECTIVE.md` renders from the legacy position until migration (dual-read helper test with a synthetic goal chain)
- [ ] Full suite green; MCP e2e exercises all three tools; policy test asserts reviewer denial for all three
- [ ] `get_judgment_state.counts` matches the typed shape and stays small (AUDIT-19)

## Open questions

None blocking. Parked (owner, later): dossier consent/privacy for non-consenting cast
members (seq 107, product question); read-half feeder fencing (integrations, seq 114);
canon-registry registration timing rides COMP-CANON-GUARD sequencing.
