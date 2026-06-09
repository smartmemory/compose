# COMP-COCKPIT Wave 2 — UX Journey Gaps (Umbrella Design)

**Status:** DESIGN (Phase 1) — this is a design document, not shipped code; file:line references describe the codebase as explored on 2026-06-10
**Created:** 2026-06-10
**Source:** 2026-06-10 UX journey sweep (follow-up to the 2026-06-07 sweep that produced Wave 1)
**Parent:** COMP-COCKPIT umbrella (`design.md` — Wave 1, COMPLETE)
**Scope:** COMP-COCKPIT-7, -8, -9, -10. COMP-MOBILE-1 shares the roadmap phase but is a separate code, out of scope here.

## Problem

Wave 1 closed the silent-failure / native-dialog / observability gaps. The 2026-06-10 journey sweep found the next ring: journeys that *start* in the cockpit and dead-end to the terminal (retry a failed build), entities that are visible but not navigable (gate names, feature codes, loop parents rendered as plain text), narrative memory (journal/changelog) with zero UI surface, and five server routes nobody calls.

All four items were line-verified by three exploration passes on 2026-06-10. Verified corrections to the roadmap rows are flagged inline below.

---

## Per-item design

### COMP-COCKPIT-7 — Failed-build retry from Past Builds (S)

**Finding:** retry is pure frontend wiring — no server work.
- The archived build record (`lib/build.js:2014-2028` → `build-history.jsonl`) already carries `featureCode` and `mode`.
- `POST /api/build/start` (`server/build-routes.js:39-58`) accepts exactly `{featureCode, mode, description}`, returns 409 when a build is already active.
- `StartBuildPopover.jsx:36-48` is the canonical dispatch pattern: `wsFetch` + `withComposeToken`, error message extracted from `response.error`.

**Approach:**
- Add a `Retry` button in `BuildRow` row 3 (`PastBuildsView.jsx:165-167`), rendered only when `status ∈ {failed, aborted}` (not `killed` — a killed build was deliberately stopped; not `complete`).
- Click → POST `/api/build/start` with the record's `featureCode` + `mode` (no description — the server re-resolves from the feature folder). Disable button while in flight.
- **Conflict model (corrected):** the active-build check is **per feature code**, not a global lock — concurrent builds for *different* features are explicitly allowed (`lib/build.js:916`, locked in by `test/build.test.js:199`). A retry only 409s when *that same feature* already has a live build. Copy accordingly: 409 → `notify('A build for <code> is already active', 'warn')`.
- Other feedback via `notify()` (`NotificationBar.jsx:81`): success → `notify('Build restarted for <code>', 'info')`; other errors → `notify(message, 'error')`.
- Extract the dispatch into a small shared helper (e.g. `startBuild({featureCode, mode, description})` in `src/lib/`) consumed by both `StartBuildPopover` and the retry button, rather than duplicating the fetch.

**Files:** `PastBuildsView.jsx` (edit), `StartBuildPopover.jsx` (edit — consume helper), `src/lib/startBuild.js` (new). Tests extend `test/ui/past-builds-view.test.jsx`.

### COMP-COCKPIT-8 — Cross-view entity links (M)

**Finding:** `App.jsx` owns the navigation callbacks — `handleSelect` (:702), `handleOpenGate` (:927), `handleViewChange` (:576), `handleViewInGraph`/`Tree` (:975/:982) — but there is no shared link component; every existing clickable entity is an ad-hoc `<button>`. **Correction (Codex-verified):** `handleOpenGate` does *not* open the Gates view — it only selects the gate's owning item in the context panel and carries no gate-focus state. True jump-to-gate is new work, not reuse.

**Approach — one primitive, then wire the four sites:**
1. **`EntityLink` component** (new, `src/components/shared/EntityLink.jsx`): renders an inline clickable chip/text for `{kind: 'feature'|'item'|'gate'|'session', id, label}`. Navigation callbacks delivered via a React context (`NavigationContext`, new) provided by `App.jsx` wrapping the existing handlers — avoids threading 4 more props through every view. Styling follows the existing convention (`hover:underline`, `text-[11px]`, muted → foreground on hover).
2. **New `openGate(gateId)` navigation primitive** in App.jsx, exposed via `NavigationContext`: `handleViewChange('gates')` + a new gate-focus state (e.g. `focusedGateId`) passed to `GateView` so it scrolls to / highlights that gate. **Phase-filter interaction:** App.jsx filters gates through `selectedPhase` before they reach `GateView` (`App.jsx:328,673`), so a deep-linked gate can be invisible on arrival — `openGate` must clear `selectedPhase` (or set it to the target gate's phase) as part of navigation. Falls back to item-select if the gate is gone. This is what gate `EntityLink`s call — not the existing `handleOpenGate`.
3. **Wire the four named gap sites:**
   - `ItemDetailPanel.jsx:597-627` — pending-gate box becomes a link → `openGate(gate.id)` (navigates to Gates view, focuses that gate).
   - `AttentionQueueSidebar.jsx:134-142` — "+N more" currently navigates to a nonexistent `'attention'` view (**roadmap row understated this: it's a broken target, not just a missing path**). Replace with expand-in-place (show all queued entries, each already clickable) — no new view needed.
   - `OpenLoopsPanel.jsx:150-164` — render `loop.parent_feature` (already in the data, never rendered) as an `EntityLink` to the parent feature.
   - `ContextPanel.jsx:164-178` — each pending-gate line becomes an `EntityLink` showing the owning feature code + gate label → `openGate`.
4. **Sweep remaining plain-text sites** found by exploration: `DashboardView.jsx:351/:375` (featureCode in session cards). `SessionsView` already links feature codes (:146-157) — leave as-is or migrate to `EntityLink` only if zero-risk.

**Scope boundary:** "every entity everywhere" is the roadmap's aspiration; v1 delivers the primitive + the four named sites + the Dashboard sweep. New surfaces adopt `EntityLink` going forward.

**Files:** `EntityLink.jsx` (new), `NavigationContext` (new, can live in EntityLink module or `src/lib/navigation.js`), `App.jsx` (provider), `ItemDetailPanel.jsx`, `AttentionQueueSidebar.jsx`, `OpenLoopsPanel.jsx`, `ContextPanel.jsx`, `DashboardView.jsx` (edits). New test `test/ui/entity-link.test.jsx`.

### COMP-COCKPIT-9 — Journal & changelog cockpit surface (M)

**Finding:** zero HTTP routes exist for journal/changelog; the lib layer is complete (`lib/journal-writer.js` — files under `docs/journal/` with frontmatter + required sections; `lib/changelog-writer.js` — parses/writes root `CHANGELOG.md`). MCP tools are thin wrappers (`server/compose-mcp-tools.js:392-414`). The AgentPanel "journal" badge is a session-spawned flag, not a data feed.

**Lib contracts (Codex-verified — the routes are adapters, not pass-throughs):**
- `writeJournalEntry()` (`lib/journal-writer.js:592,648`) requires `date`, `slug`, `summary_for_index`, and exactly four section keys (`what_happened`, `what_we_built`, `what_we_learned`, `open_threads`).
- `getJournalEntries()` (`:859`) returns **structured sections**, not a markdown body; it filters by `feature_code`.
- `getChangelogEntries()` (`lib/changelog-writer.js:643`) filters by `code` (different key than journal).

**Approach:**
- **Routes** (new `server/journal-routes.js`, pattern: `settings-routes.js:1-35` — `attachJournalRoutes(app, deps)`, 400 on validation, 500 on internal). Both readers normalize the feature-filter param server-side (`?feature=` → `feature_code` for journal, `code` for changelog):
  - `GET /api/journal?feature=<code>&limit=N` → `getJournalEntries` → `{entries: [{date, slug, feature_code, summary, sections: {what_happened, what_we_built, what_we_learned, open_threads}}]}`
  - `GET /api/changelog?feature=<code>&limit=N` → `getChangelogEntries` → `{entries: [...parsed changelog shape...]}`
  - `POST /api/journal` (sensitive — `requireSensitiveToken`, same as build/start): body `{summary, feature_code?, sections: {what_happened, what_we_built, what_we_learned, open_threads}}`; the route **derives** `date` (today) and `slug` (slugified summary) and maps `summary` → `summary_for_index` — the UI never supplies writer-internal fields.
  - **Slug-collision strategy:** `writeJournalEntry()` dedupes on `(date, slug)` and silently no-ops on duplicates unless `force` (`lib/journal-writer.js:669,689`); a pre-write existence check alone is not concurrency-safe (the writer detects duplicates under its own lock). The route therefore uses a **write-retry loop keyed on the writer's no-op signal**: call `writeJournalEntry` with the derived slug; if the result indicates the idempotent duplicate no-op (entry already exists for `(date, slug)`), append the next suffix (`-2`, `-3`, …) and retry, bounded (e.g. 20 attempts → 500). Collision detection thus happens under the writer's lock, never in the route. If the writer's return value cannot distinguish no-op from fresh write, extending it to do so (a boolean on the result) is in scope for this item.
  - Changelog write stays MCP/agent-only in v1 — CHANGELOG.md edits belong to the ship pipeline, a manual UI write invites drift.
- **UI:** new `JournalView` modeled on `SessionsView` (toolbar: feature filter + journal/changelog toggle; scrollable list). Entries render their **structured sections** as labeled blocks; each section's text goes through the existing markdown renderer (`MarkdownViewer` expects a raw markdown string — feed it per-section strings, not the entry object). Write form mirrors the POST body: summary + the four section textareas.
- **Tab registry (not just the App.jsx switch):** header tabs are driven by `DEFAULT_MAIN_TABS` + `TAB_META` (`src/components/cockpit/viewTabsState.js:17,93`) and `ViewTabs.jsx:17`. JournalView must be added there too (including the persisted-tab migration path) or it never appears in the default tab set.
- Feature codes inside entries render as `EntityLink` (consumes COCKPIT-8's primitive).

**Files:** `server/journal-routes.js` (new), mounted inside `VisionServer.attach()` (`server/vision-server.js:80` — where settings/vision/session/build/graph-export routes attach, *not* a server index file), `JournalView.jsx` (new), `App.jsx` (view switch), `viewTabsState.js` + `ViewTabs.jsx` (tab registry), tests `test/journal-routes.test.js` + `test/ui/journal-view.test.jsx`.

### COMP-COCKPIT-10 — Orphaned server routes: wire or remove (M)

**Finding:** all five orphans confirmed zero callers (src/, bin/, lib/) and zero tests. Per-route verdicts:

| Route | Location | Verdict | Rationale |
|---|---|---|---|
| `GET /api/vision/blocked` | `vision-routes.js:1080-1100` | **Delete** | Redundant — AttentionQueueSidebar computes blocked client-side from `item.status` (`attentionQueueState.js:55`); server feed adds a second source of truth for the same fact. |
| `POST /api/vision/ui` | `vision-routes.js:1103-1106` | **Delete** | Broadcasts lens/layout UI commands; no sender exists, and remote-controlling the UI via unauthenticated POST is a misfeature absent a concrete consumer. |
| `POST /api/plan/parse` | `vision-routes.js:1123-1151` | **Delete** | Plan-text path extraction with no paste-a-plan UI; trivially recreatable from git if a dialog ever ships. |
| `GET /api/export/roadmap-graph` | `graph-export.js:322-329` | **Wire** | Real capability (COMP-ROADMAP-GRAPH generator) with genuine user value; expose as an "Export graph" action in the graph view toolbar — open the returned HTML in a new tab. |
| `POST /api/export/roadmap-graph/save` | `graph-export.js:332-343` | **Wire** (same action) | "Save to docs/" variant of the same export button; success → `notify()` with the written path. |

**Principle:** wire only where a real user journey exists today; delete the rest — dead routes are attack/maintenance surface. Deletions are commits, trivially restorable.

**Files:** `vision-routes.js` (delete 3 handlers), `graph-export.js` (unchanged), `GraphView.jsx` (export button), tests for the two export routes (`test/graph-export-routes.test.js` extension or new).

---

## Cross-item dependencies & build order

```
COCKPIT-8 (EntityLink primitive) ──→ COCKPIT-9 (JournalView consumes EntityLink)
COCKPIT-7 — independent
COCKPIT-10 — independent (GraphView button may use notify(), already shipped)
```

Build order: **7 → 10 → 8 → 9** (smallest/independent first, primitive before its consumer). Single batch build → **integration review across all four at the end** (cross-feature contract mismatches are the known batch-build failure mode).

## Unproven assumptions

- None hard. One soft check for the blueprint phase: confirm `requireSensitiveToken` is importable/attachable in a new route module the same way `build-routes.js` does it.

## Out of scope

- COMP-MOBILE-1 (mobile parity cluster — separate item).
- Backfilling journal UI with changelog *write* support.
- Full "every entity everywhere is a link" audit beyond the named sites + Dashboard sweep.
- `POST /api/vision/ui` replacement telemetry (delete is the decision; if a remote-control use case appears it gets its own design).
