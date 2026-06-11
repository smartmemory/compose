# COMP-MOBILE-1 — Implementation Blueprint

> **Status: BLUEPRINT — Phase 4 artifact. Implements `design.md` (approved 2026-06-11).**

**Related Documents**
- Back: `design.md` (Phase 1, approved through 3-round Codex gate)
- Forward: implementation slices S01–S03 (Phase 7)

## Verified code reality (read 2026-06-11)

### Shell & nav
- `src/mobile/MobileApp.jsx` — shell; tabs rendered at :75-78, `BottomNav` at :88 with `active`/`onSelect` only. Header at :82-84 — alert bar mounts after it.
- `src/mobile/components/BottomNav.jsx` (31 LOC) — 4-item button grid, `data-testid="mobile-nav-<id>"`, `aria-pressed`. No badge support.

### Hooks (current state)
- `src/mobile/hooks/useActiveBuild.js` — `apiJSON` helper wraps `wsFetch` (:9-18 pattern in usePendingGates; useActiveBuild has its own), `GET /api/build/state` refetch (:40-50), raw-WebSocket `/ws/vision` listener refetching on `buildState` (:62-102), returns `{ active, loading, error, refetch, startBuild, abortBuild }` (:126). `startBuild`/`abortBuild` send `withComposeToken()`.
- `src/mobile/hooks/usePendingGates.js` — `GET /api/vision/gates` (:28), raw-WebSocket listener refetching on `gateCreated|gateResolved|gateUpdated` (:65-67), `resolve()` POST (:100). Returns `{ gates, loading, error, refetch, resolve }` (:109).
- `src/mobile/hooks/useRoadmapItems.js` — uses `createReconnectingWS` from `src/lib/wsReconnect.js` (:17, :53). **WS handler at :63-79 listens for `itemUpdated`/`itemCreated`/`itemDeleted`/`state`/`visionUpdated`/`roadmapUpdated` — none of which the server broadcasts** (server emits `visionState`/`hydrate` snapshots — `server/vision-server.js:69`, `:412`). Live updates are dead code; HTTP refetch (:32-48) is what works. PATCH at :103-107 sends bare `Content-Type` (no token). `applyOptimisticEdit` (:93-124) is the rollback pattern to extend.

### Tabs (hook call sites to lift)
- `src/mobile/tabs/AgentsTab.jsx:13` — `usePendingGates()` call; gates UI at :51-64, `GatePromptSheet` at :70-75.
- `src/mobile/tabs/BuildsTab.jsx:13` — `useActiveBuild()` call; `isTerminal()` helper :8-10; `BuildDetailView` at :100-106.
- `src/mobile/tabs/RoadmapTab.jsx:26` — `useRoadmapItems()` call; `handleSave` :54-61; `ItemDetailSheet` at :99-105.

### Components to extend
- `src/mobile/components/ItemDetailSheet.jsx` (150 LOC) — controlled form (status :86-99, group :101-111, confidence :113-126), `dirty` calc :36-40, footer buttons :128-146. Mutates via `onSave(item.id, patch)` only.
- `src/mobile/components/BuildDetailView.jsx` (89 LOC) — header :47-73 (abort/close), raw SSE log :75-84 via `useAgentStream({ agentId: active?.flowId })` (:20). No step breakdown.
- `src/mobile/components/CaptureSheet.jsx` (198 LOC) — bottom-sheet form pattern for CreateItemSheet.
- `src/mobile/components/Toast.jsx` (15 LOC) — transient toast; **not** a substitute for the sticky alert bar.

### Desktop sources to extract/share
- `src/components/vision/constants.js:89-114` — `PIPELINE_STEPS` (24 steps; fields `id`, `name`, `agent`, `phase`, `hasGate`).
- **Active-step caveat:** `active-build.json` `steps[]` only carries *completed* step history (`lib/build.js:4293-4307`); the currently running step exists solely as `currentStepId`. Desktop keeps `currentStepId` separate and applies it at render (`PipelineView.jsx:182`, `:261`). The shared helper therefore takes it explicitly: `mergePipelineSteps(template, liveSteps, currentStepId)` marks the matching merged step `status: 'active'` when it has no terminal live status.
- `src/components/vision/PipelineView.jsx:178-199` — merge block: `liveStatusMap` (:179-181), `liveStepMap` right-spread merge (:185-191), dynamic-step append (:193-199).
- `src/components/vision/graphOpsOverlays.js:58-80` — `computeBuildStateMap`: failed → error (:67-68); gate-pending derivation = `status === 'running'` + `currentStepId.endsWith('_gate')` + unresolved gate for the feature's item (:70-79).
- `src/components/cockpit/NotificationBar.jsx:81-89` — `notify(message, level, ttl)` dispatches `compose:notify` CustomEvent; listener contract `{ message, level, ttl }` (:29).

### Server contracts (verified)
- `GET /api/builds?limit=N` — `server/build-routes.js:28`; returns `{ builds: [...] }`, records from `lib/build-history.js:41` `readBuildHistory` (most-recent-first). Record fields (writer `lib/build.js:2015-2029`): `featureCode`, `flowId`, `mode`, `status`, `startedAt`, `completedAt`, `durationMs`, `cost_usd`, `input_tokens`, `output_tokens`, `stepCount`, `failureReason`, `itemId`. **No steps[].**
- Health-gate downgrade: history appended at `lib/build.js:2010-2030` *after* the health gate may set `buildStatus = 'failed'`; the earlier `active-build.json` terminal write (→ `buildState` WS) can say `complete`. Corrective alert keyed by `flowId`.
- `POST /api/vision/items` — `server/vision-routes.js:91` (guardAuth); requires valid `type` (`VALID_TYPES`, vision-store.js:10).
- `DELETE /api/vision/items/:id` — vision-routes.js:123 (guardAuth) → `{ ok: true }`.
- `GET /api/vision/items/:id` — vision-routes.js:156 → item + `connections[]`.
- `POST /api/vision/connections` — vision-routes.js:134; body `{ fromId, toId, type }`, `type` ∈ `VALID_CONNECTION_TYPES = ['informs','blocks','supports','contradicts','implements']` (vision-store.js:12, :297). No label.
- `DELETE /api/vision/connections/:id` — vision-routes.js:145 → `{ ok: true }`.
- WS `gateCreated` payload `{ type, gateId, itemId, timestamp }` — vision-routes.js:813.

### AGENT_PORT duplication sites (D5)
- `src/mobile/components/AgentCard.jsx:5-10` (used :39)
- `src/mobile/components/AgentDetailView.jsx:6-10` (used :36)
- `src/mobile/hooks/useInteractiveSession.js:14-20` (used :23, :47)
- Canonical helper: `src/lib/agentServer.js:14-19` `agentServerUrl(path)` — identical URL construction (protocol + hostname + port + path).

## Corrections table (spec assumption vs reality)

| # | Design/spec assumption | Reality | Resolution |
|---|---|---|---|
| 1 | Step-input text says history backed by `GET /api/session/history` | Per-feature only; design already corrected to `GET /api/builds` | Blueprint follows design (D3) |
| 2 | `useInteractiveSession.js:14` declares AGENT_PORT at :14 with helper :17-20 | Confirmed; helper spans :17-20, fetch call sites :23, :47 | As planned |
| 3 | Design: `agentUrl()` in AgentCard spans :7-10 | Confirmed :7-10, call site :39 | As planned |
| 4 | Design: BottomNav 32 LOC | 31 LOC; structure as described | Trivial |
| 5 | Design: useActiveBuild polls | It does NOT poll on interval — initial fetch + WS-triggered refetch only (:50-58, :62-102) | Badge state still correct; no poller dedup concern beyond WS connections |
| 6 | Design: BuildsTab `isTerminal` includes `'complete'` | BuildsTab :8-10 checks `'completed'`,`'aborted'`,`'failed'`,`'done'` — **not** `'complete'`, while desktop/health writer uses `'complete'` (lib/build.js:2010) | Shared lib exports `isTerminalBuildStatus()` covering both spellings; mobile call sites switch to it |

## File Plan

| File | Action | Slice | What |
|---|---|---|---|
| `src/lib/pipeline-steps.js` | new | S01 | Shared: `PIPELINE_STEPS` (moved), `mergePipelineSteps(template, liveSteps, currentStepId)`, `isGatePending(activeBuild, gates, items)`, `isTerminalBuildStatus(status)` |
| `src/components/vision/constants.js` | edit | S01 | `PIPELINE_STEPS` re-exported from `src/lib/pipeline-steps.js` (back-compat) |
| `src/components/vision/PipelineView.jsx` | edit | S01 | Replace inline merge block :178-199 with `mergePipelineSteps()` call |
| `src/mobile/components/AgentCard.jsx` | edit | S01 | Drop :5-10, import `agentServerUrl` |
| `src/mobile/components/AgentDetailView.jsx` | edit | S01 | Drop :6-10, import `agentServerUrl` |
| `src/mobile/hooks/useInteractiveSession.js` | edit | S01 | Drop :14-20, import `agentServerUrl` |
| `src/mobile/hooks/useRoadmapItems.js` | edit | S01 | WS rewire: handle `visionState`/`hydrate` (replace items wholesale, re-apply in-flight optimistic edits via pending-ops ref); keep legacy granular types; PATCH gains `withComposeToken()` |
| `src/mobile/MobileApp.jsx` | edit | S01 | Lift `usePendingGates`+`useActiveBuild`+`useRoadmapItems`; render `MobileAlertBar`; `useMonitorEvents`; pass `badges` to BottomNav; pass hook values to tabs |
| `src/mobile/components/BottomNav.jsx` | edit | S01 | Optional `badges` prop → pill/dot per tab, `data-testid="mobile-nav-badge-<tab>"` |
| `src/mobile/components/MobileAlertBar.jsx` | new | S01 | Sticky alert strip; listens `compose:notify`; tap → navigate+dismiss |
| `src/mobile/hooks/useMonitorEvents.js` | new | S01 | WS-transition → `notify()` mapping (gateCreated, buildState transitions, per-flowId prev-status ref) |
| `src/mobile/tabs/AgentsTab.jsx` | edit | S01 | Accept gates via props (hook call removed) |
| `src/mobile/tabs/BuildsTab.jsx` | edit | S01 | Accept build state via props; `isTerminal` → shared `isTerminalBuildStatus` |
| `src/mobile/tabs/RoadmapTab.jsx` | edit | S01 | Accept items state via props |
| `src/mobile/components/BuildStepsList.jsx` | new | S02 | Vertical merged-step list; collapse done-runs; failed-step emphasis |
| `src/mobile/components/BuildDetailView.jsx` | edit | S02 | Steps section above log; log toggle preserved |
| `src/mobile/hooks/useBuildHistory.js` | new | S02 | `GET /api/builds?limit=20`; terminal-WS refetch + 2.5s flowId-matched retry; corrective health-gate alert via `notify()` |
| `src/mobile/components/BuildHistoryList.jsx` | new | S02 | History rows; inline expand to full summary |
| `src/mobile/components/CreateItemSheet.jsx` | new | S03 | Create form (CaptureSheet pattern); `type:'feature'` fixed |
| `src/mobile/components/ItemDetailSheet.jsx` | edit | S03 | Delete (two-tap confirm) + Connections section (lazy detail fetch, add via picker + type selector, remove with confirm) |
| `src/mobile/hooks/useRoadmapItems.js` | edit | S03 | `createItem`, `deleteItem` (`applyOptimisticRemove`), `addConnection`, `removeConnection` — all via `withComposeToken()` |
| `src/mobile/tabs/RoadmapTab.jsx` | edit | S03 | FAB (+) wiring CreateItemSheet |
| `src/mobile/mobile.css` | edit | S01-S03 | Badge, alert bar, steps list, history, FAB, connections styles |
| `test/ui/mobile-notifications.test.jsx` | new | S01 | Badges, alert bar, monitor-event mapping, WS rewire |
| `test/ui/pipeline-steps.test.js` | new | S01 | merge/gate-pending/terminal helpers incl. desktop-parity cases |
| `test/ui/mobile-builds.test.jsx` | edit | S02 | Steps list, history list, corrective alert, prop-driven tab |
| `test/ui/mobile-roadmap.test.jsx` | edit | S03 | Create/delete/connections flows, token header assertions |
| `test/ui/mobile-agents.test.jsx` | edit | S01 | Prop-driven gates update |
| `test/ui/mobile-app.test.jsx` | edit | S01 | Shell renders alert bar + badges |

## Boundary Map

### S01: shared lib + shell monitoring (hygiene, badges, alert bar)
Produces:
  src/lib/pipeline-steps.js → PIPELINE_STEPS, mergePipelineSteps, isGatePending, isTerminalBuildStatus (function)
  src/mobile/components/MobileAlertBar.jsx → MobileAlertBar (component)
  src/mobile/hooks/useMonitorEvents.js → useMonitorEvents (hook)
  src/mobile/components/BottomNav.jsx → BottomNav (component)
  src/mobile/hooks/useRoadmapItems.js → useRoadmapItems (hook)

Consumes: nothing (leaf node)

### S02: build steps + history
Produces:
  src/mobile/components/BuildStepsList.jsx → BuildStepsList (component)
  src/mobile/hooks/useBuildHistory.js → useBuildHistory (hook)
  src/mobile/components/BuildHistoryList.jsx → BuildHistoryList (component)

Consumes:
  from S01: src/lib/pipeline-steps.js → PIPELINE_STEPS, mergePipelineSteps, isTerminalBuildStatus

### S03: roadmap mutations
Produces:
  src/mobile/components/CreateItemSheet.jsx → CreateItemSheet (component)

Consumes:
  from S01: src/mobile/hooks/useRoadmapItems.js → useRoadmapItems

## Implementation notes per slice

### S01 (order matters within slice)
1. `src/lib/pipeline-steps.js` first: move `PIPELINE_STEPS` verbatim; `mergePipelineSteps(template, liveSteps, currentStepId)` is the PipelineView :178-199 block as a pure function — **returns the merged `Step[]` array directly**, with each step's final `status` already applied (live status wins; the `currentStepId` step gets `status: 'active'` when it has no terminal live status; otherwise template steps have `status: undefined` = pending). Desktop PipelineView keeps using its own `currentStepId` for the connector/label rendering but takes the merged array from the helper. `isGatePending(activeBuild, gates, items)` ports graphOpsOverlays.js:70-79 predicate (running + `_gate` suffix + unresolved gate matching the feature's item); `isTerminalBuildStatus` = `['complete','completed','aborted','failed','killed','done']`.
2. Desktop swap: `constants.js` re-export + PipelineView calls the lib. `npm run build` smoke after (incremental-builds rule).
3. AGENT_PORT swaps (3 files) — pure import change, identical output URLs.
4. `useRoadmapItems` WS rewire: on `visionState`/`hydrate` with `Array.isArray(msg.items)` → replace items, then re-apply any pending optimistic ops (ref-tracked set of `{id, patch}` cleared on settle); keep existing granular handlers.
5. Shell lift: tabs receive hook values as props. Tab components keep identical testids so existing tests need only harness-level prop changes.
6. `useMonitorEvents(activeBuild, gates, items)`: effect comparing previous build status per `flowId` (ref Map); `gateCreated` arrives via the gates list change (usePendingGates refetch) or direct WS — use the already-lifted hooks' data, not a 4th WS connection: gate alert fires when a new gate id appears in `gates`; build alerts fire on status transition of `active`.
7. Badges: `agents: { count: gates.length }`; `builds`: error dot if `active?.status === 'failed'`, warn dot if `isGatePending(active, gates, items)`.

### S02
- `BuildStepsList({ active })`: `mergePipelineSteps(PIPELINE_STEPS, active?.steps, active?.currentStepId)`; group headers by `phase`; runs of `done` collapse to a single "N done ✓" row (expand on tap); failed row shows `failureReason`-style summary if the step object carries one. The active step comes from `currentStepId` (see active-step caveat above), never from `steps[]` membership.
- `useBuildHistory`: refetch on `isTerminalBuildStatus(active?.status)` transition (observe via the lifted `active` prop — no own WS); if `active.flowId` not in fetched list → one retry after 2.5s; on settled entry whose `status` mismatches last-alerted status for that `flowId` → `notify('Build failed post-checks: <code>', 'error', sticky)`.
- `BuildDetailView` gains tabs-in-view: "Steps" (default) / "Log" toggle; historical variant not needed (history rows expand inline in the list — no detail overlay).

### S03
- **Contract alignment (pre-existing bugs fixed in this slice):** `ItemDetailSheet.jsx:4-13` offers `'partial'`, which the server rejects — valid statuses are `planned|ready|in_progress|review|complete|blocked|parked|killed|superseded` (`vision-store.js:11`, validated at `:198`); and the confidence field says 0–5 (`ItemDetailSheet.jsx:114-126`) while the server validates **0–4** (`vision-store.js:159`, `:201`). S03 replaces `STATUS_OPTIONS` with the server's `VALID_STATUSES` list (add `ready`/`review`, drop `partial`) and fixes the confidence label/max to 0–4 in both ItemDetailSheet and CreateItemSheet.
- `useRoadmapItems` additions: `createItem(fields)` POST + optimistic prepend (temp id swapped on response); `deleteItem(id)` optimistic remove + rollback; `addConnection(fromId, toId, type)`, `removeConnection(connId)` — connections are fetched lazily by ItemDetailSheet via `GET /api/vision/items/:id` (kept in sheet-local state, not the hook).
- All mutations: `headers: withComposeToken({ 'Content-Type': 'application/json' })`.
- ItemDetailSheet delete: `deleteArmed` state, second tap calls `onDelete(item.id)`; disarm on 3s timer or any other interaction.
- Connection picker: filtered list from `items` prop (search input), type `<select>` of the 5 valid types, default `informs`.

## Verification Table (Phase 5)

| Ref | Claim | Verified |
|---|---|---|
| MobileApp.jsx:75-78, :82-84, :88 | tab render, header, BottomNav props | ✅ read this session |
| BottomNav.jsx (31 LOC, testids, aria-pressed) | structure | ✅ read this session |
| useActiveBuild.js :40-50, :62-102, :126 | refetch/WS/returns; no interval poll | ✅ read this session (correction #5) |
| usePendingGates.js :28, :65-67, :100, :109 | endpoints, WS types, resolve, returns | ✅ read this session |
| useRoadmapItems.js :17, :53, :63-79, :103-107, :93-124 | WS lib, dead message types, bare PATCH headers, optimistic pattern | ✅ read this session |
| AgentsTab.jsx:13, :51-64, :70-75 | hook call site, gates UI | ✅ read this session |
| BuildsTab.jsx:8-10, :13, :100-106 | isTerminal spellings, hook call, detail view | ✅ read this session (correction #6) |
| RoadmapTab.jsx:26, :54-61, :99-105 | hook call, save handler, sheet | ✅ read this session |
| ItemDetailSheet.jsx :36-40, :86-126, :128-146 | dirty calc, form fields, footer | ✅ read this session |
| BuildDetailView.jsx :20, :47-73, :75-84 | agentStream usage, header, log | ✅ read this session |
| constants.js:89-114 PIPELINE_STEPS | 24 steps, 5 fields | ✅ read this session (count corrected by Codex BP review) |
| lib/build.js:4293-4307 | steps[] = completed history only; running step = currentStepId | ✅ Codex BP review, line-cited |
| vision-store.js:11,:159,:198,:201 | VALID_STATUSES (no 'partial'), confidence 0–4 | ✅ Codex BP review, line-cited |
| PipelineView.jsx:178-199 merge block | liveStatusMap/liveStepMap/dynamic append | ✅ read this session |
| graphOpsOverlays.js:58-80 | gate-pending derivation | ✅ read this session |
| NotificationBar.jsx:81-89, :29 | notify() + event contract | ✅ via explorer + design gate (Codex verified) |
| build-routes.js:28; build-history.js:41; build.js:2010-2030 | history endpoint, record fields incl. flowId, health-gate ordering | ✅ read this session |
| vision-routes.js:91, :123, :134, :145, :156, :813 | mutation routes, gateCreated payload | ✅ via endpoint explorer + Codex design gate (3 rounds, line-cited) |
| vision-store.js:10, :12, :294-310 | VALID_TYPES, VALID_CONNECTION_TYPES, createConnection | ✅ read this session |
| agentServer.js:14-19; AgentCard.jsx:5-10,:39; AgentDetailView.jsx:6-10,:36; useInteractiveSession.js:14-20,:23,:47 | duplication sites + canonical helper | ✅ read this session |
| Boundary Map | validateBoundaryMap run | ✅ see gate note below |
