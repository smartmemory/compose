# COMP-CTXBUDGET-1 — `/context-budget` Skill: Token Audit Across Loaded Surface

**Status:** COMPLETE (shipped 2026-06-06 — see [`report.md`](./report.md))
**Priority:** P2 (afternoon-sized; ships independent of any blockers)
**Track:** Compose / Skills / Infra
**Depends On:** None
**Promoted from:** [`IDEA-5`](../../product/ideabox.md)
**Source:** ECC (`affaan-m/everything-claude-code`) `skills/context-budget/SKILL.md` competitive scan 2026-05-11.

## Why

Compose's loaded surface has grown without measurement: ~30+ Compose MCP tool schemas, ~25+ Stratum MCP tool schemas, growing local skill catalog, user-level `~/.claude/skills/`, project + user CLAUDE.md chain. Every session pays for all of it whether the work needs it or not. We've never measured the actual session-start context cost. The ECC `context-budget` skill ships a small audit pattern that's worth lifting: scan every loaded component, count tokens, classify into **always / sometimes / rarely needed** buckets, output a ranked cut list with estimated reclaim per cut.

The bucket model is the only non-obvious idea — it forces a *lazy-load decision per component*, not a one-shot "is this big?" verdict.

## Design

Standalone skill at `compose/.claude/skills/context-budget/SKILL.md`. Invoked via `/context-budget` for a one-shot audit; results returned as a ranked report.

### Phase 1: Inventory

Scan and estimate tokens for:

- **Agents** (`agents/*.md`, `.agents/*.md`): line count → tokens (words × 1.3). Flag files >200 lines, descriptions >30 words.
- **Skills** (`skills/*/SKILL.md`, `~/.claude/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`): tokens per SKILL.md. Flag files >400 lines. Detect duplicate skill copies across surfaces and skip identical duplicates from double-counting.
- **Rules** (`rules/**/*.md`, `~/.claude/rules/**/*.md`): tokens per file. Flag files >100 lines. Detect content overlap between rule files in the same language module.
- **MCP servers** (`.mcp.json`, active MCP config): count servers and total tool count. Estimate schema overhead at ~500 tokens per tool. Flag servers with >20 tools, especially ones that wrap simple CLIs (`gh`, `git`, `npm`).
- **CLAUDE.md** chain (user-global → project): tokens per file. Flag combined >300 lines.

### Phase 2: Classify

| Bucket | Criteria | Action |
|---|---|---|
| **Always needed** | Referenced in CLAUDE.md, backs an active command, or matches current project type | Keep |
| **Sometimes needed** | Domain-specific (e.g. language patterns), not referenced in CLAUDE.md | Consider on-demand activation |
| **Rarely needed** | No command reference, overlapping content, no obvious project match | Remove or lazy-load |

### Phase 3: Report

Output ranked recommendations grouped by bucket, with estimated reclaim per cut and total reclaim if all applied. Example shape:

```
CONTEXT BUDGET — current load: ~X tokens (~Y% of context)

ALWAYS NEEDED (keep, total ~A tokens)
  ...

SOMETIMES NEEDED (consider lazy-load, total ~B tokens)
  - skills/foo/SKILL.md (425 lines, ~2.8K tokens) — domain-specific, not in CLAUDE.md
  ...

RARELY NEEDED (recommend cut, total ~C tokens)
  - rules/legacy-x.md (180 lines, ~1.2K tokens) — overlaps rules/common/y.md
  ...

TOP 5 RECLAIMS:
  1. ... (~1.8K tokens)
  ...
```

### Forge-specific Heuristics

- Count Compose MCP tool schemas (`mcp__compose__*`) and Stratum MCP tool schemas (`mcp__stratum__*`) as a single block per server with the ~500-tokens-per-tool estimate.
- Detect duplicate skill copies between `compose/.claude/skills/` and `~/.claude/skills/` (current real source of churn).
- Detect MCP servers that wrap simple CLIs (the Bash tool can do it).

## Phases

- [x] **Phase 1 — Inventory + classification logic.** Shipped as `compose/lib/context-budget.js` (logic) + `compose/.claude/skills/context-budget/SKILL.md` (wrapper) — deviation from "all in SKILL.md" per compose convention (skills reference `lib/`). Token estimate is a dependency-free chars/4 heuristic, calibrated ±25% vs words×1.3 (no tiktoken — OpenAI tokenizer + native dep).
- [x] **Phase 2 — First real audit.** Ran on the Forge session; baseline ~107.8K tokens captured in `report.md`. Cuts deliberately NOT auto-applied (non-goal); the ranked list is handed to the user to decide, so "re-measure" is the user's follow-up.
- [x] **Phase 3 — Periodic audit habit.** Documented in `compose/CLAUDE.md` (`## Context Budget`).

## Acceptance Criteria

- [x] `/context-budget` produces a report covering agents, skills, rules, MCP server tool schemas, and CLAUDE.md chain.
- [x] Each component is classified into one of `always` / `sometimes` / `rarely` needed.
- [x] Report shows estimated reclaim per cut and total potential reclaim.
- [x] Duplicate skill copies between `compose/.claude/skills/` and `~/.claude/skills/` are detected and not double-counted.
- [x] Forge baseline measurement captured and recorded (in `report.md`).

## Non-Goals

- Auto-applying cuts (the user reviews and chooses).
- Replacing manual review — heuristics are guides, not rules.
- Cross-session token tracking (separate work).

## References

- Ideabox: [`IDEA-5`](../../product/ideabox.md)
- ECC source skill: `affaan-m/everything-claude-code/skills/context-budget/SKILL.md`
- Sibling: [`COMP-COUNCIL-1`](../COMP-COUNCIL-1/) (also lifted from ECC competitive scan)
