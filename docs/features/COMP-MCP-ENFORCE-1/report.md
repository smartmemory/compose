# COMP-MCP-ENFORCE-1 — Implementation Report

**Status:** SHIPPED 2026-06-02. Default-OFF (`capabilities.phaseScopedTools`).
**Chain:** [`design.md`](./design.md) (Codex CLEAN, 5 rounds) → [`blueprint.md`](./blueprint.md) (Boundary Map clean) → implementation (Codex CLEAN, 2 rounds).

## 1. Summary

Phase-scoped MCP tool capabilities: the compose MCP server now gates tool calls by the session's **trusted profile × the bound feature's current phase**, default-OFF. A subagent spawned with a restrictive profile (`implementer`/`reviewer`) is mechanically kept in-lane — it cannot self-approve, self-complete, or mutate roadmap status — while the `/compose` orchestrator (unprofiled) stays unrestricted, so the existing flow is untouched. This completes the COMP-MCP-ENFORCE umbrella's Slice 4 Part B (was COMP-DEBUG-1).

## 2. Delivered vs Planned

| Planned | Delivered |
|---|---|
| Pure profile×phase policy | ✅ `server/mcp-tool-policy.js` (`isToolAllowed`, `resolveProfile`, `resolveSpawnProfile`, `TEMPLATE_PROFILE_MAP`, `PROFILE_POLICY`, `PHASE_REFINEMENT`, `SETUP_TOOLS`) |
| Trusted profile + bound-feature anchor | ✅ `_sessionProfile` (from `COMPOSE_SESSION_PROFILE` env), `_boundFeatureCode` (authoritative reply), `resolveBoundPhase`, `assertToolPhaseAllowed` |
| CallTool hard gate + ListTools surface | ✅ `server/compose-mcp.js` — `PHASE_TOOL_DENIED` before dispatch; best-effort list filter |
| Spawn-time profile injection | ✅ `server/agent-spawn.js` injects `COMPOSE_SESSION_PROFILE` via `resolveSpawnProfile` |
| Tests | ✅ policy matrix (16) + gate (10) |

## 3. Key Implementation Decisions

- **Trusted profile = spawn-injected env**, not a client-asserted arg. `COMPOSE_SESSION_PROFILE` is set by `agent-spawn` (the agent cannot rewrite its own launch env; its `compose-mcp` child inherits it). `bind_session({profile})` may only **narrow** (`resolveProfile` = max-strictness of env-floor and hint). This is what makes the CallTool guarantee real *for spawned contexts* — see the design's sharpened threat model.
- **Graduated unresolved-context posture** (not blanket fail-open): unresolved profile → orchestrator/unrestricted; unresolved phase → only the phase *refinement* fails open, the profile **base** deny still applies (a restricted context with unknown phase stays restricted).
- **Feature-scoped re-permits.** A `ship`-phase re-permit of `complete_feature`/`record_completion` applies only when the tool's target resolves to `_boundFeatureCode` (authoritative from the bind reply, so an `already_bound` response can't drift the anchor). Reviewer (allowlist) is never widened by phase.
- **CallTool is the hard guarantee; ListTools is best-effort** (no `tools/list_changed` dependency on SDK 1.26).
- **Setup tools never gated** (`set_workspace`/`get_workspace`/`bind_session`/`get_current_session`) so a restricted session can't be stranded before binding.

## 4. Test Coverage

- `test/mcp-tool-policy.test.js` (16): resolveProfile env-floor/narrow-only/unknown; TEMPLATE_PROFILE_MAP; orchestrator-allow-all; implementer deny set & lane tools; implementer+ship+own-feature re-permit; implementer+ship+other-feature denied; implementer+execute denied; reviewer allowlist + never-widened-by-phase; resolveSpawnProfile; PHASE_REFINEMENT shape.
- `test/mcp-phase-gate.test.js` (10): flag-off parity; orchestrator allow; implementer deny (PHASE_TOOL_DENIED w/ profile+phase); lane allow; ship feature-scoped allow/deny; reviewer not widened; graduated unresolved-phase; override token; setup tools never gated.
- Full compose suite green (node:test **3022**).

## 5. Files Changed

`server/mcp-tool-policy.js` (new), `server/compose-mcp-tools.js`, `server/compose-mcp.js`, `server/agent-spawn.js`, `test/mcp-tool-policy.test.js` (new), `test/mcp-phase-gate.test.js` (new).

## 6. Known Issues & Tech Debt

- **ListTools freshness:** a client that listed before binding sees the full set until it re-lists (no `tools/list_changed`). Accepted — CallTool is the enforcement.
- **Profile durability:** the trusted profile lives in the MCP process (env). A re-attached session re-derives it from env on restart; a future version could persist/verify it against the session record.
- **agent-spawn opt-in:** the orchestrator must pass `profile`/`template` when spawning to activate gating for that subagent. Unspecified spawns stay unrestricted (orchestrator) by design.

## 7. Lessons Learned

- **The MCP enforcement boundary is the CallTool choke point + a trusted env-injected identity.** Client-asserted profiles are worthless against a rogue client; spawn-injected env is the cheapest trusted channel (the parent sets it, the child can't change it). The honest framing — "blast-radius reduction for spawned contexts, not a boundary against a client that declines a profile" — kept the design from over-claiming.
- **Dogfooding friction (worth noting):** with `capabilities.guard` ON, marking *this* feature COMPLETE via the `set_feature_status` MCP tool is itself blocked by Slice 3's terminal-status gate (COMPLETE is lifecycle-owned). For a roadmap row with no started lifecycle, the status flip goes through the **trusted local operator path** (lib/CLI), not the MCP-client boundary — exactly the threat-model split working as intended.
