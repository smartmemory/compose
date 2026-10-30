# Cockpit Shell

Web UI shell for Compose: layout, zones, navigation, and persistence.

`compose start` launches the browser-based cockpit. An npm install serves the shipped cockpit and API together at `http://localhost:4001`; a source checkout uses the Vite development server at `http://localhost:5195` with the API on `:4001`. The layout is organized around three zoom levels: Graph (macro), Tree (meso), and Detail (micro).

```
┌──────────────────────────────────────────────────────────────┐
│ Header │ [Graph | Tree | Docs | Gates | Pipeline | Sessions] │
├─────────┬──────────────────────────┬─────────────────────────┤
│         │                          │                         │
│ Sidebar │       MAIN AREA          │    CONTEXT PANEL        │
│ (~200px)│  (graph / tree / docs)   │   (resizable, ~420px)   │
│         │                          │                         │
├─────────┴──────────────────────────┴─────────────────────────┤
│ OPS STRIP  (active builds · pending gates · errors)          │
├──────────────────────────────────────────────────────────────┤
│ AGENT BAR  (collapsed | expanded | maximized)                │
├──────────────────────────────────────────────────────────────┤
│ GATE NOTIFICATION BAR  (hidden when no pending gates)        │
└──────────────────────────────────────────────────────────────┘
```

## Zones

| Zone | Component | Description |
|------|-----------|-------------|
| **Header** | `ViewTabs` | Tab switcher for Graph, Tree, Docs, Gates, Pipeline, Sessions. Font/theme controls, pair-device, and the `EnvironmentHealthPanel` health dot. |
| **Environment health dot** | `EnvironmentHealthPanel` | Always-visible header dot (green/amber/red) backed by `GET /api/environment-health`; click for a popover of `compose doctor` (dep + version drift) and `compose hooks status` (git-hook drift). Read-only; refetches on workspace switch + manual ↻. |
| **Sidebar** | `AttentionQueueSidebar` | Build status, attention queue (blocked/gate items), search, group filters by feature code prefix. |
| **Main Area** | driven by active tab | Graph (fcose layout with compound grouping), Tree (search + filters), Docs (file browser + preview), and ops views. |
| **Context Panel** | `ContextPanel` | Resizable right panel with tabbed detail: Overview, Pipeline dots, Sessions, Errors, Files. Project summary when nothing selected. |
| **Ops Strip** | `OpsStrip` | Persistent 36px bar with scrollable pills for active builds, pending gates (inline approve), recent errors, and the Fleet pills (COMP-COCKPIT-12). Hidden in Docs view. |
| **Fleet (Sessions tab)** | `FleetView` / `FleetPanels` | COMP-COCKPIT-12. A Fleet pane beside Agent sessions in the Sessions view: Claude sessions (busy/idle, context K, yellow at 200K, red at 250K), open jobs with running time, the detached fleet vs its cap (Stratum), the owner question queue, disk free, hourly and daily spend, Cadence's ready units with each unit's blocker reasons plus one "Cadence would start" line (the proposed units or `none`, the top four blocker rules, and the wall when one held the launch), and the ledger tail. Read-only (watch here, act in chat). Data: `GET /api/fleet` (`server/fleet-routes.js`) over three readers: `stratum session fleet --json`, `sm_status.py --json`, and the mounted Cadence handler's belt plus the last `would_launch` line of `~/.cadence/shadow.jsonl`. A reader that is down hides only its own cards and pills and logs one warn line per outage. A failing source inside a reader shows `unavailable: <reason>` in its own card. A source that `sm_status` read only in part (an error next to its rows) shows the rows under an `unknown: <reason> (rows shown are a lower bound)` note, as its TUI does. One shared poll every 15 s (`src/lib/fleetPoller.js`), paused while the browser tab is hidden. The Sessions view is not a default tab: reach it from a Fleet pill or the Settings default view. Mobile `/m/status` shows the same cards stacked, owner questions first. |
| **Process (tab)** | `ProcessView` / `OwnerQueueCard` | COMP-COCKPIT-13. A read-only tab after Usage (flat view key `process`, deep link `?view=process`) on how unit work has been flowing. The builder's master process table (every cell verbatim from `OPS/status/out/master/process.json`, the seven pages as columns each with its `as of` and a stale or build-failed marker), a click on a column opens that page's figures from its `summary.json` (waiting share, first-pass CLEAN, review rounds, gate minutes, standard-process feeds, the builder's `basis` and `no_data` text verbatim, a missing key reads `not reported`), the time split per stamp lane (authoring, review, fix rounds, gate, waiting on owner, waiting, from unit stamps, with `M known, N unknown (rule), K not in split`, an unknown unit is never counted as 0) and the owner queue card (the Fleet card, moved into `OwnerQueueCard`). Compose computes no builder figure. Data: `GET /api/process` (`server/process-routes.js`) and, for the owner card only, the shared `GET /api/fleet` poll. One shared 60 s poll (`src/lib/processPoller.js`), paused while the browser tab is hidden. A source that is down shows its own `unavailable: <reason>` card and the others still render. |
| **Agent Bar** | `AgentBar` | Always-present bottom panel for the agent stream. Collapsed/expanded/maximized. |
| **Gate Notification** | `GateNotificationBar` | Carousel of pending gates with Approve/Revise/Kill. |

## Graph View

Uses `cytoscape-fcose` (force-directed with compound node support):

- **Compound grouping** by feature code prefix (COMP-UX, STRAT-ENG, etc.). Groups sorted by active item count.
- **Status filters**: All, Active (default), Done, Blocked.
- **Group filters** in sidebar — click to hide/show per feature group.
- **Build state overlays**: building (blue pulse), gate-pending (amber), blocked-downstream (dimmed 35%), error (red).
- **Badge overlays**: gate badge with approve/revise/kill popover, error badge, agent badge.
- **Selection**: click to highlight dependency chain. Cross-view navigation via context panel links.

## Context Panel

Tabbed detail surface (5 tabs: Overview, Pipeline, Sessions, Errors, Files). Resizable via drag handle (min 280px, max 60% viewport), persisted in `localStorage`. Shows project summary when nothing selected.

## Ops Strip

Persistent 36px bar with three entry types (blue build pills, amber gate pills with inline approve, red error pills). Completed builds flash green 2s. Hidden in Docs view.

Fleet pills (COMP-COCKPIT-12), from the same `GET /api/fleet` poll as the Fleet view: a red pill when any session is at or over 250K context (`N sessions >250K`), an amber pill when owner questions are open (`N owner questions`), and a red pill when disk is under 100 GB free (`disk N GB free`). They use the `--destructive` and `--warning` tokens (`fleet-red`, `fleet-amber` in `OpsStripEntry`). Clicking one opens the Sessions view on its Fleet pane. They have no approve or dismiss control. When the `sm_status` reader is down they are hidden, and the strip itself still hides when it has no entries.

## Sidebar

Build status, attention queue (blocked + pending gates), search, and group filters (feature code prefix groups sorted by active count, click to toggle).

## Agent Bar

Three states: collapsed (~36px status line), expanded (message stream + chat), maximized (fills main area). Sending a message with a feature code auto-selects that feature.

## Cross-View Navigation

Selection persists across view switches. Graph pans to selected node, Tree scrolls to selected row. "View in Graph" / "View in Tree" links in context panel. File click opens DocsView with back button.

## State Persistence

| `localStorage` key | Default |
|--------------------|---------|
| `compose:activeView` | `'graph'` |
| `compose:agentBarState` | `'collapsed'` |
| `compose:contextPanel` | `'open'` |
| `compose:contextWidthPx` | `420` |
| `compose:fontSize` | `13` |
| `compose:theme` | system |

## Error Boundaries

`SafeModeBoundary` wraps the full shell. Each zone has a `PanelErrorBoundary` — a crash in one zone does not take down the rest.
