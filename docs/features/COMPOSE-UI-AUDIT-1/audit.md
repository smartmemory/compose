# COMPOSE-UI-AUDIT-1: Compose UI status and gaps to "fully functional"

Owner ask (via s1-chat 2026-10-29 23:3x): "run an agent to audit and get status for compose UI and
figure out the gaps"; goal "we need compose UI to be fully functional". Audited 2026-10-29 at
compose
`8cea3463` by an Opus subagent. Read-only. Sibling: Orca steal list
[COMPOSE-UI-STEAL-1/steal-list.md](../COMPOSE-UI-STEAL-1/steal-list.md).

## In plain English

- **The cockpit is not running right now, and nothing keeps it running.** Its three ports are free
  and not even in the port registry, so this audit is from code and tests, not from clicking around.
- **What it was built for, it mostly does.** Following one feature from idea to shipped code, with
  its gates, live agent output, past builds, ideabox and a phone view: built, and all 626 UI tests
  pass.
- **What the owner now wants it for, it cannot see.** The daily work runs through cadence: chat and
  coordinator tabs, lanes, seats, quota, detached jobs, 4,030 unit folders, reviews, the owner
  question queue. None of that appears anywhere in the UI. The data readers exist (Stratum's new
  `session` commands and the status TUI's JSON), the screen was designed (COMP-COCKPIT-12) and never
  built.
- **One real hazard:** the cockpit's "launch agent" starts raw `claude` with permissions skipped
  and no seat pick or quota gate, so using it as a dispatcher would go around every launch control.

## Evidence base

- Live: `port_check.py 4001|4002|5195` all `free`; `port_check.py --list` has no compose/forge row;
  no `~/Library/LaunchAgents` entry; only per-session `compose-mcp.js` stdio processes run.
- Tests: `npx vitest run --maxWorkers=2` (jsdom only, no ports): 51 files, 626 passed, 2026-10-29
  23:27.
- UI code: `src/App.jsx` (1547 lines, view switch :256-391), 5 default tabs
  `src/components/cockpit/viewTabsState.js:20`, 10 hidden views :24-27 (COMPOSE-UX-SIMPLIFY-2,
  commit `483c19dd`, the only October UI commit). Mobile `/m`:
  `src/mobile/tabs/{Agents,Builds,Ideas,Roadmap}Tab.jsx`.
- Server: 116 distinct HTTP routes in `server/*.js`; agent server on 4002
  (`server/agent-server.js:8`),
  API 4001 (`server/index.js:102`), Vite 5195 (`vite.config.js:13`), supervisor
  `server/supervisor.js:38-59`.
- Designs: `ROADMAP.md` COMP-UI (:261-274, COMPLETE), COMP-COCKPIT 1-11 (:1442-1466, COMPLETE),
  COMP-COCKPIT-12/13 (:1467-1468, PLANNED), COMP-MOBILE + REMOTE (:1348-1349, COMPLETE),
  COMP-AUDIT-8..18 (:1544-1554, mostly PLANNED); `docs/features/COMP-COCKPIT-12/design.md`;
  `forge/stratum/docs/features/SESSION-MGMT-1/plan.md:1-3` (owner pick: Compose Sessions screen is
  "a later layer on top, not now"); `forge/stratum/docs/VISION.md` (humans audit and gate, not
  author).

## Gap table

| Screen / capability | Designed where | State | Evidence | Fully functional needs | Size |
|---|---|---|---|---|---|
| Cockpit is up and reachable | `server/supervisor.js:38-59` | BROKEN (not running) | ports free, not in `~/.ports`, no launchd | register 3 ports, supervised start, live smoke walk | S |
| Feature lifecycle (idea→design→blueprint→implement, gates) | COMP-UI-1..6, COMP-COCKPIT-1..11 | WORKS (code+tests; not seen live) | `DashboardView.jsx`, `GateView.jsx`, `PipelineView.jsx`; 626 tests pass | live golden-flow walk; COMP-AUDIT-8/9/11/12 bugs | S |
| Session / task view (which agent on which unit, live output) | COMP-COCKPIT-12 design :13-35 | PARTIAL | `SessionsView.jsx` hidden tab, shows only Compose's own hook sessions; stale "no sessions" note :19-21 (server does send them, `vision-server.js:467`); live output only for Compose-spawned agents (`AgentStream.jsx`, `LaneStrip.jsx`) | every iTerm tab and detached job, busy/idle, context size, unit, seat | M |
| Dispatch / queue (cadence lanes, seats, quota) | COMP-COCKPIT-12 design :19-29; SESSION-MGMT-1 shape 2 | MISSING | grep `seat\|quota\|usage_watch\|owner_queue` in `src/` `server/`: 0 hits; readers exist: `stratum session status\|fleet\|policy` (`stratum/ts/src/cli/session.ts:52-54`), `sm_status.py --json` (`:2148`, `:2205`) | Fleet tab + Ops pills over one reader | M |
| Launch/dispatch from the UI | SESSION-MGMT-1 D3 and U13/U14 (Compose diffs) | BROKEN (bypasses controls) | `server/agent-spawn.js:58` `spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'])`; no `SESSION-MGMT` commit in compose | launch through `stratum session launch` (pick + admit + job register) | M |
| Review view (diffs, findings, fix rounds) | COMP-REVIEW-ENH-*, cadence rule 7b | PARTIAL | Compose builds only: review-loop state `DashboardView.jsx:437-463`, `agent/ViolationDetail.jsx`, `shared/ArtifactDiff.jsx`; cadence reviews (`units/<ID>/review-*.md`, `batch/`) invisible | per-unit page: brief, report, VERDICT, findings table, rounds, adjudication | L |
| Roadmap view | COMP-UI-4, COMP-AUDIT-17/18 | PARTIAL | `GraphView.jsx` (default landing, AUDIT-18 "unreadable at default zoom"), `TreeView.jsx` hidden, mobile `RoadmapTab.jsx`; one workspace at a time; rollup COMP-COCKPIT-13 PLANNED | land on Dashboard, readable roadmap, cross-workspace rollup | M |
| Blocked / owner-question view | `AttentionQueueSidebar.jsx`; COMP-COCKPIT-12 :24 | PARTIAL | Compose gates and blocked items WORK; cadence owner queue (`owner_queue.py`) MISSING | owner-question list with age, read-only v1 | S (after Fleet) |
| Remote runners | COMP-AGENT-VENDOR-1, COMP-AGENT-DEVIN-1 (COMPLETE) | PARTIAL | vendor tiers server-side (`server/model-tiers.js:30-48`); no UI for detached jobs (`jobs.jsonl`) or other hosts; UI vendor picker unverified | jobs panel (running time, pid alive, report link) | M |
| Mobile / remote access | COMP-MOBILE, COMP-MOBILE-REMOTE (COMPLETE) | WORKS in code (not seen live) | `src/mobile/`, `cockpit/PairDeviceModal.jsx`, `lib/cli-remote.js` (JWT, QR, BYO tunnel); whether a tunnel is set up: unverified | mobile Status tab (COCKPIT-12); a live pair test | S |
| Published status / process metrics | COMP-COCKPIT-13 design | MISSING | `ROADMAP.md:1468` PLANNED | export + metrics panel | M |
| Information architecture | COMP-AUDIT-17/18 | PARTIAL | 5 tabs + 10 hidden views reachable only by links (`viewTabsState.js:20-27`) | tabs that match the jobs: Work, Fleet, Reviews, Roadmap, Ideas | M |

## Top gaps (what blocks "fully functional", in order)

1. **It is not running and has no home.** Unregistered ports, no supervised start, no live smoke
   test. Every other gap is invisible until this is fixed. (S)
2. **No fleet view.** The cockpit cannot show the work the owner actually runs: sessions, lanes,
   seats, quota, jobs, owner questions. Design exists (COMP-COCKPIT-12) but its open question (how
   Node reads the Python data, design.md:37) predates `stratum session`, which now offers a
   contracted JSON reader (`SESSION-MGMT-1/session-contract.json`). (M)
3. **Launching from the UI skips every launch control** (`agent-spawn.js:58`). Read-only is safe
   today; any "dispatch from the cockpit" needs SESSION-MGMT-1 U13/U14 first. (M, security-adjacent)
4. **No review or unit view for cadence.** 4,030 unit folders, verdicts and fix rounds live only
   as files. (L)
5. **Roadmap and navigation are single-workspace and hard to read** (AUDIT-17/18, COCKPIT-13). (M)

## Recommendation: next units (no dates)

1. **COMPOSE-UI-RUN-1**: register 4001/4002/5195, supervised on-demand or launchd start, and a
   Playwright golden-flow walk of every screen (screenshots, console errors) as the live baseline.
2. **COMP-COCKPIT-12 (re-scoped)**: Fleet tab + Ops pills + mobile Status tab, read-only, reading
   `stratum session fleet|status --json`, with `sm_status.py --json` for the sources Stratum lacks
   (owner queue, ledger tail, disk, spend). Owner picks the reader (question 1).
3. **SESSION-MGMT-1 U13/U14**: Compose spawns go through `stratum session launch`. Pre-land
   review (security-tagged in the plan).
4. **COMPOSE-UI-UNITS-1**: read-only unit and review page over `smart-memory-ops/units/<ID>/`
   (brief, report, VERDICT, findings, rounds, stamps). Reader choice unverified; check
  `unit_stamps.py`.
5. **COMP-AUDIT-17/18**: land on Dashboard, regroup tabs around the jobs above.
6. **COMP-COCKPIT-13**: cross-workspace rollup and process metrics.
7. **COMPOSE-UI-BUGS-1**: batch COMP-AUDIT-8, 9, 11, 12 (each named on `ROADMAP.md:1544-1554`).

Where the [Orca steal list](../COMPOSE-UI-STEAL-1/steal-list.md) helps: its rows 1-3 (visible
worktree per feature/agent, diff line notes sent back as gate "Revise", terminal pane with a
per-agent status light) fill the session view and part of gap 4. It cannot fill gaps 1-3 (fleet
data, launch controls), and it agrees Orca's own launcher would bypass the Stratum session door.

## Questions for the owner

1. Fleet reader: (a) `stratum session` JSON (contracted, recommended) plus `sm_status.py --json`
   for the rest, or (b) `sm_status.py --json` only (the COCKPIT-12 design's pick, made before
   `stratum session` landed).
2. Scope of v1: read-only cockpit (watch everything, act in chat), or also act (launch, answer
   owner questions)? Acting needs unit 3 first.
3. Always on (launchd) or opened on demand like PyCharm?
