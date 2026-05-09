# COMP-WORKSPACE-HTTP — Blueprint

**Status:** IN_PROGRESS
**Phase:** 4 (blueprint)
**Predecessor:** [design.md](./design.md)
**Audit date:** 2026-05-09

---

## Verification table

Every file:line ref from design.md, verified against current code.

| # | Item | Design claim | Verified | Status |
|---|---|---|---|---|
| V1 | `server/index.js` middleware insertion | line 49 (after `express.json()`) | `express.json()` at line 48 | ✅ design correct; insert middleware at line 49 |
| V2 | `compose-mcp-tools.js` `_bindSession` | line 313 | line 313 | ✅ |
| V3 | `compose-mcp-tools.js` `_postLifecycle` | line 348 | line 348 | ✅ |
| V4 | `compose-mcp-tools.js` `_postGate` | line 375 | line 375 | ✅ |
| V5 | `compose-mcp-tools.js` `toolGetCurrentSession` | line 159 | line 159 | ✅ |
| V6 | `lib/vision-writer.js` `_fetch()` accepts `opts.headers` | yes, spreads on line 129 | confirmed | ✅ |
| V7 | `bin/compose.js` `resolveCwdWithWorkspace` returns string root | line 57 | confirmed | ✅ — needs `{root,id}` shape change |
| V8 | `bin/compose.js` `_resolvedCwdCache` declared at line 52 | yes | confirmed | ✅ |
| V9 | `bin/compose.js` `httpGet` ~lines 2450–2480 | line 2450 | line 2450 | ✅ |
| V10 | `bin/compose.js` `httpPost` ~lines 2450–2480 | line 2464 | line 2464 | ✅ |
| V11 | `bin/compose.js` httpGet/Post caller count | unspecified | **4 sites**: lines 2491, 2510, 2536, 2584. (17+ refers to `resolveCwdWithWorkspace` consumers, not HTTP helpers — different population.) | informational |
| V12 | `server/design-routes.js` direct fetches | unspecified | lines 472, 477 | ✅ identified |
| V13 | `lib/resolve-workspace.js` error classes | 5 classes named in table | all 5 verified at lines 21, 29, 37, 45, 62 | ✅ |
| V14 | `lib/resolve-workspace.js` `resolveWorkspace` synchronous, no `allowFallback` | yes | line 62, sync, confirmed | ✅ |
| V15 | `lib/discover-workspaces.js` `deriveId` exported | yes | line 94, signature `deriveId({ root })` | ✅ — note signature is **`{root}` object**, not bare string |
| V16 | `server/project-root.js` `getTargetRoot` exported | yes | line 46 | ✅ |

**No stale references. One signature note (V15): `deriveId({ root })` takes an object — design code sample needs update.**

## Frontend fetch audit (V17)

48 `fetch()` callsites across `src/`. Categorized:

| Category | Count | Migration |
|---|---|---|
| Same-origin `/api/...` | 41 | mechanical: `fetch(...)` → `wsFetch(...)` |
| Hardcoded `http://localhost:4001/api/...` | 3 (`ChallengeModal.jsx:194,225`, `AgentStream.jsx`-ish) | mechanical with absolute URL preservation |
| Cross-process to agent server `:4002` | 2 (`ChallengeModal.jsx:34`, `AgentStream.jsx:314`) | OUT OF SCOPE — agent server deferred to COMP-WORKSPACE-AGENT-SVR |
| Dynamic URL via `${API}${path}` etc. | 2 (`StratumPanel.jsx:12`, `useVisionStore.js:85`, `useIdeaboxStore.js:20`) | wsFetch wrapper needs to handle absolute + relative |

The 2 agent-server fetches (port 4002) keep raw `fetch` for now — they'll be migrated when COMP-WORKSPACE-AGENT-SVR ships.

WS/EventSource (6 sites) — explicitly out of scope, no changes:
- `useVisionStore.js:103` (`/ws/vision`)
- `useDesignStore.js:239` (`/api/design/stream`)
- `useIdeaboxStore.js:41` (`/ws/vision`)
- `Canvas.jsx:267` (`/ws/files`)
- `PopoutView.jsx:120` (`/ws/files`)
- `AgentStream.jsx:263` (dynamic SSE)

## Corrections to design

| # | Design said | Reality | Resolution |
|---|---|---|---|
| C1 | "around line 49" for middleware insertion | `express.json()` at line 48 (audit said 51 — incorrect; spot-check confirmed 48) | precise: insert at line 49 |
| C2 | `deriveId(root)` (sketch in design SD-2 code) | actual signature is `deriveId({ root })` | update bootstrap impl: `deriveId({ root })` |
| C3 | "most fetch calls already centralized" (design SD-3) | actually 48 sites scattered across 21 files; only `StratumPanel.jsx` uses an `${API}` constant | blueprint: `wsFetch` lives in `src/lib/wsFetch.js`; per-file mechanical migration |
| C4 | implied: `lib/vision-writer.js` callers thread workspaceId already | callers don't currently thread it; need new param OR an instance/closure source | blueprint: `_fetch` reads workspaceId from a constructor-time `this.workspaceId` (instance var); existing callers default to undefined → no header sent → middleware soft-fallback |
| C5 | "agent-hooks deferred" once but listed in goal | settled in pass-5 codex; goal updated | already fixed in design |
| C6 | hardcoded `localhost:4001` in some frontend fetches | they're absolute-url fetches, not relative | wsFetch must accept absolute + relative URLs and inject header in both cases |

## Task plan

Implementation order. Each task lists files, pattern, test.

### T1 — `lib/wsFetch.js` (frontend) + `WorkspaceContext` provider

**New files:**
- `src/lib/wsFetch.js` — wraps `fetch()`, injects `X-Compose-Workspace-Id` header from a module-local var. Accepts both relative (`/api/foo`) and absolute (`http://localhost:4001/api/foo`) URLs.
- `src/contexts/WorkspaceContext.jsx` — React provider. On mount, fetches `GET /api/workspace`, stores `{id, root}` in state, calls `wsFetch.setWorkspaceId(id)`. Provides `useWorkspace()` hook.

**Pattern:**
```js
// wsFetch.js
let _workspaceId = null;
export function setWorkspaceId(id) { _workspaceId = id; }
export async function wsFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (_workspaceId) headers['X-Compose-Workspace-Id'] = _workspaceId;
  return fetch(url, { ...opts, headers });
}
```

**Test:** `src/lib/wsFetch.test.js` — relative URL, absolute URL, no workspace set, workspace set.

### T2 — `server/workspace-routes.js` + `GET /api/workspace`

**New file:** `server/workspace-routes.js`. Uses `getTargetRoot()` + `deriveId({ root })`. NO `resolveWorkspace()` call (per design SD-2 — boot-deterministic).

**Pattern:** `deriveId({ root })` returns an object `{ id, root, configPath }`, not a bare string id. Destructure or use `.id`.

```js
import { getTargetRoot } from './project-root.js';
import { deriveId } from '../lib/discover-workspaces.js';
export function attachWorkspaceRoutes(app) {
  app.get('/api/workspace', (req, res) => {
    const root = getTargetRoot();
    const { id } = deriveId({ root });
    res.json({ id, root, source: 'boot' });
  });
}
```

**Test:** `test/workspace-routes.test.js` — returns boot workspace shape; works in tmpdir; doesn't error in nested workspace setup (the bug from codex pass 4).

### T3 — `server/workspace-middleware.js`

**New file:** middleware exactly as in design SD-1, with `EXEMPT_PATHS = {/api/workspace, /api/project/switch, /api/health}`. v1 soft-fallback for ALL methods.

**Test:** `test/workspace-middleware.test.js` — matrix:
- header present + valid → `req.workspace.id === header`
- header absent + GET → fallback, `X-Compose-Workspace-Fallback: true`
- header absent + POST → in v1 soft fallback (NOT 400 yet, per design)
- header invalid id → 400 `WorkspaceUnknown`
- ambiguous cwd with header that resolves → 200 (header disambiguates)
- exempt path bypasses → `req.workspace.source === 'exempt'`

### T4 — wire middleware + workspace routes into `server/index.js`

**Modify:** `server/index.js`. Insert after line 48 (`express.json()`):
```js
import { createWorkspaceMiddleware } from './workspace-middleware.js';
import { attachWorkspaceRoutes } from './workspace-routes.js';

attachWorkspaceRoutes(app);  // before middleware so /api/workspace is reachable for bootstrap
app.use(createWorkspaceMiddleware());
```

(Order matters: `attachWorkspaceRoutes` mounts a route handler that the middleware would otherwise gate. The exempt-paths set ALSO permits `/api/workspace`, so routing order is belt+suspenders.)

**Test:** existing tests pass; integration test in T9.

### T5 — `_httpRequest` wrapper in `compose-mcp-tools.js`

**Modify:** `server/compose-mcp-tools.js`. Add module-private `_httpRequest(method, path, body)` that:
- reads `_binding.id` (already exists from WORKSPACE-ID T6)
- builds the same `{hostname, port, path, method, headers}` shape as today
- adds `'X-Compose-Workspace-Id': _binding.id` if set
- shrinks the 4 callsites (lines 159, 313, 348, 375) to one-liners

**Test:** `test/compose-mcp-tools-http.test.js` — mock the http module, verify header is injected when binding set, omitted when not.

### T6 — `lib/vision-writer.js` workspaceId plumbing

**Modify:** `lib/vision-writer.js`. Constructor accepts `workspaceId`. `_fetch()` injects header if set. Existing callers don't pass it → no header → soft-fallback (current behavior preserved).

**Test:** `test/vision-writer.test.js` (extend existing) — verify header present when constructed with id, absent otherwise.

### T7 — `bin/compose.js` `{root,id}` plumbing

**Modify:** `bin/compose.js`:
- `resolveCwdWithWorkspace()` (line 57) returns `{ root, id }` instead of bare string. Update `_resolvedCwdCache` accordingly.
- `httpGet`/`httpPost` accept optional `workspaceId` arg, inject header.
- All callers of `resolveCwdWithWorkspace` (currently destructure-as-string) updated to access `.root`.
- All callers of `httpGet`/`httpPost` (**4 sites**: lines 2491, 2510, 2536, 2584) updated to pass the resolved id.

**Cache compat:** keep `_resolvedCwdCache.root` working; add `.id`. No callers should break.

**Test:** existing CLI tests pass; new test pins the shape change.

### T8 — `server/design-routes.js` header injection

**Modify:** `server/design-routes.js` lines 472, 477. Use `req.workspace.id` (set by middleware) when calling out via fetch. Same pattern as the rest.

**Test:** existing design-routes tests pass; one new assertion that header is sent.

### T9 — Frontend fetch migration (T1 dependent)

**Modify:** every `fetch('/api/...')` site listed in V17 → `wsFetch(...)`. 41 same-origin + 3 absolute-localhost = 44 mechanical replacements across 21 files.

**Skip:** 2 agent-server (`:4002`) calls — leave as raw `fetch` with a `// TODO COMP-WORKSPACE-AGENT-SVR` comment.

**Test:** `src/App.test.jsx` (or whatever exists) still passes; new smoke test hits a route through the app.

### T10 — Golden test: 2 workspaces, one server

**New file:** `test/golden/http-middleware-multi-workspace.test.js`. Boots a real Express server (or uses the existing test harness), fires 2 requests with different `X-Compose-Workspace-Id` headers, verifies both `req.workspace.id` values are correctly attached. Asserts that NO downstream behavior diverges (writes still go to boot workspace — known-current). This is the foundation-only verification.

### T11 — Frontend smoke

`npm run dev`, page loads, devtools network panel shows `X-Compose-Workspace-Id` on outgoing requests. Manual verification, documented in report.

## Dependencies between tasks

```
T1 (wsFetch + Context) ──→ T9 (frontend migration)
T2 (workspace route) ──┐
T3 (middleware) ──────→ T4 (wire into index.js) ──→ T10 (golden)
T5 (mcp-tools wrapper)
T6 (vision-writer)
T7 (cli)
T8 (design-routes) ←── needs T3 (req.workspace from middleware)
T11 (smoke) ←── needs T9, T4
```

Parallelizable groups:
- {T1, T2, T3, T5, T6, T7} — independent, can run concurrently
- T4, T8 depend on T3
- T9 depends on T1
- T10 depends on T3+T4
- T11 depends on T4+T9

## Out-of-scope reminders

These will trip up implementer if forgotten:

1. **Do NOT touch the 6 import-time `PROJECT_ROOT` snapshot sites.** They stay. Follow-ups remove them.
2. **Do NOT split VisionStore/SettingsStore/SessionManager/DesignSessionManager** singletons. They stay.
3. **Do NOT touch agent-server (port 4002).** Even the 2 frontend fetches to `:4002` keep raw `fetch`.
4. **Do NOT tag SSE/WebSocket connections** with workspace id. Defer.
5. **Do NOT remove `/api/project/switch`** or refactor it. Stays exempt.

## File touch list (final)

**New:**
- `server/workspace-middleware.js`
- `server/workspace-routes.js`
- `src/lib/wsFetch.js`
- `src/contexts/WorkspaceContext.jsx`
- `test/workspace-middleware.test.js`
- `test/workspace-routes.test.js`
- `test/golden/http-middleware-multi-workspace.test.js`
- `test/compose-mcp-tools-http.test.js`
- `src/lib/wsFetch.test.js`

**Modified:**
- `server/index.js` (insert at 49)
- `server/compose-mcp-tools.js` (4 callsites + new wrapper)
- `lib/vision-writer.js` (constructor + `_fetch`)
- `bin/compose.js` (`resolveCwdWithWorkspace` + ~17 of its consumers; 4 `httpGet`/`httpPost` callsites at 2491, 2510, 2536, 2584)
- `server/design-routes.js` (lines 472, 477)
- `src/App.jsx` (8 fetch sites)
- `src/components/AgentStream.jsx` (2 sites — note 1 is to :4002, skip)
- `src/components/PopoutView.jsx` (1 site)
- `src/components/Canvas.jsx` (3 sites)
- `src/components/StratumPanel.jsx` (1 site)
- `src/components/cockpit/OpsStrip.jsx` (2 sites)
- `src/components/cockpit/ContextStepDetail.jsx` (1 site)
- `src/components/vision/DocsView.jsx` (3 sites)
- `src/components/vision/TemplateSelector.jsx` (2 sites)
- `src/components/vision/ItemDetailPanel.jsx` (2 sites)
- `src/components/vision/EventTimeline.jsx` (1 site)
- `src/components/vision/VisionTracker.jsx` (2 sites)
- `src/components/vision/ChallengeModal.jsx` (3 sites — 1 to :4002, skip)
- `src/components/vision/PipelineView.jsx` (2 sites)
- `src/components/vision/ContextFilesTab.jsx` (1 site)
- `src/components/vision/shared/AgentLogViewer.jsx` (1 site)
- `src/components/vision/useDesignStore.js` (6 fetch sites; 1 EventSource skip)
- `src/components/vision/useVisionStore.js` (5 fetch sites; 1 WS skip)
- `src/components/vision/useIdeaboxStore.js` (1 fetch; 1 WS skip)
- `src/main.jsx` — wrap app in `WorkspaceContext.Provider`

**Estimated:** ~28 files modified, 9 new files, ~700–900 LOC delta (most of it mechanical 1-line replacements in the frontend).

## Phase 5 verification

Before proceeding to Phase 6 plan: re-grep verified line refs. If any drifted by >5 lines from this blueprint, re-verify and update.
