# review_triage 1M-context failure — ROOT CAUSE (2026-09-16)

Supersedes the open questions in `hypothesis-controls-2026-09-15.md` (corrections to that file
are appended there). Related: `../design.md`, parent `../../COMP-MODEL-ROUTE/`.

## Mechanism

`stratum/ts/src/connectors/claude.ts:114` maps the connector's `allowedTools` onto the Claude
Agent SDK `tools` option, an explicit tool-SET restriction. compose's `orchestrator` template
(`server/agent-templates.js:27`) sets `allowedTools: [Read, Grep, Glob, Agent, Bash]`, so every
step using it (including `review_triage`) sends an explicit list. That list omits `ToolSearch`,
and without ToolSearch Claude Code cannot defer MCP tool schemas. MCP servers connect
asynchronously, so:

- turn 1 goes out before the servers are up: small (26–31K tokens);
- turn 2 (the continuation after the first tool result) inlines EVERY configured MCP tool
  schema: **511,214 cache-creation tokens for a one-line `echo`**.

On `claude-sonnet-4-6` (200K standard window) Claude Code escalates to the 1M tier and the API
refuses: `Usage credits required for 1M context`. That is flow `05f660fe`. On `claude-sonnet-5`
the request succeeds and bills **$3.26 per trivial turn**, so the same defect is a cost bug for
every tiered dispatch since the Sonnet 5 sweep.

## Reproduction and controls (all 2026-09-16, cwd = compose, prompt = "run `echo`, then reply PROBE_OK")

| Path | Model | tools | MCP | Result | last-turn ctx |
|---|---|---|---|---|---|
| `stratum_agent_run agent=claude` foreground, allowedTools=[Read,Grep,Glob,Agent,Bash], disallowed=[Edit,Write] | sonnet-4-6 | explicit | default | **1M error** on turn 2 (transcript `404205b3`) | turn 1: 26,342 |
| same | sonnet-5 | explicit | default | PROBE_OK, **$3.26** (transcript `e6772e44`) | turn 2: **511,214** |
| `claude -p --allowedTools Bash` (CLI 2.1.273) | sonnet-4-6 | preset | default | PROBE_OK, $0.31 | 49,035 + 44,128 read |
| `claude -p --tools Read,Grep,Glob,Agent,Bash` | sonnet-4-6 | explicit | default | **1M error** | turn 1: 92,825 |
| `claude -p --tools Read,Grep,Glob,Agent,Bash,ToolSearch` | sonnet-4-6 | explicit+ToolSearch | default | PROBE_OK, $0.26 | 41,110 + 36,335 read |
| `claude -p --tools Read,Grep,Glob,Agent,Bash --strict-mcp-config --mcp-config '{"mcpServers":{}}'` | sonnet-4-6 | explicit | none | PROBE_OK, $0.21 | 33,160 + 33,020 read |

Two independent knobs each flip the outcome: add ToolSearch → passes; remove MCP servers →
passes. The transcript of the failing runs contains nothing large (tool result 23 bytes,
attachments < 5KB each), so the growth is entirely in the tool-definition block the transcript
does not log. The SDK-bundled CLI is 2.1.206 (`claude-agent-sdk 0.3.206`); the installed CLI
2.1.273 reproduces identically, so this is not a version artifact.

MCP servers an SDK subprocess loads here: user-scope `base44`, `smartmemory-hosted`; project
`.mcp.json` `compose, filesystem, memory, playwright, smartmemory-memory, stratum`
(`enableAllProjectMcpServers: true`), plus the claude.ai connectors bound to the account.

## What the 2026-09-15 evidence got wrong

1. "Failing request = 3 input + 64,118 cache-creation, first turn": that was the SUCCESSFUL first
   turn. The failure was the continuation after one Bash tool result, which has no usage record
   (`~/.claude/projects/-Users-ruze-reg-my-forge-compose/b49042a9-….jsonl` lines 10–14).
2. "dispatch shape: tools preset claude_code, settingSources ['project']": the dispatch used the
   explicit orchestrator list, and stratum omits settingSources (SDK 0.3.x then loads all sources).
3. The two "matched-size" background probes did not control the variable that mattered: they used
   no allowedTools, so they got the preset (with ToolSearch) and deferral stayed on.

Hypotheses 1–4 in that file remain refuted; the eliminations were correct, the description of the
failing request was not.

## Fix

stratum `ClaudeConnector`: when `allowedTools` is given, include `ToolSearch` in the SDK `tools`
list (unless the caller disallowed it). Preserves the caller's restriction, restores deferral.
**Landed** as stratum `f250d9e6746276cfc79ef311fe56d1f2008ea503` (`origin/main`, 2026-09-17):
append `ToolSearch` once to an explicit `allowedTools`, never duplicate it, and let an explicit
`disallowedTools: ["ToolSearch"]` still win and strip it. The preset branch is untouched.
Background dispatch needed no separate fix (`claude-bg-worker` instantiates `ClaudeConnector`).
4 RED->GREEN tests at the SDK boundary; 39/39 green unsandboxed across the three touched files.

### Live-fire verification (2026-09-17, against the rebuilt `dist`)

Same process, same prompt, same `dist`, `claude-sonnet-4-6`, compose's real orchestrator list
`[Read,Grep,Glob,Agent,Bash]`. The control disallows `ToolSearch`, which makes the fixed connector
strip it and reproduce pre-fix behavior exactly:

| Arm | cache-creation tokens | cost | result |
|---|---|---|---|
| CONTROL — `ToolSearch` disallowed (= pre-fix) | 156,992 | $0.943 | PROBE_OK |
| TREATMENT — fix appends `ToolSearch` | 53,620 | $0.323 | PROBE_OK |

A 66% reduction on an `echo`. This harness is a bare node process, so it loads a smaller MCP roster
than a full Claude Code session (157K here vs 511K there) and therefore stays under the 200K window
in BOTH arms — it confirms the token mechanism and the cost, not the 1M-tier refusal itself. The
refusal is the downstream consequence of the same growth at the larger roster, already evidenced in
the six-row control table above.

Codex review (sol/high) returned REVIEW CLEAN: precedence correct for all six allow/deny
combinations; `ToolSearch` discovers schemas but cannot invoke a tool the caller explicitly denied,
so the security boundary does not widen; the one other SDK-options builder
(`stratum/app/server/agent-server.js:153`) uses the Claude Code preset and needs nothing.

Follow-ups worth a separate decision (not done here): whether stratum should pass
`settingSources`/`--strict-mcp-config` so a compose step does not inherit the account's entire
MCP roster at all; and re-pricing the dispatch ledger rows since `603ec78`, which carry ~500K-token
turns that this defect caused.
