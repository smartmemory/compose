# JOINT REGISTER

> **CANON for joint state.** The vision doc (`docs/product/2026-07-20-what-to-build-vision.md` §9) points here and does not duplicate. Split is by kind: stable named reasoning lives there, live operational state lives here.
>
> **DISPOSABLE SCAFFOLDING.** This markdown store is a manual-mode learning substrate, **not** a fourth canon alongside `ideabox.md`, the vision store, and `feature.json`. Migration target *(re-ruled 2026-07-21, per `PROVIDER-SEAM` — [what-to-build §8k substrate ruling](../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives))*: **fluid-store provider records, written only by the `judgment_*` tools.** The local floor provider is expected to implement over the vision store's existing types — joint → `question`, decision/kill → `decision`, deliberation → `thread`, position → `idea` *or a new type (undecided — see below)* — with SmartMemory as the capability-rich provider backing the same records. Do not build tooling against these files; tooling is what turned the ideabox from a surface into a second source. *Ruled 2026-07-22 (owner, `decide: judgment-writer-provider-records`): the `judgment_*` writers front the local-floor provider directly from v1 — these files become projections; this banner is upheld over COMP-CANON-GUARD design.md's markdown-as-floor argument, which is overruled.*
>
> **OPEN MODELLING QUESTION — do not answer by drift:** is a *position* a new vision-store type, or an `idea` with joints attached? This is the same question WS-A asks about ideas, and answering it by accretion is how the current fragmentation happened.

**Last ranked:** 2026-07-22 · **Under test:** `joint-is-non-obvious` (exactly one, per `ONE-UNDER-TEST`)

Backfilled from the 2026-07-20 design session. Ranking is by value of information
against cost — **and per Codex finding 1, VOI is not yet a computed quantity, so
the ordering below is judgment, not calculation.** Recorded as such rather than
dressed up.

## Under test

| Joint | Question | If TRUE | If FALSE | Resolve by | Cost |
|---|---|---|---|---|---|
| **joint-is-non-obvious** | Can it surface a joint the owner hadn't noticed? | Day one is valuable with an empty ledger | It reformats what you already said | `CONSTRUCT` — manual mode | days |

*Moved here 2026-07-22 (ledger: `rank: joint-is-non-obvious takes the UNDER TEST slot`,
`[AGENT]`, flagged for owner veto). Exercised for free in every working session; criterion
already defined (owner confirms, at the time — owner is the adjudicator); directly serves the
nearest-term success criterion under the months horizon. Runner-up: `already-knew` via `INT`.*

*`differentiated` vacated the slot the same day: it had been blocked on sharpening since
2026-07-20 (P3 forbids a stuck item holding the queue), and `instrument-now-product-later`
deprioritized it — see below.*

## Open — high

| Joint | Question | If TRUE | If FALSE | Resolve by | Cost |
|---|---|---|---|---|---|
| **already-knew** | Do bad build decisions come from unexamined reasoning, or do people know and build anyway? | Judgment layer is the product | Value is recovery, not foresight | `INT` — own decision history · **`EXT-UNREACHABLE`** | days |
| **valuation-exists** | How is worth established at all? | Advisor product works | Arrive-with-nothing cannot ship | `CONSTRUCT` | weeks |
| **external-reachable** | Can external signal be acquired at useful quality? | Generation is real; straddling works | Asserted-only; flattery risk returns | `CONSTRUCT` | weeks |
| **sensitivity-computable** | Can "which claim flips the conclusion" be computed reliably? | Branching engine works | Multiplies garbage | `CONSTRUCT` | weeks |
| **straddle-reaches-trunk** | Can strategy-level branches be built in parallel cheaply? | Straddling reaches decisions that matter | Leaf-level tool only | `CONSTRUCT` | weeks |

*Re-weighted 2026-07-22 under `instrument-now-product-later` + the months horizon: sell-path
joints (`elicitation-works`, `candidates-generatable`, arrive-with-nothing weighting on
`valuation-exists`) are parked below, not killed — they re-enter ranking when the product
decision reopens.*

## Open — medium

| Joint | Question | If TRUE | If FALSE | Resolve by | Cost |
|---|---|---|---|---|---|
| **construction-discipline** | Does construction resolve joints, or degrade into "build it and see"? | Execution-as-instrument works | Most expensive failure mode in the design | `CONSTRUCT` — observe own discipline | days |
| **conviction-inferred** | Does auto-capture infer conviction accurately? | Ledger is trustworthy | Timestamped fiction; needs confirmation UX | `CONSTRUCT` — **live test running: LEDGER conviction fields are agent-inferred and awaiting owner correction** | hours |
| **entry-threshold** | What earns a ledger entry? | Threshold holds, volume stays usable | Volume rot, faster than manual | `CONSTRUCT` | days |
| **calibration-timely** | Is calibration signal obtainable in useful time? | Self-grading is real | Substitute the 6-week usage proxy permanently | `INT` — own history | days |
| ~~**ingest-continuous**~~ | ~~Continuous or invoked ingestion?~~ | — | — | **DISSOLVED 2026-07-20** | — |
| **ledger-used** | Does an **auto-captured** ledger get used? | Byproduct model works | Dies to the decision-journal abandonment curve | `CONSTRUCT` — **NOT closable in manual mode**; the claim is about auto-capture | weeks |
| **differentiated** | Distinct from Productboard / Aha! / Dovetail? | Proceed | Reposition or kill | `EXT` — **blocked on sharpening** | hours |
| **elicitation-works** | Can context + objective be elicited in one conversation? | Day-one works, no accumulation needed | Only serves users who already have a candidate | `CONSTRUCT` | days |
| **candidates-generatable** | Can candidates be generated, or must the owner supply them? | Generation layer is real | Evaluation-only system | `CONSTRUCT` | weeks |

*`differentiated` demoted from `UNDER TEST` 2026-07-22: blocked on sharpening since 2026-07-20
(as worded, "distinct" has no bar and no stated NO — per `SHARPEN-FIRST` it must be restated as
something a fact can falsify before dispatch; the "hours" estimate predates sharpening), and
deprioritized by `instrument-now-product-later`. Reachable once sharpened — not a kill.
`elicitation-works` and `candidates-generatable` demoted the same day for the same ruling:
both serve the sell-path/arrive-with-nothing case, which is parked.*

## Resolved

The criterion for sitting here: an outcome recorded in `LEDGER.md`, dated, with what was
rejected. `ASSERT` resolutions are marked permanently unproven per P3 — resolved is not the
same as validated.

| Joint | Resolved | By | Outcome (ledger entry) |
|---|---|---|---|
| **commercial-intent** | 2026-07-22 | `ASSERT` — owner | Instrument now, product later; sell-path concerns parked, not killed (`decide: instrument-now-product-later`) |
| **horizon** | 2026-07-22 | `ASSERT` — owner | Months — payoff within 2026; ranking favors cheap fast-resolving joints (`decide: horizon-months`) |
| **success-criteria** | 2026-07-22 | `ASSERT` — owner | All four criteria count, tiered by timescale; "changed a real build decision" is nearest-term (`decide: success-criteria-all-four`) |

## Dissolved

A joint that stopped being one question is a distinct outcome from a joint that got an answer.
Recorded here so it cannot later be misread as resolved.

- **`ingest-continuous`** — dissolved by decomposition 2026-07-20, not asserted. Under
  `TWO-MACHINES` ([external signal design](../design/2026-07-20-external-signal-design.md) §1a)
  it has two different correct answers: the Answerer is invoked by nature (nothing to answer
  when nothing is asked, and the invocation is register-driven rather than person-driven, so it
  does not degrade to on-demand research), the Wanderer is continuous or it is pointless.

## Reading ceiling

Two joints are marked **`EXT-UNREACHABLE`**: reading the public web cannot touch them at any
level of quality, so no `EXT` finding may be accepted against them and neither may be resolved
by proxy. See [external signal design](../design/2026-07-20-external-signal-design.md) §7.

- **`already-knew`** — nobody publishes an honest account of building something they knew was
  unfounded. What is publishable is a tidy retrospective, which is worse than silence because it
  is confidently wrong in a consistent direction. This is the deepest premise in the stack and
  the entire reachable surface today cannot reach it.
- **`joint-is-non-obvious`** — needs a person, in a room, confirming at the time.

Both wait on the poke half.

## Resolution methods

Five, matching P2 step 3 exactly: `EXT` (look it up in the world) · `INT` (check our own history and records) · `CONSTRUCT` (build the test) · `ASSERT` (owner's call) · `STRADDLE` (build all branches). `INT` was in use here before being defined in the manual — now defined in both.

## Notes

- `ledger-used` is explicitly **not** resolvable by manual dogfooding: the claim is
  about auto-capture. Marked so it cannot be falsely closed.
- Nine joints resolve by `CONSTRUCT`. Manual mode exercises four of them.
- First three resolutions landed 2026-07-22, all by owner `ASSERT` (minutes each, after
  sitting open for two days — the lesson: cheap owner-ASSERT joints should be put to the
  owner immediately, not queued behind build work).
