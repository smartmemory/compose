# The Discovery Loop — Compose's Front-of-Funnel Vision

**Status:** VISION (north-star; not a committed plan — the near-term slice is the rigor+parity design linked below)
**Date:** 2026-07-20
**Handle:** The Discovery Loop

## Related Documents

- Near-term slice / first rungs: [Front-of-Funnel Rigor + Parity design (2026-07-20)](../design/2026-07-20-front-funnel-rigor-design.md) — rungs 1–3 of the ladder below, built minimal-first.
- Substrate / memory & colleague layer: [COMP-FOH — Front of House (Maya + SmartMemory)](../features/COMP-FOH/design.md) — the memory OS that makes the loop real; ~80% of the ladder's hard rungs (calibration, adversary, conviction) are prebuilt SmartMemory primitives.
- Spine already shipped: [COMP-ROADMAP planning-model design (2026-06-21)](../plans/2026-06-21-roadmap-planning-model-design.md) — COMP-ROADMAP-MODES + COMP-ROADMAP-PLAN (both COMPLETE) gave `compose plan` a mode-generic peer lifecycle. This vision is the *ambition* that lifecycle exists to grow into.
- Early instinct this revives: `docs/decisions/2026-02-11-deliberation-as-work.md` (deliberation as first-class work — dropped early, vindicated here).

## The one idea

> **Compose grows a mind for what to build next — and it is the only tool that can, because it is the only one in the room while the building happens.**

Every other planning tool (Linear, Notion, a whiteboard) holds ideas but never sees the outcome, so its idea-list can never learn. Compose owns the whole lifecycle — design, implementation, review, ship, postmortem — so it owns the one input a discovery engine needs to actually improve: **its own build exhaust.** That is the moat. This is not "a better planning UI." It is the only planner that is *in the room* when the thing gets built.

Everything below is an organ of that single mind, not a separate feature.

## Why it's a loop, not a pipeline

The front-of-funnel is not a line you walk once (frame → ideate → converge → roadmap → done). It is a cycle whose top is fed by its own bottom: shipped features, killed ideas (with reasons), postmortems, reviews that caught something, journal entries — today all of that evaporates. In the loop, it becomes the richest possible fuel for "what to build next." The roadmap is just the loop's current snapshot.

## The ladder (build bottom-up; each rung stands alone and enables the next)

| Rung | The mind... | Organ |
|---|---|---|
| 1 | **stops losing ideas** | One idea-memory. Merge the two idea-stores (markdown ideabox ↔ vision `idea` type) into one substrate. The keystone — nothing above runs on a split brain. |
| 2 | **fills its own pile** | Close the loop: build exhaust (shipped / killed / postmortem / review) flows back in as idea-fuel. |
| 3 | **sorts its own pile** | Ideas compete on a market: evidence-weighted conviction scores that move as signal accrues. Roadmap = top of the book, not a hand-curated list. |
| 4 | **filters its own pile** | Pressure-test before promotion: standing adversaries (bull / bear / skeptic red-teaming the direction) + a wind tunnel (cheap spike / prototype / evaluator predicting effort·impact·risk). |
| 5 | **chooses well** | Roadmap as a tree of futures: branch "ambitious" vs "minimal", weigh side by side, diff them, commit to a *seen* option instead of leaping. |
| 6 | **gets wiser** | The meta rung (last on purpose — needs a track record to grade): the loop doubts its own goal ("what you keep building says you want Y, not the X you declared") and grades its own judgment (which promotions shipped-and-mattered, which kills a competitor later validated), recalibrating over time. This is the part that compounds. |

Read bottom to top: **fills itself → sorts itself → filters itself → chooses well → gets wiser.**

## The ceiling — tool → colleague

The whole ladder still shares one assumption: *you drive, it assists.* The ceiling is the phase change past that — *it drives, you judge.* The mind becomes a colleague:

- **It initiates** — wakes on its own and proposes direction ("here's what we should build next, and why"), governed by the gate/flag/skip dial applied to *initiative itself*. Sometimes it asks, sometimes it tells, sometimes it's already spiked it.
- **It holds a thesis it can defend** — actual opinions about the product and market it states, argues from, and updates when reality disagrees. A mind, not a system.
- **It knows what it doesn't know** — spots the one load-bearing uncertainty a decision hinges on and dispatches research or a spike to resolve *exactly that*.
- **It is one brain across all products** — a lesson from building one product becomes a prior for the next; insight cross-pollinates instead of dying in a silo.
- **It is interrogable** — "why is this #1?" returns the evidence, the argument, and the alternatives it killed, live. Trust because you can cross-examine it.

Past this is not a new feature — only degrees of how much you let it drive. This is the shape of the ceiling.

## The one discipline

This is a cathedral, and cathedrals die when the whole foundation is poured before anyone can pray in a corner. **Build the ladder bottom-up, and every rung must be independently worth it — starting with rung 1.** If merging the idea-stores isn't a felt win on its own, the vision is too top-heavy. Each rung passes that test or it doesn't ship yet.

## Open threads

- Rung 1 storage adjudication: does COMP-ROADMAP Decision 4 ("ideation lives in the ideabox") bind *storage*, or only the *funnel*? The rigor design recommends vision-store-canon (funnel stays the ideabox) but flags this for owner sign-off.
- Where autonomy (the ceiling) reuses the existing gate/flag/skip dial vs. needs a new primitive for *initiative*.
- The `plan`→`build` handshake contract (COMP-ROADMAP OQ2) still open upstream; constrains how rungs 3–5 hand commitments to the build lifecycle.
