# COMP-JUDGMENT-WRITER — Typed Writer + Provider Seam for Judgment Canon (design)

**Status:** DESIGN — Phase 1 (grounded by three exploration reports, 2026-07-22)
**Parent epic:** [COMP-CANON-GUARD](../COMP-CANON-GUARD/design.md) — this is epic slice S3, carved as its own feature
**Implements:** `TOOLS-OWN-WRITES`, `MARKDOWN-EMITTED`, `PROVIDER-SEAM` (first consumer), Decision 3 of the epic (as amended: v1 agent-only)
**Owner rulings folded in (2026-07-22, `docs/judgment/LEDGER.md` session 3):** `oq1-agent-only-v1`, `judgment-writer-provider-records`, `instrument-now-product-later`

## Related Documents

- Claims implemented: [What To Build §8k](../../product/2026-07-20-what-to-build-vision.md) — `TOOLS-OWN-WRITES` (names the four tools), `MARKDOWN-EMITTED`, `PROVIDER-SEAM`, `ONE-WAY-WRITES`, `LIFECYCLE-VS-SEMANTICS`, `CANON-IS-GATED`
- Operational surface: [Judgment Layer — Process Manual](../../design/2026-07-20-judgment-layer-process-manual.md) — P1–P7 are the write-operation inventory
- Parent epic: [COMP-CANON-GUARD design](../COMP-CANON-GUARD/design.md) — enforcement (S4–S6) is deliberately NOT here
- Contract: `contracts/judgment-record.schema.json` *(new — created in W1, first implementation step)*
- Convergent sibling: `SmartMemory/smart-memory-docs/docs/features/MAYA-GROUNDED-SELF-1/design.md` — filed the same day, independently; reaches the same core substrate (decision-as-position, DS confidence, challenge wiring) from the conversational side and co-signs Decision 7's ontology RFC. Its §9 maps the overlap.

---

## Problem

Judgment canon (`docs/judgment/**`) is the highest-value, worst-protected store in the repo: 88% of its commits carry no tool involvement (epic S0 mining), and every recorded judgment-layer failure — duplicated register, undecided-recorded-as-decided, agent claim wearing the owner's tag — arrived through hand-authored markdown. The parent epic ruled the fix (a validating writer); the owner ruled the substrate (provider records, not markdown); this feature builds it.

## Goal

A small typed tool surface (five write tools — the four §8k-ruled names plus `judgment_position_amend` — and one read tool) becomes the only legitimate write path to judgment canon. Records are canonical and git-tracked; the markdown files humans read become generated projections; provenance is stamped by the writer and unforgeable through the tool surface. SmartMemory lights up as the capability-rich layer without ever becoming a second canon.

**Not the goal:** enforcement (hooks, guards — epic S4–S6), owner-attributed writes (OQ1 ruling: v1 agent-only), semantic truth-checking (`STRUCTURE-NOT-TRUTH`), the ideabox/provider migration (COMP-PLAN-IDEA-UNIFY).

---

## Grounding (three exploration reports, 2026-07-22 — all claims below carry file:line evidence in the reports)

**Compose writer mechanics.** `lib/journal-writer.js` is the whole-cloth template: transport-free `(cwd, args)` writer, mkdir advisory lock for counters, atomic `tmp.${pid}`+rename writes, compensating rollback on multi-file writes, typed `err.code`/`err.cause` that survive the MCP boundary, best-effort audit append AFTER commit, small typed results (AUDIT-19: never full document text). Consume as-is: `lib/idempotency.js`, `lib/feature-events.js#appendEvent`, `server/schema-validator.js` (Ajv), `server/project-root.js#getTargetRoot`. Two traps: `roadmap-gen.js:525` writes non-atomically (do not copy); MCP `inputSchema` is advisory — the writer must self-validate against the contract schema.

**Provider seam precedent.** The checkpoint-store registry (`lib/checkpoint/store/index.js`) is the closer template (over `lib/tracker/`): method-granular `capabilities()` consumed opportunistically at call sites, config-keyed backend selection, and a pre-registered `'smartmemory'` seam. Conformance-suite pattern exists (`tests/tracker/conformance.js`).

**The gitignore finding (deviation from the substrate ruling's expectation).** The ruling expected the local floor to implement over the vision store's types. The vision store lives at `.compose/data/vision-state.json`, which is **gitignored** — as is every store-like thing in Compose (`feature-events.jsonl`, checkpoints, settings). But P7 postmortems require reading the register *as it stood at the time* via git history: **canon must be committed**. The only committed-record precedent is `docs/features/<CODE>/feature.json`. The floor therefore follows the `feature.json` precedent (tracked JSON under `docs/`), not the vision store. This is a recorded deviation for owner ratification, not silent drift.

**SmartMemory reality.** `procedural` is a real memory kind in code (with stores and evolvers) — the workflows-under-procedural idea has a native home. Managed types (`decision`, `opinion`, `evaluation`, `learned`, …) are stamped from a framework; `decision` already carries `rejected_alternatives`, `rationale`, reserved `confidence` with reinforce/contradict math, supersession lifecycle — a *position* in all but name. `question`/`thread`/`idea` types do **not** exist. Adding `position` + `joint` as managed types is small-code (~4 touchpoints each, template: `learned/declaration.py`) but is a **core release**, not an API call. `conviction` must map onto the reserved `confidence` field. `challengeable=True` is declared-but-unwired. `EvaluationEvolver` computes per-(agent, dimension, domain) calibration from decision/opinion history — P7's calibration target already exists. Workspace-per-product is one API call (`POST /memory/teams`); the blessed external integration is the HTTP client (Maya subclasses it); Compose's workspace→SmartMemory key bridge already ships (`lib/smartmemory-config.js#resolveProjectTag`).

---

## Decision 1: In v1, canon is the tracked floor provider — provider-primary canon deliberately not foreclosed

*(Reworked after gate round 1, finding 1 — the original wording made git-canon permanent, which reversed `PROVIDER-SEAM` rather than implementing it.)*

*(Re-reworked after gate round 2, finding 1 — the round-1 "mirror" framing still put two stores in the write path, which violates one-canon.)*

The seam is a **real provider contract** — records + lifecycle events + capability discovery — with **exactly one configured canon provider**; tools front it, projections emit from it, and switching canon providers is a one-time import, never a live sync (all per the ruling, verbatim). v1 ships one canon provider: the tracked floor. There is no mirroring:

> **The configured provider is the only canon. v1's configured provider is the floor (git-tracked records under `docs/`). The W4 SmartMemory integration is NOT a second provider and NOT canon — it is an enrichment *emitter* (the shipped `feature-events` fail-open pattern) plus a capability surface. If a future SmartMemory canon provider is built and the owner switches to it, the floor stops being written, the switch is a one-time import, and committed projections carry the P7 git-history requirement from then on.**

What P7 actually requires is *the register's state at any past commit* — committed records satisfy it today; committed projections would satisfy it after a canon switch. The floor's tracked home follows the `feature.json` precedent (not the gitignored vision store) — that deviation stands on the gitignore evidence and needs owner ratification at this gate.

## Decision 2: Storage layout — records under `docs/judgment/records/`, projections beside them

```
docs/judgment/
  records/
    positions/<slug>/r<N>.json # append-only revision chain per position; highest N is current
    joints/<slug>.json         # one file per joint; state lives here
    predictions/<id>.json      # spawned by CONSTRUCT/commit events; status open|graded
    evidence/<id>/             # immutable raw-source packages (Answerer slice writes these — see joint contract)
    ledger.jsonl               # append-only events
  REGISTER.md                  # projection of joints/
  LEDGER.md                    # projection of ledger.jsonl
  OBJECTIVE.md                 # projection of positions/objective/
  positions/<slug>.md          # projections of position chains (current revision + history block)
```

**Positions are append-only revision chains** *(round 3, finding 6 — `supersedes: <slug@rev>` was unrepresentable with one mutable file per slug)*: every change — supersession, scoped amendment, retraction — is a new immutable `r<N>.json`; nothing is ever mutated in place; `supersedes` references `<slug>#r<N>` which is now a real address. One mechanism replaces three (versioning, amendment, supersession), and `judgment_position_amend` becomes "new revision whose delta is restricted to grounding/conviction".

All tracked. Per-record JSON files keep diffs reviewable and match the `feature.json` precedent; the ledger is a JSONL stream because it is an event log. **Append-only honesty** *(round 2, finding 9 — the draft overclaimed)*: the stream makes the *projection* layer tamper-pointless (`LEDGER.md` edits are overwritten by regen), but at S3 the stream itself is protected only by writer convention — nothing here stops a direct edit to `ledger.jsonl`. Epic OQ4 (append-only *enforcement*) stays open at the parent until S5/S6 attestation; this feature narrows it, it does not dissolve it. Projections regenerate to a fixed point (regen of own output is a no-op — the `roadmap-gen` invariant, enforced by a roundtrip guard before commit).

**Curated prose becomes `note` records — preserved sections are rejected.** *(Reworked after gate round 2, finding 5: the roadmap-preservers pattern reads marker blocks back from the existing projection, which makes the projection an input — a hand-edit inside markers would survive regeneration, quietly reintroducing the second writer this feature exists to kill.)* Hand-authored banners and notes (the REGISTER scaffolding banner, the reading-ceiling notes) are imported as typed `note` ledger/annotation records with a placement anchor (`register-header`, `joint:<slug>`, …); projections render them from records like everything else. **Projections are pure output, no exceptions** — the regen reads only records, and the acceptance criterion "any hand-edit is overwritten" holds with no marker carve-out. New curated prose is written the same way canon is: through a tool.

**Joint state machine — every edge bound to its required artifact** *(round 3, finding 2 — states and outcomes were independently writable; now each edge names the exactly-one outcome/package it must carry, per P3's "every resolution ends in exactly one outcome")*:

| Edge | Required artifact |
|---|---|
| `open → under_test` | method gate: `EXT` → `ext` package (or judgment-dispatch mode, below); `STRADDLE` → `straddle` package; others → none |
| `under_test → resolved` | `resolution { outcome: resolved, evidence }` |
| `under_test → inconclusive` | `resolution { outcome: inconclusive, learned, would_have_settled }` |
| `under_test → open` | ONLY via `resolution { outcome: failed_to_run, reason }` — a free return edge does not exist |
| `open \| under_test → superseded` | `resolution { outcome: superseded, why }` (terminal) |
| `open \| under_test → dissolved` | `dissolution { decomposed_into[] }` — its own artifact kind, NOT a resolution: the manual's P3 outcome list is exhaustive at four, and the register already treats "dissolved by decomposition" as a distinct fact from "got an answer" (terminal) |
| `resolved → open` | reopen `{ shaken_evidence_ref }` (P6) |
| `inconclusive → under_test \| open` | **re-dispose** `{ new_resolve_by, new method package }` — audited transition input, atomically emits its ledger note *(round 3, finding 3 — P3 explicitly allows retrying with a different method; this is the operation)* |

Resolution outcome enum stays exactly the ruled four: `resolved | inconclusive | failed_to_run | superseded` *(round 4, finding 1 — round 3 had wrongly widened it; dissolution carries its own `dissolution` artifact instead)*. Any edge not listed is refused.

## Decision 3: Record shapes (the contract)

`contracts/judgment-record.schema.json`, definitions per kind. Every record carries a writer-stamped provenance block the caller can never set:

```
provenance: { actor: 'agent',            // v1 constant (OQ1 ruling); 'owner' only via { via: 'import' } or future override
              session: <id|null>, written_at: <iso>, via?: 'import' }
```

**`session` is best-effort and nullable, stated now so it is not assumed later.** The MCP server is a long-running process separate from any Claude session; a session id reaches it only if present in the server's own environment. This is the same cross-process reality that broke the parent epic's `build_id` correlation — the reliable, load-bearing stamps are `actor` and `written_at`; `session` is diagnostic garnish and nothing may depend on it.

*(Shapes reworked after gate round 1, findings 4–7 and 9.)*

- **position** — `slug`, `claims[] { id, text, grounding: EXT|INT|ASSERT|DERIVED|AGENT, supports[] }` (**claims are individually addressable with per-claim grounding and upward links** — P1a steps 3/6; P5 walks these, P6 downgrades one grounding without touching siblings), `conviction { level: high|medium|low, source: stated|inferred }`, `rejected_alternatives[] { what, why }`, `supersedes?: <slug>#r<N>`, `retracted?: true` (tombstone revision). **Status is derived, never stored** *(round 4, finding 2 — a stored status would force mutating an immutable revision at supersession)*: a chain is `superseded` iff a live revision elsewhere names it in `supersedes`; `retracted` iff its own latest revision is a tombstone; `live` otherwise. Readers and projections compute it; the reference form is `<slug>#r<N>` everywhere.
- **joint** — `slug`, `question`, `branch_true`, `branch_false` (both REQUIRED), `resolve_by: EXT|INT|CONSTRUCT|ASSERT|STRADDLE`, `cost: hours|days|weeks|months` (**exactly the ruled `COARSE-BUCKETS` — no `minutes`**; the import maps the register's existing `minutes` entries to `hours` with a note), `rank: high|medium`, `state` (graph below), `resolution`, `flags[]`. **Method-specific gates, now structural** *(round 2, finding 4 — the full ruled P3/external-signal contract, not a subset)*:
  - `EXT` requires, before `under_test`, EITHER `ext { sharpened_question, bar, falsifier }` OR the ruled `BAR-OR-JUDGMENT` exception *(round 3, finding 4)*: `ext { judgment_dispatch: true, reason }` for joints that cannot honestly be sharpened — the stamp propagates permanently into any resolution built on it. An `EXT` resolution carries the ruled result package `{ outcome: FOUND|CONTRARY|SILENT|UNREACHABLE, sources[] (addresses into records/evidence/), search_record, found_or_provoked, judgment_not_evidence }`; `SILENT` may only yield the joint outcome `inconclusive`. **Sequenced dependency, stated plainly** *(round 3, finding 5)*: `sources[]` must address immutable `records/evidence/` packages (raw fetched content + search record, per the external-signal contract), and the evidence-package writer ships with the Answerer slice of the external-signal design — not here. Until the Answerer exists no `EXT` resolution can occur at all (nothing produces one), so its write path being absent from W1 is sequencing, not a gap; the schema fields and refusal rules ship now so the first Answerer write lands validated.
  - `STRADDLE` requires `straddle { discriminating_signal, kill_criteria }` before `under_test` (`STRADDLE-NEEDS-SIGNAL`, `KILL-CRITERIA-FIRST`).
  - Resolution `outcome` is the manual's full four-way vocabulary: `resolved | inconclusive | failed_to_run | superseded` — a test that never ran and a test that answered nothing are different facts, and the schema refuses to conflate them.
- **prediction** *(new record kind — closes the P6.7/P7-trigger-3 hole)* — `id`, `text`, `outcome_criteria`, `made_at`, `context: construct|commit`, `refs[]`, `status: open|graded`, `grade?: right|right-wrong-reason|wrong`. Written by the writer as a side-effect of the ledger events that the manual says must carry predictions; **the P6 sweep queries `status: open` instead of re-reading prose** — a prediction nobody can find is a prediction nobody made.
- **ledger event** — `kind: decide|kill|override|escalate|calibrate|postmortem|rank|note|correct|open`, common fields `title|body|refs[]`, **plus kind-specific REQUIRED fields** (the validating-writer premise is these, not the common envelope): `decide` requires `rejected[]` + `conviction`; a commit-moment `decide` requires `trigger: earned|forced|exhausted` + `open_joints[]` (may be empty only for `earned`) + `prediction { text, outcome_criteria }` — the conviction claim P7's trigger 3 later grades, spawning `records/predictions/<id>.json` *(round 3, finding 10: the spawn now has explicit inputs and a home)*; a `CONSTRUCT`-disposition event requires an embedded prediction (spawning the prediction record); `postmortem` requires `trigger`, `recall_verdict: NAMED|NAMED-BUT-MISRANKED|MISSED|UNKNOWABLE`, `attribution` (question-type-scoped), and `prediction_grade` when a prediction ref exists (grading flips the prediction record to `graded`); `override` requires a non-empty `reason`. Append-only; no update tool exists.

**Deflected from round 1 (finding 5, in part):** position *ranking* and commitment *state* do not become stored fields. The manual treats both as acts of judgment recorded in the ledger (P2.5, P4.3–4); the current canon stores neither; "do not add structure until a process demands it" is the manual's own rule. Candidate revival likewise: a kill is a ledger event, a revival is a new ledger event referencing it — events, not a candidate-pile store.

**The ASSERT problem, reworked after gate round 1, finding 3 — which caught the original design making manual mode unrunnable.** The draft banned `[ASSERT]` grounding on all tool writes (per the OQ1 v1-agent-only ruling as first encoded). But P1a step 3 *requires* marking claims `ASSERT` when the owner asserts them, and the agent transcribing an owner statement made in-session is the normal manual-mode path — the entire existing ledger is exactly that. A total ban makes the golden flow and the anti-lockout criterion unsatisfiable until the epic's S4 override exists. Corrected design, preserving the ruling's spirit (no *unaudited* owner-authority claims) while restoring the process:

> - `grounding: ASSERT` on a claim IS writable through tools, **only when the record carries a required, structured `elicitation` block**: `{ asked, answered_at, answer_ref }` — what question was put to the owner, when, and where the answer is recorded (conversation quote or ledger ref). Transcription-with-citation, auditable after the fact; a bare `ASSERT` with no elicitation block is rejected.
> - `[owner-locked]` (amendment-blocking authority) remains **unrepresentable through tools** — import (`via: 'import'`) or the epic's future override only. The 2026-07-21 failure class was authority-laundering; this is the tag that carries authority.
> - `resolve_by: ASSERT` (a joint resolved by owner's call) is a resolution method and legal as before — but its resolution evidence must likewise carry the elicitation block.

**This amends the letter of the `oq1-agent-only-v1` ruling (actor stays `agent`; what changes is that cited owner-attributed grounding becomes representable) and is flagged for owner ratification at the design gate.** Round 2's reviewer correctly notes the design cannot self-approve this — it is the gate's first question, and both branches are specified: **if ratified**, the elicitation-block contract above ships in W1; **if declined**, `ASSERT` grounding waits for the epic's S4 override, the golden flow is scoped to non-`ASSERT` paths, and manual mode keeps hand-writing owner assertions in the interim (the known failure mode, accepted knowingly until S4). The design is implementable either way; only the golden-flow scope changes.

## Decision 4: Tool surface — the four ruled tools plus one read tool

Derived from the process manual's write inventory (P1–P7), not invented; names are owner-locked in §8k:

| Tool | Covers (manual) | Notes |
|---|---|---|
| `judgment_position_create` | P1a 1–7, P1b 3 | Also position supersession via explicit `supersedes: <slug>#r<N>` on the new revision — the old chain is never touched; its superseded status is derived by readers (round 4, finding 2) |
| `judgment_joint_add` | P1a 7, P2 1–4 | Validator enforces both branches + cost |
| `judgment_transition` | P2 6, P3 outcomes, P6 reopen | Joint state machine — **single lifecycle authority, selected by config, never two** (round 1, finding 2): where `capabilities.guard` is true (it is here; adapter `server/lifecycle-guard.js` is fail-closed), the Stratum guard IS the authority — graph `guard_register`ed, `judgment_transition` calls `guard_transition`, record `state` is the transition's artifact. **Guard/record split handled by intent-first write + replaying reconciler** (round 2 finding 2; hardened by round 3 finding 1 — repairing `state` alone would resurrect a resolved joint without its resolution package, rank event, or prediction): the writer persists the COMPLETE mutation as a `pending-intent` record (atomic tmp+rename) BEFORE calling `guard_transition`; on verdict it applies the mutation and clears the intent; the reconciler, on every judgment write and on `get_judgment_state`, replays any incomplete intent idempotently — guard state authoritative for the edge, the intent authoritative for the payload — so recovery restores the whole mutation, never a bare state flip. Divergence is surfaced in the result either way. Only where guard is absent does the writer's own identical state machine enforce — kept deliberately (a hard Stratum requirement would raise the floor for every user, the `BUNDLE-IS-SUGAR` argument; flagged as a scoped limit, not silent drift). ONE-UNDER-TEST: guard predicate if expressible, else writer under advisory lock, and the population-invariant contribution is filed upstream in Stratum's tracker either way. **Rank changes are transition inputs and atomically emit the required `rank` ledger event in the same locked operation** (round 2, finding 7 — closes former OQ3: P2.5's "record what decided it" cannot be bypassable) |
| `judgment_position_amend` | P6 5 (`SHAKE-GROUNDING`) | Scoped amendment: may downgrade a single claim's `grounding` or update `conviction` — may never touch claim text, branches, or rejected alternatives (those are supersession). Added on gate round 1, finding 5: the sweep needs grounding-downgrade *now*, not after supersession proves too heavy (this closes former OQ2) |
| `judgment_ledger_append` | P1b 5–6, P3 records, P4 2–4, P5 1, P7 5 | Append-only; enforces kind-specific required fields (Decision 3); spawns/grades prediction records as a writer-internal side-effect |
| `get_judgment_state` *(read)* | session load, P6 sweep | Register + under-test + open predictions + recent ledger, small result (AUDIT-19) |

*§8k names four write tools as the ruled minimum surface, not a maximum; `judgment_position_amend` is the fifth, added with the P6 write-inventory evidence above.*

**Policy (`server/mcp-tool-policy.js`):** write tools stay implementer/orchestrator-only (default deny covers reviewers); `get_judgment_state` is added to `REVIEWER_ALLOW`. Rationale: review findings become judgments *through the orchestrator's adjudication*, preserving the epic's provenance chain — a reviewer writing canon directly would be a second unattributed author. Revisit if adjudication proves to be a bottleneck.

**Gap accepted, named:** P2's re-rank (high↔medium) is a joint mutation with no dedicated tool; v1 folds it into `judgment_transition` (`rank` change is a legal transition input). The manual's P6 sweep and P7 postmortems write only ledger events — covered.

## Decision 5: The provider seam — checkpoint-store shape, enrichment capabilities

*(Reworked after round 3, finding 7 — the draft registered `'smartmemory'` behind the canon-selecting factory while calling it "not a provider", an internal contradiction.)* Two config keys, two different things, never conflated:

- **`judgment.provider`** — canon store selection, `lib/judgment/store/index.js`, checkpoint-registry shape. v1 registers exactly one implemented backend: `'records'`. `'smartmemory'` appears only as the checkpoint-precedent stub throwing `NOT_IMPLEMENTED` — it becomes selectable only if/when a full canon store contract is implemented and the owner rules the switch (Decision 1's one-time import).
- **`judgment.enrichment.smartmemory`** — the W4 emitter + capability surface, orthogonal to provider selection, additive over whichever canon provider is configured. `capabilities()` is method-granular (`challenge`, `calibration`, `semanticRecall`, `convictionDynamics`), consumed opportunistically (the `reconciler.js:150` pattern). Transport: the HTTP client, Maya's precedent; fail-open like the existing feature-events emit. **Workspace identity, not name** *(round 3, finding 9)*: W4 creates the team once, persists the service-returned `team_id`, and uses THAT — never the `resolveProjectTag` slug — on requests and in OKF resource URIs (the bridge compares URI workspace to the configured id exactly); the project tag is only the requested display name.

## Decision 6: The import, and the only sanctioned owner-tag path in v1

One-time importer parses current `REGISTER.md`, `LEDGER.md`, `positions/*.md`, `OBJECTIVE.md` into records, stamping `provenance.via: 'import'` and preserving existing `[owner-locked]`/`[ASSERT]` grounding (import is historical transcription, not new authorship). After import: regenerate all projections, human-diff against the hand-written originals, commit records + projections together. From that commit forward the markdown is generated. The importer is `bin/`-side, run once, kept for provider migrations (`PROVIDER-SEAM`: switching is a re-import, never a sync).

## Decision 7: SmartMemory ontology RFC — filed in SmartMemory's repo, two independent items

1. **`position` + `joint` managed types.** Small-code per the framework (`learned` template, ~4 touchpoints each); `conviction` maps onto reserved `confidence`; `challengeable=True` noted as declared-but-unwired (challenge integration is not free and is not claimed). Until it ships, the enrichment layer may interim-map `position → decision` (which already carries `rejected_alternatives`, `rationale`, confidence, supersession) inside a Compose-owned workspace — zero-core-change, explicitly temporary.
2. **`workflow` as a procedural-memory managed type.** Separate consumer (Maya's hat ladder, eventually the process manual itself), separate timeline; rides the same framework. Fields sketch: name, trigger, steps, preconditions, provenance, track-record hooks for calibration. Not consumed by this feature — filed so the ontology grows coherently.

3. **`smartmemory-obsidian`: `ingestFile` honors `reference: true`** (skip, never rewrite frontmatter) — small bridge change; what makes the Decision 8 exclusion guard real for vault-overlapping setups (round 3, finding 8).

All three are SmartMemory roadmap items (owning repo per house rule); W1–W3 of this design depend on none of them.

## Decision 8: Projections speak OKF (owner ruling 2026-07-22 — reverses `note: okf-set-aside`)

Per-item projections are emitted as **Google Open Knowledge Format v0.1** markdown, the dialect SmartMemory's Obsidian bridge already speaks (`smartmemory-obsidian/src/bridge/okf.ts` — codec, resource URIs, bundle rules verified against code and fixtures):

- `positions/<slug>.md` (and `OBJECTIVE.md`) carry OKF frontmatter: `type`, `title`, `timestamp`. **`resource` is emitted only once a real provider id exists** *(round 2, finding 8 — the bridge treats the URI's item component as the actual SmartMemory item id, and SmartMemory's framework generates ids server-side, so a made-up `<kind>.<slug>` resource would be a dangling identity claim)*: records gain `provider_ids { smartmemory?: <id> }`, populated by the W4 emitter from the service's returned id; projections without one omit `resource` (nullable in the codec) and are still valid typed OKF. Item ids are single path components — the codec rejects `/` (`okf.ts:52-54`).
- `docs/judgment/` becomes an OKF bundle: a generated `index.md` (bundle root, `okf_version: "0.1"`) linking the projections. `REGISTER.md`/`LEDGER.md` keep their names and human-first aggregate shape — OKF is per-item; aggregates are not force-fitted.
- **Two-source guard, reworked after gate round 1, finding 8 — the original guard relied on upsert semantics that do not exist.** Codex verified against the actual Obsidian ingest (`ingest.ts:183,212`): on content change it *deletes the referenced item and ingests a new one with a new server id* (no server-side dedupe), and it *rewrites the note's frontmatter* — which on a generated projection would break the fixed-point invariant. The guard is therefore **exclusion-based, not upsert-based** — and round 3 (finding 8) verified the exclusion cannot be config-only either: the bridge never checks `reference`, folder exclusions apply only to bulk folder ingest, and single-file/auto ingest rewrites frontmatter (which would break the fixed-point invariant). So the honest v1 posture: projections stamp `smartmemory: { reference: true, origin: 'compose-projection' }` as declarative intent; the compose repo is not an Obsidian vault, so no ingest path touches these files in normal operation; **the actual enforcement — `ingestFile` skipping `reference: true` notes — is a sibling `smartmemory-obsidian` change, filed as RFC item 3 in Decision 7 and a W4 exit condition for any setup where a vault overlaps the repo.** Until it ships, the user-facing docs state the limitation plainly. No design claim depends on ingest honoring `resource`.
- **Workspace naming (same finding):** the bridge ignores resources whose workspace differs from its configured SmartMemory workspace, and `resolveProjectTag` yields a Compose-local tag. W4 must provision/name the SmartMemory workspace to match the resource-URI workspace component — one name, chosen once, used by both.
- Payoff: Obsidian views judgment canon natively (read-only); the W4 enrichment layer reuses the same resource identities end to end — one naming scheme from record to memory.

Scope line: OKF applies to judgment *projections* only. Records stay JSON (canon, schema-validated); ROADMAP/CHANGELOG are aggregates and stay out; design docs are prose and stay out.

---

## Slices

| Slice | Content | Gate |
|---|---|---|
| W1 | Schema + records store + `judgment-write-guard.js` + `judgment-writer.js` + projections (OKF per Decision 8, incl. bundle `index.md`) + golden test | Golden flow: P1→P7 via writer API only, projections regenerate fixed-point; per-item projections parse under the OKF codec's rules (frontmatter fence, required `type`, valid `resource`) |
| W2 | 6 MCP tool entries (5 write + 1 read) + policy entries + MCP e2e tests | Manual mode's judgment-canon writes runnable end-to-end through the judgment tools (anti-lockout); P4.5 crystallization explicitly uses the existing Compose feature writer — the golden flow asserts the handoff, not a judgment-tool reimplementation; forbidden-tag write rejected |
| W3 | Importer + cutover commit (records + regenerated projections together) | Human diff of generated vs hand-written markdown approved; post-cutover hand-edit to a projection is overwritten by next regen |
| W4 (fast-follow) | SmartMemory enrichment backend (HTTP client, workspace provisioning, fail-open emit) + both RFC items filed in SmartMemory repo | `capabilities()` reports enrichment; floor behavior byte-identical with backend unconfigured |

## Files

| File | Action | Purpose |
|---|---|---|
| `contracts/judgment-record.schema.json` | new | Record shapes + provenance block (W1, first step) |
| `lib/judgment-write-guard.js` | new | Pure leaf validator (feature-write-guard shape): schema + branch/tag/state rules |
| `lib/judgment-writer.js` | new | Typed writer (journal-writer template): lock, atomic writes, rollback, audit append, ONE-UNDER-TEST |
| `lib/judgment-gen.js` | new | Projections: records → REGISTER/LEDGER/OBJECTIVE/positions markdown, fixed-point |
| `lib/judgment/store/index.js` | new | Provider registry (checkpoint-store shape) + capabilities |
| `server/compose-mcp.js` | modify | 6 TOOLS entries + dispatch cases (5 write + 1 read) |
| `server/compose-mcp-tools.js` | modify | 6 thin shims (getTargetRoot + lazy import) |
| `server/mcp-tool-policy.js` | modify | `get_judgment_state` → REVIEWER_ALLOW |
| `bin/judgment-import.js` | new | One-time markdown → records importer (W3) |
| `test/judgment-writer.test.js` | new | Unit/golden (node:test, freshCwd pattern) |
| `test/judgment-writer-mcp.test.js` | new | E2E via McpClient + COMPOSE_TARGET |

## Acceptance criteria

- [ ] `contracts/judgment-record.schema.json` exists; writer validates every write against it (MCP inputSchema is not the enforcement)
- [ ] Records live under `docs/judgment/records/` and are git-tracked; `git log` shows register state at any past commit (the P7 requirement)
- [ ] All four §8k tool names ship; no tool can set any `provenance` field; `actor` is `agent` on every tool write
- [ ] `grounding: ASSERT` without a structured `elicitation` block is rejected; with one it persists; `[owner-locked]` through any tool is rejected naming the import/override paths; `resolve_by: ASSERT` requires the elicitation block in its evidence
- [ ] With `capabilities.guard` true, `judgment_transition` routes through `guard_transition` (fail-closed) and the record's `state` is written only as the transition's artifact; with guard absent, the writer enforces the identical graph — a contract test asserts both resolve the same legal-edge set
- [ ] ONE-UNDER-TEST enforced (guard predicate if expressible, else writer under advisory lock); the Stratum upstream population-invariant contribution is filed either way
- [ ] A joint without both branches, or without a cost bucket, is refused; `cost` vocabulary is exactly `hours|days|weeks|months`
- [ ] An `EXT` joint without `ext { sharpened_question, bar, falsifier }` cannot enter `under_test`; a `SILENT` result cannot produce `resolved`
- [ ] Ledger kind-specific required fields enforced: commit-`decide` without `trigger`+`open_joints`, `postmortem` without `recall_verdict`+`attribution`, `CONSTRUCT` event without its prediction, `override` without `reason` — all rejected
- [ ] Predictions are queryable: `CONSTRUCT`/commit events spawn `prediction` records; `get_judgment_state` lists `status: open` predictions; a `postmortem` with `prediction_grade` flips the record to `graded`
- [ ] `judgment_position_amend` creates a new revision whose delta is restricted to grounding/conviction; claim-text deltas are refused (supersession path named in the error); position revisions are immutable once written
- [ ] Every transition edge carries its bound artifact or is refused; an interrupted transition (guard advanced, apply failed) is fully recovered by intent replay — payload included, verified by a kill-between-steps test
- [ ] An `EXT` joint may enter `under_test` via sharpened package or judgment-dispatch stamp, nothing else; the stamp propagates into resolutions
- [ ] `judgment.provider` and `judgment.enrichment.smartmemory` are independent config keys; selecting `'smartmemory'` as provider throws `NOT_IMPLEMENTED` in v1
- [ ] Projections regenerate to a fixed point; a hand-edit to any projection is overwritten by the next regeneration; the roundtrip guard blocks non-fixed-point commits
- [ ] Ledger has no update/delete surface; `LEDGER.md` is a projection of `ledger.jsonl`
- [ ] Golden flow: P1→P7 of the process manual executed end-to-end against a real temp workspace, all judgment-canon writes through the six judgment tools only; P4.5 crystallization asserted as a handoff to the existing feature writer (anti-lockout)
- [ ] Import round-trip: current hand-written canon → records → projections, human-approved diff, single cutover commit
- [ ] With `judgment.provider` unset, behavior is floor-only and byte-identical to no-seam; `judgment.provider` is the ONLY canon-selector key (round 4, finding 3); `'smartmemory'` as provider throws `NOT_IMPLEMENTED` (checkpoint-store precedent)
- [ ] Writer results are small typed objects (AUDIT-19); errors carry `code`/`cause` through the MCP boundary
- [ ] A failure mid-write (record persisted, projection regen fails) rolls back via the journal-writer compensating pattern and surfaces `JUDGMENT_PARTIAL_WRITE` with `cause`
- [ ] Reviewer profile: write tools denied, `get_judgment_state` allowed (policy test)

## Open questions

**None. Both gate questions were ruled 2026-07-22** (`LEDGER.md` session 3):

1. ~~Floor home~~ — **RATIFIED by delegation** (`decide: judgment-records-under-docs`): `docs/judgment/records/`, on the git-history/precedent/sandbox evidence.
2. ~~ASSERT amendment~~ — **RATIFIED** (`decide: assert-elicitation-amendment`): elicitation-cited `ASSERT` ships in W1; `[owner-locked]` stays locked out; the declined-branch scoping is moot.

*(Former OQ2 — scoped position amendment — closed by gate round 1, finding 5: `judgment_position_amend` is in scope. Former OQ3 — automatic rank events — closed by gate round 2, finding 7: rank mutation and its ledger event are one atomic operation.)*

## Review history

**Gate round 1 (2026-07-22, Codex `gpt-5.6-sol/xhigh`, design-level adversarial pass): 9 findings — 7 P1, 2 P2. Adjudication: 8 accepted (folded in above), 1 partially deflected with evidence.**

1. P1 storage model reversed `PROVIDER-SEAM` → **accepted**; Decision 1 narrowed to v1-only, provider-primary canon left to a future owner call.
2. P1 dual lifecycle authority → **accepted**; guard-first where enabled (fail-closed adapter verified at `server/lifecycle-guard.js:325`), writer-local only where guard absent, contract test for graph parity.
3. P1 owner assertions unrepresentable → **accepted**, the round's sharpest catch: the OQ1 encoding as drafted made the golden flow unsatisfiable. Fixed via elicitation-cited `ASSERT`; flagged for ratification.
4. P1 free-form ledger → **accepted**; kind-specific required fields (structural, not semantic).
5. P1 P6 inventory incomplete → **accepted in part** (prediction records, `supersedes`, `judgment_position_amend`); **deflected in part**: position-rank and commitment state stay ledger events, per the manual's own no-unneeded-structure rule and the absence of either in live canon.
6. P2 claims not addressable → **accepted**; positions restructured to `claims[]` with per-claim grounding and links.
7. P1 `EXT` amendment absent → **accepted**; sharpening gates and `SILENT→inconclusive` now structural.
8. P1 OKF guard contradicted by real ingest → **accepted**; the round's most instructive finding — the guard claimed upsert semantics the code doesn't have (design-by-assertion about a neighboring repo, the exact failure the parent epic documents five times). Guard is now exclusion-based with a W1 MUST-VERIFY.
9. P2 `minutes` vs ruled buckets → **accepted**; enum matches `COARSE-BUCKETS`, import maps existing `minutes` rows to `hours`.

**Gate round 2 (2026-07-22, same reviewer/config): 9 findings — 5 P1, 4 P2. Adjudication: 7 accepted, 1 accepted-in-part, 1 adjudicated as owner-gated rather than reviewer-clearable.**

1. P1 provider fix still violates one-canon → **accepted**; Decision 1 re-reworked — real provider contract, exactly one configured canon, W4 SmartMemory reclassified as emitter+capabilities (not a provider), future canon switch = one-time import with projections carrying git history.
2. P1 guard/record split unrecoverable → **accepted**; guard-authoritative reconciler (repair record guard-ward, never re-transition, surface divergence). Writer-local fallback for guard-absent workspaces **kept in part** with the `BUNDLE-IS-SUGAR` argument, as a named scoped limit.
3. P1 ASSERT remedy overturns the owner ruling → **adjudicated as owner-gated**: the design proposes an amendment and now specifies both the ratified and declined branches; a reviewer cannot clear or fail a pending owner decision. Gate question 2.
4. P1 EXT/STRADDLE/P3 contract gaps → **accepted**; full ruled result package (`FOUND|CONTRARY|SILENT|UNREACHABLE`, raw sources, `JUDGMENT-NOT-EVIDENCE`, `found_or_provoked`), STRADDLE preconditions, four-way outcome vocabulary incl. `failed_to_run`.
5. P1 preserved sections = second writer → **accepted**, the round's best catch; preserved sections rejected outright, curated prose becomes typed `note` records, projections are pure output with no carve-outs.
6. P2 tool-count inconsistencies + P4.5 crystallization → **accepted**; six MCP entries everywhere, golden flow scoped to judgment-canon writes plus an asserted handoff to the existing feature writer.
7. P2 rank bypass of mandatory ledger record → **accepted**; atomic rank+event, closes former OQ3.
8. P2 OKF resource ids aren't provider ids → **accepted**; `provider_ids` field, `resource` emitted only when a real id exists.
9. P2 JSONL append-only overclaim → **accepted**; epic OQ4 stays open, claim narrowed to projection-layer tamper-pointlessness.

**Gate round 3 (2026-07-22, same reviewer/config, owner-gated items scoped out): 10 findings — 8 P1, 2 P2. All accepted; three resolved by narrowing scope rather than adding machinery. Finding counts across rounds (9, 9, 10) are not converging — per the convergence rule this is the signature of a broad spec, so round 4 is a verification pass and any non-clean result goes to the owner rather than another loop.**

1. P1 reconciler recovers state without payload → **accepted**; intent-first writes (complete mutation persisted before the guard call), reconciler replays intents idempotently.
2. P1 states and outcomes independently writable → **accepted**; edge→artifact table binds every transition to exactly one required outcome/package; `dissolved` added to the outcome enum; free `under_test → open` edge removed.
3. P1 inconclusive not re-disposable → **accepted**; re-dispose is an audited transition input carrying the new method package.
4. P1 `BAR-OR-JUDGMENT` branch missing → **accepted**; judgment-dispatch mode with permanent stamp propagation.
5. P1 raw sources have no write path → **accepted by sequencing**; `records/evidence/` layout + schema ship now, the evidence writer ships with the Answerer slice — no `EXT` resolution can exist before the Answerer does.
6. P1 supersession unrepresentable → **accepted**; positions become append-only revision chains (`<slug>/r<N>.json`), one mechanism for versioning/amendment/supersession.
7. P1 Decision 5 conflated provider and emitter → **accepted**; `judgment.provider` (canon) and `judgment.enrichment.smartmemory` (additive) are separate config keys; `'smartmemory'` provider stays a `NOT_IMPLEMENTED` stub per the checkpoint precedent.
8. P1 OKF exclusion fallback doesn't exist in the bridge → **accepted**; enforcement is a sibling `smartmemory-obsidian` change (RFC item 3); until then the limitation is documented, and no repo-side claim depends on bridge behavior.
9. P2 workspace name vs identity → **accepted**; persist and use the service-returned `team_id` everywhere; the project tag is a display name.
10. P2 commit predictions had no inputs/home → **accepted**; commit `decide` carries `prediction { text, outcome_criteria }`, `records/predictions/` added to the layout.

**Gate round 4 (2026-07-22, same reviewer/config, P1-only verification bar): 3 findings, all P1, all coherence defects introduced by the round-3 edits themselves — no new conceptual ground. All accepted. Convergence achieved: 9 → 9 → 10 → 3, with round 4's items purely editorial.**

1. `dissolved` wrongly widened the ruled four-outcome enum → dissolution is its own terminal artifact (`dissolution { decomposed_into[] }`), outcomes stay exactly four.
2. Stored `status` contradicted revision immutability → status is derived (supersedes-references / tombstone / live), never stored; reference form unified to `<slug>#r<N>`.
3. Stale `judgment.backend` key alongside `judgment.provider` → single canon-selector key, `judgment.provider`.

## Explicitly out of scope

Enforcement of any kind (epic S4–S6: hooks, guard registration of judgment paths, attestation); owner-attributed tool writes; challenge/calibration *consumption* (Maya/FOH); ideabox migration (COMP-PLAN-IDEA-UNIFY); building the SmartMemory managed types themselves (SmartMemory repo owns that RFC).
