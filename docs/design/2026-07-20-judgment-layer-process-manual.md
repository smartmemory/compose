# Judgment Layer — Process Manual (manual-mode v0)

**Status:** OPERATIONAL DRAFT — written to be *run by hand*, not built
**Date:** 2026-07-20
**Purpose:** dogfood the judgment layer manually so we learn what to build, and in what order.

## Related Documents

- Source of the claims this operationalizes: [What To Build — The Judgment Layer](../product/2026-07-20-what-to-build-vision.md)
- Context: [The Discovery Loop](../product/2026-07-20-discovery-loop-vision.md), [COMP-FOH](../features/COMP-FOH/design.md)
- **Amends this manual:** [External Signal — Acquisition Design](2026-07-20-external-signal-design.md) §8 — adds a precondition to P2 step 3 (`EXT` may not be tagged until the joint is sharpened), changes the P3 `EXT` disposition to return a package rather than a finding, and rules that a joint resolved on silence alone is Inconclusive.

## Why manual first

`AUTOMATION-IS-FREE` says automation decides whether any of this survives. Running it by hand is how we find out **what that means concretely** — the friction points *are* the automation spec. Manual operation also resolves the three highest-VOI constructible joints (`elicitation-works`, `joint-is-non-obvious`, `sensitivity-computable`) at near-zero cost, before anything is built.

**Every process below therefore has a `WATCH FOR` block. Those observations are the deliverable — more than the outputs themselves.**

---

## Storage layout (manual mode)

Deliberately minimal. Three things, all markdown, all in git.

```
docs/judgment/
  OBJECTIVE.md          the objective function — itself a position (THE-GOAL-IS-A-POSITION),
                        versioned: every owner correction is a new version, never a rewrite
  REGISTER.md           the joint register: all open joints, ranked, one marked UNDER TEST
  LEDGER.md             append-only log: decisions, overrides, escalations, dated
  positions/<slug>.md   one file per position: claim, argument, joints, branches
  people/<name>.md      one per human in the cast (P0.0) — the full cast, not just the owner
```

**Write path** (ruled 2026-07-22): every store is written through the judgment-writer
from day one — the Writer is the only door, and the markdown above is a projection.
Extends the `unguarded-writes` ruling from ledger/register/positions to all stores,
person files and situation included (ledger seq 106).

### People box — level-2 sketch (added 2026-07-22, ledger seq 107)

One file per human in the cast, owner included. Seven sub-boxes:

| Sub-box | Holds |
|---|---|
| Role & unit | who they are to this decision, and their edges to others (married-to, sells-for, customer-of). **Person files own their edges**; the whole-cast map is a rendered projection, never a second source. |
| Life situation | strengths, aversions, constraints, what they are carrying (P0.0's list) |
| Stated | what they said, dated, their words where possible |
| Revealed | what they did — recent real decisions, observed behavior |
| Open fields | named unknowns, filled by interview, never by inference |
| Load | what currently rests on this person — the stub rule made checkable |
| Instruments | opt-in structured elicitation feeding the file (rules below) |

**Provenance grammar** (cross-cutting — situation will share it): every fact carries
how-we-know plus when. Four channels: *said · observed · secondhand-via-X · inferred*.
Secondhand is a **tag on a fact, not a section** — a stated-fact-at-one-remove ("partner
says she said yes") stays load-banned until the person speaks into their own file.
Corrections fix the fact in place with the old value visibly traced (ledger seq 106).

**Rules:** stated and revealed are recorded separately and never merged; divergences
between them are recorded as **pairs, never scores** (`PEOPLE-SCORING-PUNTED` extended
from postmortems to the file itself). **A stub may not carry load** — a plan resting on
what someone else reported about a person ("she can run it") is unsafe until that person
has spoken into their own file. Lifecycle is binary — *stub → spoken* — until a process
demands more. Person files hold a *user's* cast in a *user's* project — they are never
authored in this repo, whose only cast is the process itself.

**Instruments** — one elicitation engine, two surfaces: delivered live it is the
interview; delivered async and self-paced it is the quiz. The quiz is the cheap path from
stub to spoken for cast members an interview would be awkward to arrange with, and paired
instruments surface stated-vs-secondhand divergence automatically. Sequencing spends the
**fatigue budget on load, not coverage** — highest-load open field first, re-ranked after
every answer; ranking is a collection point (no computation exists — record the judgment).
Validated psychometric blocks are dropped in **verbatim or not at all**; the instrument is
dynamic between blocks only. Consent ladder: full instrument → highest-load basics woven
into normal contact (plus an optional short validated form) → silence leaves the stub a
stub. Coarse profiles are **never load-bearing alone** — they shape how the next question
is asked, never substitute for its answer. Question banks are composite (intents, goals,
situation, relationships); personality is one bank among several. In-house prior art and
first instrument candidates: cofounder-fit, couples.team.

Open joint, parked (product question, not box shape): dossier consent/privacy — what may
be written, shown, or exported about non-consenting cast members.

> **WATCH FOR:** the whole instrument design is calibrated on one atypical, introspective
> owner. Whether mainstream users need something simpler — or richer — is empirical.
> Watch, don't design.

### Situation box — level-2 sketch (added 2026-07-22, ledger seq 108; accepted tentatively)

The card about *what's on the table*: businesses, money, commitments, pipeline. Inherits
the People box's provenance grammar wholesale. Four sub-boxes:

| Sub-box | Holds |
|---|---|
| Entities | the things in their world — businesses, products, deals — each a named cluster of facts |
| Facts | what's true, each carrying the four channels (said · observed · secondhand · inferred) + when |
| Owed | facts known to be missing and load-bearing, listed by name — the situation-level twin of a person file's open fields |
| Load | which facts carry plans or claims, so a broken fact names what shakes |

**Boundaries.** With People: facts about a person live in their person file; facts about
shared things live here — written once, cross-referenced, never duplicated. With the
world: **inside-out only**. Situation holds what the cast owns, owes, and has committed
to. Outside-in facts (markets, competitors) arrive through the read-half as resolution
evidence — the world feeds the Answerer and Wanderer, never Situation. A competitor's
launch never becomes a situation fact; their own booked demos do.

**Storage:** entity-tagged records behind the Writer; `SITUATION.md` is a projection
grouped by entity. **Staleness:** facts carry dates and the P6 sweep ranks by judgment —
no volatility metric invented at the desk. Corrections fix in place with the old value
traced. Like the person files, the record is never complete — no maneuver may treat the
situation as fully known (P0.1).

### Goal box — level-2 sketch (added 2026-07-22, ledger seq 109; research-grounded)

Already ruled: `OBJECTIVE.md` is a position, opened as a v1 draft, re-versioned on every
owner correction, never captured at intake. This adds the mechanics.

| Sub-box | Holds |
|---|---|
| Current version | the goal as it stands, in clauses — each clause a fact with provenance |
| Trajectory | every prior version: the diff, and the provocation in the owner's words |
| Joints | the goal's own uncertainties, in the register like any position's |

**Rules.** Clauses are facts under the shared four-channel grammar, and **an inferred
clause may not carry a commit** — the stub rule's twin at the goal level. Only the
owner's voice cuts a version: the agent drafts, the owner ratifies; meaning changes
version, wording does not. Every version stores its **provocation** — the trajectory of
provoked corrections is `WORTH-IS-CONSTRUCTED`'s first real content (with the
assert-to-elicit kill intact: drafts after listening, never strategic wrong verdicts).
No schema is imposed on the goal; the live run's horizon / "enough" threshold /
optionality clauses stay observations, not required fields.

**Churn handling** (owner-prompted: "what about someone who changes goals just because,
frequently?" — grounded in a literature pass, ledger seq 109):

- **Invariant projection.** After enough versions, project what never moved. Goal
  hierarchies (Carver & Scheier) treat subordinate *means* churning under stable
  superordinate ends as normal self-regulation, and value-focused thinking (Keeney)
  finds most stated objectives are means — fundamentals surface via the *"why is that
  important?"* ladder, which joins the instrument banks. A flip that ladders to the same
  fundamental is means churn, recorded as such. Fundamental-vs-means tags emerge from
  running the ladder — never required fields.
- **Oscillation converts to a joint.** A→B→A on the same goal is the action-crisis
  signature (Brandstätter; Wrosch): persist-vs-disengage becomes an explicit register
  joint with branches and kill criteria, instead of endless versioning. Adaptive
  disengagement followed by reengagement is healthy — it gets the bill and prepared
  branches, never stigma.
- **Show the bill, never block.** Load links price every flip; refusing the change is
  not the system's call.
- **Commit guard.** An irreversible commit may not quietly rest on a recently flipped
  clause — permitted, but presented as *forced* with open joints and clause stability
  listed.
- **Aspiration drift is expected.** "Enough" thresholds adapt with attainment
  (satisficing); threshold drift is normal versioning with its provocation recorded.
- **Elicitation constructs the answer** (Lichtenstein & Slovic: procedure invariance
  fails — external validation of `WORTH-IS-CONSTRUCTED`). Record which instrument or
  question produced each clause; a clause that survives two different elicitation shapes
  outranks a single-method clause. Instruments are not neutral.

> **WATCH FOR:** whether the invariant projection ever surprises the owner — the
> goal-level twin of `joint-is-non-obvious`. Whether oscillation-to-joint ever fires in
> practice.

Do not add structure until a process demands it. If a field is never used by hand, it is not needed in the build.

---

## P0 — The basics (added 2026-07-22, after the first live run)

Learned by running P1/P2 on a real portfolio decision and failing at it. Owner-taught,
not derived. **When anything below conflicts with these, these win.**

0. **Know the person first and foremost.** Strengths, aversions, life situation, and who
   is around them — spouse, partners, sellers. The unit is rarely one person. Nothing can
   be evaluated except through who will live it.
1. **Learn the facts by listening — no verdicts before knowing.** In the live run, every
   load-bearing fact (the only paying customer, the spouse who could operate, the partner
   already out selling, the scheduled demos) was absent from every artifact and existed
   only in the owner's head. A verdict issued before the facts costs credibility, and a
   real owner does not stay to correct it — they leave.
2. **Research is part of goal-building, not a stage after it.** Pick up the world whenever
   the forming goal needs it. Reasoning from the chair is not diligence.
3. **Figuring out what the goal should be IS the deliverable.** "Which of N should I focus
   on?" is a symptom of a missing goal, not a selection problem. Most people cannot state
   their goal in a sentence — it is constructed over the course of the work, never
   collected at intake. Once the goal exists, focus and ranking fall out mechanically.
   This is the product's founding premise (`layer-above-execution`), and the first live
   run still managed to answer like the layer below.

These are not pipeline stages. They interleave — the skill is knowing what would help
*right now*. The processes below are checklists for specific maneuvers (decomposition,
ranking, resolution), not a script for the encounter.

---

## The flow — breadcrumbs, end to end (added 2026-07-22)

The spine everything below serves. The processes are maneuvers *on* this trail, and the
trail is where any encounter is located before any maneuver is chosen.

> person → situation → **goal takes shape** (constructed, research woven in throughout) →
> claims under it → the few that matter → settle / test / straddle → **commit**, open items
> named ∥ build → learnings flow back → the world keeps watching → revise, or switch to the
> prepared branch

| Crumb | Artifact | Maneuver |
|---|---|---|
| person | `people/<name>.md` — full cast, stated vs revealed | P0.0 |
| situation | facts records, owner-corrected, provenance marked | P1 listening |
| goal | `OBJECTIVE.md`, **versioned** — every correction is a version | P0.3, opened in P1b |
| claims | `positions/<slug>.md` | P1a decomposition |
| the few that matter | `REGISTER.md`, one under test | P2 |
| settle / test / straddle | resolution packages | P3 (+ external-signal design) |
| commit | crystallize → `feature.json` + `design.md` | P4 |
| build | Compose's execution half | outside this manual |
| learnings flow back | escalation records | P5 |
| world keeps watching | sweep + (when built) the Wanderer | P6 |
| revise / recover | reopened joints, prepared branches | P5/P6 outcomes |

Everything up to **commit** is the judgment layer — the part that decides what is worth
doing. Build onward already ships. The last three crumbs are loops, not steps.

---

## P1 — Intake

**Trigger:** a new question arrives ("should we build X?", "what should we do about Y?", "which of these should I focus on?", or nothing at all).

**Entry detection (re-ruled 2026-07-22): locate the person on the trail, then enter there.**
The question asked is rarely the trail position. Check in order: is the *person* known
(P0.0)? Is the *situation* known? Does a *goal* exist? Candidates can arrive at any
position — arriving with five candidates and no goal (the first live run's exact shape)
routes to goal-construction with the candidates as raw material, **not** to P1a
decomposition of any one of them. P1a and P1b below are maneuvers for two common shapes,
not the only doors (`NOTHING-MEANS-NO-IDEA`).

### P1a — Arrives with a candidate
1. Ask what they want to build and why. Let them talk (`LISTENING-BEATS-ASKING`).
2. Decompose into the claims underneath: the descriptive ones, the causal ones, the value ones.
3. Mark each claim's grounding: `EXT` / `INT` / `ASSERT`.
4. Identify the **joints** — the steps where the argument's weight actually sits (`GROUNDING-PER-STEP`). Data at the bottom, assertion at the joints.
5. **REQUIRED — capture the two fields, or the position is not written.** For the position as a whole record (a) **what was rejected** — every candidate, framing or approach considered and dropped, each with its reason; (b) **conviction at the time**, in the owner's words where possible, marked *inferred* where not. `NEVER-CAPTURED-BEFORE` says these are the point of the whole artifact; a position lacking them is incomplete, not merely thin.
6. **Record what each claim supports.** Every claim links upward to the claim or decision resting on it. Without these links P5 cannot walk anything and degrades to guesswork.
7. Write `positions/<slug>.md`. Add joints to `REGISTER.md` — each with branches and a cost, per P2, or it is not a register entry.

### P1b — Arrives with nothing
1. **Elicit** — situation, constraints, assets, dissatisfactions, and what they are optimizing for. Rules: forced trade-offs over stated preferences; concrete past over abstract future; never ask what you can observe; every answer returns something visible. *Amended 2026-07-22 (live run):* elicitation **opens** the file; it does not fill it. Load-bearing facts keep surfacing for the entire run — several only ever surface as corrections — so no maneuver downstream may treat the situation as fully known (P0.1).
2. Ask for **stated principles and recent real decisions in the same sitting**, then compare (`READ-IN-ONE-SITTING`). This is the first read on how much to trust their self-report.
3. Open `OBJECTIVE.md` as a **version 1 draft** — a position with its own joints. *Amended 2026-07-22:* the goal is constructed over the whole run and re-versioned on every owner correction (P0.3); a first-sitting objective is a draft to be stressed, never a capture — most people cannot state their goal, and the live run produced three versions in one afternoon. Research is picked up whenever the forming goal needs it (P0.2), not held for a later stage.
4. **Generate** candidates: gap-to-goal · unfair advantage · world signal · inverted constraint.
5. **Value them — NO PROCEDURE EXISTS. This step is a collection point.**
   > `NO-VALUATION` is an acknowledged open hole on the critical path, and `WORTH-IS-CONSTRUCTED` is a framing, not a method. **Do not invent a procedure at the desk** — that is how the first draft of this manual acquired five self-contradictions.
   > **Instead: rank them however you actually rank them, then write down what you did.** In `LEDGER.md`, record: what you compared, what tipped it, what you ignored, and whether the owner agreed. Those records are the evidence from which a real valuation procedure gets specified.
   > Still binding: never hand back an unranked list (`UNRANKED-IS-A-LIST`). An honest ad-hoc ranking beats fifty options and a shrug.
6. **REQUIRED — the discarded candidates are the record.** Every generated candidate not taken forward goes into `LEDGER.md` with why it lost. Discarding them silently destroys exactly the thing this product claims to uniquely capture.
7. Take the top candidate into P1a.

> **WATCH FOR:** Which questions actually moved the answer, and which were filler. Where the conversation felt like an interrogation. Whether the trade-off questions produced real orderings or evasion. Whether generation produced anything the person hadn't already thought of — if not, generation is not earning its place. How long before question fatigue set in.

---

## P2 — Joint identification and ranking

**Trigger:** a position exists or has changed.

1. For each claim: *if this were false, would we do something different?* If no, it is not a joint however uncertain it is (`VALUE-OF-INFORMATION`).
2. For each joint, write both branches: **if true → …** / **if false → …** (`JOINTS-ARE-BRANCHES`). If the two branches are identical, delete the joint. **A joint without both branches written is not a register entry** — no exceptions, including for joints that feel obvious.
3. Tag resolution method — these five and no others:
   - `EXT` look it up in the world · `INT` check our own history and records · `CONSTRUCT` build the test · `ASSERT` owner's call · `STRADDLE` build both branches.
   - *(`INT` was used in the register before being defined here — a real gap. It is a distinct method: the evidence exists and is ours, so it is neither external lookup nor new construction.)*
4. Estimate cost in coarse buckets — hours / days / weeks / months (`COARSE-BUCKETS`). **Required for every entry**; an unestimated joint cannot be ranked and must not sit in the register pretending it can.
5. **Rank — NO COMPUTATION EXISTS. This step is a collection point.**
   > `VALUE-OF-INFORMATION` gives the *principle* (does resolving it change what we do?) and `ONE-COST-COMPARISON` gives the *shape* (resolve vs straddle vs assert vs be wrong). Neither yields a number: there is no probability of being wrong, no cost-of-being-wrong, no budget, and no reversibility measurement anywhere in this system yet.
   > **Rank by judgment, then record the judgment.** In `LEDGER.md` note which joint you picked, what you nearly picked instead, and what actually decided it. When several such records accumulate, the real ranking rule becomes specifiable — that is the point of doing this by hand.
6. Mark exactly **one** `UNDER TEST` (`ONE-UNDER-TEST`).
7. **Independent check — do not skip.** A second party (a different agent, or the owner deliberately adversarial) reviews the joint list for **what is missing**, not what is wrong. Novelty to the owner does not establish that a joint is load-bearing, and an omitted joint leaves no artifact for any later stage to catch (`JOINT-RECALL`).
   > Added on evidence, not principle: on 2026-07-20 the agent's own grading of its own work ran generous and only an independent pass caught it (`calibrate: self-grading-ran-generous`).

> **WATCH FOR:** **Did any joint surface that the owner had not already noticed?** (`JOINT: joint-is-non-obvious` — the single most important observation in manual mode.) How often the "both branches identical" test killed a joint that felt important. Whether ranking was obvious or agonising. Whether cost estimates were later borne out.

---

## P3 — Resolution

**Trigger:** a joint is `UNDER TEST`.

Pick the cheapest disposition that yields an acceptable outcome (`ONE-COST-COMPARISON`):

| Disposition | Do this | Manual-mode note |
|---|---|---|
| `EXT` | Go look. Web, competitors, users, data. | Record the source and its reliability, not just the finding. |
| `CONSTRUCT` | Build the smallest thing that makes the answer observable. | **Write the prediction and the outcome criteria in `LEDGER.md` BEFORE building** (`CONSTRUCTION-TRAP`). No prediction, no build. |
| `STRADDLE` | Build all branches. | Requires a discriminating measurement (`STRADDLE-NEEDS-SIGNAL`) and pre-committed kill criteria (`KILL-CRITERIA-FIRST`). If either is missing, do not straddle. |
| `INT` | Check our own history, ledger, build records. | Same evidence discipline as `EXT`: record which record, and how much it is worth. |
| `ASSERT` | Owner decides. | Mark permanently unproven. **Later contradicting evidence does *not* automatically win** — weigh it: is it current, representative, causally relevant, and more reliable than the owner's direct knowledge? Source type is not reliability (`EVIDENCE-BY-SOURCE`), so a stale survey does not beat domain expertise. Record the weighing. |

**Outcomes — every resolution ends in exactly one of these:**

| Outcome | Then |
|---|---|
| **Resolved** | Update the position, re-rank remaining joints, move the `UNDER TEST` marker. |
| **Inconclusive** | Evidence conflicting, insufficient, or the measurement did not discriminate. **Record what was learned and what would have settled it**, then either re-dispose (a different method) or return the joint to the register with a note. **Free the queue slot either way** — an inconclusive result must never hold the depth-1 queue, or the whole process deadlocks behind it. |
| **Failed to run** | Experiment never executed, sample missed, source unreachable. Record the reason, free the slot, re-rank. **Do not record as inconclusive** — a test that did not happen and a test that answered nothing are different facts. |
| **Superseded** | The joint stopped mattering (the position changed underneath it). Record why, remove from register. |

**Never mark a joint resolved to free the queue.** If pressure to do so is felt, that pressure is itself the finding — record it.

> **WATCH FOR:** How often construction was chosen because it was genuinely cheapest versus because it was the nearest tool (`TAG-BY-RESOLUTION`). Whether the pre-written prediction ever actually contradicted the result, or whether it was retro-fitted. Whether straddling was ever affordable in practice.

---

## P4 — The commit moment

**Trigger:** no remaining joint is worth resolving, OR reversibility is about to cross, OR budget is gone.

1. State which of the three triggers fired: **earned / forced / exhausted** (`THREE-TRIGGERS-NOT-ONE`). Do not blur them.
2. **Present commit using the wording for that trigger. They are not interchangeable:**
   - **earned** — "Nothing left worth resolving." The only case where questions are actually exhausted.
   - **forced** — "**Open joints remain.** Reversibility is about to cross, so committing now is cheaper than learning more." Out of time, not out of questions.
   - **exhausted** — "**Open joints remain.** Budget is gone." Stopped because continuing was impossible, not because the work finished.
   In all three: commit is **not** an endorsement. It never means the idea is good — the system cannot say that, because valuation is unbuilt (`READY-IS-NOT-VALIDATED`, `NO-VALUATION`). Under *forced* and *exhausted*, **list the open joints in the presentation itself**, so nobody later remembers it as *earned*.
3. If the owner commits against open high-VOI joints, record the override with the open joints listed. **These are the highest-value entries in the ledger** (`OVERRIDES-ARE-GOLD`).
4. **REQUIRED — record conviction and rejected alternatives at the commit**, not just at intake. What was believed, how strongly, and which alternative was still live when the call was made.
5. Crystallize: the committed position becomes a `feature.json` + `design.md` via the existing Compose writer.

> **WATCH FOR:** Whether the stopping condition ever actually fired, or whether commitment always came from impatience or a deadline. How commit felt when presented — permission, or pressure.

---

## P5 — Escalation (the vertical loop)

**Trigger:** anything learned during scoping, design, a spike, or a build that bears on an upstream claim.

1. **Record it always.** Free and unconditional (`RECORD-ALWAYS`).
2. Classify: is this **difficulty** or **wrongness**? "Harder than we thought" is usually not evidence the premise is wrong (`HARD-NOT-WRONG`).
3. Walk the links recorded in P1a step 6: implementation → design → feature premise → product position → objective function. **If the links were not captured, the walk is guesswork** — say so in the record rather than presenting a guess as a propagation.
4. **Act-or-note — no reversibility number exists yet, so this is a collection point.** Nothing in this system measures reversibility (`REVERSIBILITY-METER` is a design claim, not an implemented meter). Judge it, act or don't, and **record the judgment**: how hard you thought this would be to undo later, and whether that turned out right. Those records are what makes the meter specifiable.
5. Check accumulation: do several recorded weak signals now jointly cross the threshold (`SIGNALS-ACCUMULATE`)? **No threshold is defined** — review the accumulated signals for this claim and judge; record the call and the count that prompted it.

> **WATCH FOR:** How many escalations were difficulty misread as wrongness. Whether anything ever escalated past the feature premise. Whether recorded-but-not-acted signals were ever revisited, or just buried.

---

## P6 — Maintenance sweep

**Trigger:** periodic (weekly, manual mode). The sweep **ranks**; it does not re-check everything (`TIMER-RANKS-NOT-CHECKS`).

1. For each claim: volatility × downstream impact × time since last check.
2. Re-check only the top one or two.
3. Where a check repeats in the same shape, **write a checker instead of repeating the check** (`COMPILE-INSTRUMENTS`).
4. Verify existing checkers are still *able* to fire (`DEAD-SENSOR-IS-QUIET`).
5. Shaken claims: downgrade **grounding**, never **conviction** (`SHAKE-GROUNDING`).
6. **Then act on the shake — downgrading a label is not a response.** For every shaken claim, walk its links (P1a step 6) and do each that applies:
   - **Reopen** any joint that was resolved on the shaken evidence — back into the register, branches and cost intact.
   - **Re-rank** positions whose ranking depended on it.
   - **Revisit** commitments resting on it — this may raise a P5 escalation.
   - **Revive** candidates killed for a reason that has now become false (`KEEP-THE-RAW` applied to candidates; a kill reason that expired should return the candidate to the pile).
   Leaving downstream work resting on a known-stale premise is the failure `STALENESS-IS-SILENT` names.
7. **Sweep for due predictions and run P7 on them.** Any prediction written before a build (`CONSTRUCTION-TRAP`) or conviction recorded at a commit (P4.4) that can now be graded. **This is P7's trigger 3, and it is the one with no natural prompt** — nothing in the world arrives to tell you a prediction came due, so if the sweep does not look for them, they are never graded and `JOINT-RECALL` stays uncomputed forever.

> **WATCH FOR:** Whether re-checking ever found anything. Which claim types actually rot (this calibrates volatility empirically). Whether the sweep felt worth doing or became a chore skipped after week two — that answer is load-bearing for `JOINT: ledger-used`.

---

## P7 — Postmortem `[AGENT]` *(added 2026-07-22 — flagged for owner sign-off)*

**Why this exists.** `JOINT-RECALL` is named in the spine as **"the single most important metric about this system"** and *"everything else is decoration by comparison."* It is unmeasurable without a postmortem, and there was no postmortem procedure — so the most important metric had no way to be computed, and the honesty table below correctly marked `sensitivity-computable` as **No**. Rung 6 of the Discovery Loop ("the loop grades its own judgment") and `AGENT-CALIBRATION` have the same dependency. This is the smallest procedure that unblocks all three. **It is deliberately thin** — per the manual's own rule, do not add structure until a process demands it.

**Trigger — the hard part, and the reason this was missing.** Postmortems are conventionally triggered by *failure*, and failure in this system is often silent, late, or never labelled as such. Three triggers, and the third is the one that matters:

1. **Something broke** — a build went badly wrong, a feature shipped and did not land, a decision was reversed.
2. **A joint resolved** — any joint leaving `UNDER TEST` with a Resolved outcome. Cheap, frequent, and the fast-calibration corpus `TRIVIAL-IS-TRAINING` argues for.
3. **A prediction came due** — the one nobody remembers to run. Every `CONSTRUCT` disposition writes a prediction before building (`CONSTRUCTION-TRAP`); every commit records conviction (P4.4). **Those are dated claims with no scheduled reckoning.** Sweep for them in P6 and run P7 on any that can now be graded.

**Procedure.** Five steps, all against records that already exist:

1. **State what happened**, in one sentence, before looking at the register. Order matters: reading the register first contaminates the recall answer, which is the entire measurement.
2. **Was the cause on the list?** Check the register *as it stood at the time* (git history — this is why the register is in git). Exactly one of:
   - **NAMED** — the cause was a joint in the register.
   - **NAMED-BUT-MISRANKED** — it was there, ranked too low to reach the queue. A distinct and more actionable failure than not seeing it: the seeing worked, the ranking did not.
   - **MISSED** — not there at all. **These are the entries that matter.** Record what would have surfaced it, since that is the only specification anyone will ever get for a better generator.
   - **UNKNOWABLE** — no available method would have surfaced it in advance. Use sparingly and with an argument; it is the escape hatch that makes the metric flattering.
3. **Grade the prediction, if there was one.** Compare what was written before to what happened. Do not rewrite the prediction. Record whether it was *right*, *right for the wrong reason* (which is not a success and is where overconfidence hides), or *wrong*.
4. **Attribute, scoped to the question type — never to a person** (`PEOPLE-SCORING-PUNTED`). *"Integration-effort estimates run low, consistently"* is actionable. *"Bob is bad at this"* is not, and changes what the product is. Agent inferences get the same treatment scoped to inference type (`AGENT-CALIBRATION`).
5. **Append to `LEDGER.md`** with the date, the trigger, the four-way recall verdict, and the attribution. **Never edit the original entry** — the ledger is append-only, and a corrected prediction is a destroyed measurement.

**The metric.** `JOINT-RECALL` = NAMED ÷ (NAMED + NAMED-BUT-MISRANKED + MISSED), with UNKNOWABLE excluded from both terms and **reported alongside**, because a rising UNKNOWABLE rate is how this metric gets quietly gamed.

> **HONESTY — what P7 cannot do yet, stated so it is not later assumed.** The sample will be tiny for months, so early numbers are anecdote, not a rate; report the raw counts, never a percentage, until there are enough to mean anything. P7 also **cannot distinguish "the method worked" from "a human filled the gap"** — the same limit already recorded against `sensitivity-computable`, and it does not go away just because a procedure now exists. And P7 is run by the same agent whose recall it measures, which is precisely the `WHO-CHECKS-THE-CHECKER` problem: **step 2's verdict should be adjudicated by the owner**, as with `joint-is-non-obvious`, or it inherits the self-grading miscalibration already recorded twice in the ledger.

> **WATCH FOR:** Whether trigger 3 ever actually fires, or whether due predictions are simply never noticed — that is the load-bearing observation, because a prediction nobody grades is a prediction nobody made. Whether MISSED entries produced anything specific enough to change the generator, or only regret. How often UNKNOWABLE was reached for. Whether the postmortem felt like learning or like paperwork — if paperwork, it will be skipped by week three and `JOINT-RECALL` dies with it.

---

## What manual mode is trying to resolve

**Honesty rule for this table: manual mode can only *inform* most of these, not close them.** A joint is resolved by evidence meeting a criterion stated in advance, and several criteria below do not yet exist. Marking one resolved without its criterion is the self-grading failure recorded in `calibrate: self-grading-ran-generous`.

| Joint | Exercised by | Criterion | Can manual mode close it? |
|---|---|---|---|
| `joint-is-non-obvious` | P2 | Owner confirms, at the time, that a surfaced joint was one they had not considered. Owner is the adjudicator; agent may not score this. | **Yes** |
| `construction-discipline` | P3 | Was the prediction in `LEDGER.md` before the build, timestamped? Binary, checkable from git. | **Yes** |
| `candidates-generatable` | P1b | Owner confirms a generated candidate was not already in their head. | **Yes** |
| `elicitation-works` | P1b | *No criterion defined* — "usable objective function" is unscored. **Define the criterion before claiming this, or record observations only.** | **Partial** |
| `sensitivity-computable` | P2, **P7** | Requires a postmortem: when something went wrong, was the cause a named joint? ~~No postmortem trigger or procedure exists yet.~~ **P7 now supplies the trigger and procedure (2026-07-22).** Still cannot distinguish "the method works" from "a human filled the gap", and the sample will be too small to mean anything for months. | **Partial** — P7 collects the raw material; the criterion is still unmet |
| `ledger-used` | — | The claim is about an **auto-captured** ledger (`AUTOMATION-IS-FREE`). Hand-running a labour-intensive practice cannot test it. Six-week survival of manual mode is a *different* fact. | **No — do not close** |

**Primary metric throughout:** `JOINT-RECALL` — when something later went wrong, was the cause on the list beforehand? ~~Requires a postmortem procedure that does not exist.~~ **Procedure written 2026-07-22: see P7 above.** Report raw counts, never a percentage, until the sample is large enough to carry one.

## Explicitly not in manual mode

World ingestion, standing sensors, continuous monitoring, multi-stakeholder anything, per-person calibration. Manual mode covers the judgment half only. Generation is exercised in P1b but not automated — and per the reuse map, generation is the part with no existing machinery, so it is deliberately the last thing to build.
