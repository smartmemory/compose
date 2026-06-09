# COMP-COCKPIT Wave 2 — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4-5)
**Created:** 2026-06-10
**Design:** `design-wave-2.md` (gate clean 2026-06-10, 3 Codex iterations)
**Slices:** S01=COCKPIT-7 (retry), S02=COCKPIT-10 (orphan routes), S03=COCKPIT-8 (entity links), S04=COCKPIT-9 (journal surface)
**Build order:** S01 → S02 → S03 → S04 (independent first; S04 consumes S03's EntityLink)

## Corrections Table (design/roadmap assumption vs verified reality)

| # | Assumption | Reality | Impact |
|---|---|---|---|
| 1 | OpenLoopsPanel gap at `:150-164` | `LoopRow` spans `OpenLoopsPanel.jsx:113-164`; loop renders kind badge/TTL/age/summary/resolve, `parent_feature` never rendered (confirmed) | None — same fix |
| 2 | DashboardView plain featureCode at `:351/:375` | Session-card featureCode is at `:249` (recent-sessions badge); `:349-351` is the completed-features badge; `:372` is a title fallback, not a link target | Wire EntityLink at `:249` (Codex-verified — patching `:349-351` would hit the wrong surface) |
| 3 | vision-routes orphans at `:1080/:1103/:1123` | `GET /api/vision/blocked` `:1079`, `POST /api/vision/ui` `:1102`, `POST /api/plan/parse` `:1108` | None — delete by route string, not line |
| 4 | `TAB_META` in `viewTabsState.js:93` | `TAB_META` is in `ViewTabs.jsx:17`; `viewTabsState.js:93` is `loadMainTabs()` whose migration loop (`:99-110`) auto-inserts new `DEFAULT_MAIN_TABS` entries into persisted tab lists | Less work — no bespoke migration needed, just extend `DEFAULT_MAIN_TABS` (`viewTabsState.js:17-19`) + `TAB_META` |
| 5 | `writeJournalEntry` requires `summary_for_index` + 4 section keys | Confirmed; returns `{path, session_number, index_number?, index_line, idempotent}` (`journal-writer.js:646-648`) — the `idempotent` boolean already exists, no writer extension needed for the slug-retry loop | Drops "extend writer return value" from scope |
| 6 | Journal write requires index file to exist | `writeJournalEntry` throws `JOURNAL_INDEX_FORMAT` if `docs/journal/README.md` missing (`journal-writer.js:656-658`) | Route maps this error to a 500 with a clear message; acceptable for compose-self v1 |

## Per-slice implementation

### S01 — COCKPIT-7: Retry from Past Builds

1. **`src/lib/startBuild.js` (new):** export `async function startBuild({ featureCode, mode = 'feature', description = '' })` — extracted verbatim from `StartBuildPopover.jsx:36-45` (`wsFetch('/api/build/start', {method:'POST', headers: withComposeToken({'Content-Type':'application/json'}), body})`); throws `Error` with server `error` text and a `status` property (carry `res.status` so callers can branch on 409).
2. **`StartBuildPopover.jsx` (edit):** replace inline fetch `:36-45` with the helper; behavior identical.
3. **`PastBuildsView.jsx` (edit):** in `BuildRow` (`:124-170`), add a `Retry` button in row 3 (`:164-167`) when `build.status === 'failed' || build.status === 'aborted'`. In-flight state via local `useState`; on click → `startBuild({featureCode: build.featureCode, mode: build.mode})`; feedback via `notify()` (`NotificationBar.jsx:81`): success `info`, `status===409` → `warn` "A build for <code> is already active", else `error`. Note conflict model is **per-feature** (`lib/build.js:916`).
4. **Tests:** extend `test/ui/past-builds-view.test.jsx` (button visibility per status, dispatch payload, 409 path); new `test/ui/start-build-helper.test.js` if mockable cleanly.

### S02 — COCKPIT-10: Orphan routes

1. **Delete** from `server/vision-routes.js`: `GET /api/vision/blocked` (`:1079-1100`), `POST /api/vision/ui` (`:1102-1106`), `POST /api/plan/parse` (`:1108-1136`, includes its `path.resolve` guard block). Verify no remaining references to removed helpers/imports.
2. **Wire export:** `GraphView.jsx` toolbar (`:1009` region, button helpers at `:461`) gets an `Export` control with two actions: *Open HTML* → `window.open` on `/api/export/roadmap-graph` (route: `graph-export.js:322-329`); *Save to docs/* → POST `/api/export/roadmap-graph/save` (`:332-343`) via `wsFetch`, success → `notify('Saved <path>', 'info')`, failure → `notify(msg, 'error')`.
3. **Tests:** new `test/graph-export-routes.test.js` (GET returns HTML, POST writes file to tmp target root) if not already covered; assert deleted routes 404 in `test/vision-routes` suite if such a suite exists (else add to the new file).

### S03 — COCKPIT-8: EntityLink + navigation

1. **`src/lib/navigation.jsx` (new):** `NavigationContext` (createContext), `useNavigation()` hook returning `{ openItem(id), openGate(gateId), openView(view), openFeature(featureCode) }`. Provider value built in `App.jsx`.
2. **`App.jsx` (edit):**
   - New state `focusedGateId`; new `openGate(gateId)` callback: `setSelectedPhase(null)` (clears phase filter — gates are filtered through `phaseFilteredGates` `:673-676` before reaching `GateView` `:328-336`), `setFocusedGateId(gateId)`, `handleViewChange('gates')`; falls back to `handleSelect(gate.itemId)` if gate not found (existing `handleOpenGate` `:927-932` stays for context-panel selection).
   - `openFeature(code)`: resolve item by `featureCode || feature_code || lifecycle.featureCode` (pattern from `PastBuildsView.jsx:126`), then `handleSelect(item.id)`.
   - Wrap the app in `<NavigationContext.Provider>`; pass `focusedGateId` + `onFocusHandled` to `GateView` (scroll-to + highlight, clear after use).
3. **`src/components/shared/EntityLink.jsx` (new):** `EntityLink({ kind, id, label, className })` — `kind ∈ {item, feature, gate, view}`; renders `<button>` with `text-[11px] font-mono text-blue-400 hover:underline` convention (matches `PastBuildsView.jsx:141-146`); dispatches via `useNavigation()`; renders plain muted text when context absent or target unresolvable.
4. **Wire gap sites:**
   - `ItemDetailPanel.jsx:597-627` — make the pending-gate label (`:602-604`) an `EntityLink kind="gate"`.
   - `AttentionQueueSidebar.jsx:134-142` — replace `onViewChange?.('attention')` (broken target: no `'attention'` view exists) with local `expanded` state revealing all entries (rows `:120-133` already clickable).
   - `OpenLoopsPanel.jsx` `LoopRow` (`:113-164`) — render `loop.parent_feature` as `EntityLink kind="feature"` next to the age label.
   - `ContextPanel.jsx:171-175` — each pending-gate line becomes `EntityLink kind="gate"` (label stays `gateLabel(...)`).
   - `DashboardView.jsx:249` — recent-sessions featureCode badge becomes `EntityLink kind="feature"` (NOT `:349-351`, which is the completed-features badge).
5. **Tests:** new `test/ui/entity-link.test.jsx` (renders, navigates via mock context, degrades without provider); extend `test/ui/open-loops-panel.test.jsx` (parent feature link).

### S04 — COCKPIT-9: Journal & changelog surface

1. **`server/journal-routes.js` (new):** `attachJournalRoutes(app, { projectRoot, requireSensitiveToken })`, mounted in `VisionServer.attach()` (`server/vision-server.js` — alongside `attachGraphExportRoutes` `:227`):
   - `GET /api/journal?feature=<code>&limit=N` → `getJournalEntries(projectRoot, { feature_code, limit })` (`lib/journal-writer.js:859`) → `{entries, count}` passthrough. **`limit` must be parsed numerically** (`parseInt` + clamp, same pattern as `/api/builds` at `build-routes.js:28-31`) — both lib readers only honor `limit` when it is a number; a raw `req.query` string is silently ignored.
   - `GET /api/changelog?feature=<code>&limit=N` → `getChangelogEntries(projectRoot, { code, limit })` (`lib/changelog-writer.js:643`) — note param key difference (`feature_code` vs `code`), normalized here; same numeric `limit` parsing.
   - `POST /api/journal` (wrapped in `requireSensitiveToken`, same middleware used by `/api/build/start` at `build-routes.js:39`): body `{summary, feature_code?, sections:{what_happened, what_we_built, what_we_learned, open_threads}}`; derive `date` (today, local), base `slug` (slugify summary, conform to `SLUG_RE`), map `summary → summary_for_index`; **write-retry loop:** call `writeJournalEntry`; while `result.idempotent === true` append `-2, -3, …` to slug and retry (≤ 20, then 500). **Error mapping:** 400 on missing summary/sections AND on any writer error with `code === 'INVALID_INPUT'` (e.g. bad `feature_code`); other writer errors (incl. `JOURNAL_INDEX_FORMAT`) → 500.
2. **`src/components/vision/JournalView.jsx` (new):** modeled on `SessionsView` (toolbar + list + EmptyState). Source toggle journal/changelog; feature filter input; fetch via `wsFetch('/api/journal'|'/api/changelog')` on mount/filter-change. Entries render structured sections as labeled blocks — section *strings* go through the existing markdown renderer (`src/components/vision/shared/MarkdownViewer.jsx`); feature codes render as `EntityLink kind="feature"` (S03). "New entry" button → inline form (summary + 4 section textareas) → POST with `withComposeToken`, feedback via `notify()`.
3. **Registry (edit):** `viewTabsState.js:17-19` add `'journal'` to `DEFAULT_MAIN_TABS` (migration in `loadMainTabs` `:99-110` is automatic); `ViewTabs.jsx:17` add `TAB_META.journal` (label `Journal`, icon e.g. `BookOpen`, tip); `App.jsx` view switch (`:241-371` region) add `case 'journal'`.
4. **Tests:** new `test/journal-routes.test.js` (reads incl. string-`limit` honored, write happy path, slug-collision retry produces `-2`, token required, 400 on missing fields and `INVALID_INPUT`) using tmp project dir with seeded `docs/journal/README.md`; new `test/ui/journal-view.test.jsx` (toggle, render sections, write form); **tab-migration unit test** in `test/cockpit-layout.test.js` (seeds a pre-journal persisted tab list, asserts `loadMainTabs()` inserts `journal` — `viewTabsState.js:99-110` path is currently untested).

## File Plan

| File | Action | Slice |
|---|---|---|
| `src/lib/startBuild.js` | new | S01 |
| `src/components/vision/StartBuildPopover.jsx` | edit | S01 |
| `src/components/vision/PastBuildsView.jsx` | edit | S01 |
| `test/ui/past-builds-view.test.jsx` | edit | S01 |
| `server/vision-routes.js` | edit | S02 |
| `src/components/vision/GraphView.jsx` | edit | S02 |
| `test/graph-export-routes.test.js` | new | S02 |
| `src/lib/navigation.jsx` | new | S03 |
| `src/components/shared/EntityLink.jsx` | new | S03 |
| `src/App.jsx` | edit | S03, S04 |
| `src/components/vision/ItemDetailPanel.jsx` | edit | S03 |
| `src/components/vision/AttentionQueueSidebar.jsx` | edit | S03 |
| `src/components/vision/OpenLoopsPanel.jsx` | edit | S03 |
| `src/components/cockpit/ContextPanel.jsx` | edit | S03 |
| `src/components/vision/DashboardView.jsx` | edit | S03 |
| `src/components/vision/GateView.jsx` | edit | S03 |
| `test/ui/entity-link.test.jsx` | new | S03 |
| `test/ui/open-loops-panel.test.jsx` | edit | S03 |
| `server/journal-routes.js` | new | S04 |
| `server/vision-server.js` | edit | S04 |
| `src/components/vision/JournalView.jsx` | new | S04 |
| `src/components/cockpit/viewTabsState.js` | edit | S04 |
| `src/components/cockpit/ViewTabs.jsx` | edit | S04 |
| `test/journal-routes.test.js` | new | S04 |
| `test/ui/journal-view.test.jsx` | new | S04 |
| `test/cockpit-layout.test.js` | edit | S04 |

## Boundary Map

### S01: failed-build retry
Produces:
  src/lib/startBuild.js → startBuild (function)

Consumes: nothing (leaf node)

### S02: orphan routes wire-or-remove
Produces: nothing (integration only)

Consumes: nothing (leaf node)

### S03: entity links + navigation
Produces:
  src/lib/navigation.jsx → NavigationContext (const)
  src/lib/navigation.jsx → useNavigation (hook)
  src/components/shared/EntityLink.jsx → EntityLink (component)

Consumes: nothing (leaf node)

### S04: journal surface
Produces:
  server/journal-routes.js → attachJournalRoutes (function)
  src/components/vision/JournalView.jsx → JournalView (component)

Consumes:
  from S03: src/components/shared/EntityLink.jsx → EntityLink

## Verification Table (Phase 5)

All references read in-session on 2026-06-10 immediately before authoring; `validateBoundaryMap` run clean (`ok: true`, 0 violations, 0 warnings).

| Reference | Check | Result |
|---|---|---|
| `PastBuildsView.jsx:124-170` BuildRow, row 3 `:164-167` | read | ✓ matches |
| `StartBuildPopover.jsx:36-45` fetch pattern | read | ✓ matches |
| `build-routes.js:28-37` GET /api/builds, `:39-58` POST start | read | ✓ matches |
| `lib/build.js:916` per-feature active check | Codex-verified + test lock `test/build.test.js:199` | ✓ |
| `App.jsx:673-676` phaseFilteredGates, `:328-336` GateView props, `:702-712` handleSelect, `:927-932` handleOpenGate | read | ✓ matches |
| `viewTabsState.js:17-19` DEFAULT_MAIN_TABS, `:93-110` loadMainTabs auto-migration | read | ✓ matches (corrects design's TAB_META location) |
| `ViewTabs.jsx:17` TAB_META | grep | ✓ |
| `ItemDetailPanel.jsx:597-627` pending gates | read | ✓ matches |
| `AttentionQueueSidebar.jsx:134-142` +N more → 'attention' | read | ✓ matches (broken view target confirmed) |
| `OpenLoopsPanel.jsx:113-164` LoopRow, no parent_feature render | read | ✓ (corrects design's :150-164) |
| `ContextPanel.jsx:164-178` pending-gate plain text | read | ✓ matches |
| `DashboardView.jsx:249` session-card featureCode (target); `:349-351` completed-features badge (not the target) | Codex-verified | ✓ (corrects design's :351/:375) |
| `vision-routes.js:1079/:1102/:1108` orphan handlers | read | ✓ (corrects design's :1080/:1103/:1123) |
| `graph-export.js:320-344` export routes; mounted `vision-server.js:227` | read | ✓ matches |
| `journal-writer.js:646-648` return incl. `idempotent`, `:689` dedup under lock, `:859` getJournalEntries `feature_code` | read | ✓ matches |
| `changelog-writer.js:643` getChangelogEntries `code` filter | read | ✓ matches |
| Boundary Map | validateBoundaryMap | ✓ ok, 0 violations, 0 warnings |
