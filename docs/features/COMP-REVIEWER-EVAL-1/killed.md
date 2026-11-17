# COMP-REVIEWER-EVAL-1 — KILLED 2026-11-17

**Reason: rejected for now by the owner's ruling on OPS-VERIFY-CONFORM-1 ("agree all", 2026-11-17), item C7.**

C7 asked for a reviewer benchmark and grading service: labeled incidents, matched clean changes, replay
snapshots, held-out tuning and test sets, recall before and after confidence filtering. The audit found 0
reviewer-quality incidents in Compose (searches: `reviewer` with `revert/reject/recall/overfit`, `matched.clean`,
`held.out.review`, `reviewer.benchmark`). It is large work plus ongoing human labelling, with no demonstrated
benefit at one owner plus agents.

What stays: raw findings and run evidence in the existing records (`contracts/review-result.json` severity and
confidence). Revive on a measured reviewer miss or filter loss at `lib/review-prompt.js`, or a paying consumer
need for reviewer evaluation, not simply because confidence filtering exists.

Source: `smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md` (row 25, C7), decision record
`smart-memory-ops/units/OPS-VERIFY-CONFORM-1/decisions.md`. Lifecycle: `set_feature_status` PLANNED to KILLED with this reason.
