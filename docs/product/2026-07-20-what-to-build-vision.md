# What To Build — The Judgment Layer

**Status:** VISION (working ledger — actively moving, not signed off)
**Date:** 2026-07-20
**Format:** named claims plus a joint register. Dogfoods the artifact it specifies: every danger is recorded as a **joint** (a testable question with branches and a resolution method), not as a caveat. Per `ONE-UNDER-TEST` the experiment queue is depth 1 — many joints may be open, one is under test.

## Related Documents

- [The Discovery Loop](2026-07-20-discovery-loop-vision.md) — three corrections today ran in its favour (`LADDER-CORRECTION`, `TREE-OF-FUTURES-RESTORED`, `THE-CYCLE`). Its rungs were the right organs; this doc supplies the spine connecting them.
- [COMP-FOH — Front of House (Maya + SmartMemory)](../features/COMP-FOH/design.md) — candidate substrate.
- [Front-of-Funnel Rigor + Parity](../design/2026-07-20-front-funnel-rigor-design.md) (COMP-PLAN-RIGOR) — supporting infrastructure.
- [COMP-ROADMAP planning-model design](../plans/2026-06-21-roadmap-planning-model-design.md) — shipped spine below all of this.
- **Operationalization:** [Judgment Layer — Process Manual](../design/2026-07-20-judgment-layer-process-manual.md) — the six processes (P1–P6) written to be run by hand, so the friction points become the automation spec.

**Grounding key:** `[EXT]` external evidence · `[INT]` internal/build history · `[ASSERT]` owner assertion, unvalidated · `[DERIVED]` follows from other claims · `[owner-locked]` decided by owner this session

*(Renamed from C-n / J-n numbering 2026-07-20 — the numbers were unreadable. Names are stable from here.)*

---

## 1. The stack

```
GENERATION    where candidates come from            ← shape locked, mechanism undesigned
VALUATION     what makes one candidate worth more   ← structurally absent
JUDGMENT      is this candidate well-grounded       ← specified below
──────────────────────────────────────────────────
EXECUTION     goal → plan → build → ship            ← Compose today, works
```

**`MIDDLE-NOT-TOP`** `[DERIVED]` — The first draft locked the middle layer and called it the top. Deciding requires generating options, valuing them, and judging the evidence. Only the third was specified.

**`GENERATION-DOMINATES`** `[DERIVED]` — **Decision quality is capped by the best option considered.** Perfect judgment over three mediocre candidates yields a mediocre outcome. Generation therefore has strictly more leverage than evaluation, and we built the evaluation half first.

**`NO-VALUATION`** `[ASSERT]` — Worth cannot be derived from evidence. Evidence establishes what is *true*, not what is *worth doing*. Ranking requires an objective function: target customer, opportunity cost, capital, time horizon, risk appetite, what you are not doing instead. Proving onboarding costs 20% of signups does not establish that fixing onboarding beats fixing pricing. **Largest structural hole.** → `JOINT: valuation-exists`

---

## 2. The operating cycle (the spine)

**`THE-CYCLE`** `[DERIVED]`

```
positions → joints → rank by value of information → ONE under test
  → resolve by (external evidence | construction | marked assertion | straddle)
  → update positions + branches → repeat
```

Everything below is an organ of this cycle.

---

## 3. What the product actually is

**`OPERATIONALIZATION-IS-THE-PRODUCT`** `[owner-locked]` — The ideas in this doc are not the product. Everything here is derivable; anyone reasoning carefully arrives at it. The product is letting a human plus agents execute it **repeatably**, instead of re-deriving it under pressure and stabbing intuitively.

**`CONSTRAINTS-ARE-THE-UX`** `[owner-locked]` — Constraints are what convert this from advice into a process, and they drive the interface. "Think rigorously" is not enforceable. *One joint under test*, *kill criteria before building*, *prediction before construction* are. **What the UI permits and refuses is the methodology.**

**`AUTOMATION-MAKES-IT-FREE`** `[owner-locked]` — Automation decides whether any of this survives. Structure alone has been tried and abandoned repeatedly — decision journals, premortems, argument mapping, all correct, all dead — because discipline costs the user something every time. The ledger must be written from work already happening, joints surfaced rather than authored, branches built rather than planned. This is the difference between a methodology and a product. → `JOINT: ledger-used`

---

## 4. The unit of value: the ledger

**`LEDGER-IS-THE-VALUE`** `[DERIVED]` — The product's output is a **testable record**, not a decision aid: what was claimed, what was rejected, how strongly it was held, when. *Rejected:* the reasoning-aid framing.

**`LEDGER-SURVIVES-THE-ATTACK`** `[DERIVED]` — Recording that you *knew* and proceeded is more valuable than recording that you didn't know. The decision-aid framing dies to `UNEXAMINED-OR-UNWILLING`; the ledger does not.

**`LEDGER-IS-FALSIFIABILITY`** `[DERIVED]` — A dated claim with named alternatives and stated conviction *is* the timestamped prediction that makes the system checkable. One artifact, two jobs.

**`NEVER-CAPTURED-BEFORE`** `[ASSERT]` — The two fields that matter have never been capturable: **rejected alternatives** and **conviction at the time**. Hindsight rewrites both — people recall more certainty than they had, and forget options dismissed in seconds.

**`AGENT-IN-THE-ROOM`** `[ASSERT]` — An agent present at the decision captures both for free. The defensible form of the moat claim: *only something in the room can record what you rejected and how sure you were.* → `JOINT: ledger-used`, `JOINT: conviction-inferred`

---

## 5. Evidence and grounding

**`EVIDENCE-BY-SOURCE`** — Evidence is typed by source; one system, **no degraded mode**. `EXT` (users, market, competitors, live data) · `INT` (build exhaust, own history) · `ASSERT` (owner says so). External is worth far more but **must never block** — its absence degrades grounding, not function. *Amended:* source type is **not** reliability. A stale survey should not beat direct domain knowledge. Reliability is per-item, with source as one input.

**`GROUNDING-PER-STEP`** `[ASSERT]` — Grounding is a property of each step, not of the position. **Data at the bottom, assertion at the joints.** "Signups dropped 20%" is measurement; "because onboarding confuses people" is an untested leap. *Amended:* "weakest load-bearing step" was false precision — arguments have multiple sufficient paths, correlated premises, probabilistic ones. Replaced by sensitivity. → `JOINT: sensitivity-computable`

**`STRUCTURE-NOT-PROSE`** `[DERIVED]` — Prose reads as uniformly confident and hides which joint carries the weight. Only structure makes joints addressable, and only addressable joints can be attacked where positions actually break.

**`UNEXAMINED-OR-UNWILLING`** `[ASSERT]` — **The deepest premise.** That bad build decisions come from *unexamined* reasoning. Competing explanation: people already know their shaky assumption and build anyway — momentum, identity, irreducible uncertainty, or checking costing more than being wrong. *Status:* substantially neutralized by `LEDGER-SURVIVES-THE-ATTACK` and `PREPARED-RECOVERY`. Still the deepest premise; no longer clearly fatal. → `JOINT: already-knew`

---

## 6. Branching

**`JOINTS-ARE-BRANCH-POINTS`** `[owner-locked]` — An unresolved joint forks the plan: *if it holds → strategy A; if not → strategy B.* Uncertainty becomes structure rather than a blocker.

**`VALUE-OF-INFORMATION`** `[DERIVED]` — Research priority is **value of information, not uncertainty**. A joint is worth resolving *only if flipping it changes the strategy.* Identical branches mean the joint is irrelevant however unsure you are. Most research burns on uncertainty that changes nothing.

**`PREPARED-RECOVERY`** `[DERIVED]` — Branching answers `UNEXAMINED-OR-UNWILLING` more completely than the ledger alone: a prepared alternative changes the **recovery** even when naming the risk changes nothing. You still build; when the joint resolves against you, the switch is already chosen rather than improvised late under pressure.

**`JOINTS-ARE-THE-WATCHLIST`** `[DERIVED]` — Open joints are the ingestion filter. Signal bearing on a branched joint is high-priority by construction; the rest is noise. **This closes the generation↔judgment loop** — previously two adjacent systems.

**`ONE-UNDER-TEST`** `[owner-locked]` — Distinguish *open* from *under test*: the register holds many joints, the **experiment queue has depth 1**. Kills combinatorial blowup without pretending there is only one uncertainty. Serial resolution is strictly more informative than parallel — each result re-ranks what follows. Selection rule is `VALUE-OF-INFORMATION`.

**`TREE-OF-FUTURES-RESTORED`** — Restores Discovery Loop rung 5 with a mechanism: branches keyed to specific unresolved joints, not arbitrary ambitious-vs-minimal framings.

**`BRANCHING-FAILURE-MODES`** — Combinatorial blowup (contained by `ONE-UNDER-TEST`). Branch rot (defended by `JOINTS-ARE-THE-WATCHLIST` — a branch stays live because signal keeps arriving against its joint). Passed branch points (joints resolving only after action was possible — mark them, don't present them as live options).

---

## 7. Generation

**`GENERATION-SHAPE`** `[owner-locked]` — **world → raw signal → processing (internal + external) → candidates.**

**`SIGNAL-NOT-IDEAS`** `[ASSERT]` — The world emits signal, not ideas. Complaints, gaps, competitor moves, shifts, papers, conversations. An idea is *made* by interpreting signal against a context. Generation is never a feed reader.

**`INTERPRETATION-IS-THE-ASSET`** `[ASSERT]` — Ingestion is commodity; interpretation against accumulated context is not. The same signal means different things depending on goal, product state, and what was already tried and failed. Compose holds that context. Defensibility line independent of the moat claim.

**`KEEP-THE-RAW`** `[DERIVED]` — The interpretation function changes as the goal changes, so discarded signal can become valuable later. Ingestion and interpretation are separate stages with separate storage; interpretation must be re-runnable over history. Filtering at ingest permanently loses everything that was merely early.

**`OPPOSITE-FAILURE-MODES`** `[DERIVED]` — Evaluation fails by being too permissive; generation fails by being too narrow (only ever variations of what you already have). They cannot be one mechanism, and judgment machinery cannot be stretched upward to cover generation.

**`LOW-YIELD-BY-DESIGN`** `[DERIVED]` — Most ingested signal is worthless. Judge ingestion by **rejection ratio, not volume**. Anything surfacing most of what it ingests is broken.

**`CONTINUOUS-INGEST`** `[ASSERT]` — Ingestion is continuous, not invoked; signal arrives on the world's clock. Invoked ingestion degrades to on-demand research, which is commodity. → `JOINT: ingest-continuous`

**`THE-WORLD-CAN-ARGUE`** `[DERIVED]` — Continuous ingest plus standing positions means **the world can knock down a belief you already hold.** A feed cannot contradict you (it doesn't know what you think); a journal cannot be contradicted (nothing new arrives). Both halves make the ledger live rather than archival, and retire the flattery-engine risk structurally rather than by policy.

---

## 8. Resolution: how a joint gets settled

**`THREE-WAYS-TO-RESOLVE`** `[owner-locked]` — **(a) external evidence** — look at the world. **(b) assertion** — owner decides, marked unproven. **(c) construction** — build the cheapest thing that makes the answer observable. Most decision tools offer only (a). Compose can do (c) because it is already an execution engine: **execution becomes an instrument for resolving decisions**, not only post-decision delivery.

**`MOAT-FINAL-FORM`** `[DERIVED]` — Ambient build exhaust is worthless for "what to build" (killed — closed loop). Exhaust from a **targeted experiment against a named joint** is high-grade evidence. The difference is intent and targeting, not the data.

**`CONSTRUCTION-TRAP`** — **Severe; expect erosion here first.** "Build it and find out" is what everyone already does and the most expensive way to be wrong. Construction-as-evidence and self-deception are indistinguishable from outside. The **only** separator is that the joint and its outcome criteria were recorded *before* building. Without a recorded prediction, "building to test the hypothesis" is just building with better vocabulary. → `JOINT: construction-discipline`

**`TAG-BY-RESOLUTION`** — Not every joint is constructible. Feasibility and some behaviour joints, yes; "will anyone pay", usually not absent distribution — you ship, learn nothing, and read the silence as a result. Untagged, construction becomes the default answer to everything because it is the nearest tool to hand.

### Straddling — the fourth disposition

**`STRADDLE`** `[owner-locked]` — Don't resolve the joint: **build all its branches and let reality pick.** Correct when *cost of building all branches < cost of being wrong × probability of being wrong.* The first disposition that does not require knowing the answer.
**Composes with `ONE-UNDER-TEST`, does not contradict it:** that rule caps *joints* under test at one; straddling parallelises *within* one joint. Three branches of one joint is three builds, not 2^N. The depth-1 queue bottlenecks questions, not throughput.
*Why it matters:* years are not lost building the wrong thing, they are lost **committing** to a branch before anything could distinguish them — a commitment historically forced by construction cost. Cheap construction unforces it.

**`STRADDLE-NEEDS-MEASUREMENT`** `[DERIVED]` — Three artifacts tell you exactly what one does unless something distinguishes them afterward. Inherits `JOINT: external-reachable` wholesale. Absent a discriminating signal, straddling is **3× the self-deception, delivered faster**.

**`KILL-CRITERIA-FIRST`** `[DERIVED]` — The failure mode is not picking wrong, it is **keeping all three**. Branches must be disposable by construction with the kill rule recorded in advance — same discipline as `CONSTRUCTION-TRAP` at higher stakes, because working code argues for its own survival and each branch has an author's attachment behind it.

**`STRADDLE-INVERSION`** `[DERIVED]` — Cheap-to-parallelise ≠ consequential. Leaf decisions branch cleanly. **Trunk decisions — architecture, data model, positioning, who the customer is — cannot coexist**, and that is where the expensive mistakes live. Straddling attacks the class of waste that was already survivable and does not reach the class that kills companies. → `JOINT: straddle-reaches-trunk`

---

## 8b. Reversibility (agenda item 1 — resolved)

**`LEDGER-ALWAYS-ON`** `[owner-locked]` — The machinery always applies to *some* degree; near-zero is a quantity, not an exemption. **The record is always on; what scales with reversibility is the deliberation** (branching, testing, adversarial pressure). Viable only because capture is automated and therefore free — see `AUTOMATION-MAKES-IT-FREE`. *Supersedes* the earlier proposal of a silent no-op quadrant, which conflated the ledger with the machinery.

**`TRIVIAL-DECISIONS-ARE-TRAINING-DATA`** `[DERIVED]` — Cheap reversible decisions **resolve in days, not months**, so recording them supplies the fast calibration corpus that strategic outcomes cannot. Partially unblocks `JOINT: calibration-timely`: the signal comes from the decisions that "didn't need" the process, which is why the ledger must not switch off for them.

**`REVERSIBILITY-IS-A-METER`** `[owner-locked]` — Not a one-and-done gate but a **tracked quantity that only decays**. Every dependency added, user onboarded, schema written to, and public statement made lowers it. The valuable output is the *derivative*: this is calcifying faster than expected, or a one-way door is about to close. Nobody notices the moment a door stops being two-way — that is the thing worth surfacing.

**`REVERSIBILITY-IS-OBSERVABLE`** `[DERIVED]` — Measurable from the work itself (accumulating dependencies, data written, surface exposed) rather than polled from the owner. Same automation argument as the ledger, and same in-the-room advantage.

**`REVERSIBILITY-MISCALLS-GRADE-YOU`** `[DERIVED]` — "Called it reversible, turned out not to be" is recorded at the time and checkable soon after. A far shorter calibration loop than grading whether a strategy was right, and it grades the owner's judgment specifically.

---

## 8c. The stopping rule (agenda item 2 — resolved)

**`STOP-WHEN-NOTHING-LEFT-TO-LEARN`** `[DERIVED]` — Deliberation ends not when confidence is high but when **the best remaining joint isn't worth resolving**: its value of information no longer exceeds the cost of settling it. Harder to self-deceive past than a confidence threshold, because it is about the questions rather than feelings about the answer. Requires the cost term (agenda item 4) to be computable — the rule is incomplete without it.

**`DELAY-IS-PRICED`** `[DERIVED]` — Waiting is not free: `REVERSIBILITY-IS-A-METER` decays while you deliberate. Deliberate while changing your mind is cheap; act before it stops being. This is the real answer to analysis paralysis, which is failure to price delay. A system that can always find one more joint is a sophisticated way to never ship; the VOI-vs-cost threshold plus a priced clock is the only defence.

**`STRADDLE-SUSPENDS-STOPPING`** `[DERIVED]` — Where branches can be built in parallel, you need not stop deliberating at all — act on both, let the world decide. Stopping therefore only *binds* where straddling is unavailable, which by `STRADDLE-INVERSION` is precisely the trunk decisions. Stopping matters exactly where it is hardest.

**`COMMIT-BUTTON-APPEARS-WHEN-EARNED`** `[owner-locked]` — The commit action is **surfaced by the condition**, not always present and not a separate ceremony. Purest instance of `CONSTRAINTS-ARE-THE-UX`: the criterion becomes an affordance.

**`OVERRIDE-IS-THE-BEST-ENTRY`** `[DERIVED]` — Committing against the system's judgment must always be possible, and is **recorded as a ledger entry** ("committed with N open joints, high VOI, owner overrode"). Overrides are the highest-value records in the ledger: the moments the process was overruled are where the owner's judgment is most exposed and most learnable. Without an override the system gates decisions it will sometimes be wrong about.

**`THREE-TRIGGERS-NOT-ONE`** `[DERIVED]` — The commit moment arrives for three distinct reasons and the ledger must record which: **earned** (nothing left worth learning), **forced** (reversibility about to cross — out of time, not out of questions), **exhausted** (budget/runway gone). Identical in the moment, completely different in retrospect, and nobody remembers which it was six months later.

**`READY-IS-NOT-VALIDATED`** — **UX warning.** Surfacing the button nudges hard, and users will read *"nothing left worth learning"* as *"this has been validated."* The first is a claim about exhausted questions; the second is a claim about the idea being good, which the system **cannot** make — that is `NO-VALUATION`. If the interface blurs them it manufactures false confidence behind a rigorous-looking process, which is worse than no process.

---

## 8d. Cold start and "arrive with nothing" (agenda item 3)

**`NOTHING-MEANS-NO-CANDIDATE`** `[owner-locked]` — "Arrive with nothing" means no *candidate*, not no *context*. Everyone has a domain, a dissatisfaction, an ambition, constraints, and unfair advantages. That context is **un-elicited, not absent**. *Corrects* the earlier claim that day-one generation is impossible for want of accumulated context — elicitation and accumulation are two sources of the same thing, and a good advisor gets most of it in the first hour.

**`ELICIT-GENERATE-VALUE`** `[owner-locked]` — The layer before "I'm thinking of building X":
```
ELICIT   situation, constraints, assets, dissatisfactions, and what you are optimizing for
GENERATE candidates from: gap to goal · unfair advantage · world signal · inverted constraint
VALUE    rank against the elicited objective function
         → hand off to the judgment layer as a candidate with joints
```

**`GENERATION-WITHOUT-VALUATION-IS-A-LIST`** `[DERIVED]` — **A list is worse than nothing.** Someone arrives with no candidate and leaves with fifty: more stuck than before, goodwill spent. Generating candidates is commodity; the scarce part is that they are grounded in *this* person's situation and come back **ranked**. Therefore `NO-VALUATION` does not merely leave a hole — **it blocks the arrive-with-nothing case entirely.** Generation and valuation are one capability, not two agenda items. The arrive-with-a-candidate case can duck valuation because the user already chose; this one cannot.

**`WORTH-IS-CONSTRUCTED-WITH-HELP`** `[owner-locked]` — Fourth and current branch for `JOINT: valuation-exists`. Worth is **not computable** (no function exists over nothing), **not elicited** (the owner may not know), and **not revealed by choices** (see the killed claim below). It is **constructed, with help, then held to**: the system supplies evidence, reasoning and challenge until the owner arrives at an objective function they can defend. Preferences here are *formed*, not discovered, and articulation is what forms them. This is the advisor role, and it is why the advisor comparison keeps recurring.

> **KILLED — `WORTH-IS-REVEALED-BY-CHOICES`** (proposed and killed same session). Claimed the objective function could be learned implicitly from the owner's choices, with the ledger as training data. **Fatal objection (owner): it contradicts the product's own premise.** This product exists because people decide badly under uncertainty; if so, their choices encode guessing and salience, not a coherent preference. Fitting a model to that and returning it as "your taste" is the flattery engine wearing statistics. Cannot simultaneously hold that people need help deciding and that their decisions are ground truth about what they value.
> **Salvaged, much reduced:** stated-vs-enacted divergence remains a useful *question generator* — "you said long-term platform value; the last nine calls were all this-quarter" flags something worth asking about. It is **not** a preference estimator.

**`SELF-KNOWLEDGE-IS-A-SPECTRUM`** `[owner-locked]` — Not everyone is bad at stating what they want; some are reliable self-reporters. Where a given owner sits is **measurable and must be measured**, as a running tally rather than a one-time judgment (compare `REVERSIBILITY-IS-A-METER`). The tally dials the posture: **consistent → trust the stated objective function and act as executor; inconsistent → work constructively** (`WORTH-IS-CONSTRUCTED-WITH-HELP`). The advisor stance is therefore earned per person, not fixed — the existing gate/flag/skip dial pointed at a new quantity.

**`CONSISTENCY-IS-NOT-CORRECTNESS`** `[DERIVED]` — The tally measures **self-knowledge, not judgment quality**. Someone can be perfectly consistent and consistently wrong. A consistent owner is trusted about *what they want*, never about *whether it is a good idea*. Conflating the two lets coherence launder bad calls.

**`DRIFT-VS-UPDATE`** `[DERIVED]` — Changing one's mind on evidence is good; changing weekly for no reason is not. Both look identical in a raw consistency count. The ledger records *why* things changed, so it can separate a principled update from drift — without it, all change reads as noise.

**`PREFER-BEHAVIOURAL-TALLY-OVER-PSYCHE-MODEL`** — A consistency count is **auditable**: the instances can be shown and the owner can dispute the reading. "Your personality suggests low self-insight" is unfalsifiable, paternalistic, and wrong often enough to matter. Use the psyche model as a **weak prior at cold start only**, overwritten by observed behaviour as soon as there is any. Refines `PERSONALITY-DRIVES-STYLE-NOT-WORTH` into three clean destinations: personality → interaction style; personality → *initial* confidence in self-report (weak, temporary); observed behaviour → the consistency tally. Still never personality → what is worth building.

**`CONSTRUCTIVE-INFLUENCE-MUST-BE-AUDITABLE`** `[DERIVED]` — A system that helps *construct* preferences has real influence over them, and can shape the owner wrongly or toward its own defaults — experienced as having made up one's own mind. This is the cost of the advisor role and the strongest argument for inspectable reasoning (`STRUCTURE-NOT-PROSE`): something shaping what you want must be auditable in a way something merely serving you need not be.

**`THE-GOAL-IS-A-POSITION`** `[DERIVED]` — The objective function is itself a position with joints. "You are optimizing for revenue in eighteen months" is an assertion that can be wrong, that evidence can contradict, that deserves branches. **This is what Discovery Loop rung 6 ("doubt the goal") actually is** — not a mystical meta-capability, but the same machinery pointed at the goal. Fourth correction in that doc's favour.

**`PERSONALITY-DRIVES-STYLE-NOT-WORTH`** `[DERIVED]` — Where Maya and Compose combine: **shared capture, separate models.** One observation stream over the same conversations, two destinations. Personality → interaction style, pacing, how much challenge the owner tolerates. Product judgment → what gets ranked. **Personality must never feed valuation directly** — "he's a big-picture guy, rank the ambitious one" is a category error dressed as personalization: it feels insightful and is noise.

**`QUIZZING-IS-LICENSED-BUT-DECAYS`** `[owner-locked]` — Direct questioning is tolerated here where it is not for personality, because the stakes justify it and every advisor does it. **But tolerance decays:** in the first conversation questions signal seriousness; by the fiftieth, re-asking what someone values is an insult, because it means nothing was retained. Explicit questioning is a cold-start instrument that must hand off to accumulated understanding — the handoff is the design problem.

### Maximising signal from the initial conversation

**`QUIZ-IS-GOVERNED-BY-VALUE-OF-INFORMATION`** `[DERIVED]` — Ask the question whose answer **changes what happens next**, not the one that is interesting. Same rule as joint selection, applied to elicitation. Implies the quiz must be **adaptive** — each answer re-ranks the remaining questions — which is the real reason a conversation beats a form, not aesthetics.

**`FORCED-TRADE-OFFS-BEAT-STATED-PREFERENCES`** `[DERIVED]` — "Speed or quality?" returns *both*, always, for free. "Ship late or ship broken?" forces an ordering. Preferences stated in isolation cost nothing and reveal nothing; **ranking under constraint is the objective function**, so trade-off questions are the highest-signal instrument available.

**`CONCRETE-PAST-OVER-ABSTRACT-FUTURE`** `[DERIVED]` — "What are you optimizing for?" yields a socially acceptable abstraction. "What did you say no to last month, and why?" yields data. People narrate values aspirationally and decisions accurately.

**`CONSISTENCY-READ-IN-ONE-SITTING`** `[DERIVED]` — Asking for stated principles **and** recent concrete decisions in the same conversation gives a first read on `JOINT: self-report-reliable` immediately, by checking whether they match. Solves that dial's cold start — it does **not** require months of accumulated behaviour as previously assumed.

**`NEVER-ASK-WHAT-YOU-CAN-OBSERVE`** — Compose sits on the repo, roadmap and history. Asking what could have been read burns tolerance and signals inattention — the opposite of the "it was listening" quality that makes `QUIZZING-IS-LICENSED-BUT-DECAYS` survivable. Questions are reserved for what exists only in someone's head.

**`EVERY-ANSWER-RETURNS-SOMETHING`** — An extractive interview is onboarding tax and gets abandoned. Each answer must visibly sharpen something the owner can see (a candidate, a joint, a trade-off made explicit). **The quiz is not a preamble to the product, it is the first session of it** — if it is separable, it is a form, and it will be skipped.

**`CONTINUITY-OVERRIDES-OPTIMALITY`** `[owner-locked]` — Value of information and conversational flow pull against each other: the highest-signal question is often not the one that follows from what was just said, and always jumping to it produces whiplash that reads as a script. **VOI ranks candidate questions; conversational continuity breaks ties and may override** — take the second-best question when it is on-thread. Slower to converge, far more likely to survive.

**`LISTENING-BEATS-ASKING`** `[DERIVED]` — Most high-signal material arrives unprompted; real constraints and frustrations surface in asides, not answers. Harvest from the narrative first; ask only for what did not come out.

**`NO-QUIZ-OBJECT`** `[owner-locked]` — There is a **coverage model** of what needs to be known and a conversation that opportunistically fills it. The checklist is internal and invisible, questions are the fallback rather than the mechanism, and nothing is ever presented as a stage to complete.

**`COVERAGE-MODEL-IS-INSPECTABLE`** — Guard against the obvious abuse: a conversation engineered to extract is warm and still extractive. The coverage model must be viewable on request — "here is what I still don't know about you, and why it matters." Transparency without formality; same principle as `CONSTRUCTIVE-INFLUENCE-MUST-BE-AUDITABLE`, since something shaping your conclusions should not be doing invisible work on you.

**`ELICITATION-IS-THE-PRODUCT-HERE`** — Risk concentration. A form kills this outright; nobody completes fifteen fields about their ambitions. A genuinely good conversation is the most valuable hour the product has. Note the implied competitor: **not Productboard, but a decent advisor** — a higher bar and a better business. → `JOINT: elicitation-works`

---

## 8e. Cost (agenda item 4 — resolved)

**`THREE-DISPOSITIONS-ONE-COMPARISON`** `[DERIVED]` — For any joint: **resolve** (pay the test cost), **straddle** (pay the build-both cost), or **assert** (pay the expected cost of being wrong). Choose the cheapest path to an acceptable outcome. A single comparison, not three mechanisms. **Completes the stopping rule**: you stop when *asserting is cheaper than resolving or straddling* — computable, where "nothing left worth learning" was not.

**`DEPTH-1-MAKES-OPPORTUNITY-COST-REAL`** `[DERIVED]` — With one slot (`ONE-UNDER-TEST`), testing joint A means not testing joint B. A naive cost model misses this and will spend the slot on something cheap and unimportant. **The cost of a test includes the queue it blocks.**

**`COST-IS-OBSERVED-NOT-ESTIMATED`** `[DERIVED]` — Software estimation is reliably wrong, so a cost model built on owner guesses inherits the error. The ledger records how long past tests actually took: **estimate from history, not opinion.** Available for the same reason everything else here is — something was in the room when it happened.

**`COST-HAS-A-SHAPE`** `[DERIVED]` — Two days of effort now and two days spread over three weeks are different costs, because `REVERSIBILITY-IS-A-METER` decays throughout. Elapsed time can dominate effort when a door is closing. `DELAY-IS-PRICED` belongs *inside* the cost term, not beside it.

**`COARSE-BUCKETS-NOT-FALSE-PRECISION`** — Quantifying invites three significant figures over guesses. Use hours / days / weeks / months. Nothing is lost and the honesty is preserved — same lesson as replacing weakest-link with sensitivity in `GROUNDING-PER-STEP`.

---

## 8f. Staleness (agenda item 5 — resolved)

**`STALENESS-FAILS-SILENTLY`** — The sleeper risk. Everything else fails loudly (bad joints get attacked, wrong positions get contradicted); staleness fails quietly, and **a confidently stale ledger is worse than none** because it carries the authority of having been reasoned through. Four rots, differently handled: **evidence expires**; **resolved joints re-open** (most dangerous — they leave the watchlist by design and stop being observed); **the objective function drifts** while every downstream ranking still uses the old one; **killed candidates deserve revival** when the reason for killing them becomes false (`KEEP-THE-RAW` applied to candidates).

**`STALENESS-IS-RE-DERIVATION-NOT-AGE`** `[DERIVED]` — Age alone does not make a claim wrong; a two-year-old structural fact may be perfectly sound. What makes it wrong is that **the ground under it moved**. The check is therefore "did the supporting evidence change", not "is this old" — possible only because arguments are structured and evidence is linked (`STRUCTURE-NOT-PROSE` paying off).

**`THE-TIMER-SCHEDULES-THE-DECISION-NOT-THE-CHECK`** `[owner-locked]` — A cron re-verifying everything is wasteful, arbitrary, and expensive once research agents are involved. The periodic sweep **ranks**; a budget picks the top few; only those get dispatched. **Dispatch is governed by value of information** — re-check the claim where a change would most alter what you would do. Staleness checking is joint selection pointed backwards at settled things.

**`STALENESS-PRIORITY`** `[DERIVED]` — Each claim carries **evidence links**, expected **volatility** (competitor pricing rots in weeks; structural user facts in years) and **downstream impact** (how much rests on it). Priority = volatility × impact × time since last check.

**`TIERED-INSTRUMENTS`** `[owner-locked]` — Costs differ by orders of magnitude, so tier them:
- **Free — event-driven invalidation.** Ingestion is already pulling signal; when arriving evidence contradicts a linked claim, mark it shaken. No extra cost, but only catches what the pipe happens to see.
- **Cheap — standing sensors.** Page diffs, metric thresholds, changelogs. Continuous, near-zero cost, no reasoning. Most volatile facts can be *watched* rather than re-investigated.
- **Expensive — dispatched research agent.** Reserved for high VOI, or when a cheap sensor trips and the implication needs judgment.

Sensors run constantly; investigations run rarely and on trigger. This is a monitoring architecture and should be built as one.

**`COMPILE-THE-INSTRUMENT-DONT-BE-IT`** `[owner-locked]` — Prefer generating cheap deterministic automation over repeatedly dispatching agents. The expensive reasoning pass runs **once** and emits a *checker* (diff, query, threshold, scraper) which then runs forever at ~zero cost. **Reasoning as a compile step, not a runtime.** Three gains beyond cost: (1) **determinism is a feature** — an agent re-asked "has the picture shifted?" returns variance that will be misread as signal, whereas a comparison either changed or did not; (2) **scale** — 500 standing watchers is fine, 500 agent dispatches is not, so the maintenance budget stops binding; (3) **auditability** — a checker can be read, a recurring judgment call cannot.
**Division of labour:** *compile the detection, reserve the reasoning for interpretation.* The watcher notices the pricing page changed; the agent is woken to say whether it matters — expensive work firing on a real event rather than on a calendar.
**Generalises beyond staleness:** anywhere the system pays for the same *shaped* question repeatedly is a candidate for compilation.

**`BROKEN-SENSORS-READ-AS-CALM`** — **Serious.** Compiled checkers rot silently: pages restructure, APIs move, metrics get renamed — and a dead sensor is indistinguishable from "nothing changed". Same silent-failure class as `STALENESS-FAILS-SILENTLY`, one level up: monitoring goes quiet and quiet is read as calm. Watchers therefore need **liveness checks independent of their results** — proof they are still able to fire, not merely that they have not.

**`VOLATILITY-IS-LEARNED`** `[DERIVED]` — Observe how often re-checking a class of claim actually finds a change, and re-rank from that. Self-tuning from history, same mechanism as `COST-IS-OBSERVED-NOT-ESTIMATED`.

**`MAINTENANCE-HAS-ITS-OWN-BUDGET`** `[DERIVED]` — Otherwise re-verification competes with discovery for the same slot and one starves the other. Separate, smaller, and **visible** — a system quietly spending money re-reading the internet is its own failure mode.

**`SHAKE-GROUNDING-NOT-CONVICTION`** — Proposed resolution to auto-downgrade-vs-flag (owner: possibly a preference switch). The system may downgrade **grounding** automatically — the evidence under a claim is its to assess — but never **conviction**, which is the owner's. It can honestly say "this is less supported than when you wrote it" without touching "you were sure." Flag-only decays into noise once forty flags go uncleared; auto-downgrading belief is the influence problem in its most literal form.

---

## 8g. Multiple stakeholders (agenda item 6 — resolved)

**`FACT-DISPUTE-VS-VALUES-DISPUTE`** `[owner-locked]` — The core contribution here. The two look identical in the room and **resolve completely differently**: world-uncertainty yields to evidence, preference-disagreement does not — two people can agree on every fact and still want different things. Most unproductive strategy arguments are values disputes fought with studies: everyone brings data, nobody moves, because the data was never the disagreement. **The system must name which kind of argument is happening.** Cheap, immediately useful, and nothing does it today.

**`NEVER-MERGE-OBJECTIVE-FUNCTIONS`** `[DERIVED]` — Averaging priorities produces something neither party holds and nobody will defend: an **unowned preference**. Hold them separately, surface divergence, and make choosing between them an explicit decision with an owner rather than a silent blend.

**`AUTHORITY-IS-EXPLICIT`** `[DERIVED]` — The commit button needs a person attached. **Contributing evidence, dissenting, and committing are three distinct rights**; conflating them is how teams end up with decisions nobody made.

**`RECORDED-DISSENT-BEATS-THE-SOLO-LEDGER`** `[DERIVED]` — What actually goes wrong on teams is not bad decisions but that decisions are **remembered differently afterward** by each person. "I disagreed, here is why, on this date" protects the dissenter, ends re-litigation, and is **gradeable later** — you can see who was right when they disagreed.

**`CALIBRATING-PEOPLE-IS-THE-MOST-DANGEROUS-FEATURE-HERE`** — Comparing individuals' track records is technically trivial (the per-person dial from `JOINT: self-report-reliable` generalises directly) and **changes what the product is**. A system that scores who was right alters behaviour: dissent dries up once it is graded, or the record becomes a weapon in a performance review. Not a tuning problem — a category change. Flagged as more dangerous than anything else in this document.

**`PEOPLE-CALIBRATION-DEFERRED-TO-A-SEPARATE-PRODUCT`** `[owner-locked]` — Scoring individuals is **punted entirely**; it belongs to a different product, not this one. What survives into v1: calibration is **scoped to the question type, not the person** ("our integration-effort estimates are wrong 70% of the time, always the same direction") — more useful anyway, because a systematic bias is actionable where "Bob is bad at this" is not. Solo, self-directed and private is both the safest shape and exactly v1, so nothing is lost by deferring.
*Honest limit:* the technical part is easy and the social part is not controllable by design. Aggregate stats de-anonymise on a team of three; domain-scoped stats trace to whoever owns the domain. Safety here is a matter of **defaults**, not capabilities — anything shipped as an option is eventually switched on by someone with a reason.

**`ATTRIBUTION-NOW-EVEN-IF-TEAMS-LATER`** `[owner-locked]` — v1's user is a solo owner, so most of this can wait. But **the data model must not foreclose it**: attribution on claims, dissent and commits costs nothing today and is close to impossible to retrofit.

---

## 8h. Auditing the agent (agenda item 7 — resolved)

**`THE-RIGOR-POINTS-ONLY-OUTWARD`** — The asymmetry: this is a rigor machine aimed entirely at the owner — challenging assumptions, grading grounding, tracking consistency — and **nothing aims it at the system**. Its inferences arrive wearing structure and confidence, the packaging that makes error hardest to see.

**`AGENT-INFERENCES-ARE-POSITIONS-TOO`** `[DERIVED]` — "This is the load-bearing joint", "you believed X at strength Y", "this evidence is reliable" are all claims with grounding, and get the same treatment as any other position. Same recursion as `THE-GOAL-IS-A-POSITION`. **Floor to stop infinite regress:** audit only inferences that are load-bearing *and* cheap to check — `VALUE-OF-INFORMATION` again.

**`AGENT-CALIBRATION-IS-FREE`** `[DERIVED]` — The agent's judgments are falsifiable by outcome, and outcomes are already collected: did the failure land on the joint it named? Was the captured conviction right (owner corrects on the spot)? Was the evidence later contradicted? Calibration therefore comes from the same ledger at no extra cost, and per `PEOPLE-CALIBRATION-DEFERRED-TO-A-SEPARATE-PRODUCT` it is **scoped to inference type** — "joint identification is wrong 40% of the time on architecture decisions" says exactly where to distrust it.

**`WHO-CHECKS-THE-CHECKER`** — Ranked: **reality** (outcomes are external to the agent's reasoning — not self-assessment, and by far the strongest); **the owner**, for immediately verifiable captures; **an independent adversarial pass** — *high recall, poor precision*, demonstrated in this very session, where an outside review caught the missing generation layer and missing objective function that self-review walked past, while grading 9 of 10 findings FATAL; **the owner again**, adjudicating. It bottoms out at a human, which is acceptable, but makes owner attention the scarce resource — it must not be spent sifting noise.

**`ADVERSARIAL-REVIEW-ALREADY-EXISTS`** `[EXT]` — Verified in-repo: Codex review is a live gate in `pipelines/build.stratum.yaml`, `build-quick`, `refactor`, and `review-fix`, with a structured `ReviewResult` schema and a review→fix→re-review loop (`pipelines/review-fix.stratum.yaml:15`). **Auditing the judgment layer is a reuse, not a build** — materially cheaper than assumed. Two carried problems:
- *Reviews against a reference, and judgments have none.* In `build`, Codex checks code against the blueprint. **The joint register is the missing reference:** review a position against its own claimed grounding — does the evidence support the claim, is the named joint really load-bearing, what is absent. Same shape as blueprint-conformance.
- *Category error on non-code artifacts is documented.* Pointed at a design doc it reviews it as shipped code. Even when told explicitly to judge the argument, this session's pass returned 9 of 10 findings graded FATAL. The reuse needs its own lens **and its own grading contract**, not just a different input.
- The `review-fix` loop is already the adjudication loop **minus the human**, and today showed the human cannot be removed: precision is too low to act on unsorted findings.

**`JOINT-RECALL-IS-THE-NUMBER`** `[DERIVED]` — **The one that matters.** Everything surfaced gets scrutinised; what the system **never mentions is invisible**, producing no artifact to audit. Same silent-failure class as `BROKEN-SENSORS-READ-AS-CALM`, and undetectable by inspection. The only detector is postmortem: *when something broke, was the cause on the list?* **Joint recall — the fraction of things that actually went wrong which were named beforehand — is the single most important metric about this system.** Everything else is decoration by comparison.

---

## 8i. Product boundary: separate product or a layer in Compose?

Decision criterion (owner): how much is reusable, and from Compose vs Stratum.

**Reuse map.** Construction-as-resolution and straddle (parallel branches) → **Compose** build lifecycle + parallel merge machinery. Adversarial review loop → **Compose/Stratum**, verified live in four pipelines. Agent dispatch, flows, background runs → **Stratum**. Crystallization target (`feature.json`, roadmap) → **Compose**. Memory, conversation, profiling → **SmartMemory/Maya**. World ingestion, compiled sensors, valuation → **nothing; genuinely new.** Roughly two-thirds reuse, and **the new third is almost entirely the generation half** — the same part that is least designed.

> **STATUS: OPEN — NOT DECIDED.** Recorded as decided in error; owner reopened. The argument below is one side only, and is materially weakened by `TRANSFER-LINE-IS-CONSTRUCTABILITY` and `MONOLITHS-ARE-HARD-TO-SPLIT` below.

**`BUILD-IT-INSIDE-EXTRACT-LATER`** *(proposed, contested)* — Build as a layer within Compose with a clean seam; extract only if a reason appears.
1. **The differentiators span the boundary.** Construction-as-resolution requires the build engine (`THREE-WAYS-TO-RESOLVE`, `MOAT-FINAL-FORM`). Split them and what remains is a judgment tool the incumbents already approximate (`JOINT: differentiated`) plus a build tool. **The value is the join**, so a seam through it destroys the thing being built.
2. **The dependency is already one-way and clean.** Judgment depends on execution; execution does not depend on judgment (Compose builds fine without any of this). That is what layering-within-a-product is for — the structure is obtained without paying for a boundary.
3. **Precedent, twice.** COMP-FOH settled the identical shape for Maya: part of Compose, a layer over the core, extractable later, opt-in at the boundary and all-in inside it.

**`PRODUCT-BOUNDARY-IS-NOT-DEPENDENCY-STRUCTURE`** — Conflation worth separating: building directly on Stratum's dispatch and flows **does not require being a separate product**. Compose already depends on Stratum; a layer inside Compose can depend on Stratum just as directly. Independence of substrate ≠ independence of packaging.

**`TRANSFER-LINE-IS-CONSTRUCTABILITY`** `[owner-locked]` — *Supersedes the earlier "non-software users would flip it" condition, which was wrong.* The transfer boundary is **not** product-vs-non-product. It is **whether the joint's experiment can be built**:
- **Pricing** — the experiment *is* software (price tests, paywall variants, checkout flows). Construction-as-resolution works fully; straddling is just an A/B test. **Sweet spot.**
- **Market entry** — landing pages, ad tests, per-segment waitlists. Also software. **Sweet spot.**
- **Hiring** — the experiment cannot be built; straddling means actually hiring both. Ledger, joints, branches and evidence still work, but the differentiator does not. **Commodity version.**

Pricing and market entry are *software decisions that are not product decisions*, and they retain the entire differentiator — so the line runs through the middle of "non-product", not around it.

**`MONOLITHS-ARE-HARD-TO-SPLIT`** `[owner]` — Counter-argument to `BUILD-IT-INSIDE-EXTRACT-LATER`, largely conceded. Packaging and architecture are independent: two interoperating components can ship as **one product with the integration hidden**, so "sell it as one thing" is not an argument for building it as one thing. "Extract later" is a promise codebases rarely keep. The opposing cost — a boundary drawn before it is felt is worse than none, and its tax compounds — **only holds when the seam is unknowable in advance.** If the domain hands you the seam (**judgment engine** vs **construction resolver**, per `TRANSFER-LINE-IS-CONSTRUCTABILITY`), it is not unknowable and the objection largely dissolves.

**`CHECK-BEFORE-DECIDING`** — Load-bearing fact, unverified: **has this codebase ever actually extracted something it called "extractable later"?** COMP-FOH used the phrase for Maya, citing a COMP-ROADMAP pattern. If nothing has ever been extracted, "extract later" is a story and `MONOLITHS-ARE-HARD-TO-SPLIT` wins outright. Verify before deciding the boundary.

**`LEAN-ON-SMARTMEMORY-MAXIMALLY`** `[owner-locked]` — Maximize reuse of SmartMemory as the substrate rather than rebuilding storage, typing, evolvers, or challenge machinery. *Constraint preserved from COMP-FOH:* the kitchen still runs headless — maximal leaning applies to the judgment/front-of-house layer, not to Compose's portable core.

---

## 8j. Escalation — the vertical loop

Previously missing. What was recorded is **horizontal** (the world contradicts a position). This is **vertical**: scoping, design, spikes and build all feed back up — into the feature premise, the product position, and ultimately the objective function.

**`EXHAUST-IS-EVIDENCE-INTO-THE-SAME-GRAPH`** `[DERIVED]` — Not a new mechanism. Downstream work emits evidence bearing on upstream claims, and invalidation propagates by walking the same evidence links as `STALENESS-IS-RE-DERIVATION-NOT-AGE` — world-sourced and build-sourced evidence enter the identical graph. This is the **targeted** form of build exhaust salvaged in `MOAT-FINAL-FORM`, not the ambient form that was killed. It also supplies the mechanism the Discovery Loop's "dissolution" always lacked.

**`THE-ESCALATION-LADDER`** `[owner-locked]` — implementation detail → feature design → feature premise → product position → objective function. **How far a contradiction propagates is computed by walking links, not judged by feel.**

**`REVERSIBILITY-GOVERNS-ESCALATION`** `[DERIVED]` — The valuation protocol: escalate when *the cost of continuing on a false premise exceeds the cost of stopping.* Near a one-way door, escalate readily; where the work is cheap to undo, note and continue. `REVERSIBILITY-IS-A-METER` is already the correct governor — no new rule needed.

**`DIFFICULTY-IS-NOT-WRONGNESS`** — The critical discrimination. *"This is 5× harder than we thought"* is the most common escalation trigger and is usually **not** evidence the premise is wrong. *"We discovered users don't do X"* is. Conflating them means every hard sprint re-opens the strategy.

**`BOTH-ESCALATION-FAILURES-ARE-FATAL`** — They pull opposite ways. **Under-escalation** is sunk cost: the premise is known dead and the work finishes anyway (`UNEXAMINED-OR-UNWILLING` in another guise). **Over-escalation** is thrash: nothing ships because every setback reopens the goal. A naive "always escalate" rule produces the second while trying to cure the first.

**`RECORD-ALWAYS-ACT-BY-COST`** `[owner-locked]` — Resolution. Noting a contradiction is **free and unconditional** (it goes in the ledger); *acting* on it runs the cost comparison. Preserves signal without thrash, and enables **`WEAK-SIGNALS-ACCUMULATE`**: three difficulty-surprises may jointly indicate a wrong premise where none does alone — possible only because all three were recorded.

---

## 9. JOINT REGISTER — moved

> **The register lives in [`docs/judgment/REGISTER.md`](../judgment/REGISTER.md).** It is not duplicated here.
>
> **Why (2026-07-20):** it *was* duplicated here, and within an hour of the judgment store being created the same 17 joints existed in two files with no sync — reproducing precisely the ideabox↔vision-store fragmentation this project spent an epic eliminating. Split is now by **kind, not convenience**:
> - **Stable named reasoning** (the claims in §1–§8) → this document. Canon.
> - **Live operational state** (joints, their status, positions, dated decisions) → `docs/judgment/`. Canon.
> - **Nothing appears in both.**
>
> Applies Decision 3's projection pattern (one canonical store; surfaces are projections; never a second source).

---

## 10. Open agenda (queued, one at a time)

1. ~~**Reversibility as a gate**~~ — **RESOLVED** (§8b): ledger always on, deliberation scales, reversibility tracked as a decaying meter and observed rather than asked.
2. ~~**The stopping rule**~~ — **RESOLVED** (§8c): stop when nothing is left worth learning; commit button surfaced by the condition; override always available and recorded; three triggers distinguished.
3. ~~**Cold start**~~ — **RESOLVED** (§8d): "nothing" means no candidate, not no context; elicit → generate → value → hand off. Surfaced that **valuation blocks the arrive-with-nothing case**, promoting it from hole to blocker.
3b. **VALUATION** — **framing settled, design open.** `WORTH-IS-CONSTRUCTED-WITH-HELP` plus the elicitation mechanics (§8d) give a defensible framing and a measurable posture dial; there is still no design. Critical path for the arrive-with-nothing case.
4. ~~**Cost alongside value of information**~~ — **RESOLVED** (§8e): three dispositions collapse to one cost comparison, which also completes the stopping rule; cost observed from history, bucketed coarsely, opportunity cost included.
5. ~~**Staleness**~~ — **RESOLVED** (§8f): re-derivation not age; the timer schedules the ranking, not the check; tiered instruments (event-driven / sensors / dispatched agents); volatility learned; separate visible maintenance budget.
6. ~~**More than one person**~~ — **RESOLVED** (§8g): name the dispute type; never merge objective functions; explicit authority; recorded dissent; attribution now even though teams are later. Flags the most dangerous feature in the doc.
7. ~~**Who audits the agent**~~ — **RESOLVED** (§8h): agent inferences are positions; calibration is free from outcomes and scoped to inference type; reality is the strongest auditor; **joint recall is the number that matters**.

**Agenda complete.** Six resolved, one punted to a separate product, one parked (extract the design phase from this session). Next: design and build.

**PARKED — extract the shape of the design phase from this session.** This session *is* an instance of the design phase being run, and a usable corpus for distilling its shape. Load-bearing observation not to lose: **we entered at the design layer directly, skipping elicitation and generation, because the context already existed.** Implies the stack has **multiple entry points**, not one start — the system should detect where the owner already is from what context is present, rather than walking everyone from the top. Connects to cold start (§8d): arrive-with-nothing and arrive-mid-stack are different entries to the same machine. To be taken up later.

---

## 11. Killed, with reasons — moved

> **Kills live in [`docs/judgment/LEDGER.md`](../judgment/LEDGER.md).** A kill is a *dated event with a reason and a conviction* — ledger-shaped, not narrative-shaped — so it belongs with the operational state, not here. Same de-duplication as §9.
>
> One exception retained as reasoning rather than event: **`LADDER-CORRECTION`** is a named claim (§ Killed within the claim set) because other claims reference it. Its *event* record is in the ledger.

---

## 12. Provenance

An independent adversarial pass returned 9 of 10 findings graded FATAL. That distribution is not credible; grades were discarded and findings adjudicated individually, with roughly half surviving. Accepted findings became `MIDDLE-NOT-TOP`, `GENERATION-DOMINATES`, `NO-VALUATION`, the `GROUNDING-PER-STEP` amendment, `LEDGER-IS-FALSIFIABILITY`, the `EVIDENCE-BY-SOURCE` amendment, and `LADDER-CORRECTION`. Unresolved findings became `JOINT: external-reachable` and `JOINT: differentiated`.

Everything tagged `[ASSERT]` is owner assertion or agent inference, unvalidated. By this doc's own standard, **the thesis is grounded exactly as well as `already-knew` and `differentiated`** — and neither has been checked.
