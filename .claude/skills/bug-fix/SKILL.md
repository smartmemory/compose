---
name: bug-fix
description: DEPRECATED — use `/compose fix <bug-ref>` instead. The bug-fix lifecycle is now a mode of the Compose skill. This skill remains as a redirect for muscle memory.
---

# Bug Fix Lifecycle (DEPRECATED — see `/compose fix`)

> **Deprecation notice (2026-05-01):** the bug-fix lifecycle has been folded into Compose as `/compose fix <bug-ref>`. Use that instead. The phases and gate protocol below are preserved verbatim because Compose's fix mode delegates here for the per-phase logic — but the canonical entry point is `/compose fix`, not direct invocation of this skill. When invoked directly, redirect the user to `/compose fix`.

## When to Use

- Bug report (from user, tests, monitoring, code review)
- Test failure with unknown cause
- Production issue or hotfix
- Regression after a deploy or merge

**Skip this for:** typos, obvious one-liners where you can see the fix immediately. Just fix those.

**Use `/compose` instead when:** the "bug" is actually a missing feature, or the fix requires architectural changes spanning 3+ files with design decisions.

## Gate Protocol

Same as `/compose`. Every phase transition is a gate. The agent always proposes with rationale — gates are "block until human approves," not "block until human initiates."

- **Gate:** Agent proposes, human decides
- **Flag:** Agent decides, human gets notified with rationale
- **Skip:** Agent decides silently

Default mode: **Gate** for triage and investigation conclusions, **Flag** for fix and verify, **Gate** for ship. Projects can override per the 3-mode dial.

## Paths

Triage determines the path. The agent proposes the path; the human approves.

| Path | When | Phases |
|------|------|--------|
| **Quick** | Clear reproduction, obvious root cause, single file | Triage → Fix → Ship |
| **Standard** | Non-trivial root cause, multi-file, needs investigation | Triage → Investigate → Fix → Verify → Ship |
| **Hotfix** | Production-critical, time-sensitive | Triage → Investigate (time-boxed) → Fix → Verify → Ship (+cleanup) |

## Phases

### Phase 1: Triage

Gather enough information to select a path. Ask (or determine from context):

1. **What broke?** — Observed behavior vs expected behavior
2. **Reproduction** — Steps to reproduce, or failing test
3. **Severity** — Trivial (cosmetic), Normal (broken but workaround exists), Critical (production down, data loss, security)
4. **Scope** — Single file, multi-file, unknown
5. **Root cause hypothesis** — Do you already know what's wrong?

**Path selection:**
- Known root cause + single file → **Quick**
- Unknown root cause OR multi-file → **Standard**
- Severity is Critical → **Hotfix** (regardless of scope)

**Gate:** Agent proposes path with rationale: "This is a [severity] bug in [scope]. Root cause is [known/unknown]. Recommending [path] because [reason]." Human approves path or redirects.

### Phase 2: Investigate

**Skill:** `superpowers:systematic-debugging`

Follow the debugging methodology:
1. **Reproduce** — Get a failing test or reliable reproduction
2. **Hypothesize** — Form a theory about root cause
3. **Verify** — Confirm or eliminate the hypothesis with evidence
4. **Repeat** — If hypothesis was wrong, form the next one

Follow `~/.claude/rules/correct-over-quick.md` — check the contract first, then spec, then code, then test. Don't assume the code is right and the test is wrong.

Follow `~/.claude/rules/test-architecture-first.md` — if a test is failing, understand what behavior it specifies before changing anything.

**For Hotfix path:** Time-box investigation. If root cause isn't found within reasonable effort, fix the symptom (with a clear comment explaining the workaround) and create a follow-up task for proper root cause analysis.

**Gate:** Present root cause findings: "Root cause: [what's wrong]. The fix is [approach]. This touches [files]. Risk: [low/medium/high]." For hotfix: also state whether this is a proper fix or a workaround, and what cleanup is deferred. Human approves fix approach.

**Skip when:** Quick path (root cause already known from triage).

### Phase 3: Fix

**Skill:** `superpowers:test-driven-development`

1. **Write a failing test** that reproduces the bug — this is the spec for "fixed"
2. **Implement the fix**
3. **Verify the test passes**
4. **Run the full test suite** — ensure no regressions

Follow the testing philosophy in `~/.claude/rules/testing.md` — prefer integration tests with real resources over mocks. The bug-reproduction test should test behavior, not implementation details.

**Do NOT:**
- Fix the test to match broken code
- Weaken assertions to make them pass
- Skip writing the reproduction test ("it's obvious")
- Fix unrelated code you noticed while investigating (note it, don't fix it)

**Flag:** After fix is implemented and tests pass, notify: "Fix implemented. [N] tests pass, [M] new. Changes in [files]." Human is notified, agent proceeds to verify.

### Phase 4: Verify

**Skill:** `superpowers:verification-before-completion`

1. Run all tests — not just the new one
2. Verify the original reproduction steps no longer trigger the bug
3. Check for related edge cases the same root cause could affect

**For Standard/Hotfix path:** Also run `superpowers:requesting-code-review` — a second pass catches fixes that introduce new issues.

**Flag:** Present verification results: "All [N] tests pass. Original reproduction confirmed fixed. [Edge cases checked/found]." Human is notified, agent proceeds to ship.

**Skip when:** Quick path (test suite passing is sufficient verification).

### Phase 5: Ship

**Gate:** Present the fix for final approval before committing:
- Summary: what was broken, why, what the fix does
- Files changed (with line counts)
- Tests added/modified
- For Hotfix: list any deferred cleanup as follow-up tasks

Human approves → commit. Human may request changes → loop back to Fix.

1. **Commit** — test + fix in the same commit. Follow project commit conventions.
2. **Update tracker** — if the bug has a tracker item, update its status
3. **For Hotfix:** Document any deferred cleanup as follow-up tasks. A hotfix workaround is tech debt — track it.

## Cross-Cutting Skills

| Skill | When |
|-------|------|
| `superpowers:systematic-debugging` | Phase 2 (investigation) |
| `superpowers:test-driven-development` | Phase 3 (fix) |
| `superpowers:verification-before-completion` | Phase 4 (verify) |
| `superpowers:requesting-code-review` | Phase 4 (standard + hotfix paths) |

## Rules Referenced

| Rule | Applies to |
|------|-----------|
| `~/.claude/rules/correct-over-quick.md` | Phase 2 — decision order when test and code disagree |
| `~/.claude/rules/test-architecture-first.md` | Phase 2 — understand test intent before changing |
| `~/.claude/rules/testing.md` | Phase 3 — integration tests, golden flows, error-path harness |
| `~/.claude/rules/planning-standards.md` | Phase 5 — if the fix needs a follow-up plan |
