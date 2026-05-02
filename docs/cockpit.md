# Cockpit Shell

Web UI shell for Compose: layout, zones, navigation, and persistence.

`compose start` opens a browser-based cockpit at `http://localhost:3001`. The layout is organized around three zoom levels: Graph (macro), Tree (meso), and Detail (micro).

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
| **Header** | `ViewTabs` | Tab switcher for Graph, Tree, Docs, Gates, Pipeline, Sessions. Font/theme controls. |
| **Sidebar** | `AttentionQueueSidebar` | Build status, attention queue (blocked/gate items), search, group filters by feature code prefix. |
| **Main Area** | driven by active tab | Graph (fcose layout with compound grouping), Tree (search + filters), Docs (file browser + preview), and ops views. |
| **Context Panel** | `ContextPanel` | Resizable right panel with tabbed detail: Overview, Pipeline dots, Sessions, Errors, Files. Project summary when nothing selected. |
| **Ops Strip** | `OpsStrip` | Persistent 36px bar with scrollable pills for active builds, pending gates (inline approve), and recent errors. Hidden in Docs view. |
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
