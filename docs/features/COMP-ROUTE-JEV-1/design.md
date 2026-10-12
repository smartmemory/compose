# COMP-ROUTE-JEV-1 — Jev as a shadow tier recommender for model routing (spike stub)

**Status:** PLANNED, filed 2026-10-12 at owner request ("file, not run"). **Not runnable yet:** see "Ready when".
**Parent:** COMP-MODEL-ROUTE (dynamic model routing, `learned` source still unbuilt). **Origin:** owner question
2026-10-12, "can't we use jev for the model routing?", after COMP-GATE-JEV-1 shipped.

## Related Documents

- Routing design: `docs/features/COMP-MODEL-ROUTE/design.md` (existing). Ladder off → shadow → active (:368-369),
  learned choices need durable cross-run evidence (:55, :114), cold start needs trials (:343-347).
- Routing ledger: `lib/routing-ledger.js` `readRoutingLedger()` (:1301), file `<project>/.compose/routing/ledger.jsonl`.
- Jev method and client: `docs/features/COMP-GATE-JEV-1/design.md` (existing), `lib/gate-jev.js` (existing).

## Idea

In shadow mode the router already records the static winner and a `would:` recommendation per dispatch. Add Jev as a
second shadow recommender: given the dispatch key (preset, step, provider, planner tier, item size signals), Jev picks a
tier. It never changes the tier. Its pick is scored afterwards against the ledger's downstream acceptance outcomes, the
same evidence the `learned` source is meant to use.

Why shadow only: the owner's routing decisions are "self-learning from cross-run evidence, not a one-shot guess"
(COMP-MODEL-ROUTE). Jev deciding live would be the one-shot guess. As a scored shadow it is evidence, and it can only be
promoted through the same ladder as any learned source.

Unverified: whether Jev can learn from outcome feedback, or only answers each question fresh. Check with the Jev docs
before writing the spike. If it cannot learn, the spike measures a fixed prior, which caps its value.

## Ready when (falsifier for "not runnable")

The ledger must hold enough outcome-labelled rows to score anything. As of 2026-10-12: **24 rows, one workspace**
(`compose/.compose/routing/ledger.jsonl`, `wc -l`). Runnable when a ledger count shows **>= 80 rows with a downstream
acceptance outcome, across >= 2 workspaces and >= 10 baseline shadow builds** (the routing design's own promotion floor,
:376). Check: `wc -l <project>/.compose/routing/ledger.jsonl` per project.

## Spike shape (to pre-register when ready, not before)

- Frozen corpus of ledger rows, hash recorded. Jev question and payload frozen before the run.
- Arms: the static preset choice, Jev's pick. Score: the share of dispatches where the arm's tier was accepted downstream at
  the lowest cost, using the ledger's recorded outcomes only.
- A pre-registered bar written before the run, KILL on a miss, as in COMP-GATE-JEV-1.

## Acceptance criteria

- [ ] Ready-when condition met and recorded with the counts
- [ ] Jev feedback capability checked and recorded
- [ ] Spike pre-registered, run, PASS or KILL recorded here
