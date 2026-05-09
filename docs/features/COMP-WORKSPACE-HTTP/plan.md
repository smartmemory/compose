# COMP-WORKSPACE-HTTP — Plan

**Status:** IN_PROGRESS
**Phase:** 6 (plan)
**Predecessor:** [blueprint.md](./blueprint.md)

---

## Strategy

11 tasks. Tasks T1, T2, T3, T5, T6, T7 are **independent** — can run in parallel via `superpowers:dispatching-parallel-agents`. T4, T8, T9, T10, T11 have dependencies (see blueprint dependency graph) and must follow.

Phase 7 execution skill: **mixed**.
- Group A (parallelizable foundation, T1-T3, T5-T7): dispatch via `superpowers:dispatching-parallel-agents`.
- Group B (sequential dependent, T4, T8, T9, T10, T11): `superpowers:executing-plans`.

TDD per task: write test first, watch fail, implement, watch pass.

---

## Group A — parallelizable foundation

### T1: `src/lib/wsFetch.js` + `src/contexts/WorkspaceContext.jsx`

**Files (new):**
- `src/lib/wsFetch.js`
- `src/lib/wsFetch.test.js`
- `src/contexts/WorkspaceContext.jsx`

**Acceptance:**
- [ ] `wsFetch(url, opts)` works for relative (`/api/foo`) and absolute (`http://localhost:4001/api/foo`) URLs
- [ ] `setWorkspaceId(id)` / `getWorkspaceId()` exported
- [ ] Header `X-Compose-Workspace-Id` injected when id is set; absent when null
- [ ] Existing `opts.headers` not clobbered (spread)
- [ ] `WorkspaceContext.jsx` exports `WorkspaceProvider`, `useWorkspace()` hook
- [ ] On mount, provider fetches `GET /api/workspace`, stores `{id, root}`, calls `setWorkspaceId(id)`
- [ ] Loading + error states surfaced via the hook

**Pattern (wsFetch):** see blueprint T1 code sample.

**Pattern (Context):**
```jsx
export function WorkspaceProvider({ children }) {
  const [state, setState] = useState({ loading: true, error: null, workspace: null });
  useEffect(() => {
    fetch('/api/workspace')
      .then(r => r.json())
      .then(ws => { setWorkspaceId(ws.id); setState({ loading: false, error: null, workspace: ws }); })
      .catch(err => setState({ loading: false, error: err, workspace: null }));
  }, []);
  return <WorkspaceContext.Provider value={state}>{children}</WorkspaceContext.Provider>;
}
```

**Test:** unit tests for wsFetch shape (4 cases). No test for the context yet — exercised via T9 frontend smoke + T11.

---

### T2: `server/workspace-routes.js` + `GET /api/workspace`

**Files (new):**
- `server/workspace-routes.js`
- `test/workspace-routes.test.js`

**Acceptance:**
- [ ] `attachWorkspaceRoutes(app)` exported
- [ ] `GET /api/workspace` returns `{id, root, source: 'boot'}`
- [ ] Uses `getTargetRoot()` + `deriveId({ root })` (destructured `.id`)
- [ ] Does NOT call `resolveWorkspace()` (no descendant discovery)
- [ ] Test: returns expected shape in tmpdir
- [ ] Test: works in nested-workspace setup (parent root with child `.compose/` underneath) — does NOT 409

**Pattern:** see blueprint T2 code sample (corrected for `deriveId({ root }).id`).

---

### T3: `server/workspace-middleware.js`

**Files (new):**
- `server/workspace-middleware.js`
- `test/workspace-middleware.test.js`

**Acceptance:**
- [ ] `createWorkspaceMiddleware({ allowGetFallback })` factory exported
- [ ] `EXEMPT_PATHS = {/api/workspace, /api/project/switch, /api/health}`
- [ ] Exempt paths bypass with `req.workspace = {id: null, root: getTargetRoot(), source: 'exempt'}`
- [ ] Header present + valid → `req.workspace = resolveWorkspace({workspaceId, cwd})` result
- [ ] Header absent + soft-fallback enabled → `req.workspace = {id: null, root, source: 'fallback'}` and `X-Compose-Workspace-Fallback: true` header
- [ ] Resolver errors mapped: `WorkspaceUnknown` → 400, `WorkspaceAmbiguous` → 409 with candidates, `WorkspaceIdCollision` → 409 with roots, `WorkspaceDiscoveryTooBroad` → 400
- [ ] `mapResolverErrorToResponse(err, res)` helper exported separately for reuse

**Test matrix (table-driven):**
| header | method | exempt? | expected |
|---|---|---|---|
| valid id | GET | no | 200, req.workspace.id matches |
| valid id | POST | no | 200, req.workspace.id matches |
| absent | GET | no | 200, fallback header set |
| absent | POST | no | 200, fallback (v1 soft fallback) |
| invalid id | any | no | 400 WorkspaceUnknown |
| valid id | any | yes (exempt) | 200, source=exempt |

---

### T5: `_httpRequest` wrapper in `compose-mcp-tools.js`

**Files (modify):**
- `server/compose-mcp-tools.js` — add `_httpRequest`, refactor 4 callsites
- `test/compose-mcp-tools-http.test.js` (new)

**Acceptance:**
- [ ] `_httpRequest(method, path, body)` returns Promise<{status, body}>
- [ ] Reads `_binding.id` (from existing module-local state, see WORKSPACE-ID T6)
- [ ] Injects `X-Compose-Workspace-Id` header when `_binding.id` is set
- [ ] No header when binding is null
- [ ] 4 callsites refactored: `toolGetCurrentSession` (159), `_bindSession` (313), `_postLifecycle` (348), `_postGate` (375)
- [ ] All existing behavior preserved (same hostname/port/method/body logic)

**Pattern:**
```js
async function _httpRequest(method, urlPath, body = null) {
  const port = process.env.COMPOSE_PORT || process.env.PORT || 3001;
  const headers = { 'Content-Type': 'application/json' };
  if (_binding?.id) headers['X-Compose-Workspace-Id'] = _binding.id;
  const opts = { hostname: '127.0.0.1', port, path: urlPath, method, headers };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => { /* collect body, resolve with {status, body} */ });
    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}
```

**Test:** mock http module, verify header present/absent based on binding state.

---

### T6: `lib/vision-writer.js` workspaceId plumbing

**Files (modify):**
- `lib/vision-writer.js` — constructor + `_fetch`
- `test/vision-writer.test.js` (extend)

**Acceptance:**
- [ ] Constructor accepts `{workspaceId}` (optional)
- [ ] `_fetch(urlPath, opts)` injects `X-Compose-Workspace-Id` from `this.workspaceId` when set
- [ ] Backward compat: existing callers without workspaceId still work (no header sent → middleware soft-fallback)
- [ ] Test: header present when constructed with id, absent otherwise

**Note:** No caller migration in this ticket — they're behavior-preserving as-is. Future tickets that need workspace-correct vision writes will pass `workspaceId` at construction.

---

### T7: `bin/compose.js` `{root, id}` plumbing

**Files (modify):**
- `bin/compose.js` — `resolveCwdWithWorkspace`, `_resolvedCwdCache`, `httpGet`, `httpPost`, callers
- `test/cli-resolve-workspace.test.js` (extend)

**Acceptance:**
- [ ] `resolveCwdWithWorkspace(args)` returns `{ root, id }` (was: bare string)
- [ ] `_resolvedCwdCache` stores `{ root, id }` shape
- [ ] All ~17 consumers of `resolveCwdWithWorkspace` updated to access `.root` (was: bare value)
- [ ] `httpGet(url, workspaceId?)` and `httpPost(url, body, workspaceId?)` accept optional id
- [ ] Header injected when id provided
- [ ] 4 callsites at 2491, 2510, 2536, 2584 pass `cache.id` from resolver result
- [ ] Existing CLI tests pass without modification beyond shape updates
- [ ] New test: shape change asserted for resolveCwdWithWorkspace

**Audit step:** before editing, grep for current consumers of `resolveCwdWithWorkspace` and verify each. Subagent or manual.

---

## Group B — sequential dependent

### T4: wire middleware + workspace routes into `server/index.js` (depends on T2, T3)

**Files (modify):**
- `server/index.js`

**Acceptance:**
- [ ] Imports added at top of file
- [ ] After `app.use(express.json())` (line 48), insert: `attachWorkspaceRoutes(app); app.use(createWorkspaceMiddleware());`
- [ ] Order: workspace route mounted BEFORE middleware (so bootstrap is reachable)
- [ ] All existing route handlers untouched
- [ ] Existing 2547 tests pass

**Pattern:**
```js
import { createWorkspaceMiddleware } from './workspace-middleware.js';
import { attachWorkspaceRoutes } from './workspace-routes.js';
// ... existing imports ...

app.use(cors(...));
app.use(express.json());

attachWorkspaceRoutes(app);
app.use(createWorkspaceMiddleware());

// ... existing routes ...
```

**Test:** existing test suite is the integration test. T10 adds the multi-workspace golden.

---

### T8: `server/design-routes.js` header injection (depends on T3)

**Files (modify):**
- `server/design-routes.js` — lines 472, 477

**Acceptance:**
- [ ] Both fetch sites inject `X-Compose-Workspace-Id: req.workspace.id` when set
- [ ] No-op when middleware sets fallback (id is null) — no header sent → soft-fallback chain
- [ ] Existing design-routes tests pass
- [ ] New test asserts header injection (mock fetch)

---

### T9: Frontend fetch migration (depends on T1)

**Files (modify):** 19 files per blueprint (App.jsx + 17 components + main.jsx).

**Strategy:** mechanical replacement, file-by-file. For each:
1. Add import: `import { wsFetch } from '../lib/wsFetch'` (path varies)
2. Replace `fetch(` → `wsFetch(` for in-scope sites
3. Skip `:4002` agent-server fetches (mark with `// TODO COMP-WORKSPACE-AGENT-SVR`)
4. Skip WS/EventSource sites entirely (out of scope)

**Subagent strategy:** dispatch 4-5 parallel `general-purpose` agents, each owning a slice of files. Each runs the mechanical replacement + verifies.

**Acceptance:**
- [ ] All 44 in-scope sites use `wsFetch`
- [ ] 2 agent-server (`:4002`) sites unchanged with TODO comment
- [ ] 6 WS/EventSource sites unchanged
- [ ] `main.jsx` wraps app in `<WorkspaceProvider>`
- [ ] App still loads (smoke verification in T11)
- [ ] Frontend test suite passes

---

### T10: Golden multi-workspace test (depends on T4)

**Files (new):**
- `test/golden/http-middleware-multi-workspace.test.js`

**Acceptance:**
- [ ] Boots the Express server (using existing test harness pattern from `test/golden/`)
- [ ] Two HTTP requests with different `X-Compose-Workspace-Id` headers
- [ ] Asserts each request's `req.workspace.id` matches the header
- [ ] Asserts `X-Compose-Workspace-Fallback` header on no-header request
- [ ] Asserts `WorkspaceUnknown` 400 on bogus id
- [ ] Asserts existing route still works (e.g. `GET /api/health`) under all scenarios

**Audit step:** before writing, look at existing `test/golden/*.test.js` patterns to match the harness style.

---

### T11: Frontend smoke (depends on T4, T9)

**Manual / scripted:**
- [ ] `npm run dev` boots three services
- [ ] Open `http://localhost:5195`
- [ ] Open devtools network panel
- [ ] Verify all `/api/*` requests carry `X-Compose-Workspace-Id` header
- [ ] Verify `GET /api/workspace` is the first request, returns boot workspace
- [ ] Verify no console errors

**Documented in:** Phase 8 report (or Phase 7 task notes if Phase 8 skipped).

---

## Verification at exit (Phase 7 step 1 done)

Before E2E + review + sweep:
- [ ] All 11 tasks acceptance boxes ticked
- [ ] `find test -maxdepth 1 -name "*.test.js" -exec node --test {} +` passes
- [ ] `grep -n "PROJECT_ROOT = getTargetRoot" server/*.js` returns the same 6 lines as before (NOT empty — that's a future ticket)
- [ ] Frontend builds: `npm run build`

## Phase 7 step 2 — E2E smoke test

`npm run dev`, perform a vision-tracker workflow end-to-end (e.g. open dashboard, view a feature, scaffold a session), verify no regressions.

## Phase 7 step 3 — Review loop

Codex review on the implementation. Use canonical `ReviewResult` schema. Loop until REVIEW CLEAN, max 5 iterations.

## Phase 7 step 4 — Coverage sweep

Run coverage tool (or just inspect new files), add tests for any uncovered edge case in the new modules. Loop until TESTS PASSING, max 15 iterations.

---

## Risks during implementation

- **`_resolvedCwdCache` shape change in T7 breaks consumers silently.** Mitigation: TypeScript-style audit in PR — list every consumer before editing, run CLI test suite after.
- **Frontend mass-replace introduces typos.** Mitigation: per-file diffs reviewed, smoke test in T11.
- **Middleware breaks an unexpected existing route.** Mitigation: full test suite after T4 before any other Group-B task.
- **`_binding.id` is null for unbound stdio MCP sessions.** Mitigation: `_httpRequest` correctly omits header when null — that's the soft-fallback path. Tested in T5.

## Rollback plan

If Phase 7 catches a regression that can't be fixed in the iteration window:
- Revert `server/index.js` middleware mount (1 line) — middleware exists but inert
- All T1-T11 artifacts can stay merged as no-ops
- File a follow-up ticket with the regression repro
