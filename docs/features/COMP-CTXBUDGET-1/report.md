# COMP-CTXBUDGET-1 — Implementation Report

**Status:** COMPLETE
**Shipped:** 2026-06-06
**Design:** [`design.md`](./design.md) · **Blueprint:** [`blueprint.md`](./blueprint.md) · **Plan:** [`plan.md`](./plan.md)

## Summary

Shipped the `/context-budget` skill: a read-only audit of the session-start loaded surface
(agents, skills, rules, MCP server tool schemas, CLAUDE.md chain) that estimates per-component
token cost, classifies each into **always / sometimes / rarely needed**, and prints a ranked
cut list with estimated reclaim. Logic lives in a tested ESM module; the SKILL.md is a thin
wrapper. Code is compose-owned (`compose/lib/`, `compose/.claude/skills/`).

## Delivered vs Planned

| Acceptance criterion | Status |
|---|---|
| Report covers agents, skills, rules, MCP tool schemas, CLAUDE.md chain | ✅ |
| Each component classified `always` / `sometimes` / `rarely` with a reason | ✅ |
| Report shows estimated reclaim per cut + total potential reclaim | ✅ |
| Duplicate skill copies across surfaces detected, not double-counted | ✅ (content-hash dedup, dup zeroed) |
| Forge baseline measurement captured + recorded | ✅ (below) |

All acceptance criteria met. Non-goals respected: no auto-apply, heuristics surfaced with
reasons, no cross-session tracking.

## Forge Baseline Measurement (2026-06-06)

Run: `node compose/lib/context-budget.js /Users/ruze/reg/my/forge --tool-counts=compose=46,stratum=44,smartmemory-memory=10,playwright=25,filesystem=14,memory=9`

```
CONTEXT BUDGET — current load: ~107.8K tokens

ALWAYS NEEDED (keep, ~52.3K)
  mcp-server:compose   ~23.0K   (referenced in CLAUDE.md)
  mcp-server:stratum   ~22.0K   (referenced in CLAUDE.md)
  skill:compose         ~7.0K   (referenced in CLAUDE.md) [over-400-lines]
  claude-md chain        ~0.3K

SOMETIMES NEEDED (consider lazy-load / disable-if-unused, ~55.5K)
  agents (persona-dispatcher, git-workflow, task-executor, foundation, docs-generator, …)
  skills (competitors, nlm-skill, stratum-build, create-agents, ideabox, …)
  rules (documentation, testing, planning-standards, code-standards)

RARELY NEEDED (cut): none on this surface

TOP 5 RECLAIMS:
  1. agent:persona-dispatcher  ~5.8K
  2. skill:competitors          ~5.2K
  3. skill:nlm-skill            ~5.2K
  4. skill:stratum-build        ~4.9K
  5. agent:git-workflow         ~3.8K

Potential reclaim if all sometimes+rarely cut: ~55.5K tokens
```

**Read of the baseline:** the two biggest line items are the compose + stratum MCP schemas
(~45K combined) — load-bearing here (both referenced in CLAUDE.md), so they stay. The largest
*reclaimable* surface is the agent/skill catalog (~52K across `sometimes`): several `buddy:*`-style
agents (`persona-dispatcher`, `docs-generator`, `tasks-writer`, etc.) and domain skills
(`nlm-skill`, `competitors`) that aren't referenced in the CLAUDE.md chain and are candidates for
on-demand activation. No cross-surface skill duplicates or CLI-wrapping MCP servers turned up on
this particular run. Acting on cuts is deliberately left to the user (non-goal: auto-apply).

## Key Implementation Decisions

- **D1 — logic in `lib/`, not skill prose.** Compose has no precedent for scripts inside
  `.claude/skills/`; skills reference `lib/*.js`. Real code is the only way the accuracy claims
  are testable.
- **D2 — dependency-free token heuristic** `ceil(chars/4)`, pluggable via `estimateTokens`. No
  tiktoken (OpenAI tokenizer + native dep). Calibrated in tests against a words×1.3 reference
  (±25%). Estimates are *relative budgeting*, not billing-accurate — stated in the skill.
- **D3 — injectable roots** (`cwd`, `home`, `mcpConfigPath`) so tests run against a real temp FS.
- **MCP tool counts** aren't on disk; `scanSurface` takes an optional `toolCounts` map. Missing →
  `tool-count-unknown`, excluded from totals (no fabrication). The skill passes the live counts the
  session observes.
- **Classification** = referenced-in-CLAUDE.md (word-boundary, hyphen/space tolerant) → `always`;
  unreferenced active MCP server → `sometimes` (disable-if-unused); overlap/dup/CLI-wrap → `rarely`.

## Test Coverage

`compose/test/context-budget.test.js` — 19 tests, `node:test` + real temp-FS fixtures:
token-estimate calibration/determinism/monotonicity, full-surface scan, MCP estimate + unknown
flagging, CLI-wrapper detection, cross-surface dedup, three classification paths, report
partition/ranking/totals, two golden-flow audits, word-boundary name matching, and input
hardening (empty/NaN/negative tool counts via both CLI parser and library API).

Full compose node suite: **3339 pass / 0 fail** (no regression).

## Review

Codex review loop (3 rounds → REVIEW CLEAN). Findings fixed:
1. `--tool-counts` accepted `''`→0 and `NaN`/negatives → poisoned totals. Hardened in both
   `parseToolCounts` (CLI) and `scanMcpServers` (library API) with `Number.isFinite && >= 0`.
2. Substring `includes()` misclassified (`compose` matched `decompose`; dashed labels missed
   "code standards"). Replaced with word-boundary `nameReferenced()` + hyphen/space variants.
3. SKILL.md doc said "active MCP servers = always"; code (more usefully) treats *unreferenced*
   servers as `sometimes`/disable-if-unused. Aligned the doc to the code.

The review loop caught a real library-API gap (negative counts) that the CLI guard masked — the
classic "wired but not at the boundary" class. Locked with a dedicated test.

## Files Changed

- `compose/lib/context-budget.js` (new) — core module + CLI guard
- `compose/test/context-budget.test.js` (new) — 19 tests
- `compose/.claude/skills/context-budget/SKILL.md` (new) — `/context-budget` wrapper
- `compose/CHANGELOG.md`, `compose/CLAUDE.md` — docs (Phase 9)
- `docs/features/COMP-CTXBUDGET-1/{design,blueprint,report}.md` — feature docs

## Known Issues & Tech Debt

- Token estimate is a heuristic; a real Anthropic tokenizer would tighten accuracy if one becomes
  available locally. The pluggable `estimateTokens` seam is ready for it.
- MCP tool counts are caller-supplied (the session knows them; disk doesn't). A future hook could
  read live MCP schema sizes directly.
- Rule-overlap detection keys on the first heading line only — a coarse signal, intentionally
  conservative to avoid false "cut this" calls.

## Lessons Learned

- For audit/measurement features, "wire it and run it for real" is the E2E: the live Forge run
  both validated the tool and produced the required baseline artifact in one step.
- A doc/code inconsistency (finding #3) is a real review finding even when both sides are
  internally plausible — resolve toward the higher-value behavior, then make the doc match.
