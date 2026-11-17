# COMP-PRUNE-SCHEDULE-1 — KILLED 2026-11-17

**Reason: rejected by the owner's ruling on OPS-VERIFY-CONFORM-1 ("agree all", 2026-11-17), item C10.**

C10 asked Compose to schedule automatic cleanup of every consumer project's tests, instructions and Markdown.
The significance audit found 0 Compose incidents caused by the absence of a product-scheduled prune
(searches: `prun`, `teardown`, `corpus.cut`, `context.floor`, `retire`). The one harmful-cut incident in our
own workspace (a "no longer read" measurement that two scripts still read) argues for proving each consumer
before a cut, not for more automatic deletion. Literal closure would be large: consumer detection, coverage
retention and reversibility across every project.

What stays: the human-chosen cut list in `lib/context-budget.js` and Stratum's lesson retirement suggestions,
invoked when measured cost warrants it.

Revive only if a Compose user shows a measured cost that the human-chosen path cannot handle.

Source: `smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md` (row 23, C10), decision record
`smart-memory-ops/units/OPS-VERIFY-CONFORM-1/decisions.md`. Lifecycle: `set_feature_status` PLANNED to KILLED with this reason.
