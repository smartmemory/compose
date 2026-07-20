# Judgment Layer — Process Manual (manual-mode v0)

**Status:** OPERATIONAL DRAFT — written to be *run by hand*, not built
**Date:** 2026-07-20
**Purpose:** dogfood the judgment layer manually so we learn what to build, and in what order.

## Related Documents

- Source of the claims this operationalizes: [What To Build — The Judgment Layer](../product/2026-07-20-what-to-build-vision.md)
- Context: [The Discovery Loop](../product/2026-07-20-discovery-loop-vision.md), [COMP-FOH](../features/COMP-FOH/design.md)

## Why manual first

`AUTOMATION-MAKES-IT-FREE` says automation decides whether any of this survives. Running it by hand is how we find out **what that means concretely** — the friction points *are* the automation spec. Manual operation also resolves the three highest-VOI constructible joints (`elicitation-works`, `joint-is-non-obvious`, `sensitivity-computable`) at near-zero cost, before anything is built.

**Every process below therefore has a `WATCH FOR` block. Those observations are the deliverable — more than the outputs themselves.**

---

## Storage layout (manual mode)

Deliberately minimal. Three things, all markdown, all in git.

```
docs/judgment/
  OBJECTIVE.md          the objective function — itself a position (THE-GOAL-IS-A-POSITION)
  REGISTER.md           the joint register: all open joints, ranked, one marked UNDER TEST
  LEDGER.md             append-only log: decisions, overrides, escalations, dated
  positions/<slug>.md   one file per position: claim, argument, joints, branches
```

Do not add structure until a process demands it. If a field is never used by hand, it is not needed in the build.

---

## P1 — Intake

**Trigger:** a new question arrives ("should we build X?", "what should we do about Y?", or nothing at all).

**Two entry points** (`NOTHING-MEANS-NO-CANDIDATE`). Detect which; do not force the top.

### P1a — Arrives with a candidate
1. Ask what they want to build and why. Let them talk (`LISTENING-BEATS-ASKING`).
2. Decompose into the claims underneath: the descriptive ones, the causal ones, the value ones.
3. Mark each claim's grounding: `EXT` / `INT` / `ASSERT`.
4. Identify the **joints** — the steps where the argument's weight actually sits (`GROUNDING-PER-STEP`). Data at the bottom, assertion at the joints.
5. Write `positions/<slug>.md`. Add joints to `REGISTER.md`.

### P1b — Arrives with nothing
1. **Elicit** — situation, constraints, assets, dissatisfactions, and what they are optimizing for. Rules: forced trade-offs over stated preferences; concrete past over abstract future; never ask what you can observe; every answer returns something visible.
2. Ask for **stated principles and recent real decisions in the same sitting**, then compare (`CONSISTENCY-READ-IN-ONE-SITTING`). This is the first read on how much to trust their self-report.
3. Write `OBJECTIVE.md` as a position with its own joints.
4. **Generate** candidates: gap-to-goal · unfair advantage · world signal · inverted constraint.
5. **Value** them against `OBJECTIVE.md`. Never hand back an unranked list (`GENERATION-WITHOUT-VALUATION-IS-A-LIST`).
6. Take the top candidate into P1a.

> **WATCH FOR:** Which questions actually moved the answer, and which were filler. Where the conversation felt like an interrogation. Whether the trade-off questions produced real orderings or evasion. Whether generation produced anything the person hadn't already thought of — if not, generation is not earning its place. How long before question fatigue set in.

---

## P2 — Joint identification and ranking

**Trigger:** a position exists or has changed.

1. For each claim: *if this were false, would we do something different?* If no, it is not a joint however uncertain it is (`VALUE-OF-INFORMATION`).
2. For each joint, write both branches: **if true → …** / **if false → …** (`JOINTS-ARE-BRANCH-POINTS`). If the two branches are identical, delete the joint.
3. Tag resolution method: `EXT` (look it up) · `CONSTRUCT` (build the test) · `ASSERT` (owner's call) · `STRADDLE` (build both branches).
4. Estimate cost in coarse buckets — hours / days / weeks / months (`COARSE-BUCKETS-NOT-FALSE-PRECISION`).
5. Rank by value of information against cost. Mark exactly **one** `UNDER TEST` (`ONE-UNDER-TEST`).

> **WATCH FOR:** **Did any joint surface that the owner had not already noticed?** (`JOINT: joint-is-non-obvious` — the single most important observation in manual mode.) How often the "both branches identical" test killed a joint that felt important. Whether ranking was obvious or agonising. Whether cost estimates were later borne out.

---

## P3 — Resolution

**Trigger:** a joint is `UNDER TEST`.

Pick the cheapest disposition that yields an acceptable outcome (`THREE-DISPOSITIONS-ONE-COMPARISON`):

| Disposition | Do this | Manual-mode note |
|---|---|---|
| `EXT` | Go look. Web, competitors, users, data. | Record the source and its reliability, not just the finding. |
| `CONSTRUCT` | Build the smallest thing that makes the answer observable. | **Write the prediction and the outcome criteria in `LEDGER.md` BEFORE building** (`CONSTRUCTION-TRAP`). No prediction, no build. |
| `STRADDLE` | Build all branches. | Requires a discriminating measurement (`STRADDLE-NEEDS-MEASUREMENT`) and pre-committed kill criteria (`KILL-CRITERIA-FIRST`). If either is missing, do not straddle. |
| `ASSERT` | Owner decides. | Mark permanently unproven. External evidence contradicting it later takes precedence. |

On resolution: update the position, re-rank remaining joints, move the `UNDER TEST` marker.

> **WATCH FOR:** How often construction was chosen because it was genuinely cheapest versus because it was the nearest tool (`TAG-BY-RESOLUTION`). Whether the pre-written prediction ever actually contradicted the result, or whether it was retro-fitted. Whether straddling was ever affordable in practice.

---

## P4 — The commit moment

**Trigger:** no remaining joint is worth resolving, OR reversibility is about to cross, OR budget is gone.

1. State which of the three triggers fired: **earned / forced / exhausted** (`THREE-TRIGGERS-NOT-ONE`). Do not blur them.
2. Present commit. It is **not** an endorsement — it means the questions are exhausted, not that the idea is good (`READY-IS-NOT-VALIDATED`).
3. If the owner commits against open high-VOI joints, record the override with the open joints listed. **These are the highest-value entries in the ledger** (`OVERRIDE-IS-THE-BEST-ENTRY`).
4. Crystallize: the committed position becomes a `feature.json` + `design.md` via the existing Compose writer.

> **WATCH FOR:** Whether the stopping condition ever actually fired, or whether commitment always came from impatience or a deadline. How commit felt when presented — permission, or pressure.

---

## P5 — Escalation (the vertical loop)

**Trigger:** anything learned during scoping, design, a spike, or a build that bears on an upstream claim.

1. **Record it always.** Free and unconditional (`RECORD-ALWAYS-ACT-BY-COST`).
2. Classify: is this **difficulty** or **wrongness**? "Harder than we thought" is usually not evidence the premise is wrong (`DIFFICULTY-IS-NOT-WRONGNESS`).
3. Walk the links: how far up does the contradiction propagate? implementation → design → feature premise → product position → objective function.
4. Act only if the cost of continuing on a false premise exceeds the cost of stopping — governed by reversibility.
5. Check accumulation: do several recorded weak signals now jointly cross the threshold (`WEAK-SIGNALS-ACCUMULATE`)?

> **WATCH FOR:** How many escalations were difficulty misread as wrongness. Whether anything ever escalated past the feature premise. Whether recorded-but-not-acted signals were ever revisited, or just buried.

---

## P6 — Maintenance sweep

**Trigger:** periodic (weekly, manual mode). The sweep **ranks**; it does not re-check everything (`THE-TIMER-SCHEDULES-THE-DECISION-NOT-THE-CHECK`).

1. For each claim: volatility × downstream impact × time since last check.
2. Re-check only the top one or two.
3. Where a check repeats in the same shape, **write a checker instead of repeating the check** (`COMPILE-THE-INSTRUMENT-DONT-BE-IT`).
4. Verify existing checkers are still *able* to fire (`BROKEN-SENSORS-READ-AS-CALM`).
5. Shaken claims: downgrade **grounding**, never **conviction** (`SHAKE-GROUNDING-NOT-CONVICTION`).

> **WATCH FOR:** Whether re-checking ever found anything. Which claim types actually rot (this calibrates volatility empirically). Whether the sweep felt worth doing or became a chore skipped after week two — that answer is load-bearing for `JOINT: ledger-used`.

---

## What manual mode is trying to resolve

| Joint | Resolved by | How we'll know |
|---|---|---|
| `joint-is-non-obvious` | P2 | Did it surface a joint the owner hadn't seen? |
| `elicitation-works` | P1b | Did one conversation produce a usable objective function? |
| `sensitivity-computable` | P2 | Were the identified joints the ones that later mattered? |
| `ledger-used` | P6 + general | Is this still being run in six weeks? |
| `construction-discipline` | P3 | Was the prediction ever written before the build? |
| `candidates-generatable` | P1b | Did generation produce anything genuinely new? |

**Primary metric throughout:** `JOINT-RECALL-IS-THE-NUMBER` — when something later went wrong, was the cause on the list beforehand?

## Explicitly not in manual mode

World ingestion, standing sensors, continuous monitoring, multi-stakeholder anything, per-person calibration. Manual mode covers the judgment half only. Generation is exercised in P1b but not automated — and per the reuse map, generation is the part with no existing machinery, so it is deliberately the last thing to build.
