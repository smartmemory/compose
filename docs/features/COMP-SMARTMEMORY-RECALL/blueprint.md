# COMP-SMARTMEMORY-RECALL: Implementation Blueprint

**Status:** BLUEPRINT — implementation-ready. Derived from the LOCKED design at
[`design.md`](./design.md) (8 review rounds; do not redesign). Where reality
contradicted the design's citations, the contradiction is recorded in the
[Corrections table](#corrections-file-cited-vs-found) rather than re-litigated.

## Related Documents

- Design: [`design.md`](./design.md) (decisions LOCKED)
- Depends on: [COMP-SMARTMEMORY-INGEST](../COMP-SMARTMEMORY-INGEST/design.md) —
  RECALL consumes INGEST's shared modules as a **contract**:
  - `lib/smartmemory-config.js` → `getSmartmemoryConfig(cwd)` (INGEST Decision 1),
    `resolveProjectTag(cwd)` (INGEST Decision 6)
  - `lib/smartmemory-client.js` → a client exposing `search(query, opts)` (INGEST
    Decision 2)
  - These files are authored by INGEST (blueprinted in parallel). RECALL's route
    statically imports them for its **default** deps, so `server/smartmemory-routes.js`
    cannot even load until INGEST slices S01+S02 exist on disk (see T1's dependency
    note) — RECALL implementation starts **after** those two files land. RECALL's
    tests inject stubs for behavior, but stub injection does not remove the
    module-load dependency. The two features ship together (task #4, integration).

---

## Corrections (file cited vs found)

Every design citation was opened at the cited lines. Result: the design's
architecture is sound; the corrections below are mechanism-level pins and two
envelope refinements the implementer MUST honor.

| # | Design said | Found (file:line) | Correction to apply |
|---|---|---|---|
| 1 | Read the feature description "resolved through `resolveFeaturesPath` … NOT a helper that hardcodes `docs/features`" | `readFeature(cwd, code, featuresDir='docs/features')` **defaults** its third arg to the hardcoded `'docs/features'` (`lib/feature-json.js:47`); `featuresBase` passes it through `resolvePathValue`, which is absolute-safe (`lib/feature-json.js:21-23`) | Call `readFeature(root, featureCode, resolveFeaturesPath(root))` — pass the **resolved absolute** features dir explicitly. `resolveFeaturesPath` (`lib/project-paths.js:31`) returns an absolute path; `featuresBase` accepts it. Never call `readFeature(root, featureCode)` with the default, which would miss `paths.features` overrides. |
| 2 | Query = "`<featureCode> <roadmap description>`" | The description field is `feature.description` on the `FeatureJson` shape (`lib/feature-json.js:28`) | Description source is `readFeature(...)?.description`. Fall back to plain `featureCode` when the feature is absent **or** has no `description`. |
| 3 | Register in `vision-server.js` `attach()` "lines 87-174 / 82-174" | `attach(httpServer, app)` opens at `server/vision-server.js:82`; the read-only route registrations run 87-174; `attachQaScopeRoutes(app)` is the last read-only sibling at `:103` | Insert `attachSmartmemoryRoutes(app);` **immediately after line 103** (`attachQaScopeRoutes(app)`), before `attachVisionRoutes` (`:106`). Default deps — the handler reads `root` off `req.workspace` like qa-scope; no deps passed at the call site. |
| 4 | qa-scope is "the route model"; route reads the workspace | `attachQaScopeRoutes` reads `req.workspace?.root` and returns `{found:false,...}` shaped 200s on every failure (`server/qa-scope-routes.js:38-95`); deps are default-injected (`:33-37`) | Mirror exactly: read `req.workspace?.root`; default-inject `getConfig`/`createClient`/`readFeature`/`resolveFeaturesPath`/`resolveProjectTag` so the route test can stub them; every path returns a shaped 200, never a throw. |
| 5 | Auth: `/api/smartmemory/recall` "collides with no allowlisted prefix … left OFF the allowlist" | Allowlist = `['/m','/assets/','/manifest.webmanifest','/m-sw.js','/api/health','/api/workspace','/api/auth/pair/complete','/api/auth/refresh']` (`server/index.js:93-102`); prefix match at `server/auth-middleware.js:185-189` (`path===p || startsWith(p+'/') || startsWith(p+'?')`) | Confirmed: no allowlist entry is a prefix of `/api/smartmemory/recall` (`/api/health` matches only `/api/health[/?…]`). Add **nothing** to the allowlist — the route is auth-gated in remote mode, as designed. |
| 6 | UI "mirror `ContextFilesTab` — `wsFetch` keyed on the canonical feature code, `AbortController` on code change/unmount" | `ContextFilesTab` fetches `/api/files` in a `useEffect([featureCode])` with `AbortController` (`src/components/vision/ContextFilesTab.jsx:34-52`) but then filters by a **hardcoded** `docs/features/${featureCode}/` prefix (`:54`) | Mirror the **fetch-on-open + AbortController** pattern (`:34-52`) only. RecallTab fetches `/api/smartmemory/recall?featureCode=…` — it does **not** use the `/api/files` path prefix. |
| 7 | Probe "keyed on the current workspace identity (`WorkspaceContext.jsx`, `App.jsx:565-580`)" | `ContextItemDetail` today consumes **only** `useVisionStore` (`src/components/cockpit/ContextItemDetail.jsx:24-34`) — it does **not** import `useWorkspace`. `useWorkspace()` is available in the tree (used by `App.jsx`, `EnvironmentHealthPanel.jsx`) and exposes `workspace.{id,root}` (`src/contexts/WorkspaceContext.jsx:46,76-78`); `handleProjectSwitch` calls `refreshWorkspace()` on switch (`App.jsx:565-586`) | ContextItemDetail must **add** `import { useWorkspace }` and derive `workspaceId = workspace?.id ?? workspace?.root ?? null` for the probe key. This is a new consumption, not a wiring change to an existing one. |
| 8 | Healthy shape `{enabled:true, available:true, featureCode, results:[…]}`; per-result `project`; cross-project badge compares `result.project !== currentProjectTag` (design Decision 3 + INGEST Decision 6) | Nothing in the healthy envelope carries the **current** project tag the UI needs to compute "differs from current project" | **Refinement:** add a top-level `project: resolveProjectTag(root)` to the healthy envelope. RecallTab renders the project badge when `result.project && result.project !== envelope.project`. This is the concrete wiring of Decision 6's "RECALL's route … call this same function". |
| 9 | "ON, bad/missing featureCode → results:[], invalidFeatureCode:true (no query issued)"; separately "falling back to plain featureCode when [description] absent" | Two clauses could read as conflicting: a code with no `feature.json` is not "bad" | **Pin:** in v1 `invalidFeatureCode` means the query param is **empty/whitespace after trim** (this is also the memoization-probe path, which sends no `featureCode`). A **non-empty** `featureCode` always issues a query — with `description` when `feature.json` is present, else plain `featureCode`. `isFeatureCode`-shape validation is deferred (the UI already gates the tab on a resolvable code); server-side "invalid" == empty. |
| 10 | `DetailTabs` "gains a `tabs` prop (default `DETAIL_TABS`, so all existing call sites are untouched)" | `DetailTabs` maps over the **imported** `DETAIL_TABS` directly (`src/components/cockpit/DetailTabs.jsx:14,36`); `ContextItemDetail` is its **sole** importer (grep confirmed); `DETAIL_TAB_IDS`/`isValidDetailTab` (`contextPanelState.js:76-79`) have no other consumers | Change the map to iterate the new `tabs` prop (default the imported `DETAIL_TABS`). Adding `{id:'recall'}` to `DETAIL_TABS` also extends `DETAIL_TAB_IDS`/`isValidDetailTab` — harmless (recall becomes a "valid" id globally); no other consumer is surprised. ContextItemDetail passes a **filtered** `tabs` list. |

No correction rises to a design contradiction that invalidates a decision. Rows
1, 3, 7, 8, 9 are the load-bearing ones for the implementer.

---

## Decision summary (as pinned for implementation)

### Server route — `GET /api/smartmemory/recall`

New `server/smartmemory-routes.js`, exporting `attachSmartmemoryRoutes(app, deps)`,
modeled byte-for-byte on the qa-scope degrade-never-fail posture.

**Signature & deps (all default-injected for test stubbing):**

```js
export function attachSmartmemoryRoutes(app, {
  getConfig          = getSmartmemoryConfig,      // (cwd) => {} | {enabled,baseUrl,apiKeyEnv,timeoutMs}
  createClient       = defaultCreateClient,       // (cfg) => { search(query, opts) }  [INGEST client]
  readFeature        = defaultReadFeature,        // (cwd, code, featuresDir) => FeatureJson|null
  resolveFeaturesPath= defaultResolveFeaturesPath,// (cwd) => absolute features dir
  resolveProjectTag  = defaultResolveProjectTag,  // (cwd) => canonical project tag
} = {}) { … }
```

- `getSmartmemoryConfig` and `resolveProjectTag` import from `lib/smartmemory-config.js`;
  `defaultCreateClient` constructs INGEST's `lib/smartmemory-client.js` from a config
  object. `defaultReadFeature` from `lib/feature-json.js`; `defaultResolveFeaturesPath`
  from `lib/project-paths.js`.
- **Client is constructed lazily** — only on the ON + non-empty-featureCode + about-to-query
  path. The OFF path and the empty-featureCode path never call `createClient`.

**Handler control flow (each branch returns a shaped 200; never throws to Express):**

1. `root = req.workspace?.root`. If falsy → `res.json({ enabled: false })` (degrade; no config read possible, no client).
2. `cfg = getConfig(root)` (try/catch → `{}`). If `cfg.enabled !== true` → `res.json({ enabled: false })`. **No `createClient`, no fetch, no log** — the OFF byte-identity guarantee.
3. `featureCode = (req.query.featureCode || '').toString().trim()`. If empty → `res.json({ enabled: true, available: true, results: [], invalidFeatureCode: true })`. **No `createClient`, no query** (this is also the memoization-probe response).
4. Read description: `let feature; try { feature = readFeature(root, featureCode, resolveFeaturesPath(root)); } catch { feature = null; }`. `const desc = feature?.description || ''`. `const query = desc ? \`${featureCode} ${desc}\` : featureCode`.
5. Query SmartMemory:
   ```js
   let hits;
   try {
     const client = createClient(cfg);
     hits = await client.search(query, { top_k: 10 });
   } catch (e) {
     return res.json({ enabled: true, available: false, error: shortReason(e) });
   }
   const results = (Array.isArray(hits) ? hits : (hits?.results ?? [])).map(mapHit);
   return res.json({
     enabled: true, available: true, featureCode,
     project: safeProjectTag(resolveProjectTag, root),   // top-level current tag (Correction #8)
     results,
   });
   ```
   `shortReason(e)` = `e?.message?.slice(0, 200) || 'unreachable'`. `safeProjectTag`
   wraps `resolveProjectTag(root)` in try/catch → `null`.

**`mapHit(hit)` adapter** (defensive against the exact SmartMemory hit shape — see
[Contract dependency](#contract-dependency-ingest-clientsearch)):

```js
function mapHit(hit) {
  const content = hit?.content ?? hit?.text ?? '';
  return {
    id:         hit?.id ?? hit?.item_id ?? null,
    snippet:    content.length > 280 ? content.slice(0, 280) + '…' : content,
    score:      hit?.score ?? null,
    memoryType: hit?.memory_type ?? hit?.memoryType ?? null,
    ts:         hit?.context?.event?.ts ?? hit?.context?.ts ?? hit?.ts ?? null,
    project:    hit?.context?.project ?? null,
  };
}
```

**Response envelope contract (all four cases, verbatim):**

| Case | Response body |
|---|---|
| Flag OFF (or no workspace root) | `{ enabled: false }` |
| ON, empty/missing `featureCode` (probe) | `{ enabled: true, available: true, results: [], invalidFeatureCode: true }` |
| ON, healthy | `{ enabled: true, available: true, featureCode, project, results: [{id, snippet, score, memoryType, ts, project}] }` |
| ON, unreachable/timeout/missing-key | `{ enabled: true, available: false, error }` |

**Registration:** `server/vision-server.js:103` area — add `attachSmartmemoryRoutes(app);`
immediately after `attachQaScopeRoutes(app);`, with a one-line comment matching the
sibling style.

### UI — Recall tab in ContextItemDetail, fetch-on-open

- **`contextPanelState.js`:** append `{ id: 'recall', label: 'Recall' }` to `DETAIL_TABS`
  (after `files`). `DETAIL_TAB_IDS`/`isValidDetailTab` extend automatically — acceptable.
  **`test/context-panel-state.test.js` (existing) hard-codes the pre-recall tab set**:
  `DETAIL_TABS.length` equal to 5 (`:102-103`) and `DETAIL_TAB_IDS` deep-equal to
  `['overview', 'pipeline', 'sessions', 'errors', 'files']` (`:106-108`). Both assertions
  go red once `recall` is appended, so this existing suite MUST be updated in the same
  task (T4) alongside the `contextPanelState.js` edit.
- **`DetailTabs.jsx`:** add `recall: Brain` to `ICONS` (import `Brain` from `lucide-react`);
  add a `tabs = DETAIL_TABS` prop; iterate `tabs.map(...)` instead of the imported constant
  (Correction #10). Sole caller passes a filtered list.
- **`useRecallEnabled.js` (new):** module-scoped memoized probe hook, keyed on workspace id.
  - Module state: `const _resolved = new Map();  // key -> boolean`, `const _inflight = new Map();  // key -> Promise<boolean>`.
  - `useRecallEnabled(workspaceId)` → `boolean | null` (`null` = unknown/in-flight).
    On mount / `workspaceId` change: `key = workspaceId ?? '__none__'`. If `_resolved.has(key)` → set state from it, no fetch. Else start (or reuse `_inflight`) a probe:
    `wsFetch('/api/smartmemory/recall').then(r=>r.json()).then(d => d?.enabled === true).catch(() => false)`; cache the promise in `_inflight`, and on settle write `_resolved.set(key, value)` + `_inflight.delete(key)`; guard `setState` with a cancelled flag.
  - Export `__resetRecallEnabledCache()` (clears both maps) — for test isolation only.
  - **Memoization:** the probe (no `featureCode`) fires **at most once per workspace id per page load**. Switching to a workspace with a different id re-probes (different key).
- **`RecallTab.jsx` (new):** fetch-on-open body.
  - `useEffect([featureCode])` with `AbortController`; `setState('loading')`; `wsFetch('/api/smartmemory/recall?featureCode=' + encodeURIComponent(featureCode))` → json →
    if aborted return; if `data.available === false` → `unreachable`; else `results = data.results || []`, keep `currentProject = data.project ?? null`, state `results`. `.catch` (non-abort) → `unreachable`. Return `() => controller.abort()`.
  - **States:**
    - `loading` → skeleton (`data-testid="recall-loading"`)
    - `unreachable` → quiet "SmartMemory unreachable" (`data-testid="recall-unreachable"`)
    - `results` empty → "No prior context" (`data-testid="recall-empty"`)
    - `results` non-empty → list; each row `data-testid="recall-row-<id>"`: snippet, a score bar (`data-testid="recall-score-<id>"`), a memory-type badge (when `memoryType`), relative time (when `ts`), and a project badge (`data-testid="recall-project-<id>"`) **only when** `row.project && row.project !== currentProject` (Correction #8). Reuse the `relativeTime` shape from `ContextFilesTab.jsx:21-28`.
- **`ContextItemDetail.jsx` wiring:**
  - Add `import { useWorkspace } from '../../contexts/WorkspaceContext.jsx';`, `import RecallTab from './RecallTab.jsx';`, `import useRecallEnabled from './useRecallEnabled.js';`, `import { DETAIL_TABS } from './contextPanelState.js';`. The current React import (`ContextItemDetail.jsx:13`) is `import React, { useState, useMemo } from 'react';` — it does **not** include `useEffect`. Extend it to `import React, { useState, useMemo, useEffect } from 'react';`, since the active-tab-reset rule below requires `useEffect`.
  - `const { workspace } = useWorkspace();  const workspaceId = workspace?.id ?? workspace?.root ?? null;`
  - `const recallEnabled = useRecallEnabled(workspaceId);`  `const showRecall = recallEnabled === true && !!featureCode;`
  - `const visibleTabs = useMemo(() => showRecall ? DETAIL_TABS : DETAIL_TABS.filter(t => t.id !== 'recall'), [showRecall]);`
  - **Active-tab reset rule** (Design Decision 2): derive the effective active tab at render so a hidden tab never renders its body for even one frame, and persist the reset into state:
    ```js
    const effectiveTab = visibleTabs.some(t => t.id === activeDetailTab) ? activeDetailTab : 'overview';
    useEffect(() => { if (effectiveTab !== activeDetailTab) setActiveDetailTab('overview'); }, [effectiveTab, activeDetailTab]);
    ```
    Drive both `<DetailTabs activeTab={effectiveTab} tabs={visibleTabs} …/>` and the content branch (`effectiveTab === 'recall' && <RecallTab featureCode={featureCode} />`) off `effectiveTab`.
  - The existing `activeDetailTab` state (`ContextItemDetail.jsx:37`) persists across `itemId` changes (no React key) — the reset rule is what strands-proofs an item switch from a feature (Recall active) to a non-feature item.

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `server/smartmemory-routes.js` | new | `attachSmartmemoryRoutes(app, deps)` — the four-case recall route, degrade-never-fail |
| `server/vision-server.js` | edit | One `attachSmartmemoryRoutes(app);` line after `:103` |
| `src/components/cockpit/contextPanelState.js` | edit | `{ id:'recall', label:'Recall' }` in `DETAIL_TABS` |
| `src/components/cockpit/DetailTabs.jsx` | edit | `recall` icon; new `tabs` prop (default `DETAIL_TABS`); iterate `tabs` |
| `src/components/cockpit/useRecallEnabled.js` | new | Workspace-keyed memoized enabled-probe hook + `__resetRecallEnabledCache` |
| `src/components/cockpit/RecallTab.jsx` | new | Fetch-on-open tab body; loading/results/empty/unreachable states |
| `src/components/cockpit/ContextItemDetail.jsx` | edit | `useWorkspace` probe key; filtered `tabs`; effective-tab reset; `RecallTab` branch |
| `test/smartmemory-recall-route.test.js` | new | Route contract (node:test; mirrors `qa-scope-routes.test.js`) |
| `test/ui/smartmemory-recall.test.jsx` | new | UI (vitest+jsdom; mirrors `open-loops-panel` + `context-step-detail` + `env-health-panel`) |

---

> Note: RECALL's dependency on INGEST's `lib/smartmemory-config.js` /
> `lib/smartmemory-client.js` is a **cross-feature contract**, not a Boundary Map
> edge — those files are produced by a different feature's blueprint and are
> referenced in prose (Contract dependency below), never as a slice here.

## Boundary Map

### S01: server recall route
Produces:
  server/smartmemory-routes.js → attachSmartmemoryRoutes (function)

Consumes: nothing (leaf node)

### S02: enabled-probe hook
Produces:
  src/components/cockpit/useRecallEnabled.js → useRecallEnabled, __resetRecallEnabledCache (function)

Consumes: nothing (leaf node)

### S03: recall tab body
Produces:
  src/components/cockpit/RecallTab.jsx → RecallTab (component)

Consumes: nothing (leaf node)

### S04: detail-panel wiring
Produces:
  src/components/cockpit/contextPanelState.js → DETAIL_TABS (const)
  src/components/cockpit/DetailTabs.jsx → DetailTabs (component)
  src/components/cockpit/ContextItemDetail.jsx → ContextItemDetail (component)

Consumes:
  from S02: src/components/cockpit/useRecallEnabled.js → useRecallEnabled
  from S03: src/components/cockpit/RecallTab.jsx → RecallTab

### S05: route registration
Produces: nothing (integration only)

Consumes:
  from S01: server/smartmemory-routes.js → attachSmartmemoryRoutes




## Contract dependency: INGEST client `search()`

RECALL's route calls `client.search(query, { top_k: 10 })` and maps the returned
hits. The design (Decision 1) and INGEST (Decision 2) pin:

- `search(query, opts)` posts to `POST /memory/search`.
- Each hit carries: content/text, `score`, `memory_type`, and a `context` object
  with `project` and (for event items) `event.ts`.

`mapHit` reads these defensively (multiple field-name fallbacks). **Before
implementing T1's non-stubbed default path, confirm the exact hit field names
against the shipped `lib/smartmemory-client.js` `search()` return** (INGEST). If
INGEST returns `{ results: [...] }` rather than a bare array, the handler already
handles both (`Array.isArray(hits) ? hits : hits?.results ?? []`). The route
tests inject a stub `search`, so they pin RECALL's *expectations*; the integration
step (task #4) reconciles them against INGEST's actual shape.

---

## Test Plan

### Route: `test/smartmemory-recall-route.test.js` (node:test, mirrors `qa-scope-routes.test.js`)

Start a real Express app on an ephemeral port; a tiny middleware injects
`req.workspace`; `attachSmartmemoryRoutes(app, deps)` with all deps stubbed. A
`calls` ledger records `createClient`/`search`/`readFeature` invocations.

- [ ] **OFF → `{enabled:false}`, zero client calls.** `getConfig → {enabled:false}`. `GET ?featureCode=COMP-X` → 200, body deep-equals `{ enabled:false }`; assert `createClient` **never called** and `search` **never called**.
- [ ] **OFF via absent block → `{enabled:false}`.** `getConfig → {}` → same as above.
- [ ] **No workspace root → `{enabled:false}`, no client.** `req.workspace` undefined.
- [ ] **Empty featureCode (probe) → `{enabled:true, available:true, results:[], invalidFeatureCode:true}`, no query.** `getConfig → {enabled:true,…}`; `GET` with no query param; assert `createClient` **not called** and `search` **not called** (no-query-on-invalid-code).
- [ ] **Whitespace featureCode → same as empty.** `?featureCode=%20%20`.
- [ ] **ON healthy → full envelope.** `getConfig → {enabled:true}`; `readFeature → {description:'Desc words'}`; `resolveFeaturesPath → '/abs/features'`; `resolveProjectTag → 'projB'`; `createClient → { search: async (q,o) => { calls.search.push([q,o]); return [{ id:'m1', content:'x'.repeat(400), score:0.9, memory_type:'decision', context:{ event:{ts:'2026-05-02T16:11:11Z'}, project:'projA' } }]; } }`. `GET ?featureCode=COMP-X` → assert body `{ enabled:true, available:true, featureCode:'COMP-X', project:'projB', results:[{ id:'m1', snippet:<=281 chars ending '…', score:0.9, memoryType:'decision', ts:'2026-05-02T16:11:11Z', project:'projA' }] }`; assert `search` called once with `['COMP-X Desc words', { top_k:10 }]`; assert `readFeature` called with `(root, 'COMP-X', '/abs/features')` (Correction #1).
- [ ] **ON, feature absent → query falls back to plain code.** `readFeature → null`. Assert `search` called with `'COMP-X'` (no trailing space), envelope still healthy.
- [ ] **ON, feature present but no description → plain code.** `readFeature → {}`. `search` called with `'COMP-X'`.
- [ ] **ON unreachable → `{enabled:true, available:false, error}`, no 500.** `search` throws `Error('ECONNREFUSED')`. Assert `available:false`, `error` is a non-empty string, status 200.
- [ ] **ON, readFeature throws → degrades to plain-code query, still 200.** `readFeature` throws; handler catches, `desc=''`, queries `'COMP-X'`.
- [ ] **snippet truncation boundary.** `content` length 280 → returned unchanged (no ellipsis); length 281 → truncated to 280 + `…`.

### UI: `test/ui/smartmemory-recall.test.jsx` (vitest+jsdom)

Mirror `env-health-panel.test.jsx` (mock `wsFetch`), `context-step-detail.test.jsx`
(mock `useVisionStore` with selector support), and `open-loops-panel.test.jsx`
(testid conventions). Also mock `useWorkspace`. `wsFetch.mockImplementation` routes
on URL: `'/api/smartmemory/recall'` (exact) → probe; `startsWith('/api/smartmemory/recall?featureCode=')` → per-feature. `beforeEach`: `__resetRecallEnabledCache()`, `wsFetch.mockReset()`.

Seed a feature item into the mocked store: `{ id:'i1', lifecycle:{ featureCode:'COMP-X' } }`; a non-feature item: `{ id:'i2' }` (no featureCode). `useWorkspace → { workspace:{ id:'ws-1' } }`.

- [ ] **Tab hidden when disabled.** probe → `{enabled:false}`. Render `ContextItemDetail itemId='i1'`. `await waitFor` probe fired; assert **no** tab with name "Recall" (`queryByRole('tab',{name:/recall/i})` is null).
- [ ] **Tab hidden for non-feature item even when enabled.** probe → `{enabled:true}`. Render `itemId='i2'`. Assert no Recall tab and **no** per-feature `wsFetch` fired.
- [ ] **Tab shown + loading → results.** probe → `{enabled:true}`; per-feature → `{enabled:true, available:true, project:'projB', results:[{id:'m1', snippet:'prior decision', score:0.8, memoryType:'decision', ts:'2026-05-02T16:11:11Z', project:'projA'}]}`. Render `itemId='i1'`; activate the Recall tab; assert `recall-row-m1` renders with the snippet; assert `recall-score-m1` present; assert `recall-project-m1` present (projA ≠ projB).
- [ ] **Same-project result hides project badge.** result `project:'projB'`, envelope `project:'projB'` → `recall-project-m1` absent.
- [ ] **Empty results.** per-feature → `{enabled:true, available:true, project:'projB', results:[]}` → `recall-empty` present.
- [ ] **Unreachable.** per-feature → `{enabled:true, available:false, error:'down'}` → `recall-unreachable` present; no rows.
- [ ] **Active-tab reset on item switch.** probe → `{enabled:true}`. Render `itemId='i1'`, activate Recall (assert a recall element present). Rerender with `itemId='i2'` (non-feature). Assert the Recall tab is gone AND overview content is showing (effective tab reset to overview; recall body not rendered).
- [ ] **Probe memoization (no second probe).** probe → `{enabled:false}`. Render `itemId='i1'`, `await` probe. Rerender/switch to `itemId='i2'` (same workspace). Assert the count of `wsFetch` calls whose URL is exactly `/api/smartmemory/recall` is **1**.
- [ ] **`DetailTabs` `tabs` prop is honored.** Render `<DetailTabs tabs={[{id:'overview',label:'Overview'}]} />` directly → only the Overview tab renders; no Recall tab (proves the default-`DETAIL_TABS` call sites are unaffected and filtering works).

### Byte-identity when OFF (assert, not just claim)

- [ ] Route test: OFF body is exactly `{enabled:false}` and no client is constructed (covered above).
- [ ] UI test: with probe `{enabled:false}`, the rendered tab list equals today's `DETAIL_TABS` minus recall — i.e. the five existing tabs, unchanged order (assert the tab names).

---

## Implementation order (TDD — test first per task)

Dependencies in brackets. T2 and T3 are independent and parallelizable. T1 is
**not** independent: `server/smartmemory-routes.js` statically imports
`getSmartmemoryConfig` and the client constructor from INGEST's
`lib/smartmemory-config.js` (S01) and `lib/smartmemory-client.js` (S02) as its
default deps (Decision summary above) — the module cannot be implemented or
even loaded until both files exist on disk, regardless of RECALL's own tests
injecting stubs for the `deps` parameter. T4 depends on T2+T3; T5 depends on T1.

1. **T1 — Server route (S01).** [dep: INGEST S01 (`lib/smartmemory-config.js`) + S02 (`lib/smartmemory-client.js`) must exist on disk before this file can be implemented — its default-parameter imports resolve at module-load time; RECALL's own route tests stub the injected `deps`, but that does not remove this on-disk prerequisite.]
   - Write `test/smartmemory-recall-route.test.js` (all route cases above) — RED.
   - Implement `server/smartmemory-routes.js` (`new`) — GREEN. Confirm the INGEST client field names for `mapHit` (Contract dependency) or leave the defensive fallbacks.
2. **T2 — Probe hook (S02).**
   - Write the memoization + invalidation cases (part of `test/ui/smartmemory-recall.test.jsx`, or a focused `it` block) — RED.
   - Implement `src/components/cockpit/useRecallEnabled.js` (`new`) — GREEN.
3. **T3 — Recall tab body (S03).**
   - Write RecallTab state cases (loading/results/empty/unreachable/project-badge) — RED.
   - Implement `src/components/cockpit/RecallTab.jsx` (`new`) — GREEN.
4. **T4 — Detail-panel wiring (S04).** [dep: T2, T3]
   - Write the tab-visibility, active-tab-reset, and `DetailTabs`-`tabs`-prop cases — RED.
   - Edit `contextPanelState.js` (`recall` entry), `DetailTabs.jsx` (`tabs` prop + icon), `ContextItemDetail.jsx` (`useWorkspace`, filtered tabs, effective-tab reset, RecallTab branch) — GREEN. Also edit `test/context-panel-state.test.js` (existing) — update the `DETAIL_TABS.length` (`:102-103`) and `DETAIL_TAB_IDS` (`:106-108`) assertions to include `recall`, in the same task.
5. **T5 — Route registration (S05).** [dep: T1]
   - Edit `server/vision-server.js` — add `attachSmartmemoryRoutes(app);` after `:103`. Covered by the existing route test suite booting the module; a full `npm test` smoke confirms no regression.

**Gate before hand-off:** full `npm test` (route + UI suites) green; stop the local
`:4001` server first if running (a live server reds the server-down-path tests).
