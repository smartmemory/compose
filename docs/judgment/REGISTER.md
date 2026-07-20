# JOINT REGISTER

> **CANON for joint state.** The vision doc (`docs/product/2026-07-20-what-to-build-vision.md` §9) points here and does not duplicate. Split is by kind: stable named reasoning lives there, live operational state lives here.
>
> **DISPOSABLE SCAFFOLDING.** This markdown store is a manual-mode learning substrate, **not** a fourth canon alongside `ideabox.md`, the vision store, and `feature.json`. Migration target: the vision store's existing types — joint → `question`, decision/kill → `decision`, deliberation → `thread`, position → `idea` *or a new type (undecided — see below)*. Do not build tooling against these files; tooling is what turned the ideabox from a surface into a second source.
>
> **OPEN MODELLING QUESTION — do not answer by drift:** is a *position* a new vision-store type, or an `idea` with joints attached? This is the same question WS-A asks about ideas, and answering it by accretion is how the current fragmentation happened.

**Last ranked:** 2026-07-20 · **Under test:** `differentiated` (exactly one, per `ONE-UNDER-TEST`)

Backfilled from the 2026-07-20 design session. Ranking is by value of information
against cost — **and per Codex finding 1, VOI is not yet a computed quantity, so
the ordering below is judgment, not calculation.** Recorded as such rather than
dressed up.

## Under test

| Joint | Question | If TRUE | If FALSE | Resolve by | Cost |
|---|---|---|---|---|---|
| **differentiated** | Distinct from Productboard / Aha! / Dovetail? | Proceed | Reposition or kill | `EXT` | hours |

*Chosen because it is the only joint resolvable by external evidence at hours-scale,
and the only external evidence anyone has produced. Everything else is asserted.*

## Open — high

| Joint | Question | If TRUE | If FALSE | Resolve by | Cost |
|---|---|---|---|---|---|
| **already-knew** | Do bad build decisions come from unexamined reasoning, or do people know and build anyway? | Judgment layer is the product | Value is recovery, not foresight | `INT` — own decision history | days |
| **joint-is-non-obvious** | Can it surface a joint the owner hadn't noticed? | Day one is valuable with an empty ledger | It reformats what you already said | `CONSTRUCT` — manual mode | days |
| **valuation-exists** | How is worth established at all? | Advisor product works | Arrive-with-nothing cannot ship | `CONSTRUCT` | weeks |
| **elicitation-works** | Can context + objective be elicited in one conversation? | Day-one works, no accumulation needed | Only serves users who already have a candidate | `CONSTRUCT` | days |
| **external-reachable** | Can external signal be acquired at useful quality? | Generation is real; straddling works | Asserted-only; flattery risk returns | `CONSTRUCT` | weeks |
| **sensitivity-computable** | Can "which claim flips the conclusion" be computed reliably? | Branching engine works | Multiplies garbage | `CONSTRUCT` | weeks |
| **candidates-generatable** | Can candidates be generated, or must the owner supply them? | Generation layer is real | Evaluation-only system | `CONSTRUCT` | weeks |
| **straddle-reaches-trunk** | Can strategy-level branches be built in parallel cheaply? | Straddling reaches decisions that matter | Leaf-level tool only | `CONSTRUCT` | weeks |
| **commercial-intent** | Product to sell, or instrument for own building? | — | — | `ASSERT` — owner | minutes |

## Open — medium

| Joint | Question | Resolve by |
|---|---|---|
| **construction-discipline** | Does construction resolve joints, or degrade into "build it and see"? | `CONSTRUCT` |
| **conviction-inferred** | Does auto-capture infer conviction accurately? | `CONSTRUCT` — **live test: see LEDGER** |
| **entry-threshold** | What earns a ledger entry? | `CONSTRUCT` |
| **calibration-timely** | Is calibration signal obtainable in useful time? | `INT` |
| **ingest-continuous** | Continuous or invoked ingestion? | `ASSERT` |
| **ledger-used** | Does an auto-captured ledger get used? | `CONSTRUCT` — **NOT testable in manual mode** (Codex finding 9) |
| **horizon / success-criteria** | See `OBJECTIVE.md` | `ASSERT` |

## Notes

- `ledger-used` is explicitly **not** resolvable by manual dogfooding: the claim is
  about auto-capture. Marked so it cannot be falsely closed.
- Nine joints resolve by `CONSTRUCT`. Manual mode exercises four of them.
- No joint has yet been resolved. This register has one day of history.
