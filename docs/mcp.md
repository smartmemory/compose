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
| `add_roadmap_entry` | Register a new feature: writes `feature.json` + regenerates `ROADMAP.md`. Audit-log append is best-effort. Use instead of editing ROADMAP by hand. |
| `set_feature_status` | Flip a feature status with transition-policy enforcement (`force: true` overrides). Appends an audit event (best-effort). |
| `roadmap_diff` | Read the feature-management audit log for a window. Returns `events[]`, `added[]`, `status_changed[]`. |
| `start_iteration_loop` | Start an iteration loop on a feature |
| `report_iteration_result` | Report an iteration's result; the server decides whether to continue. Terminal outcomes are `clean`, `max_reached`, `action_limit`, or `timeout`; while the loop is still running, `outcome` is `null`. |
| `abort_iteration_loop` | Abort an active iteration loop |

> **Note:** an `agent_run` tool used to live here for LLM-facing dispatch. It was removed on 2026-04-18 (`STRAT-DEDUP-AGENTRUN`); use `mcp__stratum__stratum_agent_run` instead.

## Roadmap writers (COMP-MCP-ROADMAP-WRITER)

`add_roadmap_entry`, `set_feature_status`, and `roadmap_diff` route every roadmap mutation through a typed surface so feature-management state stays consistent across `feature.json`, `ROADMAP.md`, and the audit log.

**Write order** for the two writers (steps 3-4 are committed; step 5 is best-effort):
1. Validate inputs (code shape, status enum, transition policy).
2. Idempotency check (if `idempotency_key` supplied) — replay returns the cached result without re-mutating.
3. Mutate `docs/features/<CODE>/feature.json`.
4. Regenerate `ROADMAP.md` from all `feature.json` files (`lib/roadmap-gen.js:writeRoadmap`).
5. Append a row to `.compose/data/feature-events.jsonl` (canonical audit log).

If step 3 fails, nothing changes. If step 4 fails, `feature.json` is correct but `ROADMAP.md` is stale — recover by running `compose roadmap generate`. If step 5 fails, the mutation succeeded but the audit row is missing; we log a warning and don't roll back.

**Transition policy** enforced by `set_feature_status` (use `force: true` to bypass; force is recorded in audit):

```
PLANNED      → IN_PROGRESS, KILLED, PARKED
IN_PROGRESS  → PARTIAL, COMPLETE, BLOCKED, KILLED, PARKED
PARTIAL      → IN_PROGRESS, COMPLETE, KILLED
COMPLETE     → SUPERSEDED                 (rare; force-only)
BLOCKED      → IN_PROGRESS, KILLED, PARKED
PARKED       → PLANNED, KILLED
KILLED       → (terminal)
SUPERSEDED   → (terminal)
```

**Idempotency keys** are caller-provided strings cached at `.compose/data/idempotency-keys.jsonl` (last 1000 entries, file-locked). Same key replays return the cached result; missing key always executes.

**Audit log** at `.compose/data/feature-events.jsonl` is append-only JSONL. Each row: `{ ts, tool, code, from?, to?, reason?, actor, idempotency_key? }`. Actor is `process.env.COMPOSE_ACTOR` (e.g. `cockpit:user-42`) or `mcp:agent` by default. `roadmap_diff` reads this file.

**Why not call REST?** The writers are pure file-IO in `lib/feature-writer.js` — no HTTP delegation. The COMP-DOCS-FACTS architectural review flagged HTTP-from-MCP as a layering violation; this surface avoids it.
