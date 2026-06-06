# COMP-CTXBUDGET-1-2: Progressive-disclosure-aware live estimate — Design

**Status:** COMPLETE
**Date:** 2026-06-07
**Parent:** [COMP-CTXBUDGET-1](../COMP-CTXBUDGET-1/) (surfaced_by)

## Why

Dogfooding COMP-CTXBUDGET-1 on the Forge surface reported ~70.5K "reclaimable", but that counted
full skill/agent file **bodies**. In Claude Code, skills and agents use **progressive disclosure** —
only `name`+`description` load at session start; the body loads on invocation. So the real
live-startup cost of the catalog is ~its descriptions (**~5.0K live**, not 70.5K), and "cutting" it
would destroy ~50 capabilities for almost no live reclaim. The tool measured "what *could* load",
not "what *is* loaded".

## Decision: per-component `liveTokens` + dual reporting

Add `liveTokens` (loaded at startup) alongside `tokens` (on-disk surface):

| Kind | `liveTokens` |
|---|---|
| skill / agent | only the `name`+`description` frontmatter fields (`liveTextFor` → `matchFrontmatterField`); falls back to the whole block only if neither field present, else first non-empty line if no frontmatter |
| rule / claude-md | `== tokens` (inlined into the system prompt at startup) |
| mcp-server | `== tokens`, plus an `mcp-may-defer` flag (tool-deferral harnesses load schemas on demand → live is an upper bound) |

- `buildReport` reports `totalLiveTokens` alongside `totalTokens`, ranks **TOP RECLAIMS by
  `liveTokens`** (the savings you actually get back), and defaults a missing `liveTokens`
  **conservatively to surface** (a budget tool over-reports cost, never hides it).
- `dedupeSkills` zeroes `liveTokens` on duplicates too.
- Report text shows `~X surface / ~Y live` per line and per bucket, with a header explaining
  progressive disclosure.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/context-budget.js` | modify | `extractFrontmatter`, `matchFrontmatterField`, `liveTextFor`, `liveTokens` on every component, dual-number report |
| `test/context-budget.test.js` | modify | +8 tests (frontmatter extraction, live<surface, rule/claude-md/mcp live==surface, extra-keys don't inflate, conservative fallback, reclaim-by-live) |
| `.claude/skills/context-budget/SKILL.md` | modify | "Surface vs live" section; don't-mass-delete-lazy-loaded-skills guidance |

## Result (Forge)

`~122.9K on disk / ~50.4K live`. SOMETIMES bucket: ~70.5K surface but only **~5.0K live**. Dominant
live cost is the MCP schemas (~45K, load-bearing). Confirms there is no large safe cut; the real
micro-levers are trimming verbose descriptions, removing genuinely-unused entries, and disabling
unused MCP servers.

## Verification

27 `node:test` tests pass; Codex review 2 rounds → CLEAN (tightened frontmatter field extraction;
documented + tested the conservative fallback).

## Non-Goals

- Multi-line YAML block-scalar descriptions are counted by their first line only (rare; under-count
  is the safe direction).
- Detecting the actual harness's deferral behavior at runtime (MCP flagged as upper bound instead).
