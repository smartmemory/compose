# Compose UI — End-to-End Test Checklist

Manual smoke checklist for verifying every major UI surface end-to-end. Run before a release, after a large refactor, or when promoting work that touches the cockpit shell, real-time pipeline, or vision store. Estimated time: ~30 min for the full pass.

Each step lists the **action**, the **expected result**, and any **APIs/files involved** so failures map directly to the right layer.

---

## 0. Pre-flight

| # | Action | Expected |
|---|---|---|
| 0.1 | `cd compose && npm run dev` | Supervisor reports `api-server`, `agent-server`, `vite` all up |
| 0.2 | `curl -sf http://127.0.0.1:3001/` | 404 (server alive, no root route) |
| 0.3 | `lsof -nP -iTCP:3001 -sTCP:LISTEN` and `:4002`, `:5195` | All three ports bound |
| 0.4 | Open `http://localhost:5195/` | Cockpit shell renders: header (Compose logo + ViewTabs + controls), sidebar, main view, no console errors |
| 0.5 | Devtools → Network → WS | `ws://localhost:3001/ws/vision` and `ws://localhost:3001/ws/files` connect; status `101 Switching Protocols` |

If any of 0.1–0.5 fails, stop and fix before continuing — every later step assumes a healthy shell.

---

## 1. ViewTabs — main views

The 9 default tabs are: `dashboard`, `graph`, `tree`, `docs`, `design`, `gates`, `pipeline`, `sessions`, `ideabox`. Click each; verify it renders without errors.

### 1.1 Dashboard
- [ ] Click **Dashboard** tab → `DashboardView` renders status band, drift ribbon, decision timeline strip
- [ ] Status band shows a one-sentence rollup; click expands a panel
- [ ] Drift ribbon shows three axes (path/contract/review-debt) with hardcoded thresholds
- [ ] Decision timeline strip is horizontally scrollable (72px tall)

### 1.2 Graph
- [ ] Click **Graph** tab → `GraphView` renders. Items appear as nodes; connections as edges
- [ ] Node click → context panel opens on the right with item detail
- [ ] Drag a node → position persists across reload (PATCH `/api/vision/items/:id` with `position`)

### 1.3 Tree
- [ ] Click **Tree** tab → hierarchical view of features → phases → tasks
- [ ] Expand/collapse nodes; expansion state persists in localStorage

### 1.4 Docs
- [ ] Click **Docs** tab → `DocsView` lists feature folders under `docs/features/`
- [ ] Select one → renders its `design.md`/`prd.md`/`blueprint.md` with markdown formatting
- [ ] Mermaid diagrams (if any) render inline

### 1.5 Design
- [ ] Click **Design** tab → `DesignView` shows DesignSidebar + active session
- [ ] Decision cards render with Confidence dots
- [ ] Add a new decision → optimistic UI update + persisted to `.compose/data/`

### 1.6 Gates
- [ ] Click **Gates** tab → `GateView` lists pending gates from `get_pending_gates`
- [ ] Approve a gate → status flips, `GateToast` appears, gate disappears from pending list
- [ ] Approval is persisted in `gate-log-store`

### 1.7 Pipeline
- [ ] Click **Pipeline** tab → `PipelineView` shows the active build/flow
- [ ] If a build is running: agent stream, step list, decision events stream
- [ ] If idle: empty state with "no active pipeline"

### 1.8 Sessions
- [ ] Click **Sessions** tab → `SessionsView` lists Claude Code sessions
- [ ] Each row shows tool count, items touched, error count, Haiku summary

### 1.9 Ideabox
- [ ] Click **Ideabox** tab → `IdeaboxView` renders matrix + triage + analytics
- [ ] Add an idea via input → appears in matrix
- [ ] Promote an idea → `IdeaboxPromoteDialog` opens, dispatches to roadmap

---

## 2. Cross-cutting interactions

### 2.1 Command Palette (Cmd+K / Ctrl+K)
- [ ] Press `Cmd+K` (or click the search button on ViewTabs) → palette opens
- [ ] Type a feature code (e.g. `STRAT-PAR`) → fuzzy results across items, gates, sessions
- [ ] Select a result → navigates and opens context panel
- [ ] `Esc` closes palette

### 2.2 Sidebar — Attention Queue
- [ ] AttentionQueueSidebar lists items needing attention (blocked, gated, stale)
- [ ] Click an item → opens context panel with detail
- [ ] Items reorder live as state changes (WS-driven)

### 2.3 Context Panel
- [ ] Trigger from any view (item click) → right-side panel slides in
- [ ] Tabs work: detail, files, sessions, research, errors, branch-compare
- [ ] Close button + Esc dismiss it; remembers last-opened item per view

### 2.4 Open Loops Panel
- [ ] Region ④ visible (320px right panel) — open loops listed with UUID v4 ids
- [ ] Add a loop via `compose loops` CLI → appears within 1s in panel (WS event)
- [ ] Close a loop → strikes through, archives to history

### 2.5 Decision Timeline Strip
- [ ] Region ② full-width (72px) — events render left-to-right, newest right
- [ ] Hover an event → tooltip with event detail
- [ ] Click an event → opens step detail surface

---

## 3. Real-time resilience

### 3.1 WebSocket reconnect
- [ ] In devtools, throttle network to "Offline" → WS disconnects, banner appears
- [ ] Restore network → WS reconnects automatically; client hydration request fires (`COMP-RT-2`)
- [ ] No duplicate events; no stale state in any view

### 3.2 Multi-tab sync
- [ ] Open the cockpit in two browser tabs
- [ ] Make a change in tab A (e.g. drag a node, approve a gate)
- [ ] Tab B reflects the change within 1s (broadcast via `vision-server.js`)

### 3.3 Event coalescing
- [ ] Trigger a burst (`compose start` on a small feature, or rapid agent activity)
- [ ] Network panel shows batched WS frames, not one frame per event (`COMP-RT-1`)
- [ ] UI does not jank or drop frames

### 3.4 File watcher
- [ ] Edit a file in `docs/features/<any>/` from a terminal (e.g. `touch docs/features/FEAT-1/test`)
- [ ] DocsView updates without reload (file-watcher WS at `/ws/files`)

---

## 4. Build / lifecycle flow

Runs the actual Compose pipeline through the UI to verify CLI ↔ server ↔ UI integration.

### 4.1 Start a build
- [ ] In a separate terminal: `compose start <some-test-feature>`
- [ ] AgentBar (top-of-cockpit) lights up with status
- [ ] PipelineView populates with steps
- [ ] Decision Timeline shows entries as steps complete

### 4.2 Parallel dispatch (STRAT-PAR-6 progress UI)
- [ ] If pipeline hits a `parallel_dispatch` step: AgentBar shows `‖ N/M tasks` progress bar with active/failed counts
- [ ] Bar fills as tasks complete; turns red on failure
- [ ] Click bar → opens parallel task list

### 4.3 Gate resolution from UI
- [ ] Build halts at a gate → GateToast appears
- [ ] Click toast → opens GateView with the pending gate
- [ ] Approve from UI → CLI build resumes (verify via terminal output and `STRAT-COMP-6`)

### 4.4 Stratum panel
- [ ] Open StratumPanel (or Stratum view if present) → shows active flow_id, current step, retries, ensure violations
- [ ] After flow completes: audit trace viewable; bound to vision item

---

## 5. Settings & admin

### 5.1 Settings panel
- [ ] Open settings (gear icon or `/settings` route)
- [ ] Toggle a policy dial (gate/flag/skip) → persists to `.compose/data/settings.json`
- [ ] Capability enforcement integration test: change `block`-mode setting, retry a build that violates → enforced

### 5.2 Project root
- [ ] `compose doctor --json` → reports correct project root and target dir
- [ ] If two trackers exist (parent vs subproject), the cockpit's bound one is unambiguous in the UI header

---

## 6. Browser smoke (different browsers / windows)

- [ ] Chrome — full pass
- [ ] Safari — render + WS work; CSS tokens consistent
- [ ] Mobile viewport (devtools → 375px) — sidebar collapses, ViewTabs scroll horizontally, no overflow

---

## 7. Final teardown

- [ ] Stop dev server (`Ctrl+C` in supervisor terminal)
- [ ] No orphan processes on `:3001`, `:4002`, `:5195`
- [ ] `.compose/data/vision-state.json` consistent (no truncation, valid JSON)

---

## Failure triage

| Symptom | Likely layer |
|---|---|
| View renders blank, no console errors | React component error boundary swallowed — check `error-boundary` zones |
| Console: `Failed to fetch /api/vision/...` | API server (`server/index.js`, `vision-routes.js`) not bound to expected port |
| WS connects then disconnects immediately | Auth token mismatch — check `COMPOSE_API_TOKEN` in supervisor env |
| Gate approval doesn't propagate to CLI | Flow not bound to vision item — check `POST /api/stratum/bind` in Phase 9 |
| Item updates show in one tab not another | Broadcast missing — check `vision-server.js` WS broadcast path |
| Parallel progress bar stuck at 0/N | `build-stream-bridge.js` not passing `parallel` flag — see `AgentBar.jsx:37–147` |

---

## Coverage note

This checklist covers **manual** flows. Automated coverage lives in:
- `compose/test/*.test.js` — Node integration tests (settings-e2e, build-stream-smoke, vision)
- `compose/src/**/*.test.{js,jsx}` — component unit tests
- `compose/test/playwright/` *(if/when introduced)* — browser-driven E2E

If this checklist surfaces a regression that should be caught automatically, add a Playwright spec rather than just fixing the bug.
