# COMP-MCP-ENFORCE-1 — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4) — verified against source 2026-06-02. Design ([`design.md`](./design.md)) Codex REVIEW CLEAN (5 rounds).

## Scope

Profile-aware × phase MCP tool gate, default-OFF (`capabilities.phaseScopedTools`), enforced at `CallTool` (hard, for a session carrying a restrictive profile) + `ListTools` surface filter. Trusted profile from spawn-injected `COMPOSE_SESSION_PROFILE`; phase resolved on-disk from `vision-state.json` keyed by an in-process `_boundFeatureCode`; phase re-permits are feature-scoped.

## What exists (verified)

- `server/compose-mcp.js:625-734` — raw MCP SDK `Server`. `ListTools` returns static `TOOLS` (`:630-632`). `CallTool` (`:634`): destructures `{name, arguments: args}` (`:635`), has a `WORKSPACE_EXEMPT` set (`:637`), resolves workspace (`:640-643`), then a `switch (name)` dispatch (`:645-688`), wrapping results in `{content:[...]}` / `{isError:true}` (`:689-724`). **The gate inserts between `:635` and the switch.**
- `server/compose-mcp-tools.js`:
  - `_binding` process-global (`:613`), `_getBinding` (`:628`) — the existing per-process session-state pattern to mirror.
  - `toolBindSession({featureCode})` (`:441-456`) — POSTs `/api/session/bind`, returns `body`. **Add:** set `_boundFeatureCode = featureCode` on non-error (incl. `already_bound`), resolve `_sessionProfile`.
  - `loadVisionState()` → `{items}` where items carry `lifecycle` (used by `toolGetFeatureLifecycle`) — **reuse to resolve a feature's `lifecycle.currentPhase`** by matching `item.lifecycle.featureCode === _boundFeatureCode`.
  - Slice-3 boundary helpers already here (`assertForceAuthorized`/`assertTerminalStatusAuthorized`/`assertCompletionEvidence`, `_guardOn`/`_overrideOk`) — the gate reuses `loadProjectConfig` + `_overrideOk` idioms.
- `server/agent-spawn.js:53-58` — `spawn('claude', [...], { env: cleanEnv })`. **Inject** `COMPOSE_SESSION_PROFILE` into `cleanEnv` from the spawn template.
- `server/agent-templates.js:11-37` — `AGENT_TEMPLATES` (read-only-reviewer/read-only-researcher/implementer/orchestrator/security-auditor) → source for `TEMPLATE_PROFILE_MAP`.
- MCP SDK 1.26 (`package.json`): `CallTool` is the enforcement point; `ListTools` filtering is best-effort surface (no `tools/list_changed` dependency).

## Corrections table (design assumption → reality)

| Assumption | Reality | Resolution |
|---|---|---|
| MCP process knows the bound feature | `bind_session` keeps no local feature state (`:441-456`) | Add `_boundFeatureCode` set in `toolBindSession` |
| Phase readable in-process | `loadVisionState()` reads `vision-state.json` with `lifecycle` per item | Resolve via `items.find(i => i.lifecycle?.featureCode === code)?.lifecycle?.currentPhase` |
| agent-spawn can inject env | `spawn('claude', …, {env: cleanEnv})` at `:53-58` | Add `COMPOSE_SESSION_PROFILE` to `cleanEnv` when template maps to a restrictive profile |
| CallTool has one choke point | Yes, `:634` before the switch | Gate inserted there, behind the capability flag, with `WORKSPACE_EXEMPT`-style setup-tool exemption |

## Build plan

### S01 — `server/mcp-tool-policy.js` (new, pure)
- `TEMPLATE_PROFILE_MAP` const: agent-template name → MCP profile (`read-only-*`/`security-auditor` → `reviewer`; `implementer` → `implementer`; `orchestrator`/unknown → `orchestrator`).
- `PROFILE_POLICY` const: `orchestrator` → `{mode:'unrestricted'}`; `implementer` → `{mode:'deny', tools:[approve_gate, complete_feature, kill_feature, set_feature_status, add_roadmap_entry, record_completion, propose_followup]}`; `reviewer` → `{mode:'allowlist', tools:[get_*, validate_*, roadmap_diff, get_changelog_entries, get_completions, get_feature_*, get_pending_gates, get_phase_summary, get_blocked_items, get_current_session, set_workspace, get_workspace, bind_session, assess_feature_artifacts]}`.
- `PHASE_REFINEMENT` const: `{ ship: ['complete_feature','record_completion'] }`.
- `SETUP_TOOLS` const (never gated): `set_workspace, get_workspace, bind_session, get_current_session` + all read/`get_*`.
- `resolveProfile(envProfile, bindHint)` → trusted env wins; bind hint may only NARROW (strictness order orchestrator < implementer < reviewer); neither ⇒ `orchestrator`.
- `TARGET_RESOLVERS` map: tool → how to extract its target feature anchor (`complete_feature`/`kill_feature`: `args.id`→item; `record_completion`: `args.feature_code`; `set_feature_status`/`add_roadmap_entry`/`propose_followup`: `args.code`; `approve_gate`: `args.gateId`→gate→item). Returns `{kind:'feature'|'item'|'gate'|'new', value}` for the caller to resolve against `_boundFeatureCode`.
- `isToolAllowed({tool, profile, phase, targetMatchesBoundFeature})` → `{allowed, reason}`. Order: unrestricted⇒allow; SETUP_TOOLS⇒allow; allowlist⇒tool∈allowlist (phase never widens); deny⇒denied unless `PHASE_REFINEMENT[phase]` includes tool **AND** `targetMatchesBoundFeature===true`.

### S02 — `server/compose-mcp-tools.js` (modify)
- Add `_sessionProfile = null`, `_boundFeatureCode = null`; getters `_getSessionProfile()`, `_getBoundFeatureCode()`.
- Module init: `_sessionProfile = resolveProfile(process.env.COMPOSE_SESSION_PROFILE, null)`.
- `toolBindSession`: on non-error (incl. `already_bound`), `_boundFeatureCode = featureCode`; `_sessionProfile = resolveProfile(process.env.COMPOSE_SESSION_PROFILE, args.profile)`.
- `resolveBoundPhase()` → from `loadVisionState()`, the bound feature's `lifecycle.currentPhase` (or null).
- `targetMatchesBoundFeature(tool, args)` → resolve the tool's target (via `TARGET_RESOLVERS` + `loadVisionState`) to a feature code, compare to `_boundFeatureCode`; new-feature minters ⇒ false; unresolved ⇒ false.
- `assertToolPhaseAllowed(tool, args, capsOverride?)`: if `!_guardOn2(capsOverride)` (reads `capabilities.phaseScopedTools`) ⇒ allow; if `_overrideOk(args)` ⇒ allow; else `isToolAllowed({tool, profile:_sessionProfile, phase:resolveBoundPhase(), targetMatchesBoundFeature:targetMatchesBoundFeature(tool,args)})`; throw `{code:'PHASE_TOOL_DENIED', message, profile, phase}` if not allowed.

### S03 — `server/compose-mcp.js` (modify)
- `CallTool` (`:634`): immediately after `:635`, `try { assertToolPhaseAllowed(name, args); } catch(e){ return {content:[{type:'text', text:`Error [${e.code}]: ${e.message}`}], isError:true}; }` — before workspace resolution/switch.
- `ListTools` (`:630`): filter `TOOLS` best-effort via the same policy with the current resolvable `{profile, phase}` (target check N/A at list time → list tools whose profile-base permits them; document surface-only).

### S04 — `server/agent-spawn.js` (modify)
- Where the spawn template is known, set `cleanEnv.COMPOSE_SESSION_PROFILE = TEMPLATE_PROFILE_MAP[template]` when it maps to a restrictive profile (skip for orchestrator/unknown). Keep additive; no behavior change when the template is non-restrictive or the flag is off.

### S05 — Tests
- `test/mcp-tool-policy.test.js`: pure policy matrix — unrestricted allow; implementer deny set; implementer+ship+own-feature ⇒ complete allowed; implementer+ship+OTHER-feature ⇒ denied; implementer+execute ⇒ denied; reviewer allowlist + ship does NOT widen; `resolveProfile` env-wins + narrow-only; SETUP_TOOLS never gated; override allows.
- `test/mcp-phase-gate.test.js`: `assertToolPhaseAllowed` with injected caps/profile/phase — flag-off parity (no throw), denial throws PHASE_TOOL_DENIED, fail-open on unresolved phase/profile, `_boundFeatureCode` target matching, override.

## File Plan

| File | Action |
|---|---|
| `server/mcp-tool-policy.js` | new |
| `server/compose-mcp-tools.js` | edit |
| `server/compose-mcp.js` | edit |
| `server/agent-spawn.js` | edit |
| `test/mcp-tool-policy.test.js` | new |
| `test/mcp-phase-gate.test.js` | new |

## Boundary Map

The S01→S04 and S01→S03 seams are JS symbol imports (intra-compose). The spawn env var (`COMPOSE_SESSION_PROFILE`) and the MCP error envelope are prose, not Boundary Map entries.

### S01: Policy module
Produces:
  server/mcp-tool-policy.js → isToolAllowed, resolveProfile, TEMPLATE_PROFILE_MAP, PROFILE_POLICY, PHASE_REFINEMENT (function)
Consumes: nothing

### S02: Session state + gate helper
Produces:
  server/compose-mcp-tools.js → assertToolPhaseAllowed, resolveBoundPhase, _getSessionProfile, _getBoundFeatureCode (function)
Consumes:
  from S01: server/mcp-tool-policy.js → isToolAllowed, resolveProfile

### S03: MCP server gate + list filter
Produces: nothing
Consumes:
  from S02: server/compose-mcp-tools.js → assertToolPhaseAllowed

### S04: Spawn profile injection
Produces: nothing
Consumes:
  from S01: server/mcp-tool-policy.js → TEMPLATE_PROFILE_MAP

## Verification table (Phase 5)

Verified against source on 2026-06-02.

| Claim | Ref | Result |
|---|---|---|
| CallTool choke point + destructure | `server/compose-mcp.js:634-635` | ✓ `{name, arguments: args = {}}` |
| WORKSPACE_EXEMPT pattern to mirror | `server/compose-mcp.js:637` | ✓ |
| switch dispatch + isError envelope | `server/compose-mcp.js:645-724` | ✓ |
| ListTools static array | `server/compose-mcp.js:630-632` | ✓ |
| `_binding`/`_getBinding` per-process pattern | `server/compose-mcp-tools.js:613,628` | ✓ |
| `toolBindSession` returns body, no local feature state | `server/compose-mcp-tools.js:441-456` | ✓ |
| `loadVisionState` carries lifecycle | used by `toolGetFeatureLifecycle` (`:530`) | ✓ items have `lifecycle` |
| Slice-3 helpers/idioms reusable | `assertForceAuthorized`/`_overrideOk`/`loadProjectConfig` | ✓ present |
| agent-spawn env injection point | `server/agent-spawn.js:53-58` | ✓ `spawn('claude', …, {env: cleanEnv})` |
| agent templates source | `server/agent-templates.js:11-37` | ✓ 5 templates |
| Boundary Map | `node lib/boundary-map.js` | ✓ (run in Phase 5) |

**Gate: PASS** pending Boundary Map validator run.
