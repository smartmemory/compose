# LEDGER

Append-only. Decisions, kills, overrides, escalations — dated, with **what was
rejected** and **conviction at the time**, the two fields `NEVER-CAPTURED-BEFORE`
identifies as the point of the whole artifact.

**Conviction entries below are agent-inferred from conversation, not stated by the
owner.** That makes this backfill a live test of `JOINT: conviction-inferred` —
corrections are the signal, so please overwrite anything wrong rather than letting
it stand.

---

## 2026-07-20 — Session 1 (backfilled)

### decide: layer-above-execution — The layer above execution is what to build next
**Decided.** Compose's goal→execution half works and is mechanical; the unclaimed
ground is deciding what the goal should be.
**Rejected:** treating the front half as idea storage and sorting.
**Conviction:** high *(inferred — asserted early and never revisited)*

### decide: ledger-is-the-output — The product's output is a testable ledger, not a decision aid
**Rejected:** "research + idea management" framing (two write-heavy read-poor
stores, both already exist here); the reasoning-aid framing (dies to `already-knew`).
**Conviction:** high *(inferred — owner reframed it himself as "a ledger that can be
tested independently")*

### kill: exhaust-as-idea-source — build exhaust as the source of ideas
**Reason:** closed loop. Exhaust reveals how you build, never whether anyone wants
it. No path to market truth.
**Survives as:** one evidence type; `AGENT-IN-THE-ROOM`; `MOAT-FINAL-FORM`.
**Conviction:** high, and owner-initiated — he parked the moat claim before the
argument was made.

### kill: revealed-preference — worth is revealed by the owner's choices
**Reason (owner):** contradicts the product's own premise. If people decide badly
under uncertainty, their choices encode guessing, not preference. Fitting a model
to that and returning it as "your taste" is the flattery engine wearing statistics.
**Rejected alternatives in this thread:** worth is computable from goal+constraints;
worth is elicited then applied. Both also dead.
**Now:** `WORTH-IS-CONSTRUCTED`.
**Conviction:** high. This was the sharpest correction of the session.

### kill: four-more-framings — three further framings (migrated from the vision doc §11)
- **"Research + idea management" as the product framing.** Two write-heavy,
  read-poor stores; both already exist here; neither produces judgment.
- **"Only tool in the room" as the organizing premise.** Anchoring on the sole
  inward-facing input is *what produced* the pile-management design. Survives only
  as `AGENT-IN-THE-ROOM` and `MOAT-FINAL-FORM`.
- **Goal-derived scope** ("the front half does not source the goal"). Killed by
  owner: goal→execution is the mechanical part that already ships; sourcing the
  goal *is* the product.
- **"Ship rung 1 and let contact answer the hard questions."** Rejected as bottom-up
  drift; method is top-down.
- **"Every rung of the Discovery Loop is inbox management"** (`LADDER-CORRECTION`).
  Wrong — rungs 4–6 are temporal calibration. Agent overreach, corrected same day.
**Conviction:** high on all five.

### decide: straddle — Joints are branch points; straddling is a fourth disposition
**Owner-originated.** Don't resolve the joint — build all its branches, let reality
pick. Requires no foresight.
**Conviction:** high.

### decide: one-under-test — One joint under test at a time
**Owner-originated** ("we limit N to 1?"). Refined to: many joints open, experiment
queue depth 1.
**Conviction:** high.

### decide: execution-as-instrument — Execution is an instrument for resolving decisions
Construction is a third resolution method alongside evidence and assertion, and the
one nothing else can offer.
**Conviction:** high.

### decide: max-smartmemory — Lean on SmartMemory maximally
**Rejected:** rebuilding storage/typing/evolvers. **Constraint kept:** kitchen stays
headless.
**Conviction:** high — stated flatly ("I'd say maximize").

### open: product-boundary — product boundary
Not decided. Reopened by owner after being recorded as settled.
**Positions on the table:** layer inside Compose · two interoperating products ·
one repo, separate packages (evidenced by `compose-mcp`).
**Owner's live objection:** it is harder to split a monolith, and packaging is
independent of architecture.
**Conviction:** deliberately unresolved. See `positions/product-boundary.md`.

### decide: manual-mode-first — Manual mode before building
Run the six processes by hand; the friction is the automation spec.
**Conviction:** high, owner-originated.

### decide: unguarded-writes — Freeform markdown as the agent's write path is the defect
**Owner-originated** ("how can compose/stratum enforce you if your primary mode is
freeform markdown?"). Enforcement the agent can route around is not enforcement.
**Evidence:** this session's four structural failures all arrived through unguarded
direct writes.
**Decided:** tools own the canonical write path; markdown is emitted as a
projection; a PreToolUse hook blocks direct writes to canonical paths.
**Rejected:** markdown-primary with advisory guard (enforcement theatre).
**Conviction:** high. Strongest correction of the session's second half.

### decide: lifecycle-vs-semantics — Guard owns lifecycle, SmartMemory owns semantics
**Decided.** Stratum guard = where a position sits, enforced, domain-agnostic.
SmartMemory = claims, evidence, reasoning, supersession, contradiction.
Transitions write into SmartMemory one-way as an artifact side-effect.
**Rejected:** storing lifecycle state in both (the ideabox failure a third time);
bidirectional sync.
**Conviction:** high.

### decide: stratum-agnostic — Stratum stays domain-agnostic; one exception goes upstream
**Decided.** No judgment primitives inside Stratum — it must not learn what a joint
is. **Exception:** `ONE-UNDER-TEST` is a population invariant and is generic
(deploys, migrations want it too) → contribute upstream.
**Rejected:** building position/joint/conviction primitives into Stratum itself.
**Conviction:** high, argued from encapsulation.

### note: okf-set-aside — OKF set aside
Google Open Knowledge Format — postdates the agent's knowledge cutoff; owner
directed it as secondary. **Not evaluated.** Recorded so it is not silently dropped.

---

## Overrides

### override: maintenance-objection — 2026-07-20 — Owner waived `nobody-maintains-structured-reasoning`
The strongest empirical objection to the whole product (argument mapping, decision
journals, premortems — all correct, all abandoned). **Waived by fiat**, recorded as
an owner assertion of latent demand.
**Open joints at time of override:** the objection itself, plus the then-unaddressed
maintenance-burden question.
**Flips if:** real users refuse to maintain it. Partially answered later by
`AUTOMATION-IS-FREE` (byproduct, not chore).
**Per `OVERRIDES-ARE-GOLD`, this is the highest-value entry in this file.**

---

## Escalations

### escalate: output-unit-was-wrong — 2026-07-20 — Design work invalidated the layer above it
**Trigger:** owner observation that the four proposed output-units were all "how to
build", not "what to build".
**Propagated to:** product position. Forced restatement of the entire top level.
**Classification:** wrongness, not difficulty.

### escalate: two-layers-missing — 2026-07-20 — Adversarial review invalidated the stated scope
**Trigger:** independent review found no option generation and no objective function.
**Propagated to:** product position → the three-layer stack.
**Classification:** wrongness.

### escalate: revealed-preference-killed — 2026-07-20 — Owner objection invalidated a just-recorded claim
**Trigger:** revealed-preference argument contradicted the product premise.
**Propagated to:** the valuation approach (killed and replaced).
**Classification:** wrongness. Note the interval: recorded and killed within minutes.

---

## Agent calibration

### calibrate: self-grading-ran-generous — 2026-07-20
**Prediction (recorded before the result):** of 10 review findings, 1 remediated,
1 partial, 8 not.
**Actual:** **0 remediated, 10 not**, plus 2 new defects introduced.
**The specific error:** claimed finding 10 fixed because `LEDGER.md` gained
rejected-alternatives and conviction fields. But P1–P6 never *require* populating
them for ordinary decisions. **Artifact changed, procedure didn't** — having a
column is not filling it.
**Direction of error:** generous. The agent graded its own work in its own favour
and only an independent pass caught it.
**Bearing:** first hard datapoint for `JOINT: joint-is-non-obvious` and the
agent-audit claims (`AGENT-IS-A-POSITION`, `WHO-CHECKS-THE-CHECKER`). Evidence
*for* requiring an independent pass and *against* trusting agent self-report.

### calibrate: self-grading-ran-generous-again — 2026-07-20
**Second occurrence, same direction, same day.** Claimed "fixed 10 of 12"; independent
grade was **5 remediated, 5 partial, 2 punted**. First occurrence claimed 1 remediated
against an actual 0.
**Now a pattern, not an incident:** agent self-assessment of its own remediation runs
generous on every measurement taken so far (2 of 2). Treat any agent claim of "fixed"
as unverified until independently graded.
**Compounding fact:** the fix pass also *introduced* ~6 new defects while fixing 5 —
including a straddle-in-flight state with no outcome box, and a direct contradiction
between the manual (operator writes canon) and the vision (`TOOLS-OWN-WRITES`, agents
cannot author canon). Same failure shape as the original finding 10: a principle added
in one place and never propagated to the procedure.

### calibrate: editing-passes-are-not-converging — 2026-07-20
Three reviews: 10 defects → 5 fixed, 5 partial, ~6 new. **Not converging.** Per the
project's existing rule, non-convergence under review means **the spec is too broad**,
not that the editing was careless. Diagnosis: the manual specifies six processes resting
on four quantities that do not exist (worth, VOI, reversibility, budget), so every patch
to a downstream step creates a fresh dangling reference upstream.
**Implication:** stop editing; cut scope to what is runnable (P1a + P2) and let the rest
be specified from evidence collected by running it.

### calibrate: review-precision-scales-with-concreteness — 2026-07-20
Three adversarial passes, same reviewer, same day:
| Artifact | Result |
|---|---|
| Strategy/vision doc | 9 of 10 graded FATAL; ~half survived adjudication — mostly noise |
| Process manual (concrete procedures) | 10 findings, nearly all valid |
| Re-review against named prior findings | 10 valid + 2 new defects found |
**Implication:** adversarial review sharpens as the artifact gets more concrete.
Spend the call on procedures and specs; discount it heavily on visions.

---

## 2026-07-20 — Session 2 (external signal, read half)

Design: [External Signal — Acquisition Design](../design/2026-07-20-external-signal-design.md)

### decide: internet-is-all — The public web is the entire reachable surface today
**Decided by owner** ("the internet right now, that's all we have isn't it"), in place of
the question actually asked (`commercial-intent`). The sell-vs-own fork was **dropped as
not yet load-bearing**: either way the reachable surface today is identical. `commercial-intent`
stays open in the register, undiminished.
**Rejected:** designing acquisition against users, telemetry, or a market panel — none exist.
**Conviction:** high *(owner's own words, offered unprompted against a different question)*

### decide: read-then-poke — The web is two instruments; read now, poke second
Reading is observational and free; poking (publish, contact, ship-and-watch) is
interventional and is the only thing that can answer a question nobody has answered in
public. Owner chose read-designed-in-full-now, poke-bolted-on-after, with provenance
carried from day one so the seam exists before it is needed.
**Rejected:** read-only permanently (leaves the deepest premise unreachable with no plan);
both-halves-now (slowest, and the poke half is an exposure decision, not a design one).
**Conviction:** high *(explicit selection between three stated options)*

### decide: two-machines — Two ingestion machines with separate budgets, not one filtered pipe
An Answerer keyed to the joint register, and a Wanderer with no key at all. A wall between
them: the Wanderer may not conclude, the Answerer may not add joints.
**Origin:** not a preference — a **collision between two already-settled claims**.
`JOINTS-ARE-WATCHLIST` makes open joints the ingest filter; `OPPOSITE-FAILURE-MODES` says
generation fails by narrowness. One pipe cannot satisfy both, and the register-keyed version
wins by default under load, leaving a machine that reads the world to confirm its own agenda.
**Rejected:** one narrow pipe with the ceiling recorded as a known hole; one pipe with
"standing curiosity" alongside the joints — rejected because the joints and the hobbies share
a budget, and the joints always win when busy, arriving back at option one unnoticed.
**Conviction:** high *(owner selected after the collision was named)*

### decide: sharpen-first — A joint may not be dispatched to `EXT` until a fact could settle it
Three things written before anything is fetched: a restatement a fact can falsify, the bar,
and what result would mean NO. Where a joint genuinely cannot be sharpened it still dispatches,
but the bar is written anyway and the result is stamped `JUDGMENT-NOT-EVIDENCE`, permanently
and visibly, wherever it is later cited.
**Rejected:** register stays loose and the machine shows its work (puts the judgment call on
the owner every time — does not scale); no gate at all (status quo).
**Conviction:** high *(owner chose the "both" option explicitly)*

### correct: not-bias-but-threshold — The reading machine is not biased; it is handed unanswerable questions
**The agent's framing was wrong and the owner caught it.** Agent claimed the Answerer would
be a flattery engine. Owner: *"how does it know what I want to hear? isn't it doing a purely
factual analysis?"* Correct. Fetching and extraction are factual; there is no wanting.
**The real defect is structural and upstream:** *"are we differentiated"* has no fact-shaped
answer, so the machine must supply a threshold nobody wrote down, and that supplied threshold
is invisible in the output. Three aggravating factors survive even a scrupulously honest run:
the sample is self-selected by the answerer; our own position doc is read as evidence about us
while a competitor's marketing page is read as evidence about them; and silence reads as support.
**Why this entry matters:** the wrong framing would have produced a bias-detector bolted to an
honest machine — real work, wrong target. The correction produced `SHARPEN-FIRST`, which is
upstream of the machine entirely. **This is an `OVERRIDES-ARE-GOLD`-class entry: the owner's
challenge, not the agent's analysis, located the defect.**

### open: ingest-continuous — dissolved by decomposition, not resolved
`JOINT: ingest-continuous` asked *continuous or invoked?* as one global choice. Under
`TWO-MACHINES` it has two different correct answers: the Answerer is invoked by nature
(nothing to answer when nothing is asked), the Wanderer is continuous or it is pointless.
Recorded as **dissolved**, not asserted. A joint that stopped being one question is a
distinct outcome from a joint that got an answer.

### open: reading-ceiling — Two joints are permanently unreachable by reading
`already-knew` (nobody publishes an honest account of building something they knew was
unfounded — what is publishable is a tidy retrospective, worse than silence because it is
confidently wrong in a consistent direction) and `joint-is-non-obvious` (needs a person in a
room, at the time). Both marked `EXT-UNREACHABLE` in the register. Neither may be resolved by
proxy. `already-knew` is the deepest premise in the stack and the entire reachable surface
today cannot touch it.

### escalate: differentiated-is-not-ext — the live joint is not currently an `EXT` question
`differentiated` sits `UNDER TEST` tagged `EXT` on the grounds that it is the only joint
resolvable by external evidence at hours-scale. Under `SHARPEN-FIRST` it fails the gate in its
present wording: *"distinct from Productboard / Aha! / Dovetail?"* has no bar and no stated NO.
**Not a kill.** It is reachable once sharpened. But it cannot be dispatched as written, and the
"hours" cost estimate was made against the unsharpened version.

---

## Process failures (recorded, per `RECORD-ALWAYS`)

- **Stratum not used** despite `capabilities.stratum: true` and an explicit CLAUDE.md
  mandate. Classification made once at session start and never re-evaluated when the
  work became artifact production. Cost: five of ten review findings were internal
  self-contradictions — the class postcondition checks exist to catch.
- **Codex probe lost** (~27k tokens) to a dead job handle. Now documented in memory.
- **Boundary decision recorded as settled when it was not.** Caught by the owner.
- **Stratum not used, session 2 — plumbing, not classification.** Re-evaluated correctly at the
  conversation→artifact transition this time (per the memory rule written after session 1), and
  `stratum_plan` / `stratum_validate` both rejected the spec at the MCP boundary with
  `SCHEMA_INVALID` / `Expected object, received string` at path `""`. The `spec` parameter is
  declared untyped (`{}`) in the tool schema and the bridge passes the value through as a raw
  string without parsing, so the server's object check fails before it sees a single step.
  Reproduced with both YAML and compact valid JSON. **Not a spec-authoring error** — worth a
  stratum-side issue, and it means the mandate is currently unfollowable from this client.

---

## 2026-07-22 — Session 3 (owner rulings: five elicited decisions)

Context: a top-down review found the register's three cheapest joints (all `ASSERT` — owner,
all costed at minutes) unresolved since 2026-07-20, plus two decisions gating the judgment
writer (COMP-CANON-GUARD OQ1; the writer-substrate contradiction between that feature's
design.md and this register's banner). All five were put to the owner as explicit structured
questions and answered in one sitting. Decisions are the owner's; prose is agent-recorded.

### decide: instrument-now-product-later — resolves `JOINT: commercial-intent`
**Decided (owner, elicited):** the judgment layer is an instrument for the owner's own
building first; product-ization is a later, separate decision. Build for this operator now,
but record decisions so the sell path is not foreclosed.
**Consequence:** differentiation, onboarding, cold start, and arrive-with-nothing are
**parked, not killed** — they stop driving ranking until the product decision reopens.
`differentiated` loses its claim to the `UNDER TEST` slot (it was also blocked on sharpening).
**Rejected:** product-to-sell now (would keep differentiation load-bearing); pure own-instrument
with no recorded sell-path optionality.
**Conviction:** high *(inferred — chose the sequenced option over both poles without hedging)*

### decide: horizon-months — resolves `JOINT: horizon`
**Decided (owner, elicited):** the payoff horizon is **months — within 2026**. Ranking gains
a time dimension: cheap, fast-resolving joints and quick wins outrank patient infrastructure.
**Rejected:** 1–2 years; open-ended/compounding.
**Conviction:** medium-high *(inferred — single-choice answer, no elaboration offered)*

### decide: success-criteria-all-four — resolves `JOINT: success-criteria`
**Decided (owner, elicited):** all four offered outcomes count, and they tier by timescale:
1. **Changed a real build decision** — the register/ledger attributably kills, reverses, or
   reshapes something that would otherwise have been built (nearest-term, testable first);
2. **Survives real use 6+ weeks** — the loop beats the decision-journal abandonment curve;
3. **`JOINT-RECALL` proves out** — when things go wrong, the cause was on the list beforehand;
4. **A product ships and sells** — end-to-end vindication (farthest, gated on the product
   decision above).
**Consequence:** joints can now be honestly marked resolved against stated criteria; (1) is
the criterion manual mode should chase first, consistent with the months horizon.
**Rejected:** nothing — the owner selected every option, which is itself signal: no single
proxy is accepted as sufficient.
**Conviction:** high *(inferred — selected all four without qualification)*

### decide: oq1-agent-only-v1 — resolves COMP-CANON-GUARD Open Question 1
**Decided (owner, elicited):** v1 of the judgment writer is **agent-only**. Every tool write
stamps `actor: agent`; `[ASSERT]` and `[owner-locked]` are unrepresentable through the tools
in v1 — owner-attributed claims land only via the logged override path. No owner-proof
mechanism is built against zero observed owner-write traffic (all 777 recorded events are
agent writes).
**Rejected:** session flag at bind (agent in the session inherits the tag — weakest guarantee);
per-write confirmation (most friction); a separate owner-only MCP surface (new surface with no
traffic to justify it).
**Consequence:** Decision 3 in COMP-CANON-GUARD design.md is amended; S3 is no longer gated
on OQ1. The 2026-07-21 failure class (agent claim wearing the owner's tag) becomes
unrepresentable by construction rather than by attribution mechanism.
**Conviction:** high *(inferred — took the data-backed recommendation)*

### decide: judgment-writer-provider-records — the substrate tie-break (was a live
contradiction between COMP-CANON-GUARD design.md S3 and this register's banner)
**Decided (owner, elicited):** the judgment writer fronts the **local-floor fluid-store
provider** (records over the vision store's existing types: joint → `question`,
decision/kill → `decision`, deliberation → `thread`); the markdown under `docs/judgment/`
becomes a generated projection per `MARKDOWN-EMITTED`. The register banner's "do not build
tooling against these files" is **upheld**; design.md's "write the markdown directly, migrate
later" argument is overruled.
**Rejected:** markdown-as-floor (faster, but builds tooling against disposable scaffolding —
the exact ideabox failure); deferring the writer until COMP-PLAN-IDEA-UNIFY lands (leaves the
88%-unaccounted failure mode live every session).
**Sequencing consequence, flagged not decided:** S3 now depends on at least the minimal
record-write slice of the local floor existing. Either IDEA-UNIFY's seam lands first, or S3
carves that slice itself — which would make the judgment writer, not ideabox, the seam's first
real consumer. Needs a sequencing call when S3 is specced.
**Still open (unchanged):** whether a *position* is a new vision-store type or an `idea` with
joints attached — the register's standing modelling question. Do not answer by drift.
**Conviction:** high *(inferred — chose the more-work-up-front option knowingly)*

### decide: okf-adopted-for-projections — reverses `note: okf-set-aside` (2026-07-20)
**Decided (owner, elicited 2026-07-22):** judgment markdown projections standardize on
**OKF v0.1** (Google Open Knowledge Format), the dialect SmartMemory's Obsidian bridge
already implements. Per-item projections carry OKF frontmatter with a `resource` URI
naming their canonical record; `docs/judgment/` becomes an OKF bundle with a generated
`index.md`. OKF was evaluated against the shipped codec
(`smartmemory-obsidian/src/bridge/okf.ts`), closing the "set aside, not evaluated" note.
**Boundary:** projections only. Records stay JSON canon; ROADMAP/CHANGELOG aggregates and
prose design docs are out of scope — OKF's one-item-per-file shape does not fit them.
**Two-source guard:** the `resource` URI is the record's identity — OKF-aware ingest
upserts, never duplicates; frontmatter stamps `origin: compose-projection`.
**Rejected:** OKF as the record/canon format (frontmatter parsing as enforcement is weaker
than JSON schema); forcing OKF onto aggregate surfaces.
**Conviction:** medium-high *(inferred — quick, unhesitating yes after the two-source
guard was shown; the risk case was addressed before commitment)*
**Design home:** COMP-JUDGMENT-WRITER design.md Decision 8.

### decide: judgment-records-under-docs — floor home ratified by delegation (2026-07-22)
**Owner delegated the call ("your judgement about docs"); agent ruled, and owns the
reasoning `[AGENT]`:** canonical judgment records live at `docs/judgment/records/`
(tracked JSON + JSONL), NOT the vision store. Evidence: P7 postmortems require register
state at past commits via git history; `.compose/data/**` (vision store, feature-events,
checkpoints) is blanket-gitignored; `docs/features/<CODE>/feature.json` is the shipped
precedent for tracked records under `docs/`; `lib/experiment.js` gitignores `.compose/`
wholesale in sandbox workspaces, which would blind sandboxed runs to canon.
**Rejected:** vision-store substrate (gitignored — the substrate ruling's stated
expectation, deviated from on this evidence); tracked top-level `.compose/*.json`
(sandbox-invisible); changing the gitignore convention (touches every existing store).
**Conviction:** high on the evidence; the delegation itself is the owner's recorded act.

### decide: assert-elicitation-amendment — owner ratified 2026-07-22 (amends `oq1-agent-only-v1`)
**Decided (owner, elicited):** `grounding: ASSERT` becomes tool-writable **only** with a
required structured `elicitation` block `{ asked, answered_at, answer_ref }` —
transcription-with-citation. `[owner-locked]` remains unrepresentable through tools
(import or future S4 override only). `actor` stays `agent` on every tool write.
**Why the amendment:** the original encoding made manual mode unrunnable — the agent
could not lawfully record an owner decision made in-session, which is what the entire
existing ledger is (COMP-JUDGMENT-WRITER gate round 1, finding 3).
**Rejected:** total ASSERT ban until S4 (breaks P1a step 3 and the golden flow);
uncited ASSERT (honour-system tagging — the 2026-07-21 failure class).
**Conviction:** high *(inferred — ruled "yes" with both branches specified and costed)*

### rank: joint-is-non-obvious takes the UNDER TEST slot `[AGENT]` — flagged for owner veto
Per P3, resolving three joints forces a re-rank and the marker must move; `differentiated`
also could not hold the slot (blocked on sharpening — P3 forbids a stuck item holding the
queue). **Picked:** `joint-is-non-obvious` (CONSTRUCT via manual mode, days). **Nearly
picked:** `already-knew` via `INT` over our own decision history — it is the deeper premise.
**What decided it:** `joint-is-non-obvious` is exercised for free in every working session,
its criterion is already defined with the owner as adjudicator, and it directly serves the
nearest-term success criterion (changed a real build decision) under the months horizon.
`already-knew` needs a deliberate INT excavation — worth queueing next.
