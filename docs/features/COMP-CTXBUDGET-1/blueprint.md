# COMP-CTXBUDGET-1 — Implementation Blueprint

**Status:** IN_PROGRESS
**Design:** [`design.md`](./design.md)

## Files

| File | New/Existing | Purpose |
|---|---|---|
| `compose/lib/context-budget.js` | new | Core: `estimateTokens`, `scanSurface`, `dedupeSkills`, `classifyComponent`, `buildReport`, `auditContextBudget` + CLI guard |
| `compose/test/context-budget.test.js` | new | `node:test` + `node:assert/strict`, temp-FS fixtures |
| `compose/.claude/skills/context-budget/SKILL.md` | new | `/context-budget` wrapper that runs the lib CLI and interprets output |
| `docs/features/COMP-CTXBUDGET-1/report.md` | new (Phase 8) | Forge baseline measurement |

## Conventions to mirror (verified)

- **ESM**: `package.json` `"type": "module"` → use `import`/`export`. (verified `compose/package.json`)
- **Test runner**: `node --test test/*.test.js`; import `{ test } from 'node:test'`, `assert from 'node:assert/strict'`. New file auto-collected by the `test/*.test.js` glob. (verified `package.json` test script)
- **Scan shape**: mirror `lib/feature-json.js` `listFeatures` — guard `existsSync`, `readdirSync(dir,{withFileTypes:true})`, skip non-dirs, try/catch malformed, return array. (verified `lib/feature-json.js:1-40`)
- **Pure transform + rendered text** like `roadmap-gen.js`: scan → build structured report object → render `text`; no writes (CLI prints to stdout only).
- **Temp-FS fixtures** like `test/boundary-map.test.js`: `mkdtempSync(join(tmpdir(),'cb-'))`, write real fixture files, assert on real output.

## `.mcp.json` reality (verified)

`{ mcpServers: { <name>: { command, args?, description? } } }`. **Tool counts are NOT on disk.**
Resolution: `scanSurface` accepts an optional `toolCounts` map (`{ serverName: N }`). When a
server has a count → token estimate `500 * N`, kind `mcp-server`. When absent → component emitted
with `tokens: 0`, flag `tool-count-unknown`, excluded from numeric total (no fabrication). The CLI
accepts `--tool-counts name=N,name2=M`; the SKILL.md instructs passing the live counts the session
observes. "Wraps a simple CLI" flag = command basename ∈ {git, gh, npm, npx} with a CLI-ish first arg.

## CLAUDE.md chain (verified, 4 files present)

`~/.claude/CLAUDE.md`, `/Users/ruze/reg/CLAUDE.md` (workspace), `<cwd>/CLAUDE.md`, `<cwd>/compose-or-self/CLAUDE.md`.
`auditContextBudget` resolves the chain from `home` + walking `cwd` upward to a repo-ish root; for v1,
take `home/.claude/CLAUDE.md` + `cwd/CLAUDE.md` + any parent `CLAUDE.md` between cwd and a `.git`/root.
Tests inject `cwd`/`home` so this is deterministic.

## Verification Table

| Blueprint claim | Check | Result |
|---|---|---|
| `package.json type:module` | read | ✅ confirmed |
| test glob `test/*.test.js` picks up new file | read test script | ✅ confirmed |
| `lib/feature-json.js` scan pattern exists | read `:1-40` | ✅ confirmed |
| `.mcp.json` = `mcpServers` map, no tool counts | cat | ✅ confirmed (6 servers, no counts) |
| No existing token-count logic to reuse | explore sweep | ✅ confirmed greenfield |
| CLAUDE.md chain files exist | `ls` | ✅ 4 files present |
| `boundary-map.test.js` temp-FS harness | explore | ✅ confirmed pattern |

Zero stale references. No Boundary Map (single work unit). Proceed to TDD.
