# COMP-COCKPIT-12 — Multi-session status view in the cockpit

**Status:** COMPLETE · 2026-10-30 (owner request relayed 2026-10-08)

**Decision (OWNER via s1-chat, 2026-10-30 18:0x, record `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/COMP-COCKPIT-12/decision.md`):** the design question below is answered with three read-only readers, not the single `sm_status.py` poll recommended here. (1) `stratum session fleet --json` (contract `/Users/ruze/reg/my/forge/stratum/docs/features/SESSION-MGMT-1/session-contract.json`, `operations.fleet`) for the detached fleet; (2) `python3 ~/.claude/scripts/sm_status.py --json` for what Stratum does not cover (sessions, jobs, owner queue, disk, spend, ledger tail); Stratum wins where both supply a value (a job's liveness); (3) Cadence: ready units with their verdict and blockers from the mounted `/api/cadence-ui/belt` handler (COMPOSE-CADENCE-TAB-1, called in-process) plus the last `would_launch` line from the tail of `~/.cadence/shadow.jsonl`; never `~/.cadence/snapshot.json`, never the F33-affected agreement numbers. Reason: the owner picked the contracted Stratum JSON as the session source ("1 + cadence yes") and asked for Cadence's proposed launches beside it. v1 is read-only: watch everything, act in chat.

## Related Documents
- Cockpit shell (zones, Sessions tab, Ops strip): `/Users/ruze/reg/my/forge/compose/docs/cockpit.md`
- Parent: `COMP-COCKPIT` (`/Users/ruze/reg/my/forge/compose/docs/features/COMP-COCKPIT/`)
- House-shape precedent: `COMP-COCKPIT-9` (thin server routes + a view tab) at `/Users/ruze/reg/my/forge/compose/docs/features/COMP-COCKPIT-9/`
- Source TUI (read-only for this feature, never edited from here): `/Users/ruze/reg/my/SmartMemory/scratch/2026-10-08-status-tui/`
  - `sm_status.py`, `owner_queue.py`, `scan_readonly.py`, `brief.md` (data sources), `README.md`, `report.md`
- Installed 2026-10-08 13:50 at `~/.claude/scripts/` (`sm_status.py`, `owner_queue.py`, `scan_readonly.py`; confirmed by sm-coord). `python3 ~/.claude/scripts/sm_status.py --json` verified: exit 0, all six sources (sessions, jobs, queue, df, spend, ledger) `error: null`. Output is strict JSON (NaN/Infinity become null with an error). To stop it, send SIGTERM before killing the process group; it reaps its own fetch processes on SIGTERM/SIGHUP.

## Problem
The owner watches many Claude Code sessions at once. Today that view exists only as a terminal TUI (`sm_status.py`). The cockpit has a Sessions tab, an Ops strip and a mobile `/m` view, but none of them show multi-session health, the owner question queue, disk and spend, or the ledger. The owner cannot check it from a phone or from the cockpit.

## Hard requirement
Reuse the TUI's data readers. Do not write a second set of parsers in Node. One source of truth for how sessions, jobs, the owner queue, disk, spend and ledger are read.

## Data sources (from the TUI, `brief.md` and `sm_status.py`)
| Panel | Source the TUI reads | TUI symbol |
|---|---|---|
| Sessions: name, busy/idle, context K (yellow >=200K, red >=250K) | `scan_readonly.py` wrapping `~/.claude/scripts/iterm_sessions.py scan` (osascript, ~2.4 s) | `parse_scan` |
| Open jobs: session, id, kind, running time, pid alive | `~/.claude/session-state/jobs/*.jsonl` (folded like `jobs.py`) | `parse_jobs`, `pid_alive` |
| Waiting on the owner | `.../SmartMemory/scratch/2026-10-05-coordination/owner-queue.jsonl` (append-only, latest record per id wins) | `owner_queue.py` `open_items`, `parse_queue` |
| Disk free (red under 100 GB) | `df -k /System/Volumes/Data` | `parse_df` |
| Hourly spend | `.../scratch/2026-10-08-token-burn/attribute.py 1` (~1.5 s) | `parse_attr` |
| Ledger tail (last 10 lines) | `.../scratch/2026-10-05-coordination/ledger.md` (16 KB tail) | `read_tail` |

Read-only, no AI calls. Each source has its own refresh cadence in the TUI (3 s, 10 s, 60 s) and fails to `unavailable: <reason>` without crashing.

## UI placement (per cockpit.md)
- **Sessions tab (main area):** new "Fleet" section or sub-tab holding the full five-panel view. This is the primary home.
- **Ops strip (36 px):** add compact pills only: a red pill when any session is over 250K context, an amber pill when owner questions are open (count), a red pill when disk is under 100 GB free. Click opens the Sessions tab Fleet view. Entry types follow `OpsStripEntry.jsx` and `opsStripLogic.js`.
- **Mobile `/m`:** one read-only "Status" tab beside the existing `src/mobile/tabs/` entries (Agents, Builds, Ideas, Roadmap). Stacked cards: owner questions first, then sessions, jobs, disk and spend, ledger tail. No actions in v1.
- **Panel failure:** a source that errors shows `unavailable: <reason>` in its own card. If the reader itself is absent (see design question), hide the whole Fleet panel and Ops pills and log one warn line.

## Design question (DECIDED 2026-10-30, see the decision at the top): how does the Node server get the Python readers' data?
The Compose server is Node. The readers are Python in the SmartMemory scratch folder, moving to `~/.claude/scripts/` after review.

| | (a) Import the readers (Python sidecar or port) | (b) Shell out to `sm_status.py --once` | (c) Poll `sm_status.py --json` |
|---|---|---|---|
| One source of truth | Sidecar: yes. Port to Node: no, creates the second set the owner forbids | Yes, but output is rendered text, so the server must parse a UI frame | Yes. Structured `{generated, sources:{name:{value,error,ts}}}` |
| Install path `~/.claude/scripts` | Sidecar needs a long-running process and its own lifecycle | Same script path | Same script path |
| Python or script absent | Sidecar start fails, hide panel | Spawn error, hide panel | Spawn error or non-zero exit, hide panel |
| Polling cost | Lowest (sidecar caches per source on its own cadence) | Highest: each call refreshes all sources, ~2.4 s scan plus ~1.5 s spend | Same as (b) unless cached, since `--json` refreshes all sources in parallel |
| Mobile view | Same route as desktop | Same route, brittle text | Same route, JSON passes straight through |
| Coupling | Highest (new process, new protocol) | Brittle (frame layout changes break parsing) | Low: a documented JSON contract |

**Verified fact that shapes this:** `--json` already exists in the reviewed script. `sm_status.py` argparse defines `--json` and `dump_json()` prints `{generated, sources: {name: {value, error, ts}}}` (`/Users/ruze/reg/my/SmartMemory/scratch/2026-10-08-status-tui/sm_status.py`, `main` and `dump_json`; `report.md` row "opt" says all six sources returned `error: null` on a real run). Option (c) needs no change to the TUI to begin with.

**Recommendation:** option (c). The server spawns `python3 ~/.claude/scripts/sm_status.py --json` with a timeout, caches the result server-side for ~10 s so all clients share one spawn, and exposes it at one read-only route. The cockpit and `/m` poll that route. Concerns to settle in the blueprint: the slowest source sets the call time (about 4 s worst case, so cache and never spawn concurrently), and a later per-source `--json --only <name>` flag would allow different cadences. Revisit (a) only if per-source cadence or latency proves too coarse.

## Out of scope (v1)
- Any write action: answering owner questions, typing into tabs, closing jobs. The TUI is read-only and so is this.
- Editing anything under the SmartMemory scratch folder or `~/.claude/scripts/`. Contract changes to `--json` go through the SmartMemory owner of the TUI.
- Non-macOS hosts (the sessions source depends on iTerm2 via osascript).

## Acceptance criteria
- [x] Design question resolved by the owner and recorded at the top of this file with date and reason: top of this file (Decision, 2026-10-30)
- [x] No Node re-implementation of any reader: every panel value comes from the TUI's own readers: `server/fleet-routes.js:109-122` (sm_status JSON passed through, panels cut only), `:125-140` (Stratum envelope), `:196-216` (Cadence belt handler + shadow tail); no parser of the TUI's sources in Node
- [x] Server route (read-only, behind existing auth) returns the five panels' data, with per-source `error` preserved: `server/fleet-routes.js:294-305` `GET /api/fleet`, per-source `{value, error, ts}`; mounted `server/index.js:230-231` beside the other `/api` routes (remote auth gate, loopback otherwise)
- [x] Server caches the reader result so N clients cause at most one spawn per cache window, and never two concurrent spawns: `server/fleet-routes.js:233-270` single-flight cache, TTL `:34` (Stratum 10 s, sm_status 60 s, Cadence 60 s); test row `test/fleet-routes.test.js:83`
- [x] Spawn has a timeout and runs with no shell interpolation of user input: `server/fleet-routes.js:62-90` argv array, `shell: false` `:66`, SIGTERM then SIGKILL `:82-85`; test row `test/fleet-routes.test.js:107`
- [x] Reader path resolves `~/.claude/scripts/sm_status.py` (override via env var for tests): `server/fleet-routes.js:45-55` (`COMPOSE_FLEET_SM_STATUS`, `_PYTHON`, `_STRATUM_BIN`, `_CADENCE_SHADOW`)
- [x] Python, script or non-zero exit absent: Fleet panel and Ops pills hidden, exactly one warn line logged per outage, cockpit otherwise unaffected: per reader: `server/fleet-routes.js:250` one warn per outage, `:246` recovery line; test rows `test/fleet-routes.test.js:99,116,121,125,132,135`; all-down UI `test/ui/fleet-view.test.jsx:118-137`; live forced Stratum outage logged once (report)
- [x] Sessions tab shows the Fleet view: sessions (busy/idle, context K with 200K yellow and 250K red), open jobs with running time, owner queue with age, disk free and hourly spend, ledger tail: `src/components/vision/SessionsView.jsx:28-34,57-59`, `src/components/cockpit/FleetPanels.jsx`; test `test/ui/fleet-view.test.jsx:66`
- [x] Ops strip shows the compact pills (context over 250K, open owner questions, disk under 100 GB) and click opens the Fleet view: `src/components/cockpit/fleetLogic.js` `fleetPills`, `src/components/cockpit/OpsStrip.jsx:18-25`; test `test/ui/fleet-view.test.jsx:92`; shot `ops-pills.png`
- [x] Mobile `/m` has a read-only Status tab with the same data, readable at phone width: `src/mobile/tabs/StatusTab.jsx`, `src/mobile/MobileApp.jsx:165-167`, `src/mobile/components/BottomNav.jsx:8`; test `test/ui/fleet-view.test.jsx:102`; live at 390 px, no horizontal overflow (report)
- [x] A single failing source shows `unavailable: <reason>` in its own card on desktop and mobile: `src/components/cockpit/FleetPanels.jsx` `Unavailable`/`panelOr`; partial reads keep their rows under an `unknown` note; test `test/ui/fleet-view.test.jsx:66`
- [x] Polling pauses while the tab is hidden: `src/lib/fleetPoller.js:38-57`; test `test/ui/fleet-view.test.jsx:142`
- [x] Tests: route with fixture JSON, stale cache, spawn failure, timeout; UI tests for Fleet view, pills and mobile tab (real route, per `testing.md`, no mocked reader seam): `test/fleet-routes.test.js:56-151` (one table), `test/ui/fleet-view.test.jsx` (real route in `test/fixtures/fleet/serve.mjs`, fixture readers by env path)
- [x] `docs/cockpit.md` Zones and Ops Strip sections updated; CHANGELOG entry in the same commit: `docs/cockpit.md:33-34,57`, `CHANGELOG.md:5`
- [x] TUI install to `~/.claude/scripts/` (with `owner_queue.py` and `scan_readonly.py` together) confirmed before this ships (2026-10-08)

## Status
COMPLETE 2026-10-30 (report `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/COMP-COCKPIT-12/report.md`). Falsifier for "built": `ls /Users/ruze/reg/my/forge/compose/server | grep -i fleet` returns nothing or `feature.json` status is not COMPLETE.
