# COMP-MIMO-INTEROP — Plan (seed)

**Status:** PLANNED · promoted from forge-top ROADMAP 2026-06-14. Low urgency / strategic. Scope sanity-checked against source 2026-06-14.

**Source:** Xiaomi MiMoCode teardown (2026-06-13). MiMoCode (OpenCode fork, released 2026-06-10) retains MCP + plugins + the Claude-Code `SKILL.md`/command/agent format and ships one-step "Import from Claude Code" — making it an interop *substrate* for our stack, not just a competitor.

## Two legs

### (a) MCP-host interop validation
Confirm `compose` (and `stratum-mcp`) register and can drive work under MiMoCode.

**Sanity-check result (2026-06-14 vs source):** both are textbook stdio MCP servers on the official SDKs — `compose` uses `@modelcontextprotocol/sdk` `StdioServerTransport` (`server/compose-mcp.js:820`); `stratum-mcp` uses `FastMCP` / `mcp>=1.0` (console-script `stratum_mcp.server:main`). So **register + list + call tools is unchanged** under any stdio-MCP host. The *transport* is host-agnostic, but a *full flow* assumes the Claude-Code host surface — scope honestly as **register/list = unchanged; flow = needs host-surface adapters**.

- [ ] Add MiMoCode MCP-config entry for `compose` (+ `stratum-mcp`) and confirm tools list + a read-only call succeed.
- [ ] Map the host-surface gaps before claiming "flows run": (i) Stratum non-codex dispatch + skills call host `Agent`/`Skill`/`TodoWrite` (MiMo has its own subagent system; codex dispatch is subprocess → portable); (ii) Compose `record_completion`/lifecycle run over the separate `:4001` HTTP server, not the stdio MCP; (iii) skill tool-name translation layer.
- [ ] Decide scope: "MCP registers/lists" (cheap, achievable now) vs "full flow under MiMo" (needs the adapters above) — likely ship the former, file the latter.

### (b) Neutral benchmark subject
MiMo's "beats Claude Code at 200+ step tasks" headline is **self-reported** (TechTimes flagged it). It is the obvious first *external* subject for `COMP-BENCH` once that suite lands.

- [ ] Once `COMP-BENCH` ships, run MiMoCode through it as the first external model/harness and publish a neutral score against the self-reported claim.

## Dependencies
- Leg (b) depends on `COMP-BENCH-1..5` (PLANNED).
- Leg (a) MCP-host check is technically a stratum concern; tracked here per the 2026-06-14 ownership decision (compose owns this ticket, collaborates with stratum on the host check).

## Non-goals
- Vendoring MiMoCode or maintaining a fork.
- Guaranteeing full Stratum/Compose flow parity under MiMo in v1 (transport interop only; flow adapters are a separate, larger scope).

_Provenance: forge-top `MIMO-INTEROP` row; `reference_mimocode` memory._
