# COMP-RESUME-CHECKPOINT-1 — Checkpoint recovery for a failed review

**Status:** PLANNED
**Created:** 2026-09-17
**Surfaced by:** COMP-HOST-PORTABILITY-1 gap G2, via COMP-RESUME-FAILED-PHASE-1 part A
**Supersedes:** stratum `STRAT-REOPEN-FAILED-1` (KILLED 2026-09-17 — see that design for why)

---

## Intent

Checkpoint the build flow immediately after implementation merges and before review dispatches,
so a failed review can be recovered with the engine's existing `revert` instead of restarting
from design.

---

## The problem

COMP-HOST-PORTABILITY-1 host B lost a flow at the review step after 18m51s, 208,080 tokens and
**$14.04**. The completed implementation was intact on disk and unreachable by every recovery
route. The run had to restart from design.

COMP-RESUME-FAILED-PHASE-1 shipped the honest refusal (B) and step-history rehydration (C), but
its part A — actually reopening the failed run — is impossible from the Compose side: Stratum's
`resume` returns early for a non-running run.

The obvious answer was a new engine surface to reopen failed runs. **That was designed,
reviewed, and killed.** The review found the engine can already do this, and that reopening is
unsafe in the general case. This feature is what replaces it.

---

## The boundary

`pipelines/build.stratum.yaml:249` — the `execute_merge` gate with `on_approve: review_triage`.

At that point implementation has succeeded, its merge gate has been approved, and the review
lenses have not started. A checkpoint there preserves the expensive work; reverting to it
replays triage plus all lenses.

**Placement is narrow and is the whole feature.** Checkpointing once lens descriptors exist is
TOO LATE: fanout activation sets the step `running` (`stratum/ts/src/engine/engine.ts:1735`)
and `commit` refuses an in-flight fanout (`:3360`). The pre-triage boundary is before that.

`revert` retains cumulative `flowSpent` and the receipt spine
(`stratum/ts/src/engine/engine.ts:964`), so recovery does not un-spend money — correct, and
consistent with how the engine already treats spend.

---

## Why re-running ALL the lenses is correct, not wasteful

The killed design tried to preserve lenses that had already succeeded. The review established
that is unsafe: the engine counts succeeded fanout items toward `require: all`
(`stratum/ts/src/engine/engine.ts:2133`) but does not establish that their outputs describe the
CURRENT workspace, and the revision digest covers the specification, not reviewed file
contents. **A preserved clean lens can therefore produce a falsely successful review.**

Checkpoint recovery re-runs the whole review batch and sidesteps this entirely. The cost is
roughly one extra lens dispatch per recovery versus the killed approach — paid only on failure,
and buying correctness.

---

## Constraints

- **Do not un-spend.** `revert` preserves `flowSpent` and receipts. Keep it that way.
- **Bound recovery by spend, not by count.** A revert count does not bound the cost of a single
  recovery. Carried from the review: the engine supports budget limits only for declared
  dimensions (`stratum/ts/src/engine/ledger.ts:28`), and dollars settle AFTER execution while
  fanout admission reserves a dispatch rather than a worst-case amount (`:2247`) — so **no
  dollar limit is a strict no-overshoot guarantee**. Do not design as though it were.
- **No engine change.** If this turns out to need one, STOP and re-open the question rather
  than quietly reviving the killed design.

---

## Open questions for the design phase

1. Is the checkpoint written unconditionally on every build, or only when the pipeline declares
   the following step risky? Unconditional is simpler; it also grows every run's persisted
   state permanently, since a checkpoint deep-clones `steps` and `events` into the run's own
   JSON (`stratum/ts/src/engine/checkpoint.ts:36`), and that file is read and written on every
   subsequent mutation.
2. What triggers the revert — automatic on a terminal review failure, or an explicit operator
   command? Automatic is friendlier and is also an unattended spend loop.
3. What does `--resume` do once this exists? The honest refusal shipped in
   COMP-RESUME-FAILED-PHASE-1 part B currently promises no recovery path. It should name this
   one once it exists, and that message is part of this feature's scope.
4. Is one checkpoint enough, or does each risky step want its own? See question 1 for the cost.

---

## Explicit non-goal

**A run that has already failed with no suitable checkpoint cannot be salvaged by this.** Host
B's measured flow stays unrecoverable. Checkpoint-less historical salvage is a separate
requirement and nothing here addresses it.
