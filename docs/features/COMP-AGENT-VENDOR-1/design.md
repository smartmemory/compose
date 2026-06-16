# COMP-AGENT-VENDOR-1 — Ship the vendored compose-explorer / compose-architect agents

**Status:** DESIGN · 2026-06-16

## Problem
The compose SKILL.md depends on `compose-explorer` (Phases 1, 4) and `compose-architect` (Phase 3)
and its "Vendored" table claims they ship "under compose/.claude/agents/". But **no definition file
exists anywhere**, `.claude/agents/` doesn't exist, and `syncSkills()` only installs `SKILL.md`
files — never agent defs. So `subagent_type: compose-explorer` dispatches silently fall back to
built-ins, and the vendored design is a phantom.

## Decision — author the defs + install them (not switch to built-ins)
The roadmap row's primary directive and the Vendored table both intend real vendored agents, so:
1. Author `compose/.claude/agents/compose-explorer.md` and `compose-architect.md` as Claude Code
   subagent definitions (frontmatter `name`/`description`/`tools` + system prompt), capturing the
   roles the SKILL.md describes (explorer = read-only parallel codebase research with file:line
   refs; architect = architecture proposals under a single competing-mandate lens).
2. Extract `lib/install-agent-defs.js` (`installAgentDefs(srcDir, destDir)` — copy `*.md`,
   idempotent) and call it from `syncSkills()` so `compose setup`/`compose init` install the defs
   to `~/.claude/agents/` (sibling of the skills root; Claude tree only — gemini is already
   skipped, codex shares the claude root).

## Why not switch SKILL.md to built-in Explore/Plan
That's the row's documented fallback, but it abandons the vendored-agent design the SKILL.md
advertises and loses the compose-specific mandates. Authoring the defs is the complete fix and is
cheap; the install reuses the existing `syncSkills` agent loop.

## Out of scope
- Per-mandate architect variants beyond the three lenses (minimal / clean / pragmatic) — the lens
  is passed in the dispatch prompt, not encoded per-agent.
- Gemini agent format (different system; `syncSkills` already skips gemini).

## Test
`test/install-agent-defs.test.js`: (a) both real defs exist in `.claude/agents/` with a `name:`
matching the filename; (b) `installAgentDefs` copies `*.md` to a temp dest and is idempotent.
