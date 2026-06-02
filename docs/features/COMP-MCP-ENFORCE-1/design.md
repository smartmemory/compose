# COMP-MCP-ENFORCE-1 — Phase-Scoped MCP Tool Capabilities: Design

## Why

Deferred Slice 4 Part B of COMP-MCP-ENFORCE. Slices 1–3 + Slice 4 Part A (loopback REST auth) shipped 2026-06-02; phase-scoped tool filtering was deferred because the MCP stdio server does not currently track per-session lifecycle phase, making it a real architectural addition rather than a wiring change.

**Status:** SHIPPED 2026-06-02 (default-OFF `capabilities.phaseScopedTools`) — see [`blueprint.md`](./blueprint.md), [`report.md`](./report.md). This is the Phase-1 intent doc.
**Owner:** compose · **Parent:** COMP-MCP-ENFORCE (was COMP-DEBUG-1) · **Created:** 2026-06-02

## Related Documents

- Parent / umbrella: [`../COMP-MCP-ENFORCE/design.md`](../COMP-MCP-ENFORCE/design.md) (Slice 4 §"Phase-scoped tool capabilities")
- Substrate: `server/agent-templates.js` (capability profiles), `server/lifecycle-guard.js` (phase graph), `reference_statewright` (per-phase `allowed_tools` state-gating)

## Problem

The compose MCP server (`server/compose-mcp.js`) advertises a **static** list of ~54 tools to every client and dispatches `CallTool` with **no per-context restriction**. A context doing implementation work has the very tools that let it escape its lane — `approve_gate`, `complete_feature`, `set_feature_status`, `kill_feature`. The umbrella's principle ("unrepresentable beats forbidden") wants an implement-phase context to not even *have* those tools. Slices 1–3 closed the *evidence/terminal* bypasses at the tool boundary; this slice adds the *contextual* layer: which tools a session may use at all, given who it is (profile) and where the work is (phase).

### Architectural constraints (verified)

- `server/compose-mcp.js:625-642` — raw MCP SDK `Server`; `ListToolsRequestSchema` returns a static `TOOLS` array (`:630`), `CallToolRequestSchema` dispatches (`:634`). One stdio server **process per session**.
- The MCP server is a **separate process** from the REST/vision server. It **can** read `vision-state.json` from disk (as `toolGetVisionItems` does, `compose-mcp-tools.js:153`) → a bound feature's `lifecycle.currentPhase`. So **current phase is resolvable in-process** without the REST server.
- `bind_session` (`compose-mcp-tools.js:441`) delegates to REST and does **not** update MCP-process state today. MCP-process-global `_binding` (workspace) is set by `set_workspace` (`:613-628`).
- `agent-templates.js:11-37` profiles are about **Claude Code tools** (Read/Write/Bash), informational only — a *conceptual* substrate, not directly an MCP-tool allowlist.
- MCP SDK 1.26: `CallTool` enforcement is reliable; dynamic `ListTools` re-fetch (`tools/list_changed`) is **not** something we depend on — `ListTools` filtering is a best-effort surface, `CallTool` is the hard guarantee.

## Goal

A **profile-aware × phase** MCP tool gate, **default-OFF** (`capabilities.phaseScopedTools`), enforced at `CallTool` (hard guarantee *for a session that carries a restrictive profile*) with `ListTools` surface filtering. When ON:

- A session whose **trusted profile** is `implementer` or `reviewer` may only call tools in its lane; the management/approval/completion tools are denied — **except** where the bound feature's **current phase** legitimately permits them (e.g. `ship` → `complete_feature`).
- An **unprofiled / `orchestrator`** session is **unrestricted** — this is the `/compose` driver, so the existing flow is never broken.
- Off / override ⇒ allow. On unresolved context the posture is **graduated, not blanket fail-open**: an unresolved *profile* (no/unknown env) normalizes to `orchestrator` (unrestricted); an unresolved *phase* fails open only the phase *refinement* — the profile **base** policy still applies (a restricted context with unknown phase stays restricted). An out-of-band `STRATUM_GUARD_OVERRIDE_TOKEN` is the single sanctioned escape (consistent with Slice 3).

### Threat model (sharpened — Codex finding)

This layer is **blast-radius reduction for spawned subagent contexts**, NOT a boundary against a fully adversarial MCP client. A client that declines to carry a restrictive profile runs as `orchestrator` (unrestricted) — and that adversary is exactly what Slices 1–3 (evidence/terminal gating, fail-closed) and Slice 4A (loopback REST auth) already defend against. What this slice adds: when the `/compose` orchestrator **spawns** an implementer/reviewer subagent, that subagent's context is mechanically kept in-lane and cannot escalate to self-approve / self-complete / mutate roadmap — *because its profile is injected at spawn time and it cannot rewrite it* (Decision 1). Calling it a "hard guarantee" is accurate **only** in that scoped sense.

**Non-goals:** changing Claude Code's own tool gating (that's the host's job); per-tool argument policy (Slices 1–3 own that); a full per-phase allowlist of all 54 tools (strict model rejected — too broad, breaks flows); defending against a client that simply never declares a profile (out of scope — see threat model).

## Decision 1: Trusted profile from spawn-injected env; enforce at CallTool; phase on-disk

- **The authoritative profile is a spawn-injected env var the agent cannot rewrite (Codex finding).** Precedence:
  1. `process.env.COMPOSE_SESSION_PROFILE` — **trusted**. Set by `agent-spawn` when the orchestrator spawns a templated subagent (the subagent inherits it in its environment and cannot change its own launch env; its child `compose-mcp.js` process inherits it). This is the real boundary for spawned contexts.
  2. `bind_session({ profile })` — an **untrusted hint that may only NARROW**, never widen. If the env says `implementer`, a `bind_session(profile:'orchestrator')` is ignored; a `bind_session(profile:'reviewer')` (stricter) is honored. With no env profile, the bind hint applies but is advisory (the session is already unrestricted-capable).
  3. Neither set → `orchestrator` (unrestricted) — the human-launched `/compose` driver.
  - Resolved profile is held process-global (`_sessionProfile`, alongside the existing `_binding` pattern); one process per session ⇒ correct scope.
  - **Scope of this feature includes** the `agent-spawn` wiring: when spawning with a restrictive template, set `COMPOSE_SESSION_PROFILE` so the gate is end-to-end, not inert.
- **The MCP process learns its bound feature in-process (Codex finding).** Today `bind_session` delegates to REST and keeps no local feature state. v1 adds a process-global `_boundFeatureCode` set whenever `bind_session` is called with a `featureCode` and the REST call does not error — **including the `already_bound` reply** (so reconnects / repeat binds keep the anchor set), alongside `_sessionProfile` (same pattern as the existing `_binding` workspace state). The phase gate keys off `_boundFeatureCode`. A `CallTool` with no bound feature ⇒ phase unresolved ⇒ fail-open (the profile base policy still applies; only the phase *refinement* needs a feature anchor).
- **Phase resolved on-disk at call time.** Given `_boundFeatureCode`, the gate reads `vision-state.json` for that feature's `lifecycle.currentPhase` (same path as `toolGetVisionItems`). No HTTP dependency; `vision-state.json` is written atomically (rename) by the REST server on every lifecycle change, so it is fresh enough. Unresolvable → fail-open.
- **Rejected alternatives:** client-asserted profile only (not a boundary — the finding); REST-gateway endpoint (network hop + cross-process coupling per call); agent-side wrapper (outside compose's enforcement boundary).

## Decision 2: Policy = profile base ∪ phase refinement, declarative

A pure policy module `server/mcp-tool-policy.js`:

- `PROFILE_POLICY[profile]` → `{ mode: 'unrestricted' | 'deny' | 'allowlist', tools: [...] }`.
  - `orchestrator` (and **unprofiled** / unknown) → `unrestricted`.
  - `implementer` → `deny`: `approve_gate`, `complete_feature`, `kill_feature`, `set_feature_status`, `add_roadmap_entry`, `record_completion`, `propose_followup`. (Implementation work writes artifacts/journal/changelog/links and reads state — not lifecycle management.) **`set_workspace` is deliberately NOT denied** (Codex finding): workspace selection is a setup prerequisite that can precede feature binding; denying it would strand a restricted session in a multi-workspace repo. Setup/query tools (`set_workspace`, `get_workspace`, `bind_session`, all `get_*`) are never gated.
  - `reviewer` → `allowlist`: the read/query/setup tools only (`get_*`, `validate_*`, `roadmap_diff`, `get_changelog_entries`, `set_workspace`, `bind_session`, …) — every state mutation denied.
- `PHASE_REFINEMENT[phase]` → management tools *re-permitted* in that phase, **applied to `deny`-mode profiles only, never to `allowlist`-mode profiles** (Codex finding). v1: `ship` → `{ complete_feature, record_completion }`. So an `implementer` at `ship` may complete; a `reviewer` is read-only in *every* phase including `ship` (its allowlist is never widened). All other phases re-permit nothing.
- `isToolAllowed(toolName, { profile, phase })` → `{ allowed: boolean, reason }`. Decision order:
  1. `unrestricted` profile (orchestrator/unprofiled) ⇒ allow.
  2. `allowlist`-mode (`reviewer`): allowed iff tool ∈ allowlist. **Phase refinement does NOT widen an allowlist** — a reviewer never gains a mutation tool.
  3. `deny`-mode (`implementer`): denied iff tool ∈ denylist, UNLESS `PHASE_REFINEMENT[phase]` re-permits it **AND the tool's target resolves to `_boundFeatureCode`** (next bullet). So `implementer` bound to A + `ship` ⇒ `complete_feature(A)` allowed, `complete_feature(B)` denied; `implementer` + `execute` ⇒ denied.
- **Phase re-permits are feature-scoped (Codex finding).** A `PHASE_REFINEMENT` grant applies ONLY when the gated mutation targets the bound feature. The gated tools carry a target that must be resolved to a feature code and compared to `_boundFeatureCode`:
  - `complete_feature(id)` / `kill_feature(id)` → item `id` → `lifecycle.featureCode`
  - `record_completion(feature_code)` / `set_feature_status(code)` → the code directly
  - `approve_gate(gateId)` → gate → `itemId` → `lifecycle.featureCode`
  - `add_roadmap_entry` / `propose_followup` mint *new* features → never match an existing `_boundFeatureCode` ⇒ never re-permitted for a restricted profile (correct: a restricted context does not create roadmap rows).
  If the target cannot be resolved, or differs from `_boundFeatureCode`, the phase re-permit does **not** apply and the profile denial stands. (`bind_session` may return `already_bound` to a *different* feature than requested — `_boundFeatureCode` is the authoritative anchor, and a cross-feature target is denied regardless of phase.) Target resolution reuses the on-disk `vision-state.json` read.

This keeps the policy data-driven and unit-testable in isolation, and makes "what can an implementer do in execute vs ship" a table, not scattered conditionals.

## Decision 3: Capability flag + fail-open + override (consistent with the umbrella)

- `capabilities.phaseScopedTools` (default **OFF**) read from `.compose/compose.json` (MCP process via `loadProjectConfig`). Off ⇒ `CallTool`/`ListTools` behave exactly as today.
- **Graduated unresolved-context posture (NOT blanket fail-open):** unresolved *profile* ⇒ orchestrator/unrestricted; unresolved *phase* ⇒ only the phase refinement fails open, the profile base policy still applies. The gate blocks on a positive profile-base deny even with unknown phase — a restricted context stays restricted. (A default-off defense-in-depth surface that must not wedge flows it doesn't understand, but also must not silently un-restrict a context whose phase merely couldn't be read.)
- **Override:** `args.override_token === process.env.STRATUM_GUARD_OVERRIDE_TOKEN` ⇒ allow + record (the one authorized escape, mirroring Slice 3's `assertForceAuthorized`).
- **CallTool denial** returns a structured MCP error (`isError: true`, `code: PHASE_TOOL_DENIED`, the reason, and the resolved {profile, phase}) — never a silent drop.
- **ListTools filtering** reflects the current resolvable {profile, phase} best-effort; documented as surface-only (the enforcement is CallTool).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/mcp-tool-policy.js` | new | Declarative profile×phase policy + `isToolAllowed` (pure); profile precedence resolver (env trusted > bind hint may-only-narrow > orchestrator) |
| `server/compose-mcp-tools.js` | modify | resolve trusted profile (env `COMPOSE_SESSION_PROFILE` > `bind_session` narrow-only hint); record `_boundFeatureCode` on successful `bind_session`; export `_getSessionProfile`/`_getBoundFeatureCode`; phase resolver from `vision-state.json`; `assertToolPhaseAllowed` helper |
| `server/compose-mcp.js` | modify | `CallTool` gate (hard) + `ListTools` filter (surface), behind `capabilities.phaseScopedTools` |
| `server/agent-spawn.js` | modify | set `COMPOSE_SESSION_PROFILE` in the spawned subagent env when the template is restrictive; map existing agent templates → MCP profiles (`read-only-reviewer`/`read-only-researcher`/`security-auditor` → `reviewer`; `implementer` → `implementer`; `orchestrator` → unrestricted) |
| `test/mcp-tool-policy.test.js` | new | Policy table: profile/phase matrix, allowlist/deny/refinement, narrow-only precedence, override |
| `test/mcp-phase-gate.test.js` | new | CallTool denial + fail-open + flag-off parity + ListTools filter |

## Open Questions

1. **Profile source of truth** — v1's trusted source is the spawn-injected `COMPOSE_SESSION_PROFILE` env (process == session); `bind_session` can only narrow. A future version could also derive/verify the profile from the persisted session record or the agent-template registry so a re-attached session re-derives it. v1: env + narrow-only hint is sufficient.
2. **ListTools freshness** — without `tools/list_changed`, a client that listed before binding sees the full set until it re-lists. Accepted: `CallTool` is the guarantee; ListTools is a courtesy. Revisit if SDK gains reliable `list_changed`.
