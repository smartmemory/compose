# COMP-AUDIT-17 + COMP-AUDIT-18: cockpit navigation and landing page (design)

**Status:** SLICE 1 BUILT 2026-10-30 (home page, readable map, labelled header; report `smart-memory-ops/units/COMP-AUDIT-17-18/report-slice1.md`). Slice 2 (rooms, focus) not started. Design history: DESIGN, fix round 1 of 2 (2026-10-30, Opus `hard:`), read-only of compose `8a870e32`. Round 1
(`c6f530e3`, read of `b6031a44`) went to an Opus design review
(`smart-memory-ops/units/COMP-AUDIT-17-18/review-r1.md`, NOT CLEAN H1 M6 L10). This round corrects the
"feature-scoped views" premise (H1), so the shape comparison and the recommendation in §2 and §7 changed:
**the recommendation is now shape A (labelled rooms), not B.** Next: final design review (round 2), owner
picks, then a build unit. No source changes in this unit.
**Covers:** COMP-AUDIT-17 (information architecture) and COMP-AUDIT-18 (landing page, inert status bar,
one status surface). AUDIT-18's third clause (three status models on one item) is split out: see §5.
**Line numbers** are compose `8a870e32`. COMP-OBS-STATS-1 (`a986f9de`) landed after round 1, added the
`usage` view and shifted `src/App.jsx` by +3 after line ~389. COMP-COCKPIT-12 (`f894877f..467ed5d6`) landed
during this round: no new view key, but the Sessions view gained a Fleet pane, OpsStrip gained Fleet pills,
and one new view switch (`handleOpenFleet`, `App.jsx:818-821` at `467ed5d6`) opens Sessions ▸ Fleet. It is
folded into §1.3, §2.1 and §2.6; other `App.jsx` citations after line ~263 sit +2 to +13 at `467ed5d6`.

## Related Documents

- Audit rows: `ROADMAP.md` COMP-AUDIT-17/18 (`ROADMAP.md:1553-1554`), feature files
  [../COMP-AUDIT-17/feature.json](feature.json), [../COMP-AUDIT-18/feature.json](../COMP-AUDIT-18/feature.json)
  (pointer [../COMP-AUDIT-18/README.md](../COMP-AUDIT-18/README.md)). Phase model: COMP-AUDIT-11 (`ROADMAP.md:1547`).
- Status audit: [../COMPOSE-UI-AUDIT-1/audit.md](../COMPOSE-UI-AUDIT-1/audit.md) (:60 IA row with its target
  "Work, Fleet, Reviews, Roadmap, Ideas", :88 next unit 5).
- Tab integration: [../COMPOSE-UI-INTEGRATION-1/design.md](../COMPOSE-UI-INTEGRATION-1/design.md) (Ops, Stratum,
  Cadence, Wiki tabs; packages imported as components, tab hidden when the package is absent).
- Usage tab: [../COMP-OBS-STATS-1/design.md](../COMP-OBS-STATS-1/design.md) (`a986f9de`, the 20th view).
- Prior cut: COMPOSE-UX-SIMPLIFY-2 (`483c19dd`, five tabs, the rest hidden).
- Neighbours: COMP-AUDIT-11 (phase model), COMP-AUDIT-16 (dead WS protocol), COMP-COCKPIT-12/13.

## 0. What changed since the audit row was written (2026-07-12)

The row says "14 flat top-level views". Today it is **10 tabs + 10 hidden views = 20 views**:
COMPOSE-UX-SIMPLIFY-2 hid ten, the Ops/Stratum/Cadence/Wiki tabs added four, and COMP-OBS-STATS-1 added
Usage (`src/components/cockpit/viewTabsState.js:20,24-27`). The tabs carry text labels already
(`ViewTabs.jsx:22-42`); the **unlabelled icons are the right-hand header controls**, not the tabs.
Dashboard is first in the tab list, yet a fresh cockpit **still lands on the Graph**, for a reason the
audit did not name (§4.1).

## 1. Inventory (compose `8a870e32`)

### 1.1 Views (`CockpitView` switch, `src/App.jsx:267-419`)

"Feature" column: **F** = needs a feature to show anything useful; **P+f** = a project view with an optional
feature filter (works with no feature chosen); **-** = no feature notion. Evidence is in §2.0.

| View key (label) | Tab? | Feature | What it shows | Data source | Reachable from | Overlaps with |
|---|---|---|---|---|---|---|
| `dashboard` (Dashboard) | tab 1 | F (body) | One feature: phase timeline, agents, iterations, its gates, recent sessions, event timeline. With no bound session: "No feature in progress." + 5 completed features | vision store; feature = `sessionState.featureCode` (`App.jsx:499`), `DashboardView.jsx:283-344` | tab | Sidebar, OpsStrip, ContextPanel summary, ContextItemDetail Overview |
| `graph` (Graph) | tab 2 | P+f | All items + connections, cytoscape fcose, build/agent overlays, gate popover | vision store `items`, `connections` (`App.jsx:302-322`) | tab; "View in graph" (`App.jsx:1095-1100`) | `tree` (same items) |
| `docs` (Docs) | tab 3 | P+f | File tree + markdown preview, feature-focus filter | `/api/files`, `/api/file` (`DocsView.jsx`) | tab; item "open file" (`navigateToDocs`, `App.jsx:1109-1113`) | Wiki (feature hub) |
| `ideabox` (Ideabox) | tab 4 | - | Ideas funnel, triage, promote | `useIdeaboxStore` (`IdeaboxView.jsx:19`) | tab; sidebar Ideas row (`AttentionQueueSidebar.jsx:256`) | none |
| `ops` (Ops) | tab, if pages exist | - | 8 ops status pages, iframed, 15 min stale | `/ops-status/<name>/status.html` (`OpsView.jsx:38`) | tab | Cadence (live) |
| `stratum` (Stratum) | tab, if package | - | Runs list, run DAG, Stratum gates inbox | `@smartmemory/stratum-ui` via `/api/stratum-ui` (`StratumView.jsx:2-4,20-33`) | tab | `build-history`, `pipeline`, `gates` |
| `cadence` (Cadence) | tab, if package | - | Seat strip + Board / Chains / Attention / Diary | `@cadence/ui` via `/api/cadence-ui` (`CadenceView.jsx:2-4,7-12`) | tab | `sessions`, Ops |
| `wiki` (Wiki) | tab, if configured | P+f | Feature pane (FeatureHub for a code), Search pane, "Open full wiki" iframe | `@wiki/components` via `/api/wiki` (`WikiView.jsx:13-27,64-72`) | tab | Docs |
| `usage` (Usage) | tab (no predicate) | - | Token/cost KPIs, usage over time, by-model table, current workspace | `usageClient.js` (`UsageView.jsx:1-8`) | tab | Cadence seat strip (seat %, different data) |
| `settings` (Settings) | tab (last) | - | Settings form | vision store `settings` (`SettingsPanel.jsx`) | tab; `,` key (`App.jsx:704`) opens `SettingsModal` | `SettingsModal` |
| `tree` (Items) | hidden | P+f | Item hierarchy list | vision store | "View in tree" (`App.jsx:1102-1107`) | `graph` |
| `gates` (Gates) | hidden | P+f | Compose gates, approve/revise/kill | vision store `gates` (`GateView.jsx`) | gate open (`App.jsx:1017`), GateToast (`App.jsx:1517`) | Dashboard gates, OpsStrip, Stratum gates inbox |
| `pipeline` (Pipeline) | hidden | P+f | The one live build's steps, draft approve/reject | `activeBuild`, `/api/pipeline/draft/*` (`PipelineView.jsx`) | **nothing** | Stratum run DAG, ContextItemDetail Pipeline |
| `pipeline-editor` (Pipeline Editor) | hidden | - | Visual editor for `*.stratum.yaml` | `/api/pipeline/specs` (`PipelineEditor.jsx:1-14`) | **nothing** | STRAT-UI-BUILDER-1 (Stratum tab, planned) |
| `sessions` (Sessions) | hidden | P+f | Compose hook sessions; Fleet pane since COMP-COCKPIT-12 | vision store `sessions` (`SessionsView.jsx`) | OpsStrip Fleet pill opens its Fleet pane (COMP-COCKPIT-12, `467ed5d6`) | Cadence seat strip, Dashboard recent sessions, ContextItemDetail Sessions |
| `build-history` (Builds) | hidden | P+f | Past Compose builds, own feature search box | `fetchBuildHistory` (`App.jsx:905-908`), `PastBuildsView.jsx:57` | **nothing** | Stratum runs (unverified how much) |
| `validate` (Validate) | hidden | P+f | `compose validate` findings, project or feature scope | `/api/validate` (`ValidateView.jsx:24-53`) | **nothing** | none |
| `qa-scope` (QA Scope) | hidden | F | Affected routes for a feature, else the active build's feature | `/api/qa-scope` (`QaScopeView.jsx:31-68`) | **nothing** | none |
| `journal` (Journal) | hidden | - | Journal + changelog entries | `/api/journal`, `/api/changelog` (`JournalView.jsx`) | **nothing** | Docs (CHANGELOG file) |
| `design` (Design) | hidden | P+f | Design-agent conversation, product or feature scope, decisions sidebar | `useDesignStore` (`DesignView.jsx:2,88,95-96`) | **nothing** | none |

"Nothing" = no tab, no `handleViewChange('<key>')` call (only `gates`, `graph`, `tree`, `docs`, `ideabox`
and a saved previous view have one; full list in §2.6), no `EntityLink kind="view"` user (grep:
`EntityLink.jsx:26` maps the kind, no caller passes it), and the command palette searches items, gates and
sessions only (`src/components/vision/shared/CommandPalette.jsx:5-6`). **Seven shipped views are unreachable
by clicking, and Sessions has a door only while the OpsStrip shows a Fleet pill** (a session over 250K,
an open owner question or disk under 100 GB, COMP-COCKPIT-12). The only other doors: the Settings "default view" picker (§4.1) and the `visionUI` WS
command (`visionMessageHandler.js:88`, applied at `App.jsx:691`), which no server code emits (grep
`visionUI` in `server/ lib/`: 0 hits).

### 1.2 Header controls (right side, `src/App.jsx:1163-1253`)

| # | Glyph | Label today | Does | Line |
|---|---|---|---|---|
| 1 | "disconnected" text | text | WS down indicator (repeated in sidebar `AttentionQueueSidebar.jsx:361`) | 1167 |
| 2 | health dot | tooltip | `compose doctor` + hooks drift popover | 1172 |
| 3 | build icon | tooltip | Build all PLANNED / GSD `<CODE>` (spawns agents) | 1175 |
| 4 | 🚀 | tooltip | Launch fix / new / resume lifecycle (spawns agents) | 1185 |
| 5 | ➕ | tooltip | New feature scaffold dialog | 1202 |
| 6 | 📱 | tooltip | Pair mobile device | 1209 |
| 7 | ☀/☾ | tooltip | Theme (repeated in sidebar header) | 1218 |
| 8-11 | A− · 14 · A+ · 100% | none | Font size down / readout / up / reset | 1228-1253 |

Left of these, inside `ViewTabs`: Maya (labelled, if installed) and ⌘K search (`ViewTabs.jsx:84-108`).
Plus the sidebar's "+ New" (generic vision item, `AttentionQueueSidebar.jsx:364-372`; the same dialog as
⌘N, `App.jsx:703`), a **third create button** next to ➕ (scaffold) and 🚀 "new" (agent lifecycle), each
making a different thing.

### 1.3 Status surfaces and per-feature panels

| Surface | Where | Scope | Feeds from | Problem |
|---|---|---|---|---|
| StatusBand | top of main, 32px, every view (`App.jsx:1342`) | one feature | `sessionState.featureCode` only (`App.jsx:499`) | Says "Select a feature to see status." (`StatusBand.jsx:20`), but selecting an item never changes it (`handleSelect`, `App.jsx:769-778`, sets only `selectedItemId`). It fills only when an agent session binds a feature. **Inert for a human.** |
| DecisionTimelineStrip | under StatusBand, 72px, when bound (`App.jsx:1347-1349`) | one feature | same | fine when shown |
| OpsStrip | bottom, 36px (`App.jsx:1463`) | project | active build, pending gates, recent errors | **Not persistent:** returns `null` on Docs and whenever it has no entries (`OpsStrip.jsx:177-180`; since COMP-COCKPIT-12, no entries and no Fleet pills, `OpsStrip.jsx:184` at `467ed5d6`); entries can be dismissed (`dismissedRef`, `OpsStrip.jsx:24,141,162`). Entry click selects that feature (`OpsStrip.jsx:208` → `handleOpsSelectFeature`, `App.jsx:813-822`) |
| Sidebar CompactStatsRow + BuildStatusWidget + AgentPanel + attention queue + Ideas row | left (`AttentionQueueSidebar.jsx:385-416`) | project | items, gates, activeBuild, agents, ideabox | build widget duplicates OpsStrip and Dashboard. The attention queue's `onViewChange` prop is unused (`AttentionQueueSection`, `:97`); only the Ideas row navigates (`:256`) |
| DesignSidebar | replaces the left sidebar while on `design` (`App.jsx:1287`) | design session | `useDesignStore` decisions | fine, keyed on the view (§2.6) |
| ContextPanel "project summary" | right, no selection (`ContextPanel.jsx:59,128-180`) | project | activeBuild, pending gates (`pending` or `awaiting`, `:59`), errors | third copy of build + gates |
| **ContextItemDetail** (right panel, an item selected) | right (`ContextItemDetail.jsx:63`) | one item / feature | tabs Overview / Pipeline / Sessions / Errors / Files / Recall (`contextPanelState.js:68-75`) | **already a per-feature tab page**, missed in round 1 (review M6). Any new per-feature page must reconcile with it |
| OpenLoopsPanel | right, when a session feature is bound, not on Docs (`App.jsx:1446-1449`) | one feature | `activeFeatureCode` | same inert-for-a-human source as StatusBand |
| AgentBar collapsed text | bottom (`AgentBar.jsx`) | agent | `compose:agent-status` event | fine (agent chat, not status) |
| Gate badge on tabs | header (`App.jsx:1153`) | project | pending gates | **dead:** keyed `gates`, which is not a tab since SIMPLIFY-2 (`ViewTabs.jsx:57` looks badges up by tab) |
| NotificationBar, GateNotificationBar, GateToast | bottom / toast (`App.jsx:1488,1495,1514-1518`) | events | transient | transient, not status; keep |

Sidebar group counts: each group row shows two unlabelled numbers, active count in the primary colour
and total in grey (`AttentionQueueSidebar.jsx:222-226`).

## 2. Navigation shapes

### 2.0 Which views actually need a feature (corrected; round 1 got this wrong)

Round 1 said six views are "feature-scoped" and that Validate, QA scope and Design "have no way to choose a
feature except a bound agent session, so they stay half-empty". **That was false.** Most of them are project
views that offer an optional feature filter, and they work with no feature chosen:

| Truly feature-scoped (needs a feature) | Project view with an optional feature filter (works with none) |
|---|---|
| **Dashboard body**: with no feature it shows "No feature in progress." + 5 completed features (`DashboardView.jsx:316-344`); the code comes only from the bound session (`App.jsx:276` prop, fed `App.jsx:1393` from `:499`) | **Validate**: project scope is the default (`ValidateView.jsx:25` `useState('project')`), falls back to project with no code (`:32`), the feature option is disabled as "Feature (none focused)" (`:71-72`) |
| **QA scope**: needs a code; with none it resolves the active build's feature (`QaScopeView.jsx:38,42-55`); with no build there is nothing to show | **Gates**: all gates unless the focus toggle is on (`GateView.jsx:333`); the gate jump turns the toggle off on purpose so every gate shows (`App.jsx:1013-1017`) |
| **Wiki's Feature pane** only: "Select a feature, or type its code above." with no code (`WikiView.jsx:70-72`) | **Docs**: all files unless the focus toggle is on (`DocsView.jsx:285-286`) |
| | **Design**: a Product Design session (`DesignView.jsx:88` `startSession('product')`) and a Feature Design session whose code the user types (`:95-96`), with its own persisted scope (`useDesignStore.js:46-48`); it never reads App's feature code (`App.jsx:384`) |
| | **Wiki** as a whole: Search and "Open full wiki" need no code (`WikiView.jsx:65-66,73-76`) |
| | **Live build** (`pipeline`): the single project-wide `activeBuild` (`App.jsx:324-331`) |
| | **Builds** (`build-history`): gets no feature prop (`App.jsx:346-352`) and has its own feature search box (`PastBuildsView.jsx:57`) |
| | **Graph, Items (tree), Sessions**: the focus toggle only (`App.jsx:297-299,319-321,341-343`) |

The other eight (ideabox, ops, usage, stratum, cadence, journal, pipeline-editor, settings) have no feature
notion. So the honest count is **2 feature-only views plus one Wiki pane, 10 project views with an optional
filter, 8 with no feature notion** (20). Consequences for the shapes: (1) no shape may hide a project view
behind a feature choice; (2) the old weak spot of A and C ("feature-scoped views stay half-empty") mostly
goes away; (3) what is genuinely missing is a way for a **human** to say "I am looking at feature X" that the
StatusBand, the filters and the two feature-only views all respect (§2.5).

### 2.1 Shape A: labelled rooms (recommended)

**Like a building with a few labelled doors; each door opens a room with its own small row of tabs.**
This is the ROADMAP row's idea (`ROADMAP.md:1553` "Work / Review / Build / Knowledge") merged with the status
audit's target ("Work, Fleet, Reviews, Roadmap, Ideas", `COMPOSE-UI-AUDIT-1/audit.md:60`).
First load: Home. Top row: `Home · Roadmap · Ideas · Review · Build · Fleet · Library` + gear, and a
`Feature: CODE ×` chip at its right end while a feature is focused (§2.5). A room with more than one view
shows a second row; Home and Ideas have none.

| Room | Sub-tabs (view keys) | Works with no feature focused? |
|---|---|---|
| Home | `dashboard` (fattened, §4.2) | yes, project-wide; a focused feature adds a section on top |
| Roadmap | Graph (`graph`) with a List toggle (`tree`) | yes |
| Ideas | `ideabox` | yes |
| Review | Gates (`gates`), Validate (`validate`), QA scope (`qa-scope`) | yes; QA scope falls back to the active build |
| Build | Design (`design`), Live build (`pipeline`), Builds (`build-history`), Flow editor (`pipeline-editor`) | yes |
| Fleet | Cadence, Stratum, Ops (same availability predicates as today, `App.jsx:1149`), Sessions (`sessions`, with its Fleet pane), Usage (`usage`) | yes; never empty (Sessions and Usage have no predicate) |
| Library | Docs (`docs`), Wiki (`wiki`, if configured), Journal (`journal`) | yes |
| gear | Settings (`settings`); `,` still opens SettingsModal | yes |

All 20 keys have a home, every one is at most two clicks from the top, and none depends on focus.
Merged: tree into Roadmap. The gate badge moves to Review.
Cost: shape-neutral core of §2.5-§2.7 (focus model, `VIEW_KEYS` + `locateView`, `migrateNavState`) +
`ViewTabs` second row + chip, ~10 files, **M**.
**Weak spot:** a user following one feature still moves between rooms (Review for its gates, Build for its
builds). The focus chip carries the feature with them, so each room opens already filtered to it.

### 2.2 Shape B: rooms + a Feature page (restated)

**Like A, plus a binder tab for the feature you are looking at.** Round 1's B put Validate, Gates, Design,
Live build, Builds and Wiki *only* under a Feature tab that "appears only when one is focused"; with no focus
those screens became unreachable (review H1). Restated so that cannot happen: **B = A's rooms exactly, plus**
a `Feature: CODE` top tab while a feature is focused, whose page shows Overview (today's per-feature dashboard
body) and pre-filtered copies of Gates, QA scope, Docs and Builds. With no focus, B is A.
**Overlap it must resolve (review M6):** the right panel already shows a per-item tab page for the selected
feature, Overview / Pipeline / Sessions / Errors / Files / Recall (`contextPanelState.js:68-75`,
`ContextItemDetail.jsx:63`). B must either absorb those tabs into the Feature page and cut the right panel
to a summary (moves a shipped surface; Recall and Files tabs move too), or keep both and show two tab sets
for one feature at the same time, which is the overlap this unit exists to remove.
Cost: A + Feature host + the reconciliation above, ~14 files, **M+ to L**.
**Weak spot:** its one gain over A, "a page for one feature", already exists as the right panel.

### 2.3 Shape C: keep flat tabs, add a "More" menu

**Like today's menu bar plus an overflow drawer.** First load: Dashboard. Tabs stay as the 10 of today; a
"More ▾" holds the 10 hidden views by name; tree becomes a List toggle inside Graph. The focus model
(§2.5) applies the same way.
Cost: ViewTabs dropdown + labels + the shape-neutral core, ~6 files, **S to M**.
**Weak spot:** a drawer of ten names nobody can tell apart (Pipeline vs Pipeline Editor vs Builds vs Runs)
is the original complaint, now one click deeper, and the top row stays at 10 ungrouped tabs. (Round 1's
second weak spot, "the feature-scoped views stay empty", was wrong: they are project views, §2.0.)

### 2.4 Recommendation

**Shape A**, changed from B in round 1. Why: B's case rested on screens that "need a feature", and they do
not (§2.0); once B is fixed so nothing hides behind a focus, B is A plus a second per-feature tab page that
duplicates the right panel's. A gives all 20 screens a labelled home within two clicks, matches what both
audits asked for, and costs less than B. C is the cheap fallback if the owner wants the smallest change.
Built in two slices so the parts every shape needs land first:
- **Slice 1 (any shape, S):** §4 landing fixes, §3 header labels and the shared view list. Ships whichever
  shape is picked; box-by-box shape independence is stated in §6.
- **Slice 2 (M):** the shape-neutral core (§2.5-§2.7), then the picked shape's layout.

### 2.5 The focused feature (shape-neutral; one control, exact rules)

Today there are three "current feature" notions: the bound session's code (`activeFeatureCode`,
`App.jsx:499`), the selected item (`selectedItemId`, `App.jsx:517`, set by `handleSelect` `:769-778`), and
Wiki's "selected item wins over session" rule (`App.jsx:395-399`). Selection-derived focus (round 1) is
unstable: re-clicking the selected item deselects it (`App.jsx:771-775`), clicking an item with no code
would swap to the session's feature, and a reload drops selection (`selectedItemId` starts `null`, `:517`).
New rule: **focus is explicit state, separate from selection.**

- **State:** `focusedFeature` (a feature code or `null`) in App, persisted in localStorage
  `compose:focusedFeature` (new key).
- **Set by:** the "Focus" button in the right panel's item header (ContextItemDetail), shown only for an item
  whose code resolves. Nothing else sets it: not selection, not a graph click, not an OpsStrip entry, not an
  agent session binding.
- **Code resolution order for an item:** `item.featureCode || item.feature_code || item.lifecycle?.featureCode`
  (the order at `App.jsx:397` and `openFeature`, `:1025-1027`). No title-prefix match: `title.includes(code)` in
  `handleOpsSelectFeature` (`:819`) is a code-to-item lookup, not a source of codes. An item with no code
  gets no Focus button.
- **Cleared by:** only the × on the `Feature: CODE ×` chip; also on project switch, and on load when the
  persisted code no longer resolves to any item (a WARNING console line, no-silent-degradation).
- **Not changed by:** re-clicking the selected item, selecting a non-feature item (idea, decision, question,
  task), selecting another feature's item, deselecting. Selection drives the right panel only.
- **What reads it:** one pure `resolveFeatureContext({focusedFeature, sessionState})` →
  `{code, source: 'focus' | 'session' | null}` (focus wins; else the bound session's code).
  - *Filters* (Graph, Items, Docs, Gates, Sessions, Builds' search box, Validate's feature option) apply
    **only when `source === 'focus'`**, so an agent binding a session never silently filters a project view.
  - *Displays* (StatusBand, DecisionTimelineStrip, OpenLoopsPanel, Home's feature section, QA scope's code,
    Wiki's initial code) use `code` whatever the source. The StatusBand names the source ("Focused: X" or
    "Agent session: X").
  - Wiki keeps its own rule for its *initial* code (selected item, else `code`), because it is a starting
    value for its type-a-code box, not a filter (`App.jsx:395-399`).
- **One control, not two:** the per-view "Focus: CODE" toggle (`shared/FeatureFocusToggle.jsx`, used by
  Graph, Items, Docs, Gates, Sessions; `focusFeature` state `App.jsx:569`) is retired; the chip is the only
  focus control.
- **Gate jump:** `openGate` stops clearing the filter (`setFocusFeature(false)`, `App.jsx:1015`); GateView
  always includes the jumped-to gate (`focusedGateId`) even when the focus filter would hide it.
- **Shape B only:** when × clears focus while the Feature tab is active, the view moves to the same leaf in
  its room (all exist there), else Home.

### 2.6 The view key stays flat; rooms are derived (shape-neutral, review M5)

`activeView` stays the leaf view key (`gates`, `tree`, ...). One pure `locateView(key)` → `{top, sub}` gives
the tabs to highlight; `handleViewChange(key)` (`App.jsx:643-648`) keeps its signature. So every site that
reads or sets `activeView` keeps working; the table lists each one and its change.

| Site | What it does with the view key | Change |
|---|---|---|
| `App.jsx:518-524` | initial `activeView` from `compose:activeView`, excludes hidden + stratum/cadence/wiki but not `ops` or `usage` | replaced by `migrateNavState` (§2.7) |
| `App.jsx:441,446,636-640` | `mainTabs` / `activeTab` state, `setActiveTab` | retired; the tab rows derive from `locateView(activeView)` and call `handleViewChange` |
| `App.jsx:643-648` | `handleViewChange` sets view + active tab | keeps signature; stops writing the active-tab key |
| `App.jsx:651-659` | persists `compose:activeView`, clears docs back-nav on leave | unchanged |
| `App.jsx:680-686` | applies `settings.ui.defaultView` on first connect | slice 1: only if reachable (§4.1) |
| `App.jsx:691` | server `visionUI` `view` command | unknown keys ignored with a console WARNING |
| `App.jsx:864` | snapshot provider reports `activeView` | unchanged |
| `App.jsx:896-901` | design-doc context panel on `design` | unchanged |
| `App.jsx:905-908` | build-history fetch on `build-history` | slice 1: also on `dashboard` (Home "Recent builds") |
| `App.jsx:1017` | gate open → `gates` | unchanged key; stops clearing focus (§2.5) |
| `App.jsx:1049` | EntityLink `openView` | unchanged; unknown keys ignored with a WARNING |
| `App.jsx:1099`, `:1106` | "View in graph" / "View in tree" | unchanged (tree locates to Roadmap ▸ List) |
| `App.jsx:1109-1121` | `navigateToDocs` / back | unchanged |
| `App.jsx:1151-1153` | ViewTabs `onTabChange`, dead `gates` badge | replaced by the two-row nav; badge on the room holding `gates` |
| `App.jsx:1287` | DesignSidebar swap on `design` | unchanged |
| `App.jsx:1298` → `AttentionQueueSidebar.jsx:256` | Ideas row → `ideabox` | unchanged |
| `App.jsx:1408`, `:1446`, `OpsStrip.jsx:178`, `contextPanelState.js:17` | hide ContextPanel / OpenLoopsPanel / OpsStrip on `docs` | unchanged; `:1446` reads `resolveFeatureContext` |
| `App.jsx:1517` | GateToast → `gates` | unchanged |
| `App.jsx:818-821` (`467ed5d6`) | OpsStrip Fleet pill → `sessions` with the Fleet pane | unchanged key; locates to Fleet ▸ Sessions |
| `VisionTracker.jsx:49,59,270` | popout window's own view state | slice 1 only (§4.1, L2) |

### 2.7 Every stored navigation value and where it lands (shape-neutral, review M2)

One pure `migrateNavState({activeViewRaw, activeTabRaw, tabsRaw, defaultView, focusRaw, items, available})`
→ `{view, focus}` runs once on load. `view` is always a key in `VIEW_KEYS` that is reachable given `available`
(the package/page predicates, `App.jsx:1149`); the fallback is always `dashboard` (Home). Precedence:
`compose:activeView`, then the active-tab key, then `defaultView`, then `dashboard`.

| # | Stored value (writer) | Possible contents | Lands on |
|---|---|---|---|
| 1 | tab list, `viewTabsState.js:95` (read `loadMainTabs` `:101-127`; `saveMainTabs` `:132` has no caller in `src/`) | old 8-tab lists, today's 10, garbage | ignored and removed (room order is fixed; nobody can reorder tabs today) |
| 2 | active-tab key, `viewTabsState.js:96` (read `:143-151`, written for any view by `App.jsx:636-648`) | any view key incl. hidden ones (`gates`, `tree`, `docs`), garbage | that key if valid and available, else next source |
| 3 | `compose:activeView` (`App.jsx:518-524` read, `:651-652` write, every visit) | any view key, incl. `ops` with no pages, `stratum`/`cadence`/`wiki` with package absent, `usage` | that key if valid and available, else next source |
| 4 | server `settings.json` `ui.defaultView` (`settings-store.js:12,70,232`) | one of the 8 legacy values; after slice 1 any `VIEW_KEYS` entry | that key if reachable, else `dashboard` |
| 5 | `compose:designSession` (`useDesignStore.js:46-48`) | `{scope: product|feature, featureCode}` | unchanged: Design keeps its own scope picker in every shape |
| 6 | popout `sessionStorage` `vision-activeView` (`VisionTracker.jsx:48-49,59`) | VisionTracker's own keys, incl. its default `roadmap`, which it has no branch for | slice 1: unknown → `graph` (§4.1) |
| 7 | `sessionStorage` `vision-selectedItemId` (`App.jsx:661-664`, read only by `VisionTracker.jsx:47`) | an item id | unchanged (selection, not navigation) |
| 8 | `compose:focusedFeature` (new, §2.5) | a code, a code that no longer resolves, garbage | the code if it resolves, else `null` with a WARNING |

Test rows (one table, `migrateNavState.test.js`): each row above; hidden key `gates` → `gates`;
`tree` → `tree`; `ops` with no pages → `dashboard`; `stratum` with package absent → `dashboard`; `usage` →
`usage`; `roadmap`, `''`, garbage → `dashboard`; shape B Feature tab persisted with no focus → same leaf;
Fleet sub-tab whose package is now absent → `dashboard`; **"View not found" row:** for every row the output
`view` renders a real view (the `CockpitView` default branch, `App.jsx:413-418`, is never reached).

## 3. Header and sidebar cleanup (slice 1, any shape)

- Group the right-hand controls into three labelled clusters: **Run** (build-all/GSD, launch: one "Run ▾"
  menu with text items, since both spawn agents; SESSION-MGMT-1 U13/U14 owns their safety, audit gap 3,
  untouched here), **New** (one "New ▾" with "Feature (scaffold)", "Item", the two kinds explained in one
  line each; the sidebar "+ New" goes, ⌘N stays and opens "Item", `App.jsx:703`), **View** (theme + font
  size moved into a "Display" popover, pair-device into it as "Pair phone").
- Health dot and disconnected text stay, with a visible word next to the dot when not green.
- Sidebar: drop the duplicate theme toggle and the "Compose" title (the project switcher names it);
  group rows show `3 active / 12` as text, or one number with a tooltip. The Ideas row and DesignSidebar swap
  stay.
- Remove the dead `gates` tab badge (`App.jsx:1153`) or re-key it to the tab that shows gates.

## 4. Landing page (COMP-AUDIT-18)

### 4.1 Why it lands on the Graph today

`server/settings-store.js:70` defaults `ui.defaultView` to `'graph'`, and `App.jsx:680-686` applies it on
the first WS connect whenever no view is persisted in localStorage. So every fresh browser, every cleared
storage and every new machine lands on the Graph, whatever the tab order says. (Returning browsers are not
affected: `compose:activeView` is written on every visit, `App.jsx:651-652`.) Also: `VALID_VIEWS`
(`settings-store.js:12`, mirrored in `SettingsPanel.jsx:11`) does not include `dashboard`, so a user cannot
pick it, and does include hidden views (`pipeline`, `design`, `sessions`), so a user can land on a view with
no tab selected. The popout window (`?popout=vision://`, `App.jsx:222-226`) applies the same setting
(`VisionTracker.jsx:65-70`) and has no `dashboard` branch (`VisionTracker.jsx:296-338`), so a new default
would open it blank.
Fix (shape-neutral, review L1): `defaultView` stores a **leaf view key**. The server accepts any key in
`VIEW_KEYS` (all 20; the list changes only when a view is added, under any shape) and defaults to
`dashboard`. The client applies it only if it is *reachable by clicks in the current navigation* (today:
the visible tabs; after slice 2: every key), else Home; the picker lists the same reachable set. The popout
renders `graph` for any view it has no branch for. Settings are merged as defaults + user overrides
(`settings-store.js:5`), so users who never picked one move to Home; one who picked Graph keeps it.

### 4.2 Home ("fattened" dashboard), only data the store already has

Today the no-feature state shows one sentence and five completed features in array order
(`DashboardView.jsx:316-344`, `.slice(-5)`). Home shows, top to bottom, each section hidden when empty:

| Section | Shows | Source (already in the cockpit) |
|---|---|---|
| Focused feature | when `resolveFeatureContext` has a code: today's per-feature dashboard body (phase timeline, agents, iterations, its gates, sessions, events), labelled with its source | `DashboardView.jsx:283-344` with the resolved code |
| Needs you | pending Compose gates (all features), blocked items, decisions, agent errors; one click opens the gate | **unfiltered** `gates` and `items` (not `phaseFilteredItems/Gates`, `App.jsx:270-271`, or a sidebar phase filter hides gates), `computeAttentionQueue` (`attentionQueueState.js:37`), `agentErrors`. "Pending" = `status === 'pending'` (the badge's rule, `App.jsx:1153`) |
| Running now | active build (feature, step, iteration), spawned agents with stop | `activeBuild`, `iterationStates`, `spawnedAgents` (`DashboardView.jsx:72` `ActiveAgents`; it has no stop prop today, so wire `handleStopAgent`, `App.jsx:782`) |
| In progress | features with status in progress, each with a mini phase timeline | `items` + `lifecycle.currentPhase` (`DashboardView.jsx:28` `PhaseTimeline`) |
| Recently changed (done) | last 5 completed features by `updatedAt`, labelled "last changed": `updatedAt` is last-edit time (`vision-store.js:226`), not completion time | `items` |
| Recent builds | last 5 builds with outcome | `buildHistory` (fetched today only on Builds, `App.jsx:905-908`; fetch on Home too) |
| Recent sessions | as today | `sessions` (`RecentSessions`) |
| Ideas | untriaged count, link to Ideas | `useIdeaboxStore` (self-hydrating, `useIdeaboxStore.js:77`; `AttentionQueueSidebar.jsx:239-245`) |
| Fleet glance | seat strip, only when the Cadence package is present | `@cadence/ui` `SeatStrip` behind `useCadenceUiAvailable` (stub when absent, `cadence-ui-stub.js:4`) |

The empty-project CTA (COMP-AUDIT-8, landed `b6031a44`) stays. In slice 1 (before the focus model) the
"Focused feature" section shows the bound session's feature, which is exactly today's `DashboardView.jsx:316`
branch, so Home with a bound session shows that feature's body on top and the project sections below.

### 4.3 Graph: fit to readable

Today: fcose layout, then `cy.fit(undefined, 30)` (`GraphView.jsx:795,801`), `minZoom 0.1` (:786), labels
8-10px (:233,246,292). With many items fit-all shrinks labels far below legible size. New rule after layout:
fit; if the zoom is below `READABLE_ZOOM = 1.12` (the 9px node label renders at >= 10px; 1.1 gives 9.9px),
zoom to that floor centred on, in order: the focused feature's node, else the first in-progress feature,
else the centre of the largest group. The pure helper `graphInitialViewport({fittedZoom, candidates:
{focused, inProgress, largestGroup}})` → `{zoom, centre}` (`src/components/vision/graphInitialViewport.js`,
new) takes positions, not node counts, because the fitted zoom depends on the bounding box and container
size. cytoscape is destroyed and rebuilt on every `elements` change (`GraphView.jsx:762-765`, deps `:871`),
so the rule runs **once per mount** (a ref guard); later rebuilds keep today's behaviour. The existing Fit
button (`handleFit`, :1002) keeps "show everything". Saved node positions (`applySavedAndCapture`, :793) are
untouched.

### 4.4 The inert bar and the one status surface (review M4)

- **StatusBand:** shown only when `resolveFeatureContext` has a code (in slice 1: a bound session, as today);
  never the "Select a feature" sentence. The 32px goes back to the view.
- **Project-wide status: OpsStrip, backed by one sidebar line.** OpsStrip is project-wide but not
  persistent: it hides on Docs and when it has no entries, and entries can be dismissed
  (`OpsStrip.jsx:24,177-180`). So the sidebar **CompactStatsRow stays** (`AttentionQueueSidebar.jsx:385`,
  pending gates / blocked counts) as the one always-visible project line, including on Docs.
- **OpsStrip click:** entry clicks keep selecting that feature (`OpsStrip.jsx:208` → `App.jsx:813-822`).
  A separate "All ▸" link at the strip's right end opens Home.
- **Removed duplicates:** sidebar BuildStatusWidget (`AttentionQueueSidebar.jsx:389`; OpsStrip and Home
  "Running now" show the build) and the ContextPanel "project summary" (replaced by a one-line "Select an
  item to see it here"). The sidebar keeps CompactStatsRow, attention queue, agents, Ideas row, search and
  groups.
- Transient bars (notifications, gate toast) stay; they are events, not status.

## 5. The three item status models (AUDIT-18 clause 3): split to COMP-AUDIT-11

The item detail shows three editable controls: **status** dropdown (`ItemDetailPanel.jsx:453`), **phase**
dropdown writing the legacy `item.phase` (:478), and **confidence** (:462). `compose build` reads
`feature.json` (`lib/build-all.js:100` filters `status === 'COMPLETE'`; `lib/build.js:3437` writes
`PLANNED` back), while the item PATCH route (`server/vision-routes.js:155`) writes back only `group` to feature.json
(:186-190) and refuses `status: complete` for managed items (:173-180).
Resolving which one governs is data-model work that COMP-AUDIT-11 already owns (collapse on
`lifecycle.currentPhase`). This design asks only for labels in slice 1: phase shows
`lifecycle.currentPhase` read-only when present ("set by `compose build`"), status is labelled "Board status
(cockpit only)", confidence "Your confidence". Owner question 2.

## 6. Acceptance criteria (build unit; slice 1 first, slice 2 after the owner picks)

**Slice 1 (any shape).** Each box says why it does not depend on the shape.
- [ ] `src/components/cockpit/viewKeys.js` (new, pure, no React): `VIEW_KEYS` (the 20 leaf keys, the one list the `CockpitView` switch, settings and tests share) and `reachableViews(nav, available)`. *Shape-neutral: leaf keys exist under A, B and C; only `nav` differs.* `server/settings-store.js` imports it (no server→`src/` import exists today, unverified for packaging; fallback: a server copy plus a parity test)
- [ ] `server/settings-store.js` (existing): `ui.defaultView` default `'dashboard'`; accepts any `VIEW_KEYS` entry. *Shape-neutral: stores a leaf key, not a tab*
- [ ] `src/components/vision/SettingsPanel.jsx` (existing): picker lists `reachableViews` (one shared list, not two copies). *Shape-neutral: the set follows the nav model*
- [ ] `src/App.jsx` (existing): first connect applies `defaultView` only if reachable, else Home; the `compose:activeView` initialiser (`:518-524`) also drops `ops` with no pages and any unreachable key; fresh storage lands on Dashboard/Home (test). *Shape-neutral: "reachable" is computed*
- [ ] `src/components/vision/VisionTracker.jsx` (existing): any view it has no branch for (incl. `dashboard`, `usage`, its own default `roadmap`) renders `graph`; one test (review L2). *Shape-neutral: the popout keeps its own view set*
- [ ] `src/components/vision/DashboardView.jsx` (existing) + `src/components/vision/HomeSections.jsx` (new): §4.2 sections from store data, each hidden when empty; unfiltered gates/items for Needs you; `handleStopAgent` wired to Running now; completed sorted by `updatedAt` and labelled "last changed". *Shape-neutral: Home is the landing view in A, B and C*
- [ ] `buildHistory` fetched when Home mounts (`App.jsx:905-908` effect widened). *Shape-neutral*
- [ ] `src/components/vision/GraphView.jsx` (existing) + `src/components/vision/graphInitialViewport.js` (new): fit-to-readable §4.3, `READABLE_ZOOM = 1.12`, once per mount, Fit button unchanged; one table test (fitted zoom × candidates → zoom/centre). *Shape-neutral: the Graph is the same component in every shape*
- [ ] `src/components/vision/StatusBand.jsx` (existing): renders nothing without a feature; `NO_FEATURE_SENTENCE` removed. *Shape-neutral*
- [ ] `src/components/vision/AttentionQueueSidebar.jsx` (existing): theme toggle, title, BuildStatusWidget removed; **CompactStatsRow kept**; group counts labelled. *Shape-neutral: the sidebar is outside the tab model*
- [ ] `src/components/cockpit/ContextPanel.jsx` (existing): ProjectSummary replaced by a one-line hint. *Shape-neutral*
- [ ] `src/components/cockpit/OpsStrip.jsx` (existing): "All ▸" link at the end opens Home; entry clicks still select the feature (test both). *Shape-neutral: targets the leaf `dashboard`*
- [ ] `src/App.jsx` header (existing): Run ▾ / New ▾ / Display ▾ clusters with text items; sidebar "+ New" removed, ⌘N kept; dead `gates` badge removed. *Shape-neutral: header right side, not the tabs*
- [ ] `src/components/vision/ItemDetailPanel.jsx` (existing): the three §5 labels; phase read-only when `lifecycle.currentPhase` is set. *Shape-neutral*
- [ ] Tests rewritten, not "kept green" (review L3): `test/settings-store.test.js:78,111-113` (`graph` default, `gates` becomes a plain valid key), `test/settings-routes.test.js:124`, `test/settings-e2e.test.js:147`, `test/ui/status-band.test.jsx:132-134` (sentence removed). New tests table-driven, no stacked `parametrize`-style loops; vitest `--maxWorkers=4`

**Slice 2, shape-neutral core (A, B or C):**
- [ ] `src/components/cockpit/focusedFeature.js` (new): pure `resolveFeatureContext` + focus reducer per §2.5, one row table: Focus button sets; re-click same item (no change); select non-feature item (no change); select another feature's item (no change); deselect (no change); × (cleared); project switch (cleared); reload with a resolving code (restored); reload with a stale code (cleared + warning); session binds with no focus (display `session`, no filter); session binds with focus (focus wins)
- [ ] `src/App.jsx` (existing): `focusedFeature` state persisted as `compose:focusedFeature`; filters read it only when `source === 'focus'`; StatusBand, DecisionTimelineStrip, OpenLoopsPanel, Home, QA scope, Validate read `resolveFeatureContext`; `activeFeatureCode` (`:499`) and `focusFeature` (`:569`) retired; `openGate` no longer clears focus (`:1015`)
- [ ] `src/components/cockpit/ContextItemDetail.jsx` (existing): "Focus" button in the item header for items whose code resolves
- [ ] `src/components/shared/FeatureFocusToggle.jsx` (existing): removed from Graph, Items, Docs, Gates, Sessions; GateView always includes `focusedGateId`
- [ ] `src/components/cockpit/viewKeys.js` (existing after slice 1): `locateView(key)` → `{top, sub}` for the picked shape; `migrateNavState` per §2.7 with its row table incl. the "View not found" row
- [ ] Every §2.6 site handled as the table says (one acceptance check per row); `handleViewChange` keeps its signature
- [ ] Coverage test, keys **derived from `VIEW_KEYS`**, never a literal count: (a) with **no feature focused** and all packages available, every key is reachable by a click path in the nav model; (b) with each package absent, its key drops out and no other key does; (c) one row per `handleViewChange` caller in §2.6 (default view, `visionUI`, gate open, EntityLink, View in graph, View in tree, open file, docs back, sidebar Ideas, GateToast, OpsStrip Fleet pill, tab click) asserting the derived `{top, sub}` is highlighted; (d) rendering `CockpitView` for every key never reaches the "not found" branch, and every `case` in the switch is in `VIEW_KEYS`
- [ ] Tests rewritten: `test/cockpit-layout.test.js:123-138,236-239` (`DEFAULT_MAIN_TABS`/`HIDDEN_VIEWS`), the "is a default tab" checks in `test/ui/{ops,stratum,cadence,wiki}-view.test.jsx` (`:14,:18,:35,:23`) and `test/ui/usage-view.test.jsx`, `test/context-panel-state.test.js` if `CONTEXT_HIDDEN_VIEWS` moves

**Slice 2, shape A layout (if picked):**
- [ ] `src/components/cockpit/ViewTabs.jsx` (existing): top row `Home · Roadmap · Ideas · Review · Build · Fleet · Library` + gear, sub-row per §2.1, `Feature: CODE ×` chip; rooms hide unavailable sub-tabs (same predicates as `App.jsx:1149`)
- [ ] `src/components/cockpit/viewTabsState.js` (existing): flat tab list, active-tab key and `HIDDEN_VIEWS` retired (migration in `migrateNavState`)
- [ ] Roadmap = Graph with a List toggle (tree)
- [ ] Docs: `docs/features/COMP-AUDIT-17/design.md` status → built; ROADMAP rows 17/18 COMPLETE via `compose roadmap`, with row 18's text amended to say clause 3 moved, and the clause added to the COMP-AUDIT-11 row (`ROADMAP.md:1547`) in the same commit; CHANGELOG same commit

(Shape B adds a `FeatureView.jsx` host and the ContextItemDetail reconciliation of §2.2; shape C adds a
"More ▾" menu in `ViewTabs.jsx` and keeps the flat tab list.)

**FYI, decided here without an owner question (coordinator authority, review L10):** fresh browsers now
land on Home instead of the Graph, and the sidebar's build widget goes (the gate/blocked counts stay).

## 7. Owner questions

1. **How should the cockpit's screens be organised?** Today there are 10 tabs and 10 more screens that you
   can only reach through a link, 7 of them not at all
   and one only when a warning pill happens to show.
   - (a) **Labelled rooms** (recommended): seven doors across the top (Home, Roadmap, Ideas, Review, Build,
     Fleet, Library) and a small row of tabs inside each, so every screen has a home two clicks away. Why:
     it is what both audits asked for (`ROADMAP.md:1553`, `COMPOSE-UI-AUDIT-1/audit.md:60`), and every
     screen works with no feature chosen (§2.0), so nothing needs a special per-feature page.
   - (b) **Rooms plus a feature page**: the same rooms, plus a tab for the one feature you are looking at.
     Costs more, and the right-hand panel already is a tabbed page for the selected feature
     (`contextPanelState.js:68-75`), so you would see two of them. (Round 1 recommended this, on the wrong
     belief that several screens only work for one feature.)
   - (c) **"More" menu**: keep today's 10 tabs and put the other 10 screens in a drop-down. Cheapest, but the
     drop-down is ten look-alike names (Pipeline, Pipeline Editor, Builds, Runs).
   In every option: the new Usage screen sits with the fleet screens, a user with no feature chosen reaches
   every screen, and the first part of the work (a real home page, a readable map, labelled buttons) ships
   whichever you pick.
2. **The three status controls on an item** (status, phase, confidence): label them now ("set by compose
   build", "board only", "your confidence") and leave the real merge to COMP-AUDIT-11, which already owns
   the phase model (recommended: it keeps this build small and the data-model change in one place,
   `ROADMAP.md:1547`), or make the merge part of this build?
3. **The Design screen** (a chat with a design agent, either for the whole product or for one feature you
   type in; unreachable by clicking since July): keep it as Build ▸ Design (recommended: it works for the
   whole product with no feature chosen, `DesignView.jsx:88`, and for one feature by typing its code,
   `DesignView.jsx:95-96`), or drop it?

## ELI5 TLDR

**The first draft recommended a "page per feature" because it thought most screens only work for one
feature. They don't: almost all of them work for the whole project and just offer a feature filter.** So
the recommendation flips to the plainer option: a few labelled rooms (Home, Roadmap, Ideas, Review, Build,
Fleet, Library), each with its own small tab row, so all twenty screens are reachable and none hides behind
picking a feature. "Looking at one feature" becomes a single chip you turn on and off yourself, instead of
something that changes whenever you click. The first part of the work (open on a real home page, a readable
map, labelled buttons) is the same whichever way you choose. Your call: rooms (recommended), rooms plus a
feature page, or a "more" drawer.
