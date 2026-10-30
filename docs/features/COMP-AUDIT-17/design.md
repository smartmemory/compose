# COMP-AUDIT-17 + COMP-AUDIT-18: cockpit navigation and landing page (design)

**Status:** DESIGN, 2026-10-30, Opus (`hard:`), read-only of compose `b6031a44`. Goes to one Opus design
review, then a build unit. No source changes in this unit.
**Covers:** COMP-AUDIT-17 (information architecture) and COMP-AUDIT-18 (landing page, inert status bar,
one status surface). AUDIT-18's third clause (three status models on one item) is split out: see §5.

## Related Documents

- Audit rows: `ROADMAP.md` COMP-AUDIT-17/18 (`ROADMAP.md:1553-1554`), feature files
  [../COMP-AUDIT-17/feature.json](feature.json), [../COMP-AUDIT-18/feature.json](../COMP-AUDIT-18/feature.json)
  (pointer [../COMP-AUDIT-18/README.md](../COMP-AUDIT-18/README.md)).
- Status audit: [../COMPOSE-UI-AUDIT-1/audit.md](../COMPOSE-UI-AUDIT-1/audit.md) (:60 IA row, :88 next unit 5).
- Tab integration: [../COMPOSE-UI-INTEGRATION-1/design.md](../COMPOSE-UI-INTEGRATION-1/design.md) (Ops, Stratum,
  Cadence, Wiki tabs; packages imported as components, tab hidden when the package is absent).
- Prior cut: COMPOSE-UX-SIMPLIFY-2 (`483c19dd`, five tabs, the rest hidden).
- Neighbours: COMP-AUDIT-11 (phase model), COMP-AUDIT-16 (dead WS protocol), COMP-COCKPIT-12/13.

## 0. What changed since the audit row was written (2026-07-12)

The row says "14 flat top-level views". Today it is **9 tabs + 10 hidden views = 19 views**:
COMPOSE-UX-SIMPLIFY-2 hid ten, and today's Ops/Stratum/Cadence/Wiki tabs added four
(`src/components/cockpit/viewTabsState.js:20,24-27`). The tabs carry text labels already
(`ViewTabs.jsx:22-41,73`); the **unlabelled icons are the right-hand header controls**, not the tabs.
Dashboard is first in the tab list, yet a fresh cockpit **still lands on the Graph**, for a reason the
audit did not name (§4.1).

## 1. Inventory (compose `b6031a44`)

### 1.1 Views (`CockpitView` switch, `src/App.jsx:266-416`)

| View key (label) | Tab? | What it shows | Data source | Reachable from | Overlaps with |
|---|---|---|---|---|---|
| `dashboard` (Dashboard) | tab 1 | One feature: phase timeline, agents, iterations, its gates, recent sessions, event timeline. With no bound session: "No feature in progress." + 5 completed features | vision store; feature = `sessionState.featureCode` (`App.jsx:496`), `DashboardView.jsx:283-344` | tab | Sidebar, OpsStrip, ContextPanel summary |
| `graph` (Graph) | tab 2 | All items + connections, cytoscape fcose, build/agent overlays, gate popover | vision store `items`, `connections` (`App.jsx:301-321`) | tab; "View in graph" (`App.jsx:1092`) | `tree` (same items) |
| `docs` (Docs) | tab 3 | File tree + markdown preview, feature-focus filter | `/api/files`, `/api/file` (`DocsView.jsx`) | tab; item "open file" (`App.jsx:1106`) | Wiki (feature hub) |
| `ideabox` (Ideabox) | tab 4 | Ideas funnel, triage, promote | `useIdeaboxStore` (`IdeaboxView.jsx:19`) | tab; sidebar Ideas count (`AttentionQueueSidebar.jsx:256`) | none |
| `ops` (Ops) | tab, if pages exist | 8 ops status pages, iframed, 15 min stale | `/ops-status/<name>/status.html` (`OpsView.jsx:38`) | tab | Cadence (live) |
| `stratum` (Stratum) | tab, if package | Runs list, run DAG, Stratum gates inbox | `@smartmemory/stratum-ui` via `/api/stratum-ui` (`StratumView.jsx:2-4,20-33`) | tab | `build-history`, `pipeline`, `gates` |
| `cadence` (Cadence) | tab, if package | Seat strip + Board / Chains / Attention / Diary | `@cadence/ui` via `/api/cadence-ui` (`CadenceView.jsx:2-4,7-12`) | tab | `sessions`, Ops |
| `wiki` (Wiki) | tab, if configured | FeatureHub + Search for the selected feature, "open full wiki" iframe | `@wiki/components` via `/api/wiki` (`WikiView.jsx:2-4,83`) | tab | Docs |
| `settings` (Settings) | tab (last) | Settings form | vision store `settings` (`SettingsPanel.jsx`) | tab | `SettingsModal` (`App.jsx` modal) |
| `tree` (Items) | hidden | Item hierarchy list | vision store | "View in tree" (`App.jsx:1099`) | `graph` |
| `gates` (Gates) | hidden | Compose gates, approve/revise/kill | vision store `gates` (`GateView.jsx`) | gate open (`App.jsx:1014`), GateToast (`App.jsx:1511`) | Dashboard gates, OpsStrip, Stratum gates inbox |
| `pipeline` (Pipeline) | hidden | Live build steps, draft approve/reject | `activeBuild`, `/api/pipeline/draft/*` (`PipelineView.jsx`) | **nothing** | Stratum run DAG |
| `pipeline-editor` (Pipeline Editor) | hidden | Visual editor for `*.stratum.yaml` | `/api/pipeline/specs` (`PipelineEditor.jsx:1-14`) | **nothing** | STRAT-UI-BUILDER-1 (Stratum tab, planned) |
| `sessions` (Sessions) | hidden | Compose hook sessions | vision store `sessions` (`SessionsView.jsx`) | **nothing** | Cadence seat strip, Dashboard recent sessions |
| `build-history` (Builds) | hidden | Past Compose builds | `fetchBuildHistory` (`App.jsx:902`) | **nothing** | Stratum runs (unverified how much) |
| `validate` (Validate) | hidden | `compose validate` findings | `/api/validate` (`ValidateView.jsx`) | **nothing** | none |
| `qa-scope` (QA Scope) | hidden | Affected routes for the active build | `/api/qa-scope` (`QaScopeView.jsx`) | **nothing** | none |
| `journal` (Journal) | hidden | Journal + changelog entries | `/api/journal`, `/api/changelog` (`JournalView.jsx`) | **nothing** | Docs (CHANGELOG file) |
| `design` (Design) | hidden | Design-agent conversation + decisions sidebar | `useDesignStore` (`DesignView.jsx:2`) | **nothing** | none |

"Nothing" = no tab, no `handleViewChange('<key>')` call (only `gates`, `graph`, `tree`, `docs` have one,
`App.jsx:1014,1092-1106`), no `EntityLink kind="view"` user, and the command palette searches items, gates
and sessions only (`CommandPalette.jsx:6`). **Eight shipped views are unreachable by clicking.** The only
other doors: the Settings "default view" picker (§4.1) and the `visionUI` WS command
(`visionMessageHandler.js:88`), which no server code emits (grep `visionUI` in `server/ lib/`: 0 hits).

### 1.2 Header controls (right side, `src/App.jsx:1160-1250`)

| # | Glyph | Label today | Does | Line |
|---|---|---|---|---|
| 1 | "disconnected" text | text | WS down indicator (repeated in sidebar `AttentionQueueSidebar.jsx:361`) | 1164 |
| 2 | health dot | tooltip | `compose doctor` + hooks drift popover | 1169 |
| 3 | build icon | tooltip | Build all PLANNED / GSD `<CODE>` (spawns agents) | 1172 |
| 4 | 🚀 | tooltip | Launch fix / new / resume lifecycle (spawns agents) | 1182 |
| 5 | ➕ | tooltip | New feature scaffold dialog | 1197 |
| 6 | 📱 | tooltip | Pair mobile device | 1206 |
| 7 | ☀/☾ | tooltip | Theme (repeated in sidebar header) | 1215 |
| 8-11 | A− · 14 · A+ · 100% | none | Font size down / readout / up / reset | 1225-1250 |

Left of these, inside `ViewTabs`: Maya (labelled, if installed) and ⌘K search (`ViewTabs.jsx:84-108`).
Plus the sidebar's "+ New" (generic vision item, `AttentionQueueSidebar.jsx:364-372`), a **third create
button** next to ➕ (scaffold) and 🚀 "new" (agent lifecycle), each making a different thing.

### 1.3 Status surfaces

| Surface | Where | Scope | Feeds from | Problem |
|---|---|---|---|---|
| StatusBand | top of main, 32px, every view (`App.jsx:1339`) | one feature | `sessionState.featureCode` only (`App.jsx:496`) | Says "Select a feature to see status." (`StatusBand.jsx:20`), but selecting an item never changes it (`handleSelect`, `App.jsx:766-776`, sets only `selectedItemId`). It fills only when an agent session binds a feature. **Inert for a human.** |
| DecisionTimelineStrip | under StatusBand, 72px, when bound (`App.jsx:1345`) | one feature | same | fine when shown |
| OpsStrip | bottom, 36px, all views but docs (`App.jsx:1460`, `OpsStrip.jsx:10`) | project | active build, pending gates, recent errors | the one surface that is both persistent and project-wide |
| Sidebar stats + build widget + agent panel + attention queue | left (`AttentionQueueSidebar.jsx:385-416`) | project | items, gates, activeBuild, agents | duplicates OpsStrip (gates, build) and Dashboard (agents) |
| ContextPanel "project summary" | right, no selection (`ContextPanel.jsx:59,128-180`) | project | activeBuild, pending gates, errors | third copy of build + gates |
| AgentBar collapsed text | bottom (`AgentBar.jsx`) | agent | `compose:agent-status` event | fine (agent chat, not status) |
| Gate badge on tabs | header (`App.jsx:1150`) | project | pending gates | **dead:** keyed `gates`, which is not a tab since SIMPLIFY-2 |
| NotificationBar, GateNotificationBar, GateToast | bottom / toast (`App.jsx:1485,1492,1511`) | events | transient | transient, not status; keep |

Sidebar group counts: each group row shows two unlabelled numbers, active count in the primary colour
and total in grey (`AttentionQueueSidebar.jsx:222-226`).

## 2. Navigation shapes

All three keep every view's component as is; they differ in what sits at the top and how a feature-scoped
view gets its feature. Six views are feature-scoped through a `featureCode` prop (dashboard, docs, gates, validate,
qa-scope, wiki; `App.jsx:266-405`; tree, graph and sessions use it only for a focus filter), which is what
shape B builds on.

### Shape A: four rooms (the audit's Work / Review / Build / Knowledge)

**Like a building with four labelled doors; each room has its own small tab row.**
First load: Work ▸ Home. Top row: `Work · Review · Build · Knowledge` + gear; a second row inside each.

| Room | Sub-tabs |
|---|---|
| Work | Home (dashboard), Board (cadence), Ideas (ideabox) |
| Review | Gates (Compose gates, with Stratum gates inbox as a second list), Validate, QA scope |
| Build | Live build (pipeline), Builds (build-history), Runs (stratum), Sessions, Flow editor (pipeline-editor) |
| Knowledge | Roadmap (graph, with a List toggle for tree), Docs, Wiki, Journal, Ops |

Merged: tree into Roadmap. Gear: settings. Design view: Build ▸ Design (or dropped, §6 Q3).
Cost: `viewTabsState.js` gains a two-level model and a migration for persisted tabs, `ViewTabs.jsx` a second
row, `App.jsx` routing, ~8 files, M. **Weak spot:** feature-scoped views (Validate, QA scope, Design) still
have no way to choose a feature except a bound agent session, so they stay half-empty, and a user looking
at one feature hops between three rooms.

### Shape B: Home + Feature page + Machine room (recommended)

**Like a project binder: a cover page, one tabbed section per feature you open, and a back room that shows
the machines.** First load: Home.
Top row: `Home · Roadmap · Ideas · Feature: <CODE> × · Fleet · Project` (Feature appears only when one is
focused; Fleet sub-tabs hide when their package is absent, as today).

| Top | Contents |
|---|---|
| Home | fattened dashboard (§4.2); project-wide, never empty when there is data |
| Roadmap | Graph (readable zoom, §4.3) with a List toggle (tree); clicking a feature focuses it |
| Ideas | ideabox |
| Feature: CODE | Overview (today's per-feature dashboard), Gates, Live build, Validate, QA scope, Design, Docs (focused), Wiki, Builds (filtered) |
| Fleet | Cadence, Stratum (runs, gates, later the builder), Ops, Sessions |
| Project | Docs (all), Journal, Flow editor, Settings |

The new idea is one **focused feature**: the selected item's feature code, else the bound session's
(`sessionState.featureCode`). Every feature-scoped view, the StatusBand and the DecisionTimelineStrip read
it. That one change is what makes "Select a feature to see status." true, gives Validate / QA scope / Design
a feature without an agent, and replaces the two "current feature" notions in `App.jsx` (496 and 766).
Merged: tree into Roadmap. Dropped from the top: Settings (under Project), the gate tab badge moves to
Feature ▸ Gates and to Home.
Cost: the focused-feature state (App.jsx + the six views' props), a two-level tab model, Feature sub-tab
host component, persisted-tab migration, ~10-12 files, M+ (largest of the three).
**Why recommended:** it matches what the cockpit was built for (one feature from idea to shipped, audit
:13-15) and what the owner now uses it for (the machine room: Cadence, Stratum, Ops). It is the only shape
that fixes the inert bar and the eight orphan views for the same price, instead of relabelling them.

### Shape C: keep flat tabs, add a "More" menu

**Like today's menu bar plus an overflow drawer.** First load: Dashboard. Tabs stay as the 9 of today; a
"More ▾" holds the 10 hidden views by name; tree becomes a List toggle inside Graph.
Cost: ViewTabs dropdown + labels, ~3-4 files, S.
**Weak spot:** a drawer of ten names nobody can tell apart (Pipeline vs Pipeline Editor vs Builds vs Runs)
is the original complaint, now one click deeper; the feature-scoped views stay empty.

### Recommendation

**Shape B**, built in two slices so the parts every shape needs land first:
- **Slice 1 (any shape, S):** §4 landing fixes and §3 header labels. Ships even if the owner picks A or C.
- **Slice 2 (shape B, M):** focused feature, Home / Roadmap / Ideas / Feature / Fleet / Project.

## 3. Header and sidebar cleanup (slice 1, any shape)

- Group the right-hand controls into three labelled clusters: **Run** (build-all/GSD, launch: one "Run ▾"
  menu with text items, since both spawn agents; SESSION-MGMT-1 U13/U14 owns their safety, audit gap 3,
  untouched here), **New** (one "New ▾" with "Feature (scaffold)", "Item", the two kinds explained in one
  line each; the sidebar "+ New" goes), **View** (theme + font size moved into a "Display" popover,
  pair-device into it as "Pair phone").
- Health dot and disconnected text stay, with a visible word next to the dot when not green.
- Sidebar: drop the duplicate theme toggle and the "Compose" title (the project switcher names it);
  group rows show `3 active / 12` as text, or one number with a tooltip.
- Remove the dead `gates` tab badge (`App.jsx:1150`) or re-key it to the tab that shows gates.

## 4. Landing page (COMP-AUDIT-18)

### 4.1 Why it lands on the Graph today

`server/settings-store.js:70` defaults `ui.defaultView` to `'graph'`, and `App.jsx:676-683` applies it on
the first WS connect whenever no view is persisted in localStorage. So every fresh browser, every cleared
storage and every new machine lands on the Graph, whatever the tab order says. Also: `VALID_VIEWS`
(`settings-store.js:12`, mirrored in `SettingsPanel.jsx:11`) does not include `dashboard`, so a user cannot
pick it, and does include hidden views (`pipeline`, `design`, `sessions`), so a user can land on a view with
no tab selected. Fix: default `dashboard`; valid list = the visible top-level tabs; App ignores a
`defaultView` that is not a visible tab. Settings are merged as defaults + user overrides
(`settings-store.js:5`), so users who never picked one move to Home; one who picked Graph keeps it.

### 4.2 Home ("fattened" dashboard), only data the store already has

Today the no-feature state shows one sentence and five completed features in array order
(`DashboardView.jsx:316-344`, `.slice(-5)`). Home shows, top to bottom, each section hidden when empty:

| Section | Shows | Source (already in the cockpit) |
|---|---|---|
| Needs you | pending Compose gates (all features), blocked items, decisions, agent errors; one click opens the gate | `gates`, `computeAttentionQueue` (`attentionQueueState.js`, used by the sidebar), `agentErrors` |
| Running now | active build (feature, step, iteration), spawned agents with stop | `activeBuild`, `iterationStates`, `spawnedAgents` (`DashboardView.jsx` `ActiveAgents`) |
| In progress | features with status in progress, each with a mini phase timeline | `items` + `lifecycle.currentPhase` (`DashboardView.jsx:28` `PhaseTimeline`) |
| Recently finished | last 5 completed features **by `updatedAt`** | `items` |
| Recent builds | last 5 builds with outcome | `buildHistory` (today fetched only on the Builds view, `App.jsx:902`; fetch on Home too) |
| Recent sessions | as today | `sessions` (`RecentSessions`) |
| Ideas | untriaged count, link to Ideas | `useIdeaboxStore` (`AttentionQueueSidebar.jsx:239-245`) |
| Fleet glance | seat strip, only when the Cadence package is present | `@cadence/ui` `SeatStrip` (`CadenceView.jsx:2`), same DataClient |

With a focused feature, Home keeps these sections; the per-feature view (today's dashboard body) lives in
Feature ▸ Overview (shape B) or stays on top of Home (A, C). The empty-project CTA (COMP-AUDIT-8, landed
`b6031a44`) stays.

### 4.3 Graph: fit to readable

Today: fcose layout, then `cy.fit(undefined, 30)` (`GraphView.jsx:795,801`), `minZoom 0.1` (:786), labels
8-10px (:233,246,292). With many items fit-all shrinks labels far below legible size. New rule after layout:
fit; if the zoom is below a readable floor (labels render at >= 10px, about zoom 1.1 for the 9px node label),
zoom to the floor centred on, in order: the focused feature's node, else the first in-progress feature, else
the centre of the largest group. The existing Fit button (`handleFit`, :1002) keeps "show everything".
Saved node positions (`applySavedAndCapture`, :793) are untouched.

### 4.4 The inert bar and the one status surface

- **StatusBand:** shown only when there is a focused feature (shape B) or a bound session (A, C); never the
  "Select a feature" sentence. The 32px goes back to the view.
- **One project-wide status surface: OpsStrip wins.** It is the only one that is persistent and
  project-wide already. Home is its expanded form (click the strip → Home ▸ Needs you).
- **Removed duplicates:** sidebar CompactStatsRow pending-gates count, sidebar BuildStatusWidget, and the
  ContextPanel "project summary" (replaced by a one-line "Select an item to see it here").
  The sidebar keeps attention queue, agents, search and groups.
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

**Slice 1 (any shape):**
- [ ] `server/settings-store.js` (existing): `ui.defaultView` default `'dashboard'`; `VALID_VIEWS` = visible top-level tabs incl. `dashboard`, no hidden views
- [ ] `src/components/vision/SettingsPanel.jsx` (existing): picker lists the same set (one shared list, not two copies)
- [ ] `src/App.jsx` (existing): first connect ignores a `defaultView` that is not a visible tab; fresh storage lands on Dashboard/Home (test)
- [ ] `src/components/vision/DashboardView.jsx` (existing) + `src/components/vision/HomeSections.jsx` (new): §4.2 sections from store data, each hidden when empty; completed sorted by `updatedAt`
- [ ] `buildHistory` fetched when Home mounts (`App.jsx` effect at :902 widened)
- [ ] `src/components/vision/GraphView.jsx` (existing): fit-to-readable rule §4.3, `READABLE_ZOOM` constant, Fit button unchanged; pure helper `graphInitialViewport.js` (new) with one table test (node count × focus → zoom/centre)
- [ ] `src/components/vision/StatusBand.jsx` (existing): renders nothing without a feature; `NO_FEATURE_SENTENCE` removed
- [ ] `src/components/vision/AttentionQueueSidebar.jsx` (existing): theme toggle, title, CompactStatsRow gates, BuildStatusWidget removed; group counts labelled
- [ ] `src/components/cockpit/ContextPanel.jsx` (existing): ProjectSummary replaced by a one-line hint
- [ ] `src/App.jsx` header (existing): Run ▾ / New ▾ / Display ▾ clusters with text items; sidebar "+ New" removed; dead `gates` badge removed or re-keyed
- [ ] `src/components/vision/ItemDetailPanel.jsx` (existing): the three §5 labels; phase read-only when `lifecycle.currentPhase` is set
- [ ] OpsStrip click opens Home ▸ Needs you
- [ ] existing UI tests green; new tests table-driven, no stacked `parametrize`-style loops; vitest `--maxWorkers=4`

**Slice 2 (shape B):**
- [ ] `src/components/cockpit/focusedFeature.js` (new): pure `deriveFocusedFeature({selectedItemId, items, sessionState})` + table test
- [ ] `src/App.jsx` (existing): every feature-scoped view, StatusBand, DecisionTimelineStrip, OpenLoopsPanel read the focused feature; `activeFeatureCode` (`:496`) retired
- [ ] `src/components/cockpit/viewTabsState.js` (existing): two-level model (`top`, `sub`), persisted-state migration from the flat list and from `compose:activeView`; hidden-view list retired
- [ ] `src/components/cockpit/ViewTabs.jsx` (existing): top row + sub-row; Feature tab shows `Feature: CODE ×`, × clears focus
- [ ] `src/components/cockpit/FeatureView.jsx` (new), `FleetView.jsx` (new), `ProjectView.jsx` (new): sub-tab hosts; Fleet hides sub-tabs whose package is absent (same predicates as `App.jsx:1146`)
- [ ] Roadmap = Graph with a List toggle (tree); clicking a feature node focuses it
- [ ] every one of the 19 view keys reachable by clicks (one test walks the tab model and asserts coverage)
- [ ] `docs/features/COMP-AUDIT-17/design.md` status → built; ROADMAP rows 17/18 COMPLETE via `compose roadmap`; CHANGELOG same commit

## 7. Owner questions

1. **Which navigation shape?** (a) **Binder** (shape B): a cover page, one tabbed page per feature you
   open, a back room for Cadence/Stratum/Ops. Recommended: it fixes the dead status bar and the eight
   unreachable screens in one move. (b) **Four rooms** (shape A): Work/Review/Build/Knowledge, the audit's
   idea; tidier, but per-feature screens stay half-empty. (c) **More menu** (shape C): cheapest, mostly
   hides the mess. Slice 1 ships whichever you pick.
2. **Item status controls:** label them now and leave the real merge to COMP-AUDIT-11 (recommended), or
   make the merge part of this build?
3. **The Design view** (a design-agent chat, unreachable since July): keep it under Feature ▸ Design
   (recommended, it is per feature and works), or drop it?

## ELI5 TLDR

**The cockpit opens on the tangled map because a hidden setting says "map", not because of the tab order.**
Eight of its nineteen screens cannot be reached by clicking at all, and the bar on top that says "pick a
feature" ignores you when you do. The fix comes in two parts: a small one that opens on a real home page
that is never blank, makes the map readable and labels the mystery buttons (worth doing whatever else we
pick), and a bigger one that reorganises the screens. Your call is the bigger one: a binder with a page per
feature (recommended), four themed rooms, or a "more" drawer.
