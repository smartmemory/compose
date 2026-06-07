# COMP-COCKPIT Slice B — Implementation Blueprint

**Scope:** Slice B = {COCKPIT-4 inline gate artifact, COCKPIT-5 first-run empty-state CTAs, COCKPIT-3 run history}. Slice A {2,1,6} already shipped.
**Status:** BLUEPRINT (Phase 4) + Phase 5 verification — feeds Phase 6 plan.
**Design:** `docs/features/COMP-COCKPIT/design.md` (umbrella, gate-approved 2026-06-07; per-feature design for -3/-4/-5 is authoritative).

All file:line references below were read directly from source on 2026-06-08, **after Slice A shipped** (lines shifted from the design, which was written pre-Slice-A).

---

## Corrections table (design assumption vs. verified reality)

| # | Design said | Verified reality (2026-06-08) | Resolution |
|---|---|---|---|
| C1 | COCKPIT-4: DocsView markdown render at `:520-539` | Shifted to **`DocsView.jsx:537-542`**; render is `ReactMarkdown remarkPlugins={[remarkGfm]} components={{code: MarkdownCode}}`. Mermaid handled by custom `MermaidBlock` (`:26-58`) + `MarkdownCode` (`:60-67`), **not** a remark plugin. | The shared `MarkdownViewer` must carry `MarkdownCode`+`MermaidBlock` (or import them), not just ReactMarkdown+remarkGfm. |
| C2 | COCKPIT-4: gate `artifactSnapshot` at `vision-routes.js:772` | Persisted at **`vision-routes.js:812`** (creation reads file `:774-783`). `gate.artifactSnapshot` reaches UI; GateView already consumes snapshots for *prior revisions* via `ArtifactDiff` (`:154`, props `{oldText,newText}`). | Render the gate's **own** `gate.artifactSnapshot` inline. No new field, no fetch. |
| C3 | COCKPIT-4: "optionally offer compare-to-latest" live `/api/file` fetch | GateView (423 lines) is **pure-presentation, has zero fetch/wsFetch imports**. | **Drop the live compare-to-latest from v1.** Render snapshot only (collapsible). Preserves gate immutability and keeps GateView fetch-free. (Diff-vs-snapshot for *revisions* already exists; unchanged.) |
| C4 | COCKPIT-5: Graph & Dashboard empty states dead-end | GraphView has ONE empty branch (`:1041` `filteredItems.length===0`, msg `:1044`) but `filteredItems` is post status/group/track filter (`:665-680`) — it does **NOT** distinguish empty-project from filtered-out. DashboardView's `!featureCode` branch (`:314-322`) means "no active feature in session," **not** first-run/empty-project. TreeView (`:429-431` `tree.length===0`) is filtered too. **(Codex blueprint review correction.)** | **No view can decide emptiness locally** — all receive already-filtered data. Compute `isEmptyProject` ONCE in `App` from the **raw store items** (`useVisionStore s.items`, App `:414`) and pass it down. Each view shows the create CTA only on the `isEmptyProject` branch; keep "no match" copy for the filtered-but-nonempty case. |
| C5 | COCKPIT-5: `ItemFormDialog` at `shared/ItemFormDialog.jsx` | Path is **`src/components/vision/shared/ItemFormDialog.jsx`** (note `vision/`). `QUICK_TYPES` `:23-28` has 5 presets (task/decision/question/idea/spec), no feature. Props `{open, onClose, parentItem}` — **no `initialType`**. | Add `feature` preset to `QUICK_TYPES`; add `initialType` prop (default `'task'`) so a CTA can preselect feature. |
| C6 | COCKPIT-5: App `onCreate` (`:242`) | `handleCreate` at **`App.jsx:866-879`**, takes no args, creates hardcoded `task`; dialog controlled by `createOpen` state (`:507`), mounted `:1316` `open={createOpen} onClose={()=>setCreateOpen(false)}`. Views render in inner component receiving `onCreate` (`:264`, `:1161`). | Add `createInitialType` state + `onCreateFeature` callback `()=>{setCreateInitialType('feature'); setCreateOpen(true)}`; thread `onCreateFeature` + `isEmptyProject` to Tree/Graph/Dashboard; pass `initialType={createInitialType}` to ItemFormDialog. |
| C7 | COCKPIT-3: archive at terminal sites `:1894/:1912/:1929` | Those write `active-build.json` **but the COMP-HEALTH gate (`:1983-1994`) can later downgrade `buildStatus` to `'failed'`** — archiving at the terminal sites would record `complete` for a build whose final status is `failed`. **(Codex blueprint review correction.)** | Archive ONCE **after** the health-gate block resolves `buildStatus` (after `:2002`, still inside the main try so `stepHistory` `:945` is in scope), using the **final** `buildStatus` + in-memory hoisted vars (`featureCode`, `buildStartedAt :579`, `buildCostTotals :801`, `stepHistory`, `itemId :743`, `mode :553`). Skip non-terminal status. **Never** re-read `active-build.json` (last-writer-wins, [[project_compose_idempotency_gaps]] + `build-routes.js:9`). |
| C8 | COCKPIT-3: `/api/build/state` read endpoint in `build-routes.js` | `attachBuildRoutes` (`build-routes.js:20`) mounts POST start/abort; the GET read is in **`vision-server.js:154`**. | Register `GET /api/builds` in `build-routes.js` `attachBuildRoutes`; mirror the simple disk-read style of `vision-server.js:154`. |
| C9 | COCKPIT-3: `failureReason` not persisted | Confirmed. Derivable from last `stepHistory` entry with `outcome==='failed'` → `.summary`. | Derive at the single archive site; persist in archive record. |
| C10 | COCKPIT-3: store at `src/store/useVisionStore.js`; nav via `AttentionQueueSidebar` | Store is **`src/components/vision/useVisionStore.js`** (no `src/store/`). Primary nav is the **header tab system**: `viewTabsState.js DEFAULT_MAIN_TABS :17-19` + `ViewTabs.jsx TAB_META :17-27`, **not** the sidebar. **(Codex blueprint review correction.)** | Add `'build-history'` to `DEFAULT_MAIN_TABS` and a `TAB_META['build-history']` entry (label/icon/tip); store edits go in `vision/useVisionStore.js`. `PastBuildsView` must receive **all** (unfiltered) `items` for feature-code click resolution, like SessionsView. |

No correction invalidates the design. C3 narrows v1; C4/C6/C10 sharpen the wiring; C7 is the load-bearing safety choice (single post-health-resolution archive).

---

## COCKPIT-4 — Inline artifact content in gate review (M)

### New shared component: `src/components/vision/shared/MarkdownViewer.jsx`
Extract DocsView's render path so both consume one component (DRY; DocsView is 564 lines).
- Move `MermaidBlock` (`DocsView.jsx:26-58`) + `MarkdownCode` (`:60-67`) into `MarkdownViewer.jsx`.
- Export `default function MarkdownViewer({ content, className })` rendering:
  ```jsx
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>
    {content}
  </ReactMarkdown>
  ```
  wrapped in the existing prose `<div>` (DocsView `:529-536` classes) when `className` not overridden.
- **Edit `DocsView.jsx`:** import `MarkdownViewer`, replace the inline block (`:529-543`) with `<MarkdownViewer content={fileContent} />`; drop now-unused local `MermaidBlock`/`MarkdownCode`/markdown imports if no longer referenced elsewhere in the file (verify before deleting).

### Edit `GateView.jsx`
- Import `MarkdownViewer` (`./shared/MarkdownViewer.jsx`) + `useState` (already imported).
- In `PendingGateRow`, **after** `ArtifactAssessment` (`:21-49` is the component; render site within the row), add a collapsible "View artifact" section that renders `gate.artifactSnapshot` via `MarkdownViewer` when the snapshot is non-empty. Default collapsed; toggle with a small `Button`/chevron consistent with existing GateView styling.
- Empty/absent snapshot → render nothing (or a muted "no artifact captured" line), never a fetch.

**Files:** new `MarkdownViewer.jsx`; edit `GateView.jsx`, `DocsView.jsx`.

---

## COCKPIT-5 — First-run empty-state CTAs (M)

### Edit `ItemFormDialog.jsx`
- Add to `QUICK_TYPES` (`:23-28`): `{ id: 'feature', label: 'Feature', defaults: { type: 'feature', phase: 'vision', priority: 2, governance: 'gate' } }`.
- Add `initialType` prop (default `'task'`); on open, set `selectedType` + apply that preset's defaults to the form (extend the existing open-reset effect). Keep back-compat: omitted prop ⇒ `'task'` (current behavior).

### Edit `App.jsx` (compute emptiness centrally + wiring)
- **`isEmptyProject`:** App already reads raw store items (`:414` `items: s.items`). Compute `const isEmptyProject = items.length === 0;` and pass it to the views. This is the **only** correct emptiness signal — every view receives pre-filtered data and cannot decide locally (C4).
- Add state: `const [createInitialType, setCreateInitialType] = useState('task');`
- Add callback: `const handleCreateFeature = useCallback(() => { setCreateInitialType('feature'); setCreateOpen(true); }, []);`
- Pass `initialType={createInitialType}` to `<ItemFormDialog>` (`:1316`); reset `createInitialType` to `'task'` on close.
- Thread `onCreateFeature={handleCreateFeature}` + `isEmptyProject={isEmptyProject}` to the inner component and down to TreeView/GraphView/DashboardView (mirror existing `onCreate` threading at `:264`/`:1161`).

### Edit `TreeView.jsx` / `GraphView.jsx` / `DashboardView.jsx` (CTA on empty-project branch)
- Add `onCreateFeature` + `isEmptyProject` props to each.
- In each existing empty-state block (Tree `:429-431`, Graph `:1041-1045`, Dashboard `!featureCode` branch `:314-322`):
  - **`isEmptyProject` true** ⇒ show "No items yet" + **"Create your first feature"** button → `onCreateFeature?.()`.
  - else (filtered-out, project non-empty) ⇒ keep existing "no match"/CTA copy unchanged.
- Do **not** use view-local `length===0` heuristics to decide emptiness — gate on the `isEmptyProject` prop.

**Scope boundary (from design):** creates a `type:'feature'` *vision item* only — not a feature folder + `/compose build`. Full scaffold-from-UI is COMP-PARITY-9. Honest stop.

**Files:** `src/components/vision/shared/ItemFormDialog.jsx`, `TreeView.jsx`, `GraphView.jsx`, `DashboardView.jsx`, `App.jsx`.

---

## COCKPIT-3 — Run history / past builds (M, heaviest)

### New writer: `lib/build-history.js`
- `export function appendBuildHistory(dataDir, record)` — atomic append a single JSON line to `<dataDir>/build-history.jsonl` via `appendFileSync` (JSONL append is atomic for our small records; mirrors `BuildStreamWriter` append style). Create file if absent. Never throw into the build path — wrap in try/catch, log on failure.
- `export function readBuildHistory(dataDir, { limit = 50 } = {})` — read file if present, split lines, JSON.parse each (skip malformed), return **most-recent-first**, bounded to `limit`. Missing file ⇒ `[]`.
- Record shape (assembled from in-memory vars, C7):
  ```js
  {
    featureCode, flowId, mode,                 // identity
    status,                                    // 'complete' | 'aborted' | 'failed'
    startedAt, completedAt, durationMs,        // timing (completedAt = now, durationMs = now - buildStartedAt)
    cost_usd, input_tokens, output_tokens,     // from buildCostTotals
    stepCount,                                  // stepHistory.length
    failureReason,                              // null on success; derived on fail/abort
    itemId,
  }
  ```

### Edit `lib/build.js` (ONE archive site, post-health-resolution)
- **Do NOT archive at the three terminal sites** (`:1894/:1912/:1929`) — the COMP-HEALTH gate (`:1983-1994`) can downgrade `buildStatus` to `'failed'` afterward, so those sites see a non-final status (C7).
- Add a single archive call **after the health-gate block resolves** (after `:2002`, still inside the main try so `stepHistory` `:945` is in scope), before the audit-trace write:
  ```js
  if (['complete','aborted','failed','killed'].includes(buildStatus)) {
    const lastFailed = [...stepHistory].reverse().find(s => s.outcome === 'failed');
    const failureReason = buildStatus === 'complete' ? null
      : (lastFailed?.summary ?? `Build ${buildStatus}`);
    appendBuildHistory(dataDir, {
      featureCode, flowId: response?.flow_id ?? null, mode, status: buildStatus,
      startedAt: buildStartedAt, completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(buildStartedAt).getTime(),
      cost_usd: buildCostTotals.cost_usd, input_tokens: buildCostTotals.input_tokens,
      output_tokens: buildCostTotals.output_tokens, stepCount: stepHistory.length,
      failureReason, itemId,
    });
  }
  ```
  Wrap in try/catch (never break the build). Import `appendBuildHistory` from `./build-history.js`.
- Confirm `flowId` source in scope at that point (use `response?.flow_id` or the hoisted flow id if available; nullable is fine).

### Edit `server/build-routes.js`
- In `attachBuildRoutes`, add `app.get('/api/builds', (req,res) => {...})`: read `limit` query (default 50, cap 200), call `readBuildHistory(dataDir, {limit})`, return `{ builds }`. Read-only — **no** `requireSensitiveToken` (mirrors `/api/build/state`). Resolve `dataDir` the same way existing routes do.

### New UI: `src/components/vision/PastBuildsView.jsx`
- Mirror `SessionsView.jsx` (177 lines): toolbar (title + count + optional status filter) + scrollable list + empty state ("No past builds yet — runs are recorded after this ships") + `BuildRow` per record.
- `BuildRow`: feature code (clickable → `onSelectItem`), status badge (complete/aborted/failed colors), relative `completedAt`, duration, cost chip, `failureReason` line when present.

### Store + nav wiring
- `src/components/vision/useVisionStore.js` (NOT `src/store/`): add `buildHistory: []` + `setBuildHistory`, and a `fetchBuildHistory()` that `wsFetch('/api/builds')` → `setBuildHistory`. Hydrate when the view opens (mirror sessions hydration `:227`).
- **Header tab registration (C10):** add `'build-history'` to `DEFAULT_MAIN_TABS` (`src/components/cockpit/viewTabsState.js:17`) and a `TAB_META['build-history']` entry (label "Builds", an icon e.g. `History`/`Clock`, tip) in `src/components/cockpit/ViewTabs.jsx:17`.
- `App.jsx`: add `case 'build-history':` to the view switch (`:299` area) rendering `<PastBuildsView items={items} onSelectItem={handleSelect} .../>` — pass **unfiltered** `items` for feature-code resolution.

**Scope (gate-confirmed):** forward-only — only builds after this ships are recorded; honest empty state until then. No backfill.

**Files (new):** `lib/build-history.js`, `src/components/vision/PastBuildsView.jsx`. **(edit):** `lib/build.js`, `server/build-routes.js`, `src/components/vision/useVisionStore.js`, `src/App.jsx`, `src/components/cockpit/viewTabsState.js`, `src/components/cockpit/ViewTabs.jsx`.

---

## Boundary Map

- **`MarkdownViewer`** — `component`, `src/components/vision/shared/MarkdownViewer.jsx`. Produced COCKPIT-4. Consumed by `GateView` + `DocsView`.
- **`appendBuildHistory` / `readBuildHistory`** — `function`s, `lib/build-history.js`. Produced COCKPIT-3. `appendBuildHistory` consumed by `lib/build.js` (3 terminal sites); `readBuildHistory` consumed by `server/build-routes.js` (`GET /api/builds`).
- **`onCreateFeature`** / **`isEmptyProject`** — callback + boolean props, originate in `App.jsx` (`handleCreateFeature`; `isEmptyProject = items.length===0` from raw store items). Consumed by `TreeView`, `GraphView`, `DashboardView` empty states.
- **`initialType`** — prop on `ItemFormDialog`. Produced COCKPIT-5 (App passes `createInitialType`). Consumed by ItemFormDialog open-reset.
- **`gate.artifactSnapshot`** — existing field (`vision-routes.js:812`). Consumed by `GateView` inline render. (Untouched dependency.)
- **`writeActiveBuild` / `readActiveBuild` / `stepHistory` / `buildCostTotals`** — existing (`lib/build.js`). Read by `recordBuildHistory`. (Untouched.)

Topology: three independent features; no cross-feature forward references. COCKPIT-3's writer is produced before its server/UI consumers (same slice, earlier file).

---

## Phase 5 — Verification Table (verified 2026-06-08)

| Check | Result |
|---|---|
| `GateView.jsx` ArtifactAssessment metadata + no fetch | ✅ `:21-49`; zero fetch/wsFetch imports (7 imports, UI-only). |
| `gate.artifactSnapshot` persisted & reaches UI | ✅ `vision-routes.js:812`; snapshot already used for revisions (`GateView:154`). |
| `DocsView` render path + mermaid handling | ✅ `:537-542` ReactMarkdown+remarkGfm; `MermaidBlock :26-58`, `MarkdownCode :60-67`. |
| `ArtifactDiff` props `{oldText,newText}`, already imported | ✅ `shared/ArtifactDiff.jsx`; `GateView:7` import, `:154` use. |
| `ItemFormDialog` path + QUICK_TYPES (no feature) + props | ✅ `vision/shared/ItemFormDialog.jsx`; `QUICK_TYPES :23-28` (5, no feature); props `{open,onClose,parentItem}`, no `initialType`. |
| Backend accepts `type:'feature'` | ✅ `vision-store.js:10` VALID_TYPES includes `feature`; validated `:156`. |
| `TreeView` ambiguous empty state + has `items` prop | ✅ `:429-431` `tree.length===0`; props include `items`. |
| GraphView / DashboardView already disambiguate | ✅ Graph `:1041/:1044`; Dashboard `:323-324`. CTA-only changes. |
| App dialog control: `createOpen` state + mount | ✅ `:507` state; `:1316` mount `open={createOpen}`. |
| `lib/build.js` terminal sites + in-scope vars | ✅ complete `:1894`, aborted `:1912`, failed `:1929`; `featureCode/buildStartedAt:579/buildCostTotals:801/stepHistory:945/buildStatus:797/itemId:743/mode/cwd` all in `runBuild` scope. |
| `writeActiveBuild` atomic rename | ✅ `lib/build.js:407-415`. |
| `failureReason` not persisted; derivable | ✅ confirmed; last failed `stepHistory[].summary`. |
| `build-routes.js attachBuildRoutes` + `/api/build/state` read pattern | ✅ `:20`; read GET mirror at `vision-server.js:154`. |
| `.compose/data/` dir + append helpers | ✅ `dataDir = join(composeDir,'data')` (`build.js:558`); `appendFileSync`/`BuildStreamWriter` patterns. |
| `SessionsView` structure to mirror | ✅ 177 lines, toolbar+list+empty+row. |
| View nav registration | ✅ App switch `:299`; `AttentionQueueSidebar` `onViewChange`; store hydration `useVisionStore`. |

**Gate:** All references verified; zero stale entries; Boundary Map satisfiable; one scoped deferral (C3 live compare-to-latest → out of v1). **Phase 5 PASS.**

---

## Test plan (per testing rules — real backends, behavior assertions)

- **COCKPIT-3 golden flow:** `appendBuildHistory` then `readBuildHistory` round-trips (most-recent-first, bounded); malformed line skipped; missing file ⇒ `[]`. Plus: terminal site assembles record from in-memory vars (failureReason derived). Server: `GET /api/builds` returns the records (real Express handler, temp dataDir).
- **COCKPIT-4 component:** GateView renders `gate.artifactSnapshot` body inline when present; renders nothing when empty; never fetches. `MarkdownViewer` renders markdown + a mermaid code block path.
- **COCKPIT-5 component:** TreeView shows empty-project CTA when `items.length===0`, "no match" when filtered; `ItemFormDialog` with `initialType='feature'` preselects the feature preset and submits `type:'feature'`.
- **E2E smoke (Phase 7):** run a build to terminal → record appears in PastBuildsView; open a gate → artifact body visible inline; empty project → create-feature CTA opens dialog.
