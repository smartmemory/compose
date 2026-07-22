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

Four typed tools become the only legitimate write path to judgment canon. Records are canonical and git-tracked; the markdown files humans read become generated projections; provenance is stamped by the writer and unforgeable through the tool surface. SmartMemory lights up as the capability-rich layer without ever becoming a second canon.

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

In v1 the tracked floor is the **only provider that exists**, so it is the canon and the history substrate — no behavioral question arises. The design commitment is narrower than the original draft claimed:

> **v1: the floor provider (git-tracked records) is canon. A configured SmartMemory layer receives the same writes one-way (fail-open, after floor commit) and provides enrichment capabilities. Whether a future capability-rich provider may *become* canon — with committed projections carrying the P7 git-history requirement instead of committed records — is a provider-migration decision under `PROVIDER-SEAM`'s "one-time import" rule, owned by the owner, not decided here.**

What P7 actually requires is *the register's state at any past commit*, which committed records satisfy today and committed projections could satisfy later. The floor still follows the `feature.json` precedent (tracked under `docs/`, not the gitignored vision store) — that deviation stands on the gitignore evidence and still needs ratification, but it no longer smuggles in a permanent storage ruling.

## Decision 2: Storage layout — records under `docs/judgment/records/`, projections beside them

```
docs/judgment/
  records/
    positions/<slug>.json      # one file per position (objective is the position 'objective')
    joints/<slug>.json         # one file per joint; state lives here
    ledger.jsonl               # append-only events (decide/kill/override/escalate/calibrate/postmortem/rank/note)
  REGISTER.md                  # projection of joints/
  LEDGER.md                    # projection of ledger.jsonl
  OBJECTIVE.md                 # projection of positions/objective.json
  positions/<slug>.md          # projections of positions/
```

All tracked. Per-record JSON files keep diffs reviewable and match the `feature.json` precedent; the ledger is a JSONL stream because it is an event log, and append-only becomes *structural*: `LEDGER.md` edits are overwritten by regeneration, and the stream is the history (this dissolves epic OQ4 for the ledger). Projections regenerate to a fixed point (regen of own output is a no-op — the `roadmap-gen` invariant, enforced by a roundtrip guard before commit).

**Curated prose survives via preserved sections.** The current markdown carries hand-authored banners and notes (the REGISTER scaffolding banner, the reading-ceiling notes). Projections support `<!-- preserved-section: id -->` blocks using the exact marker regexes exported by `lib/roadmap-preservers.js` — the shipped pattern. The import wraps existing curated prose in markers; anything outside markers or record-derived sections is dropped at regen (that *is* the guarantee). Prose that turns out to be load-bearing belongs in a record's fields, not a marker block; the sweep can promote it.

**Joint state machine, edges enumerated:** `open ↔ under_test`; `under_test → resolved | inconclusive`; `open | under_test → superseded | dissolved`; `resolved → open` (P6 reopen on shaken evidence, evidence ref required); `inconclusive → open | under_test` (re-dispose). `superseded` and `dissolved` are terminal. Any edge not listed is refused by the validator.

## Decision 3: Record shapes (the contract)

`contracts/judgment-record.schema.json`, definitions per kind. Every record carries a writer-stamped provenance block the caller can never set:

```
provenance: { actor: 'agent',            // v1 constant (OQ1 ruling); 'owner' only via { via: 'import' } or future override
              session: <id|null>, written_at: <iso>, via?: 'import' }
```

**`session` is best-effort and nullable, stated now so it is not assumed later.** The MCP server is a long-running process separate from any Claude session; a session id reaches it only if present in the server's own environment. This is the same cross-process reality that broke the parent epic's `build_id` correlation — the reliable, load-bearing stamps are `actor` and `written_at`; `session` is diagnostic garnish and nothing may depend on it.

*(Shapes reworked after gate round 1, findings 4–7 and 9.)*

- **position** — `slug`, `claims[] { id, text, grounding: EXT|INT|ASSERT|DERIVED|AGENT, supports[] }` (**claims are individually addressable with per-claim grounding and upward links** — P1a steps 3/6; P5 walks these, P6 downgrades one grounding without touching siblings), `conviction { level: high|medium|low, source: stated|inferred }`, `rejected_alternatives[] { what, why }`, `supersedes?: <slug@rev>`, `status: live|superseded|retracted`.
- **joint** — `slug`, `question`, `branch_true`, `branch_false` (both REQUIRED), `resolve_by: EXT|INT|CONSTRUCT|ASSERT|STRADDLE`, `cost: hours|days|weeks|months` (**exactly the ruled `COARSE-BUCKETS` — no `minutes`**; the import maps the register's existing `minutes` entries to `hours` with a note), `rank: high|medium`, `state` (graph below), `resolution { outcome, date, evidence[] }`, `flags[]`. **`EXT` gates (the incorporated external-signal amendment, now structural):** an `EXT` joint requires `ext { sharpened_question, bar, falsifier }` before it may transition to `under_test`; an `EXT` resolution's evidence must carry source + reliability + search record; a `SILENT` result may only produce `inconclusive`, never `resolved`.
- **prediction** *(new record kind — closes the P6.7/P7-trigger-3 hole)* — `id`, `text`, `outcome_criteria`, `made_at`, `context: construct|commit`, `refs[]`, `status: open|graded`, `grade?: right|right-wrong-reason|wrong`. Written by the writer as a side-effect of the ledger events that the manual says must carry predictions; **the P6 sweep queries `status: open` instead of re-reading prose** — a prediction nobody can find is a prediction nobody made.
- **ledger event** — `kind: decide|kill|override|escalate|calibrate|postmortem|rank|note|correct|open`, common fields `title|body|refs[]`, **plus kind-specific REQUIRED fields** (the validating-writer premise is these, not the common envelope): `decide` requires `rejected[]` + `conviction`; a commit-moment `decide` requires `trigger: earned|forced|exhausted` + `open_joints[]` (may be empty only for `earned`); a `CONSTRUCT`-disposition event requires an embedded prediction (spawning the prediction record); `postmortem` requires `trigger`, `recall_verdict: NAMED|NAMED-BUT-MISRANKED|MISSED|UNKNOWABLE`, `attribution` (question-type-scoped), and `prediction_grade` when a prediction ref exists (grading flips the prediction record to `graded`); `override` requires a non-empty `reason`. Append-only; no update tool exists.

**Deflected from round 1 (finding 5, in part):** position *ranking* and commitment *state* do not become stored fields. The manual treats both as acts of judgment recorded in the ledger (P2.5, P4.3–4); the current canon stores neither; "do not add structure until a process demands it" is the manual's own rule. Candidate revival likewise: a kill is a ledger event, a revival is a new ledger event referencing it — events, not a candidate-pile store.

**The ASSERT problem, reworked after gate round 1, finding 3 — which caught the original design making manual mode unrunnable.** The draft banned `[ASSERT]` grounding on all tool writes (per the OQ1 v1-agent-only ruling as first encoded). But P1a step 3 *requires* marking claims `ASSERT` when the owner asserts them, and the agent transcribing an owner statement made in-session is the normal manual-mode path — the entire existing ledger is exactly that. A total ban makes the golden flow and the anti-lockout criterion unsatisfiable until the epic's S4 override exists. Corrected design, preserving the ruling's spirit (no *unaudited* owner-authority claims) while restoring the process:

> - `grounding: ASSERT` on a claim IS writable through tools, **only when the record carries a required, structured `elicitation` block**: `{ asked, answered_at, answer_ref }` — what question was put to the owner, when, and where the answer is recorded (conversation quote or ledger ref). Transcription-with-citation, auditable after the fact; a bare `ASSERT` with no elicitation block is rejected.
> - `[owner-locked]` (amendment-blocking authority) remains **unrepresentable through tools** — import (`via: 'import'`) or the epic's future override only. The 2026-07-21 failure class was authority-laundering; this is the tag that carries authority.
> - `resolve_by: ASSERT` (a joint resolved by owner's call) is a resolution method and legal as before — but its resolution evidence must likewise carry the elicitation block.

**This amends the letter of the `oq1-agent-only-v1` ruling (actor stays `agent`; what changes is that cited owner-attributed grounding becomes representable) and is flagged for owner ratification at the design gate.**

## Decision 4: Tool surface — the four ruled tools plus one read tool

Derived from the process manual's write inventory (P1–P7), not invented; names are owner-locked in §8k:

| Tool | Covers (manual) | Notes |
|---|---|---|
| `judgment_position_create` | P1a 1–7, P1b 3 | Also position update via explicit `supersedes` (new record, old marked superseded — no in-place mutation of claims) |
| `judgment_joint_add` | P1a 7, P2 1–4 | Validator enforces both branches + cost |
| `judgment_transition` | P2 6, P3 outcomes, P6 reopen | Joint state machine — **single lifecycle authority, selected by config, never two** (reworked after gate round 1, finding 2): where `capabilities.guard` is true (it is in this workspace, and the shipped adapter `server/lifecycle-guard.js` is fail-closed before state mutation), the Stratum guard IS the authority — the joint graph is `guard_register`ed, `judgment_transition` calls `guard_transition`, and the record's `state` field is the transition's artifact side-effect (`ONE-WAY-WRITES`, `LIFECYCLE-VS-SEMANTICS`). Only where guard is absent does the writer's own state machine (same graph) enforce. ONE-UNDER-TEST: expressed in the guard if its predicates can state a population invariant; otherwise enforced by the writer under its advisory lock **and the population-invariant contribution is filed upstream in Stratum's tracker** — the vision already designates that exact contribution |
| `judgment_position_amend` | P6 5 (`SHAKE-GROUNDING`) | Scoped amendment: may downgrade a single claim's `grounding` or update `conviction` — may never touch claim text, branches, or rejected alternatives (those are supersession). Added on gate round 1, finding 5: the sweep needs grounding-downgrade *now*, not after supersession proves too heavy (this closes former OQ2) |
| `judgment_ledger_append` | P1b 5–6, P3 records, P4 2–4, P5 1, P7 5 | Append-only; enforces kind-specific required fields (Decision 3); spawns/grades prediction records as a writer-internal side-effect |
| `get_judgment_state` *(read)* | session load, P6 sweep | Register + under-test + open predictions + recent ledger, small result (AUDIT-19) |

*§8k names four write tools as the ruled minimum surface, not a maximum; `judgment_position_amend` is the fifth, added with the P6 write-inventory evidence above.*

**Policy (`server/mcp-tool-policy.js`):** write tools stay implementer/orchestrator-only (default deny covers reviewers); `get_judgment_state` is added to `REVIEWER_ALLOW`. Rationale: review findings become judgments *through the orchestrator's adjudication*, preserving the epic's provenance chain — a reviewer writing canon directly would be a second unattributed author. Revisit if adjudication proves to be a bottleneck.

**Gap accepted, named:** P2's re-rank (high↔medium) is a joint mutation with no dedicated tool; v1 folds it into `judgment_transition` (`rank` change is a legal transition input). The manual's P6 sweep and P7 postmortems write only ledger events — covered.

## Decision 5: The provider seam — checkpoint-store shape, enrichment capabilities

`lib/judgment/store/index.js` copies the checkpoint-store registry: `createJudgmentStore(backendId)` from `.compose/compose.json#judgment.backend` (default `'records'`), backends `'records'` (the tracked floor, always the canon per Decision 1) and `'smartmemory'` (registered seam; fast-follow implements it as an *enrichment emitter + capability surface*, not alternative storage). `capabilities()` is method-granular: `challenge`, `calibration`, `semanticRecall`, `convictionDynamics`. Consumers check opportunistically (the `reconciler.js:150` pattern). SmartMemory transport: the HTTP client, Maya's precedent; workspace key via `resolveProjectTag`; fail-open like the existing feature-events emit.

## Decision 6: The import, and the only sanctioned owner-tag path in v1

One-time importer parses current `REGISTER.md`, `LEDGER.md`, `positions/*.md`, `OBJECTIVE.md` into records, stamping `provenance.via: 'import'` and preserving existing `[owner-locked]`/`[ASSERT]` grounding (import is historical transcription, not new authorship). After import: regenerate all projections, human-diff against the hand-written originals, commit records + projections together. From that commit forward the markdown is generated. The importer is `bin/`-side, run once, kept for provider migrations (`PROVIDER-SEAM`: switching is a re-import, never a sync).

## Decision 7: SmartMemory ontology RFC — filed in SmartMemory's repo, two independent items

1. **`position` + `joint` managed types.** Small-code per the framework (`learned` template, ~4 touchpoints each); `conviction` maps onto reserved `confidence`; `challengeable=True` noted as declared-but-unwired (challenge integration is not free and is not claimed). Until it ships, the enrichment layer may interim-map `position → decision` (which already carries `rejected_alternatives`, `rationale`, confidence, supersession) inside a Compose-owned workspace — zero-core-change, explicitly temporary.
2. **`workflow` as a procedural-memory managed type.** Separate consumer (Maya's hat ladder, eventually the process manual itself), separate timeline; rides the same framework. Fields sketch: name, trigger, steps, preconditions, provenance, track-record hooks for calibration. Not consumed by this feature — filed so the ontology grows coherently.

Both are SmartMemory roadmap items (owning repo per house rule); this design only depends on neither.

## Decision 8: Projections speak OKF (owner ruling 2026-07-22 — reverses `note: okf-set-aside`)

Per-item projections are emitted as **Google Open Knowledge Format v0.1** markdown, the dialect SmartMemory's Obsidian bridge already speaks (`smartmemory-obsidian/src/bridge/okf.ts` — codec, resource URIs, bundle rules verified against code and fixtures):

- `positions/<slug>.md` (and `OBJECTIVE.md`) carry OKF frontmatter: `type`, `title`, `timestamp`, and `resource: smartmemory://<workspace>/<item-id>` where workspace = `resolveProjectTag(cwd)` and item-id = `<kind>.<slug>` — **single path component, the codec rejects `/` in item ids** (`okf.ts:52-54`).
- `docs/judgment/` becomes an OKF bundle: a generated `index.md` (bundle root, `okf_version: "0.1"`) linking the projections. `REGISTER.md`/`LEDGER.md` keep their names and human-first aggregate shape — OKF is per-item; aggregates are not force-fitted.
- **Two-source guard, reworked after gate round 1, finding 8 — the original guard relied on upsert semantics that do not exist.** Codex verified against the actual Obsidian ingest (`ingest.ts:183,212`): on content change it *deletes the referenced item and ingests a new one with a new server id* (no server-side dedupe), and it *rewrites the note's frontmatter* — which on a generated projection would break the fixed-point invariant. The guard is therefore **exclusion-based, not upsert-based**: projections stamp `smartmemory: { reference: true, origin: 'compose-projection' }` and the projections directory is never a sync/ingest target. The `resource` URI remains as identity *for readers*; no design claim depends on ingest honoring it. **MUST-VERIFY at W1:** confirm the bridge skips `reference: true` notes; if it does not, projection exclusion is enforced by path configuration alone and that is stated in the user-facing docs.
- **Workspace naming (same finding):** the bridge ignores resources whose workspace differs from its configured SmartMemory workspace, and `resolveProjectTag` yields a Compose-local tag. W4 must provision/name the SmartMemory workspace to match the resource-URI workspace component — one name, chosen once, used by both.
- Payoff: Obsidian views judgment canon natively (read-only); the W4 enrichment layer reuses the same resource identities end to end — one naming scheme from record to memory.

Scope line: OKF applies to judgment *projections* only. Records stay JSON (canon, schema-validated); ROADMAP/CHANGELOG are aggregates and stay out; design docs are prose and stay out.

---

## Slices

| Slice | Content | Gate |
|---|---|---|
| W1 | Schema + records store + `judgment-write-guard.js` + `judgment-writer.js` + projections (OKF per Decision 8, incl. bundle `index.md`) + golden test | Golden flow: P1→P7 via writer API only, projections regenerate fixed-point; per-item projections parse under the OKF codec's rules (frontmatter fence, required `type`, valid `resource`) |
| W2 | 5 MCP tools (4 write + 1 read) + policy entries + MCP e2e tests | Manual mode runnable end-to-end through tools only (anti-lockout); forbidden-tag write rejected |
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
| `server/compose-mcp.js` | modify | 5 TOOLS entries + dispatch cases |
| `server/compose-mcp-tools.js` | modify | 5 thin shims (getTargetRoot + lazy import) |
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
- [ ] `judgment_position_amend` can downgrade one claim's grounding without touching any other field; claim-text changes are refused (supersession path named in the error)
- [ ] Projections regenerate to a fixed point; a hand-edit to any projection is overwritten by the next regeneration; the roundtrip guard blocks non-fixed-point commits
- [ ] Ledger has no update/delete surface; `LEDGER.md` is a projection of `ledger.jsonl`
- [ ] Golden flow: P1→P7 of the process manual executed end-to-end using only the five tools against a real temp workspace (anti-lockout)
- [ ] Import round-trip: current hand-written canon → records → projections, human-approved diff, single cutover commit
- [ ] With `judgment.backend` unset, behavior is floor-only and byte-identical to no-seam; `'smartmemory'` unimplemented in W1–W3 throws `NOT_IMPLEMENTED` (checkpoint-store precedent)
- [ ] Writer results are small typed objects (AUDIT-19); errors carry `code`/`cause` through the MCP boundary
- [ ] A failure mid-write (record persisted, projection regen fails) rolls back via the journal-writer compensating pattern and surfaces `JUDGMENT_PARTIAL_WRITE` with `cause`
- [ ] Reviewer profile: write tools denied, `get_judgment_state` allowed (policy test)

## Open questions — all owner-gate items

1. **Ratify: floor = tracked `docs/judgment/records/`**, not the gitignored vision store (gitignore evidence in Grounding). Decision 1 is now deliberately narrow — v1 canon is the floor provider; provider-primary canon later stays an open owner call under `PROVIDER-SEAM`.
2. **Ratify: the ASSERT amendment** (Decision 3) — cited transcription of owner assertions becomes tool-writable; `[owner-locked]` stays locked out. Amends the letter of `oq1-agent-only-v1`; without it, manual mode cannot run through the tools at all (gate round 1, finding 3).
3. Should `rank` changes emit ledger events automatically (P2.5 says record the re-rank judgment)? Lean yes — cheap, and the ledger is the collection point the manual demands.

*(Former OQ2 — scoped position amendment — closed by gate round 1, finding 5: `judgment_position_amend` is in scope now.)*

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

## Explicitly out of scope

Enforcement of any kind (epic S4–S6: hooks, guard registration of judgment paths, attestation); owner-attributed tool writes; challenge/calibration *consumption* (Maya/FOH); ideabox migration (COMP-PLAN-IDEA-UNIFY); building the SmartMemory managed types themselves (SmartMemory repo owns that RFC).
