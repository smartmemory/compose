---
name: context-budget
description: Use when the user wants to audit, measure, or trim the session-start context load — token cost of agents, skills, rules, MCP tool schemas, and the CLAUDE.md chain. Triggers on "context budget", "token audit", "what's loading my context", "trim my skills/agents", "how big is my context". Produces a ranked, classified cut list; never auto-applies cuts.
---

# Context Budget

Audit the loaded surface a session pays for at startup, estimate its token cost, classify
every component into **always / sometimes / rarely needed**, and produce a ranked cut list
with estimated reclaim. Read-only — you surface recommendations; the user reviews and chooses.

## When to use

- "Run a context budget" / "audit my context" / "what's eating my context window"
- After adding skills, agents, rules, or MCP servers — measure the new cost
- Before trimming `~/.claude/skills/` or a project's `.claude/` surface

## How it works

The scan/classify/report logic lives in a tested module: `compose/lib/context-budget.js`
(pure ESM, covered by `compose/test/context-budget.test.js`). This skill is a thin wrapper —
run the module's CLI, then interpret the report for the user.

### Step 1 — Gather live MCP tool counts

`.mcp.json` lists servers but **not** how many tools each exposes. The session's own
tool-list (the deferred-tools / connected-MCP reminders you can see) is the source of truth.
Count the tools per server you actually have loaded, e.g. `compose=46,stratum=44`. Servers you
don't pass a count for are still listed but flagged `tool-count-unknown` and excluded from the
numeric total (the tool never fabricates a number).

### Step 2 — Run the audit

```bash
node <compose-root>/lib/context-budget.js <project-root> \
  --tool-counts=compose=46,stratum=44,playwright=25,filesystem=14,memory=9
```

- `<project-root>` defaults to `cwd` if omitted.
- The CLI walks: `~/.claude/{agents,skills,rules,CLAUDE.md}` + the project's
  `.claude/{agents,skills,rules}`, the `.mcp.json` servers, and the CLAUDE.md chain
  (home → every `CLAUDE.md` from cwd up to the repo root).
- Token estimate is a dependency-free ~4-chars-per-token heuristic — **relative budgeting,
  not billing-accurate**. Use it to rank, not to bill.

### Step 3 — Interpret the report

The report prints three buckets and a TOP 5 RECLAIMS list. Walk the user through:

- **ALWAYS** — referenced by name in the CLAUDE.md chain, or the CLAUDE.md chain itself. Keep.
- **SOMETIMES** — domain-specific and not referenced in CLAUDE.md. Includes active MCP servers
  the chain doesn't mention: they're load-bearing *while configured*, but if this project doesn't
  use a server, disabling it in `.mcp.json` is often the single biggest reclaim (schemas are tens
  of K tokens). Candidates for on-demand activation / disable-if-unused rather than always-loaded.
- **RARELY** — duplicates across surfaces, overlapping rules, simple-CLI-wrapping MCP servers.
  Recommend cutting.

Flags worth calling out explicitly:
- `duplicate` — same SKILL.md present in both `compose/.claude/skills/` and `~/.claude/skills/`
  (the common real source of churn). Counted once; the copy is the cut.
- `wraps-simple-cli` — an MCP server whose command is `git`/`gh`/`npm`/etc.; the Bash tool can
  do that work without the schema overhead.
- `over-N-lines` — an oversized agent (>200), skill (>400), or rule (>100) worth splitting.

## Heuristics are guides, not rules

Always surface the **reason** alongside each recommendation so the user can override. The buckets
force a lazy-load decision per component; they don't make it for you.

## Non-goals

- **Never auto-apply cuts.** Present the list; the user decides and acts.
- Not a replacement for manual review.
- No cross-session token tracking (separate work).

## Reference

- Logic + contract: `compose/lib/context-budget.js`
- Tests: `compose/test/context-budget.test.js`
- Feature: `docs/features/COMP-CTXBUDGET-1/`
- Source: ECC `affaan-m/everything-claude-code/skills/context-budget/SKILL.md`
