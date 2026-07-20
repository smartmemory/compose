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

### D-1 · The layer above execution is what to build next
**Decided.** Compose's goal→execution half works and is mechanical; the unclaimed
ground is deciding what the goal should be.
**Rejected:** treating the front half as idea storage and sorting.
**Conviction:** high *(inferred — asserted early and never revisited)*

### D-2 · The product's output is a testable ledger, not a decision aid
**Rejected:** "research + idea management" framing (two write-heavy read-poor
stores, both already exist here); the reasoning-aid framing (dies to `already-knew`).
**Conviction:** high *(inferred — owner reframed it himself as "a ledger that can be
tested independently")*

### D-3 · KILL — build exhaust as the source of ideas
**Reason:** closed loop. Exhaust reveals how you build, never whether anyone wants
it. No path to market truth.
**Survives as:** one evidence type; `AGENT-IN-THE-ROOM`; `MOAT-FINAL-FORM`.
**Conviction:** high, and owner-initiated — he parked the moat claim before the
argument was made.

### D-4 · KILL — worth is revealed by the owner's choices
**Reason (owner):** contradicts the product's own premise. If people decide badly
under uncertainty, their choices encode guessing, not preference. Fitting a model
to that and returning it as "your taste" is the flattery engine wearing statistics.
**Rejected alternatives in this thread:** worth is computable from goal+constraints;
worth is elicited then applied. Both also dead.
**Now:** `WORTH-IS-CONSTRUCTED-WITH-HELP`.
**Conviction:** high. This was the sharpest correction of the session.

### D-5 · Joints are branch points; straddling is a fourth disposition
**Owner-originated.** Don't resolve the joint — build all its branches, let reality
pick. Requires no foresight.
**Conviction:** high.

### D-6 · One joint under test at a time
**Owner-originated** ("we limit N to 1?"). Refined to: many joints open, experiment
queue depth 1.
**Conviction:** high.

### D-7 · Execution is an instrument for resolving decisions
Construction is a third resolution method alongside evidence and assertion, and the
one nothing else can offer.
**Conviction:** high.

### D-8 · Lean on SmartMemory maximally
**Rejected:** rebuilding storage/typing/evolvers. **Constraint kept:** kitchen stays
headless.
**Conviction:** high — stated flatly ("I'd say maximize").

### D-9 · OPEN — product boundary
Not decided. Reopened by owner after being recorded as settled.
**Positions on the table:** layer inside Compose · two interoperating products ·
one repo, separate packages (evidenced by `compose-mcp`).
**Owner's live objection:** it is harder to split a monolith, and packaging is
independent of architecture.
**Conviction:** deliberately unresolved. See `positions/product-boundary.md`.

### D-10 · Manual mode before building
Run the six processes by hand; the friction is the automation spec.
**Conviction:** high, owner-originated.

---

## Overrides

### O-1 · 2026-07-20 — Owner waived `nobody-maintains-structured-reasoning`
The strongest empirical objection to the whole product (argument mapping, decision
journals, premortems — all correct, all abandoned). **Waived by fiat**, recorded as
an owner assertion of latent demand.
**Open joints at time of override:** the objection itself, plus the then-unaddressed
maintenance-burden question.
**Flips if:** real users refuse to maintain it. Partially answered later by
`AUTOMATION-MAKES-IT-FREE` (byproduct, not chore).
**Per `OVERRIDE-IS-THE-BEST-ENTRY`, this is the highest-value entry in this file.**

---

## Escalations

### E-1 · 2026-07-20 — Design work invalidated the layer above it
**Trigger:** owner observation that the four proposed output-units were all "how to
build", not "what to build".
**Propagated to:** product position. Forced restatement of the entire top level.
**Classification:** wrongness, not difficulty.

### E-2 · 2026-07-20 — Adversarial review invalidated the stated scope
**Trigger:** independent review found no option generation and no objective function.
**Propagated to:** product position → the three-layer stack.
**Classification:** wrongness.

### E-3 · 2026-07-20 — Owner objection invalidated a just-recorded claim
**Trigger:** revealed-preference argument contradicted the product premise.
**Propagated to:** the valuation approach (killed and replaced).
**Classification:** wrongness. Note the interval: recorded and killed within minutes.

---

## Process failures (recorded, per `RECORD-ALWAYS-ACT-BY-COST`)

- **Stratum not used** despite `capabilities.stratum: true` and an explicit CLAUDE.md
  mandate. Classification made once at session start and never re-evaluated when the
  work became artifact production. Cost: five of ten review findings were internal
  self-contradictions — the class postcondition checks exist to catch.
- **Codex probe lost** (~27k tokens) to a dead job handle. Now documented in memory.
- **Boundary decision recorded as settled when it was not.** Caught by the owner.
