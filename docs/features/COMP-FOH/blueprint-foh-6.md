# Blueprint — FOH-6 COLLEAGUE-PANEL

**Status:** DRAFT — pending Phase 5 verification (every file:line ref below) + VERIFY-1/2/3
(need local stack up).
**Design:** [design-foh-6.md](design-foh-6.md) (Codex REVIEW CLEAN r3, committed @43aab5e).
**Ledger:** [foh-6-progress.md](foh-6-progress.md).
**Mockup:** [mockups/colleague-pane.html](mockups/colleague-pane.html).

## Overlap check (in-flight features sharing files)

- **COMP-PLAN-IDEA-UNIFY (PARTIAL)** shares `lib/fluid/ideabox-ops.js`. FOH-6's touch is one
  additive export (`contradictionsOf`) + write-back calls through the existing `addDiscussion` —
  no signature changes to shared ops. Low collision; coordinate at merge if that feature lands
  concurrent edits.
- No other active blueprint references `server/maya-routes.js` (new), `lib/colleague/` (new), or
  the cockpit chrome files below.

## Upstream contracts this build consumes (Maya — read-only, never edited)

All under `/Users/ruze/reg/my/SmartMemory/maya/` (zero diffs allowed there; acceptance criterion):

| Contract | Where | What we rely on |
|---|---|---|
| `POST /api/chat` | `server/maya/api/routes.py:5354` | Non-streaming turn; JWT via `Authorization: Bearer` |
| `ChatRequest` | `routes.py:3230-3246` | `message`, `timezone`, `surface`, `channel_context: List[Dict[str,str]]` (accepted on input despite `exclude=True`) |
| `ChatResponse` | `routes.py:3383-3401` | `success`, `response`, `message_id` (write-back idempotency key), `memory_available` |
| channel_context consumption | `routes.py:4090, 4482`, `_format_channel_context_block` `:714-754` | Injected verbatim, priority 2, token-capped (`llm_manager.py:493-498`, `max_tokens=CHANNEL_CONTEXT_MAX_TOKENS`) |
| Workspace scoping | `maya/api/client.py:73-83, 147-150` | Workspace derived SOLELY from verified JWT claim (`workspace_id`/`current_workspace_id`/`default_team_id`) |
| Session model | `session_registry.py:486-527` | One conversation per JWT identity; 30-min inactivity / 24-h rollover |
| Health | `maya_server.py:46` | `GET /health`, public |
| Auth middleware | `maya_server.py:53-93` | SmartMemory/Clerk JWT; no API-key path |

Provisioning (smart-memory-service, also read-only): `POST /test/provision-user` → `{user_id,
tenant_id, team_id, access_token}`; `POST /memory/beta/nda/accept {"version":"v1"}`;
`DELETE /test/provision-user {email, user_id, tenant_id}` (FOH-4 ledger, verified live 2026-08-10).

## File plan

### S1 — relay + token source

| File | Status | What |
|---|---|---|
| `lib/maya-config.js` | (new) | `getMayaConfig(cwd)` mirroring `lib/smartmemory-config.js:20-28`: reads `.compose/compose.json` `maya` block `{baseUrl, auth: {mode}}`; absent → `{enabled:false}` |
| `lib/maya-identity.js` | (new) | Identity store `data/maya-identity.json` (gitignore entry): `loadIdentity()`, `saveIdentity()`, `provisionIdentity({smBaseUrl})` (provision + NDA accept), `teardownIdentity()`. Exports `validateWorkspaceIsolation(identity, fluidWorkspaceId)` — refuses `team_id === fluid.smartmemory.workspaceId` (design §2; fluid workspaceId read via `lib/fluid/factory.js:136-161` config path) |
| `lib/maya-client.js` | (new) | `createMayaClient({baseUrl, getToken})`: `health()`, `chat({message, channelContext, surface})` → upstream `POST /api/chat`; single same-token retry on 401 then typed `MayaAuthError`; timeouts per `lib/smartmemory-client.js` `fetchWithContract` pattern (per-call `timeoutMs` — chat needs a generous cap, her turn does LLM work) |
| `server/maya-routes.js` | (new) | `attachMayaRoutes(app, {projectRoot})`: `GET /api/maya/status` (degrade-never-fail shaped 200s, model `server/smartmemory-routes.js:66-112`), `POST /api/maya/message` (compose context → chat → write-back → `{reply, message_id, writeback}`). **Stays BEHIND the remote auth gate — never allowlisted** (`server/auth-middleware.js:196` — `if (_allowed(path)) return next();` admits allowlisted paths with no auth) |
| `server/vision-server.js` | (existing) | One `attachMayaRoutes(app, …)` call next to `attachSmartmemoryRoutes` (attach block `:88-277`) |
| `test/helpers/maya-stub.js` | (new) | Local HTTP stub of `/health` + `/api/chat` (+ knobs: `__401Once`, `__401Always`, `__rejectChannelContext`, `__slow`), mirroring `test/helpers/smartmemory-stub.js` conventions |
| `test/maya-client.test.js` | (new) | Client contract incl. 401-retry-once, timeout, channel_context passthrough |
| `test/maya-routes.test.js` | (new) | Status shapes, auth posture (route not in allowlist), message happy path against stubs |

### S2 — context builder (first production consumers)

| File | Status | What |
|---|---|---|
| `lib/colleague/context.js` | (new) | `composeColleagueContext(ctx, {focusId})` → `{blocks: [{author, text}], omissions: []}`. Sections per declared capability (`provider.has(CAP.X)`), composed concurrently with per-capability timeouts; priority order **contradictions > conviction > challenge > record body > discussion** enforced under a byte budget; every dropped section named in `omissions`. Provenance authors: `compose:idea IDEA-42`, `compose:contradiction`, … |
| `lib/fluid/ideabox-ops.js` | (existing) | New export `contradictionsOf(ctx, id)` following the `convictionOf` shape (`:508-512`): resolve id → provider `contradictions(handle)`, `FluidRecordNotFound → IdeaboxNotFound`. **First production callers land here:** `challengeIdea` (`:487`), `convictionOf` (`:508`), `contradictionsOf` (new) all invoked by `context.js`. `resolveIdeaChallenge` untouched — stays CLI-only |
| `test/colleague-context.test.js` | (new) | Per-capability inclusion/absence, truncation order (golden: contradiction survives, discussion drops first), omissions list, provider-error paths (capability throw ≠ turn failure — section omitted + named) |

### S3 — panel

| File | Status | What |
|---|---|---|
| `src/components/colleague/ColleaguePanel.jsx` | (new) | Slide-over (overlay + scrim, right-docked): header, findings accordion, message list, input. Reuses `ChatInput.jsx` + `MessageCard.jsx` (`src/components/agent/`; imports `AgentStream.jsx:3-4`, usage `MessageCard` `:590`, `ChatInput` `:688`) with a message-shape adapter. Renders the funnel state machine from design §gating (5 states) |
| `src/components/colleague/useMayaStatus.js` | (new) | Fetch-on-open + workspace-keyed memo of `GET /api/maya/status`, mirroring `useRecallEnabled.js:21-59` — but driving **funnel states, not visibility** (`RecallTab` hide-when-disabled is the named anti-pattern, `ContextItemDetail.jsx:55-65`) |
| `src/components/cockpit/ViewTabs.jsx` | (existing) | Summon button after the unnamed spacer `<div className="flex-1" />` at `:73` (before the Cmd+K button `:74-83`) — there is **no `tab-spacer` selector in code**; give the button its own class, don't anchor on the spacer. Renders iff status says installed; toggles the panel. **No `DEFAULT_MAIN_TABS`/`TAB_META` change** (persistence machinery `viewTabsState.js:99-107` migration loop deliberately untouched) |
| `src/App.jsx` | (existing) | Panel mount + open/close state; focus context: current Ideabox selection id piped as `focusId` (manual override picker inside the panel) |
| `test/ui/colleague-panel.test.jsx` | (new) | Vitest under `test/ui/` (the second test tree — `ls test/` misses it): funnel states render per status payload; write-back chips (ok / landed-unrendered repair / failed retry); send disabled while pending |

### S4 — write-back (idempotent)

| File | Status | What |
|---|---|---|
| `server/maya-routes.js` | (S1 file) | After chat success with a focus record: reconcile-then-append — scan the record's discussion for the `message_id` marker; append via `addDiscussion(ctx, id, {author:'maya', text})` (`lib/fluid/ideabox-ops.js:463-…`, route precedent `server/ideabox-routes.js:199-204`) with the marker embedded (encoding decided here: trailing `\n\n<!-- maya:msg_<message_id> -->` HTML comment — invisible in rendered markdown, greppable, no schema change). Outcomes `ok | landed-unrendered | failed` per the partial-success distinction `ideabox-routes.js:80` |
| | | `POST /api/maya/writeback-retry {focusId, message_id, text}` — the retry-append-only endpoint; runs the same reconcile-then-append; never touches chat |
| `test/maya-routes.test.js` | (S1 file) | Write-back: dedup on retry after fake landed-then-failed; landed-unrendered surfaces; chat result authoritative when append fails |

### S5 — streaming (stretch, may ship as follow-up)

POST fetch-streaming on `/api/maya/message` (`?stream=1`): pipe upstream `POST /api/chat/stream`
SSE (`event: token|final|error`, envelope `maya.turn.*` — `web/src/lib/api.js:121-141`) through the
POST response body; after upstream `final`, relay performs write-back and emits terminal
`writeback` event. No EventSource, no `streamPaths`.

## Config & environment

```jsonc
// .compose/compose.json (dogfood config to be created — repo currently has NO maya/fluid/smartmemory blocks)
{
  "maya": { "baseUrl": "http://localhost:9005", "auth": { "mode": "provision" } },
  "smartmemory": { "baseUrl": "http://localhost:9001", "apiKeyEnv": "SM_FLUID_KEY", "enabled": true },
  "fluid": { "provider": "smartmemory", "smartmemory": { "workspaceId": "<compose fluid ws>" } }
}
```

- `data/maya-identity.json` — already covered: `.gitignore:3` blanket-ignores `data/`. No new entry.
- Ops note in `server/maya-routes.js` header: deployment must keep `MAYA_PROACTIVE_CHECK_INTERVAL_S=0`.
- Maya dev port is **9005** via `dev.sh`/Docker (raw process is 5001 — `maya/CLAUDE.md` dev-port note).

## Boundary Map

- `getMayaConfig` — kind: function — S1 — `lib/maya-config.js` — consumed by S1 routes, S3 hook (via status route)
- `provisionIdentity` — kind: function — S1 — `lib/maya-identity.js` — consumed by S1 client token flow
- `validateWorkspaceIsolation` — kind: function — S1 — `lib/maya-identity.js` — consumed by S1 status/config path
- `createMayaClient` — kind: function — S1 — `lib/maya-client.js` — consumed by S1 routes (from S1)
- `attachMayaRoutes` — kind: function — S1 — `server/maya-routes.js` — consumed by `server/vision-server.js` (from S1)
- `composeColleagueContext` — kind: function — S2 — `lib/colleague/context.js` — consumed by S1 route `POST /api/maya/message` (from S2)
- `contradictionsOf` — kind: function — S2 — `lib/fluid/ideabox-ops.js` — consumed by `composeColleagueContext` (from S2)
- `ColleaguePanel` — kind: component — S3 — `src/components/colleague/ColleaguePanel.jsx` — consumed by `src/App.jsx` (from S3)
- `useMayaStatus` — kind: hook — S3 — `src/components/colleague/useMayaStatus.js` — consumed by `ColleaguePanel` and the ViewTabs summon button (from S3)

(Untouched dependencies consumed: `addDiscussion`, `challengeIdea`, `convictionOf` — function,
`lib/fluid/ideabox-ops.js`; `CAP` — const, `lib/fluid/provider.js:53`; `ChatInput` / `MessageCard`
— component, `src/components/agent/`.)

## Corrections table

| # | Spec/exploration assumption | Reality | Status |
|---|---|---|---|
| C1 | Agent server on :3002 (compose skill text) | :4002 (`server/index.js:155`); ":3002" is a stale comment `server/agent-server.js:2` | Corrected — irrelevant to FOH-6 (no agent-server involvement) |
| C2 | "Add Maya routes to remote allowlist" (early draft) | Allowlist BYPASSES auth (`auth-middleware.js:192`) — routes stay gated | Corrected in design r1 |
| C3 | `channel_context` verified accepted | Static pydantic check only; live acceptance is VERIFY-2 | Open until stack up |
| C4 | Provision token carries workspace claim Maya honors | `team_id` returned; claim-extraction path is VERIFY-1 | Open until stack up |

## Phase 5 verification — DONE 2026-08-11

**Boundary Map:** `validateBoundaryMap` → ok, 0 violations, 0 warnings.

**File:line sweep (34 refs, both repos):** 27 VERIFIED exactly; 5 STALE off-by-lines; 1 named
anchor nonexistent; 1 path-form fix. **All corrections applied inline above** in the same edit
session (per docs rules). Summary of what changed:

| Ref | Was | Corrected to |
|---|---|---|
| auth bypass check | `auth-middleware.js:192` (function sig) | `:196` (`if (_allowed(path)) return next();`) |
| MessageCard/ChatInput | `AgentStream.jsx:4, 688` | imports `:3-4`; usage MessageCard `:590`, ChatInput `:688` |
| Summon-button anchor | "right of `tab-spacer`" | no such selector — unnamed `<div className="flex-1" />` at `ViewTabs.jsx:73`; button gets its own class |
| channel_context token cap | `llm_manager.py:501-506` | `:493-498` (`max_tokens=CHANNEL_CONTEXT_MAX_TOKENS`) |
| gitignore step | add `data/maya-identity.json` | no-op — `.gitignore:3` blanket-ignores `data/` |
| stale-port comment | `agent-server.js:2` | `server/agent-server.js:2` |

Every load-bearing Maya contract claim verified exactly: `/api/chat` `:5354`, `ChatRequest`
`:3230-3246` (channel_context accepted on input `:3241`), `ChatResponse` `:3383-3401`
(`message_id` present), consumption `:4090/:4482/:714-754`, workspace-claim extraction
`client.py:73-83`, session-per-identity `session_registry.py:486-527`.

Note: `data/design-sessions.json` does not exist on disk yet (created on first design session) —
the S1 identity-store precedent claim is about the `data/` tier, which holds.

**VERIFY-1/2/3 (live stack):** see ledger — run against the running local stack before implement.
