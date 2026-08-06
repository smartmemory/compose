# COMP-ITER-BUDGET — Plan Seed

**Status:** PLANNED (Backlog) · seed, not a committed plan — full design pending the normal gate.
**Related:** promoted from `idea_budget_ceilings` (2026-07-16); scope extended 2026-08-06 with
gate memoization from IDEA-1200 (prime-agent teardown, smart-memory-docs ideabox).

## Scope

Two complementary controls on `start_iteration_loop`:

1. **Budget ceilings** (original scope): configurable max iterations / wall-clock /
   action-count caps with auto-abort and a structured failure report.
2. **Gate memoization** (IDEA-1200): before re-running a quality gate inside the loop,
   hash the workspace state the gate reads; if unchanged since the last run, reuse the
   recorded verdict instead of re-executing. Source: prime-agent autonomous mode, which
   "avoids rerunning gates when workspace state hasn't changed." A failed-gate retry that
   changed nothing burns budget on a verdict already known — memoization makes the budget
   ceiling bind on *productive* attempts only.

## Acceptance criteria (seed)

Budget ceilings:
- [ ] `start_iteration_loop` accepts `maxIterations`, `maxWallClockMs`, `maxActions` (all optional)
- [ ] Ceiling breach auto-aborts the loop and emits a structured failure report (which ceiling, spent vs cap, last gate verdict)
- [ ] Report is persisted where `report_iteration_result` consumers can read it

Gate memoization:
- [ ] Gate runs record `(workspace hash, gate command, verdict, bounded output)`
- [ ] Unchanged workspace hash + same gate command → recorded verdict reused, gate not re-executed
- [ ] Reused verdicts are marked as memoized in the loop trace (never silently indistinguishable from a fresh run)
- [ ] Hash covers exactly the inputs the gate reads (default: working-tree content hash; document what is excluded)

Cross-cutting:
- [ ] Memoized skips do not count against iteration/action ceilings
- [ ] Honest-gate semantics documented: gate passage only validates what that gate checks

## Files

- `server/` iteration-loop module (existing) — ceilings + memo store
- `docs/features/COMP-ITER-BUDGET/design.md` (new, at design gate)

## Cross-refs

- Pairs with `idea_tiered_gate_evaluation` (cheap checks before expensive ones — memoization
  is the degenerate best case: zero-cost when nothing changed)
- Stratum analogue: step postcondition (`ensure`) re-checks could memoize the same way
- Validation source: Claude Code Workflow token-budget runtime (2026-07) + prime-agent
  autonomous-mode gates (2026-08)
