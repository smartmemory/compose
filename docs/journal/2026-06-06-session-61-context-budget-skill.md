---
date: 2026-06-06
session_number: 61
slug: context-budget-skill
summary: COMP-CTXBUDGET-1 shipped — /context-budget token-audit skill; investigated + diagnosed the proof-run full-suite hang (missing --test-timeout)
feature_code: COMP-CTXBUDGET-1
closing_line: We built the tool that measures the cost of our own context — and on the way, found the test that hangs forever because nothing tells it to stop.
---

# Session 61 — COMP-CTXBUDGET-1

**Date:** 2026-06-06
**Feature:** `COMP-CTXBUDGET-1`

## What happened

Ran `/compose build COMP-CTXBUDGET-1 full auto` from a roadmap pick. The plan.md (promoted from IDEA-5, ECC competitive scan) was a combined design+plan, so the one open decision was architecture: pure-prose skill vs. a tested helper. Compose convention settled it — skills reference `lib/` modules, and the acceptance criteria (±20% token estimates, dedup, no double-counting) are only testable as real code. Built `lib/context-budget.js` (pure ESM) behind a thin SKILL.md wrapper, TDD with real temp-FS fixtures. The E2E was running it for real on the Forge surface, which doubled as the required baseline capture (~107.8K loaded, ~55.5K reclaimable). Codex review ran 3 rounds to CLEAN: it caught a token-poisoning input bug (`--tool-counts` accepting ''→0 and NaN/negatives) and a substring-vs-word-boundary misclassification (`compose` matching `decompose`), then a follow-up round caught that the negative-count guard was only at the CLI parser, not the library API — the classic 'wired but not at the boundary' gap, locked with a dedicated test. The full `npm test` then hung for over an hour; we paused to investigate rather than fight it.

## What we built

NEW `lib/context-budget.js` — estimateTokens (dependency-free ~4-chars/token, pluggable), scanSurface (agents/skills/rules/mcp-servers/claude-md chain), dedupeSkills (content-hash, dup zeroed), nameReferenced (word-boundary + hyphen/space variants), classifyComponent (always/sometimes/rarely + reason), buildReport, auditContextBudget, CLI guard. NEW `.claude/skills/context-budget/SKILL.md` — thin wrapper. NEW `test/context-budget.test.js` — 19 node:test tests. NEW `docs/features/COMP-CTXBUDGET-1/{design,blueprint,plan,report,feature.json}`. MODIFIED CHANGELOG.md, CLAUDE.md (periodic-audit habit), ROADMAP.md (new COMP-CTXBUDGET section + row).

## What we learned

1. For audit/measurement features, 'wire it and run it for real' IS the E2E — the live run validates the tool and produces the required artifact in one step. 2. A doc/code inconsistency is a real review finding even when both sides are plausible; resolve toward the higher-value behavior, then make the doc match (here: unreferenced MCP servers are `sometimes`/disable-if-unused, not auto-`always`, surfacing the biggest reclaim instead of hiding it). 3. The full-suite hang was NOT our change: `test/proof-run.test.js` runs a real 25s stratum pipeline and is the slowest test; under full parallel load it can starve, and because compose's `npm test` omits `--test-timeout` (and node's --test has no default), a starved test hangs forever instead of failing. In isolation it passes; bounded with --test-timeout=90000 the whole node suite is green (3516). This is pre-existing infra fragility that also threatens the pre-push hook.

## Open threads

- [ ] File follow-up: add `--test-timeout` to compose's `npm test` script so a starved integration test fails loudly instead of hanging the suite AND the pre-push hook.
- [ ] User to decide on pushing 09e3811 (pre-push hook runs the unbounded suite; proof-run flake could hang it).
- [ ] Optional: act on the captured Forge baseline (~55.5K reclaimable in the agent/skill catalog) via lazy-load — left to the user (non-goal: auto-apply).

---

*We built the tool that measures the cost of our own context — and on the way, found the test that hangs forever because nothing tells it to stop.*
