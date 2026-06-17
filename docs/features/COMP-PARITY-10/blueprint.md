# COMP-PARITY-10 — QA Scope Cockpit Panel — Implementation Blueprint

**Status:** Verified blueprint (Phase 4). All file:line refs checked against the working
tree on `main`. Sibling of COMP-PARITY-6 (Validate tab) — every shared-file edit is a
discrete additive insertion designed to coexist with PARITY-6's parallel additions.

Constraints: read-only; wrap the existing qa-scope mapper (no reimplementation); mirror
`server/health-routes.js` + `src/components/cockpit/EnvironmentHealthPanel.jsx`; new panel
in its own file; App.jsx / ViewTabs.jsx / viewTabsState.js / vision-server.js get only
minimal additive lines.

---

## Verified facts (file:line)

| Fact | Location | Verified |
|------|----------|----------|
| `qa-scope` CLI verb | `bin/compose.js:2694` | ✓ |
| CLI pipeline: `readFeature(qsCwd, qsCode)` → `mapFilesToRoutes(filesChanged, { cwd: qsCwd })` → `classifyRoutes(result.affectedRoutes, [])` | `bin/compose.js:2707-2724` | ✓ |
| `allKnown = []` (v1: no known-routes registry) | `bin/compose.js:2723` | ✓ |
| Empty-diff guidance text | `bin/compose.js:2716-2719` | ✓ |
| `mapFilesToRoutes` returns `{ affectedRoutes, unmappedFiles, framework, docsOnly }` | `lib/qa-scoping.js:279-349` | ✓ |
| `classifyRoutes` returns `{ affected, adjacent }` | `lib/qa-scoping.js:365-397` | ✓ |
| `readFeature(cwd, code)` reads `docs/features/<code>/feature.json`, returns `FeatureJson \| null` | `lib/feature-json.js:47-55` | ✓ |
| `feature.filesChanged ?? []` access | `bin/compose.js:2715` | ✓ |
| read-only endpoint pattern `attachHealthRoutes(app, { …injectable })`, no auth on GET | `server/health-routes.js:150-205` | ✓ |
| `safe(fn, fallback)` degrade helper | `server/health-routes.js:49-55` | ✓ |
| `req.workspace.root` is the per-request workspace root (CLI-equivalent cwd) | `server/health-routes.js:189`, `server/workspace-middleware.js:47,56,67` | ✓ |
| vision-server import block | `server/vision-server.js:12-37` (health import at :30) | ✓ |
| vision-server attach block; `attachHealthRoutes(app)` call | `server/vision-server.js:89-92` | ✓ |
| Panel fetch/loading/error idiom (monotonic `reqIdRef`, `wsFetch`, degrade-never-throw) | `src/components/cockpit/EnvironmentHealthPanel.jsx:99-130` | ✓ |
| `wsFetch` import path | `src/lib/wsFetch.js` | ✓ |
| `TAB_META` map (add view key here) | `src/components/cockpit/ViewTabs.jsx:17-29` | ✓ |
| lucide-react icon import line | `src/components/cockpit/ViewTabs.jsx:15` | ✓ |
| `DEFAULT_MAIN_TABS` array | `src/components/cockpit/viewTabsState.js:17-19` | ✓ |
| App.jsx vision-view import block | `src/App.jsx:49-60` | ✓ |
| `CockpitView` switch on `activeView` | `src/App.jsx:247` (cases run 248-381) | ✓ |
| `CockpitView` receives `featureCode` prop | `src/App.jsx:239`, passed at `src/App.jsx:1303` (`featureCode={activeFeatureCode}`) | ✓ |
| `activeFeatureCode = sessionState?.featureCode \|\| null` | `src/App.jsx:457` | ✓ |
| `<ViewTabs tabs={mainTabs} …>` render | `src/App.jsx:1094-1100` | ✓ |
| Server pure-helper unit test pattern | `test/health-routes.test.js` | ✓ |
| Server real-Express integration test pattern | `test/integration/health-routes.test.js` | ✓ |
| UI panel test pattern (vitest, mock wsFetch + WorkspaceContext) | `test/ui/env-health-panel.test.jsx` | ✓ |

---

## New files

### 1. `server/qa-scope-routes.js` (new)

Read-only REST route. Mirrors `attachHealthRoutes` structure: module-level deps with
injectable overrides, a `safe()` degrade helper, no auth gate on the GET (mirrors
`GET /api/environment-health`).

```js
/**
 * qa-scope-routes.js — Read-only QA-scope REST API (COMP-PARITY-10).
 *
 * Route:
 *   GET /api/qa-scope?featureCode=<CODE> — surfaces `compose qa-scope <CODE>`
 *     (diff-to-route mapping from COMP-QA) as structured JSON for the cockpit's
 *     QA Scope view. Maps the feature's recorded filesChanged → affected /
 *     adjacent routes via lib/qa-scoping.js. Read-only, no side effects.
 *
 * Not auth-gated (mirrors GET /api/environment-health): it reads only
 * feature.json + heuristic route mapping, no host paths leaked, no mutation.
 *
 * Degrade-never-fail: a bad feature code or unreadable feature.json returns a
 * structured { found:false } / empty result, never a 500.
 *
 * Reuses (no logic fork):
 *   - lib/feature-json.js  — readFeature(cwd, code)
 *   - lib/qa-scoping.js    — mapFilesToRoutes(filesChanged,{cwd}), classifyRoutes(routes,[])
 */
import { readFeature as defaultReadFeature } from '../lib/feature-json.js';
import {
  mapFilesToRoutes as defaultMapFilesToRoutes,
  classifyRoutes as defaultClassifyRoutes,
} from '../lib/qa-scoping.js';

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {Function} [deps.readFeature]      — (cwd, code) => FeatureJson|null
 * @param {Function} [deps.mapFilesToRoutes] — (filesChanged, {cwd}) => {affectedRoutes,unmappedFiles,framework,docsOnly}
 * @param {Function} [deps.classifyRoutes]   — (routes, allKnown) => {affected,adjacent}
 */
export function attachQaScopeRoutes(app, {
  readFeature = defaultReadFeature,
  mapFilesToRoutes = defaultMapFilesToRoutes,
  classifyRoutes = defaultClassifyRoutes,
} = {}) {
  app.get('/api/qa-scope', (req, res) => {
    const featureCode = (req.query.featureCode || '').toString().trim();
    if (!featureCode) {
      return res.json({ found: false, error: 'featureCode required' });
    }

    const root = req.workspace?.root;
    if (!root) {
      return res.json({ found: false, error: 'no workspace root', featureCode });
    }

    let feature;
    try {
      feature = readFeature(root, featureCode);
    } catch {
      feature = null;
    }
    if (!feature) {
      return res.json({ found: false, featureCode });
    }

    const filesChanged = feature.filesChanged ?? [];
    if (filesChanged.length === 0) {
      // Mirror the CLI's empty-diff guidance (bin/compose.js:2716-2719).
      return res.json({
        found: true,
        featureCode,
        filesChanged: [],
        framework: 'unknown',
        docsOnly: false,
        affected: [],
        adjacent: [],
        unmappedFiles: [],
        emptyDiff: true,
      });
    }

    // Same pipeline as the CLI (bin/compose.js:2722-2724); allKnown=[] (v1: no registry).
    let result, classified;
    try {
      result = mapFilesToRoutes(filesChanged, { cwd: root });
      classified = classifyRoutes(result.affectedRoutes, []);
    } catch (e) {
      return res.json({ found: true, featureCode, error: e?.message || 'qa-scope failed' });
    }

    res.json({
      found: true,
      featureCode,
      filesChanged,
      framework: result.framework,
      docsOnly: result.docsOnly,
      affected: classified.affected,
      adjacent: classified.adjacent,
      unmappedFiles: result.unmappedFiles,
      emptyDiff: false,
    });
  });
}
```

**Response contract** (matches the CLI's printed fields):

| Field | Type | Source |
|-------|------|--------|
| `found` | boolean | `false` when code unknown / no workspace / missing featureCode |
| `featureCode` | string | echo of the query |
| `filesChanged` | string[] | `feature.filesChanged ?? []` |
| `framework` | string | `result.framework` (`nextjs`/`express`/`react-router`/`spa`/`explicit`/`unknown`) |
| `docsOnly` | boolean | `result.docsOnly` |
| `affected` | string[] | `classifyRoutes(...).affected` |
| `adjacent` | string[] | `classifyRoutes(...).adjacent` |
| `unmappedFiles` | string[] | `result.unmappedFiles` |
| `emptyDiff` | boolean | true when `filesChanged` is empty (drives the CLI-style guidance message) |

### 2. `src/components/vision/QaScopeView.jsx` (new)

Main-area view. Reads the active `featureCode` prop (threaded by `CockpitView`), fetches
`/api/qa-scope?featureCode=…` via `wsFetch`, and renders affected / adjacent / unmapped
lists. Mirrors EnvironmentHealthPanel's monotonic-request-token fetch + degrade-never-throw
(`src/components/cockpit/EnvironmentHealthPanel.jsx:99-130`).

```jsx
/**
 * QaScopeView — QA Scope cockpit view (COMP-PARITY-10).
 *
 * Surfaces `compose qa-scope <CODE>` (COMP-QA diff-to-route mapping) for the
 * active feature: changed files → affected / adjacent routes + unmapped files.
 * Backed by GET /api/qa-scope?featureCode=…; read-only, degrades, never throws.
 *
 * Props:
 *   featureCode {string|null}  the active feature code (from CockpitView)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

function RouteList({ testid, label, routes, empty }) {
  return (
    <div className="mt-3 first:mt-0" data-testid={testid}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {label} ({routes.length})
      </div>
      {routes.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic">{empty}</div>
      ) : (
        <ul className="text-[12px] font-mono space-y-0.5">
          {routes.map(r => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function QaScopeView({ featureCode }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqIdRef = useRef(0);

  const fetchScope = useCallback(async () => {
    if (!featureCode) return;
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const r = await wsFetch(`/api/qa-scope?featureCode=${encodeURIComponent(featureCode)}`);
      const json = await r.json();
      if (myId !== reqIdRef.current) return;
      setData(json);
      setError(null);
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      setData(null);
      setError(e?.message || 'unavailable');
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, [featureCode]);

  useEffect(() => { fetchScope(); }, [fetchScope]);

  if (!featureCode) {
    return (
      <div data-testid="qa-scope-empty" className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground italic">
        Select a feature to see its QA scope.
      </div>
    );
  }

  return (
    <div data-testid="qa-scope-view" className="flex-1 overflow-auto p-4 text-foreground">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">QA Scope · <span className="font-mono">{featureCode}</span></h2>
        <button
          data-testid="qa-scope-refresh"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          onClick={fetchScope}
          disabled={loading}
          title="Refresh"
        >↻</button>
      </div>

      {error && <div data-testid="qa-scope-error" className="text-destructive text-[12px]">Unavailable: {error}</div>}
      {!data && !error && (
        <div className="text-muted-foreground text-[12px]">{loading ? 'Analyzing…' : 'No data'}</div>
      )}

      {data && data.found === false && (
        <div data-testid="qa-scope-not-found" className="text-muted-foreground text-[12px]">
          No feature found for <span className="font-mono">{featureCode}</span>.
        </div>
      )}

      {data && data.found && data.emptyDiff && (
        <div data-testid="qa-scope-empty-diff" className="text-muted-foreground text-[12px]">
          No filesChanged recorded for {featureCode}. Run a build first so the pipeline tracks touched files.
        </div>
      )}

      {data && data.found && !data.emptyDiff && (
        <>
          <div className="text-[11px] text-muted-foreground mb-2">
            Framework: <span className="font-mono">{data.framework}</span>
            {data.docsOnly ? ' · docs-only' : ''}
          </div>
          <RouteList testid="qa-scope-affected" label="Affected routes" routes={data.affected || []} empty="(none — no code files mapped to known routes)" />
          <RouteList testid="qa-scope-adjacent" label="Adjacent routes" routes={data.adjacent || []} empty="(none)" />
          <RouteList testid="qa-scope-unmapped" label="Unmapped files" routes={data.unmappedFiles || []} empty="(none)" />
        </>
      )}
    </div>
  );
}
```

### 3. `test/qa-scope-routes.test.js` (new) — server, node --test

Mirrors `test/integration/health-routes.test.js` (real Express app on ephemeral port,
injected `req.workspace`, **injected mapper deps** so no disk fixtures needed). Golden +
error cases:

- [ ] Golden: known featureCode with `filesChanged` → `found:true`, returns `affected` +
      `adjacent` + `unmappedFiles` + `framework` (assert injected mapper output flows through).
- [ ] Injected `readFeature` stub returns a feature → no disk dependency.
- [ ] Unknown featureCode (`readFeature` stub → null) → `{ found:false, featureCode }`, status 200.
- [ ] Empty `filesChanged` → `{ found:true, emptyDiff:true, affected:[], … }`, status 200,
      mapper NOT called.
- [ ] Missing `featureCode` query param → `{ found:false, error:'featureCode required' }`.
- [ ] No `req.workspace` → `{ found:false, error:'no workspace root' }`, status 200 (no 500).
- [ ] `mapFilesToRoutes` throws (injected) → `{ found:true, featureCode, error:… }`, no 500.

### 4. `test/ui/qa-scope-view.test.jsx` (new) — UI, vitest

Mirrors `test/ui/env-health-panel.test.jsx` (mock `wsFetch`, render component):

- [ ] No `featureCode` → renders `qa-scope-empty` placeholder, no fetch.
- [ ] With `featureCode` → fetches `/api/qa-scope?featureCode=<CODE>`; renders affected /
      adjacent / unmapped lists from the mocked response.
- [ ] `found:false` response → renders `qa-scope-not-found`.
- [ ] `emptyDiff:true` response → renders `qa-scope-empty-diff` guidance.
- [ ] `↻` refresh re-issues the fetch.
- [ ] wsFetch rejects → renders `qa-scope-error`, never throws.

---

## Shared-File Integration

Each edit is a discrete anchored insertion. PARITY-6 adds a `validate` tab in the same four
files; phrase every addition as a sibling so both apply cleanly without conflicting hunks.

### `server/vision-server.js`

**Import** — append after the health-routes import (anchor: `server/vision-server.js:30`):

```js
import { attachHealthRoutes } from './health-routes.js';
import { attachQaScopeRoutes } from './qa-scope-routes.js';   // + COMP-PARITY-10
```

**Attach** — add immediately after the `attachHealthRoutes(app)` call (anchor:
`server/vision-server.js:92`):

```js
    attachHealthRoutes(app);

    // ── QA-scope route (COMP-PARITY-10) ───────────────────────────────────
    // Read-only GET /api/qa-scope?featureCode=…; wraps lib/qa-scoping mapper,
    // reads filesChanged off the feature on req.workspace.root.
    attachQaScopeRoutes(app);
```

### `src/components/cockpit/ViewTabs.jsx`

**Icon import** — add `FileSearch` to the lucide-react import (anchor: `ViewTabs.jsx:15`):

```js
import { Network, GitBranch, Activity, ShieldCheck, Search, FileText, Workflow, MessageSquare, LayoutDashboard, Lightbulb, History, BookOpen, FileSearch } from 'lucide-react';
```

**TAB_META entry** — add one line to `TAB_META` (sibling to PARITY-6's `validate` entry;
anchor: after the `ideabox` line, `ViewTabs.jsx:28`):

```js
  ideabox:   { label: 'Ideabox',   icon: Lightbulb,       tip: 'Captured ideas and suggestions' },
  'qa-scope': { label: 'QA Scope', icon: FileSearch,      tip: 'Affected routes for the active feature (qa-scope)' },
```

### `src/components/cockpit/viewTabsState.js`

**DEFAULT_MAIN_TABS** — append the key (sibling to PARITY-6's `'validate'`; anchor:
`viewTabsState.js:17-19`):

```js
export const DEFAULT_MAIN_TABS = [
  'dashboard', 'graph', 'tree', 'docs', 'journal', 'design', 'gates', 'pipeline', 'sessions', 'build-history', 'ideabox', 'qa-scope'
];
```

> Note: `loadMainTabs` (viewTabsState.js:99-111) already migrates new `DEFAULT_MAIN_TABS`
> keys into a persisted older tab list, so existing users pick up the tab automatically. No
> migration code needed.

### `src/App.jsx`

**Import** — add the view import among the other vision-view imports (anchor: after the
`IdeaboxView` import, `src/App.jsx:60`):

```js
import IdeaboxView from './components/vision/IdeaboxView.jsx';
import QaScopeView from './components/vision/QaScopeView.jsx';   // COMP-PARITY-10
```

**CockpitView switch case** — add a case in the `activeView` switch (sibling to PARITY-6's
`validate` case; anchor: after the `ideabox` case, `src/App.jsx:361-362`):

```jsx
    case 'ideabox':
      return <IdeaboxView />;
    case 'qa-scope':
      return <QaScopeView featureCode={featureCode} />;
```

> `featureCode` is already a `CockpitView` parameter (`src/App.jsx:239`) wired from
> `activeFeatureCode` at the render site (`src/App.jsx:1303`). No new prop plumbing needed.

No edit to the `<ViewTabs …>` render call (`src/App.jsx:1094`) — it already maps over
`mainTabs`, which now includes `qa-scope` via `DEFAULT_MAIN_TABS`.

---

## Tests planned (summary)

| File | Runner | Coverage |
|------|--------|----------|
| `test/qa-scope-routes.test.js` | node --test | golden (filesChanged → routes via injected mapper), unknown code, empty diff, missing param, no workspace, mapper-throws degrade |
| `test/ui/qa-scope-view.test.jsx` | vitest | empty (no featureCode), populated lists, not-found, empty-diff, refresh, fetch-error degrade |

Both mirror the COMP-PARITY-3 precedents (`test/integration/health-routes.test.js`,
`test/ui/env-health-panel.test.jsx`). Server test uses injected mapper deps (no disk
fixtures); UI test mocks `wsFetch`.

---

## Why this is the smallest correct change

- **No logic fork:** the endpoint calls the same three functions the CLI calls, in the same
  order, with the same `allKnown = []`.
- **Read-only, no auth gate:** identical posture to `GET /api/environment-health`.
- **Additive only:** four shared files get one anchored insertion each, every one a sibling
  of PARITY-6's parallel `validate` addition — no overlapping hunks.
- **Reuses the active-feature plumbing** already in `CockpitView` — no new prop wiring.
