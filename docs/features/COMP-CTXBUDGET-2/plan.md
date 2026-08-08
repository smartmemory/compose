# COMP-CTXBUDGET-2 — Context Budget as a Tracked Recurring Cost: Implementation Plan

**Status:** PLAN (seed — promoted from ideabox, not yet designed)
**Date:** 2026-08-08
**Promoted from:** [IDEA-17](../../../../docs/product/ideabox.md) — `zwolf25/tokenminning` scan 2026-08-08
**Builds on:** [COMP-CTXBUDGET-1](../COMP-CTXBUDGET-1/report.md) (COMPLETE), [COMP-CTXBUDGET-1-2](../COMP-CTXBUDGET-1-2/) (COMPLETE — live-startup estimate)

---

## Related Documents

- `lib/context-budget.js` (existing) — the read-only audit core this extends
- `.claude/skills/context-budget/SKILL.md` (existing) — thin wrapper
- `compose/CLAUDE.md` §Context Budget — the standing "pair new skills with a `/context-budget` check" rule this automates

---

## Problem

COMP-CTXBUDGET-1 answers *"what is big right now?"*. It cannot answer *"is this
getting worse?"* — every run is a fresh snapshot with no memory of the last one.
The forge baseline (~107.8K live startup / ~55.5K reclaimable, captured
2026-06-06) exists only in a shipped ROADMAP row, not as data the tool can diff
against. In practice that means context debt is noticed when a session *feels*
heavy, which is late and unfalsifiable.

The ranking has a related flaw: reclaims are ranked by on-disk size, but
COMP-CTXBUDGET-1-2 established that Claude Code loads skills and agents at
frontmatter-description size until invoked. So the cut list still over-weights
large-but-lazy components relative to small-but-always-loaded ones.

---

## Scope

Three deltas, all on top of the existing read-only core. **Non-goal, inherited
from -1: never auto-apply a cut.**

### Task 1: Persist a baseline series

- **File:** `lib/context-budget.js` (existing), plus a JSONL store — path TBD in design
- **What:** Append each run's live-startup total and per-component breakdown to a
  append-only series, keyed by project root. Report drift against the previous
  entry and against the first (baseline) entry.
- **Pattern:** Follow the existing pure-core + thin-CLI split in
  `lib/context-budget.js`; the writer must be injectable so tests do not touch
  a real store.
- **Test:** Series append is idempotent per run-id; drift math is correct across
  a synthetic 3-entry series including a component that disappears entirely.
- **Depends on:** —

**Acceptance criteria**
- [ ] Each run appends one JSONL record: timestamp, project root, live-startup total, per-component map, tool-count inputs
- [ ] Skill output shows delta vs previous run and vs baseline (e.g. `+8.2K live tokens since 2026-06-06`)
- [ ] Components that appeared or vanished since the last run are called out by name, not folded into the total
- [ ] Store path is configurable and gitignored by default (decision: is the series per-machine or committed? — see Open Questions)
- [ ] Missing or corrupt series degrades to current snapshot-only behavior with a warning, never an error

### Task 2: Run unattended against a ceiling

- **File:** hook/cron wiring — surface TBD (`bin/git-hooks/`, `.claude/hooks/`, or cron)
- **What:** Run the audit without being asked and surface a result when live
  startup crosses a configurable ceiling.
- **Pattern:** `.claude/hooks/canon-guard.mjs` is the precedent for a
  compose-shipped hook installed by `compose setup` / `compose update`.
- **Test:** Ceiling breach produces the intended signal; under-ceiling run is silent.
- **Depends on:** Task 1

**Acceptance criteria**
- [ ] Configurable ceiling (absolute live-startup tokens, and/or % growth vs baseline)
- [ ] Under the ceiling the run is silent — no output, no prompt
- [ ] Decision recorded in design: does a breach *report* or *block*? (Default should be report; blocking a push over context size is almost certainly wrong)
- [ ] Runs are cheap enough to sit in a pre-push path, or are moved off it (measure before wiring)

### Task 3: Rank reclaims by recurring cost

- **File:** `lib/context-budget.js` (existing)
- **What:** Rank the cut list by `tokens/session x sessions/week` rather than
  bytes-on-disk.
- **Pattern:** Reuse the live-vs-on-disk classification already built in
  COMP-CTXBUDGET-1-2 — this is a ranking change, not new measurement.
- **Test:** Golden case — a 400-line rarely-invoked skill must rank BELOW a
  200-line always-loaded rule file, which is the inversion the current ranking gets wrong.
- **Depends on:** —

**Acceptance criteria**
- [ ] Cut list ordered by recurring token cost, not file size
- [ ] Each row shows the recurring figure that justifies its rank
- [ ] The always-loaded / lazy distinction is visible in the output, not just in the sort

---

## Secondary scope — split into its own feature if it grows

**Adoption auditing: measure whether an optimization actually fires.**

The source case study's one genuinely empirical finding was that a token-saving
tool its author had installed and trusted was reached by only **6% of eligible
calls over 30 days** — the tool worked, its trigger did not
([rtk-ai/rtk#2425](https://github.com/rtk-ai/rtk/issues/2425), verified open
2026-08-08). We do not run RTK; the transferable part is the discipline.

We have no instrumentation telling us whether our own hooks, gates, and guards
fire at the rate we assume. An adoption-rate pass over Claude Code session
history — which hooks fired, which gates were skipped, which shipped skills were
never once invoked — is the same measurement pointed at enforcement rather than
size. Note this overlaps COMP-LOOP-DETECT's data source (session history), so
design them together if both land in the same cycle.

---

## Open Questions

- [ ] Is the baseline series per-machine (gitignored, honest per-developer numbers) or committed (shared trend, but noisy across differing local skill sets)? This is the one real design decision.
- [ ] Where do `sessions/week` come from — measured from session history, or configured? Measured is better and is the same data source as the adoption audit above.
- [ ] Does the ceiling breach report or block? (Strong prior: report.)
- [ ] Does this stay a skill, or become a `compose doctor` section? Doctor already reports environment health and is already run unattended.

---

## Files Summary

| File | Tasks |
|------|-------|
| `lib/context-budget.js` (existing) | 1, 3 |
| baseline series store (new, path TBD) | 1 |
| hook/cron wiring (new, surface TBD) | 2 |
| `.claude/skills/context-budget/SKILL.md` (existing) | 1, 3 |
