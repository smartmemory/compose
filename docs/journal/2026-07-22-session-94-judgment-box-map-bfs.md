---
date: 2026-07-22
session_number: 94
slug: judgment-box-map-bfs
summary: "The BFS correction: level-1 box map first, then every box to level 2 research-grounded; integrations become an adapter layer (seq 106-114)"
closing_line: We stopped decorating a room and drew the house — then let the library check the blueprints.
---

# Session 94 — The BFS correction

**Date:** 2026-07-22

## What happened

The session resumed from a flush mid-judgment-layer work and immediately made the mistake this entry exists to record: we dove into fleshing out the situation-facts artifact — asking the owner detailed design questions about correction mechanics — before any floor plan of the whole system existed. The owner halted it in one line: "wtf are we doing? we're building something without having even sketched out the boxes," followed by the method that governed everything after: top-down BFS, DAGs where needed.

So we drew the house first: eight stores (people, situation, goal, positions, register, resolutions, commit, ledger) and five machines (answerer, wanderer, poke, sweep+postmortem, writer), with the feeds DAG. Accepted tentatively, two infra rulings attached — corrections fix facts in place with a visible trace, and every store goes behind the judgment-writer from day one, upgrading the Writer to "the only door."

Then breadth-first across the empty and half-empty boxes, one exchange each. People grew seven sub-boxes and — on the owner's suggestion — an Instruments engine: quizzes as the cheap path from stub to spoken, with cofounder-fit and couples.team as in-house question banks. Situation got its inside-out boundary. At the Goal box the owner asked what we'd do with someone who changes goals frequently "just because," and asked for a literature pass before baking the answer — which mid-stream became a standing correction: research at every step, not just this one. The research pass per box became method (seq 110), and it paid immediately: goal-hierarchy and action-crisis research grounded the invariant projection and oscillation-to-joint mechanics; ACH gave Resolutions diagnosticity; nonresponse research gave the Poke half per-question silence verdicts and chase-the-silent. The Writer and Poke boxes closed level 2, and a final owner question — "have we thought about external integrations?" — produced the adapter layer: integrations are not a new box but five adapter classes on doors the DAG already has.

## What we built

- `docs/design/2026-07-20-judgment-layer-process-manual.md` — storage section expanded from a paragraph of person-file rules into the canon: level-1 box map, six level-2 box subsections (People, Situation, Goal, Resolutions, Writer, Poke), the Integrations adapter layer, and a P3 amendment pointer (sharpen-first everywhere, diagnosticity, VOI cap).
- `docs/judgment/LEDGER.md` + `records/ledger.jsonl` — seq 106–114, all through the tool-owned write path: bfs-top-down-design, people-box-level-2, situation-box-level-2, goal-box-level-2, research-pass-per-box, resolutions-box-level-2, writer-box-level-2, poke-box-level-2, integrations-adapter-layer.
- Seven commits on main (28c36b9 → d5b6e81), each box write run through a Stratum flow (v1 IR spec, 3/3 steps clean each).

## What we learned

1. **Depth-first design of one artifact while its siblings are blank reads as progress and is not.** The BFS correction was the session's spine: sketch every box at level N before any box gets level N+1. The correction cost one exchange; not getting it would have cost a situation-facts artifact designed against boxes that didn't exist yet.
2. **A literature pass per box is cheap and pays in mechanics we would not have invented.** Diagnosticity (evidence consistent with both branches weighs zero), chase-the-silent, the VOI spend cap, and oscillation-to-joint all came from the research passes — none were in the pre-research sketches. The owner's generalization ("research at every step") is P0.2 applied to building the product itself.
3. **Propagation gaps recur even under a rule that names them.** The why-ladder was declared "joins the instrument banks" in the Goal box but not written into the banks' definition in the People box — caught only because the owner asked "did you incorporate your findings?" Same failure shape the ledger already records twice.
4. **Rules become real when they become rejected writes.** The Writer level-2 is the session's quiet keystone: stub-may-not-carry-load, prediction-before-evidence, and owner-ratified goal versions stop being discipline and become invariants the write path enforces.
5. **The stratum MCP takes the v1 IR schema, not the pipelines YAML format** — version: 1, contracts as type-string maps, flows.entry, steps with do/out/ensure. Cost one failed plan call to learn; recorded so it costs nothing again.

## Open threads

- [ ] Build the Writer extensions (person/situation/goal/package record kinds + invariant enforcement) — the one box whose level 3 is code
- [ ] Resume the paused live advisory (five-products question) with the completed machinery — owner's call, never unprompted
- [ ] Research debt: People (elicitation/psychometrics) and Situation (evidence-grading practice) were baked before the research rule existed
- [ ] Dossier consent/privacy joint (what may be written about non-consenting cast members) — parked, product question
- [ ] Mainstream-simplicity: instrument design calibrated on one atypical owner — empirical, watch don't design
- [ ] Poke half: thin traffic on owned properties means rungs 1–2 are audience-building before rungs 3–5 can fire

---

*We stopped decorating a room and drew the house — then let the library check the blueprints.*
