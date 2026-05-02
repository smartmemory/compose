# MCP Server

Compose's project state exposed as MCP tools.

Compose exposes project state as MCP tools via `server/compose-mcp.js` (stdio transport). Registered in `.mcp.json` by `compose init`. Available tools:

| Tool | Description |
|------|-------------|
| `get_vision_items` | Query items by phase, status, type, keyword |
| `get_item_detail` | Full item detail with connections |
| `get_phase_summary` | Status/type distribution per phase |
| `get_blocked_items` | Items blocked by non-complete dependencies |
| `get_current_session` | Active session context (tool count, items touched) |
| `bind_session` | Bind agent session to a lifecycle feature |
| `get_feature_lifecycle` | Feature lifecycle state, phase history, artifacts |
| `kill_feature` | Kill a feature with reason |
| `complete_feature` | Mark feature complete (ship phase only) |
| `assess_feature_artifacts` | Quality signals for feature artifacts |
| `scaffold_feature` | Create feature folder with template stubs |
| `approve_gate` | Resolve a pending gate (approved/revised/killed) |
| `get_pending_gates` | List pending gates |
| `start_iteration_loop` | Start an iteration loop on a feature |
| `report_iteration_result` | Report an iteration's result; the server decides whether to continue. Terminal outcomes are `clean`, `max_reached`, `action_limit`, or `timeout`; while the loop is still running, `outcome` is `null`. |
| `abort_iteration_loop` | Abort an active iteration loop |

> **Note:** an `agent_run` tool used to live here for LLM-facing dispatch. It was removed on 2026-04-18 (`STRAT-DEDUP-AGENTRUN`); use `mcp__stratum__stratum_agent_run` instead.
