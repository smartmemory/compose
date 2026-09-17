# COMP-BUILD-SPLIT-1: Split lib/build.js into cohesive modules

**Status:** PLANNED
**Created:** 2026-09-17
**Surfaced by:** COMP-HOST-PORTABILITY-1 remediation (measured contention, 2026-09-17)

---

## Intent

`lib/build.js` is 7,845 lines. Split it into cohesive modules so that the build orchestrator
fits in an agent context window, and so that independent pieces of work can edit disjoint
files instead of serialising on one.

---

## Why now — the measured cost

This is not a tidiness request. It was surfaced by a concrete scheduling loss.

The COMP-HOST-PORTABILITY-1 remediation produced three independent implementation briefs —
COMP-GATE-HEADLESS-1 + COMP-LIFECYCLE-BRIDGE-1 (merged), COMP-REVIEW-BUDGET-1, and
COMP-RESUME-FAILED-PHASE-1. All three edit **disjoint regions of the same file**:

| Brief | Region of `lib/build.js` | Concern |
|---|---|---|
| COMP-GATE-HEADLESS-1 / COMP-LIFECYCLE-BRIDGE-1 | ~3814, ~5900-6400, ~7400-7500 | gate delegation, tracker writes, active-build record |
| COMP-REVIEW-BUDGET-1 | ~1700-1964 | review lens dispatch, consumer failure envelope, usage accounting |
| COMP-RESUME-FAILED-PHASE-1 | ~2900-3300, ~4100-4300 | resume decision, terminal-flow audit |

They could not be dispatched concurrently: two agents editing one file in one working tree
overwrite each other. The work was serialised, turning what should have been one wave into
three. A prior session (2026-09-16) hit the same wall on `bin/compose.js` and paid for it
differently — by splitting a combined diff into per-feature commits by hand, with a throwaway
script.

So the cost is already being paid twice over, in two different currencies: lost parallelism,
and manual diff surgery at commit time.

Neighbouring candidates, for scope discussion only (NOT in this feature's scope):
`bin/compose.js` (4,393), `lib/judgment-writer.js` (3,457), `lib/consumer-fanout.js` (2,113).

---

## Constraints

- **Behaviour-preserving.** This is a move, not a redesign. No behavioural change should be
  observable. If a genuine defect is found while splitting, file it separately rather than
  fixing it in the same change — a behavioural fix hidden inside a 7,800-line move is
  unreviewable.
- **The test suite is the gate.** The full suite must be green before and after, with the same
  set of pre-existing failures and no new ones.
- **Sequenced after the in-flight remediation.** The three briefs above are landing in this
  file now. Splitting underneath them would guarantee conflicts. This work starts only once
  they are committed.

---

## Open questions for the design phase

1. **What are the real seams?** The region map above is evidence of how the file is *used*,
   not necessarily how it should be *cut*. The design phase should derive boundaries from
   actual coupling, not from where this session happened to edit.
2. **How much shared mutable state crosses those seams?** `stepHistory`, the active-build
   record and the usage/cost accumulators are known to be touched from several regions. These
   determine whether a clean split is possible or whether state has to be threaded explicitly.
3. **Is `runBuild` itself splittable**, or does it stay as a thin orchestrator over extracted
   modules? The latter is the likelier shape and the safer one.
4. **What is the verification strategy for a pure move?** Suite-green is necessary but weak. A
   stronger check may be available — worth deciding explicitly rather than defaulting to "tests
   pass".

---

## Notes

Seeded by `compose feature`, then written up from the measured contention that surfaced it.
The `compose build` pipeline will expand this into a full design, blueprint and plan.
