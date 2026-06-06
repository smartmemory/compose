# COMP-CTXBUDGET-1 — Design

**Status:** IN_PROGRESS (design accepted, implementing)
**Plan:** [`plan.md`](./plan.md) (combined design+plan, promoted from `IDEA-5`)
**Track:** Compose / Skills / Infra

## Related Documents

- Upstream: [`plan.md`](./plan.md) — Why, phase breakdown, acceptance criteria, non-goals
- Sibling: [`COMP-COUNCIL-1`](../COMP-COUNCIL-1/) — also lifted from the ECC competitive scan
- Source: ECC `affaan-m/everything-claude-code/skills/context-budget/SKILL.md`

## Goal

Ship a `/context-budget` skill that audits the session-start loaded surface (agents,
skills, rules, MCP server tool schemas, CLAUDE.md chain), estimates per-component token
cost, classifies each into **always / sometimes / rarely needed**, and emits a ranked
cut list with estimated reclaim. Read-only; the user reviews and chooses cuts.

## Resolved Architecture Decisions

The plan said "standalone skill at `compose/.claude/skills/context-budget/SKILL.md`" but
left open *how* the scan/classify/report logic is realized. Resolved against compose
conventions (verified by exploration):

### D1 — Logic lives in a pure ESM `lib/` module, not in skill prose

Compose has **no precedent** for helper scripts colocated in `.claude/skills/`. Every
skill that needs real logic references a `compose/lib/*.js` module (e.g. `compose/SKILL.md`
invokes `validateBoundaryMap` from `lib/boundary-map.js`). The audit's accuracy claims
(±20% token estimate, dedup, no double-counting) are only testable if the logic is real
code, not LLM-interpreted prose.

**Decision:** Core logic in `compose/lib/context-budget.js` (pure functions + a thin FS
walk + a CLI guard). The `SKILL.md` is a thin wrapper that runs it and interprets the
report. Follows the `roadmap-gen.js` shape: scan files → pure transform → rendered text,
no side effects beyond stdout.

### D2 — Dependency-free token heuristic (no tiktoken)

There is no local Anthropic tokenizer, and tiktoken is an OpenAI tokenizer + a native
dependency we will not add (per code standards: no needless deps). Token counts here are
*relative* budgeting estimates, not billing-accurate.

**Decision:** Estimate via a character-based heuristic `ceil(chars / 4)`, the widely-used
~4-chars-per-token approximation, exposed as a pluggable `estimateTokens(text)` so a real
tokenizer can be swapped in later. Calibrate in tests against a hand-counted fixture and
assert the heuristic lands within ±25% of a reference word-count cross-check (the plan's
"±20% vs tiktoken/equivalent" criterion, adapted to a dependency-free reference since no
tiktoken is available). The estimator's *consistency* (monotonic, deterministic) is what
the ranking depends on, and that is exactly testable.

### D3 — FS walk is parameterized for testability

`auditContextBudget({ cwd, home, mcpConfigPath })` takes injectable roots so tests point
at a temp directory with real fixture files (golden-flow discipline: real FS, real files,
assert persisted/produced output — never mock the filesystem).

### D4 — Classification is rule-driven and explainable

Each component carries a `{ bucket, reason }`. Buckets per plan's table:

| Bucket | Rule |
|---|---|
| `always` | referenced by name in the CLAUDE.md chain, OR backs an active command/skill, OR matches current project type |
| `sometimes` | domain-specific, not referenced in CLAUDE.md |
| `rarely` | no command reference, content overlaps a sibling, or no project match |

Heuristics are guides surfaced *with their reason* so the human can override (non-goal:
auto-applying cuts).

## Component Surface

```
compose/lib/context-budget.js        (new) — core: estimate, scan, classify, dedup, report, CLI guard
compose/test/context-budget.test.js  (new) — node:test, temp-FS fixtures
compose/.claude/skills/context-budget/SKILL.md  (new) — /context-budget wrapper
docs/features/COMP-CTXBUDGET-1/report.md        (new, Phase 8) — Forge baseline measurement
```

## Public API (lib/context-budget.js)

- `estimateTokens(text) -> number` — `ceil(chars/4)`
- `scanSurface({ cwd, home, mcpConfigPath }) -> Component[]` — walk all surfaces into a flat inventory
- `dedupeSkills(components) -> Component[]` — collapse identical SKILL.md copies across surfaces by content hash; keep one, mark the dup `duplicateOf`
- `classifyComponent(component, ctx) -> { bucket, reason }`
- `buildReport(components) -> { totalTokens, buckets, topReclaims, text }`
- `auditContextBudget({ cwd, home, mcpConfigPath }) -> Report` — orchestrator
- CLI guard: `node lib/context-budget.js [cwd]` prints `report.text`

`Component = { kind, path, label, lines, tokens, flags[], bucket?, reason?, duplicateOf? }`
where `kind ∈ {agent, skill, rule, mcp-server, claude-md}`.

MCP servers are counted as one component per server at `~500 tokens × toolCount`
(schemas aren't on disk as readable text the way files are); the `.mcp.json` provides
server list, tool counts come from a static per-server estimate where the live count
isn't available, flagged as an estimate.

## Test Plan (golden-flow shaped)

1. **estimateTokens calibration** — known string → within ±25% of word-count×1.3 reference; deterministic; monotonic with length.
2. **scanSurface golden flow** — temp dir with 2 agents, 3 skills (one duplicated into a second surface), 2 rules, a `.mcp.json` with 2 servers, a CLAUDE.md chain → inventory has every component with correct kind/lines/tokens.
3. **dedupeSkills** — identical SKILL.md in `compose/.claude/skills/` and `~/.claude/skills/` counted once; non-identical copies both kept.
4. **classifyComponent** — a skill named in CLAUDE.md → `always`; an unreferenced domain skill → `sometimes`; an overlapping rule → `rarely`.
5. **buildReport** — buckets partition the inventory; `topReclaims` is the 5 highest-token `sometimes`+`rarely` items, descending; total equals sum of de-duped components.
6. **MCP estimate** — server with N tools → `~500*N` tokens, flagged estimate.
7. **CLI guard** — module import has no stdout side effect (guard only fires when run directly).

## Non-Goals (from plan)

Auto-applying cuts; replacing manual review; cross-session token tracking.
