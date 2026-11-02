<!-- CANONICAL copy, backed up in git (compose repo). Working copy that Compose tools read and edit: forge/ROADMAP-ARCHIVE.md; copy it here and commit after every edit there. Relative links below resolve from forge/, not from this folder. 2026-11-02, D-0019 backup. -->
# Forge Roadmap — Archive

**Historical record of completed, superseded, parked, and deferred work.** Active and planned items live in [ROADMAP.md](ROADMAP.md).

**Latest archive update:** [2026-09-09](#archive-update-2026-09-09). Older sections below are preserved snapshots, including historical planned statuses; they are not the current work queue.

**Archived:** 2026-04-11

---

## Roadmap Conventions

- **Status:** `PLANNED` | `IN_PROGRESS` | `PARTIAL` | `COMPLETE` | `SUPERSEDED` | `PARKED`
- **Phases** are sequential. **Half-phases** (e.g. 4.5) are parallel tracks that surface between sequential phases.
- Items are numbered sequentially across all phases — never reuse a number.
- Cross-reference stable IDs (e.g. `Phase 3`, item 18) not section headings.

---

## Phase 0: Bootstrap — COMPLETE

Manual, out-of-band. None of this is tracked in Compose itself.

| # | Item | Status |
|---|------|--------|
| — | Discovery, requirements, PRD, UI-BRIEF | COMPLETE |
| — | External UI build (Base44) + gap evaluation | COMPLETE |
| — | Terminal embed: xterm.js + WebSocket + node-pty | COMPLETE |
| — | Process supervisor with auto-restart | COMPLETE |
| — | First boot crash analysis and resilience fixes | COMPLETE |

**Exit:** Claude Code runs in the embedded terminal and survives server restarts.

---

## Phase 1: Vision Surface — COMPLETE

Make the agent's work visible. Compose can see what's happening without the human watching the terminal.

| # | Item | Status |
|---|------|--------|
| 1 | Vision tracker: item CRUD with phase/type/status/confidence | COMPLETE |
| 2 | Connection graph: blocks, informs, supports, implements, contradicts | COMPLETE |
| 3 | 7 views: Roadmap, List, Board, Tree, Graph, Docs, Attention | COMPLETE |
| 4 | WebSocket broadcast: real-time state sync to all clients | COMPLETE |
| 5 | File-based persistence: `data/vision-state.json`, reload on restart | COMPLETE |
| 6 | Snapshot API: browser-side state captured via WS request/response | COMPLETE |

**Exit:** The Vision Surface tracks items, renders 7 views, and updates in real time.

---

## Phase 2: Agent Awareness (Read-Only) — COMPLETE

Compose observes what the agent is doing without the human watching the terminal.

| # | Item | Status |
|---|------|--------|
| 7 | Activity hooks: tool-use events POSTed to `/api/agent/activity` | COMPLETE |
| 8 | File-path resolution: map tool events to tracker items | COMPLETE |
| 9 | Auto-status promotion: Write/Edit on planned items → in_progress | COMPLETE |
| 10 | Error detection: pattern-match tool responses, broadcast `agentError` | COMPLETE |
| 11 | Activity feed in sidebar: live tool-use stream with category pills | COMPLETE |

**Exit:** Compose surfaces agent activity and errors in the Vision Surface without the human watching the terminal.

---

## Phase 3: Session Tracking — COMPLETE

Sessions accumulate context across tool uses. Compose builds a record of each working session.

| # | Item | Status |
|---|------|--------|
| 12 | Session lifecycle: start/end with source, reason, transcript path | COMPLETE |
| 13 | Per-item accumulator: reads, writes, first/last touched per tracker item | COMPLETE |
| 14 | Work block detection: group tool events by resolved item set | COMPLETE |
| 15 | Block classification: building / debugging / testing / exploring / thinking | COMPLETE |
| 16 | Haiku summarization: batch significant events → background LLM summary | COMPLETE |
| 17 | Session persistence: append-only `data/sessions.json`, reload last on startup | COMPLETE |

**Exit:** Sessions accumulate per-item stats and LLM summaries; each session persists to disk.

---

## Phase 4: Agent Connector (Read-Write) — COMPLETE

Compose can direct agents, not just observe them. Connectors route prompts to Claude or Codex via MCP.

| # | Item | Status |
|---|------|--------|
| 18a | Connector class hierarchy: AgentConnector → ClaudeSDKConnector, OpencodeConnector → CodexConnector | COMPLETE |
| 18b | `agent_run` MCP tool (stdio transport): routes to claude or codex | COMPLETE |
| 18c | `review-fix.stratum.yaml`: two-phase execute → fix/review pipeline | COMPLETE |
| 18d | UI decoupling verified: zero new HTTP/WS surface added | COMPLETE |
| 18e | Server modularization: no file in `server/` over ~300 lines | COMPLETE |
| 18f | Regression tests: connectors, server pure functions, activity routes (69/69) | COMPLETE |
| 18g | Dead code removal: `openai` and `gray-matter` deps removed | COMPLETE |
| 18h | Acceptance gate: end-to-end pipeline with live inference backends | COMPLETE (passed per commit 37acf7c) |

**Exit:** Claude Code can call `agent_run` to dispatch work to Claude or Codex and run the review-fix pipeline.
See `docs/plans/2026-03-05-18h-acceptance-gate.md` for the acceptance test checklist.

---

## Phase 4.5 Support: Stratum Sync + Feature Scan — COMPLETE

Infrastructure that landed alongside Phase 4 connector work.

| # | Item | Status |
|---|------|--------|
| — | Feature scan: seed tracker from `docs/features/` folders (replaced speckit) | COMPLETE |
| — | Stratum sync: poll `~/.stratum/flows/`, sync flow status → item status | COMPLETE |
| — | Stratum bind/audit routes: link flows to items, store audit traces | COMPLETE |
| — | compose-mcp: 5 MCP tools for querying Vision Surface state | COMPLETE |

---

## Phase 5: Standalone App — SUPERSEDED by STRAT-1

Packaging is now part of STRAT-1. `pip install compose` replaces `npm install -g compose`.
UI installation is handled by `compose init` questionnaire.

---

## Phase 6: Lifecycle Engine — COMPLETE

Compose's lifecycle layers (L0–L6) are built and working. The process primitives
(gates, policy, skip, rounds) currently live in Compose. STRAT-1 moves them to Stratum
and makes Compose a thin workflow layer.

### Phase 6 Layers (Compose-internal, all COMPLETE)

| # | Layer | Status |
|---|-------|--------|
| 21 | **L0 — User Preferences Inventory:** full preferences system — `data/settings.json`, REST API (`GET/PATCH /api/settings`, `POST /api/settings/reset`), WS broadcast, Settings panel in sidebar. Policy engine + lifecycle manager use settings as middle fallback. Agent server reads model from disk. | COMPLETE |
| 22 | **L1 — Feature Lifecycle State Machine:** `contracts/lifecycle.json` (single source of truth); `lifecycle-constants.js` derives all exports; `policy-engine.js` validates against contract; `compose_feature.stratum.yaml` generated from contract with compound steps for revision loops; 28 contract parity tests; `currentPhase` + `phaseHistory` on feature items; centralized state in `vision-state.json`. | COMPLETE |
| 23 | **L2 — Artifact Awareness:** feature folder creation, artifact presence detection, phase-appropriate templates, artifact ↔ tracker item linking. | COMPLETE |
| 24 | **L3 — Policy Enforcement Runtime:** gate/flag/skip dials that structurally block phase transitions. Policy inheritance through work hierarchy. Override at any level. Hardcoded defaults until L0 lands. | COMPLETE |
| 25 | **L4 — Gate UI:** sidebar surface for pending phase transitions — shows artifact, proposed next phase, rationale. Three actions: Approve / Revise / Kill. Gate history. | COMPLETE |
| 26 | **L5 — Session-Lifecycle Binding:** sessions tagged to feature + phase. Activity grouped by feature. Transcripts auto-filed. Handoff context injected automatically. | COMPLETE |
| 27 | **L6 — Iteration Orchestration:** review and coverage loops as Compose primitives. Compose dispatches, monitors for completion promises, enforces exit criteria. Agent cannot self-report done without Compose confirming. | COMPLETE |

**Exit (current):** Lifecycle layers work end-to-end with Compose-internal primitives. Gates block, policies inherit, iterations are orchestrated, artifacts are managed.

**Exit (after STRAT-1):** Process primitives live in Stratum. Compose's lifecycle is a `.stratum.yaml` spec. Compose owns workspace concerns only.

See `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` for full layer detail.

---

## INIT-1: Project Bootstrap — COMPLETE

Make Compose portable across any project, not just its own repo.

| # | Item | Status |
|---|------|--------|
| 28 | `compose init` command: creates `.compose/`, writes manifest, detects capabilities | COMPLETE |
| 29 | Project manifest: `.compose/compose.json` with version, capabilities, paths | COMPLETE |
| 34 | Stratum graceful degradation: soft-fail when stratum-mcp not installed | COMPLETE |
| 35 | Config-driven paths: all server modules read docs/features/journal from manifest | COMPLETE |
| 36 | Target binding: `compose start` resolves project root via parent traversal | COMPLETE |

**Exit:** `compose init` in any repo bootstraps Compose. Server starts against that project. No hard dependency on stratum. All paths configurable.

See `docs/features/INIT-1/` for design, blueprint, plan, and report.

---

## STRAT-1: Stratum Process Engine + Compose MVP — COMPLETE

Three milestone gates. Each produces a usable deliverable. Nothing ships until each gate passes.

### Milestone 1: Stratum Engine Complete

Stratum IR v0.2 parses, validates, and executes specs with all primitives. All work in the Stratum repo.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 37 | — | Audit Stratum: inventory existing primitives, identify gaps | COMPLETE |
| 38 | STRAT-ENG-1 | IR v0.2 schema: `workflow:` declaration, inline steps (`agent`, `intent`, `on_fail`, `next`), `flow:` composition, gates, policy, skip, rounds | COMPLETE |
| 39 | STRAT-ENG-2 | Executor — state model: StepRecord, FlowState, agent passthrough, audit infra | COMPLETE |
| 40 | STRAT-ENG-3 | Executor — gates, policy, skip: policy evaluation (`skip`/`flag`/`gate`), `stratum_skip_step` tool | COMPLETE |
| 41 | STRAT-ENG-4 | Executor — loops and rounds: round tracking, `max_rounds`, per-step iteration | COMPLETE |
| 42 | STRAT-ENG-5 | Executor — routing and composition: `on_fail`/`next`, `flow:` sub-execution | COMPLETE |
| 43 | STRAT-ENG-6 | Contract freeze: spec shape, MCP tool signatures, flow state/audit output | COMPLETE |
| 43.1 | STRAT-ENG-HOOKS | `stratum-mcp install` hooks: install to `~/.stratum/hooks/` with absolute paths instead of per-project copies | COMPLETE |

**Gate:** Multi-step spec with gates, loops, and per-step agent assignment executes end-to-end in Stratum.

### Milestone 2: Headless Compose Runner

`compose build` works without UI. CLI → Stratum → agents → artifacts. All work in the Compose repo.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 44 | STRAT-COMP-1 | Skill prompt + headless runner + init upgrade: universal agent skill, `compose build`, questionnaire, agent detection | COMPLETE |
| 45 | STRAT-COMP-2 | Delete bespoke code: replace lifecycle-manager/policy-engine with Stratum adapters | COMPLETE |

**Gate:** `compose build FEAT-X` reads a spec, dispatches agents, enforces gates, produces artifacts. No server required.

### Milestone 3: Prove It

Run STRAT-1's own Compose integration through `compose build`. Dogfooding milestone D4.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 46 | STRAT-COMP-3 | Proof run: fix build infrastructure bugs, rewrite sub-flow spec, prove dispatch loop with mock connectors (449 Stratum tests, 0 fail). Live run (Task 6) remains manual/gated. | COMPLETE |

**Gate:** Compose builds itself using `compose build`. Multi-agent, gated, audited.

### Milestone 4: Unified Interface

CLI and web UI share execution context. Build runs are visible in the web app. Gates resolve from either interface.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 47 | STRAT-COMP-4 | Vision store unification: reconcile `VisionWriter` (CLI) and `VisionStore` (server) conventions — `featureCode` format mismatch, race-free shared access | COMPLETE |
| 48 | STRAT-COMP-5 | Build visibility: extend server file watcher to `.compose/` and `active-build.json`, broadcast build state via WebSocket | COMPLETE |
| 49 | STRAT-COMP-6 | Web gate resolution: when `compose start` is running, gates resolve through the web UI (Gate View) instead of CLI readline. CLI falls back to readline when server is not running | COMPLETE |
| 50 | STRAT-COMP-7 | Agent stream bridge: CLI writes tool_use events to `.compose/build-stream.jsonl`, server watches and pipes to AgentStream SSE | COMPLETE |
| 51 | STRAT-COMP-8 | ~~Active build dashboard~~ **SUPERSEDED by COMP-UI.** Build state visibility distributed across COMP-UI-2 (sidebar: active step, progress) and COMP-UI-3 (context panel: retries, violations, audit trail). | SUPERSEDED |

**Gate:** `compose start` + `compose build` run simultaneously. Build progress, agent activity, and gates are all visible and actionable in the web UI.

**Exit:** `pip install compose` → `compose init` → `compose build`. Compose is a thin layer: lifecycle spec + visibility + agent routing + optional UI.

See `docs/features/STRAT-1/` for full design.

---

## COMP-UI: Cockpit Integration — COMPLETE

Merge the cockpit architecture from compose-ui into the production compose/src/ codebase. Replace the split-pane terminal+canvas layout with a sidebar + tabbed main area + context panel + collapsible agent bar. Preserve everything that works (agent stream, canvas, Cytoscape graph, WebSocket data layer, error boundaries).

See `compose-ui/INTEGRATION-BRIEF.md` for the full merge spec.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 52 | COMP-UI-1 | **Cockpit shell:** rewrite `App.jsx` to render cockpit layout (header with ViewTabs, sidebar, main area, context panel, agent bar, notification bar). Move existing views from canvas tabs to main-area tabs. Agent stream becomes a collapsible bottom panel (agent bar) — always present, not a view tab. Three states: collapsed (status line), expanded (message stream + input), maximized (fills main area). | COMPLETE |
| 53 | COMP-UI-2 | **Live sidebar:** replace AppSidebar with attention-queue sidebar. Wire to useVisionStore for phase filter (global, affects all views), pending gates, blocked items, active build status (current step, progress from `active-build.json`), compact stats. Absorbs sidebar scope from STRAT-COMP-8. | COMPLETE |
| 54 | COMP-UI-3 | **Context panel:** right-side slide-in panel. Item click → ItemDetailPanel (inline field editing, connection editor). Gate click → GateReviewPanel (prior decisions, artifact summary, connected items, feedback). Build step detail component exists (`ContextStepDetail.jsx`) but not wired into item detail tabs. Artifact files open in DocsView. Persists across view switches. Absorbs detail scope from STRAT-COMP-8. | COMPLETE |
| 55 | COMP-UI-4 | **View upgrades:** replace BoardView (drag-drop with gate-aware transitions), ListView (filter bar: status/phase/type/agent), RoadmapView (collapsible tree with indentation). Restyle existing GraphView. Add PipelineView (visual step diagram) and SessionsView (browser with agent/status filters, read/write/error counters). | COMPLETE |
| 56 | COMP-UI-5 | **Interaction components:** CommandPalette (Cmd+K search across items/gates/sessions), ItemFormDialog (quick-type creation presets), SettingsModal (governance dials per phase), GateNotificationBar (persistent bottom bar with inline actions). Shared primitives: StatusBadge, PhaseTag, AgentAvatar, ConfidenceBar, RelativeTime, EmptyState, SkeletonCard. | COMPLETE |
| 57 | COMP-UI-6 | **Polish and teardown:** error boundaries per zone, delete replaced vision components and all compose-ui dead code (old pages, Layout, auth, base44). Merge color tokens into single constants file. localStorage persistence for cockpit state (active view, sidebar collapsed, font size). | COMPLETE |

**Gate:** Each step must pass its test criteria from `INTEGRATION-BRIEF.md` before the next begins.

**Exit:** Compose web UI uses the cockpit layout. All views render in tabs. Agent bar provides persistent bottom-panel access to the agent stream (collapsed/expanded/maximized). Context panel shows detail/gate/artifact. Command palette (Cmd+K), item creation (Cmd+N), settings modal, and gate notification bar work. All shared primitives (StatusBadge, PhaseTag, AgentAvatar, ConfidenceBar, RelativeTime, EmptyState, SkeletonCard) adopted across views. No compose-ui dead code remains.

---

## COMP-UX-1: Zoom-Level View Architecture — COMPLETE

Redesign the compose UI around three zoom levels (Graph → Tree → Detail) instead of 10+ separate view tabs. Absorb ops monitoring (Pipeline, Sessions, Gates) into the context panel and a persistent ops strip. Make the context panel the workhorse at 50% width.

See `docs/features/COMP-UX-1/design.md` for full spec and interactive mockups.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 73 | COMP-UX-1a | **View consolidation:** Remove Board, List, Roadmap, Attention views. Graph as default. Tree with search + filters. Three tabs: Graph, Tree, Docs. Blue-slate color scheme. Track filters in sidebar. Project switching. Feature scanner with roadmap-graph import. | COMPLETE |
| 74 | COMP-UX-1b | **Context panel as workhorse:** Widen to 50% (Tree) / 40% (Graph) with resizable divider. Add pipeline dot visualization, sessions table, errors section, files with Docs navigation. Preserve all existing ItemDetailPanel features (editing, connections, lifecycle, gates). | COMPLETE |
| 75 | COMP-UX-1c | **Graph ops overlays:** Node border colors from build status. HTML badge overlays for gates/errors. Gate popover on badge click. Building nodes show agent + step. Blocked downstream nodes dimmed. | COMPLETE |
| 76 | COMP-UX-1d | **Ops strip:** Persistent bottom bar (36px) showing active builds, gates, errors. Inline gate approve. Click entry to select. Completed items flash then clear. Hidden in Docs view. | COMPLETE |
| 77 | COMP-UX-1e | **Cross-view navigation:** "View in Graph ↑" / "View in Tree ↓" links in context panel. File click → Docs with back button. Selection persists across tab switches. Filters persist. | COMPLETE |
| 78 | COMP-UX-1f | **Agent bar integration:** Agent activity updates ops strip + node colors. Build start/complete events reflected across all views. Chat commands trigger ops updates. | COMPLETE |

**Dependencies:** 1a (done) → 1b → 1c ∥ 1d → 1e → 1f

**Gate:** Each sub-feature must pass visual comparison against the interactive mockups in `docs/features/COMP-UX-1/mockups/`.

**Exit:** Compose has three zoom levels. Graph shows dependency network with ops overlays. Tree shows features by track. Context panel is the workhorse for investigation and action. Ops strip provides persistent awareness. Agent bar controls everything.

---

## COMP-STATE: Singleton State Store — COMPLETE

Replace the `useVisionStore` hook (called independently by 12+ components, creating 12 WebSocket connections and 12 state copies) with a Zustand singleton store. One connection, one state, one set of intervals.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 79 | COMP-STATE-1 | **Zustand migration:** Convert `useVisionStore.js` from React hook to Zustand `create()` store. Single WebSocket connection, single state atom. All components read from same store via `useVisionStore()` selector hooks. One 10s recentErrors interval, one 5s build poll. | COMPLETE |
| 80 | COMP-STATE-2 | **Gate race fix:** Remove optimistic fetch on gateCreated (server already broadcasts). Prevent null itemId in gate resolved toast. | COMPLETE |
| 81 | COMP-STATE-3 | **Build completion reliability:** 5s build poll. Synthetic 'done' build kept for 3s so ops strip flash fires even on fast builds. | COMPLETE |
| 82 | COMP-STATE-4 | **Session zombie cleanup:** 3s end timer (was 15s). New session start unconditionally clears previous session and its timer. | COMPLETE |

**Dependencies:** 1 → 2 ∥ 3 ∥ 4

**Exit:** One WebSocket connection per client. All UI components show identical state. No race conditions in gate or build lifecycle. No zombie sessions.

---

## COMP-DESIGN: Interactive Design Conversation — PARTIAL (1a–1d COMPLETE, 2 PLANNED)

Product design conversation with the LLM before the roadmap exists. The LLM asks questions, presents structured decision cards with recommendations, and the human selects or responds with free text. Decisions accumulate into a design document that feeds into `compose new`.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 83 | COMP-DESIGN-1a | **Design view + message thread:** "Design" tab in cockpit. Conversation UI with text input. SSE streaming to agent via `ClaudeSDKConnector`. Markdown rendering. Server-side design session (`design-routes.js`, `design-session.js`). Product-scope and feature-scope sessions. Tests passing. | COMPLETE |
| 84 | COMP-DESIGN-1b | **Decision cards:** `parseDecisionBlocks` extracts fenced `decision` JSON from LLM responses. `DesignCard` renders clickable panels (letter prefix, title, bullets, recommendation badge, selected check). Card selection sends `card_select` message. Revisable via `reviseDecision`. | COMPLETE |
| 85 | COMP-DESIGN-1c | **Live design doc:** DesignDocPanel in context panel with live markdown preview (react-markdown + remark-gfm). Draft builds incrementally from decisions via `buildDraftDoc()`. Human can edit inline — edits survive across assistant turns and rehydration. `POST /complete` accepts edited draft as seed for final LLM polish. | COMPLETE |
| 86 | COMP-DESIGN-1d | **Research + sidebar:** DesignSidebar with Decisions/Research tab bar. ResearchTab shows topic outline, codebase references (Read/Grep/Glob), and web searches. Live SSE events (`research`/`research_result`) with unique IDs for reliable correlation. Topic outline auto-generated from decisions. | COMPLETE |
| 87 | COMP-DESIGN-2 | **compose new integration:** `compose new` detects `docs/design.md` and uses it as enriched intent, skipping the questionnaire. Research and brainstorm steps reference design decisions. | PLANNED |

**Dependencies:** 1a → 1b → 1c, 1a → 1d, 1c → 2

**Exit:** `compose design` starts an interactive design conversation. Decisions render as cards. Output feeds directly into `compose new` for roadmap generation.

---

## COMP-RT: Real-Time Resilience — PLANNED

Harden the streaming and connector layer for production-quality performance, late-joining clients, and multi-vendor extensibility.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 58 | COMP-RT-1 | **Event coalescing for WebSocket broadcasts:** accumulate agent activity and state-change events into a sparse buffer, flush to clients at a fixed interval (~60 fps). Prevents UI thrash from fine-grained tool-use deltas during heavy agent runs. | PLANNED |
| 59 | COMP-RT-2 | **Client hydration on connect:** when a new browser tab or reconnecting client joins via WebSocket, send a single state snapshot (active build, vision state, in-flight agent stream) so it starts current instead of empty. Eliminates the "blank panel until next event" problem. | PLANNED |
| 60 | COMP-RT-3 | **Connector trait split — discovery vs runtime:** refactor AgentConnector into two interfaces: a stateless `AgentRegistry` (enumerate installed agents, load session history, validate model IDs) and a stateful `AgentRuntime` (stream execution, interrupt, schema injection). Enables adding new vendors without touching the execution path. | PLANNED |
| 61 | COMP-RT-4 | **Session branching:** fork an in-progress agent session at any turn, creating an independent branch that shares history up to the fork point but diverges from there. Persist both branches with shared-prefix-aware storage. Web UI shows branch points and lets the user open divergent paths side-by-side for comparison. | PLANNED |

**Exit:** WebSocket clients never miss state. Streaming is smooth under load. New agent vendors plug in without modifying the runtime. Agent sessions can be branched mid-conversation for exploratory work.

---

## STRAT-PAR: Parallel Task Decomposition — PLANNED

Automatically decompose pipeline steps into independent subtasks, analyze their dependency graph, and execute non-dependent subtasks concurrently with worktree isolation and structured merge. Bumps Stratum IR from v0.2 to v0.3.

See `docs/features/STRAT-PAR/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 67 | STRAT-PAR-1 | **IR v0.3 schema:** add `decompose` and `parallel_dispatch` step types to spec. `decompose` emits a TaskGraph (tasks with `files_owned`, `files_read`, `depends_on`). `parallel_dispatch` consumes a TaskGraph with `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`. Backward-compatible superset of v0.2. | COMPLETE |
| 68 | STRAT-PAR-2 | **`no_file_conflicts` ensure function:** built-in validation that no two independent tasks (no dependency edge) share `files_owned` entries. Read-only overlap allowed. Transitive dependency detection. 5 tests. | COMPLETE |
| 69 | STRAT-PAR-3 | **Executor dispatch + `stratum_parallel_done`:** decompose returns `execute_step` with `step_mode: "decompose"`. `parallel_dispatch` returns task graph with resolved source ref. New MCP tool `stratum_parallel_done` for batch result reporting with require semantics (all/any/N). 10 tests. | COMPLETE |
| 70 | STRAT-PAR-4 | **Compose parallel dispatch:** `build.js` handles `parallel_dispatch` — git worktree per task under `.compose/par/`, dispatch up to `max_concurrent` agents, collect diffs via `git diff --cached HEAD`, apply in topo order with `git apply --check`. Conflict detection sets `mergeStatus='conflict'`. Falls back to shared cwd if not a git repo. 19 tests. | COMPLETE |
| 71 | STRAT-PAR-5 | **Pipeline integration:** `build.stratum.yaml` bumped to v0.3 — `decompose` step after `plan_gate` emits TaskGraph with `no_file_conflicts` + `len >= 1` ensures, `execute` step is now `parallel_dispatch` consuming decomposed tasks with worktree isolation. Validates cleanly. | COMPLETE |
| 72 | STRAT-PAR-6 | **Agent bar parallel progress:** build-stream-bridge passes `parallel` flag through SSE events. AgentStream tracks parallel task state (total/completed/failed/active). AgentBar shows `\u2225 N/M tasks` status text + mini progress bar when parallel dispatch is active. | COMPLETE |

**Exit:** `compose build` decomposes implementation tasks, runs independent ones in parallel worktrees, merges cleanly. Falls back to sequential on conflict. Agent bar shows parallel progress. Pipeline runs measurably faster on features with independent subtasks.

---

## STRAT-REV: Parallel Multi-Lens Review — PARTIAL

Replace the single-pass review step with parallel specialized reviewers ("lenses"), each focused on one concern. A triage step activates only relevant lenses, they run concurrently via `parallel_dispatch`, and a merge step deduplicates findings before the fix loop.

Inspired by [claude-review-loop](https://github.com/hamelsmu/claude-review-loop) — multi-agent parallel review with deduplication.

See `docs/features/STRAT-REV/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 79 | STRAT-REV-1 | **Triage step:** file-list analysis to activate conditional lenses | COMPLETE |
| 80 | STRAT-REV-2 | **Lens library:** 4 review prompts (diff-quality, contract-compliance, security, framework) with `LensFinding` contract. Each lens declares a **confidence gate** (minimum confidence threshold, e.g. security=8/10, diff-quality=6/10) — findings below the gate are suppressed. Each lens also declares a **false-positive exclusion list** (e.g. security lens excludes DoS/rate-limiting, memory safety in memory-safe languages, absent hardening without concrete risk). Inspired by gstack `/cso` zero-noise pattern. | COMPLETE |
| 81 | STRAT-REV-3 | **Parallel review dispatch:** `parallel_dispatch` with `isolation: none` for read-only review tasks | COMPLETE |
| 82 | STRAT-REV-4 | **Merge + dedup + fix-first classification:** collect, deduplicate by file+issue, assign severity. Classify each finding as **AUTO-FIX** (mechanical: formatting, simple tests, obvious typos) or **ASK** (requires judgment). AUTO-FIX findings are applied immediately in the fix loop. ASK findings are batched into a single gate decision. Inspired by gstack `/review` fix-first pipeline. | COMPLETE |
| 83 | STRAT-REV-5 | **Selective re-review:** on retry, only re-run lenses with actionable findings | COMPLETE |
| 84 | STRAT-REV-6 | **Pipeline integration:** replace `review_check` with `parallel_review` in `build.stratum.yaml` | COMPLETE |
| 85 | STRAT-REV-7 | **Cross-model adversarial synthesis:** for large diffs (200+ lines), run both Claude lens review and Codex review in parallel. Merge step surfaces overlapping findings (high confidence) vs. unique findings (flag for human attention). Auto-scales: small diffs skip, medium diffs run one cross-model check, large diffs run full synthesis. Inspired by gstack `/review` + `/codex` cross-model pattern. | PLANNED |

**Dependencies:** STRAT-PAR (parallel dispatch infrastructure)

**Exit:** Review step runs 2–4 specialized lenses in parallel, merges findings with severity, auto-fixes mechanical issues, batches judgment calls, and only re-reviews dirty lenses on retry. Confidence gates and false-positive exclusions ensure zero-noise output. Large diffs get cross-model adversarial synthesis. Review quality improves without proportional cost increase.

---

## COMP-BENCH: Model Benchmark Suite — PLANNED

Score LLMs on multi-phase workflow fidelity — not just code correctness (SWE-bench) but pipeline discipline, artifact quality, gate compliance, and cost efficiency. A fixed seed repo + 5 canonical feature requests + Stratum audit traces + judge-model scoring.

See `docs/features/COMP-BENCH/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 62 | COMP-BENCH-1 | **Seed repo:** ~2k LOC task management API (Express + SQLite + integration tests). Planted race condition for BENCH-4. Pre-initialized `.compose/` manifest. Deterministic `npm test`. | PLANNED |
| 63 | COMP-BENCH-2 | **Feature specs:** 5 canonical requests as YAML — OAuth (hard), repo refactor (medium), WebSocket notifications (hard), race condition fix (medium), CSV export (easy). Machine-checkable acceptance criteria + judge rubric per feature. | PLANNED |
| 64 | COMP-BENCH-3 | **Benchmark harness:** runner with git worktree isolation per run, connector config per model, `audit-scorer.js` (6 automated axes from Stratum audit), `judge-scorer.js` (5 qualitative axes, blind evaluation, 3x inter-rater check). | PLANNED |
| 65 | COMP-BENCH-4 | **Scoring and calibration:** composite score (50% automated + 50% judge), cost-efficiency ratio, rubric anchor calibration from baseline runs. Judge stddev < 2 across repeated evaluations. | PLANNED |
| 66 | COMP-BENCH-5 | **`compose bench` CLI:** `compose bench run --model X --feature Y`, `compose bench report --compare X,Y,Z`. Results persisted in `bench/results/{model}-{feature}-{timestamp}/`. | PLANNED |

**Exit:** `compose bench run --model claude-opus --feature all` produces scored results. `compose bench report` generates a comparison table across 3+ models. Automated scores correlate with human judgment.

---

## COMP-CTX: Context Artifacts — PLANNED

Manage project-level context documents as first-class artifacts in the feature lifecycle. Agents always see ambient context (tech stack, conventions, decision log) without manual injection. Stale artifacts are flagged when the code or phase moves past them.

Inspired by [Conductor](https://github.com/nicklatkovich/conductor-plugin)'s "context as artifact" pattern — treating product vision, tech decisions, and work tracks as managed artifacts alongside code.

Note: cross-artifact consistency (design↔blueprint↔plan alignment) is already handled by Codex review loops in the build pipeline.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 100 | COMP-CTX-1 | **Ambient context layer:** `compose init` scaffolds `docs/context/` with `tech-stack.md`, `conventions.md`, `decisions.md`. These are injected into every agent prompt during `compose build` as read-only context. Updated manually or via `compose context update`. | PLANNED |
| 101 | COMP-CTX-2 | **Artifact staleness detection:** track last-modified timestamps and phase at time of writing. When the feature advances past the artifact's phase or code changes touch files referenced in the artifact, flag it as potentially stale. Surface in context panel and gate reviews. | PLANNED |
| 102 | COMP-CTX-3 | **Decision log accumulation:** agent decisions during `compose build` (model choices, architecture trade-offs, rejected approaches) auto-append to `docs/context/decisions.md` with timestamp, feature ref, and rationale. Queryable via `compose context decisions`. | PLANNED |

**Dependencies:** None — independent of other features. Enhances L2 artifact awareness and L3 policy enforcement.

**Exit:** `compose init` creates context docs. Agents see ambient context automatically. Stale artifacts are flagged. Decision log accumulates across builds.

---

## COMP-TUI: CLI Terminal UI — PARTIAL

Rich terminal interface for `compose build`. Replaces raw text output with structured progress visualization, interactive gates, and live parallel task tracking.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 103 | COMP-TUI-1 | **Step pipeline bar:** horizontal progress visualization showing all build steps with done/active/pending states. Always visible at top of output. | PLANNED |
| 104 | COMP-TUI-2 | **Gate panel:** interactive gate UI with artifact summary, approve/revise/kill as selectable options. Replaces raw readline prompt. | PLANNED |
| 105 | COMP-TUI-3 | **Violation/findings table:** formatted table for review findings (severity, file, line, description) instead of raw JSON output. | PLANNED |
| 106 | COMP-TUI-4 | **Parallel task grid:** live 2-4 row grid during `parallel_dispatch` showing per-task status (spinner/done/failed) with agent and elapsed time. | PLANNED |
| 107 | COMP-TUI-5 | **File manifest:** running list of files changed by the build, updated after execute step. | PLANNED |
| 108 | COMP-TUI-6 | **Build summary:** completion report with step durations, retries, total cost/tokens, pass/fail per step. | PLANNED |
| 109 | COMP-TUI-7 | **Split pane layout:** top pane for pipeline progress, bottom for tool output. Terminal equivalent of cockpit main area + agent bar. | PLANNED |
| 110 | COMP-TUI-8 | **Item detail on gate:** pull item connections, lifecycle phase, related artifacts into the gate review panel. | PLANNED |

**Support features (complete):**
- Heartbeat timer: 5s elapsed time tick during silent agent runs
- Key commands: t=toggle s=skip r=retry Ctrl+C=abort
- Collapsed/expanded tool output with last-5 view
- Stall detection in opencode connector (120s warning)
- Rate-limit/auth error detection in opencode connector

**Exit:** `compose build` has a rich terminal interface. Pipeline progress is always visible. Gates are interactive with context. Review findings are formatted. Parallel tasks show live progress.

---

## COMP-PIPE-EDIT: Visual Pipeline Editor — PLANNED

Drag-and-drop pipeline editor in the web UI. Build, modify, and rewire `.stratum.yaml` specs visually instead of editing YAML by hand. Extends the existing COMP-PIPE template picker with a full editor.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 111 | COMP-PIPE-EDIT-1 | **Step canvas:** Drag-and-drop step nodes on a canvas. Each node shows step ID, agent, intent preview. Dependency edges rendered as arrows. Add step via toolbar or context menu. Delete step via node menu. | PLANNED |
| 112 | COMP-PIPE-EDIT-2 | **Step inspector:** Click a step node to open a side panel with editable fields: ID, agent, intent (multiline), inputs (key-value), output_contract (dropdown from defined contracts), ensure conditions, retries, on_fail. Live validation as you type. | PLANNED |
| 113 | COMP-PIPE-EDIT-3 | **Dependency wiring:** Drag from one node's output port to another's input port to create `depends_on` edges. Visual feedback for invalid connections (cycles, missing refs). Auto-layout via dagre/elk. | PLANNED |
| 114 | COMP-PIPE-EDIT-4 | **Contract editor:** Define and edit contracts (LensFinding, ReviewResult, etc.) in a schema form. Contracts available as dropdowns in step inspector. New contracts auto-added to the spec. | PLANNED |
| 115 | COMP-PIPE-EDIT-5 | **Sub-flow support:** Collapse a group of steps into a named sub-flow. Expand sub-flows to edit internals. Sub-flow inputs/outputs visible as ports on the collapsed node. | PLANNED |
| 116 | COMP-PIPE-EDIT-6 | **YAML sync:** Bidirectional sync between canvas and YAML. Edit in canvas → YAML updates live. Edit YAML in Docs view → canvas updates. Conflict resolution when both sides change. | PLANNED |
| 117 | COMP-PIPE-EDIT-7 | **Template save:** Save the current canvas as a new pipeline template in `pipelines/`. Templates appear in the existing TemplateSelector for future builds. | PLANNED |

**Dependencies:** COMP-PIPE (template selector, pipeline routes — complete), COMP-UX-1 (context panel — complete)

**Exit:** Users can visually build, modify, and save pipeline specs. Steps are draggable nodes with editable properties. Dependencies are wired via drag. Sub-flows collapse/expand. YAML stays in sync. Custom pipelines save as reusable templates.

---

## STRAT-TIER: Model Tier Routing — PLANNED

Assign Stratum steps to model tiers based on task criticality. Steps declare a `model_tier` (critical/standard/fast) and the executor routes to the appropriate model. Enables hybrid chains: Opus plans → Haiku executes → Sonnet reviews.

Inspired by [wshobson/agents](https://github.com/wshobson/agents) model routing strategy.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 88 | STRAT-TIER-1 | **IR schema extension:** add optional `model_tier` field to step definitions (`critical` → Opus, `standard` → Sonnet/inherit, `fast` → Haiku). Backward-compatible — absent field means inherit. | PLANNED |
| 89 | STRAT-TIER-2 | **Executor routing:** executor reads `model_tier`, resolves to concrete model via config map, passes to agent dispatch. Override via CLI flag or `.stratum.yaml` top-level `model_map`. | PLANNED |
| 90 | STRAT-TIER-3 | **Compose integration:** `build.js` reads tier from step, passes model to connector. Audit trail records which model ran each step. Cost tracking per tier. | PLANNED |
| 91 | STRAT-TIER-4 | **Hybrid chain presets:** built-in chain templates — `plan-execute-review` (Opus→Haiku→Sonnet), `review-fix` (Sonnet→Haiku), `security-audit` (Opus→Opus). Selectable in spec or via `compose build --chain`. | PLANNED |

**Dependencies:** None — independent of other features.

**Exit:** Stratum specs declare model tiers per step. Executor routes accordingly. Compose tracks cost per tier. Hybrid chains reduce cost without sacrificing quality on critical steps.

---

## COMP-TEAMS: Agent Team Presets — PLANNED

Pre-configured multi-agent team compositions for common workflows. Each preset defines agent count, roles, file ownership boundaries, and coordination protocol. Builds on STRAT-PAR's parallel dispatch infrastructure.

Inspired by [wshobson/agents](https://github.com/wshobson/agents) agent-teams plugin — team-lead orchestration with file ownership model.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 92 | COMP-TEAMS-1 | **Team presets library:** 5 preset configs — `review` (3 reviewers: security/perf/arch), `debug` (3 investigators with competing hypotheses), `feature` (1 lead + 2 implementers), `fullstack` (4 agents across layers), `research` (3 explorers with codebase/web/docs splits). Stored as `.stratum.yaml` templates. | PLANNED |
| 93 | COMP-TEAMS-2 | **File ownership enforcement:** `parallel_dispatch` gains `files_owned` per task as exclusive locks. `no_file_conflicts` ensure already exists (STRAT-PAR-2). Add runtime enforcement: agent writes outside owned files → step fails. Sequential fallback for shared files. | PLANNED |
| 94 | COMP-TEAMS-3 | **Team-lead agent pattern:** agent definition for orchestrating decomposition — selects 2–5 teammates, assigns file boundaries, builds dependency graph, collects and merges results. Reusable as a Compose agent or Claude Code agent. _Related pattern: [Mason-Teams](https://github.com/Mason-Teams/mason-teams) "concierge" (Connie) — interviews the user in natural language, then assembles a team dynamically from the description rather than selecting a preset. A dynamic assembly variant of this step could feed `compose build --team auto`, complementing the preset-based flow in COMP-TEAMS-1/4._ | PLANNED |
| 95 | COMP-TEAMS-4 | **`compose build --team`:** CLI flag to select a preset or custom team config. `compose build --team review` runs the review preset. `compose build --team custom:./my-team.yaml` uses a custom definition. | PLANNED |

**Dependencies:** STRAT-PAR (parallel dispatch, worktree isolation, `no_file_conflicts`)

**Exit:** `compose build --team feature` decomposes work, assigns file ownership, dispatches agents in parallel with conflict prevention. 5 built-in presets cover common workflows. Custom team definitions supported.

---

## SKILL-PD: Progressive Disclosure for Skills — PLANNED

Restructure Compose and Claude Code skills into a three-tier progressive disclosure architecture. Tier 1 (metadata + activation trigger) is always loaded. Tier 2 (core instructions) loads on activation. Tier 3 (examples, templates, resources) loads on demand. Reduces token burn in skill-heavy sessions.

Inspired by [wshobson/agents](https://github.com/wshobson/agents) progressive disclosure architecture for agent skills.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 96 | SKILL-PD-1 | **Tier format spec:** define the three-tier SKILL.md format — frontmatter (name, description, activation trigger ≤1024 chars), `## Instructions` section, `## Resources` section with `<!-- lazy -->` markers. Document in `docs/skill-format.md`. | PLANNED |
| 97 | SKILL-PD-2 | **Skill loader refactor:** update skill loading to parse tiers. Tier 1 always injected into system prompt. Tier 2 loaded when activation trigger matches. Tier 3 loaded only when agent requests via `load_skill_resources` tool or explicit reference. | PLANNED |
| 98 | SKILL-PD-3 | **Migrate existing skills:** convert current SKILL.md files to three-tier format. Measure token savings per session. Target: ≥40% reduction in skill token overhead for sessions that don't activate all skills. | PLANNED |
| 99 | SKILL-PD-4 | **Compose skill activation:** `compose build` activates only skills relevant to the current phase (e.g., design skills during design, test skills during test). Phase→skill mapping in lifecycle contract. | PLANNED |

**Dependencies:** None — independent of other features.

**Exit:** Skills use three-tier progressive disclosure. Only metadata is always loaded. Instructions activate on demand. Examples/templates are lazy-loaded. Measurable token reduction in multi-skill sessions.

---

## STRAT-VOCAB: Vocabulary Enforcement — PLANNED

Ensure function that checks generated code against a canonical name registry. Prevents naming entropy across sessions — the "is it `user_id`, `uid`, `UserId`?" problem. A `vocabulary.yaml` in the project declares canonical names with rejected aliases. The ensure function greps generated/modified files for rejected names and fails the step if any appear.

Inspired by [SpeQ](https://github.com/speq-ai/speq)'s closed-world VOCABULARY construct — but implemented as a Stratum ensure function, not a new DSL.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 107 | STRAT-VOCAB-1 | **Vocabulary file format:** `contracts/vocabulary.yaml` — map of canonical names to rejected aliases, grouped by domain. Example: `auth_token: { reject: [jwt, accessToken, JwtToken, authToken] }`. Optional `scope` field to limit checks to specific directories. | PLANNED |
| 108 | STRAT-VOCAB-2 | **`vocabulary_compliance` ensure function:** built-in Stratum ensure that greps modified files for rejected aliases. Returns violations with file, line, rejected term, and canonical replacement. Runs on implementation steps. | PLANNED |
| 109 | STRAT-VOCAB-3 | **Compose integration:** `compose init` scaffolds empty `contracts/vocabulary.yaml`. `compose build` implementation steps include `vocabulary_compliance` ensure by default. Violations surface in review findings. | PLANNED |

**Dependencies:** None — standalone ensure function.

**Exit:** `contracts/vocabulary.yaml` declares canonical names. Stratum ensure catches rejected aliases in generated code. No new DSL — just a YAML file and a grep-based checker.

---

## STRAT-IMMUTABLE: Spec Immutability During Execution — COMPLETE

Make `.stratum.yaml` specs read-only while a flow is executing. Prevents the failure mode where an agent modifies its own spec to reconcile with bad output. The executor checksums the spec at flow start and fails if the file changes mid-run.

Inspired by [SpeQ](https://github.com/speq-ai/speq)'s immutable spec rule — "modifying the spec to match generated code is a security violation." Also informed by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s self-protection rules — agents blocked from modifying their own config, hook definitions, and policy files during a session.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 110 | STRAT-IMMUTABLE-1 | **Spec checksum at flow start:** executor computes SHA-256 of parsed FlowDefinition when `stratum_plan` is called. Stored in FlowState, persisted/restored across restarts. | COMPLETE |
| 111 | STRAT-IMMUTABLE-2 | **Integrity check on step transitions:** `stratum_step_done` and `stratum_parallel_done` recompute checksum and compare. Mismatch → `spec_modified` error, flow halts. Pipeline file hash verified from disk in `build.js` before each step transition. | COMPLETE |
| 112 | STRAT-IMMUTABLE-3 | **PostToolUse guard (optional):** hook that watches for Edit/Write targeting `*.stratum.yaml` files during active flows. | PARKED — no Python hook mechanism exists; pipeline file hash in build.js covers the primary threat |
| 140 | STRAT-IMMUTABLE-4 | **Gate criteria protection:** `build.js` hashes `settings.json` policy fields at build start, verifies before gate resolution. Policy mutation detected → `POLICY_MODIFIED` error, build halts. | COMPLETE |

**Dependencies:** None — executor-level change.

**Exit:** Specs and gate criteria cannot be silently modified during execution. Checksum mismatch halts the flow. Agents must work within the spec and governance rules as written.

---

## HOOK-CACHE: Read Cache Hook — COMPLETE

PreToolUse hook that blocks redundant file reads within a session. Claude re-reads files it already has in context — a token-optimization hook tracks what's been read, checks mtime for freshness, and blocks re-reads of unchanged, already-loaded content.

Inspired by [claude-context-optimizer](https://github.com/egorfedorov/claude-context-optimizer) — reported 68% token savings on heavy sessions (362K → 115K). We take the core idea (mtime + range tracking) and drop the baggage (historical pattern DB, crypto donation injection, heuristic token estimates, warnings that consume the tokens they're trying to save).

| # | Feature | Item | Status |
|---|---------|------|--------|
| 103 | HOOK-CACHE-1 | **Read cache core:** `read-cache.py` PreToolUse hook. Per-agent mtime + line-range tracking in `~/.claude/read-cache/<session>/<agent>/`. First read records mtime + range. Subsequent reads: mtime changed → allow + update; range fully covered → block; uncovered range → allow + merge intervals. | COMPLETE |
| 104 | HOOK-CACHE-2 | **Invalidation rules:** `read-cache-invalidate.py` PostToolUse hook on Edit/Write/MultiEdit deletes cache entry. `read-cache-compact.py` PreCompact hook clears entire session cache. All registered in `hooks.json`. | COMPLETE |
| 105 | HOOK-CACHE-3 | **Partial read awareness:** block message includes cached line ranges so Claude can request uncovered ranges via offset/limit. | COMPLETE |
| 106 | HOOK-CACHE-4 | **Metrics:** Appends to `~/.claude/read-cache/stats.json` on every decision — timestamp, session, decision, file path, estimated tokens saved. Metrics for the human, not injected into context. | COMPLETE |

**Dependencies:** None — standalone hook, independent of Compose/Stratum.

**Exit:** PreToolUse hook blocks redundant reads with mtime + range validation. Edit/Write/compaction invalidate correctly. Metrics show token savings. No tokens wasted on warnings or pattern databases.

---

## COMP-QA: Diff-Aware QA Scoping — PLANNED

Scope integration/browser testing to changed functionality instead of full regression. When `compose build` reaches the test phase, analyze the git diff to identify affected routes/pages, detect the running dev server, and test only changed functionality. Prevents regression on adjacent pages without paying for full-suite reruns.

Inspired by gstack `/qa` diff-aware mode — git diff analysis → affected route identification → targeted browser verification.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 113 | COMP-QA-1 | **Diff-to-route mapper:** analyze git diff to identify changed files, map to routes/pages via framework conventions (Next.js pages/, Express routes/, etc.) or explicit `routes.yaml` mapping. Output: list of affected URLs to test. | PLANNED |
| 114 | COMP-QA-2 | **Dev server detection:** scan common ports (3000, 4000, 5173, 8080) for running dev servers. If none found, attempt `npm run dev` or equivalent from manifest. Timeout after 30s. | PLANNED |
| 115 | COMP-QA-3 | **Targeted browser verification:** for each affected route, run a Playwright verification pass — navigate, check for console errors, verify key elements render, take before/after screenshots. Findings feed into review merge step. | PLANNED |
| 116 | COMP-QA-4 | **Regression guard:** on adjacent routes (one hop from changed routes in the route graph), run a lightweight smoke check (200 OK + no console errors) to catch collateral breakage without full verification cost. | PLANNED |

**Dependencies:** None — standalone, but enhances `compose build` test phase.

**Exit:** `compose build` test phase scopes browser verification to changed routes. Adjacent routes get smoke checks. Full regression only on explicit request.

---

## COMP-HEALTH: Quantified Quality Score for Gates — PLANNED

Assign a numeric quality score to gate decisions based on weighted dimensions. Instead of binary pass/fail, gates surface a composite score (0–100) that policy can threshold. Dimensions include test coverage, review finding severity, console errors, contract compliance, and documentation freshness. Score history enables trend tracking.

Inspired by gstack `/qa` health scoring — weighted average across 8 dimensions with per-severity deductions.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 117 | COMP-HEALTH-1 | **Score dimensions:** define 6 weighted dimensions — test coverage (25%), review findings (25%, weighted by severity), contract compliance (15%), console/runtime errors (15%), documentation freshness (10%), plan completion (10%). Configurable weights in `.compose/compose.json`. | PLANNED |
| 118 | COMP-HEALTH-2 | **Score computation:** after each phase completes, compute composite score from available signals (Stratum audit trace, review findings, test results). Missing dimensions scored as neutral (50), not zero. | PLANNED |
| 119 | COMP-HEALTH-3 | **Policy integration:** gates can declare `min_score: 70` as a threshold. Score below threshold → gate blocks. Score between threshold and target → gate warns. Score above target → auto-approve (if policy allows). | PLANNED |
| 120 | COMP-HEALTH-4 | **Score history and trends:** persist scores in `.compose/data/health-scores.json` per feature per phase. `compose status` shows current score. Context panel shows score trend across phases. `/retro` includes score trends. | PLANNED |

**Dependencies:** STRAT-REV (review findings feed into scoring), COMP-CTX-2 (documentation freshness signal).

**Exit:** Gate decisions include a composite quality score. Policy thresholds on score. Trend tracking shows quality trajectory across phases. Scores are configurable, not hardcoded.

---

## COMP-PLAN-VERIFY: Plan-Diff Verification — COMPLETE

Mechanical verification that plan items appear in the implementation diff before the ship gate. Cross-references the plan's acceptance criteria checkboxes against the actual diff to detect missing deliverables and scope creep. Runs as a Stratum ensure function.

Inspired by gstack `/ship` plan completion audit — cross-referencing TODOS.md against diff to detect scope drift.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 121 | COMP-PLAN-VERIFY-1 | **Plan parser:** `plan-parser.js` — `parsePlanItems()` extracts checkbox items with file paths and critical flags from plan.md. Agent-side helper for the ship step. | COMPLETE |
| 122 | COMP-PLAN-VERIFY-2 | **Diff matcher:** `matchItemsToDiff()` classifies plan items as DONE (file in diff), MISSING (file not in diff), EXTRA (diff file not in plan — scope creep). | COMPLETE |
| 123 | COMP-PLAN-VERIFY-3 | **`plan_completion` ensure function:** Python ensure builtin in spec.py. Runs on the ship step (not ship_gate). Division-by-zero guard. Critical missing → plain string violations. Below threshold → violation with percentage. Registered in executor sandbox. | COMPLETE |
| 124 | COMP-PLAN-VERIFY-4 | **Scope creep report:** EXTRA items from `matchItemsToDiff` are informational. Agent presents at ship_gate for human review. Optional policy gate via `len(result.scope_creep) == 0`. | COMPLETE |

**Dependencies:** None — standalone ensure function. Enhances any `compose build` pipeline with a plan.

**Exit:** Ship gate mechanically verifies plan items against diff. Missing items block (configurable). Scope creep surfaced. No manual cross-referencing needed.

---

## COMP-TEST-BOOTSTRAP: Test Framework Bootstrap — PLANNED

Detect when a project has no test framework and auto-generate one during the build phase. Instead of failing on "no tests," scaffold a framework-appropriate test setup, generate golden flow tests from the implementation, and gate on the generated suite passing.

Inspired by gstack `/ship` test bootstrap — detects missing framework, installs it, generates initial tests before first PR.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 125 | COMP-TEST-BOOTSTRAP-1 | **Framework detection:** check for test config files (jest.config, vitest.config, pytest.ini, go test files, etc.). If none found, classify project by language/framework and select appropriate test runner. | PLANNED |
| 126 | COMP-TEST-BOOTSTRAP-2 | **Scaffold generation:** install test runner, create config, generate a minimal test helper with project-specific setup (db connection, server boot, auth fixture). Output as a `test-bootstrap` decompose task in the implementation phase. | PLANNED |
| 127 | COMP-TEST-BOOTSTRAP-3 | **Golden flow generation:** from the implementation diff, generate 1–3 golden flow tests covering the core capability lifecycle. Tests follow the project's testing hierarchy (golden flows > error harness > contract > unit). | PLANNED |
| 128 | COMP-TEST-BOOTSTRAP-4 | **Gate integration:** test phase ensure requires `test_count >= 1` and `test_pass_rate == 100%`. If bootstrap generated the tests, review lens flags them for human verification ("auto-generated tests — verify assertions match intent"). | PLANNED |

**Dependencies:** None — standalone enhancement to the build pipeline test phase.

**Exit:** `compose build` on a test-less project auto-scaffolds a test framework and generates golden flow tests. Tests gate the ship step. Human reviews auto-generated assertions.

---

## COMP-TRIAGE: Task Tier Classification — COMPLETE

Pre-flight classification of task complexity and blast radius before work begins. Analyzes the task description, affected files, and dependency surface to recommend a tier (0–4) and the corresponding agent chain. Prevents under-scoping (security-sensitive change run as Tier 1) and over-scoping (typo fix run through full review chain).

Inspired by [Hub3r7/claude-code-orchestration-template](https://github.com/Hub3r7/claude-code-orchestration-template) `/tier-check` skill — upfront task classification with chain recommendation.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 129 | COMP-TRIAGE-1 | **Classification engine:** `lib/triage.js` — pure file analysis. Counts paths in plan/blueprint, detects security/core paths, assigns tier 0-4 and build profile (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`). No LLM calls. | COMPLETE |
| 130 | COMP-TRIAGE-2 | **`compose triage` CLI command:** standalone command prints tier, profile flags, signal counts, rationale. Persists to feature.json. | COMPLETE |
| 131 | COMP-TRIAGE-3 | **Build integration:** `compose build` runs triage before `stratum_plan()`. Profile toggles `skip_if` on existing pipeline steps — no new templates needed. `--skip-triage` and `--template` flags. Cache invalidation via mtime comparison. Creates feature.json if missing. | COMPLETE |
| 132 | COMP-TRIAGE-4 | **Tier history:** deferred — triage results persist in feature.json per feature. Cross-feature history log is a one-liner addition when needed. | PARKED |

**Dependencies:** None — standalone, enhances `compose build` entry point.

**Exit:** Every `compose build` starts with a triage step. Tier determines pipeline depth. Under-scoping and over-scoping are caught before work begins. Tier accuracy tracked over time.

---

## COMP-AGENT-CAPS: Agent Capability Profiles — PARTIAL

Standardize agent capability profiles with explicit tool restrictions. Each agent declares its role (read-only reviewer, implementer, orchestrator) and the system enforces tool access boundaries. Prevents review agents from modifying code and implementation agents from self-reviewing.

Inspired by [Hub3r7/claude-code-orchestration-template](https://github.com/Hub3r7/claude-code-orchestration-template) `disallowedTools` pattern — review agents restricted to `[Read, Grep, Glob]`, orchestrator restricted to meta-config only.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 133 | COMP-AGENT-CAPS-1 | **Capability profile schema:** `server/agent-templates.js` — 4 profiles with `allowedTools`/`disallowedTools`. `lib/agent-string.js` — centralized `parseAgentString("claude:template")` parser + `resolveAgentConfig()`. | COMPLETE |
| 134 | COMP-AGENT-CAPS-2 | **Profile templates:** `read-only-reviewer`, `implementer`, `orchestrator`, `security-auditor`. Resolved by agent string parser at build time. | COMPLETE |
| 135 | COMP-AGENT-CAPS-3 | **Compose enforcement:** `build.js` connector factory resolves agent string → template → tool restrictions. `claude-sdk-connector` passes `allowedTools`/`disallowedTools` to SDK. Review sub-flow steps use `claude:orchestrator` and `claude:read-only-reviewer`. `capability_profile` stream events emitted. | COMPLETE |
| 136 | COMP-AGENT-CAPS-4 | **Violation detection:** informational logging via stream events in v1. Runtime violation detection (inspecting actual tool_use events against profile) requires normalizer integration — deferred to v2. | PARTIAL |

**Dependencies:** None — standalone, enhances agent dispatch in `compose build`.

**Exit:** Agents declare capability profiles. Review agents cannot modify files. Implementers cannot self-review. Profiles are reusable templates. Violation detection is informational in v1.

---

## COMP-CAPS-ENFORCE: Agent Capability Violation Detection — PLANNED

Runtime detection of agent tool calls that violate their capability profile. Currently COMP-AGENT-CAPS logs which template was active per step, but doesn't inspect actual tool_use events. This feature hooks into the result normalizer's event stream to compare each tool call against the agent's profile and surface violations.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 193 | COMP-CAPS-ENFORCE-1 | **Normalizer event tap:** Extend `result-normalizer.js` to emit structured `tool_use` events (tool name, timestamp) to a callback or event emitter during `runAndNormalize()`. Currently normalizer only returns `{ text, result }` — tool events are consumed but not surfaced. | PLANNED |
| 194 | COMP-CAPS-ENFORCE-2 | **Violation checker:** After each step completes, compare observed tool_use events against the step's agent template (`allowedTools`/`disallowedTools`). Classify: VIOLATION (disallowed tool used), WARNING (tool not in allowedTools but not explicitly disallowed). | PLANNED |
| 195 | COMP-CAPS-ENFORCE-3 | **Build audit integration:** Violations written to build-stream as `capability_violation` events with step, agent, tool, template, severity. Surface in review findings and context panel audit trail. | PLANNED |
| 196 | COMP-CAPS-ENFORCE-4 | **Enforcement mode:** Policy setting `capabilities.enforcement: "log" | "block"`. Log mode (default): violations recorded but don't block. Block mode: violation fails the step with `capability_violation` error. | PLANNED |

**Dependencies:** COMP-AGENT-CAPS (template registry — COMPLETE)

**Exit:** Every tool call during a templated step is checked against the profile. Violations surface in build audit. Block mode available via policy for strict environments.

---

## COMP-UX-3: Workflow Approachability — PLANNED

Reduce friction in the Compose workflow so first-time users can be productive without reading docs. Smarter defaults, conversational prompts at decision points, and concise status narration. The goal is not a simpler product — it's a less intimidating one.

Inspired by [srf6413/cstack](https://github.com/srf6413/cstack) — zero-config agent orchestration that prioritizes approachability over power.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 137 | COMP-UX-3a | **Scaffold defaults:** `scaffold_feature` infers lifecycle shape from project context (language, existing features, test setup). Only prompts for what can't be inferred. Default lifecycle covers 80% of cases — user overrides only when needed. | PLANNED |
| 138 | COMP-UX-3b | **Conversational gates:** Gate prompts rewritten as plain-English questions with recommended action. "Tests pass, 2 review findings (both minor). Ship it? [Y/n]" instead of full audit dump. Detail available on expand. | PLANNED |
| 139 | COMP-UX-3c | **Status narration:** Phase transitions and iteration reports summarized in 1–2 sentences focused on what changed and what's next. Full detail behind a toggle, not inline. | PLANNED |

**Dependencies:** None — standalone UX pass. Can run in parallel with any wave.

**Exit:** A user can `scaffold_feature` → `compose build` → approve gates → ship without reading Compose documentation. Status updates are concise. Detail is available but not forced.

---

## COMP-BUDGET: Iteration Budget Enforcement — COMPLETE

Hard ceilings on iteration loops to prevent runaway agents. Today `abort_iteration_loop` exists but requires manual intervention. Budget enforcement auto-aborts with a structured failure report when any ceiling is hit.

Inspired by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s budget-as-enforcement pattern — action counts, token caps, cost thresholds, and wall-clock timeouts as hard limits, not warnings. Cross-session cumulative limits.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 141 | COMP-BUDGET-1 | **Iteration ceilings:** Wall-clock timeout and action count ceiling checked at each `report_iteration_result`. Timeout and maxActions stored in iterationState. Exceeded → auto-abort with `timeout` or `action_limit` outcome. | COMPLETE |
| 142 | COMP-BUDGET-2 | **Cumulative tracking:** `budget-ledger.js` persists per-feature iteration totals in `.compose/data/budget-ledger.json`. Recorded from both report and abort routes. `checkCumulativeBudget()` blocks start when exceeded (429). | COMPLETE |
| 143 | COMP-BUDGET-3 | **Budget visibility:** Client handles `timeout` and `action_limit` outcomes with distinct messages. Ops strip display of elapsed/budget deferred to COMP-OBS-SURFACE. | PARTIAL |
| 144 | COMP-BUDGET-4 | **Policy integration:** Per-loop-type settings: `iterations.review.timeout` (15min), `iterations.coverage.timeout` (30min), `iterations.review.maxTotal` (20), `iterations.coverage.maxTotal` (50). Validated in settings-store. | COMPLETE |

**Dependencies:** None — enhances existing iteration loop infrastructure.

**Exit:** Iteration loops auto-abort when ceilings are hit. Cumulative budgets tracked across sessions. Ops strip shows live budget consumption. Policy controls ceilings per phase.

---

## COMP-OBS-SURFACE: Step Detail Surface — PLANNED

Render existing but invisible data in the UI. Retry counts, postcondition results, and filtered SDK events already flow through build-stream events or audit traces — they just aren't displayed. Pure frontend work, no backend changes.

Inspired by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s append-only audit trail — structured visibility into every evaluation tier and decision point.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 146 | COMP-OBS-SURFACE-1 | **Retry surface:** when a Stratum step fails postconditions and retries, show the failure reason and retry count in the message stream. Data already exists: `build.js` tracks `retries` per step, `ItemDetailPanel` shows `step.attempts` in audit trace. Add: retry badge on ops strip entry ("retry 2/3"), failure reason inline in build step message. Currently silent retries look like the agent is stuck. | PLANNED |
| 148 | COMP-OBS-SURFACE-2 | **Postcondition visibility:** `build_step_done` events already carry `violations` array from `response.violations` in `build.js`. Render in MessageCard: check name, pass/fail icon, violation detail (expandable). Currently opaque — user sees "step done" but not what was verified. | PLANNED |
| 150 | COMP-OBS-SURFACE-3 | **Filtered event toggle:** AgentStream.jsx suppresses `tool_progress`, `tool_use_summary`, `stream_event` (lines 226-228). Add a "verbose" toggle in agent bar settings. When on, these events render as dimmed, smaller-font entries. Off by default. Persisted in localStorage with other cockpit state. | PLANNED |
| 192 | COMP-OBS-SURFACE-4 | **Live iteration budget counters:** Ops strip shows live budget state during active iteration loops: "iteration 3/5, 12:34 / 15:00 timeout, 47 actions". Data already flows through `iterationUpdate` WS events and iterationState has `count`, `maxIterations`, `startedAt`, `wallClockTimeout`, `totalActions`, `maxActions`. Pure frontend — read from visionMessageHandler's `iterationStates` map, render in ops strip entry for the active build. | PLANNED |

**Dependencies:** None — all data already available in the event stream. Item 192 depends on COMP-BUDGET (COMPLETE).

**Exit:** Retry attempts visible with count badge. Postcondition checks shown per step. Verbose mode available for filtered events. Live iteration budget counters in ops strip. Default view stays clean.

---

## COMP-OBS-STREAM: Tool Result Streaming — PLANNED

Enrich the existing `tool_use_summary` event with full output content and render results attached to their `tool_use` blocks. Connectors truncate at 2KB. AgentStream pre-groups pairs by position. Visibility gated by COMP-OBS-SURFACE's verbose toggle.

See `docs/features/COMP-OBS-STREAM/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 145 | COMP-OBS-STREAM-1 | **Connector enrichment:** both connectors yield enriched `tool_use_summary` with `output` field (≤2KB). `result-normalizer.js` forwards to streamWriter (currently missing). Bridge adds `tool_use_summary` case to `_mapEvent`. | PLANNED |
| 151 | COMP-OBS-STREAM-2 | **UI rendering:** AgentStream pre-groups consecutive `tool_use` → `tool_use_summary` pairs. MessageCard renders `ToolResultBlock` (new component) attached below tool_use blocks. Collapsible: summary one-liner → first 20 lines → full content. Error detection with destructive styling. | PLANNED |
| 152 | COMP-OBS-STREAM-3 | **Verbose gating:** reuses COMP-OBS-SURFACE's verbose toggle (no separate toggle). Verbose off: summaries filtered, no results visible. Verbose on: summaries consumed by pre-grouping, results render attached to tool_use. `tool_progress` renders standalone dimmed. | PLANNED |

**Dependencies:** COMP-OBS-SURFACE (verbose toggle).

**Exit:** Tool results flow through enriched `tool_use_summary` events. Users see results attached to tool calls when verbose is on. Collapsed by default, expandable per-message.

---

## COMP-OBS-COST: Token and Cost Tracking — PLANNED

Per-step token usage and cost. Currently only session-level `total_cost_usd` appears in the result message. No per-step breakdown, no cumulative build cost, no input/output token split. Requires extending the Stratum audit format and the build-stream event schema.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 147 | COMP-OBS-COST-1 | **Audit format extension:** Stratum `stratum_audit` response gains per-step `input_tokens`, `output_tokens`, `cost_usd` fields. Populated from SDK result events accumulated during step execution. Stored in flow state alongside existing `duration_ms`. | PLANNED |
| 153 | COMP-OBS-COST-2 | **Build-stream cost events:** `build_step_done` events gain `tokens` and `cost_usd` fields from the audit data. `build_end` event gains `total_tokens` and `total_cost_usd` aggregated across all steps. | PLANNED |
| 154 | COMP-OBS-COST-3 | **Ops strip cost display:** cumulative build cost shown in ops strip during active builds (e.g., "$0.42"). Updates on each `build_step_done`. | PLANNED |
| 155 | COMP-OBS-COST-4 | **Context panel cost breakdown:** build detail in context panel shows per-step table: step name, input tokens, output tokens, cost, duration. Sortable by cost. Highlights most expensive step. | PLANNED |

**Dependencies:** None — standalone. Benefits from COMP-BUDGET (cumulative cost tracking reuses budget ledger).

**Exit:** Every build step reports token usage and cost. Ops strip shows running total. Context panel shows per-step breakdown. Most expensive steps are immediately visible.

---

## COMP-OBS-GATES: Tiered Gate Evaluation — PLANNED

Gate checks run in cost order with short-circuit on failure. Currently gates have no defined evaluation order — an expensive Codex review runs even when a cheap lint check would have caught the issue. This is both a pipeline change (ordering + short-circuit logic) and a UI change (showing which tiers ran).

Inspired by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s 7-9 tier evaluation pipeline — fast pattern matching first, expensive LLM verification last, first failure blocks.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 149 | COMP-OBS-GATES-1 | **Tier definition:** define 5 gate evaluation tiers: T0 schema/type validation, T1 lint/format, T2 test suite, T3 LLM review (Claude lenses), T4 cross-model review (Codex). Each tier declares cost category (fast/medium/expensive). Configured in `.compose/compose.json` under `gate_tiers`. | PLANNED |
| 156 | COMP-OBS-GATES-2 | **Short-circuit execution:** gate evaluator runs tiers in order. First tier failure halts evaluation — expensive tiers never run. Gate result includes: tiers_run, tier_that_failed (if any), tiers_skipped. | PLANNED |
| 157 | COMP-OBS-GATES-3 | **Gate detail view:** context panel gate review shows tier pipeline visualization — each tier as a dot (green=pass, red=fail, gray=skipped). Click tier for detail. Failed tier shows findings. Skipped tiers show "skipped — prior tier failed". | PLANNED |
| 158 | COMP-OBS-GATES-4 | **Cost savings tracking:** track and display estimated cost saved by short-circuiting (cost of skipped tiers). Accumulate in `.compose/data/gate-savings.json`. Surface in build summary. | PLANNED |

**Dependencies:** STRAT-REV (lens library provides T3/T4 tier implementations).

**Exit:** Gates evaluate cheap-to-expensive with short-circuit. Gate detail shows tier pipeline. Cost savings from short-circuiting are tracked and visible.

---

## Dogfooding Milestones

| Milestone | Description | Status |
|-----------|-------------|--------|
| D0: Bootstrap | Compose built manually, out-of-band. | COMPLETE |
| D1: Visible | Compose tracks its own development in the Vision Surface. Activity hooks fire during Compose development sessions. | COMPLETE |
| D2: Self-hosting | A planning session for Compose happens entirely inside Compose — inline docs, decisions recorded, items created. | PARTIAL |
| D3: Enforced | Phase transitions on Compose features are gated through Compose's own policy runtime. | PARTIAL |
| D4: Multi-agent | A feature is built end-to-end using multiple agents dispatched by Compose via Stratum. | PLANNED |

---

## Execution Sequencing

Proposed wave order for all PLANNED and PARTIAL features. Dependencies flow forward — each wave
unblocks the next. COMP-UX-2 (2d → 2a → 2c) runs as a **parallel track** throughout, not gated by
these waves.

### Parallel Track: COMP-UX-2 (IN_PROGRESS)

Cockpit refocus — make existing views functional. 2b COMPLETE, remaining chain: 2d (group field) → 2a (feature-aware filtering) → 2c (dashboard landing). Runs independently, no cross-dependencies with waves below.

### Wave 0: Close Partials

Finish half-done work before starting new features.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-UI-6 | 57 | S | Last COMP-UI item. Dead code removal, error boundaries. Closes COMP-UI. |
| COMP-DESIGN-1c | 85 | M | Live preview + human editing of design doc. Unblocks COMP-DESIGN-2. |
| COMP-DESIGN-1d | 86 | M | Research sidebar — inline web search + codebase scan. Parallel with 1c. |

**Unlocks:** D2 (self-hosting), COMP-DESIGN-2

### Wave 1: Pipeline Integrity

Cheap safety nets and mechanical enforcement. Highest leverage per line of code.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| STRAT-IMMUTABLE | 110–112, 140 | S | Checksum spec + gate criteria at flow start, fail on mutation. Prevents agent self-modification. |
| COMP-BUDGET | 141–144 | M | Iteration budget enforcement — auto-abort on ceiling hit, cumulative tracking, policy integration. |
| COMP-PLAN-VERIFY | 121–124 | M | Ensure function verifying plan items appear in diff. Catches missing deliverables + scope creep. |
| HOOK-CACHE | 103–106 | M | Formalize read-cache hook — mtime + range tracking, proper invalidation on Edit/Write/compact. |
| COMP-TRIAGE | 129–132 | S | Pre-flight task classification — tier + chain recommendation before work begins. Prevents under/over-scoping. |
| COMP-AGENT-CAPS | 133–136 | S | Agent capability profiles — read-only reviewers, tool restriction enforcement, violation logging. |

**Unlocks:** D3 (enforced)

### Wave 2: Review Quality

The highest-impact planned feature. Replaces single-pass review with parallel specialized lenses.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| STRAT-REV | 79–85 | L | Parallel multi-lens review: confidence gates, false-positive exclusions, fix-first classification, cross-model adversarial synthesis. Depends on STRAT-PAR (COMPLETE). |
| COMP-DESIGN-2 | 87 | S | `compose new` reads design doc. Unblocked by Wave 0. Small integration. |

**Unlocks:** COMP-HEALTH (needs review findings), COMP-BENCH (needs review pipeline)

### Wave 3: Developer Experience

Three independent tracks — can run in parallel.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-TEST-BOOTSTRAP | 125–128 | M | Auto-scaffold test framework + generate golden flows for test-less projects. |
| SKILL-PD | 96–99 | M | Three-tier progressive disclosure. ≥40% token reduction in multi-skill sessions. |
| COMP-CTX | 100–102 | M | Ambient context layer + staleness detection + decision log accumulation. |
| COMP-UX-3 | 137–139 | S | Workflow approachability — smart defaults, conversational gates, concise narration. |
| COMP-OBS-SURFACE | 146, 148, 150, 192 | S | Render existing invisible data: retries, postconditions, filtered events, live iteration budget counters. UI-only. |
| COMP-OBS-STREAM | 145, 151–152 | S | Tool result streaming through build-stream bridge + UI rendering. |
| COMP-CAPS-ENFORCE | 193–196 | M | Runtime capability violation detection — normalizer event tap, violation checker, enforcement mode. |
| COMP-IDEABOX (core) | 178–189 | L | Ideabox: scaffold, skill, full web UI (cards, lanes, triage, discussion, matrix, graph layer, analytics, promote wizard). |

**Unlocks:** COMP-HEALTH (needs COMP-CTX-2 for doc freshness signal)

### Wave 4: Quality Infrastructure

Quantified signals on top of the review and context layers from Waves 2–3.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-HEALTH | 117–120 | M | Weighted quality score (0–100) for gate decisions. Depends on STRAT-REV + COMP-CTX-2. |
| COMP-QA | 113–116 | M | Diff-aware QA scoping — test only changed routes, smoke-check adjacent. |
| STRAT-TIER | 88–91 | M | Model tier routing. Opus plans → Haiku executes → Sonnet reviews. Cost reduction. |
| COMP-OBS-COST | 147, 153–155 | M | Per-step token/cost tracking. Extends Stratum audit + build-stream + ops strip + context panel. |
| COMP-OBS-GATES | 149, 156–158 | M | Tiered gate evaluation with short-circuit. Depends on STRAT-REV. |

**Unlocks:** Cost-efficient multi-agent runs, meaningful benchmark comparisons, full agent visibility

### Wave 5: Scale

Multi-agent coordination, production hardening, benchmarking. Enables D4.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-TEAMS | 92–95 | L | Team presets, file ownership enforcement, team-lead pattern. Last piece before D4. |
| COMP-RT | 58–61 | L | Event coalescing, client hydration, connector trait split, session branching. |
| STRAT-VOCAB | 107–109 | S | Vocabulary enforcement — naming consistency across parallel agents. |
| COMP-BENCH | 62–66 | L | Model benchmark suite. Needs STRAT-REV + STRAT-TIER to be meaningful. |
| COMP-IDEABOX (scale) | 190–191 | M | Multi-project ideabox aggregation + external source import (GitHub, Linear). Needs workspace manifest. |

**Unlocks:** D4 (multi-agent dogfooding)

### Dependency Graph

```
Wave 0 ──→ Wave 2 (COMP-DESIGN-2 needs 1c)
Wave 0 ──→ D2
Wave 1 ──→ D3
Wave 2 ──→ Wave 4 (COMP-HEALTH needs STRAT-REV)
Wave 3 ──→ Wave 4 (COMP-HEALTH needs COMP-CTX-2)
Wave 4 ──→ Wave 5 (COMP-BENCH needs STRAT-REV + STRAT-TIER)
Wave 5 ──→ D4

Parallel: COMP-UX-2 runs independently throughout
Parallel: Wave 3 items are independent of each other
Parallel: Wave 1 items are independent of each other
```

---

## Key Documents

| Document | What it is |
|---|---|
| `docs/features/STRAT-1/design.md` | STRAT-1 full design — IR v0.2, executor, CLI, integration |
| `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` | Full Layer 0–7 design, dependency graph, open questions |
| `docs/plans/2026-02-26-architecture-foundation-plan.md` | Phase 4 items 18a–18h detail |
| `docs/plans/2026-03-05-18h-acceptance-gate.md` | Manual acceptance test checklist for Phase 4 gate |
| `docs/plans/2026-03-05-manual-test-guide.md` | Full manual test guide for all 15 system areas |
| `docs/features/feature-dev-v2/design.md` | Feature-dev v2 design — the skill that Phase 6 enforces |
| `../compose-ui/INTEGRATION-BRIEF.md` | COMP-UI merge spec — what to replace, keep, adopt, and drop |
| `docs/features/STRAT-PAR/design.md` | STRAT-PAR design — parallel task decomposition, IR v0.3, worktree isolation |
| `docs/features/COMP-BENCH/design.md` | COMP-BENCH design — seed repo, 5 features, scoring system, harness |
| [wshobson/agents](https://github.com/wshobson/agents) | Reference: plugin marketplace with progressive disclosure, model routing, team presets |
| [garrytan/gstack](https://github.com/garrytan/gstack) | Reference: role-specialized skill prompts, confidence gates, fix-first review, diff-aware QA, health scoring, plan-diff verification, test bootstrap |
| [Hub3r7/claude-code-orchestration-template](https://github.com/Hub3r7/claude-code-orchestration-template) | Reference: tiered task escalation, PASS/FAIL loop-back, read-only agent enforcement, agent notes persistence |
| [srf6413/cstack](https://github.com/srf6413/cstack) | Reference: zero-config agent orchestration, markdown-as-state, heartbeat meta-agent, conversational setup |
| [algorismo-au/lanekeep](https://github.com/algorismo-au/lanekeep) | Reference: local-first governance sidecar, tiered evaluation pipeline, self-protection rules, budget-as-enforcement, append-only audit |

---

## COMP-CONSENSUS: Multi-LLM Consensus Orchestration — PLANNED

Run multiple LLM providers on the same task and use a consensus gate (e.g., 75% agreement) to catch disagreements and hallucinations. Extends the existing connector architecture to dispatch the same prompt to 2–4 providers, collect responses, and score agreement. Disagreements surface for human review.

Inspired by [Claude Octopus](https://github.com/nyldn/claude-octopus) (2.4K stars) — multi-provider consensus pattern.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 159 | COMP-CONSENSUS-1 | **Consensus dispatcher:** send same prompt to N connectors in parallel. Reuses existing connector trait + STRAT-PAR parallel execution. Configurable provider list per consensus step. Timeout per provider with partial-result fallback. | PLANNED |
| 160 | COMP-CONSENSUS-2 | **Agreement scorer:** semantic similarity + structured diff across responses. Pairwise comparison matrix. Agreement threshold configurable (default 75%). Scoring method pluggable — exact match, embedding cosine, LLM-as-judge. | PLANNED |
| 161 | COMP-CONSENSUS-3 | **Disagreement gate:** surface divergent responses as a gate decision. When agreement falls below threshold, gate blocks with a structured comparison view: areas of agreement, areas of divergence, per-provider response excerpts. Human selects winner or requests re-run. | PLANNED |
| 162 | COMP-CONSENSUS-4 | **Pipeline integration:** optional `consensus: true` flag on any Stratum step. When enabled, step dispatches through consensus dispatcher instead of single connector. Consensus result replaces step output. Audit trace includes per-provider responses and agreement score. | PLANNED |

**Dependencies:** Phase 4 connectors (COMPLETE).

**Exit:** Any Stratum step can opt into multi-provider consensus. Agreement is scored and disagreements block as gates. Human resolves divergences. Audit trace captures all provider responses.

---

## COMP-AUTOHARNESS: Autonomous Agent Harness Optimization — PLANNED

Meta-agent that iterates on agent configurations (system prompts, tool lists, routing rules) against benchmarks overnight. Instead of hand-tuning, AutoHarness runs: modify config → benchmark → score → keep/discard → repeat. Complements COMP-BENCH (provides the benchmark infrastructure).

Inspired by [AutoAgent](https://github.com/kevinrgu/autoagent) (MarkTechPost) — hit #1 on SpreadsheetBench (96.5%) via autonomous iteration.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 163 | COMP-AUTOHARNESS-1 | **Harness definition format:** YAML describing mutable config dimensions — system prompt variants, tool subsets, routing rule alternatives, model tier overrides. Each dimension declares value space and constraints. Stored in `.compose/harness/<name>.yaml`. | PLANNED |
| 164 | COMP-AUTOHARNESS-2 | **Iteration loop:** modify → dispatch → score → keep/discard cycle. Selects dimension to mutate, generates variant, runs benchmark suite, compares score to current best. Keeps improvement, discards regression. Configurable iteration count and convergence threshold. | PLANNED |
| 165 | COMP-AUTOHARNESS-3 | **COMP-BENCH integration:** use bench suite as scoring oracle. Harness submits config variant → COMP-BENCH runs feature set → returns aggregate score. Harness compares against baseline. Requires COMP-BENCH seed repos and scoring rubric. | PLANNED |
| 166 | COMP-AUTOHARNESS-4 | **`compose optimize --feature X` CLI command:** runs harness overnight against a specific feature's benchmark. Reports: best config found, score delta vs baseline, iteration history, recommended changes. Writes result to `.compose/data/optimize-results/<feature>.json`. | PLANNED |

**Dependencies:** COMP-BENCH (benchmark infrastructure).

**Exit:** Agent configurations can be optimized automatically against benchmarks. CLI command runs overnight optimization. Results include score improvement and recommended config changes.

---

## STRAT-CODEGRAPH: Code Graph Context for Agents — PLANNED

Feed structural code understanding (call hierarchies, type relationships, dependency chains) into agent prompts during implementation phases. Reduces token waste by replacing broad file reads with targeted structural queries. Claimed: 32% cost reduction, 67% more code edits.

Sources: [Scope CLI](https://rynhardt-potgieter.github.io/scope/) (Rust-based code intelligence), [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (2.8K stars, MCP server with tree-sitter + graph DB).

| # | Feature | Item | Status |
|---|---------|------|--------|
| 167 | STRAT-CODEGRAPH-1 | **Code graph MCP integration:** configure Scope or CodeGraphContext as a tool available during `compose build`. Auto-detect project language, index on first run, incremental re-index on file changes. Graph queryable via MCP tool calls from any Stratum step. | PLANNED |
| 168 | STRAT-CODEGRAPH-2 | **Auto-query injection:** implementation steps auto-query the code graph for relevant context before dispatching agents. Given a task targeting file X, query: callers of X, types used by X, tests covering X. Inject as structured context block, replacing broad file reads. | PLANNED |
| 169 | STRAT-CODEGRAPH-3 | **Blast radius scoring:** use PageRank + co-change history to rank file importance relative to a change set. High-PageRank files get extra review attention. Co-change clusters surface "you probably also need to update Y" warnings. Inspired by [SoulForge](https://github.com/ProxySoul/soulforge) (174 stars). | PLANNED |

**Dependencies:** None — standalone integration.

**Exit:** Code graph is indexed and queryable during builds. Implementation steps receive targeted structural context. Blast radius scoring warns about high-impact changes. Token usage measurably reduced vs. broad file reads.

---

## COMP-SPECFLOW: Spec-Driven Development Artifacts — PLANNED

Formalize the proposal → spec → design → tasks artifact flow as a lightweight, iterative (not waterfall) pipeline. Each artifact type has a schema and a "good enough" quality bar. Artifacts are fluid — updated as understanding evolves, not frozen at creation. Compose already has lifecycle phases that map to this — this feature refines the artifact schemas and makes them usable outside Compose.

Inspired by [OpenSpec](https://github.com/Fission-AI/OpenSpec/) — spec-driven development framework.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 170 | COMP-SPECFLOW-1 | **Artifact schemas:** `proposal.md`, `spec.md`, `design.md`, `tasks.md` templates with required/optional sections. Each template declares: required fields, optional fields, cross-reference expectations, minimum content thresholds. Stored in `.compose/templates/artifacts/`. | PLANNED |
| 171 | COMP-SPECFLOW-2 | **Quality bar definitions:** per-artifact "good enough" checklist that gates can reference. Proposal: problem stated, audience identified, scope bounded. Spec: acceptance criteria as checkboxes, contract references. Design: component diagram, data flow, error handling. Tasks: dependencies ordered, effort estimated, file paths annotated `(new)`/`(existing)`. | PLANNED |
| 172 | COMP-SPECFLOW-3 | **`compose artifact validate` CLI:** schema + quality check without running a full build. Validates artifact against its template schema, checks required fields, flags missing cross-references, scores against quality bar. Returns structured pass/warn/fail per check. | PLANNED |
| 173 | COMP-SPECFLOW-4 | **Standalone export:** artifacts usable with any AI coding tool, not just Compose. Export strips Compose-specific metadata, preserves content and cross-references as relative links. Output formats: markdown (default), JSON (for tooling). `compose artifact export --format md`. | PLANNED |

**Dependencies:** COMP-DESIGN (design conversation — PARTIAL).

**Exit:** Artifact templates enforce consistent structure. Quality bars gate progression. CLI validates without full builds. Artifacts export cleanly for use outside Compose.

---

## COMP-REVIEW-ENH: Review Pipeline Enhancements — PLANNED

Enhance the existing STRAT-REV review pipeline with patterns from compound-engineering's multi-agent review system. Extends the lens library with adversarial reviewers, adds domain-aware conditional dispatch, and introduces plan deepening for pre-implementation validation.

Inspired by [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) (Every Inc) — ~50 agents, ~40 skills, Brainstorm→Plan→Work→Review→Compound lifecycle.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 174 | COMP-REVIEW-ENH-1 | **Adversarial review lens:** new lens that constructs failure scenarios to break implementations across component boundaries. Unlike existing lenses (diff-quality, security, contract-compliance) which check what IS there, this lens imagines what COULD go wrong. Feeds into existing merge + dedup step. | PLANNED |
| 175 | COMP-REVIEW-ENH-2 | **Domain-aware conditional dispatch:** review triage step activates lenses based on detected codebase characteristics — Rails reviewer only for Rails projects, migration reviewer only when migrations are present, security reviewer weighted higher when auth files change. Extends STRAT-REV-1 (triage step, COMPLETE) with richer activation rules. | PLANNED |
| 176 | COMP-REVIEW-ENH-3 | **Plan deepening:** re-run research agents against an existing plan to find gaps, without re-planning from scratch. `compose deepen FEAT-X` dispatches investigators that probe the plan for missing edge cases, untested paths, and implicit assumptions. Findings surface as plan amendments, not rewrites. | PLANNED |
| 177 | COMP-REVIEW-ENH-4 | **Document review personas:** pre-implementation gate with specialized document reviewers — coherence checker, feasibility assessor, scope guardian, product lens, design lens. Validates plan/spec quality before the build phase begins. Extends COMP-DESIGN (design conversation) with structured plan validation. | PLANNED |

**Dependencies:** STRAT-REV (parallel multi-lens review — PARTIAL), COMP-DESIGN (design conversation — PARTIAL)

**Exit:** Review pipeline includes adversarial scenarios. Lenses activate conditionally based on codebase. Plans can be deepened without replanning. Document review personas validate specs before build. Review quality improves without proportional cost increase.

---

## COMP-IDEABOX: Product Idea Capture & Triage — PLANNED

Built-in product ideabox for any Compose-managed project. `compose init` scaffolds an ideabox. Ideas are captured, clustered, triaged, and promoted into the roadmap — all through CLI or web UI. The ideabox is a Compose primitive, not a per-project custom file.

**Prior art:** SmartMemory has a mature `ideabox.md` (85+ ideas, clustered by feature, priority lenses, sequential IDs) and a `/ideabox` skill. This feature productizes that pattern into Compose so any project gets it out of the box.

| # | Feature | Item | Status |
|---|---------|------|--------|
| # | Feature | Item | Status |
|---|---------|------|--------|
| 178 | COMP-IDEABOX-1 | **`compose init` ideabox scaffold:** `compose init` creates `docs/product/ideabox.md` with conventions header (ID format, statuses, priorities, tags). Manifest gains `ideabox_path` field. `/ideabox` skill resolves path from manifest — works on any Compose project. Existing SmartMemory ideabox migrates cleanly (already follows the format). LLM-assisted auto-clustering on `/ideabox add` — suggests best-fit cluster or proposes a new one. | PLANNED |
| 179 | COMP-IDEABOX-2 | **Promote + kill workflows:** `/ideabox promote` creates feature folder in `docs/features/`, seeds `plan.md`, adds to ROADMAP.md, updates `roadmap-graph.html`, marks idea as PROMOTED. `/ideabox kill` moves to Killed section with reason and date. Works against any project's ideabox via manifest path. | PLANNED |
| 180 | COMP-IDEABOX-3 | **Priority lens support:** Persona-based triage lenses. `/ideabox triage --lens <name>` filters and ranks ideas through a target-user lens (e.g., "vibe-coder", "enterprise-admin"). Lenses stored as `ideabox-priority-<lens>.md` alongside the ideabox. `compose init` scaffolds an empty lens template. | PLANNED |
| 181 | COMP-IDEABOX-4 | **Design UI — Ideabox view:** New "Ideabox" tab in the Compose cockpit. Landing state: digest summary ("3 new since last visit, 12 untriaged, top P0 cluster: Graph Viewer"). Card-based layout with ideas grouped by cluster. Each card: ID, title, tags, priority badge, source, status. Drag-and-drop between priority lanes (P0/P1/P2/untriaged). Click card → context panel with full idea details, related roadmap features, promote/kill/discuss actions. Filter by tag, status, priority, source. Search bar. Killed ideas in a collapsible "Graveyard" section with reason, date, and resurrect action. | PLANNED |
| 182 | COMP-IDEABOX-5 | **Design UI — Triage flow:** Interactive triage mode in the web UI. Presents untriaged ideas one-at-a-time (or in batches). For each: full idea card + related context + LLM-detected duplicates ("similar to IDEA-12, IDEA-45"). Actions: assign priority, promote, kill, skip, discuss, merge (mark as duplicate of another idea). Progress indicator (N/total). Triage summary on completion. Priority lens selector to filter triage by persona. | PLANNED |
| 183 | COMP-IDEABOX-6 | **Design UI — Promote flow:** Wizard-style flow. Single idea: select or create feature ID → confirm roadmap placement → preview generated `plan.md` → confirm. Cluster merge-and-promote: select 2+ related ideas from same cluster → merge into single feature with combined context → promote as one. Updates ideabox.md, ROADMAP.md, and `roadmap-graph.html` in one operation. Visual confirmation with link to new feature in Graph/Tree view. | PLANNED |
| 184 | COMP-IDEABOX-7 | **Compose lifecycle integration:** `compose design` and `compose build` sessions auto-detect surfaced ideas and suggest `/ideabox add`. Auto-capture prompt (never auto-file). Promoted ideas feed into `compose new` as enriched intent — skipping questionnaire fields already answered in the idea. Ideabox stats visible in cockpit sidebar (N new, N triaged, N promoted). Staleness nudges: ideas untriaged for 14+ days surfaced in sidebar attention queue. Ideas with no activity for 30+ days flagged in triage. | PLANNED |
| 185 | COMP-IDEABOX-8 | **API + persistence:** REST API for ideabox CRUD (`GET/POST/PATCH/DELETE /api/ideabox`, `POST /api/ideabox/:id/discuss`, `POST /api/ideabox/:id/promote`, `POST /api/ideabox/:id/kill`). Markdown parser reads `ideabox.md` into structured JSON. WebSocket broadcast on ideabox state changes. File-based persistence in `ideabox.md` (source of truth) with parsed JSON cache in `.compose/data/ideabox-cache.json` for fast UI queries. | PLANNED |
| 186 | COMP-IDEABOX-9 | **Design UI — Discussion threads:** When an idea is DISCUSSING, context panel shows a lightweight threaded conversation. Each message: author (human or agent), timestamp, text. Discussion context preserved and included when the idea is eventually promoted (seeded into `plan.md` as "Prior discussion"). `/ideabox discuss IDEA-N <comment>` from CLI appends to thread. Stored inline in ideabox.md under the idea entry. | PLANNED |
| 187 | COMP-IDEABOX-10 | **Design UI — Impact/effort matrix:** Visual 2x2 scatter plot view alongside the card/lane view. X-axis: estimated effort (S/M/L, assignable during triage). Y-axis: estimated impact (low/medium/high). Ideas plotted as dots colored by cluster. Quadrant labels: Quick Wins (high impact, low effort), Big Bets (high impact, high effort), Fill-ins (low impact, low effort), Money Pits (low impact, high effort). Click dot → context panel. Drag dot to reassign effort/impact. | PLANNED |
| 188 | COMP-IDEABOX-11 | **Design UI — Roadmap graph integration:** Ideas appear as a ghost layer in the existing Graph view. Idea nodes rendered as dashed-border circles, smaller than feature nodes, colored by priority. Connected to roadmap features via "maps to" edges (dotted lines). Toggle: "Show ideas" checkbox in graph controls. Clicking an idea node opens ideabox context panel. Promoted ideas animate from idea node → solid feature node on promote. | PLANNED |
| 189 | COMP-IDEABOX-12 | **Design UI — Source analytics + digest:** Dashboard section in the Ideabox tab header. Source breakdown: bar chart of idea sources (competitor analysis, session insight, user feedback, research paper). Conversion funnel: NEW → DISCUSSING → PROMOTED (with kill rate). Cluster health: which clusters have the most ideas, most promoted, most killed. Time series: ideas added per week. All derived from ideabox.md metadata, no external tracking. | PLANNED |
| 190 | COMP-IDEABOX-13 | **Multi-project aggregation:** When Compose manages multiple projects (via parent workspace manifest or explicit project list), unified ideabox view across all projects. Ideas tagged with project origin. Cross-project dedup detection ("SmartMemory IDEA-42 and Forge IDEA-7 overlap"). Promote targets a specific project's roadmap. Filter by project. Requires: workspace-level manifest in parent repo listing Compose projects. | PLANNED |
| 191 | COMP-IDEABOX-14 | **External source sync:** `/ideabox sync` pulls and pushes ideas between ideabox and external systems. Supported sources: GitHub issues (by label, e.g. `idea` or `enhancement`), Linear tickets (by project/status), Jira issues (by JQL filter or label), clipboard (paste a URL or text block). Bidirectional: import creates IDEA-N with source attribution and backlink; promote/kill status syncs back to the external system (close issue, update ticket status). Dedup check on sync. Bulk import with preview before filing. Configurable sync schedule or manual trigger. | PLANNED |

**Dependencies:** COMP-UX-1 (context panel — COMPLETE), COMP-DESIGN (design conversation — PARTIAL for auto-capture in item 7)

**Exit:** Any Compose project gets an ideabox out of the box via `compose init`. CLI and web UI for full lifecycle: capture (with auto-clustering and dedup), triage (with persona lenses and impact/effort matrix), discuss (threaded conversations), promote (single or cluster-merge, wizard flow), kill (with graveyard and resurrect). Ideas visible as ghost layer in roadmap graph. Source analytics show where ideas come from and what converts. Multi-project aggregation for workspaces. External import from GitHub/Linear. Staleness nudges keep the backlog healthy.

---

# Stratum Roadmap (merged from stratum/ROADMAP.md)

**Last updated:** 2026-04-09

---

## Track 1 — Python Library (`stratum-py`)

| ID | Feature | Status |
|---|---|---|
| STRAT-DECORATORS (T1-1) | `@infer`, `@contract`, `@flow`, `@compute` decorators | COMPLETE |
| STRAT-REFINE (T1-2) | `@refine` convergence loop | COMPLETE |
| STRAT-COMBINATORS (T1-3) | `parallel()`, `race()`, `debate()` | COMPLETE |
| STRAT-HITL (T1-4) | `await_human()` HITL gate | COMPLETE |
| STRAT-QUORUM (T1-5) | `quorum=` on `@infer` | COMPLETE |
| STRAT-PROBABILISTIC (T1-6) | `stable=False` → `Probabilistic[T]` | COMPLETE |
| STRAT-BUDGET-CORE (T1-7) | `Budget(ms=, usd=, tokens=)` enforcement | COMPLETE |
| STRAT-TRACE (T1-8) | OTLP trace export (no OTel SDK) | COMPLETE |
| STRAT-OPAQUE (T1-9) | `opaque[T]` annotation | COMPLETE |
| STRAT-PYPI (T1-10) | Published to PyPI as `stratum-py` 0.1.1 | COMPLETE |
| STRAT-E2E-VALIDATION (T1-11) | End-to-end validation against real LLM | COMPLETE |
| STRAT-TS-PORT (T1-12) | TypeScript library (`stratum-ts` / `@smartmemory/stratum`). **Primary driver: packaging ergonomics** — compose (already TS, sole consumer) bundles it as an npm dep and drops the Python 3.10+ runtime requirement; secondary win = collapse the Python↔TS MCP/process seam (shared contract types, in-process spec validation + postcondition checks). Clean break OK — compose is the only consumer; deprecate `stratum-py`/`stratum-mcp` on PyPI after. **De-risked 2026-06-02 (litellm-coverage spike):** technically unblocked — `litellm` is only a 3-function transport across the whole core (`litellm.acompletion` in `executor.py`, `litellm.completion` in judge/postmortem, `litellm.completion_cost`); NO Router/fallback/model-registration/caching used (retries, budget, prompt-caching, provider detection are hand-rolled in Stratum). Vercel AI SDK maps everything (`generateObject`+zod is *cleaner* than the current force-tool→`json.loads`→pydantic path; provider routing, anthropic thinking/effort, `cache_control` via `providerOptions`/`createProviderRegistry`). One real gap: cost calc — AI SDK gives token usage but no $ table, so re-home `completion_cost()` with a small pricing map (tokenlens/llm-cost). **Parked on time/effort grounds — no compulsion yet.** Flip condition: the Python↔TS seam starts actively blocking compose work (repeated contract drift, or wanting in-process calls on a hot path). See [[project_stratum_ts_port]]. | PARKED |
| STRAT-DSPY (T1-13) | DSPy prompt optimization integration | PLANNED |
| STRAT-TEMPORAL (T1-14) | Temporal durable execution integration | PLANNED |
| STRAT-RAY (T1-15) | Ray distributed agents integration | PLANNED |

---

## Track 2 — MCP Server + Claude Code (`stratum-mcp`)

### Core Server

| ID | Feature | Status |
|---|---|---|
| T2-1 | `stratum_plan` MCP tool | COMPLETE |
| T2-2 | `stratum_step_done` MCP tool | COMPLETE |
| T2-3 | `stratum_audit` MCP tool | COMPLETE |
| T2-4 | `stratum_validate` MCP tool | COMPLETE |
| T2-5 | `FlowState` in-memory execution state | COMPLETE |
| T2-6 | `ensure` expression evaluation (Python, dunder-blocked) | COMPLETE |
| T2-7 | `$.input` / `$.steps` reference resolution | COMPLETE |
| T2-8 | Kahn's topological sort on `depends_on` + implicit refs | COMPLETE |
| T2-9 | `stratum-mcp install` CLI command | COMPLETE |
| T2-10 | `stratum-mcp validate <file>` CLI command | COMPLETE |
| T2-11 | Published to PyPI as `stratum-mcp` 0.2.18 | COMPLETE |
| T2-12 | 537 passing tests (contracts, invariants, integration) | COMPLETE |
| T2-13 | `stratum-mcp uninstall` command | COMPLETE |
| T2-14 | FlowState persistence (survive MCP server restart) | COMPLETE |
| T2-15 | `ensure` file-aware builtins (`file_exists`, `file_contains`) | COMPLETE |
| T2-16 | Step output contracts (schema validation in `stratum_step_done`) | COMPLETE |
| T2-17 | `stratum_commit` — explicit flow-state checkpoint with label | COMPLETE |
| T2-18 | `stratum_revert` — roll back to a named checkpoint, trace records revert | COMPLETE |
| T2-19 | IR v0.2 — `mode: gate`, `on_approve/on_revise/on_kill` routing, round archiving, `max_rounds`, `skip_if/skip_reason`, `terminal_status` | COMPLETE |
| T2-20 | `stratum_gate_resolve` MCP tool — approve/revise/kill with `resolved_by`; GateRecord in trace | COMPLETE |
| T2-21 | `stratum_check_timeouts` MCP tool — auto-kill gate steps that exceed `timeout`; `resolved_by: system` | COMPLETE |
| T2-22 | IR v0.2 semantic validation — gate function/step invariants, `on_revise` topological ordering, `declared_routing`, `retries_explicit` | COMPLETE |
| T2-23 | 305 passing tests; `test_gate_api.py`, `test_gate_revise.py`, v0.2 invariant tests in `test_ir_schema.py` | COMPLETE |
| T2-24 | STRAT-ENG-4: Per-step iteration — `max_iterations`, `exit_criterion`, `start/report/abort_iteration`, `iteration_outcome` handoff, `archived_iterations`; 378 tests | COMPLETE |
| T2-25 | STRAT-ENG-5: Routing and composition — `on_fail`/`next` step routing, `flow:` sub-execution with child FlowState lifecycle, child audit snapshots, result unwrapping; 414 tests | COMPLETE |
| T2-26 | Stagnation detection: SHA256 fingerprinting of iteration results, configurable window, `exit_stagnation` priority ordering | COMPLETE |
| T2-27 | Pre-execution guardrails: regex patterns on functions/steps, fail-closed semantics, ReDoS timeout, parse-time validation | COMPLETE |
| T2-28 | STRAT-CERT: `reasoning_template` — structured reasoning sections in step results, validation in `step_done` pipeline, rejected on flow/parallel_dispatch steps | COMPLETE |
| T2-29 | STRAT-SCORE: `score_expr` — numeric scoring for iteration loops, best-result tracking, score-aware stagnation, enriched `exit_criterion` context (`best_score`, `prior_scores`, `iteration`), best-result auto-select and substitution in `process_step_result` | COMPLETE |

### Parallel Execution (IR v0.3)

Automatic task decomposition and concurrent dispatch. Bumps IR from v0.2 to v0.3 (backward-compatible superset). See `/Users/ruze/reg/my/forge/compose/docs/features/STRAT-PAR/design.md`.

| ID | Feature | Status |
|---|---|---|
| T2-PAR-1 | IR v0.3 schema: `decompose` and `parallel_dispatch` step types, `TaskGraph` contract, backward-compatible superset of v0.2. 20 tests. | COMPLETE |
| T2-PAR-2 | Executor decompose/parallel_dispatch handling: decompose returns `execute_step` with `step_mode: "decompose"`, parallel_dispatch resolves source ref and returns task graph. `no_file_conflicts` built-in with transitive dependency detection. 10 tests. | COMPLETE |
| T2-PAR-3 | `stratum_parallel_done` MCP tool: batch result reporting with require semantics (all/any/N), merge conflict detection, ensure evaluation. | COMPLETE |
| T2-PAR-4 | Semantic validation: decompose requires agent+intent+output_contract, parallel_dispatch requires source+intent_template, parallel_dispatch-only fields forbidden on other step types. | COMPLETE |
| T2-PAR-5 | **`stratum-mcp migrate`**: CLI command to upgrade pipeline specs across IR versions. Detects current version, applies known transforms (e.g. v0.2→v0.3: insert decompose, fix `on_approve` targets, update output refs), validates result, writes back or `--dry-run`. Prevents silent breakage when IR changes are deployed across projects. | PLANNED |
| T2-PAR-6 | `isolation: "none"` option for parallel_dispatch steps | COMPLETE |

### Compose Integration

Enable the `compose` skill to use Stratum as its execution backbone. See `docs/plans/2026-02-24-compose-stratum-integration-plan.md`.

| ID | Feature | Status |
|---|---|---|
| T2-F1 | Result schema convention for compose steps | COMPLETE |
| T2-F2 | `ensure` file-aware builtins (→ T2-15) | COMPLETE |
| T2-F3 | Step output contracts (→ T2-16) | COMPLETE |
| T2-F4 | Compose skill emits `.stratum.yaml` | COMPLETE |
| T2-F5 | Fold `agent_run` into `stratum-mcp` — Stratum dispatches to codex/claude directly via Python connectors (`opencode` subprocess + Anthropic SDK), eliminating the separate Node.js agent MCP server. Closes the enforcement gap where the agent can bypass review dispatch. | PLANNED |

### Skills

| ID | Skill | Status |
|---|---|---|
| T2-S1 | `/stratum-onboard` — read codebase cold, write MEMORY.md | COMPLETE |
| T2-S2 | `/stratum-plan` — design feature, gate before implementation | COMPLETE |
| T2-S3 | `/stratum-feature` — read → design → implement → tests | COMPLETE |
| T2-S4 | `/stratum-review` — three-pass code review | COMPLETE |
| T2-S5 | `/stratum-debug` — hypothesis formation and elimination | COMPLETE |
| T2-S6 | `/stratum-refactor` — extraction order planning | COMPLETE |
| T2-S7 | `/stratum-migrate` — rewrite bare LLM calls as `@infer` | COMPLETE |
| T2-S8 | `/stratum-test` — write test suite for existing code | COMPLETE |
| T2-S9 | `/stratum-learn` — extract patterns from session transcripts | COMPLETE |
| T2-S10 | `/compose` rewrite — emits `.stratum.yaml`, uses `stratum_plan` loop (→ T2-F4) | COMPLETE |

### Memory & Hooks

Three tiers — default is zero-dependency. Opt-in tiers add semantic retrieval without changing the skill interface.

#### Tier 1 — MEMORY.md (default, zero dependencies)

| ID | Feature | Status |
|---|---|---|
| T2-M1 | `## Memory` sections in all 9 skills — read/write MEMORY.md | COMPLETE |
| T2-M2 | `SessionStart` hook — auto-inject relevant MEMORY.md entries at session open | COMPLETE |
| T2-M3 | `Stop` hook — auto-append session summary to MEMORY.md at session close | COMPLETE |
| T2-M4 | `PostToolUseFailure` hook — auto-record ensure failures and tool errors | COMPLETE |

#### Tier 2 — SmartMemory lite (opt-in, pip only, no Docker)

`pip install smartmemory[lite]` — local SQLite graph + usearch vectors + markdown notes at `~/.smartmemory/`. No network calls, no Docker, no LLM extraction. Uses `lite_context()` / `create_lite_memory()` directly. Replaces MEMORY.md read/write with `memory.search()` / `memory.ingest()`.

| ID | Feature | Status |
|---|---|---|
| T2-SM1 | `SessionStart` hook — `memory.search()` for project-relevant context | COMPLETE |
| T2-SM2 | `Stop` hook — `memory.ingest()` session summary as `episodic` memory | COMPLETE |
| T2-SM3 | `PostToolUseFailure` hook — `memory.ingest()` failures as `observation` memory | COMPLETE |
| T2-SM4 | Skills use `memory.search()` instead of MEMORY.md when lite backend configured | COMPLETE |

#### Tier 3 — SmartMemory full (opt-in, requires Docker stack or remote API)

Full SmartMemory service — multi-tenant, LLM entity extraction, Wikidata grounding, REST API. Uses `smartmemory-mcp` HTTP client. Same hook/skill interface as Tier 2 but backed by the remote API.

| ID | Feature | Status |
|---|---|---|
| T2-SM5 | `SessionStart` / `Stop` / `PostToolUseFailure` hooks via `smartmemory-mcp` | PARKED |
| T2-SM6 | Skills use `memory_search` MCP tool when full backend configured | PARKED |

---

## Track 3 — Compose + Stratum + spec-kit Substrate

Refactor Compose to use Stratum as its execution backbone and spec-kit as its specification layer. The result is a clean three-layer stack:

```
spec-kit  →  specification layer   (spec.md, plan.md, tasks/)
stratum   →  execution layer       (.stratum.yaml, postconditions, audit)
compose     →  orchestration layer   (UI, Vision Surface, agent coordination)
```

See `docs/features/compose-speckit-substrate/design.md` for full architecture.

### Pipeline Authoring Model

Users do not write `.stratum.yaml` — it is IR. Three user interfaces replace it: Python
decorators (`@pipeline`/`@phase`) for library users, skill invocation for Claude Code users,
and `stratum.toml` for policy overrides. See `docs/features/pipeline-authoring/design.md`.

| ID | Feature | Status |
|---|---|---|
| T3-A1 | Pipeline authoring model design | COMPLETE |
| T3-A2 | `@pipeline` / `@phase` Python decorators in `stratum-py` | COMPLETE |
| T3-A3 | Capability tiers (`Capability`, `Policy` enums) in `stratum-py` | COMPLETE |
| T3-A4 | `stratum.toml` project config — policy overrides, capability mapping | COMPLETE |
| T3-A5 | Run workspace convention — `.stratum/runs/` output passing | COMPLETE |
| T3-A6 | Skill-driven pipeline execution — no YAML visible to user | COMPLETE |
| T3-A7 | File-based gate protocol — `.gate` / `.gate.approved` convention | COMPLETE |
| T3-A8 | `stratum-ui` — monitor, gate, edit, generate (separate project) | COMPLETE |

### Bridge: Task→Step Compiler

| ID | Feature | Status |
|---|---|---|
| T3-1 | Architecture design: three-layer stack | COMPLETE |
| T3-2 | Task→step compiler: `tasks/*.md` → `.stratum.yaml` (acceptance criteria → `ensure` expressions) | COMPLETE |
| T3-3 | `/stratum-speckit` bridge skill — drives spec-kit phases through stratum, emits compiled flow | COMPLETE |

### Compose Skill Refactor

| ID | Feature | Status |
|---|---|---|
| T3-4 | Adopt spec-kit artifact format: design phases produce `spec.md`, `plan.md`, `tasks/` under `.specify/` | COMPLETE |
| T3-5 | Replace custom phase artifacts with spec-kit canonical structure | COMPLETE |
| T3-6 | `stratum-build` skill compiles `tasks/` → `.stratum.yaml`, drives execution via `stratum_plan` loop | COMPLETE |

### Compose Web App Integration

| ID | Feature | Status |
|---|---|---|
| T3-7 | Vision Surface seeds work items from `.specify/` directory on load | COMPLETE |
| T3-8 | Vision Surface reflects live stratum flow state (step status, `ensure` violations = blockers) | COMPLETE |
| T3-9 | Audit trace from `stratum_audit` surfaces in session log / item evidence | COMPLETE |

---

## Track 4 — Consolidation

Merge `coder-compose` into this repo. Restructure developer configuration (`CLAUDE.md`, rules,
skills, memory) from monolithic files into pointed sub-docs.

| ID | Item | Status |
|---|---|---|
| T4-1 | Fresh copy of `coder-compose` content into `app/` — no git history carry-over | COMPLETE |
| T4-2 | Merge `coder-compose/docs/` into `docs/app/` — plans, features, decisions, journal | COMPLETE |
| T4-3 | `CLAUDE.md` restructure — unified pointer doc covering Python lib + MCP + web app | COMPLETE |
| T4-4 | Archive `coder-compose` repo — canonical location is now `app/` in this repo | COMPLETE |
| T4-5 | Extract `app/` to standalone compose project at `/Users/ruze/reg/my/forge/compose/` | COMPLETE |

---

## Track 5 — Pipeline Runtime

Implement the pipeline authoring model. Users define pipelines via Python decorators or skills,
never by writing `.stratum.yaml` by hand. See `docs/features/pipeline-authoring/design.md`.

| ID | Item | Status |
|---|---|---|
| T5-1 | `Capability` and `Policy` enums in `stratum-py` | COMPLETE |
| T5-2 | `@pipeline` / `@phase` decorators — metadata capture and validation (IR compilation is separate; needed for MCP execution mode, not Python harness) | COMPLETE |
| T5-3 | Named assertion vocabulary — `tests_pass`, `files_changed`, `approved`, `file_exists`, etc. | COMPLETE |
| T5-4 | `stratum.toml` project config — policy overrides, capability mapping, connector routing | COMPLETE |
| T5-5 | Run workspace convention — `.stratum/runs/{run-id}/{phase-id}.json` output passing | COMPLETE |
| T5-6 | File-based gate protocol — `.gate` / `.gate.approved` / `.gate.rejected` | COMPLETE |
| T5-7 | Pipeline runtime loop — `run_pipeline()` drives `@pipeline` classes through phases via `Connector` | COMPLETE |

---

## Evaluation & Benchmarks

Answers two questions: (1) is Stratum/Compose better than not using it, and (2) which memory tier is better for a given workload.

### Stratum/Compose vs. baseline

The `stratum_audit` trace is the built-in instrument — attempt counts, step durations, ensure failure reasons. The missing piece is a standardized task battery and comparison harness.

| ID | Item | Status |
|---|---|---|
| E-0 | Difficulty taxonomy — collect empirically difficult tasks from session transcripts; classify by failure dimension (cascading incorrectness, ambiguous spec, stale blueprint, self-reporting temptation, multi-file coordination, non-obvious constraint, cross-session dependency, noisy memory) | PLANNED |
| E-1 | Task battery — 5-10 tasks selected from E-0 taxonomy, covering each difficulty dimension, with known-correct outputs | PLANNED |
| E-2 | Automated scorer — `file_exists`, test pass/fail, `compose-reviewer` confidence | PLANNED |
| E-3 | Comparison harness — run task with Stratum vs. without, collect audit traces | PLANNED |
| E-4 | Metrics report — artifact completeness, retry rate, recovery rate, abandonment rate | PLANNED |

### Memory tier comparison

Retrieval precision benchmark: pre-load known patterns into each backend, run tasks that require applying those patterns without being told explicitly, score whether the agent applied them.

| ID | Item | Status |
|---|---|---|
| E-5 | Pattern fixture set — known project-specific patterns to pre-load into each backend | PLANNED |
| E-6 | Retrieval precision test — did agent apply the right pattern without explicit prompting? | PLANNED |
| E-7 | Context efficiency metric — tokens injected vs. tokens actually used per session | PLANNED |
| E-8 | Tier comparison report — Tier 1 vs. Tier 2 on precision, token cost, task outcome | PLANNED |

---

## Distribution & Discovery

| ID | Item | Status |
|---|---|---|
| D-1 | PyPI publish `stratum-py` | COMPLETE |
| D-2 | PyPI publish `stratum-mcp` | COMPLETE |
| D-3 | PyPI metadata (description, readme, license, authors, URLs) | COMPLETE |
| D-4 | Submit `stratum-mcp` to MCP server registry | PLANNED |
| D-5 | Post tutorial to Hacker News / r/ClaudeAI | PLANNED |
| D-6 | Codex integration post (`blog/stratum-in-codex.md`) | COMPLETE |

---

## Pre-release Debt (stratum-mcp 0.2.0)

Must be resolved before publishing 0.2.0 to PyPI.

### Must Fix

| ID | Item | Location | Status |
|---|---|---|---|
| R-1 | `stratum-mcp serve` without `[serve]` extra raises raw `ModuleNotFoundError`; catch `ImportError` and print install hint | `server.py:909` | COMPLETE |
| R-2 | `test_serve.py` imports `fastapi.testclient` unconditionally — breaks `pytest` on base install; guard with `pytest.importorskip` or optional marker | `tests/test_serve.py:11` | COMPLETE |
| R-3 | `_cmd_validate` swallows `OSError` silently — permission-denied on a path is treated as inline YAML; surface file errors explicitly | `server.py:897` | COMPLETE |

### Should Fix

| ID | Item | Location | Status |
|---|---|---|---|
| R-4 | CORS `allow_origins=["*"]` hardcoded — make configurable via `create_app()` parameter | `serve.py:450` | COMPLETE |
| R-5 | `"record_type"` legacy alias in `_record_from_dict` — dead compat shim; 0.2.0 is a clean break | `executor.py:294` | COMPLETE |
| R-6 | `pydantic` not declared in `[serve]` extras — undeclared transitive dependency | `pyproject.toml:29` | COMPLETE |
| R-7 | `stratum_gate_resolve` complete path returns no `output` field; `stratum_step_done` complete path does — decide canonical shape and align | `server.py:259`, `server.py:151` | COMPLETE |
| R-8 | No tests for `stratum_draft_pipeline` MCP tool | `server.py:518` | COMPLETE |

### Cleanup (low risk, do while here)

| ID | Item | Location | Status |
|---|---|---|---|
| R-9 | `first_step_id` computed but never used after `round_start_step_id=None` change | `executor.py:492` | COMPLETE |
| R-10 | `import importlib.resources` dead import inside `_cmd_setup` | `server.py:731` | COMPLETE |

---

## Prioritization Notes

**Recently completed (since 2026-03-13):**
- T2-PAR-1 through T2-PAR-4, T2-PAR-6 — IR v0.3 parallel execution shipped
- T2-28 STRAT-CERT — structured reasoning templates with validation
- T2-29 STRAT-SCORE — numeric scoring for iteration loops (hill-climbing optimization)
- `stratum-mcp` 0.2.18 published to PyPI
- 537 passing tests

**Next up (as of 2026-04-09):**
- D-4 (MCP registry), D-5 (HN/r/ClaudeAI post)
- T2-F5 — Fold `agent_run` into stratum-mcp (closes enforcement gap)
- T2-PAR-5 — `stratum-mcp migrate` CLI

**Longer horizon:**
- STRAT-TS-PORT (T1-12, TypeScript) — unlocks Cursor/Windsurf users; significant effort
- E-0 → E-8 (Evaluation & Benchmarks) — difficulty taxonomy, task battery, comparison harness
- STRAT-DSPY / STRAT-TEMPORAL / STRAT-RAY (T1-13/14/15) — Phase 3 per original design


---

<a id="archive-update-2026-09-09"></a>

## Archive update — 2026-09-09

Moved from the active Forge roadmap without re-evaluating feature status. The dated sections
above are historical snapshots; the entries below preserve the later reconciliation evidence.
Parked and deferred entries retain their reactivation conditions.

### Shipment and reconciliation history

**Last updated:** 2026-06-15 (**COMP-MIGRATE-UNIFY-VISION + FORGE-ROADMAP-RETIRE-STORE shipped** — two roadmap-store cleanups, both Codex-CLEAN. **UNIFY-VISION** (compose `fd7722a`) folds the duplicated vision-state transforms (`featureCode→lifecycle.featureCode` + gate-outcome-normalize) into the shared `lib/state-migrations.js` registry: one implementation reused by both server `_load` paths AND the eager `runStateMigrations` runner, a `target` discriminator + single `stateVersion` stamp, the eager runner now walks cold `vision-state.json` too; byte-identical (golden + load-vs-eager parity). **RETIRE-STORE** (compose `e700ec9`) adds a `capabilities.lifecycle:false` short-circuit at the `loadVisionState()` chokepoint so a narrative-owned workspace's whole MCP vision-read surface (`get_vision_items` + dependents) returns empty — `validate_project` deliberately not gated (drift detector reads raw sources). Forge-top flipped to `lifecycle:false` + its frozen `vision-state.json` archived → live-verified `get_vision_items`=0 (was the stale set), validate clean. **⚠ live MCP servers need a restart** to read the new flag (no-kill-ports — user action; the archive retires reads immediately). Active lane empty again. — **Earlier 2026-06-10:** **STRAT-JUDGE-T3-READJAIL closed at COMPLETE** — status flip PARTIAL→COMPLETE, no code change: all in-scope work shipped (macOS codex read-jail live via CODEXNEST, blocking live gate PASSED); the sole residual — Linux/CI coverage — was already broken out 2026-05-18 as the PARKED `STRAT-JUDGE-T3-READJAIL-LINUX` ticket, which now solely owns it. With this flip the active lane is empty.) **Earlier 2026-06-09** (**FORGE-ROADMAP-SYNC shipped** — the forge-top roadmap is now self-correcting. Marked the workspace **narrative-owned** (`roadmap.narrative: true`): the prose ROADMAP is the single source of truth, the typed writer returns it verbatim and can't clobber it, and `validate_project` now suppresses 193 prose↔feature.json correspondence findings that were never real drift. Reconciled the **29 cross-layer status mismatches → 0** (7 stale `feature.json` corrected to match the verified ROADMAP — STRAT-PAR-2..6 + COMP-MCP-VALIDATE → COMPLETE, COMP-BOUNDARY-MAP → SUPERSEDED — then projected into vision-state via `validate --fix`). Added `scripts/roadmap-drift-check.mjs` + daily cron as the missing drift trigger, since forge root isn't git so the product-repo pre-push gate can't fire here. Follow-up `FORGE-ROADMAP-RETIRE-STORE` filed for the full store retirement. Root-caused from a `/roadmap` session where the stale-row pattern was traced to three unlinked status representations. `docs/features/FORGE-ROADMAP-SYNC/report.md`.) **Earlier 2026-06-05** (**COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY shipped** — the deferred D4/D5 of COMP-PAR-MERGE-QUEUE-CONSUMER: `executeParallelDispatch` now owns a bounded, bounce-injected retry loop (model C — failed-only re-run, successful diffs replayed onto a per-round anchor commit, base restored to an entry snapshot between rounds → no cross-round double-apply); the single-agent mis-route of a parallel `ensure_failed` is fixed for both outer loops via an explicit `_parallelRetriesExhausted` marker; default-OFF `pre_merge_gate` opt-in wired. Retry is worktree-only (review lenses byte-identical) + gated on a guaranteed-clean base. Also fixed a parent latent bug: the `.owner` marker was captured into every task diff (multi-task merges conflicted). Compose 3426 green (17 new tests); Codex impl-review CLEAN (4 rounds). `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY/`. — Earlier same week: **COMP-PAR-MERGE-QUEUE-CONSUMER shipped (v1 = gate + surfacing)** — extends the per-task pre-merge gate to Compose's consumer-dispatch path (`executeParallelDispatch` → `stratum_parallel_done`, the default for `compose build`): Stratum surfaces the resolved `pre_merge_verify` on the dispatch envelope + accepts a structured `parallel_done` merge_status; Compose's `runPreMergeGateLocal` gates each task worktree before diff capture. **Codex design gate** caught the consumer retry state-model gap (Compose applies successes to base before `parallelDone`) → v1 narrowed to gate+surfacing, retry-loop deferred to `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY`. Stratum 1413 + compose 3395 green; Codex CLEAN. — Earlier same day: **COMP-PAR-MERGE-QUEUE shipped — closes COMP-GSD-3 + the COMP-GSD umbrella.** Per-task pre-merge verify gate (`pre_merge_verify`, default lint+build) runs in each `parallel_dispatch` task's worktree before its diff merges; gate-failed + merge-conflict produce structured `ParMergeBounce` records surfaced on `ensure_failed.bounced_tasks[]` AND injected into the re-dispatched task's prompt **server-side** (Stratum `_render_prompt` — the server re-resolves tasks per re-dispatch, so the blueprint's Compose-side `buildRetryPrompt` delivery couldn't work and was removed as dead). Cross-repo stratum+compose; v1 server-dispatch. **Codex review round 1 falsified two blueprint assumptions** (must-fix): bounce delivery moved server-side, and `executeParallelDispatchServer` now owns the parallel retry loop (re-dispatch on `ensure_failed`) — the old behavior leaked parallel failures to the single-agent retry / threw in runGsd. Stratum 1409 + compose 3401 green; Codex 3 rounds → CLEAN; not a stale-row instance (genuinely built). Follow-up filed `COMP-PAR-MERGE-QUEUE-CONSUMER`. `docs/features/COMP-PAR-MERGE-QUEUE/report.md`.) **Earlier 2026-06-02** (**STRAT-GUARD + COMP-MCP-ENFORCE reconciled — verify-first vs disk.** Both rows were stale. **STRAT-GUARD** (filed today as a forge-top PLANNED row) shipped the **same day**: `report.md` Status SHIPPED, stratum `4951822` + CLI seam `f822f2e` on `main`, **5** MCP tools `stratum_guard_{register,transition,override,migrate,history}` (the design said 4; `migrate` was added as the token-gated re-registration path) + a `stratum-mcp guard` CLI subcommand, 59+7 tests, full `stratum-mcp/tests/` 1370 passed → reconciled PLANNED→COMPLETE (**9th confirmed stale-forge-top-row instance**, [[feedback_verify_roadmap_rows_vs_disk]]). Its first consumer, compose `COMP-MCP-ENFORCE`, was likewise stale (compose ROADMAP + feature.json PARTIAL, description still "Slices 2–4 PLANNED"), but the compose git log + CHANGELOG show **all of Slices 1–4 shipped & merged to `main`** (`b6bb4d6`/`a9212e0`/`0ccceb7`/`136f0db`) plus Part B as `COMP-MCP-ENFORCE-1` (`f7be0dd`), with `capabilities.guard` **enabled** (`ea02d85`, `.compose/compose.json`) — reconciled PARTIAL→COMPLETE through the typed `set_feature_status` path, dogfooding the now-live guard verdict gate (it accepted the commit-bound completion). No code built — both verified already-shipped on disk.) **Earlier 2026-05-30** (**STRAT-WORKFLOW-PIPELINE shipped** — ticket 3 of 6 of the STRAT-WORKFLOW epic. New `pipeline` IR step type giving no-barrier stage staggering (item A in stage 2 while item B in stage 0); **desugars** `source × stages` into the existing `depends_on` graph and reuses `ParallelExecutor` — no second concurrency engine. v1: linear stages, 1:1 per item, per-stage cross-model `agent`, `{prev}`/`{prev_raw}` threading, item-scoped `require` + per-item failure isolation, `items[]` canonical aggregate. Gap verified real (the `depends_on`-waiters-don't-hold-slots mechanic existed; stage abstraction/threading/authoring did not). 27 tests, combined suite 1767 passed; Codex design 6 / blueprint 4 / impl 2 rounds → CLEAN (each tier caught a class the prior missed: require/threading semantics → 2nd live cert path + 2-site validation gap → require-bypass + empty-string hole). Branch `strat-workflow-pipeline`; CHANGELOG `[STRAT-WORKFLOW-PIPELINE]`; `docs/features/STRAT-WORKFLOW-PIPELINE/`. Epic COMPLETE: `-NAMING`/`-IMPERATIVE`/`-BUDGET`/`-BUDGET-DOLLARS`/`-PIPELINE*`/`-RESUME`/`-BG` all shipped. Only `-PIPELINE-FANOUT-DYNAMIC` remains, deferred to the TS port (verify-first: architecturally awkward in Python asyncio; bounded fan-out covers ~90%). New follow-ups filed: `-PIPELINE-FANOUT`, `-PIPELINE-STAGEOPTS`.) **Earlier 2026-05-29** (**STRAT-WORKFLOW filed** — new epic from evaluating Claude Code's dynamic workflows against Stratum; see [STRAT-WORKFLOW](#archived-strat-workflow-dynamic-workflow-parity--naming-consolidation--complete). 6 PLANNED tickets: `-NAMING`, `-IMPERATIVE`, `-PIPELINE`, `-RESUME` (extends `T2-F5-RESUME`), `-BUDGET` (promotes `idea_budget_ceilings`), `-BG`. Gaps **verified by reading source** (`parallel_exec.py`/`executor.py`/`server.py`), not inferred — concurrency scheduler, worktree isolation, structured-output schema, cascade-cancel, DAG deps, and cross-model dispatch confirmed already-shipped and explicitly excluded as non-gaps. Naming decision (two-tier Temporal/Airflow model): `workflow` = authored `.stratum.yaml` definition, `flow` = running execution — formalized/documented, **not** mass-renamed.) **Earlier 2026-05-19** (**Test-hygiene follow-ups fixed** — the two out-of-scope items flagged during STRAT-TEST-EVENTLOOP-HYGIENE: (1) `.githooks/pre-push` self-perpetuating bump loop — loop guard added (skip bump when `remote..local` on main is all `chore: bump`); proven finite live (real push bumps once → next push skipped → `main` in sync, no more churn). (2) `test_judge_corpus.py` mutated tracked fixture every run — write now gated behind `STRATUM_UPDATE_CORPUS_FIXTURE=1`. Shipped stratum `d51f78d`/merge `caa1a21` on `main`; CHANGELOG `[test-hygiene follow-ups]`. Stratum bump-loop memory updated (now fixed, not a hazard). — **STRAT-TEST-EVENTLOOP-HYGIENE shipped** — `/compose fix` (flat-chain, stratum MCP offline): 9 integration `_run` helpers → `asyncio.run`; bounded repro 65→1 fail (residual = unrelated out-of-scope Docker live-gate), `stratum-mcp/tests/` standalone 982/0. Shipped stratum `a81deaf`/merge `8fb8d1a` on `main`; CHANGELOG + `docs/bugs/STRAT-TEST-EVENTLOOP-HYGIENE/`. NB: stratum `main` has a runaway post-push version-bump hook (each push spawns the next bump commit) — left at a sane `0.2.47`, local `0.2.48` churn unpushed; flagged as a separate hook defect. — **COMP-WORKSPACE-ID reconciled** — PLANNED→COMPLETE; `/compose build` invocation verified-first per standing rule and found already shipped in compose `a8db93b` 2026-05-09 (35 tests, 2547/2547 green, compose ROADMAP COMPLETE, CHANGELOG 2026-05-09). Not rebuilt — forge-top row reconciled with inline evidence. Recorded deviations: ID derivation is basename/`compose.json#workspaceId` not `sha1(git-toplevel)`; cockpit-header visual surface deferred to compose's `COMP-WORKSPACE-{VISION,…}` track (`-HTTP` COMPLETE). Load-bearing CLI/MCP/hooks disambiguation shipped in full. Compose-side `feature.json` PLANNED is stale owning-repo metadata, flagged for separate compose-owned fix. 5th confirmed stale-forge-top-row instance — see `feedback_verify_roadmap_rows_vs_disk`. — **STRAT-PAR rows reconciled** — PAR-2..PAR-6 PLANNED→COMPLETE under the already-COMPLETE umbrella; verified row-by-row vs shipped stratum/compose code by two independent investigations (live source sweep + git/CHANGELOG history). Capability CLOSED end-to-end per compose CHANGELOG 2026-04-18, real consumer `compose gsd`/COMP-GSD-2; stale because work renamed `STRAT-PAR-*`→`T2-PAR-*`/`T2-F5-*`. PAR-3 stays "approach superseded" (side-channel `ParallelExecutor`, not the `current_idx`→set rewrite). Evidence citations added per row; deferred items (`isolation:branch`, OPENCODE-DISPATCH, CLAUDE-CANCEL, RESUME, LEGACY-REMOVAL) are CHANGELOG-documented non-correctness gaps. See [STRAT-PAR](#archived-strat-par-parallel-task-decomposition--complete) 2026-05-18 row reconciliation note. — **STRAT-JUDGE-T3-READJAIL shipped PARTIAL** — read-jail machinery built; the design's mandatory live gate empirically falsified `codex exec` under macOS `sandbox-exec` (nested Seatbelt EPERM) → honest re-scope to `claude_cold_fallback`, no false `codex_jailed`; hard jail carried by new follow-ups **STRAT-JUDGE-T3-READJAIL-CODEXNEST** + **-LINUX**. CHANGELOG `[STRAT-JUDGE-T3-READJAIL]`, `docs/features/STRAT-JUDGE-T3-READJAIL/report.md`. — **STRAT-JUDGE v2 slice 1 shipped** — T3 cold-read adversary, `paranoid` stakes live; 6 Codex rounds killed two isolation overclaims → honest re-scope: no connector read-jail exists, guarantee is reasoning-not-handed + buffered-flush-after-T3 ordering, accepted residual; new follow-up **STRAT-JUDGE-T3-READJAIL** filed for the real OS read-jail + cross-model Codex adversary. STRAT-JUDGE row stays COMPLETE with v2-slice-1 progress note; CHANGELOG `[STRAT-JUDGE-v2-slice1]`, `docs/features/STRAT-JUDGE/report.md`. **STRAT-JUDGE-POSTMORTEM v2.2 shipped 2026-05-17** — all remaining v2 (#2 acceptance/topic-shift, #3 predicate decomposition, #4 replay harness); ticket COMPLETE. **STRAT-JUDGE-POSTMORTEM v2.1** + gated corpus regen (56→11) also 2026-05-17. **STRAT-MCP-CHUNK-SIZE** + **STRAT-REV-FU-1/2/3** reconciled COMPLETE (stale forge-top rows; shipped in stratum/compose). **Roadmap dedup/reconcile pass (later 2026-05-18):** `STRAT-JUDGE-T3-READJAIL-CODEXNEST` row reconciled PLANNED→COMPLETE (verified shipped — stratum `16c5b8b`/`bdde978`, live gate PASSED, `feature.json` COMPLETE; parent READJAIL note updated to record the now-active `codex_jailed` lane on macOS-verified hosts, `-LINUX` follow-up PARKED — honest degrade, no correctness gap); the stray duplicate `## STRAT-JUDGE — IN_PROGRESS` stub and a verbatim-duplicated `## Wave 6 — Situational Awareness` block (same typed-writer regen artifact as the earlier Wave 6 dedup, `COMP-MCP-MIGRATION-2-1`) were removed — canonical Wave 6 remains the single block above, STRAT-JUDGE umbrella at its COMPLETE row.) — **STRAT-JUDGE v2 slice 2 shipped** (decomposer modes: `auto`+two-phase `hybrid`, `ask` skill-only; stateless two-phase surface, kernel loop unchanged; full /compose lifecycle: design→blueprint→plan→TDD impl, 7 Codex rounds total → CLEAN, 686+965 green; CHANGELOG `[STRAT-JUDGE-v2-slice2]`; new follow-up **STRAT-TEST-EVENTLOOP-HYGIENE** filed for pre-existing combined-suite event-loop pollution).

**Earlier 2026-05-17** (Roadmap model decided — see [Roadmap Model](ROADMAP.md#roadmap-model): tracker provider is **per-project**; forge-top stays a prose/local narrative doc that cites product-repo issues via *external references*, never bidirectional sync; product repos may adopt the GitHub Issues/Projects provider. ROADMAP.md deduped — the 4× duplicated Wave 6 block collapsed to one (typed-writer regen artifact, root cause tracked as `COMP-MCP-MIGRATION-2-1`). `COMP-MCP-VALIDATE` marked COMPLETE — `validate_feature`/`validate_project` shipped in compose with three JSON schemas + pre-push hook; the forge-top row was stale. New tickets filed: `COMP-XREF-SCHEMA`, `COMP-XREF-VALIDATE` (impl rows owned by compose, sub-tickets #15/#16 of `COMP-MCP-FEATURE-MGMT`). Spec+plan written and Codex-reviewed (5 findings fixed: `getIssue` discards HTTP status → #16 adds `getIssueResult`; local resolver must honor configurable `paths.features`; exit-gate `git -C` path; golden-flow stub consistency; provider count). Provider enum reserves `jira|linear|notion|obsidian` as parse-valid url-class; `COMP-XREF-JIRA`/`COMP-XREF-LINEAR` filed as follow-on resolvers (#17/#18), `notion`/`obsidian` permanently url-class by design. `STRAT-MCP-CHUNK-SIZE` marked COMPLETE — same stale-row pattern as `COMP-MCP-VALIDATE`: shipped in stratum 2026-05-01 (`e2d03d7`, asyncio 64 KiB stdout buffer → env-tunable `_CODEX_STDOUT_LIMIT`, 9 regression tests), forge-top row never reconciled. Verified against `connectors/codex.py:101/195/368` and a green `test_codex_chunk_size.py` run. **STRAT-JUDGE-POSTMORTEM → COMPLETE**: v2.1 segmenter gate (`776f144`) then **v2.2** (all remaining v2 — #2 acceptance/topic-shift, #3 predicate decomposition, #4 replay harness) shipped 2026-05-17; 65 postmortem tests, full suite 629 passed (pre-existing `test_e2e` timeouts only), Codex CLEAN; gated corpus regenerated 56→11, replay live-verified. Ticket goal (calibration corpus + replay) delivered; v3 staged-FS/kernel replay is deferred future scope under STRAT-JUDGE. **STRAT-REV-FU-1/FU-2/FU-3 marked COMPLETE** — all shipped together in compose `f590c79` (CHANGELOG:206-221), forge-top rows stale; FU-1's decision resolved as a dual file-count/line-count gate; verified against `lib/review-lenses.js`, `lib/review-normalize.js:405/126`, `lib/build.js` shortstat helper, 44 lens + 21 cross-model tests green.)

**Earlier 2026-05-15** (STRAT-JUDGE marked COMPLETE — v1 shipped 2026-05-14, committed 2026-05-15; STRAT-GOAL marked COMPLETE — v1 shipped 2026-05-15 with 4 MCP tools, mode matrix, synthetic flow extension, 240 tests).

**Earlier 2026-05-08** (standalone tickets `STRAT-MCP-CHUNK-SIZE`, `STRAT-COMPOSE-CODEX-COMPANION`, `COMP-CODEISLAND-BRIDGE` promoted into the active roadmap; STRAT-REV-7 confirmed COMPLETE on disk — archive entry was stale; three STRAT-REV-FU follow-ups filed for line-count alignment, consensus promotion, and fallback hardening).

**Earlier 2026-05-07** (`STRAT-PAR` umbrella reconciled to COMPLETE — all 6 sub-features either shipped or superseded; PAR-3 replaced by `parallel_exec.py` side-channel rather than executor rewrite).

**Earlier 2026-05-01** (`COMP-DEPS-PACKAGE` shipped, compose `e56b3b5`: external skill dep manifest at `compose/.compose-deps.json`, `compose doctor` subcommand with `--json`/`--strict`/`--verbose`, `compose setup` extended with dep-check pass + manifest copy, lifecycle degrade pattern documented in SKILL.md, `package.json` `files` allowlist also fixed to ship `.claude/skills/**` + `skills/**`. 4 Codex review rounds on the blueprint → REVIEW CLEAN. compose 1967 tests passing, 16 new.)

**2026-04-28** — small-batch shipped: `STRAT-PAR-STREAM-LEGACY-CLOSE` schema v0.2.5 → v0.2.6 closes 6 legacy `BuildStreamEvent` metadata blocks and reserves `reply_required: boolean` on the envelope; `STRAT-PAR-STREAM-CONSUMER-VALIDATE` validates received envelopes via Ajv2020 in `dispatchEvent` with table-driven test coverage; `COMP-AGENT-CAPS-6` mirrors `block`-mode enforcement into the child-flow path. Codex review CLEAN after 2 iterations. stratum 889 + compose 1951 tests passing.

**Earlier 2026-04-28** — `/codex-review` user-skill deprecated in favor of openai-codex plugin's `/codex:review`; new tickets filed: `STRAT-MCP-CHUNK-SIZE`, `STRAT-COMPOSE-CODEX-COMPANION`, `COMP-CODEISLAND-BRIDGE` (narrowed scope after discovering Claude's hook already surfaces compose's agent activity via `claude-agent-sdk`).

**2026-04-27** — STRAT-CLAUDE-EFFORT-PARITY + STRAT-XMODEL-PARITY shipped (canonical `ReviewResult` schema unifying Claude/Codex review output); COMP-AGENT-CAPS-4 closed (was operationally complete since 2026-04-10); COMP-AGENT-CAPS-5 polish shipped (capability enforcement integration test + settings UI + severity bucketing); 1922 node + 87 UI tests passing in compose.

---

<a id="archived-strat-1-stratum-process-engine--compose-mvp--complete"></a>

## STRAT-1: Stratum Process Engine + Compose MVP — COMPLETE

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 47 | STRAT-ENG-1 | IR v0.2 schema: `workflow:` declaration, inline steps (`agent`, `intent`, `on_fail`, `next`), `flow:` composition, gates, policy, skip, rounds | COMPLETE |
| 48 | STRAT-ENG-2 | Executor — state model: StepRecord, FlowState, agent passthrough, audit infra | COMPLETE |
| 49 | STRAT-ENG-3 | Executor — gates, policy, skip: policy evaluation (`skip`/`flag`/`gate`), `stratum_skip_step` tool | COMPLETE |
| 50 | STRAT-ENG-4 | Executor — loops and rounds: round tracking, `max_rounds`, per-step iteration | COMPLETE |
| 51 | STRAT-ENG-5 | Executor — routing and composition: `on_fail`/`next`, `flow:` sub-execution | COMPLETE |
| 52 | STRAT-ENG-6 | Contract freeze: spec shape, MCP tool signatures, flow state/audit output | COMPLETE |
| 54 | STRAT-COMP-1 | Skill prompt + headless runner + init upgrade: universal agent skill, `compose build`, questionnaire, agent detection | COMPLETE |
| 55 | STRAT-COMP-2 | Delete bespoke code: replace lifecycle-manager/policy-engine with Stratum adapters | COMPLETE |
| 56 | STRAT-COMP-3 | Proof run: fix build infrastructure bugs, rewrite sub-flow spec, prove dispatch loop with mock connectors (317 tests, 0 fail). Live run (Task 6) remains manual/gated. | COMPLETE |
| 57 | STRAT-COMP-4 | Vision store unification: reconcile `VisionWriter` (CLI) and `VisionStore` (server) conventions — `featureCode` format mismatch, race-free shared access | COMPLETE |
| 58 | STRAT-COMP-5 | Build visibility: extend server file watcher to `.compose/` and `active-build.json`, broadcast build state via WebSocket | COMPLETE |
| 59 | STRAT-COMP-6 | Web gate resolution: when `compose start` is running, gates resolve through the web UI (Gate View) instead of CLI readline. CLI falls back to readline when server is not running | COMPLETE |
| 60 | STRAT-COMP-7 | Agent stream bridge: CLI writes tool_use events to `.compose/build-stream.jsonl`, server watches and pipes to AgentStream SSE | COMPLETE |
| 61 | STRAT-COMP-8 | ~~Active build dashboard~~ SUPERSEDED by COMP-UI. Build state visibility distributed across COMP-UI-2 (sidebar: active step, progress) and COMP-UI-3 (context panel: retries, violations, audit trail). | COMPLETE |

---

<a id="archived-comp-ui-cockpit-integration--complete"></a>

## COMP-UI: Cockpit Integration — COMPLETE

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 62 | COMP-UI-1 | Cockpit shell: rewrite `App.jsx` to render cockpit layout (header with ViewTabs, sidebar, main area, context panel, agent bar, notification bar). Move existing views from canvas tabs to main-area tabs. Agent stream becomes a collapsible bottom panel (agent bar) — always present, not a view tab. Three states: collapsed (status line), expanded (message stream + input), maximized (fills main area). | COMPLETE |
| 63 | COMP-UI-2 | Live sidebar: replace AppSidebar with attention-queue sidebar. Wire to useVisionStore for phase filter (global, affects all views), pending gates, blocked items, active build status (current step, progress from `active-build.json`), compact stats. Absorbs sidebar scope from STRAT-COMP-8. | COMPLETE |
| 64 | COMP-UI-3 | Context panel: right-side slide-in panel. Item click → ItemDetailPanel (inline field editing, acceptance criteria checkboxes, connection editor). Gate click → GateReviewPanel (prior decisions, artifact summary, connected items, feedback). Build step click → step detail (retries, violations, audit trail). Artifact → Canvas in panel mode. Persists across view switches. Absorbs detail scope from STRAT-COMP-8. | COMPLETE |
| 65 | COMP-UI-4 | View upgrades: replace BoardView (drag-drop with gate-aware transitions), ListView (filter bar: status/phase/type/agent), RoadmapView (collapsible tree with indentation). Restyle existing GraphView. Add PipelineView (visual step diagram) and SessionsView (browser with agent/status filters, read/write/error counters). | COMPLETE |
| 66 | COMP-UI-5 | Interaction components: CommandPalette (Cmd+K search across items/gates/sessions), ItemFormDialog (quick-type creation presets), SettingsModal (governance dials per phase), GateNotificationBar (persistent bottom bar with inline actions). Shared primitives: StatusBadge, PhaseTag, AgentAvatar, ConfidenceBar, RelativeTime, EmptyState, SkeletonCard. | COMPLETE |
| 67 | COMP-UI-6 | Polish and teardown: error boundaries per zone, delete replaced vision components and all compose-ui dead code (old pages, Layout, auth, base44). Merge color tokens into single constants file. localStorage persistence for cockpit state (active view, sidebar collapsed, font size). | COMPLETE |

---

<a id="archived-comp-rt-real-time-resilience--complete"></a>

## COMP-RT: Real-Time Resilience — COMPLETE

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 68 | COMP-RT-1 | Event coalescing for WebSocket broadcasts: accumulate agent activity and state-change events into a sparse buffer, flush to clients at a fixed interval (~60 fps). Prevents UI thrash from fine-grained tool-use deltas during heavy agent runs. | COMPLETE |
| 69 | COMP-RT-2 | Client hydration on connect: when a new browser tab or reconnecting client joins via WebSocket, send a single state snapshot (active build, vision state, in-flight agent stream) so it starts current instead of empty. Eliminates the "blank panel until next event" problem. | COMPLETE |
| 70 | COMP-RT-3 | Connector trait split — discovery vs runtime: refactor AgentConnector into two interfaces: a stateless `AgentRegistry` (enumerate installed agents, load session history, validate model IDs) and a stateful `AgentRuntime` (stream execution, interrupt, schema injection). Enables adding new vendors without touching the execution path. | COMPLETE |

---

<a id="archived-strat-par-parallel-task-decomposition--complete"></a>

## STRAT-PAR: Parallel Task Decomposition — COMPLETE

**2026-05-07 reconciliation:** the entire umbrella shipped (largely under `T2-F5-COMPOSE-MIGRATE` / `T2-F5-DEPENDS-ON`) without the original STRAT-PAR rows being closed. PAR-3's "replace `current_idx` with completed-set" approach was superseded by a side-channel implementation (`stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py` + `stratum_parallel_start/poll/done/advance` MCP tools) that delivers the same capability without rewriting the executor's sequential state.

**2026-05-18 row reconciliation:** PAR-2..PAR-6 rows were still PLANNED under the COMPLETE umbrella — same stale-forge-top-row pattern as `STRAT-MCP-CHUNK-SIZE` / `STRAT-REV-FU-*`. Verified row-by-row against shipped product code (two independent investigations: live source sweep + git/CHANGELOG history). Capability is CLOSED end-to-end per compose CHANGELOG 2026-04-18 ("T2-F5 arc status: CLOSED end-to-end") with a real downstream consumer (`compose gsd`, COMP-GSD-2). Renamed `STRAT-PAR-*` → `T2-PAR-*`/`T2-F5-*` ticket scheme is why the rows never closed; design.md deleted 2026-03-16 (`e597e89`), rationale now in the `T2-F5-*` feature folders. All five rows reconciled to COMPLETE with on-disk evidence below. PAR-3 stays "approach superseded" — the `current_idx`→set rewrite was deliberately *not* done; the side-channel `ParallelExecutor` delivers the capability. Deferred (per CHANGELOG, not correctness gaps): `isolation: branch`, OPENCODE-DISPATCH, CLAUDE-CANCEL, RESUME, LEGACY-REMOVAL.

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 72 | STRAT-PAR-1 | IR v0.3 schema: add `decompose` and `parallel_dispatch` step types to spec. `decompose` emits a TaskGraph (tasks with `files_owned`, `files_read`, `depends_on`). `parallel_dispatch` consumes a TaskGraph with `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`. Backward-compatible superset of v0.2. | COMPLETE |
| 73 | STRAT-PAR-2 | `no_file_conflicts` ensure function: built-in validation that no two independent tasks (no dependency edge) share `files_owned` entries. Read-only overlap allowed. Decompose retries add dependency edges to resolve conflicts. **Shipped (stratum); forge-top row stale until 2026-05-18.** `_no_file_conflicts` in `stratum-mcp/src/stratum_mcp/executor.py:1634`, registered in `_ENSURE_BUILTINS` `spec.py:1374`, live as `ensure: ["no_file_conflicts(result.tasks)"]` at `compose/pipelines/build.stratum.yaml:334`; tests in `stratum-mcp/tests/integration/test_parallel_schema.py` (disjoint/overlap/dependency/read-overlap/transitive). | COMPLETE |
| 74 | STRAT-PAR-3 | Executor ready-set model: replace `current_idx` with `completed_steps` set + `active_steps` set. Compute ready steps from satisfied `depends_on`. Return `parallel_dispatch` dispatch type with full task graph. New MCP tool `stratum_parallel_done` for batch result reporting. **Capability shipped; literal approach superseded (see 2026-05-18 note).** `ParallelExecutor` in `stratum-mcp/src/stratum_mcp/parallel_exec.py:142` manages per-task state (`parallel_tasks` dict, pending/running/complete/failed/cancelled, done-events, cascade cancel) and honors `task.depends_on` at dispatch (T2-F5-DEPENDS-ON, `e1476e5`); MCP tools `stratum_parallel_start/poll/done/advance` all present. The `current_idx`→`completed_steps`/`active_steps` rewrite was deliberately not done — parallel state is orthogonal to the legacy sequential `current_idx`. | COMPLETE |
| 75 | STRAT-PAR-4 | Compose parallel dispatch: `build.js` handles `parallel_dispatch` — topo-sort tasks into levels, create git worktree per task under `.compose/par/`, dispatch up to `max_concurrent` agents, collect diffs, apply in topo order. Conflict detection with sequential fallback. **Shipped (compose); forge-top row stale until 2026-05-18.** `executeParallelDispatchServer` `compose/lib/build.js:2941`, topo-sorted `applyServerDispatchDiffsCore` with patch-apply conflict detection `:3112–3225`, server-dispatch opt-in + consumer-side fallback `:2900`. Shipped under T2-F5-COMPOSE-MIGRATE / -WORKTREE (2026-04-17). | COMPLETE |
| 76 | STRAT-PAR-5 | Pipeline integration: update `build.stratum.yaml` — insert `decompose` step after `plan_gate`, replace sequential `execute` with `parallel_dispatch`. Graceful degradation: if decompose fails or merge conflicts, fall back to single sequential execute. **Shipped (compose); forge-top row stale until 2026-05-18.** `decompose` step (depends `plan_gate`, `no_file_conflicts` ensure, retries:2) `compose/pipelines/build.stratum.yaml:323`; `execute` step `type: parallel_dispatch` (`source` ← decompose tasks, `max_concurrent:3`, `isolation:worktree`, `merge:sequential_apply`, `require:all`) `:340`; graceful degradation via `shouldUseServerDispatch()` consumer-fallback in `build.js`. | COMPLETE |
| 77 | STRAT-PAR-6 | Agent bar parallel progress: when `parallel_dispatch` is active, agent bar shows per-task status (queued/working/complete/failed), overall progress bar, and task count. **Shipped (compose); forge-top row stale until 2026-05-18.** `compose/src/components/cockpit/AgentBar.jsx:37–155` consumes `compose:agent-status` `parallelTasks` payload `{total,completed,failed,active}`, renders progress bar (destructive color on failure) + `∥ {completed}/{total} tasks ∥ {active} active`; events emitted from `build.js:2925` (`build_task_start`/`build_task_done`). | COMPLETE |

---

<a id="archived-strat-rev-parallel-multi-lens-review--complete"></a>

## STRAT-REV: Parallel Multi-Lens Review — COMPLETE

Earlier rows (STRAT-REV-1..6) are in `ROADMAP-ARCHIVE.md` as COMPLETE. STRAT-REV-7 shipped 2026-05-08 — the archive entry was stale; verified against `build.js:1575–1599`, `contracts/cross-model-review-result.json`, `lib/review-normalize.js`, and three CHANGELOG entries (1911 node + 87 UI tests passing).

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | STRAT-REV-7 | **Cross-model adversarial synthesis:** Claude lens review + Codex review run when `classifyDiffSize(filesChanged) === 'large'` (≥9 files); synthesis classifies findings into `consensus`/`claude_only`/`codex_only`; canonical `CrossModelReviewResult` schema; sets `_crossModelCompleted` to skip the pipeline's redundant `codex_review` step. | COMPLETE |

### STRAT-REV-FOLLOWUP — refinements surfaced during the 2026-05-08 reconciliation

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | STRAT-REV-FU-1 | **Diff-size measure: file-count vs line-count.** **Shipped in compose `f590c79`; forge-top row stale until 2026-05-17.** Decision: dual gate — file-count stays the primary cheap signal (`≤2 small / ≤8 medium / ≥9 large`), line-count (`≥200 → large`) added so the *larger* classification wins; restores the original design intent without losing the shipped file-count gate. `classifyDiffSize(filesChanged, lineCount?)`/`shouldRunCrossModel` in `lib/review-lenses.js`; `lib/build.js` computes real `lineCount` via `git diff --shortstat HEAD` (5s timeout, null-fallback) and passes it at the cross-model gate. Decision-of-record is compose CHANGELOG (compose owns impl); STRAT-REV design.md has no diff-size language to update. 44/44 lens tests. | COMPLETE |
| — | STRAT-REV-FU-2 | **Promote consensus findings.** **Shipped in compose `f590c79`.** `lib/review-normalize.js:405` stamps `consensus:true` and boosts confidence on findings both Claude and Codex flag, so the cockpit can highlight high-conviction issues. 21/21 cross-model tests. | COMPLETE |
| — | STRAT-REV-FU-3 | **Harden the fallback confidence path.** **Shipped in compose `f590c79`.** `lib/review-normalize.js` stamps `applied_gate` on findings missing it and drops findings whose confidence < `applied_gate` (defensive invariant), closing the silent-drop bug. 21/21 cross-model tests. | COMPLETE |

---

<a id="archived-strat-workflow-dynamic-workflow-parity--naming-consolidation--complete"></a>

## STRAT-WORKFLOW: Dynamic-Workflow Parity + Naming Consolidation — COMPLETE

Filed 2026-05-29 from an evaluation of Claude Code's [dynamic workflows](https://code.claude.com/docs/en/workflows) against Stratum. Gaps were verified by reading `stratum-mcp/src/stratum_mcp/parallel_exec.py`, `executor.py` (`validate_certificate`, `stratum_resume`), `server.py` (`stratum_agent_run` schema, `BudgetCaps`), and `worktree.py` — **not inferred**.

**What Stratum already has (NOT gaps — verified):** real concurrent scheduler (`asyncio.Semaphore(max_concurrent)`, `parallel_exec.py:225`); built-in per-task worktree isolation (`create_worktree`, `:443`); structured output (`stratum_agent_run(schema=...)`, `server.py:138`) + certificate validation (`validate_certificate`); server-side fan-out with `FlowState` persistence (results stay out of the consumer's context — polled via `parallel_poll`). Stratum is arguably *ahead* on the fan-out path: `require=all/any/N` cascade-cancel (`_require_unsatisfiable`), `depends_on` DAG with cycle detection (`_detect_dependency_cycle`), and cross-model dispatch (claude **or** codex connectors — dynamic workflows spawn Claude agents only).

**Naming decision (two-tier, Temporal/Airflow model):** `workflow` = the authored `.stratum.yaml` definition (already the IR top-level keyword + `stratum_list_workflows`); `flow` = a running execution of a workflow (`FlowState`, `flow_id`, `@flow`). The existing split is formalized as definition-vs-instance, **not** mass-renamed — avoids a ~20-file churn (`flow`-family) while making the vocabulary intentional and documented. Analogy: Temporal Workflow (def) vs Workflow Execution (run); Airflow DAG vs DAG Run.

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | STRAT-WORKFLOW-NAMING | **Formalize the two-tier vocabulary.** Document `workflow` = authored definition, `flow` = running execution, in SPEC.md/README + docstrings; ensure the boundary is consistent (`stratum_list_workflows` lists definitions; `FlowState`/`flow_id` are executions). No mass rename — definition/instance split is intentional. Add a "workflow vs flow" glossary entry and a positioning note: Stratum = **governed, portable, cross-model workflows** (the cross-client answer to Claude Code dynamic workflows). | **COMPLETE** (2026-05-29, stratum `4ab433f` on branch `strat-workflow-naming`) — SPEC.md "Terminology: Workflow vs Flow" (3-layer glossary: workflow / flow / flow execution), README "Workflow vs Flow" + positioning note, and docstrings on `stratum_list_workflows`/`@flow`/`FlowState`. **Refined** to a 3-layer split during the Codex doc-review gate: `flow` = executable DAG *definition*, `flow execution` = the run (the original "flow = running execution" prose conflated the two). No rename. `docs/features/STRAT-WORKFLOW-NAMING/design.md`. |
| — | STRAT-WORKFLOW-IMPERATIVE | **Governed accumulator + loop-until-dry for the iteration loop.** ~~Imperative control flow in the IR~~ — **scope reconciled 2026-05-29** after verify-first against `stratum-mcp/executor.py`: the original framing ("the IR cannot express `while (count < N)`, loop-until-dry, or in-flow dedup") was substantially stale. **STRAT-ENG-4 already ships the per-step iteration loop**: `max_iterations` (counted cap) + `exit_criterion` (deterministic until-guard with `iteration`/`best_score`/`prior_scores` in scope) + `score_expr` hill-climbing + K-window stagnation auto-exit (`executor.py:1860-2076`). So `while (count < N)` is **done**; loop-until-dry is **partial** (K-identical-fingerprint stagnation exists, but no "K consecutive *empty/zero-new*" predicate). **Genuine residual (this ticket):** (1) an accumulator-with-dedup carried across iterations in `FlowState`, exposed to `exit_criterion`; (2) a loop-until-dry exit predicate keyed on consecutive zero-new rounds. Narrow, governed extension to the existing loop — **not** a scripting escape hatch (warning still holds). 6th confirmed stale-forge-top-row instance (see `feedback_verify_roadmap_rows_vs_disk`, `project_strat_workflow_epic`). Owner: stratum; `stratum/docs/features/STRAT-WORKFLOW-IMPERATIVE/`. | **COMPLETE** (2026-05-29, stratum branch `strat-workflow-imperative`) — `accumulate`/`accumulate_key` IR fields + `FlowState.iteration_accumulator`; `exit_criterion` sees `accumulator`/`accumulated_count`/`new_count`/`dry_streak`, so loop-until-dry = `exit_criterion: "dry_streak >= K"`. No new construct/tool/verb. Safety: malformed extractor freezes `dry_streak` (no false dry exit); fingerprint-stagnation suppressed for accumulator loops; rejected on gate/decompose/parallel_dispatch; in spec checksum. 2 design-gate + 1 blueprint + 3 impl Codex rounds → CLEAN; 20 tests, full suite 1044 passed. `docs/features/STRAT-WORKFLOW-IMPERATIVE/{design,blueprint,report}.md`. |
| — | STRAT-WORKFLOW-PIPELINE | **No-barrier stage staggering.** ~~`ParallelExecutor.run()` fans out one task list and `gather`s to a barrier~~ — gap **verified real** (unlike `-IMPERATIVE`), but one *mechanic* already existed: `depends_on` waiters don't hold semaphore slots (`parallel_exec.py:445`), so item-level staggering already worked — what was absent was the stage abstraction, output threading, and any way to author a pipeline over a list. **COMPLETE** (2026-05-30, stratum branch `strat-workflow-pipeline`) — new `pipeline` IR step type **desugars** (`source × stages`) into the existing `depends_on` graph and reuses `ParallelExecutor` verbatim (no second engine); item A reaches stage 2 while item B is still in stage 0. v1: linear stages, 1:1 per item, per-stage `agent` (cross-model pipelines), `{prev}`/`{prev_raw}` output threading, **item-scoped** `require` + per-item failure isolation, `items[]` canonical aggregate. Shared `expand_pipeline_tasks` keeps advertised-surface == dispatched-graph; `_collapse_pipeline_items` enumerates the full graph so the client-dispatched path can't bypass `require`. 27 tests; combined suite 1767 passed; Codex design 6 / blueprint 4 / impl 2 rounds → CLEAN. Deferred follow-ups: `-PIPELINE-FANOUT` (within-stage fan-out + conditional routing), `-PIPELINE-STAGEOPTS` (per-stage cert/timeout). `docs/features/STRAT-WORKFLOW-PIPELINE/{design,blueprint,plan,report}.md`. | **COMPLETE** |
| — | STRAT-WORKFLOW-PIPELINE-ROUTE | **Conditional stage routing for pipelines (`when` / `exit_when`).** Carved 2026-05-30 from `-PIPELINE-FANOUT` — the static-grid-compatible half. Per-stage `when` (skip a stage before dispatch, passthrough the predecessor output) and `exit_when` (early-exit an item's chain after a stage completes). | **COMPLETE** (2026-05-30, stratum branch `strat-workflow-pipeline-route`) — new terminal task state `skipped` on the `-PIPELINE` desugar (no new engine, no grid-shape change); downstream dep-gate treats a `skipped` predecessor as proceed + threads its passthrough as `{prev}`. Two binding contracts (`when`→{item,prev,prev_raw}, stage0→{item}; `exit_when`→{item,result,result_raw}) compiled through the ensure jail + an AST free-name validation pass (allowed ∪ `_ENSURE_BUILTINS`; stage-0 `prev` ref → parse error). Malformed `when` fails open, `exit_when` fails closed (logged, not `error`). `skipped` recognized at every terminal-state surface (`_item_counts`, `_collapse_pipeline_items`, restart/summary/all_terminal/advance, serializers); failed-partition tolerance scoped to pipelines so plain `parallel_dispatch` can't bypass `require:all` with `skipped`. Server-dispatched only (documented). 27 tests, full suite 1846; Codex design 6 / impl 1 round → CLEAN. `docs/features/STRAT-WORKFLOW-PIPELINE-ROUTE/design.md`. |
| — | STRAT-WORKFLOW-PIPELINE-FANOUT | **Within-stage fan-out (1→many) for pipelines.** Filed 2026-05-30 from `-PIPELINE` v1 (linear 1:1 only); conditional routing/early-exit split out to `-PIPELINE-ROUTE` (COMPLETE). **COMPLETE** (2026-05-30, stratum branch `strat-workflow-pipeline-fanout`) — scoped to **bounded data-driven map-reduce**: a `fanout: {max: K, require}` stage emits a list → ≤K parallel lanes (`item{i}::stage{j}::lane{k}`) → a `join: true` stage reduces survivors. **No engine change** — K lanes pre-materialized on the static grid; unfilled lanes (past the runtime list length) ride the `-PIPELINE-ROUTE` `skipped` primitive (the predicted prerequisite); the one new primitive is the **multi-predecessor join** (engine's first >1-dep task, binds `{prevs}`/`{prevs_raw}` = surviving lane outputs). Split-output contract (list / JSON-array string, else split fails; `len>K` fails) validated in a `_run_one` split-role hook; lane `{item}=L[k]` + `{source}`=parent; **lane-require** (survivors-governed, new join dep-gate) vs **item-require** (unchanged); server collapse omits lane indices + reads fill from status; fan-out is server-dispatched only (fanned-out `_done` rejected). 33 tests, full suite 1879; Codex design 5 / impl 2 rounds → CLEAN. Deferred follow-ups: `-PIPELINE-FANOUT-DYNAMIC` (unbounded — the real engine change: mid-run task injection), fixed-count replicate/best-of-N. `docs/features/STRAT-WORKFLOW-PIPELINE-FANOUT/design.md`. | **COMPLETE** |
| — | STRAT-WORKFLOW-PIPELINE-FANOUT-DYNAMIC | **Unbounded within-stage fan-out (1→runtime K, no author cap).** Filed 2026-05-30 from `-PIPELINE-FANOUT` (which shipped the *bounded* ≤K split). The honest boundary of bounded fan-out: when the split list can exceed any static K, the static grid can't pre-materialize enough lanes — this needs the **real engine change** `-PIPELINE-FANOUT` avoided: **mid-run task injection** into `ParallelExecutor`'s construction-fixed task set (`__init__` builds all asyncio tasks + the done-event map up-front, `run()` creates them once — no mechanism to add tasks after start). Likely co-lands with the TS port ([[project_stratum_ts_port]]) or `-BG`. Owner: stratum. **Assessed 2026-05-31 (verify-first vs `parallel_exec.py`): DEFER-TO-TS.** A Python v1 is buildable but requires an architecturally-awkward `ParallelExecutor` refactor (mid-run task injection into the construction-fixed asyncio task set + done-event map; `__init__:236`/`run():292`); the shipped bounded `-PIPELINE-FANOUT` already covers ~90% of cases (K-element lists), and TS gives a clean async-native task-spawn substrate. Redoing the Python refactor only to discard it at the port is poor effort — deferred, not built. **SUPERSEDED (2026-07-10):** STRAT-TS-PORT P4 (stratum d182020) shipped engine-owned fanout in TS — items materialize at runtime from the resolved `over` array with no static K cap, concurrency-capped workers, per-item lifecycle events; the mid-run-task-injection refactor this row deferred is moot. | SUPERSEDED |
| — | STRAT-WORKFLOW-PIPELINE-STAGEOPTS | **Per-stage `task_reasoning_template` + `task_timeout`.** Filed 2026-05-30 from `-PIPELINE` v1 (step-level uniform only). **COMPLETE** (2026-05-30, stratum branch `strat-workflow-pipeline-stageopts`) — a pipeline stage may declare its own cert + timeout, overriding step-level defaults; precedence is one presence-based rule (stage→step→default). The non-obvious half: cert *instructions* are now injected into the stage prompt (`_render_prompt` → `inject_cert_instructions`, pipeline-only, graceful-degrade), not just post-hoc validated — so an explicit per-stage cert actually instructs the agent. Explicit per-stage cert bypasses the claude agent-gate; step-level fallback keeps it; one shared `effective_pipeline_task_cert` helper drives all three cert sites (validate ×2 + inject). Pipeline-only helper → non-pipeline `parallel_dispatch` byte-identical (its two cert paths are intentionally asymmetric, can't share a helper). 13 tests; combined suite 1780 passed; Codex design 3 rounds (caught the injection gap + cert asymmetry) / impl 1 round → CLEAN. `docs/features/STRAT-WORKFLOW-PIPELINE-STAGEOPTS/{design,report}.md`. | **COMPLETE** |
| — | STRAT-WORKFLOW-RESUME | **Content-addressed prefix-cache replay.** Opt-in `cache: true` on a side-effect-free `compute` function step: a re-run/iteration returns an unchanged prefix step's prior *validated* output from `~/.stratum/cache/` instead of re-dispatching the agent ("same workflow + same inputs → 100% hit"). ~~Depends on / extends `T2-F5-RESUME`~~ — **stale clause, corrected:** the two are **orthogonal siblings**, not a dependency. `T2-F5-RESUME` keeps a *live child process* alive across a server restart; this *reuses recorded step results* across re-runs. Both merged on `main`; they compose but neither needs the other. | **COMPLETE** (2026-05-31, stratum branch `main`) — **per-step** content-addressed key (`CACHE_VERSION ‖ flow_name ‖ step_id ‖ _step_fingerprint ‖ _fn_fingerprint ‖ canonical_json(resolved_input)`), deliberately **not** the whole-flow `spec_checksum` (that would bust the prefix on any edit) — so editing a later step keeps the prefix hitting and misses only its suffix via the resolved-input cascade. Fingerprint helpers promoted to module level so the cache key and whole-flow tamper detection share one source, now also covering `guardrails`/`output_schema`/`output_contract`+shape (closed a pre-existing checksum gap). Parse-time eligibility rejects gate/judge/parallel/pipeline/iteration/accumulator/routing steps on the **effective** `step.cache OR fn.cache`. Hit = zero dispatch + zero budget + `cache_hit` audit record; kill switch `STRATUM_DISABLE_RESULT_CACHE=1`; only `ensure`-passing results cached. 47 tests, full suite 1289 passed; Codex review 3 rounds (validator bypass → fingerprint-omission staleness → CLEAN). `docs/features/STRAT-WORKFLOW-RESUME/{design,blueprint,plan,report}.md`. Follow-ups: `-RESUME-PARALLEL`, `-RESUME-ROUTING`. |
| — | STRAT-WORKFLOW-BUDGET | **Run-wide budget ceiling across fan-out.** `BudgetCaps(max_turns, max_dollars, max_wall_clock_s)` exists but is scoped to the judge loop (`stratum_judge`); `parallel_exec` enforces only a per-task `timeout`. Generalize to a flow-execution-wide ceiling that every dispatched agent debits, with hard cutoff when exhausted. Promotes parked `idea_budget_ceilings`. | **COMPLETE** (2026-05-29, stratum branch `strat-workflow-budget`) — flow-level `budget:` extended with `max_agent_dispatches`/`max_tokens`; `ms` reused as wall-clock (compute-seconds, resume-safe). Every server-dispatched agent (parallel tasks + `stratum_agent_run`) debits `FlowState.budget_state`; exhaustion → `terminal_status=budget_exhausted` + cascade-cancel, recognized across all advancement/status/contract surfaces. **Premise correction:** the "dollars + wall-clock, gap is scope not mechanism" claim was verified **wrong for dollars** — connectors emit tokens only (codex `cost_usd=0`), so dollars are recorded-not-enforced; true dollar enforcement split out to **STRAT-WORKFLOW-BUDGET-DOLLARS**. Judge-internal dispatches stay on their own `BudgetCaps` (documented v1 cut). 2 design-gate + 3 impl-review Codex rounds; 44 tests; full suite 1024 green. `docs/features/STRAT-WORKFLOW-BUDGET/{design,blueprint,report}.md`. |
| — | STRAT-WORKFLOW-BUDGET-DOLLARS | **Token→USD dollar enforcement (follow-up to -BUDGET).** -BUDGET records `usd` but cannot enforce it: per-call cost isn't computed on the MCP path (connectors emit token counts; codex hardcodes `cost_usd=0`; `litellm.completion_cost` lives only in the library executor). Add a per-model token→USD pricing table so `usd` becomes an enforced run-budget axis. Also scope optional consumer-reported usage on `stratum_step_done` so normal (consumer-dispatched) steps can debit. | **COMPLETE** (2026-05-30, stratum branch `strat-workflow-budget-dollars`) — static `MODEL_PRICING` table (`pricing.py`, no litellm dep; `STRATUM_MODEL_PRICING_JSON` override) prices token counts; `accumulate_usage` derives dollars when `cost_usd≤0` so both server-dispatched debit sites get dollars free; `budget_exhausted` enforces `usd`; `init_budget_state` yields a ledger for a `usd`-only budget. `stratum_step_done` gains optional consumer `usage` ({input/output_tokens,model} or pre-priced {tokens,dollars}), debited after validation across all outcomes (retry-storm safe), child-flow teardown on hard-stop. All inputs sanitized (negative/NaN/non-string/unhashable → $0, never raise/poison). Unknown model → $0 + one-time warning. Client-dispatched parallel usage deferred (server-dispatched IS covered); no IR/schema change. Codex design 3 / impl 4 rounds → CLEAN; 25 new tests, full suite 1819 passed. `docs/features/STRAT-WORKFLOW-BUDGET-DOLLARS/design.md`. |
| — | STRAT-WORKFLOW-BG | **Background whole-flow execution.** A single `parallel_dispatch` step runs server-side async (consumer polls), but the overall flow is turn-driven by the consumer (`plan` → `step_done` → next). Dynamic workflows run the entire multi-phase script in the background with the session free. Scope a server-driven flow-execution mode that advances autonomously through steps, surfacing progress via the existing stream/poll channel, pausing only at real gates. ~~Largest architectural item — likely lands with the TS port (STRAT-TS-PORT, T1-12).~~ **Verified outdated** (verify-first, [[feedback_verify_roadmap_rows_vs_disk]]): advancement was a turn-driven state machine, so BG just wraps the existing `get_current_step_info`→`process_step_result` spine — no new engine, lands cleanly in Python. | **COMPLETE** (2026-05-31, stratum branch `main`) — v1 `_background_flow_advance` loop drives `function`/`inline` steps via `stratum_agent_run` (reused wholesale → same `process_step_result` acceptance), pauses at gates, **hands off** (never mis-executes) at judge/flow/parallel/pipeline. Tools `stratum_flow_run_bg`/`_bg_poll`/`_cancel_bg`; one driver per flow (`bg_owned` guard on `step_done`+`resume`); explicit cancel (terminal) vs shutdown drain (resumable, `_BG_SHUTTING_DOWN`/`_BG_CANCEL_REQUESTED`); durable terminal snapshot for poll; any exception → durable `error`, never orphaned `running`. 15 tests, full suite 1304 passed; Codex 3 rounds → CLEAN (unfinalized-exit + non-durable retry + resume-race → cancel-tool race → docs). **v1 cut:** parallel/pipeline autonomous exec + restart-reattach → `STRAT-WORKFLOW-BG-PARALLEL`; judge/flow → `STRAT-WORKFLOW-BG-NESTED`; driver auto-restart → `STRAT-WORKFLOW-BG-RESUME`. `docs/features/STRAT-WORKFLOW-BG/{design,blueprint,plan,report}.md`. |

---

<a id="archived-standalone-tickets--planned"></a>

## Standalone Tickets — archived entries

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | STRAT-MCP-CHUNK-SIZE | `mcp__stratum__stratum_agent_run` returned a stream-chunk-size error on large Codex `--json` preambles; agents fell back to `general-purpose` Agent dispatch. **Shipped in stratum 2026-05-01 (`e2d03d7`); forge-top row was stale until 2026-05-17.** Root cause: asyncio default 64 KiB `StreamReader` buffer on codex stdout. Fix: env-tunable `_CODEX_STDOUT_LIMIT` (default 4 MiB, 64 KiB floor) passed as `limit=` to both `create_subprocess_exec` calls in `connectors/codex.py`, plus actionable overrun error. 9 regression tests in `test_codex_chunk_size.py` (898 suite passing). | COMPLETE |
| — | STRAT-COMPOSE-CODEX-COMPANION | Programmatic compose ↔ Codex bridge that runs Codex from inside compose pipelines (not just human-driven `/codex:review`). Returns canonical `ReviewResult` JSON, integrates with Stratum's `stratum_agent_run` contract. **Shipped; forge-top row stale until 2026-05-30 (7th confirmed stale-row instance, [[feedback_verify_roadmap_rows_vs_disk]]).** `stratum_agent_run(type="codex")` lives at `stratum-mcp/src/stratum_mcp/server.py:132` (commit `58c068b`); compose calls it programmatically via `compose/lib/stratum-mcp-client.js:482/510` (`agentRun`/`runAgentText` → `stratum_agent_run` type=codex), and the pipeline consumer `runCrossModelReview` (`compose/lib/build.js:2460`) dispatches Codex and returns canonical `CrossModelReviewResult` (ReviewResult + consensus/claude_only/codex_only). The capability landed under T2-F5 + STRAT-REV-7 / STRAT-XMODEL-PARITY and was never relabeled to this ticket. Verified by the 2026-05-30 sweep. | COMPLETE |
| — | COMP-XREF-SCHEMA | **Cross-project external reference type.** Add an external-ref shape to `feature.json` `links[]` — `kind: external`, `provider` (`github`/`local`), `repo`, `issue`/`url` — distinct from same-project `to_code` resolution. Lets a forge-top strategic row cite the product-repo issue/PR that implements it without embedding or syncing its status. Schema + writer-validation only; no sync engine. Pairs with `COMP-WORKSPACE-ID` for canonical repo identity. Realizes the [Roadmap Model](ROADMAP.md#roadmap-model). Impl owned by compose (`COMP-MCP-FEATURE-MGMT` #15). | COMPLETE |
| — | COMP-XREF-VALIDATE | **External-reference staleness check.** Extend `validate_project` (from `COMP-MCP-VALIDATE`, COMPLETE) to optionally resolve external refs read-only: referenced issue exists, not deleted, open/closed state not blatantly contradicting the citing row's status claim. Runs in the pre-push hook / CI, emits a drift finding, **never writes back** — references, not sync. v1 resolvers: `github` + `local`; `url` + reserved providers (`jira`/`linear`/`notion`/`obsidian`) are recorded url-class. Depends on `COMP-XREF-SCHEMA`. Impl owned by compose (`COMP-MCP-FEATURE-MGMT` #16). | COMPLETE |
| — | COMP-PAR-MERGE-QUEUE | **Dynamic post-dispatch merge gate.** **SHIPPED 2026-06-04 — closes COMP-GSD-3.** The dynamic complement to `STRAT-PAR-2`'s static `no_file_conflicts`: each `parallel_dispatch` task runs a fast per-task **pre-merge verify gate** (`pre_merge_verify`, default `pnpm lint`+`pnpm build`) in its worktree *before* its diff is captured/merged — a gate-fail (Stratum) or merge-conflict (Compose) produces a structured `ParMergeBounce` record, surfaced on `ensure_failed.bounced_tasks[]` AND injected into the re-dispatched task's prompt **server-side** (Stratum `ParallelExecutor._render_prompt` — the server re-resolves tasks per re-dispatch, so a consumer-side prompt edit can't reach the re-run). GSD `execute` opts into `defer_advance:true` + `pre_merge_verify:$.input.pre_merge_gate` (full `pnpm test` stays at `ship_gsd`). v1 = server-dispatch (GSD/build). **Implementation falsified the blueprint's bounce-delivery + retry-routing assumptions** (Codex round 1, 2 must-fixes): bounce delivery moved server-side; `executeParallelDispatchServer` now owns the parallel retry loop (re-dispatch on `ensure_failed`, fixing build/GSD/child-flow uniformly). Cross-repo: stratum `spec/executor/worktree/parallel_exec/server.py` + compose `build/gsd/step-prompt/gsd.stratum.yaml` + `contracts/par-merge-bounce.json`. Stratum 1409 + compose 3401 tests green; Codex 3 rounds → CLEAN. Follow-up filed: `COMP-PAR-MERGE-QUEUE-CONSUMER` (consumer-dispatch path). `docs/features/COMP-PAR-MERGE-QUEUE/report.md`. | COMPLETE |
| — | COMP-PAR-MERGE-QUEUE-CONSUMER | **Pre-merge gate + bounce on the consumer-dispatch path.** **SHIPPED 2026-06-04 (v1 = gate + surfacing).** Extends COMP-PAR-MERGE-QUEUE's per-task gate + structured bounce to `executeParallelDispatch` → `stratum_parallel_done` (the default for `compose build`; agents run in Compose, not Stratum's `_run_one`). Stratum surfaces the resolved `pre_merge_verify` on the dispatch envelope (shared resolver; omitted when empty → byte-identical) + `stratum_parallel_done` accepts a structured `merge_status {status, bounced_tasks}` + readable violations; Compose's `runPreMergeGateLocal` runs the gate in each task worktree before diff capture (fail → task failed + bounce + skip diff) and passes gate+conflict bounces to `parallelDone`. Reuses the parent's `ParMergeBounce`/`buildMergeConflictBounce`/`applyTaskDiffsToBaseCwd`. Activates for any `parallel_dispatch` step declaring `pre_merge_verify`; `compose build` default unchanged unless opted in. **Codex design gate caught the consumer retry state-model gap** (Compose applies successful diffs to base before `parallelDone`) → v1 narrowed to gate+surfacing. Stratum 1413 + compose 3395 green; Codex CLEAN. Follow-up filed: `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY`. `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER/report.md`. | COMPLETE |
| — | COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY | **Consumer-path retry-with-context + build opt-in.** **SHIPPED 2026-06-05.** The deferred D4/D5 of COMP-PAR-MERGE-QUEUE-CONSUMER: `executeParallelDispatch` now owns a bounded, bounce-injected retry loop (design **model C** — failed-only-re-run with carry-forward, chosen at the gate over whole-step re-dispatch): each round re-runs only the failed subset (gate-failed + schema_failed + conflict-loser), replays successful diffs onto a per-round throwaway **anchor commit** (`buildAnchorCommit`, dangling commit-tree via temp index) so re-run tasks see prior good work, and restores the real base to an **entry snapshot** between rounds so `applyTaskDiffsToBaseCwd` never double-applies (the consumer path applies successes to base *before* `parallelDone`). Apply-before-`parallelDone`, single terminal `build_step_done`, retry gated on a guaranteed-clean base, worktree-only (`isolation:none` review lenses byte-identical). The pre-existing single-agent **mis-route** of a parallel `ensure_failed` is fixed for both `runBuild` and `executeChildFlow` via an explicit `_parallelRetriesExhausted` marker. D5 default-OFF `pre_merge_gate` opt-in wired (`resolvePreMergeGate` → `startFresh` → `planInputs` only when `capabilities.preMergeGate`; key omitted when off → byte-identical plan). Also fixed a parent-feature latent bug: the `.owner` worktree marker was being captured into every task diff (multi-task merges conflicted) — now unstaged before capture. No Stratum change. Compose 3426 `node --test` green (17 new tests, every blueprint test-plan row); Codex impl-review CLEAN (4 rounds: cap source, `isolation:none` emit parity, snapshot-required-for-retry invariant). `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY/report.md`. | COMPLETE |
| — | COMP-RTK-INTEROP | **RTK output compression interop.** Detect [rtk-ai/rtk](https://github.com/rtk-ai/rtk) and route compose's shell-outs through it when available, degrading to raw output when absent. Shipped 2026-06-15 (impl owned by compose): RTK is a *lossy* compressor, so verification narrowed the surface to the **one** genuinely LLM-bound site (`lib/build.js:221`, the Tier-1 Codex review diff) — parse-bound git calls and the patch-bound `git diff --cached HEAD` (`git apply`) are correctly left raw; `npm test` discards its output. Added `external_binaries` to `.compose-deps.json`, `lib/rtk.js` helper (memoized detect + `rtkPrefix`, `COMPOSE_DISABLE_RTK` kill-switch), and `compose doctor` rtk reporting that recommends `rtk init -g` (RTK's CC hook — the larger token win, on the agent's own Bash output). | COMPLETE |
| — | COMP-SMARTMEMORY-INGEST | **SmartMemory ingestion.** Shipped 2026-07-03 in compose (@fbe0de02, opt-in `smartmemory.enabled` default OFF): fail-open live emit at the feature-events + gate-log seams, `compose smartmemory sync` idempotent backfill (events, gate-log, journal, artifacts incl. audit.json). Provenance via `context.origin=cli:compose` / `import:compose` (workspace scoping is API-key-derived, not a request field). Row now owned by compose's ROADMAP. | COMPLETE |
| — | COMP-SMARTMEMORY-RECALL | **Cockpit recall via SmartMemory.** Shipped 2026-07-03 in compose (@fbe0de02, same opt-in flag): Recall tab in the feature detail panel (hidden until the probe confirms enabled, feature items only), degrade-never-fail `/api/smartmemory/recall` ranking via hybrid search (activation is an internal channel, not a separate endpoint). Augments — does not replace — the Attention Queue. Row now owned by compose's ROADMAP. | COMPLETE |
| — | COMP-WORKSPACE-ID | **Canonical workspace ID derivation.** Borrow SmartMemory's `derive_workspace_id()` (env var → realpath(git-toplevel) → sha1[:12]) and use it everywhere Compose currently does ad-hoc project-root resolution: MCP target binding, `vision-state.json` location, ideabox path, journal path. Surfaces the bound workspace in the cockpit header so the parent-vs-subproject confusion that bit us 2026-05-07 / 2026-05-08 stops happening. **Shipped in compose `a8db93b` 2026-05-09 (27 files, 35 tests, 2547/2547 green); forge-top row stale until 2026-05-19.** Resolver chain `lib/resolve-workspace.js:62`, bounded discovery `lib/discover-workspaces.js:46`, MCP `set_workspace`/`get_workspace` tools `server/compose-mcp.js:190/199` with pre-dispatch `switchProject`; all four unification sites wired (MCP binding, vision-state via `vision-writer.js`, ideabox, journal via `getTargetRoot()`), 17 CLI cwd-sites unified in `bin/compose.js`, git-hook templates pass `--workspace=<id>`. compose ROADMAP marks it COMPLETE; CHANGELOG `2026-05-09`. **Two recorded deviations from this intent:** (a) ID derivation is `compose.json#workspaceId` → directory-basename with collision detection, **not** `sha1(realpath(git-toplevel))[:12]` — deliberate per compose's `docs/features/COMP-WORKSPACE-ID/design.md`; (b) the cockpit-header *visual* surface is not shipped (`WorkspaceContext` fetches it, header still shows project name/root) — tracked by compose's `COMP-WORKSPACE-{VISION,SESSIONS,…}` follow-up track + `COMP-WORKSPACE-HTTP` (COMPLETE 2026-05-10). The load-bearing CLI/MCP/hooks disambiguation — the actual cause of the 2026-05-07/08 confusion — shipped in full. *NB (resolved 2026-06-04): compose-side `docs/features/COMP-WORKSPACE-ID/feature.json` was reconciled PLANNED→COMPLETE on 2026-05-19; both surfaces now agree. The earlier "still says PLANNED" note is retired.* | COMPLETE |
| — | [COMP-CTXBUDGET-1](compose/docs/features/COMP-CTXBUDGET-1/report.md) | **`/context-budget` skill: token audit across loaded surface.** Scans agents, skills, MCP tool schemas (~30 Compose + ~25 Stratum), rules, and CLAUDE.md chain; classifies each into `always` / `sometimes` / `rarely` needed buckets; outputs ranked cut list with estimated reclaim. Detects duplicate skill copies between `compose/.claude/skills/` and `~/.claude/skills/`, flags MCP servers >20 tools, files >400 lines. We've never measured Compose's session-start context cost; this is the audit. Lifted from ECC competitive scan 2026-05-11. Promoted from [IDEA-5](docs/product/ideabox.md). **Shipped 2026-06-06** — `compose/lib/context-budget.js` (pure ESM core + CLI guard) + `/context-budget` SKILL.md wrapper; 19 node:test tests, Codex 3 rounds → CLEAN, full node suite 3339 green. Forge baseline captured: ~107.8K loaded tokens, ~55.5K reclaimable (agent/skill catalog), compose+stratum MCP schemas (~45K) load-bearing. Code is compose-owned; `docs/features/COMP-CTXBUDGET-1/report.md`. | COMPLETE |
| — | STRAT-JUDGE | **Reusable tiered-judge primitive (the kernel).** Standalone evaluator with tiers, confidence gates, replay infrastructure, and tier-disagreement learning. Same shape — `act → claim → judge → reason → retry` — underlies STRAT-GOAL, STRAT-REV adversarial synthesis, Compose `/fix` loops, Codex review iteration, and SmartMemory `hook:correction` reinforcement. Build once, plug in everywhere. **Tier stack:** T1 deterministic predicates compiled to `ensure` exprs (exit codes, file stats, git status, schema checks), T1.5 cheap SLM judge (Haiku-class) for atomic predicates needing interpretation, T2 tool-using verifier that cites evidence from artifacts (not transcript), T3 adversarial cross-verify (Codex tries to falsify; must produce concrete counterexample with citation), T4 quorum sampling when T2/T3 disagree. **Static routing:** predicate type (`deterministic`/`verified`/`judged`) sets the tier ceiling; stakes flag (`cheap`/`default`/`paranoid`) caps depth; budget caps spend. **Dynamic escalation:** "not met" judgments stay cheap; "met" claims always escalate to T2+; tier-disagreement history downweights unreliable tiers within the loop. **Mandatory predicate decomposition:** refuse single-blob conditions (addresses `feedback_codex_review_convergence` failure mode at the source); decomposer is itself a judged step. **Logging contract:** one JSONL record per turn capturing all tier verdicts, confidence, escalations fired, cost, evidence citations. **SmartMemory bidirectional wiring:** (a) emit `hook:correction` on overridden met claims into the SmartMemory ingest pipeline (COMP-INSTINCT-HOOK-1), (b) consume `learned` items as judge priors so cheap-tier bias gets calibrated per-project. **Resolved design decisions (2026-05-13):** (a) **Decomposer is a per-goal runtime choice** with four modes — `user` (you write the predicate list), `auto` (LLM decomposes from prose, no confirm), `hybrid` (LLM drafts, you confirm/edit before loop starts), `ask` (prompts you each time which of the prior three to use). Default is `ask` until usage patterns settle. (b) **Adversary runs cold-read** — Tier 3 sees only goal predicates and final artifacts, never the worker's reasoning or T2's evidence citations. Preserves independent priors at the cost of re-reading; the rigor matters precisely where T3 fires (met claims). (c) **Kernel output schema is a superset of `CrossModelReviewResult`** — STRAT-REV's existing fields are accounted for from the start so existing cockpit/compose consumers read it as a view, no adapter layer. **Still open:** whether T1.5 earns its cost over T2-only — answer comes from STRAT-JUDGE-POSTMORTEM corpus. **v1 committed 2026-05-15** (`docs/features/STRAT-JUDGE/`, CHANGELOG `[STRAT-JUDGE-V1]`, `compose/contracts/judge-result.json`): T1 + T2 only; `user` decomposer only; Claude-backed T2; STRAT-IMMUTABLE wired into the MCP tool; 80 new tests. **v2 slice 1 shipped 2026-05-18** — T3 cold-read adversary, `paranoid` stakes live (`evaluate_t3`, paranoid-only escalation, disagreement→ambiguous+`tier_disagreements`, `degraded_judged` redefined; 11 tests; 6 Codex rounds → CLEAN; CHANGELOG `[STRAT-JUDGE-v2-slice1]`, `docs/features/STRAT-JUDGE/report.md`). Honest scope: no connector read-jail exists — guarantee is reasoning-not-handed (structural) + buffered-flush-after-T3 ordering; hard read-jail + cross-model Codex adversary tracked as new follow-up **STRAT-JUDGE-T3-READJAIL**. **v2 slice 2 shipped 2026-05-18** — decomposer modes: `auto` (LLM prose→predicates once on a fresh goal, reused fail-open `LiteLLMDecomposer`) + two-phase `hybrid` (new stateless `stratum_decompose` tool + caller round-trip); `ask` is skill-layer only, never a kernel/MCP value. Zero kernel state machine — one defaulted `run_judge` param + one additive immutable `GoalState.decomposer_mode` + additive MCP surface. Codex review caught & fixed two real defects post-impl (auto-resume immutability hole; order-dependent boundary `invalid_decomposer`) → CLEAN; 686+965 tests green, 30+ new; CHANGELOG `[STRAT-JUDGE-v2-slice2]`, `docs/features/STRAT-JUDGE/{design §v2 slice 2,blueprint-v2-decomposer,plan-v2-decomposer,report}.md`. Remaining v2 (T1.5, T4 quorum, SmartMemory `learned` priors, `@judge` decorator, STRAT-REV/`bug_fix` retrofits) and v3 (SmartMemory `hook:correction` emit, replay harness) remain. New follow-up filed: **STRAT-TEST-EVENTLOOP-HYGIENE** (pre-existing cross-suite `asyncio.get_event_loop()` pollution in the integration `_run` helper — 64 failures only when `tests/`+`stratum-mcp/tests/` run in one process; reproduced on a clean tree; repo runs per-directory). | COMPLETE |
| — | STRAT-GOAL | **`/goal`-equivalent built on STRAT-JUDGE.** First production caller of the kernel. Exposed as `stratum_goal` MCP tool — takes a predicate list (not prose), `max_turns`, `stakes_mode`, and runs the worker→judge loop until met or budget exhausted. **Three-mode rollout, each gated on prior-mode data:** (1) Shadow — loop runs alongside real work, never binding, logs what it would have decided; human stops manually. (2) Advisory — loop suggests "met," human confirms or rejects; produces the highest-value label data. (3) Autonomous scoped by predicate class — `deterministic` predicates go autonomous once Mode 2 shows high agreement; `judged` predicates stay advisory until T3 paranoid shows similar agreement. Graduated trust by predicate class, not by goal. **Adversarial seed corpus:** hand-crafted 5-10 "looks-met-but-isn't" cases (tests disabled rather than fixed, code that compiles but isn't wired, design criteria satisfied in name only) as unit tests for T2/T3 — daily work won't reliably surface these because humans don't try to fail in interesting ways. Sourced from `feedback_review_loops_catch_unwired` failure patterns. **v1 committed 2026-05-15** (`docs/features/STRAT-GOAL/`, CHANGELOG `[STRAT-GOAL-V1]`, `compose/contracts/goal-result.json`): 4 MCP tools (stratum_goal/_status/_decide/_archive), mode matrix (shadow-driven/shadow-observed/advisory/autonomous), FlowState.synthetic, 7-case adversarial corpus, 240 new tests. v2 (live SmartMemory autonomy resolution, T3 paranoid mode for judged predicates, per-class trust escalation) remains. | COMPLETE |
| — | STRAT-JUDGE-POSTMORTEM | **Retroactive judge-stack replay against existing logs.** Bootstraps the STRAT-JUDGE calibration corpus before a single live goal runs. **Pipeline:** (1) Segment past Claude Code session JSONL into implicit goals — bounded by user request and completion claim or topic shift. (2) Back-decompose user request prose into predicates (dual-purpose: tests the decomposer + produces judgment targets). (3) Replay the judge stack at the moment-of-claim using only what was visible in transcript. (4) Pull ground-truth labels from the *future* of the same session — user came back with "no wait" / "actually" / "you missed" within N turns = false met; commit reverted or amended = false met; tests failed after = false met; silence + topic shift = weak positive. (5) Score per-tier false-met / false-not-met against ground truth. **What this gets us:** calibrated judge prompts before any live run; empirical resolution of the T1.5-worth-it question; a real corpus of "looks-met-but-wasn't" cases that surfaces the exact failure mode `feedback_review_loops_catch_unwired` warns about. **Sources:** Claude Code session transcripts, Compose audit traces, gate-log entries, journal entries, STRAT-REV synthesis records. Extends `stratum-learn` skill's transcript-reading path. **Honest limits:** survivor bias (silent failures missing from corpus — adversarial seed cases cover that gap); some `verified` predicates can't replay faithfully without live filesystem; decomposer drifts the further past goals are from current phrasing. Ships ahead of or alongside STRAT-JUDGE so the kernel has data to tune against on day one. **Progress:** v1 + v1.5 shipped 2026-05-13 (loader/segmenter/signals/cli, 56-candidate corpus, subject-token attribution). **v2.1 shipped 2026-05-17** — LLM-augmented segmenter gate (`llm_gate.py`, opt-in `--llm-gate`, litellm-routed, fail-open, schema 1.0→1.1, 25 tests). **v2.2 shipped 2026-05-17** — all remaining v2: #2 acceptance/topic-shift discrimination (`signals.py` `_is_genuine_acceptance`), #3 LLM predicate decomposition (`decompose.py`, kernel taxonomy, schema 1.1→1.2), #4 replay harness (`replay.py` + `replay` CLI: taxonomy-faithful T1/T2/unreplayable routing, moment-of-claim, abstention/coverage scorecard, sha1 holdout). 65 postmortem tests, full suite 629 passed (only pre-existing `test_e2e` timeouts), 3+3+3 Codex rounds → CLEAN. CHANGELOG `[STRAT-JUDGE-POSTMORTEM-v2.2]`, report appended. Live-verified on the 11-candidate v1.1 corpus; gated corpus regenerated (56→11). **Ticket goal delivered** (calibration corpus + replay harness). v3 (full `kernel.run_judge`/staged-FS replay, SmartMemory `hook:correction` emit) is explicitly-deferred future scope, tracked under STRAT-JUDGE v3. | COMPLETE |
| — | STRAT-LEARN-INLINE | **Inline skill/memory self-patch edge on the judge kernel.** Filed 2026-06-03 from a Nous Hermes-agent competitive scan (`skill_manage(patch)` — Hermes patches a skill mid-session on ≥5-tool-call success / error / user correction). Closes the gap between **within-step** self-correction (STRAT-JUDGE) and **across-run** learning (STRAT-JUDGE-POSTMORTEM): today the kernel regenerates until an `ensure`/`run_judge` verdict passes, and the postmortem corpus learns offline via `--all` cold-mine, but nothing patches the durable scaffold *at the moment a failure is diagnosed*. **Mechanism:** when a postcondition fails / `run_judge` returns must-fix / a user correction is detected, the kernel already emits a diagnosis — classify its fix target as `transient` (retry, unchanged), `step-local` (fix the step, unchanged), or **`durable`** (generalizes beyond this run). For `durable`, emit a **staged** skill/MEMORY patch *candidate* (`create` / `patch` old→new string / `edit`) that is surfaced in the `stratum_audit` trace for review and feeds the STRAT-JUDGE-POSTMORTEM corpus as a high-signal pre-scored entry. **Three deliberate departures from Hermes, dictated by existing constraints:** (1) **spec stays immutable** — inline patches target skills/MEMORY only, never the running `.stratum.yaml` (STRAT-IMMUTABLE; [[feedback_review_loop_roles]]); (2) **staged, not auto-applied** — candidates land in the audit trace, not the working tree (Hermes mutates live); (3) it *feeds* the corpus, not replaces it — the inline edge becomes the harvester, the batch `--all` pass stays the curator. **Config switch (opt-in, default OFF):** gated behind a Stratum config flag (`learn.inline_patch.enabled`, default `false`) — users who don't want the agent generating skill/memory patch candidates mid-run get byte-identical current behavior; when off, the durable-classification + candidate-emission path is skipped entirely (same default-OFF discipline as the STRAT-GUARD / COMP-MCP-ENFORCE gates). Adjacent to (not duplicating) IDEA-11 — that proposes a post-ship `learn: true` step that auto-appends to the corpus; this fires *inline mid-run* on a diagnosed failure. Owner: stratum; reuses STRAT-JUDGE diagnosis output + the postmortem corpus writer. **SHIPPED v1 2026-06-08 (stratum `main`).** Trigger scoped to the `stratum_judge` MCP judge-step path (goal-orchestrator + guard `run_judge` paths excluded → `-GOAL` follow-up filed); heuristic classifier (`judged`→durable) + opt-in fail-open LLM; **described-intent** candidates only (no literal diff); candidates land in `stratum_audit` (`learn_inline`/`staged_patch_candidates`) + a **separate** `inline_candidates.jsonl` sidecar (own `inline-1.0` schema, never the transcript corpus). Default-OFF (`[learn.inline_patch]` / `STRATUM_LEARN_INLINE_PATCH_ENABLED`) with verified byte-identical off-path (omit-when-empty keys, zero kernel/JudgeResult/judge-contract change) and a wholly fail-open harvest. `tests/` 711 + `stratum-mcp/tests/` 1418 green; Codex design CLEAN (8→2→0) + blueprint CLEAN (6→1→0); impl review (independent-reviewer fallback, Codex rate-limited) caught a dead LLM-classifier `ctx`-threading bug → fixed + regression-tested → CLEAN. Follow-ups: `-ENSURE`/`-CORRECTION`/`-APPLY`/`-GOAL`. `stratum/docs/features/STRAT-LEARN-INLINE/`. | COMPLETE |
| — | STRAT-TS-LEARN | **Across-run learning, rebuilt on the TS engine.** The working replacement for STRAT-LEARN-INLINE (Python, retired 2026-07-18, never ported; its apply half was never built in any engine). Harvests failures from persisted runs offline via `StateStore` — **zero engine change, zero judge-contract change** — classifies them `transient|step-local|durable`, stages evidence-backed notes, and applies them behind a default-OFF guarded path with compare-and-swap revert. `stratum learn harvest\|list\|apply\|revert\|reconcile`. **The design's main result is a negative one:** a census of the 492-run local corpus found **zero** `judged` events (so the Python-era trigger has never fired), and found that the largest apparent defect — 155 of 174 step failures on one step — is a single golden test rerun in 155 ephemeral temp workspaces. Grouping is therefore attributed by `workspaceRoot` first, keyed on a **contract fingerprint** (never the rejected value, never the spec digest — both were measured to shatter the one real cluster), and `durable` requires breadth (≥2 runs, ≥3 run/step pairs) rather than volume. Against the live corpus it stages exactly one lesson: four `build` steps returning `outcome` values outside the declared enum, 14× across 2 runs, every one recovered on retry and therefore invisible. **v1 surfaces that lesson; it does not fix it** — the fix target is a spec, and specs are immutable here. 5 Codex sol/xhigh rounds (3 design, 2 impl; 37 findings, one rejected on data). All 18 implementation findings landed in the S4 apply protocol; S1-S3 drew zero — **treat the read-only path as solid and the apply path as unproven until exercised.** Suite 807 green. `stratum/docs/features/STRAT-TS-LEARN/`. | COMPLETE |
| — | STRAT-JUDGE-T3-READJAIL | **Hard read-jail + cross-model adversary for T3.** Filed 2026-05-18 from STRAT-JUDGE v2 slice 1. **Shipped 2026-05-18 as honest-degrade (PARTIAL):** full read-jail machinery built and the design's *mandatory live gate* run — which empirically **falsified** the premise: real `codex exec` EPERMs under macOS `sandbox-exec` (codex self-applies Seatbelt; Seatbelt can't nest), so `sandbox-exec` is the wrong primitive for jailing codex, not a profile gap. Per the blocking-gate contract the feature was re-scoped honestly rather than ship a false guarantee: `read_jail_available()` gated False, `paranoid` T3 degrades to in-process Claude cold-read with per-predicate `t3` provenance = `claude_cold_fallback` + residual stated verbatim; the connector/profile machinery (OS-jail proven for ordinary processes via `/bin/cat`) ships intact as substrate one flag-flip from active. CHANGELOG `[STRAT-JUDGE-T3-READJAIL]`, `docs/features/STRAT-JUDGE-T3-READJAIL/{design,blueprint,plan,report}.md`; 8 Codex rounds + live gate → CLEAN; 659 tests green. **2026-05-18 update:** the hard cold-read codex jail now ships — `STRAT-JUDGE-T3-READJAIL-CODEXNEST` (below) delivered the non-nesting Docker primitive and its live gate PASSED, activating the dormant `codex_jailed` lane on macOS-verified hosts. The remaining Linux/CI path (`-LINUX`) is PARKED — honest degrade, no correctness gap — so this line is functionally settled with no open work. **Marked COMPLETE 2026-06-10:** all in-scope work shipped (macOS jail live via CODEXNEST); the only residual is the Linux coverage gap, broken out into and owned entirely by the PARKED `STRAT-JUDGE-T3-READJAIL-LINUX` ticket below. | COMPLETE |
| — | STRAT-JUDGE-T3-READJAIL-CODEXNEST | **Non-nesting primitive for the codex read-jail.** Filed 2026-05-18 from the READJAIL live gate. `sandbox-exec` cannot wrap `codex exec` (nested Apple Seatbelt → EPERM at startup, verified). **Shipped 2026-05-18 (stratum `16c5b8b` on `main`; supersedes the off-main `bdde978`):** ephemeral Docker container as the non-nesting jail — only readable host path is the `:ro`-bound staged turn tree, codex run `--dangerously-bypass-approvals-and-sandbox` inside (container *is* the externally-enforced sandbox). `JailDriver` seam (`sandbox.py`: `SandboxExecJailDriver` inert, `DockerJailDriver`, `select_jail_driver`), vendored pinned image (`judge/jail/Dockerfile`, `@openai/codex@0.130.0`, non-root), verifier/kernel/contract layer untouched. **Blocking live gate PASSED for real** on macOS (real gpt-5.4 turn read an unguessable planted token through the real connector path + namespace-deny check); verification is host-scoped (`_docker_readjail_verified()` — Darwin or explicit `STRATUM_DOCKER_READJAIL_VERIFIED=1`), NOT a global flip — Codex review caught and corrected an over-claiming global `True`. `codex_jailed` provenance now real wherever the host is verified; Linux/CI still degrades to `claude_cold_fallback` (carried by `-LINUX`). (Provenance note: the code + CHANGELOG `[STRAT-JUDGE-T3-READJAIL-CODEXNEST]` shipped on `main`, but the `docs/features/STRAT-JUDGE-T3-READJAIL-CODEXNEST/` design/report dir was never committed — evidence lives in the CHANGELOG + `src/stratum/judge/sandbox.py` + `judge/jail/Dockerfile`.) | COMPLETE |
| — | STRAT-TEST-EVENTLOOP-HYGIENE | **Combined-suite event-loop pollution.** Filed 2026-05-18 from STRAT-JUDGE v2 slice 2 verification. Running `tests/` + `stratum-mcp/tests/` in **one** pytest process yields 64 failures (`integration/test_routing.py`, `test_score_expr.py`, …) from the integration suite's deprecated `asyncio.get_event_loop().run_until_complete()` `_run` helper — a prior test closes/replaces the loop. Reproduced **identically on a clean tree** (slice-2 stashed) → pre-existing, not slice-induced. Repo convention is per-directory test runs (both green). Fix: replace the integration `_run` helper with `asyncio.run`/`pytest.mark.asyncio` or an explicit fresh loop per test. Bounded test-hygiene only; no production-code correctness gap. **Shipped 2026-05-19 (stratum `a81deaf`, merge `8fb8d1a` on `main`):** all 9 `stratum-mcp/tests/integration/` `_run` helper bodies → `asyncio.run(coro)` (private per-call loop; signature unchanged → zero call-site edits, 9 files × 1 line). Bounded repro `tests/ stratum-mcp/tests/integration/` (e2e excluded): pre-fix `65 failed/1024 passed` → post-fix `1 failed/1088 passed` (sole residual = unrelated out-of-scope Docker live-gate `test_judge_jail_docker::live_gate_A`); regression `stratum-mcp/tests/` standalone `982 passed/0 failed`. `/compose fix` flat-chain (stratum MCP offline); CHANGELOG `[STRAT-TEST-EVENTLOOP-HYGIENE]`, `docs/bugs/STRAT-TEST-EVENTLOOP-HYGIENE/{description,repro,diagnosis,report}.md`. Out-of-scope follow-ups filed in report: test mutating committed fixture `judge_corpus_smoke.json` **(FIXED 2026-05-19, `d51f78d`)**; the separately-flagged pre-push bump loop **(FIXED 2026-05-19, `d51f78d`)**; pre-existing `test_e2e.py` hangs **(FIXED 2026-05-20: `pytest-timeout>=0.5` added to dev deps, `timeout=120` global cap in pytest ini — prevents indefinite LLM-call hangs)**; combined-run CI guard **(FIXED 2026-05-20: `.github/workflows/test.yml` runs `pytest tests/ stratum-mcp/tests/ --ignore=tests/test_e2e.py --timeout=15 -x -q` on every push/PR)**. | COMPLETE |
| — | STRAT-JUDGE-T3-READJAIL-LINUX | **Linux `bwrap` read-jail path.** Filed 2026-05-18 from READJAIL (macOS-only v1). Add a `bwrap --ro-bind` jail for the codex adversary on Linux/CI. NB: verify in this ticket whether codex also self-sandboxes on Linux (if so, same non-nesting constraint as CODEXNEST applies). Until then Linux degrades to Claude-cold. **PARKED 2026-05-18:** macOS read-jail ships and is live-verified (CODEXNEST); Linux/CI honestly degrades to `claude_cold_fallback` with no false `codex_jailed`, so there is no correctness gap — only a coverage gap on Linux hosts. Unpark when CI/Linux paranoid-T3 coverage becomes load-bearing. | PARKED |
| — | STRAT-GUARD | **Standalone guarded-transition primitive.** Filed 2026-06-02. Exposes stratum's enforcement engine to clients that manage a resource lifecycle *outside* a flow. Today every enforcement primitive (`stratum_judge`, `stratum_gate_resolve`, `verify_spec_integrity`) is hard-bound to a live `FlowState` + current step, so compose's feature tracker hand-rolls a weaker, bypassable copy (self-approving gates, `force` overrides, no independent verifier — see `COMP-MCP-ENFORCE`). A *guarded transition* = move a resource A→B only if (1) A→B is a legal edge in a client-registered, **checksummed** graph (STRAT-IMMUTABLE pattern — an agent can't weaken a registered edge), (2) the edge's predicates pass `run_judge` (T1/T2/T3, independent of the proposer — separation of duties; paranoid edges fire the T3 cold-read adversary), (3) the verdict appends to a tamper-evident ledger, (4) idempotency-keyed. New MCP tools `stratum_guard_{register,transition,override,history}`; **no `force`** — override is a separate authorized + logged op (non-agent-mintable token, human resolver, `deviation` ledger entry). Reuses the FlowState-light engine layer wholesale (`run_judge` `kernel.py:56`, `compute_spec_checksum` `executor.py:1196`, append-only `turns.jsonl` ledger pattern) — new code is the standalone store + edge-legality + 4 tool registrations, not a rewrite. First consumer: compose `COMP-MCP-ENFORCE`. Built in Python now (accepted build-twice vs the TS port `STRAT-TS-PORT` (T1-12); the tool contract is the TS reimplementation spec, kept thin). `stratum/docs/features/STRAT-GUARD/design.md`. **COMPLETE (2026-06-02, stratum `4951822` + CLI seam `f822f2e` on `main`)** — verified shipped on disk (`report.md` Status: SHIPPED): **5** MCP tools `stratum_guard_{register,transition,override,migrate,history}` (the design's 4 + `migrate` as the token-gated re-registration path) + a `stratum-mcp guard` CLI subcommand (the COMP-MCP-ENFORCE subprocess seam). Resource-agnostic, tamper-evident state machine over FlowState-light `run_judge`: checksummed transition graph (weaken-by-reregister rejected; `guard_migrate` the token-gated path), hash-chained ledger verified before every trust-bearing read (torn-tail recoverable, interior tampering fails closed), **server-side** trusted-evidence evaluator (4-builtin `ast` allowlist — NOT the T1 staged-snapshot jail; the design's "extend T1 vocabulary" framing was corrected at the blueprint gate), cross-process `flock` + optimistic concurrency, no `force` (`guard_override` = out-of-band token + human + `deviation` entry). 59 + 7 CLI tests; full `stratum-mcp/tests/` 1370 passed; Codex blueprint gate 2 rounds (9→4) + impl gate 2 rounds (5) → CLEAN. First consumer compose `COMP-MCP-ENFORCE` reconciled PARTIAL→COMPLETE the same pass (Slices 1–4 + `-1` shipped, `capabilities.guard` enabled). **9th confirmed stale-forge-top-row instance** ([[feedback_verify_roadmap_rows_vs_disk]]) — filed and shipped same day, row never flipped. `docs/features/STRAT-GUARD/{design,blueprint,report}.md`. | COMPLETE |
| — | FORGE-CINEKIT | **MOVED 2026-05-15 → its own project `~/reg/my/movie-maker`.** The capability (generated graphics + deterministic live-UI capture + ElevenLabs/NotebookLM VO) is bigger than Forge and applies to all products, so it was promoted out of forge-top along with the proposed FORGE-EXPLAINER-SPEC / FORGE-VO-SOURCE. Tracked there as `MM-CINE-*`/`MM-SPEC-*`/`MM-VO-*`. Convention is canonical at `~/reg/my/movie-maker/docs/conventions/react-cinematic-capture.md`. | SUPERSEDED |
| — | [COMP-ROADMAP-GRAPH-1](compose/docs/features/COMP-ROADMAP-GRAPH-1/plan.md) | **Generated roadmap dependency graph (compose substrate).** Per-project `roadmap-graph.html` derived from compose lifecycle state + `deps.yaml` per feature folder + frontmatter on `design.md`/`feature.json`. Replaces hand-maintained graph HTML with a deterministic generator (`compose roadmap-graph` CLI + `mcp__compose__roadmap_graph` MCP). Generic across compose-using projects (SmartMemory, ScaleMate, Maya, Coder-Config, forge-top itself). Includes `deps.yaml` schema, idempotent generator, dangling-edge refusal (the actual Cytoscape-crash bug class), pre-commit + CI hook templates. **Migrated from SmartMemory's META-GRAPH-1 on 2026-05-23** after the work was recognized as compose substrate — SmartMemory's META-GRAPH-1 retained as the thin first-consumer adoption feature. Pairs with `COMP-MCP-ROADMAP-WRITER` (mutations) as its render-side sibling. Realizes the [Roadmap Model](ROADMAP.md#roadmap-model)'s "narrative-owned ROADMAP, mechanical-owned graph" split. **2026-05-30 sweep note (was PARTIAL/PLANNED):** an *adjacent* HTML graph exporter already shipped under **COMP-UX-1** — `server/graph-export.js` renders `roadmap-graph.html` via `GET/POST /api/export/roadmap-graph`, parsed back by `server/feature-scan.js:420` — but it derives edges from **vision-store connections**, not `deps.yaml`; the specific deliverable here was still unbuilt at that point. **COMPLETE (2026-06-07) — verified shipped on disk, forge-top row was stale (10th confirmed stale-forge-top-row instance, [[feedback_verify_roadmap_rows_vs_disk]]).** Full 4-phase scope delivered and merged to compose `main`: v1 generator core + `compose roadmap-graph` CLI (`bin/compose.js:1187`) + `mcp__compose__roadmap_graph`/`roadmap_graph_check` MCP tools (commit `04edf6c`); enforcement `COMP-ROADMAP-GRAPH-1-1` (opt-in pre-push gate + CI snippet, `--check`-as-lint); dogfood `COMP-ROADMAP-GRAPH-1-2` (compose-self CI workflow + adoption howto + seeded real `deps.yaml` edges) (commit `0cabaae`); edge seeding/endpoint-naming fix (`d9d01d5`). Implementation is `compose/lib/roadmap-graph/{collect,config,index,model,render,template.html}` + `contracts/roadmap-{deps,graph-frontmatter}.schema.json`; derives nodes from feature.json status/phase (ROADMAP.md fallback), edges from per-folder `deps.yaml`, display metadata from design.md frontmatter; drops COMPLETE/SUPERSEDED/KILLED nodes; **refuses to emit on a dangling edge** (kills the Cytoscape-crash bug class); byte-identical re-run so `--check` is a reliable CI gate. `test/roadmap-graph.test.js`; CHANGELOG `[COMP-ROADMAP-GRAPH-1{,-1,-2}]`; compose `feature.json` COMPLETE w/ completion bound to `0cabaaee`. Compose-owned; `docs/features/COMP-ROADMAP-GRAPH-1/`. | COMPLETE |
| — | [FORGE-ROADMAP-SYNC](docs/features/FORGE-ROADMAP-SYNC/report.md) | **Make the forge-top roadmap self-correcting.** Root cause of the recurring stale-row problem: forge-top status lived in three unlinked representations (prose `ROADMAP.md`, `feature.json`, `vision-state.json`) with no trigger, because forge root isn't git so the product-repo pre-push drift gate can't fire here. **SHIPPED 2026-06-09.** (1) Marked the workspace **narrative-owned** (`roadmap.narrative: true`) — the prose ROADMAP is now the single source of truth, the typed writer/`roadmap generate` return it verbatim (`roadmap-gen.js:215`) and can never clobber it; `validate_project` now emits `ROADMAP_NARRATIVE_OWNED` and suppresses 193 roadmap↔feature.json correspondence findings that were never real drift. (2) Reconciled the **29 cross-layer status mismatches → 0**: 7 stale `feature.json` corrected to match the verified ROADMAP (STRAT-PAR-2..6 + COMP-MCP-VALIDATE → COMPLETE; COMP-BOUNDARY-MAP → SUPERSEDED), then `validate_project fix:true,apply:true` projected canonical status into vision-state (10 updates, all ok). (3) Added `scripts/roadmap-drift-check.mjs` + a daily cron — the missing trigger; runs the same `validateProject`, filtered to cross-layer + xref drift kinds, silent when clean, exit 1 with offenders on drift. Blueprint verification caught that `vision-state.json` is a live projection target (not a dead orphan) and that `validate --fix` canonical=feature.json would have *downgraded* the 7 correct ROADMAP rows — fix order inverted accordingly. `docs/features/FORGE-ROADMAP-SYNC/report.md`. | COMPLETE |
| — | [COMP-MIGRATE-ON-UPGRADE](docs/features/COMP-MIGRATE-ON-UPGRADE/plan.md) | **Versioned state migration on upgrade.** `compose upgrade` refreshes code/skills/scaffolding but runs **no** state/schema migration — migration is lazy-on-write (silently misses cold data, e.g. forge-top vision-state frozen since 2026-05-07) or manual (`compose migrate`/`validate --fix`, nobody reminded). Evidence: 12 live `FEATURE_JSON_SCHEMA_VIOLATION` errors (COMP-UI-3/4/5/6 `/complexity` schema tightened, old data never migrated, `validate --fix` doesn't cover the class). Add a migration registry keyed by a `stateVersion` stamp, eager-walk every feature.json + vision-state item (promote the existing inline `featureCode→lifecycle.featureCode`/gate-outcome migrations into shared registry entries), cover the `complexity` class, wire into `runUpdate`/`runInit` per-workspace, dry-run + one-line report, idempotent + narrative-safe + local-provider only. Compose-owned. Pairs with FORGE-ROADMAP-SYNC's drift cron (migration = version skew; cron = status drift). **SHIPPED 2026-06-10** (compose `13bfc35`, `/compose build`): `lib/state-migrations.js` versioned/eager/idempotent runner + durable stamp at `.compose/data/migration-state.json` (atomic, not compose.json); v1 `normalize-complexity` (legacy free-text → `S/M/L/XL`); convergent (corrupt files reported not blocking); wired into `runInit`/`runUpdate` (resolved-cwd threaded) + new `compose migrate-state [--dry-run]` verb. **Scope narrowed** (ship-narrow-first): vision-state already migrates eagerly on load, so v1 = feature.json only; vision-state unification → follow-up `COMP-MIGRATE-UNIFY-VISION`. **Cleared the 12 `FEATURE_JSON_SCHEMA_VIOLATION` errors** at forge-top (0 error-level findings). **Latent bug caught by Codex impl-review:** `runInit` rebuilt `compose.json` from a fixed shape, silently dropping `roadmap`/`tracker` keys — would have reverted FORGE-ROADMAP-SYNC's `roadmap.narrative` on the next upgrade; fixed with `...existing` spread + regression test. Codex ×3 (design 7 / impl 3 / impl 1 → CLEAN); full suite 3639 node + 273 vitest green. `compose/docs/features/COMP-MIGRATE-ON-UPGRADE/report.md`. | COMPLETE |
| — | [COMP-MIGRATE-UNIFY-VISION](compose/docs/features/COMP-MIGRATE-UNIFY-VISION/plan.md) | **Fold the inline vision-state migrations into the state-migration registry** (follow-up to COMP-MIGRATE-ON-UPGRADE). Promote `featureCode→lifecycle.featureCode` + gate-outcome-normalize (`server/vision-store.js`, `lib/vision-writer.js`) into shared registry entries so lazy-on-load and eager-on-upgrade share one implementation + one `stateVersion` line. Consolidation, not a correctness gap (vision-state already migrates on load). Compose-owned. **SHIPPED 2026-06-15** (compose `fd7722a`): the two transforms now live once in `lib/state-migrations.js` (`migrateVisionItemFeatureCode`/`normalizeGateOutcome`/`migrateVisionState`), reused by both server `_load` paths AND a new vision walk in `runStateMigrations`. Registry entries gained a `target` discriminator (`feature`/`vision`); the new `normalize-vision-legacy` (v2) shares the single `stateVersion` stamp — the eager runner now migrates cold `.compose/data/vision-state.json` too (absent ⇒ stamp-advancing no-op, corrupt ⇒ reported not blocking). Transforms mutate-in-place (byte-identity) and are PURE+TOTAL per the registry invariant; a golden + load-vs-eager parity test lock the on-disk image. Full suite green (3890 node + 421 UI + 100 tracker); Codex impl-review 2 rounds → CLEAN (R1 flagged the `typeof`-string totality divergence → kept deliberately + tested, since removing it would crash the eager runner). `compose/docs/features/COMP-MIGRATE-UNIFY-VISION/report.md`. | COMPLETE |
| — | [FORGE-ROADMAP-RETIRE-STORE](docs/features/FORGE-ROADMAP-RETIRE-STORE/plan.md) | **Fully retire the forge-top tracker store** (follow-up to FORGE-ROADMAP-SYNC). The aggressive option deferred per ship-narrow-first: a `tracker: "none"` provider in compose (or `capabilities.lifecycle: false` short-circuit) so forge-top has *no* MCP store at all and `get_vision_items` can't return a second drift-prone answer; archive `vision-state.json`. Needs compose code + a restart of the live MCP servers the user controls. **SHIPPED 2026-06-15** (compose `e700ec9`): chose the **`capabilities.lifecycle:false` short-circuit** over `tracker:"none"` (tracker provider is the wrong axis — issue backend ≠ vision store on/off; `lifecycle` is an existing first-class capability). New `isLifecycleEnabled()` (`server/project-root.js`) gates `loadVisionState()` — the single chokepoint behind every MCP vision-read tool (`get_vision_items` + `get_item_detail`/`get_phase_summary`/`get_blocked_items`/`get_pending_gates`/`get_feature_lifecycle`) — so the whole surface returns empty at once (inert even if a stray write recreates the file). `validate_project` is intentionally **not** gated (drift detector must read raw sources). **Forge-top ops applied:** `.compose/compose.json` → `capabilities.lifecycle:false`; frozen `vision-state.json` archived to `vision-state.json.retired-20260615`; verified live — `isLifecycleEnabled()`=false, `get_vision_items` count 0 (was the stale set), `validate_project` clean (0 error-level). Default unchanged (only explicit `false` disables); Codex review CLEAN (2 rounds; validate-bypass + config-cache-staleness accepted per plan criteria). **⚠ Live MCP servers must restart** to pick up the flag from config cache (no-kill-ports — user action); the archive already retires reads immediately. Compose-side provenance = CHANGELOG `[FORGE-ROADMAP-RETIRE-STORE]` (no compose feature folder, to keep a forge-owned code out of compose canon); full report at forge-top `docs/features/FORGE-ROADMAP-RETIRE-STORE/report.md`. | COMPLETE |
| — | STRAT-AGENT-BG | **Background agent runs + harness-native watch bridge** (first STRAT-AGENT-VIS slice). `stratum_agent_run(background=True)` (codex-only v1) reuses the T2-F5 durable-child machinery: detached spawn, JSONL stream + completion sentinel under `~/.stratum/agent_runs/<run_id>/`, immediate `{run_id, stream_path, pid, watch_cmd}` return. New `stratum_agent_poll` (restart-proof, tail-capped) + `stratum-mcp watch <run_id> [--json]` CLI (line-buffered tailer, exits with agent rc) — run the watch via Bash `run_in_background` and the run is listed below the statusline, streams via TaskOutput, and re-invokes the model on completion: native-subagent UX for an MCP-dispatched agent. `stratum_cancel_agent_run` extended to bg runs (pid+start-time identity, group-leader check, SIGTERM group). macOS `proc_start_time` moved `ps`→`libproc` (identity format change: pre-upgrade persisted reparent handles classify `failed`, safe degrade). Built by codex via `stratum_agent_run(write=True)` (dogfood); codex adversarial review 3 findings (registry path traversal → killpg exposure, unbounded stream scan, `--json` purity) all fixed + regression-tested; live golden flow verified end-to-end (bg launch → watch below statusline → auto re-invoke, rc=0). 48 targeted tests; full suite 1508. `stratum/docs/features/STRAT-AGENT-BG/{design,report}.md`. | **COMPLETE** (2026-07-10) |
| — | STRAT-TS-PORT | **TypeScript port of the Stratum engine as a STANDALONE engine** (`@smartmemory/stratum`, `ts/` workspace in the stratum repo). Supersedes archived T1-12; owner decisions 2026-07-10: library-inside-compose scoping DROPPED, clean break reaffirmed — NO semantic migrator (report-only compat linter). Consolidated v1 IR (task/edge/fanout/gate/subflow; judge unified into ensure; E1/E2/E3 enforcement invariants; ≤400-token authoring target per docs/VISION.md). Full design with P0–P7 MUST-checklist phases routed for codex sol/terra implementers: `stratum/docs/features/STRAT-TS-PORT/design.md` (4 sol/high review rounds, trail in doc). P0 (IR schema + strict validator) COMPLETE 2026-07-10 @ stratum f70ec7d: 41 tests + typecheck green, 2 adversarial review rounds. P1 (engine core: client-driven loop, durable state/resume, budgets, E1) COMPLETE 2026-07-10 @ stratum 7bde809: 65 tests + typecheck green, 2 adversarial review rounds (8 must-fixes), REVIEW CLEAN. P2 (ensure evaluator + judged tier + engine ensure enforcement) COMPLETE 2026-07-10 @ stratum 4ac7ad3: 258 tests + typecheck green, sol/high build + 7 review rounds, REVIEW CLEAN; observability amendment + ledger audit landed same day (203951f). P3 (connectors + durable background runs: claude agent-sdk + codex exec --json with exact _exec_args argv, T2F5 wrapper/sentinel/registry port, fail-closed Darwin proc identity, telemetry into attempt records) COMPLETE 2026-07-10 @ stratum 88c4518: 285 tests + typecheck green, sol/high build + 5 review rounds, REVIEW CLEAN. P4 (gates + engine-owned fanout + `run:` subflow execution (pinned to P4 — third phase orphan) + frozen payload contracts events.json/mcp-surface.json + iterate) COMPLETE 2026-07-10 @ stratum d182020: 334 tests + typecheck green, terra/high build + sol/high review, 11 rounds (23 findings fixed incl. 2 latent P1 bugs; 1 rejected with rationale), REVIEW CLEAN; subsumes STRAT-WORKFLOW-PIPELINE-FANOUT-DYNAMIC (runtime-K engine-owned fanout). P5 (stdio MCP server on the frozen 10-tool surface with runtime payload validation + stratum validate/watch CLI porting the Python _cmd_watch matrix 1:1, bins source-only on Node >=22.7) COMPLETE 2026-07-10 @ stratum 33584e0: 345 tests + typecheck green, terra/high build + sol/high review, 4 rounds, REVIEW CLEAN. P6 (report-only compat linter `stratum migrate --check` + 3 reference parity flows in both IRs run on both engines with enforced outcome comparison + ≤400-token authoring specimen, CI-enforced: 5 task steps, 250 cl100k_base tokens) COMPLETE 2026-07-10 @ stratum a1364da: 356 tests + typecheck green, Python suite untouched (1517 passed), terra/high build + self-adversary pass + sol/high review, 2 rounds (4 findings fixed), REVIEW CLEAN — final engine-repo phase. FEATURE ACCEPTANCE PASSED 2026-07-10 @ stratum 1109bda (0.2.88): live golden flow on the real binaries (spec → codex task → judged ensure → gate → engine-owned fanout → audit, `ts/acceptance/`), all outcomes enforced, keyless server env; surfaced + closed an environment-parity gap with a codex-OAuth judge backend (judged predicates via the codex connector when no OPENAI_API_KEY, matching the Python judge kernel; STRATUM_JUDGE_BACKEND override). 6 sol/high review rounds on the delta (5 fixed, 1 rejected on Python-parity evidence), REVIEW CLEAN; 368 tests. All 4 acceptance-checklist items satisfied (record in design.md). P7 compose cutover = separate compose-repo feature. | COMPLETE |
| — | STRAT-AGENT-BG-MONITOR | **Per-event streaming into the session via the Monitor tool** (COMPLETE 2026-07-10: `watch --events [--kinds=...]` shipped in stratum 94a4477, see `stratum/docs/features/STRAT-AGENT-BG-MONITOR/`) (option-3 follow-up to STRAT-AGENT-BG). `watch --json` stdout is already pure JSONL (Monitor-compatible); this ticket is the curated event surface: a `watch --events [--kinds=...]` mode emitting one selective line per meaningful event (assistant text, tool-use summaries, errors — filtered, line-buffered, never the firehose) + the documented Monitor recipe (`Monitor(command: "stratum-mcp watch <run_id> --events")`) so each agent event lands as an inline session notification without a re-invocation gate. Complements (not replaces) the Bash-watcher bridge: Bash = task-list entry + completion wake; Monitor = live per-event interrupts. Coverage rule: the event filter must emit on every terminal state, not just happy-path. | COMPLETE |
| — | STRAT-AGENT-BG-WRITE-1 | **Workspace-write background agent runs + tool allowlists over MCP** (third STRAT-AGENT-VIS slice, stratum gh #18). Lets `stratum_agent_run` background runs write into the workspace under an explicit per-run tool allowlist instead of the read-only default, with the env seam scoped and stderr plumbed into the Monitor stream. Shipped stratum `c44e08e` 2026-07-19 after a 7-round plan gate; `stratum/docs/features/STRAT-AGENT-BG-WRITE-1/` (feature.json COMPLETE 2026-07-18). CHANGELOG `[STRAT-AGENT-BG-WRITE-1]`. **Row added 2026-09-05** during reconciliation — shipped seven weeks without a forge-top row. | **COMPLETE** (2026-07-19) |
| — | STRAT-AGENT-BG-CLAUDE | **Background mode for `type="claude"` agent runs** (follow-up to STRAT-AGENT-BG). The claude connector is in-process `claude_agent_sdk.query()` — no detached child to reparent. Design: server-side `asyncio.create_task` + tee of the event stream to the same registry JSONL shape (+ synthetic sentinel on completion), so poll/watch/cancel work identically. Honest caveat: backgroundable but NOT restart-survivable (document; a server restart terminalizes the run as `error`). **Closed 2026-09-15:** shipped by stratum `c44e08e` (`STRAT-AGENT-BG-WRITE-1`, 07-19) — claude bg runs execute in a Worker Thread (`ts/src/connectors/claude-bg-worker.ts`) writing Codex-compatible JSONL, run/poll/cancel work identically, `worker.terminate()` gives death-confirmed cancel. The asyncio design above was the retired python engine's; the TS port used a worker thread instead. Restart caveat is honoured: poll returns `child_died_without_sentinel` after a server restart (WRITE-1 design D3). The 2026-09-05 reconciliation missed this. | **COMPLETE (2026-07-19, shipped as part of STRAT-AGENT-BG-WRITE-1)** |
| — | STRAT-AGENT-BG-BUDGET | **Budget debit for background runs** (follow-up to STRAT-AGENT-BG; v1 fail-louds budgeted flows out). Design: idempotent debit-on-completion-observation — first `stratum_agent_poll` that sees the sentinel debits the flow's `budget_state` from stream-derived usage and stamps `debited: true` in meta.json (atomic rewrite) so re-polls never double-debit. Needs a decision on exhaustion semantics for an already-running detached child (SIGTERM vs let-finish + refuse-next). **SUPERSEDED 2026-09-15** by `stratum_usage_report` (MCP surface 15, receipts keyed by `(runId, dispatchId)`, idempotent, any run status): `stratum_agent_poll` already returns `usage`/`split`/`usdSource` on completion, and the caller reports that as a receipt with the run id as `dispatchId`, so no poll-side debit or `meta.json` stamp is needed. Exhaustion semantics: the engine answers a receipt with `budget: "flow"` and the caller cancels via `stratum_cancel_agent_run`. The v1 guard (`budgeted` → "cannot debit run budgets yet") was dead code — nothing set it — and was removed from `ts/src/connectors/{background,runner}.ts` in stratum `bb42239` (2026-09-15). | **SUPERSEDED (2026-09-15)** |
| — | STRAT-JUDGE-BG | **Background judge kernel runs** (follow-up to STRAT-AGENT-BG). `stratum_judge` blocks for the whole T1/T2/T3 loop. The detached-child path doesn't apply (in-process kernel, multi-stage) — needs the generic server-side bg-job registry from STRAT-AGENT-BG-CLAUDE (task + tee + sentinel). Same shape could later cover `stratum_goal`/`stratum_decompose`/`stratum_distill`. **SUPERSEDED 2026-09-15** by the TS cutover: the TS MCP server exposes no `stratum_judge` tool — the judge kernel (`ts/src/judge/`) is an internal dependency of guard transitions and judged `ensure` checks, so there is no blocking judge call to background. `stratum_goal`/`stratum_decompose`/`stratum_distill` likewise do not exist as TS tools. Re-file if a synchronous judge tool is ever added. | **SUPERSEDED (2026-09-15)** |
| — | STRAT-DISTILL | **PROMOTED 2026-06-14 → stratum** (`stratum/docs/features/STRAT-DISTILL/design.md`; live tracker is the stratum feature folder, this row is a breadcrumb). **Repeated-workflow → reusable-asset synthesis.** Filed 2026-06-13 from a Xiaomi MiMoCode teardown ([[reference_mimocode]]) — MiMo's `/distill` mines its session-trajectory SQLite DB for repeated *manual* workflows and packages the high-confidence ones into skills / subagents / commands. Closes a real gap distinct from `STRAT-LEARN-INLINE`: LEARN-INLINE patches *existing* skills/MEMORY when a failure is *diagnosed* (failure-triggered, edits scaffold); this is the *success-pattern* complement — proactively scan recent Claude Code transcripts (reuse the `stratum-learn` / STRAT-JUDGE-POSTMORTEM transcript-reading path) for workflows that recurred **≥2×** with stable inputs + a clear stopping condition, and emit **new** `.claude/` assets in our native format (`SKILL.md` w/ YAML frontmatter, `agent/<name>.md`, `command/<name>.md` w/ `$ARGUMENTS`/`$1`), then verify emitted paths w/ Glob + symbols w/ Grep. Borrow MiMo's discipline wholesale: raw-trajectory-as-source-of-truth + memory-as-cache (matches our sidecar≠corpus rule, [[project_strat_learn_inline]]), inventory-existing-assets-first to *extend-not-duplicate*, "smallest form" selection, and the hard anti-slop guard — **"if nothing recurred, create nothing" is a valid, successful outcome** (never manufacture an asset to justify the run). Staged-not-auto-applied per STRAT-IMMUTABLE / [[feedback_review_loop_roles]]: candidates surface for review, never silently written to the working tree. Optional cron-like auto-run (MiMo defaults distill every 30d / dream every 7d, interval + 10s-debounce + project-age gated) but default manual/opt-in like the other learn gates. Owner: stratum; reuses STRAT-LEARN-INLINE's candidate-staging/sidecar discipline + the postmortem corpus writer. **Verified 2026-06-14 vs stratum `src/`:** net-new (0 `distill` hits); transcript loader (`judge/postmortem/loader.py:239` — walks `~/.claude/projects/*/*.jsonl`) + staging (`judge/inline_learn.py`, `postmortem/corpus.py`) are reusable, but the **detector is net-new** — LEARN-INLINE classifies judge *verdicts* (`must-fix`→`durable`, `inline_learn.py:84`), whereas DISTILL needs cross-session *recurrence* counting over tool-call sequences, and the candidate schema must extend to whole-asset (subagent/command) emission, not just skill/MEMORY patches. | SUPERSEDED |
| — | MIMO-INTEROP | **PROMOTED 2026-06-14 → compose** (`COMP-MIMO-INTEROP`, phase Backlog; live tracker is compose feature.json, this row is a breadcrumb). **MiMoCode as a second host + neutral benchmark subject.** Filed 2026-06-13 ([[reference_mimocode]]). Xiaomi MiMoCode (released 2026-06-10) is an OpenCode fork that retains MCP + plugins + the Claude-Code `SKILL.md`/command/agent format and ships one-step "Import from Claude Code"; it's an interop *substrate*, not just a competitor ([[feedback_dont_dismiss_ux_wins]]). (a) **Interop validation.** **Sanity-checked 2026-06-14 vs source:** both are textbook stdio MCP servers on the official SDKs (`stratum-mcp` = FastMCP / `mcp>=1.0`, console-script `stratum_mcp.server:main`; `compose` = `@modelcontextprotocol/sdk` `StdioServerTransport`, `server/compose-mcp.js:820`) → they **register + list + call tools unchanged** under any stdio-MCP host. But the *transport* is host-agnostic while a *full flow* assumes the Claude-Code host surface, so scope honestly as **register/list = unchanged; flow = needs host-surface adapters**: (i) Stratum's non-codex dispatch + skills call the host's `Agent`/`Skill`/`TodoWrite` tools (MiMo has its own subagent system; codex dispatch is subprocess → portable); (ii) Compose's `record_completion`/lifecycle run over its separate `:4001` HTTP server, not the stdio MCP; (iii) MiMo needs its own MCP-config entry + skill tool-name mapping. (b) **Bench subject:** MiMo's "beats Claude Code at 200+ step tasks" headline is **self-reported** — it is the obvious first *external* subject for `COMP-BENCH` once that suite lands, yielding a neutral score against the self-reported claim. Strategic / cross-product, low urgency. Owner: cross-product (compose owns the bench leg, stratum owns the MCP-host check). | SUPERSEDED |

---

<a id="archived-wave-6--situational-awareness--complete"></a>

## Wave 6 — Situational Awareness — COMPLETE

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | COMP-OBS-BRANCH | Session branching reader + compare view. Forge reads Claude Code's existing parent-pointer branch tree at `~/.claude/projects/**/*.jsonl` — no new fork mechanism, no new storage. Ships FIRST within Wave 6 because it is the structural validator that the CC JSONL assumption holds; failures here invalidate the branch-outcome shape the rest of the batch depends on. | COMPLETE |
| — | COMP-OBS-CONTRACT | Upfront shared contract for Wave 6 Situational Awareness batch. Locks lifecycle schema extensions, branch outcome record, decision event taxonomy, status rollup input, and Vision Surface UI region assignments. Includes integration-test skeleton that exercises all Wave 6 features end-to-end. Every Wave 6 feature references this contract; schema changes require batch-wide re-approval. Gates Wave 6 start. | COMPLETE |
| — | COMP-OBS-DRIFT | Region ⑥ — three mechanical drift axes (path/contract/review-debt) with hardcoded thresholds. Rising-edge DecisionEvent emission with persisted breach_event_id+breach_started_at for stable snapshot rehydration. Schema bump 0.2.3→0.2.4. 28px ribbon mounted above BRANCH compare panel. | COMPLETE |
| — | COMP-OBS-GATELOG | Gate decision audit log + compose gates report CLI. Project-scoped JSONL persistence, emit-first-then-append flow, schema-aligned outcome translation (revise→interrupt, kill→deny). Powers STATUS gate_load_24h and TIMELINE kind=gate cards. | COMPLETE |
| — | COMP-OBS-LOOPS | Open Loops region ④ — 320px right panel + compose loops CLI. UUID v4 ids, append-only, resolution-in-place. Schema-validated kind/summary/ttl_days. Drives STATUS Branch 6 (stale loops) and Branch 8 (open loops count) via shared isStaleLoop helper. | COMPLETE |
| — | COMP-OBS-STATUS | Status Line region ① — one-sentence situational rollup with click-to-expand panel. 8-branch deterministic sentence template, dual-emit on every state-changing event, REST GET /api/lifecycle/status. Mounts in main cockpit + popout. Drives the vibe-coder surface. | COMPLETE |
| — | COMP-OBS-STEPDETAIL | Step Detail surface — retries summary, postcondition violations, live iteration counters in ContextStepDetail; compact budget pill on OpsStrip; GET /api/lifecycle/budget endpoint. Absorbs COMP-BUDGET-3. UI-extension only — no schema change. | COMPLETE |
| — | COMP-OBS-TIMELINE | Decision Timeline strip — region ② (72px full-width, horizontally scrollable). DecisionTimelineStrip with DecisionCard per layout.md ②. Server dual-emits phase_transition + iteration alongside existing broadcasts; kind=branch from BRANCH gains its first consumer. kind=gate / kind=drift_threshold render with zero code change once GATELOG / DRIFT land their emitters. | COMPLETE |

---

<!-- Phase 1: Core Lifecycle — moved to compose's ROADMAP.md (workspace ownership: compose). -->
<!-- COMP-WORKSPACE-ID strategic intent row is in the Standalone Tickets table above (COMPLETE — reconciled 2026-05-19); implementation lives in compose. -->

---

<a id="archived-phase-6-mcp-writers--complete"></a>

## Phase 6: MCP Writers — COMPLETE

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | COMP-MCP-JOURNAL-WRITER | **Journal writer (`write_journal_entry`, `get_journal_entries`).** Sub-ticket #4 of `COMP-MCP-FEATURE-MGMT`. Routes every `compose/docs/journal/` mutation through a typed MCP surface. Global-monotonic session numbering, four-section enforcement on write, permissive on read, frontmatter-canonical `summary`/`feature_code`/`closing_line`, ordered `unknownSections` array, HR + italic closing-line delimiter, advisory-locked counter, two-file rollback on partial-commit failure (`JOURNAL_PARTIAL_WRITE` + `err.cause`). Cross-cutting MCP wrapper now propagates `err.cause` for the whole writer family. 76 new tests; suite 2321/2321 + 92/92 UI. Self-applied via dogfood (session 37). Five Codex review passes caught 14 contract-drift / implementation issues before ship. | COMPLETE |
| 2 | COMP-MCP-COMPLETION | **Completion writer (`record_completion`, `get_completions`).** Sub-ticket #5 of `COMP-MCP-FEATURE-MGMT`. Typed commit-bound completion records with full-SHA identity, per-feature lock, three status-flip failure subcases including ROADMAP_PARTIAL_WRITE, opt-in PATH-independent post-commit hook (template + install-time path substitution). 80 new tests; suite 2403/2403 + 92/92 UI. 7 Codex doc-review rounds + 2 implementation-review rounds caught 17 issues before ship. | COMPLETE |
| 4 | COMP-MCP-VALIDATE | **Cross-artifact validator (`validate_feature`).** Sub-ticket #7 of `COMP-MCP-FEATURE-MGMT`. Cross-check ROADMAP.md row, vision-state.json, feature.json (if used), feature folder contents, linked artifacts, and references from other artifacts. Flags drift: status mismatches, missing required artifacts, dangling artifact links, unreferenced feature folder, contradictory phase claims. Hookable from a pre-commit or pre-push hook. **Shipped in compose; forge-top row stale until 2026-05-20.** `validate_feature` + `validate_project` MCP tools live in `compose/server/compose-mcp.js:352/365`. | COMPLETE |

---

<a id="archived-future--planned"></a>

## Future — archived entries

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 2 | COMP-BOUNDARY-MAP | Boundary Map artifact in blueprint phase — explicit Produces/Consumes lists for types and functions between sequential work units (slices/features/components). Catches cross-component contract mismatches before code. Inspired by gsd-build/gsd-2. **SUPERSEDED by COMP-GSD-1 (shipped); forge-top row stale until 2026-05-30 (8th confirmed stale-row instance, [[feedback_verify_roadmap_rows_vs_disk]]).** Shipped as `compose/lib/boundary-map.js` (`validateBoundaryMap`/`parseBoundaryMap`, 481 lines) + `test/boundary-map.test.js` + `.claude/skills/compose/templates/boundary-map.md`, wired into the Phase 4/5 blueprint gate (SKILL.md:185/198), commit `ce68444`. `docs/features/COMP-GSD-1/feature.json` is COMPLETE and states it "absorbs the previously-filed COMP-BOUNDARY-MAP." Dogfooded in the STRAT-WORKFLOW-PIPELINE blueprint the same day. | SUPERSEDED |

---
