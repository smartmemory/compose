# COMP-LOOP-DETECT — Retry-Loop Detection at the Tool-Call Layer: Implementation Plan

**Status:** PLAN (seed — promoted from ideabox, not yet designed)
**Date:** 2026-08-08
**Promoted from:** [IDEA-18](../../../../docs/product/ideabox.md) — `zwolf25/tokenminning` scan 2026-08-08 (`loop-detect.sh`)

---

## Related Documents

- `COMP-ITER-BUDGET` (PLANNED, Backlog) — pipeline-level iteration caps; this is the turn-level floor beneath it
- `.claude/hooks/canon-guard.mjs` (existing) — the precedent for a compose-shipped PreToolUse hook
- `~/.claude/rules/subagent-model-routing.md` — the DeepSWE retry-blowup calibration this targets
- `IDEA-7` (ideabox) — per-step `allowed_tools`; complementary, same hook surface

---

## Problem

The expensive failure mode in delegated work is not a wrong answer, it is a
retry blowup. The routing rules record the calibration: an unbounded run took
**268 steps / 214K tokens** to reach the same outcome a converging run reached in
**95 steps / 86K**. The standing mitigation is a human noticing and escalating.

Nothing in the stack catches this automatically at the right altitude:

| Layer | What it sees | Blind to |
|---|---|---|
| `COMP-ITER-BUDGET` | pipeline iterations on `start_iteration_loop` | an agent burning 60 turns inside a single step |
| per-step `allowed_tools` (IDEA-7) | which tools are reachable in a phase | the *right* tool used in circles |
| **this** | consecutive identical tool calls | anything that varies call-to-call |

---

## Scope

A PreToolUse hook that counts consecutive identical tool calls and, on the 3rd,
returns `permissionDecision: "ask"` with a "possible retry loop, confirm to
continue" reason.

**The load-bearing design choice is warn, not block.** `ask` rather than
exit-code-2 preserves legitimate repetition (polling a background job, watching a
build, re-reading a file being written) while still interrupting a blind retry
loop. That is what makes it safe to ship enabled by default, with no curated
exception list. A hard block would need one, and the exception list is where this
kind of guard goes to die.

### Task 1: Identity predicate

- **File:** `.claude/hooks/loop-detect.mjs` (new)
- **What:** Decide when two tool calls are "the same call". This is the entire
  difficulty of the feature; the hook around it is ~15 lines.
- **Pattern:** `.claude/hooks/canon-guard.mjs` for hook shape, stdin/stdout JSON contract, and failure-mode discipline (a broken hook must not wedge the session).
- **Test:** Table-driven over recorded call sequences — true loops trip, known-legitimate repeats do not.
- **Depends on:** —

**Acceptance criteria**
- [ ] Identity predicate is a named, separately testable function, not inlined in the hook
- [ ] Documented decision among: exact command string / normalized command / same tool + same target file
- [ ] Bash calls differing only in whitespace or ordering of read-only flags are treated as identical (or an explicit decision not to)
- [ ] A deliberate poll loop (same status command, N times) is either exempted or shown to be tolerable at the chosen trip count

### Task 2: Counter and trip behavior

- **File:** `.claude/hooks/loop-detect.mjs` (new)
- **What:** Track consecutive-identical count across calls within a session and emit the `ask` decision at the threshold.
- **Test:** Counter resets correctly on an intervening different call; trips exactly once per streak, not on every call after the 3rd.
- **Depends on:** Task 1

**Acceptance criteria**
- [ ] Emits `permissionDecision: "ask"` with an actionable reason naming the repeated tool
- [ ] Never emits exit-code-2 / hard block
- [ ] Fires once per streak — does not re-prompt on the 4th, 5th, 6th identical call after the user confirms
- [ ] State is per-session and self-cleaning (no unbounded growth, no cross-session bleed)
- [ ] Hook failure (bad state file, parse error) degrades to allowing the call, never to blocking or crashing the session

### Task 3: Install path

- **File:** `lib/setup.js` / `compose update` wiring (existing)
- **What:** Ship the hook the way `canon-guard.mjs` ships.
- **Test:** Fresh `compose setup` installs it; `compose update` repairs it.
- **Depends on:** Task 2

**Acceptance criteria**
- [ ] Installed by `compose setup` and repaired by `compose update`
- [ ] Kill-switch env var, matching the `COMPOSE_DISABLE_RTK` precedent
- [ ] Documented in CHANGELOG.md in the same commit, per the docs rule

---

## Open Questions

- [ ] **Trip count per tool?** 3 is right for Edit and Write. It is wrong for a deliberate sleep-and-poll, and possibly wrong for Read. Uniform threshold first, per-tool override only if the data demands it.
- [ ] **Reset semantics** — hard reset on any intervening different call, or a sliding window (3 identical out of the last 5)? Hard reset is simpler and likely sufficient; the sliding window catches an agent alternating between two failing calls, which is a real pattern.
- [ ] **Does this belong in compose at all, or in the user's global `~/.claude/settings.json`?** Compose shipping it means every project using Compose gets it, which is the point; but the failure mode it guards is not Compose-specific. Ship compose-owned, revisit if it wants to be a standalone pack (IDEA-12).
- [ ] Should a trip also emit a signal that `COMP-ITER-BUDGET` can consume, so the pipeline layer learns a step is thrashing? Cross-layer wiring — defer to design.

---

## Files Summary

| File | Tasks |
|------|-------|
| `.claude/hooks/loop-detect.mjs` (new) | 1, 2 |
| `lib/setup.js` / `compose update` wiring (existing) | 3 |
| `CHANGELOG.md` (existing) | 3 |
