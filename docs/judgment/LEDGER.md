# Judgment Ledger

> **Ledger banner (imported)** — # LEDGER
Append-only. Decisions, kills, overrides, escalations — dated, with **what was
rejected** and **conviction at the time**, the two fields `NEVER-CAPTURED-BEFORE`
identifies as the point of the whole artifact.
**Conviction entries below are agent-inferred from conversation, not stated by the
owner.** That makes this backfill a live test of `JOINT: conviction-inferred` —
corrections are the signal, so please overwrite anything wrong rather than letting
it stand.

## 1. note: Ledger banner (imported)

# LEDGER
Append-only. Decisions, kills, overrides, escalations — dated, with **what was
rejected** and **conviction at the time**, the two fields `NEVER-CAPTURED-BEFORE`
identifies as the point of the whole artifact.
**Conviction entries below are agent-inferred from conversation, not stated by the
owner.** That makes this backfill a live test of `JOINT: conviction-inferred` —
corrections are the signal, so please overwrite anything wrong rather than letting
it stand.

- anchor: ledger-header

*2026-07-20T12:00:00Z · via import*

## 2. note: Ledger section: 2026-07-20 — Session 1 (backfilled) (imported)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 3. decide: layer-above-execution — The layer above execution is what to build next

**Decided.** Compose's goal→execution half works and is mechanical; the unclaimed
ground is deciding what the goal should be.
**Rejected:** treating the front half as idea storage and sorting.
**Conviction:** high *(inferred — asserted early and never revisited)*

- rejected: [{"what":"treating the front half as idea storage and sorting.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 4. decide: ledger-is-the-output — The product's output is a testable ledger, not a decision aid

**Rejected:** "research + idea management" framing (two write-heavy read-poor
stores, both already exist here); the reasoning-aid framing (dies to `already-knew`).
**Conviction:** high *(inferred — owner reframed it himself as "a ledger that can be
tested independently")*

- rejected: [{"what":"\"research + idea management\" framing (two write-heavy read-poor stores, both already exist here); the reasoning-aid framing (dies to `already-knew`).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 5. kill: exhaust-as-idea-source — build exhaust as the source of ideas

**Reason:** closed loop. Exhaust reveals how you build, never whether anyone wants
it. No path to market truth.
**Survives as:** one evidence type; `AGENT-IN-THE-ROOM`; `MOAT-FINAL-FORM`.
**Conviction:** high, and owner-initiated — he parked the moat claim before the
argument was made.

*2026-07-20T12:00:00Z · via import*

## 6. kill: revealed-preference — worth is revealed by the owner's choices

**Reason (owner):** contradicts the product's own premise. If people decide badly
under uncertainty, their choices encode guessing, not preference. Fitting a model
to that and returning it as "your taste" is the flattery engine wearing statistics.
**Rejected alternatives in this thread:** worth is computable from goal+constraints;
worth is elicited then applied. Both also dead.
**Now:** `WORTH-IS-CONSTRUCTED`.
**Conviction:** high. This was the sharpest correction of the session.

*2026-07-20T12:00:00Z · via import*

## 7. kill: four-more-framings — three further framings (migrated from the vision doc §11)

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

*2026-07-20T12:00:00Z · via import*

## 8. decide: straddle — Joints are branch points; straddling is a fourth disposition

**Owner-originated.** Don't resolve the joint — build all its branches, let reality
pick. Requires no foresight.
**Conviction:** high.

- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 9. decide: one-under-test — One joint under test at a time

**Owner-originated** ("we limit N to 1?"). Refined to: many joints open, experiment
queue depth 1.
**Conviction:** high.

- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 10. decide: execution-as-instrument — Execution is an instrument for resolving decisions

Construction is a third resolution method alongside evidence and assertion, and the
one nothing else can offer.
**Conviction:** high.

- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 11. decide: max-smartmemory — Lean on SmartMemory maximally

**Rejected:** rebuilding storage/typing/evolvers. **Constraint kept:** kitchen stays
headless.
**Conviction:** high — stated flatly ("I'd say maximize").

- rejected: [{"what":"rebuilding storage/typing/evolvers. **Constraint kept:** kitchen stays headless.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-20T12:00:00Z · via import*

## 12. open: product-boundary — product boundary

Not decided. Reopened by owner after being recorded as settled.
**Positions on the table:** layer inside Compose · two interoperating products ·
one repo, separate packages (evidenced by `compose-mcp`).
**Owner's live objection:** it is harder to split a monolith, and packaging is
independent of architecture.
**Conviction:** deliberately unresolved. See `positions/product-boundary.md`.

*2026-07-20T12:00:00Z · via import*

## 13. decide: manual-mode-first — Manual mode before building

Run the six processes by hand; the friction is the automation spec.
**Conviction:** high, owner-originated.

- conviction: {"level":"high","source":"stated"}

*2026-07-20T12:00:00Z · via import*

## 14. decide: unguarded-writes — Freeform markdown as the agent's write path is the defect

**Owner-originated** ("how can compose/stratum enforce you if your primary mode is
freeform markdown?"). Enforcement the agent can route around is not enforcement.
**Evidence:** this session's four structural failures all arrived through unguarded
direct writes.
**Decided:** tools own the canonical write path; markdown is emitted as a
projection; a PreToolUse hook blocks direct writes to canonical paths.
**Rejected:** markdown-primary with advisory guard (enforcement theatre).
**Conviction:** high. Strongest correction of the session's second half.

- rejected: [{"what":"markdown-primary with advisory guard (enforcement theatre).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 15. decide: lifecycle-vs-semantics — Guard owns lifecycle, SmartMemory owns semantics

**Decided.** Stratum guard = where a position sits, enforced, domain-agnostic.
SmartMemory = claims, evidence, reasoning, supersession, contradiction.
Transitions write into SmartMemory one-way as an artifact side-effect.
**Rejected:** storing lifecycle state in both (the ideabox failure a third time);
bidirectional sync.
**Conviction:** high.

- rejected: [{"what":"storing lifecycle state in both (the ideabox failure a third time); bidirectional sync.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 16. decide: stratum-agnostic — Stratum stays domain-agnostic; one exception goes upstream

**Decided.** No judgment primitives inside Stratum — it must not learn what a joint
is. **Exception:** `ONE-UNDER-TEST` is a population invariant and is generic
(deploys, migrations want it too) → contribute upstream.
**Rejected:** building position/joint/conviction primitives into Stratum itself.
**Conviction:** high, argued from encapsulation.

- rejected: [{"what":"building position/joint/conviction primitives into Stratum itself.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 17. note: note: okf-set-aside — OKF set aside (imported as note)

Google Open Knowledge Format — postdates the agent's knowledge cutoff; owner
directed it as secondary. **Not evaluated.** Recorded so it is not silently dropped.

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 18. note: Ledger section: Overrides (imported)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 19. override: maintenance-objection — 2026-07-20 — Owner waived `nobody-maintains-structured-reasoning`

The strongest empirical objection to the whole product (argument mapping, decision
journals, premortems — all correct, all abandoned). **Waived by fiat**, recorded as
an owner assertion of latent demand.
**Open joints at time of override:** the objection itself, plus the then-unaddressed
maintenance-burden question.
**Flips if:** real users refuse to maintain it. Partially answered later by
`AUTOMATION-IS-FREE` (byproduct, not chore).
**Per `OVERRIDES-ARE-GOLD`, this is the highest-value entry in this file.**

- reason: The strongest empirical objection to the whole product (argument mapping, decision

*2026-07-20T12:00:00Z · via import*

## 20. note: Ledger section: Escalations (imported)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 21. escalate: output-unit-was-wrong — 2026-07-20 — Design work invalidated the layer above it

**Trigger:** owner observation that the four proposed output-units were all "how to
build", not "what to build".
**Propagated to:** product position. Forced restatement of the entire top level.
**Classification:** wrongness, not difficulty.

*2026-07-20T12:00:00Z · via import*

## 22. escalate: two-layers-missing — 2026-07-20 — Adversarial review invalidated the stated scope

**Trigger:** independent review found no option generation and no objective function.
**Propagated to:** product position → the three-layer stack.
**Classification:** wrongness.

*2026-07-20T12:00:00Z · via import*

## 23. escalate: revealed-preference-killed — 2026-07-20 — Owner objection invalidated a just-recorded claim

**Trigger:** revealed-preference argument contradicted the product premise.
**Propagated to:** the valuation approach (killed and replaced).
**Classification:** wrongness. Note the interval: recorded and killed within minutes.

*2026-07-20T12:00:00Z · via import*

## 24. note: Ledger section: Agent calibration (imported)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 25. calibrate: self-grading-ran-generous — 2026-07-20

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

*2026-07-20T12:00:00Z · via import*

## 26. calibrate: self-grading-ran-generous-again — 2026-07-20

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

*2026-07-20T12:00:00Z · via import*

## 27. calibrate: editing-passes-are-not-converging — 2026-07-20

Three reviews: 10 defects → 5 fixed, 5 partial, ~6 new. **Not converging.** Per the
project's existing rule, non-convergence under review means **the spec is too broad**,
not that the editing was careless. Diagnosis: the manual specifies six processes resting
on four quantities that do not exist (worth, VOI, reversibility, budget), so every patch
to a downstream step creates a fresh dangling reference upstream.
**Implication:** stop editing; cut scope to what is runnable (P1a + P2) and let the rest
be specified from evidence collected by running it.

*2026-07-20T12:00:00Z · via import*

## 28. calibrate: review-precision-scales-with-concreteness — 2026-07-20

Three adversarial passes, same reviewer, same day:
| Artifact | Result |
|---|---|
| Strategy/vision doc | 9 of 10 graded FATAL; ~half survived adjudication — mostly noise |
| Process manual (concrete procedures) | 10 findings, nearly all valid |
| Re-review against named prior findings | 10 valid + 2 new defects found |
**Implication:** adversarial review sharpens as the artifact gets more concrete.
Spend the call on procedures and specs; discount it heavily on visions.

*2026-07-20T12:00:00Z · via import*

## 29. note: Ledger section: 2026-07-20 — Session 2 (external signal, read half) (imported)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 30. note: Ledger prose (imported)

Design: [External Signal — Acquisition Design](../design/2026-07-20-external-signal-design.md)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 31. decide: internet-is-all — The public web is the entire reachable surface today

**Decided by owner** ("the internet right now, that's all we have isn't it"), in place of
the question actually asked (`commercial-intent`). The sell-vs-own fork was **dropped as
not yet load-bearing**: either way the reachable surface today is identical. `commercial-intent`
stays open in the register, undiminished.
**Rejected:** designing acquisition against users, telemetry, or a market panel — none exist.
**Conviction:** high *(owner's own words, offered unprompted against a different question)*

- rejected: [{"what":"designing acquisition against users, telemetry, or a market panel — none exist.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-20T12:00:00Z · via import*

## 32. decide: read-then-poke — The web is two instruments; read now, poke second

Reading is observational and free; poking (publish, contact, ship-and-watch) is
interventional and is the only thing that can answer a question nobody has answered in
public. Owner chose read-designed-in-full-now, poke-bolted-on-after, with provenance
carried from day one so the seam exists before it is needed.
**Rejected:** read-only permanently (leaves the deepest premise unreachable with no plan);
both-halves-now (slowest, and the poke half is an exposure decision, not a design one).
**Conviction:** high *(explicit selection between three stated options)*

- rejected: [{"what":"read-only permanently (leaves the deepest premise unreachable with no plan); both-halves-now (slowest, and the poke half is an exposure decision, not a design one).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-20T12:00:00Z · via import*

## 33. decide: two-machines — Two ingestion machines with separate budgets, not one filtered pipe

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

- rejected: [{"what":"one narrow pipe with the ceiling recorded as a known hole; one pipe with \"standing curiosity\" alongside the joints — rejected because the joints and the hobbies share a budget, and the joints always win when busy, arriving back at option one unnoticed.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-20T12:00:00Z · via import*

## 34. decide: sharpen-first — A joint may not be dispatched to `EXT` until a fact could settle it

Three things written before anything is fetched: a restatement a fact can falsify, the bar,
and what result would mean NO. Where a joint genuinely cannot be sharpened it still dispatches,
but the bar is written anyway and the result is stamped `JUDGMENT-NOT-EVIDENCE`, permanently
and visibly, wherever it is later cited.
**Rejected:** register stays loose and the machine shows its work (puts the judgment call on
the owner every time — does not scale); no gate at all (status quo).
**Conviction:** high *(owner chose the "both" option explicitly)*

- rejected: [{"what":"register stays loose and the machine shows its work (puts the judgment call on the owner every time — does not scale); no gate at all (status quo).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-20T12:00:00Z · via import*

## 35. correct: not-bias-but-threshold — The reading machine is not biased; it is handed unanswerable questions

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

*2026-07-20T12:00:00Z · via import*

## 36. open: ingest-continuous — dissolved by decomposition, not resolved

`JOINT: ingest-continuous` asked *continuous or invoked?* as one global choice. Under
`TWO-MACHINES` it has two different correct answers: the Answerer is invoked by nature
(nothing to answer when nothing is asked), the Wanderer is continuous or it is pointless.
Recorded as **dissolved**, not asserted. A joint that stopped being one question is a
distinct outcome from a joint that got an answer.

*2026-07-20T12:00:00Z · via import*

## 37. open: reading-ceiling — Two joints are permanently unreachable by reading

`already-knew` (nobody publishes an honest account of building something they knew was
unfounded — what is publishable is a tidy retrospective, worse than silence because it is
confidently wrong in a consistent direction) and `joint-is-non-obvious` (needs a person in a
room, at the time). Both marked `EXT-UNREACHABLE` in the register. Neither may be resolved by
proxy. `already-knew` is the deepest premise in the stack and the entire reachable surface
today cannot touch it.

*2026-07-20T12:00:00Z · via import*

## 38. escalate: differentiated-is-not-ext — the live joint is not currently an `EXT` question

`differentiated` sits `UNDER TEST` tagged `EXT` on the grounds that it is the only joint
resolvable by external evidence at hours-scale. Under `SHARPEN-FIRST` it fails the gate in its
present wording: *"distinct from Productboard / Aha! / Dovetail?"* has no bar and no stated NO.
**Not a kill.** It is reachable once sharpened. But it cannot be dispatched as written, and the
"hours" cost estimate was made against the unsharpened version.

*2026-07-20T12:00:00Z · via import*

## 39. note: Ledger section: Process failures (recorded, per `RECORD-ALWAYS`) (imported)

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 40. note: Ledger prose (imported)

- **Stratum not used** despite `capabilities.stratum: true` and an explicit CLAUDE.md

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 41. note: Ledger prose (imported)

mandate. Classification made once at session start and never re-evaluated when the

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 42. note: Ledger prose (imported)

work became artifact production. Cost: five of ten review findings were internal

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 43. note: Ledger prose (imported)

self-contradictions — the class postcondition checks exist to catch.

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 44. note: Ledger prose (imported)

- **Codex probe lost** (~27k tokens) to a dead job handle. Now documented in memory.

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 45. note: Ledger prose (imported)

- **Boundary decision recorded as settled when it was not.** Caught by the owner.

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 46. note: Ledger prose (imported)

- **Stratum not used, session 2 — plumbing, not classification.** Re-evaluated correctly at the

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 47. note: Ledger prose (imported)

conversation→artifact transition this time (per the memory rule written after session 1), and

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 48. note: Ledger prose (imported)

`stratum_plan` / `stratum_validate` both rejected the spec at the MCP boundary with

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 49. note: Ledger prose (imported)

`SCHEMA_INVALID` / `Expected object, received string` at path `""`. The `spec` parameter is

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 50. note: Ledger prose (imported)

declared untyped (`{}`) in the tool schema and the bridge passes the value through as a raw

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 51. note: Ledger prose (imported)

string without parsing, so the server's object check fails before it sees a single step.

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 52. note: Ledger prose (imported)

Reproduced with both YAML and compact valid JSON. **Not a spec-authoring error** — worth a

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 53. note: Ledger prose (imported)

stratum-side issue, and it means the mandate is currently unfollowable from this client.

- anchor: ledger

*2026-07-20T12:00:00Z · via import*

## 54. note: Ledger section: 2026-07-22 — Session 3 (owner rulings: five elicited decisions) (imported)

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 55. note: Ledger prose (imported)

Context: a top-down review found the register's three cheapest joints (all `ASSERT` — owner,

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 56. note: Ledger prose (imported)

all costed at minutes) unresolved since 2026-07-20, plus two decisions gating the judgment

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 57. note: Ledger prose (imported)

writer (COMP-CANON-GUARD OQ1; the writer-substrate contradiction between that feature's

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 58. note: Ledger prose (imported)

design.md and this register's banner). All five were put to the owner as explicit structured

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 59. note: Ledger prose (imported)

questions and answered in one sitting. Decisions are the owner's; prose is agent-recorded.

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 60. decide: instrument-now-product-later — resolves `JOINT: commercial-intent`

**Decided (owner, elicited):** the judgment layer is an instrument for the owner's own
building first; product-ization is a later, separate decision. Build for this operator now,
but record decisions so the sell path is not foreclosed.
**Consequence:** differentiation, onboarding, cold start, and arrive-with-nothing are
**parked, not killed** — they stop driving ranking until the product decision reopens.
`differentiated` loses its claim to the `UNDER TEST` slot (it was also blocked on sharpening).
**Rejected:** product-to-sell now (would keep differentiation load-bearing); pure own-instrument
with no recorded sell-path optionality.
**Conviction:** high *(inferred — chose the sequenced option over both poles without hedging)*

- rejected: [{"what":"product-to-sell now (would keep differentiation load-bearing); pure own-instrument with no recorded sell-path optionality.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-22T12:00:00Z · via import*

## 61. decide: horizon-months — resolves `JOINT: horizon`

**Decided (owner, elicited):** the payoff horizon is **months — within 2026**. Ranking gains
a time dimension: cheap, fast-resolving joints and quick wins outrank patient infrastructure.
**Rejected:** 1–2 years; open-ended/compounding.
**Conviction:** medium-high *(inferred — single-choice answer, no elaboration offered)*

- rejected: [{"what":"1–2 years; open-ended/compounding.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-22T12:00:00Z · via import*

## 62. decide: success-criteria-all-four — resolves `JOINT: success-criteria`

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

- rejected: [{"what":"nothing — the owner selected every option, which is itself signal: no single proxy is accepted as sufficient.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-22T12:00:00Z · via import*

## 63. decide: oq1-agent-only-v1 — resolves COMP-CANON-GUARD Open Question 1

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

- rejected: [{"what":"session flag at bind (agent in the session inherits the tag — weakest guarantee); per-write confirmation (most friction); a separate owner-only MCP surface (new surface with no traffic to justify it).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-22T12:00:00Z · via import*

## 64. decide: judgment-writer-provider-records — the substrate tie-break (was a live

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

- rejected: [{"what":"markdown-as-floor (faster, but builds tooling against disposable scaffolding — the exact ideabox failure); deferring the writer until COMP-PLAN-IDEA-UNIFY lands (leaves the 88%-unaccounted failure mode live every session).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-22T12:00:00Z · via import*

## 65. decide: okf-adopted-for-projections — reverses `note: okf-set-aside` (2026-07-20)

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

- rejected: [{"what":"OKF as the record/canon format (frontmatter parsing as enforcement is weaker than JSON schema); forcing OKF onto aggregate surfaces.","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-20T12:00:00Z · via import*

## 66. decide: judgment-records-under-docs — floor home ratified by delegation (2026-07-22)

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

- rejected: [{"what":"vision-store substrate (gitignored — the substrate ruling's stated expectation, deviated from on this evidence); tracked top-level `.compose/*.json` (sandbox-invisible); changing the gitignore convention (touches every existing store).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T12:00:00Z · via import*

## 67. decide: assert-elicitation-amendment — owner ratified 2026-07-22 (amends `oq1-agent-only-v1`)

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

- rejected: [{"what":"total ASSERT ban until S4 (breaks P1a step 3 and the golden flow); uncited ASSERT (honour-system tagging — the 2026-07-21 failure class).","why":"recorded in the imported entry body"}]
- conviction: {"level":"high","source":"inferred"}

*2026-07-22T12:00:00Z · via import*

## 68. note: rank: joint-is-non-obvious takes the UNDER TEST slot `[AGENT]` — flagged for owner veto (imported as note)

Per P3, resolving three joints forces a re-rank and the marker must move; `differentiated`
also could not hold the slot (blocked on sharpening — P3 forbids a stuck item holding the
queue). **Picked:** `joint-is-non-obvious` (CONSTRUCT via manual mode, days). **Nearly
picked:** `already-knew` via `INT` over our own decision history — it is the deeper premise.
**What decided it:** `joint-is-non-obvious` is exercised for free in every working session,
its criterion is already defined with the owner as adjudicator, and it directly serves the
nearest-term success criterion (changed a real build decision) under the months horizon.
`already-knew` needs a deliberate INT excavation — worth queueing next.

- anchor: ledger

*2026-07-22T12:00:00Z · via import*

## 69. note: Register banner (imported)

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

- anchor: register-header

*2026-07-22T12:00:00Z · via import*

## 70. note: Register: register prose (imported)

|---|---|---|---|---|---|

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 71. note: Register: register prose (imported)

*Moved here 2026-07-22 (ledger: `rank: joint-is-non-obvious takes the UNDER TEST slot`,

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 72. note: Register: register prose (imported)

`[AGENT]`, flagged for owner veto). Exercised for free in every working session; criterion

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 73. note: Register: register prose (imported)

already defined (owner confirms, at the time — owner is the adjudicator); directly serves the

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 74. note: Register: register prose (imported)

nearest-term success criterion under the months horizon. Runner-up: `already-knew` via `INT`.*

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 75. note: Register: register prose (imported)

*`differentiated` vacated the slot the same day: it had been blocked on sharpening since

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 76. note: Register: register prose (imported)

2026-07-20 (P3 forbids a stuck item holding the queue), and `instrument-now-product-later`

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 77. note: Register: register prose (imported)

deprioritized it — see below.*

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 78. note: Register: register prose (imported)

|---|---|---|---|---|---|

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 79. note: Register: register prose (imported)

*Re-weighted 2026-07-22 under `instrument-now-product-later` + the months horizon: sell-path

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 80. note: Register: register prose (imported)

joints (`elicitation-works`, `candidates-generatable`, arrive-with-nothing weighting on

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 81. note: Register: register prose (imported)

`valuation-exists`) are parked below, not killed — they re-enter ranking when the product

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 82. note: Register: register prose (imported)

decision reopens.*

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 83. note: Register: register prose (imported)

|---|---|---|---|---|---|

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 84. note: Register: register prose (imported)

*`differentiated` demoted from `UNDER TEST` 2026-07-22: blocked on sharpening since 2026-07-20

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 85. note: Register: register prose (imported)

(as worded, "distinct" has no bar and no stated NO — per `SHARPEN-FIRST` it must be restated as

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 86. note: Register: register prose (imported)

something a fact can falsify before dispatch; the "hours" estimate predates sharpening), and

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 87. note: Register: register prose (imported)

deprioritized by `instrument-now-product-later`. Reachable once sharpened — not a kill.

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 88. note: Register: register prose (imported)

`elicitation-works` and `candidates-generatable` demoted the same day for the same ruling:

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 89. note: Register: register prose (imported)

both serve the sell-path/arrive-with-nothing case, which is parked.*

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 90. note: Register: register prose (imported)

The criterion for sitting here: an outcome recorded in `LEDGER.md`, dated, with what was

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 91. note: Register: register prose (imported)

rejected. `ASSERT` resolutions are marked permanently unproven per P3 — resolved is not the

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 92. note: Register: register prose (imported)

same as validated.

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 93. note: Register: register prose (imported)

|---|---|---|---|

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 94. note: Register: Reading ceiling (imported)

Two joints are marked **`EXT-UNREACHABLE`**: reading the public web cannot touch them at any
level of quality, so no `EXT` finding may be accepted against them and neither may be resolved
by proxy. See [external signal design](../design/2026-07-20-external-signal-design.md) §7.
- **`already-knew`** — nobody publishes an honest account of building something they knew was
  unfounded. What is publishable is a tidy retrospective, which is worse than silence because it
  is confidently wrong in a consistent direction. This is the deepest premise in the stack and
  the entire reachable surface today cannot reach it.
- **`joint-is-non-obvious`** — needs a person, in a room, confirming at the time.
Both wait on the poke half.

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 95. note: Register: Resolution methods (imported)

Five, matching P2 step 3 exactly: `EXT` (look it up in the world) · `INT` (check our own history and records) · `CONSTRUCT` (build the test) · `ASSERT` (owner's call) · `STRADDLE` (build all branches). `INT` was in use here before being defined in the manual — now defined in both.

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 96. note: Register: Notes (imported)

- `ledger-used` is explicitly **not** resolvable by manual dogfooding: the claim is
  about auto-capture. Marked so it cannot be falsely closed.
- Nine joints resolve by `CONSTRUCT`. Manual mode exercises four of them.
- First three resolutions landed 2026-07-22, all by owner `ASSERT` (minutes each, after
  sitting open for two days — the lesson: cheap owner-ASSERT joints should be put to the
  owner immediately, not queued behind build work).

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 97. note: Register: Dissolved (imported)

A joint that stopped being one question is a distinct outcome from a joint that got an answer.
Recorded here so it cannot later be misread as resolved.
- **`ingest-continuous`** — dissolved by decomposition 2026-07-20, not asserted. Under
  `TWO-MACHINES` ([external signal design](../design/2026-07-20-external-signal-design.md) §1a)
  it has two different correct answers: the Answerer is invoked by nature (nothing to answer
  when nothing is asked, and the invocation is register-driven rather than person-driven, so it
  does not degrade to on-demand research), the Wanderer is continuous or it is pointless.

- anchor: register-footer

*2026-07-22T12:00:00Z · via import*

## 98. note: OBJECTIVE.md (imported prose)

# OBJECTIVE — what we are optimizing for

**Status:** DRAFT — `[ASSERT]`, inferred by the agent, **NOT confirmed by the owner**
**Last reviewed:** 2026-07-20

> This file is itself a position with joints (`THE-GOAL-IS-A-POSITION`). It can be
> wrong, evidence can contradict it, and it must be defensible.

## Health warning

This was **not elicited** — it is back-inferred from one session's conversation.
Per `WORTH-IS-CONSTRUCTED`, an objective function assembled by the agent
from observed remarks is precisely the failure mode we named (the agent handing
the owner a tidied version of his own asides and calling it a goal). **Treat every
line below as a question, not a record.** First run of P1b should replace it.

## Draft objective

**Primary:** build Compose into a system that decides *what to build* well, not
just one that builds well. The back half (goal → shipped) works; the front half is
the unclaimed ground.

**Time horizon:** unstated. `[JOINT: horizon]`

**What success looks like:** unstated in measurable terms. `[JOINT: success-criteria]`

## Observed trade-off rankings (from behaviour this session, not stated)

| Ranked above | Ranked below | Evidence |
|---|---|---|
| Locking the top level | Shipping a first rung | Explicitly rejected "ship rung 1 and let contact answer the questions" as bottom-up drift |
| Correct framing | Sunk design work | Reopened the boundary decision after it was recorded as settled; killed four valuation framings |
| Being argued with | Being agreed with | Rejected the revealed-preference argument on its merits; asked for adversarial passes unprompted |
| Reuse of existing machinery | Greenfield construction | "How much can we reuse and from where" made the deciding criterion for the boundary |
| Honest uncertainty | Confident delivery | Repeatedly pushed back on premature certainty |

## Open joints on this objective

| Joint | Question | Status |
|---|---|---|
| `horizon` | Over what period does this need to pay off? | Unasked |
| `success-criteria` | What observable outcome would mean this worked? | Unasked |
| `commercial-intent` | Product to sell, or instrument for own building? Changes almost everything downstream | Unasked — **highest VOI on this file** |
| `self-report-reliable` | How much should the owner's stated objective be trusted vs constructed? | Partial read only (see LEDGER 2026-07-20) |

## Consistency tally

Too early. One session. Note for the record: within this session, stated
priorities and observed choices **did not diverge** — top-down framing was
asserted and then consistently enforced, including against the agent's own
proposals. That is one datapoint toward the reliable end of
`SELF-KNOWLEDGE-DIAL`, not a verdict.

- anchor: position:objective

*2026-07-20T12:00:00Z · via import*

## 99. note: judgment-layer.md (imported prose)

# POSITION — Build the judgment layer

**Held since:** 2026-07-20 · **Conviction:** high *(agent-inferred, unconfirmed)*
**Status:** not committed — no `feature.json`, deliberately

## Claim

Compose should grow the layer above goal→execution: deciding **what** to build.
Its output is a testable ledger of positions — claims, rejected alternatives,
conviction at the time — with the joints under each made explicit, branchable, and
resolvable by evidence, construction, or a marked assertion.

## The argument, with grounding per step

| # | Step | Grounding |
|---|---|---|
| 1 | Deciding what to build is high-stakes and often goes badly | `ASSERT` — uncontested but unevidenced |
| 2 | **It goes badly because the load-bearing assumption goes unchecked** | `ASSERT` — **the weak joint** (`already-knew`) |
| 3 | Surfacing that assumption therefore improves the outcome | derived from 2 |
| 4 | A human + agent pair can surface it reliably | `ASSERT` — `sensitivity-computable`, untested |
| 5 | Recording it changes what happens next | `ASSERT` — partly defused: `PREPARED-RECOVERY` means the *recovery* changes even if the decision doesn't |
| 6 | Compose is uniquely placed to do this | `ASSERT` — narrow form only: it is in the room when alternatives are rejected, and it can build the experiment |

**Load rests on step 2.** Steps 1 and 3 are cheap; 4 and 6 are testable; 2 is the
one that, if false, makes the rest decoration.

## Branches

- **If step 2 holds** → the judgment layer is the product. Build evaluation first,
  generation second.
- **If step 2 is false** (people know and build anyway) → the value is *recovery,
  not foresight*. The ledger and prepared alternatives survive; the joint-surfacing
  machinery becomes secondary. **Different product emphasis, not a dead one.**
- **If step 6 fails** (nothing unique about Compose's position) → commodity. See
  `positions/product-boundary.md` and `JOINT: differentiated`.

## What would change my mind

- Owner's own decision history showing he already knew the weak joint each time and
  proceeded regardless *and* would do so again → step 2 falsified.
- Manual mode running for three sessions without surfacing a joint he hadn't seen →
  step 4 falsified, step 2 undermined.
- Productboard/Aha!/Dovetail already doing the position-plus-joints thing → step 6
  falsified.

## Open joints

`already-knew` · `joint-is-non-obvious` · `sensitivity-computable` ·
`valuation-exists` · `elicitation-works` · `differentiated` *(under test)*

## Status note

Nothing here is committed. No `feature.json` exists and none should until the
under-test joint resolves and `valuation-exists` has at least a design.

- anchor: position:judgment-layer

*2026-07-20T12:00:00Z · via import*

## 100. note: product-boundary.md (imported prose)

# POSITION — Product boundary: separate product, or a layer in Compose?

**Status:** OPEN — deliberately unresolved
**Conviction:** low and *contested*. Recorded as settled 2026-07-20, **reopened by
the owner the same day.** That error is itself in the ledger (`open: product-boundary`).

## The question

Is the judgment layer a layer inside Compose, a separate product that interoperates,
or one repo with separate packages?

## Three candidates

| Option | For | Against |
|---|---|---|
| **Layer inside Compose** | The differentiator (construction-as-resolution) spans the boundary; dependency is already one-way; COMP-FOH set this precedent for Maya | "Extract later" is a promise codebases rarely keep — **verified: no extraction has ever happened in this repo** |
| **Two interoperating products** | Domain hands you the seam; packaging is independent of architecture, so it can still be sold as one thing | Boundary tax paid forever if the seam is wrong; premature |
| **One repo, separate packages** | **Evidenced to work here** — `compose-mcp` is published as `@smartmemory/compose-mcp` from inside this repo. Born separate, no extraction needed | Untested for a component this size |

## The joint that decides it

**`CONSTRUCTABILITY-LINE`** — the boundary follows whether a joint's
experiment can be built, not product-vs-non-product:

- **Pricing** — experiment *is* software. Full differentiator. Sweet spot.
- **Market entry** — landing pages, ad tests, segment waitlists. Sweet spot.
- **Hiring** — cannot build the experiment. Ledger works; differentiator doesn't. Commodity.

Pricing and market entry are **software decisions that are not product decisions**,
which widens the judgment layer's domain past Compose's build lifecycle — and
correspondingly weakens the inside-Compose argument. The construction arm starts to
look like a pluggable resolver rather than an inseparable core.

## Evidence gathered

- `[EXT]` No extraction precedent in this repo — only function-level refactors.
- `[EXT]` `compose-mcp` demonstrates born-separate packaging inside one repo works.
- `[ASSERT]` Owner: harder to split a monolith; packaging ≠ architecture.

## Branches

- **If constructability is the real line** → judgment engine as its own package,
  construction resolver as a swappable adapter, one repo.
- **If the judgment layer only ever serves software-product decisions** → the
  inside-Compose argument recovers and the seam is unnecessary.

## Open joints

`commercial-intent` (a product to sell vs an instrument for own building changes
this outright) · `straddle-reaches-trunk` · `differentiated`

## Note

This is the clearest instance in the corpus of a position whose conviction is
genuinely low and whose branches are live. Useful as a test case for whether the
format handles disagreement rather than just accumulation.

- anchor: position:product-boundary

*2026-07-20T12:00:00Z · via import*

## 101. decide: skill-is-first-consumer — the /competitors skill is the read-half’s first consumer, then retired

SmartMemory’s /competitors skill is a ~1-year-old running instance of the read-half, for a different product. Checked the paper design against it (external-signal-design §8b): it confirms TWO-MACHINES by being the one-machine failure the design avoids (wander demoted to leftover budget inside the scan); it runs the §2a unsharpened-threshold defect live (CRITICAL/HIGH with a machine-supplied bar; “went quiet” read as threat-reduction = SILENCE-NOT-SUPPORT violated); its GEO-audit is a poke mislabelled as a read, proving FOUND-OR-PROVOKED must be a field from day one; and it supplies the write-path the design left open (wander→idea pile, scan→action item mapped to a tracked claim). Owner directive: when the read-half is built, the skill becomes its first consumer and is retired in its favour — parity-first, run both in parallel, diff against the year of hand-maintained dossiers, retire only once the machine matches or beats the baseline. This is the cheapest honesty test of external-reachable, because it is a real market with fresh water (the one condition under which the Wanderer can be judged rather than assumed) and it has a ground-truth baseline.

- refs: ["docs/design/2026-07-20-external-signal-design.md#8c","~/.claude/skills/competitors/SKILL.md","smart-memory-docs/docs/product/competitors.md"]
- rejected: [{"what":"retire the hand skill before parity","why":"same kill-and-hope pattern WANDERER-KILL refuses, pointed at the wrong target"},{"what":"treat competitor tracking as a scope expansion of the judgment layer","why":"it is one instance of pointing the read-half at a register; SmartMemory’s competitors are that instance’s questions, not a new domain the layer learns"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T12:11:10.990Z*

## 102. correct: retire-not-gated-on-parity — switching off the old /competitors skill is not gated

Amends skill-is-first-consumer (seq 101) / external-signal-design §8c. The agent had gated retirement of the hand /competitors skill on weeks of parallel running until the machine matched-or-beat it. Owner overruled: "it’s ok to switch off the old one it’s not sacred." The skill is a convenience, not canon; running both in parallel was unwarranted caution. What survives the correction: the skill’s year of hand-judged dossiers is the cheapest ground-truth for testing external-reachable, and it is separable from keeping the skill alive — take a one-time snapshot at switch-off and diff the machine against that frozen baseline. Switch off whenever; just grab the snapshot first, because that is the only real cost of doing it carelessly and it costs nothing.

- refs: ["docs/design/2026-07-20-external-signal-design.md#8c"]

*2026-07-22T12:14:38.786Z*

## 103. kill: assert-to-elicit — the "be productively wrong, corrections load the facts" process

Killed same day it was proposed. The agent generalized one live session into a method: open with cheap wrong verdicts, let the owner’s corrections surface the facts. Owner’s kill reason: bad verdicts lose interest and credibility — a real owner does not stay to correct, they leave. The mechanism only appeared to work because the owner was grading a test and therefore tolerated bad verdicts. Worse, the generalization was self-serving: the agent had failed by asserting instead of asking, then built a framework in which asserting wrongly is the technique — converting its own failures into methodology. Survives as: nothing. Verdicts come after knowing, per P0.1.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md#p0"]

*2026-07-22T14:25:12.490Z*

## 104. decide: p0-basics — person first, listen before verdicts, research woven in, the goal is the deliverable

Codified as P0 in the process manual, overriding anything below it on conflict. Owner-taught during the first live run, extracted only after repeated misses: (0) know the person first and foremost — the unit is rarely one person; (1) learn the facts by listening, no verdicts before knowing; (2) research is part of goal-building, not a stage after it; (3) figuring out what the goal should be IS the deliverable — "which of N?" is a symptom of a missing goal, most people cannot state a goal in one sentence, and once the goal exists focus falls out mechanically. These interleave — no pipeline; the skill is knowing what would help right now. P1 entry detection amended: check for the goal before the candidate; candidates-without-goal routes to goal-construction.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md#p0"]
- rejected: [{"what":"staged pipeline (person → facts → research → goal)","why":"owner: research can be part of building the goal — the stages interleave; a flowchart is a substitute for judgment"},{"what":"goal captured at intake in one sentence","why":"owner: most people cannot say it — the goal is constructed over the work, never collected"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T14:25:12.520Z*

## 105. decide: crumbs-are-the-spine — the breadcrumb flow is the top-level structure; P1-P6 are maneuvers on it

The end-to-end trail (person → situation → goal takes shape → claims → the few that matter → settle/test/straddle → commit ∥ build → learnings back → world watching → revise/recover) is now the manual's spine, with a crumb→artifact→maneuver map. Entry detection re-ruled: locate the person on the trail, then enter there — the question asked is rarely the trail position. Corpus realigned, not just patched: P1b elicitation amended (opens the file, does not fill it; OBJECTIVE.md is a v1 draft, versioned per correction), vision NOTHING-MEANS-NO-IDEA first-hour claim amended, ELICIT-GENERATE- VALUE now ranks against the objective as constructed so far. New artifact type: person files (people/<name>.md), full cast, stated-vs-revealed separated, secondhand marked, stubs may not carry load — defined generically in the product; instances belong only in a user's project, never this repo. An earlier attempt wrote the live-run's specific people into this repo and was reverted same hour: the product process was the deliverable, not the test case's dossiers.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md"]
- rejected: [{"what":"patch only the single elicitation contradiction","why":"owner: \"the crumbs flow not just this one thing\" — realign the corpus to the spine, not spot-fix it"},{"what":"instantiate person files for the live-run cast inside this repo","why":"owner: the deliverable is the Compose ideation PRODUCT process — a test case's specifics are not product canon"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T14:36:15.145Z*

## 106. decide: bfs-top-down-design — design proceeds top-down BFS over a box map; DAGs where needed

Owner halted a depth-first dive into the situation-facts artifact before any floor plan existed ("we're building something without having even sketched out the boxes"). Method now: sketch the level-1 box map of the whole judgment layer first — eight stores (people, situation, goal, positions, register, resolutions, commit, ledger) and five machines (answerer, wanderer, poke half, sweep+postmortem, writer) with the feeds DAG — then flesh out each level breadth-first across all boxes before any box goes deeper. Box map accepted tentatively 2026-07-22. Two infra rulings made at level 1: (a) fact corrections fix the record in place with the old value visibly traced; (b) every store is written through the judgment-writer from day one — the Writer is the only door, markdown is a projection. This extends the unguarded-writes ruling from ledger/register/positions to all stores, including person files and situation.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md"]
- rejected: [{"what":"depth-first design of one artifact at a time","why":"owner: boxes must be sketched before any is detailed — top-down BFS, DAGs where needed"},{"what":"whole-file versioning for fact corrections","why":"reserved for OBJECTIVE.md where the goal's trajectory is the point; facts need current-truth-first readability with the trace inline"},{"what":"hand-markdown-first for new stores in manual mode","why":"owner chose tool-owned from day one — unguarded freeform writes are the defect already ruled on (unguarded-writes)"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:02:24.315Z*

## 107. decide: people-box-level-2 — person file shape: seven sub-boxes, provenance grammar, instruments

People box fleshed one level, breadth-first. Sub-boxes: role-and-unit (person files own their relationship edges; the whole-cast map is a rendered projection), life-situation (strengths, aversions, constraints, what they carry), stated, revealed, open-fields (interview-fill only), load (what rests on this person — makes stub-may-not-carry-load checkable), instruments. Cross-cutting provenance grammar, shared with situation when it is designed: every fact carries how-we-know (said / observed / secondhand-via-X / inferred) plus when; secondhand is a tag on a fact, not a section — a stated-fact-at-one-remove stays load-banned until the person speaks into their own file. Stated-vs-revealed divergences are recorded as pairs, never scores — extends PEOPLE-SCORING-PUNTED from postmortems to the file itself. Lifecycle binary: stub → spoken; no more states until a process demands one. Instruments: one elicitation engine, two surfaces (live interview / async self-paced quiz) — the quiz is the interview wearing a form costume, and the cheap path from stub to spoken for cast members an interview would be awkward to arrange with. Sequencing spends the fatigue budget on load not coverage, re-ranked after every answer; ranking is a collection point (no computation exists — record the judgment). Validated psychometric blocks are dropped in verbatim or not at all; dynamic between blocks only. Consent ladder: full instrument → highest-load basics woven into normal contact (plus an optional 2-minute validated short form) → silence leaves the stub a stub. Coarse profiles are never load-bearing alone — they inform how to ask, never substitute for the answer. Question banks are composite (intents, goals, situation, relationships); personality is one bank among several, demoted. In-house prior art and first instrument candidates: cofounder-fit, couples.team. Open joint, parked: dossier consent/privacy — what may be written, shown, or exported about non-consenting cast members; a product question, not a box-shape question. Open empirical: the whole instrument design is calibrated on one atypical, introspective owner; mainstream users may need something simpler, or richer — "we'll have to see"; watch, don't design.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md","docs/judgment/positions/judgment-layer.md"]
- rejected: [{"what":"cast map living in SITUATION.md, or dual-sourced in both","why":"one source of truth — person-owned edges with a rendered cast-map projection; 'both' is the two-store sync failure shape already seen in the ideabox"},{"what":"quiz as required intake gate","why":"rebuilds the interrogation P0 warns against; the instrument is an opt-in supplement — 'if they want better results'"},{"what":"trust scores or personality summaries carrying load","why":"scoring people stays punted; divergences land as paired facts, and coarse profiles only shape how the next question is asked"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:02:39.208Z*

## 108. decide: situation-box-level-2 — inside-out facts: entities, four-channel provenance, owed, load

Situation box fleshed one level, breadth-first. Sub-boxes: entities (named fact clusters — businesses, products, deals), facts (four-channel provenance + when, same grammar as person files), owed (named missing load-bearing facts — the situation-level twin of a person file's open fields; the live run's "partner's pipeline story, TrustFlow's monthly number"), load (which facts carry plans or claims, so a broken fact names what shakes). Boundary with People: facts about a person live in their person file; facts about shared things live in Situation — written once, cross-referenced, never duplicated. Boundary with the world: inside-out only. Situation holds what the cast owns, owes, and has committed to; outside-in facts (markets, competitors) arrive through the read-half as resolution evidence, per the DAG — the world feeds the Answerer and Wanderer, never Situation. A competitor's launch never becomes a situation fact; their own booked demos do. Storage: entity-tagged records behind the Writer; SITUATION.md is a projection grouped by entity — per-entity files vs one page is a rendering choice, not design. Staleness: facts carry dates, the P6 sweep ranks by judgment; no volatility metric invented at the desk. Corrections per seq 106 (fix-in-place with trace). Owner: accept and try; modify on evidence.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md"]
- rejected: [{"what":"admitting competitor/market facts as situation facts","why":"breaks the DAG — the outside world enters only through the read-half, which carries its own provenance and sharpening discipline"},{"what":"per-entity files as canonical storage","why":"records are canonical behind the Writer; grouping is a projection choice"},{"what":"a volatility score for staleness","why":"desk-invented quantity; dates plus sweep judgment collect the evidence a real rule would need — same collection-point discipline as ranking"}]
- conviction: {"level":"medium","source":"stated"}

*2026-07-22T15:06:39.504Z*

## 109. decide: goal-box-level-2 — versioning mechanics, churn handling, research-grounded

Goal box (OBJECTIVE.md) fleshed one level. Sub-boxes: current version (the goal in clauses, each clause a fact with four-channel provenance), trajectory (every prior version with its diff and its provocation in the owner's words), joints (the goal's own uncertainties, in the register like any position's). Core rules: clauses are facts under the shared grammar, and an inferred clause may not carry a commit — the stub rule's twin at the goal level; only the owner's voice cuts a version (agent drafts, owner ratifies; meaning changes version, wording does not); every version stores its provocation — the trajectory of provoked corrections is the first real content of WORTH-IS-CONSTRUCTED, with the assert-to-elicit kill intact (drafts after listening, never strategic wrong verdicts); no schema imposed on the goal. Churn handling, prompted by the owner's question "what would you do with someone who changes goals just because and frequently?" and grounded in a literature pass: (1) invariant projection — after enough versions, project what never moved; goal-hierarchy research (Carver & Scheier control theory) says subordinate means churn under stable superordinate ends is normal operation, and Keeney's value-focused thinking says most stated objectives are means — fundamentals surface via the "why is that important?" ladder, which joins the instrument banks; a flip that ladders to the same fundamental is means churn and recorded as such; fundamental-vs-means tags emerge from running the ladder, never required fields. (2) Oscillation converts to a joint — A→B→A on the same goal is the action-crisis signature (Brandstätter; Wrosch): persist-vs-disengage becomes an explicit register joint with branches and kill criteria instead of endless versioning; adaptive disengagement followed by reengagement is healthy and gets the bill plus prepared branches, never stigma. (3) Show the bill, never block — load links price every flip. (4) Commit guard: an irreversible commit may not quietly rest on a recently flipped clause — permitted, but presented as forced with open joints and clause stability listed. (5) Aspiration drift is expected — "enough" thresholds adapt with attainment (satisficing); threshold drift is normal versioning with its provocation recorded. (6) Elicitation constructs the answer (Lichtenstein & Slovic, procedure-invariance failures — external validation of WORTH-IS-CONSTRUCTED): record which instrument or question produced each clause; a clause that survives two different elicitation shapes outranks a single-method clause; instruments are not neutral. WATCH FOR: whether the invariant projection ever surprises the owner — the goal-level twin of joint-is-non-obvious.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md","docs/judgment/OBJECTIVE.md"]
- rejected: [{"what":"blocking or rate-limiting goal changes","why":"the goal is the owner's; only their voice cuts versions — the system shows the bill, it never gates the change"},{"what":"imposing a goal schema (horizon / enough-threshold / optionality fields)","why":"those emerged in the live run but stay observations — structure only when a process demands it"},{"what":"treating frequent goal-changing as a person defect","why":"hierarchy research says means churn under stable ends is normal self-regulation; oscillation is an action-crisis signal to be converted into a joint; scoring people stays punted"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:16:43.569Z*

## 110. correct: research-pass-per-box — every box gets a literature pass before its sketch locks

Amends bfs-top-down-design (seq 106). Owner, on seeing the Goal box grounded in goal-setting and decision literature: "there's opportunity to do research at every step of setting up this process, no?" Correct — and it is P0.2 applied to building the product itself: research is part of goal-building, and designing this system IS a goal-building exercise, so reasoning each box from the chair is exactly the failure P0.2 names. Method now: BFS per box = sketch → literature pass → bake, with the pass distilled to design-actionable imports only (validations, amendments, instrument banks), never literature reviews for their own sake. Research debt flagged on the two boxes baked before this rule: People (elicitation methodology, psychometric validity, survey design — bears directly on the Instruments sub-box) and Situation (evidence evaluation and provenance practice, e.g. intelligence-analysis source-grading). Both were accepted tentatively; their passes run when they are next touched, or sooner if cheap. Upcoming boxes inherit the rule: Resolutions gets value-of-information and experiment-design literature; the Poke half gets field-experiment and signaling literature.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md"]

*2026-07-22T15:17:43.408Z*

## 111. decide: resolutions-box-level-2 — package shape; sharpen-first everywhere; diagnosticity; VOI cap; sequential stopping

Resolutions box fleshed one level, research-grounded (VOI/decision analysis; Heuer's Analysis of Competing Hypotheses; Wald sequential analysis; open-science preregistration; practitioner riskiest-assumption-test cards). The package — one per joint put under test, a record behind the Writer, linked from the register: question (the sharpened joint — falsifiable restatement, the bar, what NO looks like), prediction (written before any evidence is gathered), evidence (items each carrying source, reliability, date, and which branch it points at), verdict (one of the four existing P3 outcomes plus who adjudicated). Five rulings: (1) sharpen-first generalizes from EXT to every disposition — INT is just as cherry-pickable as the web, and ASSERT records what was asked before the answer shapes it; grading against a moved bar is open science's named failure, outcome switching. (2) Diagnosticity per ACH: every evidence item scored against both branches; evidence consistent with both carries zero weight regardless of volume — kills confirmation-by-pile; extends STRADDLE-NEEDS-SIGNAL's logic to all evidence. (3) VOI cap: information's value is bounded by the decision change it could cause; the resolution spend ceiling is the branch difference, compared in the existing coarse buckets — gives ONE-COST-COMPARISON its missing comparator without inventing numbers. (4) Sequential stopping, not fixed-sample: evidence accumulates until it crosses the pre-written bar or the budget dies; makes Inconclusive-then-redispose normal operation, which P3's queue-freeing rule wanted but could not justify. (5) RAT-card convergence noted: product practice independently evolved the package shape (hypothesis/test/metric/criteria) — validation, nothing imported. Owner accepted.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md","docs/design/2026-07-20-external-signal-design.md"]
- rejected: [{"what":"sharpen-first as an EXT-only gate (status quo)","why":"INT and ASSERT are equally gameable without a pre-written bar; preregistration is disposition-agnostic"},{"what":"weighting evidence by volume or source count","why":"ACH: non-diagnostic evidence resolves nothing however much accumulates; only branch-discriminating items count"},{"what":"numeric VOI computation","why":"no probabilities or loss functions exist in the system; the cap comparison runs in coarse buckets, and the records collect what a real computation would need"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:32:38.085Z*

## 112. decide: writer-box-level-2 — the only door: new record kinds, generated projections, enforced invariants

Writer box fleshed one level, executing the owner's day-one tool-owned ruling (seq 106). The Writer grows from owning three files (ledger, register, positions) to the only door for every store. New record kinds: person (create, add-fact with channel, correct-with-trace, open-field, edge, load-link), situation (entity, fact with channel and entity tag, owed, load-link, correct), goal (version-cut owner-ratified only, clause ops with provenance, provocation stored per cut), resolution package (create with question and prediction first, evidence-append with diagnosticity, verdict). All projections generated, never hand-edited: people/*.md, SITUATION.md, OBJECTIVE.md, packages. The payoff — the session's rules become rejected writes instead of promised habits: a load-link from a secondhand or inferred fact is rejected (stub rule + inferred-clause rule made mechanical); a package cannot accept evidence before its prediction exists (CONSTRUCTION-TRAP enforced); a goal version without owner ratification does not cut; corrections keep their trace automatically; the PreToolUse guard extends to all new canonical paths; ONE-UNDER-TEST stays as today. Research pass: short by design — the shape is event sourcing / CQRS convergence (records are the event log, markdown files are read models), engineering prior art the writer already embodies; idempotency keys already exist in the tool schema. Nothing to import, only extend. Owner accepted.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md","lib/judgment-writer.js"]
- rejected: [{"what":"keeping new stores hand-markdown during manual mode","why":"already overruled at seq 106 — unguarded freeform writes are the defect; this entry executes that ruling"},{"what":"advisory validation (warn but write)","why":"enforcement the agent can route around is not enforcement — the unguarded-writes ruling verbatim; invariants reject, not warn"},{"what":"a separate writer per store","why":"one write path, one guard surface, one replay mechanism; per-store writers re-create the multi-door problem being closed"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:36:02.042Z*

## 113. decide: poke-box-level-2 — probes as packages, priced exposure, the six-rung probe bank

Poke half fleshed one level — the last empty box; level 2 of the box map closes with this entry. Research grounding: fake-door/demand-testing practice; survey nonresponse literature (response rate and bias are surprisingly unlinked; nonresponse bias is variable-specific). Sub-boxes: probe (the intervention, keyed to a sharpened joint), exposure record (what the poke reveals about us — written before launch, owner-approved; includes what the probe teaches observers, since poking changes the market it measures), audience (who is touched, size, selection — self-selection recorded), returns (responses AND silences, both as evidence with diagnosticity). Rules: every poke is a resolution package first — question, prediction, bar before launch; a probe without a pre-written bar is marketing, not measurement. Exposure is a priced, gated cost with owner approval. Fake doors allowed under the ethics that legitimize them: immediate honesty after the click, never on critical workflows, never claiming live what is not; the follow-up converts clicks to qualitative facts. Silence verdicts are per-question (refines THREE-SILENCES: the same silence can be damning for one question and meaningless for another), and the standard instrument applies — chase a small random sample of the silent hard before interpreting silence; silence alone stays Inconclusive. Small-N honesty: raw counts, never percentages, per P7. The probe bank, six rungs laddered by exposure and evidence strength (clicks < words < money < behavior): publish-and-watch, list-and-see, fake door, ask-directly, sell-before-build, ship-a-sliver. Rung rule: buy the cheapest rung that can produce the evidence the sharpened joint needs — the VOI cap applied to poking. Rungs 1-2 are partly audience-building for later rungs; that compounding is recorded in the exposure ledger as a benefit, not just a cost. Rails inventory: live web properties (cofounder-fit, couples.team, trustflow, smart-memory-docs), npm + MCP registry (every release is quietly a probe), PostHog for watching, email/Slack for outreach, Stripe for sell-before-build, the quiz engine as the ask-directly instrument. The Poke half is aiming machinery we own under package discipline, not new construction. Honest gap: thin traffic today on most properties — fake-door and sell-before-build need audiences that rungs 1-2 must first build.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md","docs/design/2026-07-20-external-signal-design.md"]
- rejected: [{"what":"poking without package discipline (launch first, define success later)","why":"outcome switching — the bar must exist before the evidence; otherwise it is marketing wearing a lab coat"},{"what":"one global interpretation of silence","why":"nonresponse research: bias is variable-specific; silence verdicts are per-question, and a chased sample of the silent beats any assumption"},{"what":"building new poke infrastructure before aiming existing rails","why":"minimal-first; the properties, registries, analytics, and payment rails already exist — the gap is audience, not machinery"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:39:54.805Z*

## 114. decide: integrations-adapter-layer — external integrations are channel adapters on existing doors, five classes

Owner asked whether external integrations had been thought about; answer was honest — in pieces, never as a pass. Ruled: integrations are NOT a new box. They are channel adapters on doors the DAG already has, in five classes. (1) Observed-channel feeders into Situation — the big untapped one: Stripe knows revenue, PostHog knows usage, the calendar knows demos happened, a CRM knows pipeline. The provenance grammar's observed channel at scale: these are exactly the facts the live run showed rotting in the owner's head; synced, they stay fresh and need no asking. The inside-out gate holds — your own Stripe is Situation; a competitor feed is read-half, full stop. (2) Instrument delivery surfaces — the quiz engine reaches the cast via email, web forms on owned properties, Slack. (3) Read-half source adapters — Reddit, X, HN, newsletters feed the Answerer/Wanderer as sources; the two-machine wall, separate budgets, and FOUND provenance all hold; social listening never writes straight into Situation. (4) Poke executors — email outreach tooling, Buffer/social schedulers, ad platforms, marketing-org tooling execute probes; the package governs, the tool only fires: no probe ships without its pre-written question/prediction/bar (owner named these: marketing orgs, email outreach, Buffer — "lots of things fit into it"). (5) The seams already ruled — SmartMemory as semantic store beneath (max-smartmemory, lifecycle-vs-semantics, one-way writes; OKF stays set aside) and MCP as the product's own surface outward: the Writer's record kinds ARE the API. One discipline makes all five safe: every integrated fact arrives provenance-typed — channel observed, source named, date automatic — so an integration can never launder a guess into a fact; it only makes observed cheap. New rule: auto-observed facts can disagree with owner-said facts ("Stripe says $1.8K, you said $2.5K") — record the pair, never silently prefer either; the stated-vs-revealed pairing extended to the situation level. Divergences are signal.

- refs: ["docs/design/2026-07-20-judgment-layer-process-manual.md","docs/design/2026-07-20-external-signal-design.md"]
- rejected: [{"what":"integrations as a new box in the map","why":"every integration is a feeder or executor on an existing door; a new box would duplicate the DAG's edges"},{"what":"letting social listening (Reddit/X) write into Situation","why":"outside-in facts enter only through the two read machines with their wall and budgets; Situation stays inside-out"},{"what":"auto-observed facts silently overriding owner-said facts","why":"source type is not reliability (EVIDENCE-BY-SOURCE); the disagreement pair is the signal, adjudication is explicit"},{"what":"marketing tools firing outside package discipline","why":"a probe without a pre-written bar is marketing, not measurement — the executor executes, the package governs"}]
- conviction: {"level":"high","source":"stated"}

*2026-07-22T15:43:52.130Z*

## 115. note: Legacy objective migrated to goal:v1

Migrated to `goal:v1`. The legacy `objective` position is retired (tombstoned); goal meaning now lives in the goal store.

`self-report-reliable` was not migrated because no canonical joint record exists.

Legacy OBJECTIVE.md follows verbatim:

---
type: position
title: objective
timestamp: "2026-07-20T12:00:00Z"
smartmemory:
  reference: true
  origin: compose-projection
---

# objective

**Status:** live · **Conviction:** low (inferred)

## Claims (r1)

- **c1** `[ASSERT]` build Compose into a system that decides *what to build* well, not just one that builds well. The back half (goal → shipped) works; the front half is the unclaimed ground.
  - elicitation: asked "What are we optimizing for?" (answered 2026-07-20T12:00:00Z, ref import:docs/judgment/OBJECTIVE.md (back-inferred draft — NOT owner-confirmed, see health warning))

## History

- r1 — 2026-07-20T12:00:00Z

> **OBJECTIVE.md (imported prose)** — # OBJECTIVE — what we are optimizing for

**Status:** DRAFT — `[ASSERT]`, inferred by the agent, **NOT confirmed by the owner**
**Last reviewed:** 2026-07-20

> This file is itself a position with joints (`THE-GOAL-IS-A-POSITION`). It can be
> wrong, evidence can contradict it, and it must be defensible.

## Health warning

This was **not elicited** — it is back-inferred from one session's conversation.
Per `WORTH-IS-CONSTRUCTED`, an objective function assembled by the agent
from observed remarks is precisely the failure mode we named (the agent handing
the owner a tidied version of his own asides and calling it a goal). **Treat every
line below as a question, not a record.** First run of P1b should replace it.

## Draft objective

**Primary:** build Compose into a system that decides *what to build* well, not
just one that builds well. The back half (goal → shipped) works; the front half is
the unclaimed ground.

**Time horizon:** unstated. `[JOINT: horizon]`

**What success looks like:** unstated in measurable terms. `[JOINT: success-criteria]`

## Observed trade-off rankings (from behaviour this session, not stated)

| Ranked above | Ranked below | Evidence |
|---|---|---|
| Locking the top level | Shipping a first rung | Explicitly rejected "ship rung 1 and let contact answer the questions" as bottom-up drift |
| Correct framing | Sunk design work | Reopened the boundary decision after it was recorded as settled; killed four valuation framings |
| Being argued with | Being agreed with | Rejected the revealed-preference argument on its merits; asked for adversarial passes unprompted |
| Reuse of existing machinery | Greenfield construction | "How much can we reuse and from where" made the deciding criterion for the boundary |
| Honest uncertainty | Confident delivery | Repeatedly pushed back on premature certainty |

## Open joints on this objective

| Joint | Question | Status |
|---|---|---|
| `horizon` | Over what period does this need to pay off? | Unasked |
| `success-criteria` | What observable outcome would mean this worked? | Unasked |
| `commercial-intent` | Product to sell, or instrument for own building? Changes almost everything downstream | Unasked — **highest VOI on this file** |
| `self-report-reliable` | How much should the owner's stated objective be trusted vs constructed? | Partial read only (see LEDGER 2026-07-20) |

## Consistency tally

Too early. One session. Note for the record: within this session, stated
priorities and observed choices **did not diverge** — top-down framing was
asserted and then consistently enforced, including against the agent's own
proposals. That is one datapoint toward the reliable end of
`SELF-KNOWLEDGE-DIAL`, not a verdict.


- refs: ["objective#r1","goal:v1"]
- anchor: position:objective

*2026-07-24T02:24:00.816Z · via migration*

## 116. attest: intent published: intent-1784859840816-37452-1

- intent_id: intent-1784859840816-37452-1
- tool: judgment_goal_write
- op: migrate

*2026-07-24T02:24:00.849Z*
