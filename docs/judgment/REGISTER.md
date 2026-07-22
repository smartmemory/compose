# Judgment Register

> **Register banner (imported)** — > **CANON for joint state.** The vision doc (`docs/product/2026-07-20-what-to-build-vision.md` §9) points here and does not duplicate. Split is by kind: stable named reasoning lives there, live operational state lives here.
>
> **DISPOSABLE SCAFFOLDING.** This markdown store is a manual-mode learning substrate, **not** a fourth canon alongside `ideabox.md`, the vision store, and `feature.json`. Migration target *(re-ruled 2026-07-21, per `PROVIDER-SEAM` — [what-to-build §8k substrate ruling](../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives))*: **fluid-store provider records, written only by the `judgment_*` tools.** The local floor provider is expected to implement over the vision store's existing types — joint → `question`, decision/kill → `decision`, deliberation → `thread`, position → `idea` *or a new type (undecided — see below)* — with SmartMemory as the capability-rich provider backing the same records. Do not build tooling against these files; tooling is what turned the ideabox from a surface into a second source. *Ruled 2026-07-22 (owner, `decide: judgment-writer-provider-records`): the `judgment_*` writers front the local-floor provider directly from v1 — these files become projections; this banner is upheld over COMP-CANON-GUARD design.md's markdown-as-floor argument, which is overruled.*
>
> **OPEN MODELLING QUESTION — do not answer by drift:** is a *position* a new vision-store type, or an `idea` with joints attached? This is the same question WS-A asks about ideas, and answering it by accretion is how the current fragmentation happened.
**Last ranked:** 2026-07-22 · **Under test:** `joint-is-non-obvious` (exactly one, per `ONE-UNDER-TEST`)
Backfilled from the 2026-07-20 design session. Ranking is by value of information
against cost — **and per Codex finding 1, VOI is not yet a computed quantity, so
the ordering below is judgment, not calculation.** Recorded as such rather than
dressed up.

## already-knew

- **Question:** Do bad build decisions come from unexamined reasoning, or do people know and build anyway?
- **If true:** Judgment layer is the product
- **If false:** Value is recovery, not foresight
- **Method:** INT · cost days · rank high
- **State:** open
- **Flags:** EXT-UNREACHABLE, method-note: own decision history

## external-reachable

- **Question:** Can external signal be acquired at useful quality?
- **If true:** Generation is real; straddling works
- **If false:** Asserted-only; flattery risk returns
- **Method:** CONSTRUCT · cost weeks · rank high
- **State:** open

## joint-is-non-obvious

- **Question:** Can it surface a joint the owner hadn't noticed?
- **If true:** Day one is valuable with an empty ledger
- **If false:** It reformats what you already said
- **Method:** CONSTRUCT · cost days · rank high
- **State:** under_test
- **Flags:** method-note: manual mode

## sensitivity-computable

- **Question:** Can "which claim flips the conclusion" be computed reliably?
- **If true:** Branching engine works
- **If false:** Multiplies garbage
- **Method:** CONSTRUCT · cost weeks · rank high
- **State:** open

## straddle-reaches-trunk

- **Question:** Can strategy-level branches be built in parallel cheaply?
- **If true:** Straddling reaches decisions that matter
- **If false:** Leaf-level tool only
- **Method:** CONSTRUCT · cost weeks · rank high
- **State:** open

## valuation-exists

- **Question:** How is worth established at all?
- **If true:** Advisor product works
- **If false:** Arrive-with-nothing cannot ship
- **Method:** CONSTRUCT · cost weeks · rank high
- **State:** open

## calibration-timely

- **Question:** Is calibration signal obtainable in useful time?
- **If true:** Self-grading is real
- **If false:** Substitute the 6-week usage proxy permanently
- **Method:** INT · cost days · rank medium
- **State:** open
- **Flags:** method-note: own history

## candidates-generatable

- **Question:** Can candidates be generated, or must the owner supply them?
- **If true:** Generation layer is real
- **If false:** Evaluation-only system
- **Method:** CONSTRUCT · cost weeks · rank medium
- **State:** open

## commercial-intent

- **Question:** Product to sell, or instrument for own building? Changes almost everything downstream
- **If true:** (not recorded at import)
- **If false:** (not recorded at import)
- **Method:** ASSERT · cost hours · rank medium
- **State:** resolved
- **Flags:** import: cost "minutes" mapped to "hours" (COARSE-BUCKETS)
- **Resolution:** resolved — Instrument now, product later; sell-path concerns parked, not killed (decide: instrument-now-product-later)

## construction-discipline

- **Question:** Does construction resolve joints, or degrade into "build it and see"?
- **If true:** Execution-as-instrument works
- **If false:** Most expensive failure mode in the design
- **Method:** CONSTRUCT · cost days · rank medium
- **State:** open
- **Flags:** method-note: observe own discipline

## conviction-inferred

- **Question:** Does auto-capture infer conviction accurately?
- **If true:** Ledger is trustworthy
- **If false:** Timestamped fiction; needs confirmation UX
- **Method:** CONSTRUCT · cost hours · rank medium
- **State:** open
- **Flags:** method-note: live test running: LEDGER conviction fields are agent-inferred and awaiting owner correction

## differentiated

- **Question:** Distinct from Productboard / Aha! / Dovetail?
- **If true:** Proceed
- **If false:** Reposition or kill
- **Method:** EXT · cost hours · rank medium
- **State:** open
- **Flags:** blocked-on-sharpening

## elicitation-works

- **Question:** Can context + objective be elicited in one conversation?
- **If true:** Day-one works, no accumulation needed
- **If false:** Only serves users who already have a candidate
- **Method:** CONSTRUCT · cost days · rank medium
- **State:** open

## entry-threshold

- **Question:** What earns a ledger entry?
- **If true:** Threshold holds, volume stays usable
- **If false:** Volume rot, faster than manual
- **Method:** CONSTRUCT · cost days · rank medium
- **State:** open

## horizon

- **Question:** Over what period does this need to pay off?
- **If true:** (not recorded at import)
- **If false:** (not recorded at import)
- **Method:** ASSERT · cost hours · rank medium
- **State:** resolved
- **Flags:** import: cost "minutes" mapped to "hours" (COARSE-BUCKETS)
- **Resolution:** resolved — Months — payoff within 2026; ranking favors cheap fast-resolving joints (decide: horizon-months)

## ingest-continuous

- **Question:** Continuous or invoked ingestion?
- **If true:** (not recorded at import)
- **If false:** (not recorded at import)
- **Method:** CONSTRUCT · cost hours · rank medium
- **State:** dissolved
- **Flags:** import: resolve_by/cost not recorded on the dissolved row — defaulted
- **Dissolved into:** answerer, wanderer

## ledger-used

- **Question:** Does an auto-captured ledger get used?
- **If true:** Byproduct model works
- **If false:** Dies to the decision-journal abandonment curve
- **Method:** CONSTRUCT · cost weeks · rank medium
- **State:** open
- **Flags:** method-note: NOT closable in manual mode; the claim is about auto-capture

## success-criteria

- **Question:** What observable outcome would mean this worked?
- **If true:** (not recorded at import)
- **If false:** (not recorded at import)
- **Method:** ASSERT · cost hours · rank medium
- **State:** resolved
- **Flags:** import: cost "minutes" mapped to "hours" (COARSE-BUCKETS)
- **Resolution:** resolved — All four criteria count, tiered by timescale; "changed a real build decision" is nearest-term (decide: success-criteria-all-four)

> **Register: register prose (imported)** — |---|---|---|---|---|---|

> **Register: register prose (imported)** — *Moved here 2026-07-22 (ledger: `rank: joint-is-non-obvious takes the UNDER TEST slot`,

> **Register: register prose (imported)** — `[AGENT]`, flagged for owner veto). Exercised for free in every working session; criterion

> **Register: register prose (imported)** — already defined (owner confirms, at the time — owner is the adjudicator); directly serves the

> **Register: register prose (imported)** — nearest-term success criterion under the months horizon. Runner-up: `already-knew` via `INT`.*

> **Register: register prose (imported)** — *`differentiated` vacated the slot the same day: it had been blocked on sharpening since

> **Register: register prose (imported)** — 2026-07-20 (P3 forbids a stuck item holding the queue), and `instrument-now-product-later`

> **Register: register prose (imported)** — deprioritized it — see below.*

> **Register: register prose (imported)** — |---|---|---|---|---|---|

> **Register: register prose (imported)** — *Re-weighted 2026-07-22 under `instrument-now-product-later` + the months horizon: sell-path

> **Register: register prose (imported)** — joints (`elicitation-works`, `candidates-generatable`, arrive-with-nothing weighting on

> **Register: register prose (imported)** — `valuation-exists`) are parked below, not killed — they re-enter ranking when the product

> **Register: register prose (imported)** — decision reopens.*

> **Register: register prose (imported)** — |---|---|---|---|---|---|

> **Register: register prose (imported)** — *`differentiated` demoted from `UNDER TEST` 2026-07-22: blocked on sharpening since 2026-07-20

> **Register: register prose (imported)** — (as worded, "distinct" has no bar and no stated NO — per `SHARPEN-FIRST` it must be restated as

> **Register: register prose (imported)** — something a fact can falsify before dispatch; the "hours" estimate predates sharpening), and

> **Register: register prose (imported)** — deprioritized by `instrument-now-product-later`. Reachable once sharpened — not a kill.

> **Register: register prose (imported)** — `elicitation-works` and `candidates-generatable` demoted the same day for the same ruling:

> **Register: register prose (imported)** — both serve the sell-path/arrive-with-nothing case, which is parked.*

> **Register: register prose (imported)** — The criterion for sitting here: an outcome recorded in `LEDGER.md`, dated, with what was

> **Register: register prose (imported)** — rejected. `ASSERT` resolutions are marked permanently unproven per P3 — resolved is not the

> **Register: register prose (imported)** — same as validated.

> **Register: register prose (imported)** — |---|---|---|---|

> **Register: Reading ceiling (imported)** — Two joints are marked **`EXT-UNREACHABLE`**: reading the public web cannot touch them at any
level of quality, so no `EXT` finding may be accepted against them and neither may be resolved
by proxy. See [external signal design](../design/2026-07-20-external-signal-design.md) §7.
- **`already-knew`** — nobody publishes an honest account of building something they knew was
  unfounded. What is publishable is a tidy retrospective, which is worse than silence because it
  is confidently wrong in a consistent direction. This is the deepest premise in the stack and
  the entire reachable surface today cannot reach it.
- **`joint-is-non-obvious`** — needs a person, in a room, confirming at the time.
Both wait on the poke half.

> **Register: Resolution methods (imported)** — Five, matching P2 step 3 exactly: `EXT` (look it up in the world) · `INT` (check our own history and records) · `CONSTRUCT` (build the test) · `ASSERT` (owner's call) · `STRADDLE` (build all branches). `INT` was in use here before being defined in the manual — now defined in both.

> **Register: Notes (imported)** — - `ledger-used` is explicitly **not** resolvable by manual dogfooding: the claim is
  about auto-capture. Marked so it cannot be falsely closed.
- Nine joints resolve by `CONSTRUCT`. Manual mode exercises four of them.
- First three resolutions landed 2026-07-22, all by owner `ASSERT` (minutes each, after
  sitting open for two days — the lesson: cheap owner-ASSERT joints should be put to the
  owner immediately, not queued behind build work).

> **Register: Dissolved (imported)** — A joint that stopped being one question is a distinct outcome from a joint that got an answer.
Recorded here so it cannot later be misread as resolved.
- **`ingest-continuous`** — dissolved by decomposition 2026-07-20, not asserted. Under
  `TWO-MACHINES` ([external signal design](../design/2026-07-20-external-signal-design.md) §1a)
  it has two different correct answers: the Answerer is invoked by nature (nothing to answer
  when nothing is asked, and the invocation is register-driven rather than person-driven, so it
  does not degrade to on-demand research), the Wanderer is continuous or it is pointless.
