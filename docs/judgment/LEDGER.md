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

## Process failures (recorded, per `RECORD-ALWAYS`)

- **Stratum not used** despite `capabilities.stratum: true` and an explicit CLAUDE.md
  mandate. Classification made once at session start and never re-evaluated when the
  work became artifact production. Cost: five of ten review findings were internal
  self-contradictions — the class postcondition checks exist to catch.
- **Codex probe lost** (~27k tokens) to a dead job handle. Now documented in memory.
- **Boundary decision recorded as settled when it was not.** Caught by the owner.
