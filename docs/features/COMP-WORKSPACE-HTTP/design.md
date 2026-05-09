# COMP-WORKSPACE-HTTP — HTTP workspace foundation (middleware + bootstrap)

**Status:** IN_PROGRESS
**Created:** 2026-05-09
**Updated:** 2026-05-09
**Predecessor:** COMP-WORKSPACE-ID (stdio MCP + CLI + hooks)
**Track:** Foundation for COMP-WORKSPACE-{VISION, SESSIONS, AGENT-SVR, FILES}

---

## Why this is narrowed

The original framing — "fix the 6 import-time `PROJECT_ROOT` snapshots in the HTTP server" — turned out to be incomplete. Three Codex review passes surfaced:

1. **Boot-time singletons hold workspace-scoped state**: `VisionStore`, `SettingsStore`, `SessionManager`, `DesignSessionManager`. Threading `req.workspace` through routes without per-workspace stores is theatre — the writes still hit the boot workspace.
2. **The agent server is a SEPARATE Express process on port 4002**, not a route behind the API server's middleware. Workspace must cross processes.
3. **`file-watcher.js` serves HTTP routes too** (`/api/file`, `/api/files`, `/api/canvas/open`), not just fs.watch.
4. **`/api/project/switch` mutates global state** via `switchProject()` and is incompatible with concurrent multi-workspace.

Per `feedback_codex_review_convergence.md` (3 iterations, scope still growing → spec is too broad), the work was split into a 5-ticket track. **This ticket is the foundation: middleware + bootstrap. Zero behavior change to existing routes.** Subsequent tickets (`COMP-WORKSPACE-VISION`, `-SESSIONS`, `-AGENT-SVR`, `-FILES`) build on top.

## Problem (this ticket)

The HTTP server has no per-request channel for workspace identity today. Before any of the four follow-up tickets can land, the server needs:
- A middleware that reads `X-Compose-Workspace-Id`, resolves the workspace, and attaches it to `req`.
- A bootstrap endpoint so the Vite frontend (and any out-of-process caller) can ask "which workspace am I in?" without already knowing.
- A frontend context provider that stores the resolved workspace and injects the header on every fetch.

This is purely substrate. No singletons get split, no routes change behavior, no snapshots get removed. The middleware exists but defaults to soft-fallback for every request, so old callers keep working untouched.

## Goal

After this ticket:
- `req.workspace = { id, root, source }` is available in every Express handler.
- `GET /api/workspace` returns the resolved boot workspace.
- The Vite frontend fetches `/api/workspace` on boot and attaches `X-Compose-Workspace-Id` to all subsequent **`fetch`** requests. SSE (`EventSource`) and WebSocket transports tag-via-header are deferred to follow-up tickets (covered when those routes consume workspace) — a query-param fallback is documented but not implemented in v1.
- An exhaustive grep of in-scope HTTP-proxying callers (stdio MCP `compose-mcp-tools.js`, `lib/vision-writer.js`, `bin/compose.js` httpGet/Post, `server/design-routes.js`) confirms each one has the header injection wiring in place — even though no downstream route depends on it yet. (`server/agent-hooks.js` is deferred to COMP-WORKSPACE-AGENT-SVR.)
- A new golden test confirms: when 2 different workspace headers hit the same server, both succeed and `req.workspace` differs. (No registries yet, so the writes still go to the boot workspace — that's tested explicitly as known-current-behavior.)

## Non-goals (this ticket)

- **No singleton splitting.** VisionStore, SettingsStore, SessionManager, DesignSessionManager remain boot-time singletons. → next tickets.
- **No snapshot site changes.** All 6 import-time `PROJECT_ROOT` snapshots stay. → next tickets.
- **No agent-server (port 4002) changes.** → COMP-WORKSPACE-AGENT-SVR.
- **No `/api/project/switch` rework.** Stays as-is, exempt path. The follow-up tickets decide whether to demote to single-user-mode or rebuild on registries.
- **No watcher rebinding.** → COMP-WORKSPACE-WATCHERS.

## Sub-decisions

### SD-1: Middleware contract

`server/workspace-middleware.js`. Mounted in `server/index.js` after `express.json()` (line 49), before all route handlers.

```js
const EXEMPT_PATHS = new Set([
  '/api/workspace',          // bootstrap (this endpoint can't require itself)
  '/api/project/switch',     // legacy single-user switch; rework deferred
  '/api/health',             // liveness
]);

export function createWorkspaceMiddleware({ allowGetFallback = true } = {}) {
  return (req, res, next) => {
    if (EXEMPT_PATHS.has(req.path)) {
      req.workspace = { id: null, root: getTargetRoot(), source: 'exempt' };
      return next();
    }

    const headerId = req.headers['x-compose-workspace-id'];

    try {
      if (!headerId) {
        // v1: soft fallback for ALL requests (mutations included). Behavior-preserving.
        // Subsequent tickets will narrow this to GET-only as their consumers migrate.
        if (allowGetFallback) {
          req.workspace = { id: null, root: getTargetRoot(), source: 'fallback' };
          res.setHeader('X-Compose-Workspace-Fallback', 'true');
          return next();
        }
      }
      const resolved = resolveWorkspace({ workspaceId: headerId, cwd: getTargetRoot() });
      req.workspace = resolved;
      next();
    } catch (err) {
      mapResolverErrorToResponse(err, res);
    }
  };
}
```

**Critical v1 detail:** soft-fallback applies to ALL requests, not just GET. This makes the middleware fully behavior-preserving — no existing caller breaks. The mutation-tightening happens incrementally in subsequent tickets (`COMP-WORKSPACE-VISION` tightens vision routes, etc.).

`resolveWorkspace` is **synchronous, no `allowFallback` option** — fallback logic lives in the middleware.

**Error → HTTP mapping:**
| Resolver error | HTTP | Body |
|---|---|---|
| `WorkspaceUnknown` (header given, not found) | 400 | `{error, code, id}` |
| `WorkspaceAmbiguous` | 409 | `{error, code, candidates}` |
| `WorkspaceIdCollision` | 409 | `{error, code, roots}` |
| `WorkspaceDiscoveryTooBroad` | 400 | `{error, code}` |
| `WorkspaceUnset` | not raised in v1 (soft fallback) | — |

### SD-2: Bootstrap endpoint

`GET /api/workspace`. New route file `server/workspace-routes.js`.

```js
// Returns: { id, root, source: 'boot' }
// Authoritative for "which workspace did this HTTP server boot in?"
// Does NOT call resolveWorkspace() — that runs descendant discovery, which 409s in
// parent workspaces containing nested child workspaces (e.g. forge-top has compose
// underneath). Instead derive directly from getTargetRoot() and deriveId() — those
// are the boot anchor by definition.
app.get('/api/workspace', (req, res) => {
  const root = getTargetRoot();
  const id = deriveId(root);  // from lib/discover-workspaces.js
  res.json({ id, root, source: 'boot' });
});
```

The frontend gets one workspace deterministically. If the user wants to act on a different workspace (e.g., the parent in a nested setup), they pick from a workspace switcher UI that calls a future `GET /api/workspaces` (plural — discovery-based listing, deferred to a follow-up).

Exempt from the workspace middleware (it would chicken-and-egg). Useful for: Vite frontend bootstrap, debugging, future CLI commands like `compose http-server status`.

### SD-3: Vite frontend context provider

A React context that:
1. On mount, fetches `GET /api/workspace`. Stores `{ id, root }` in state.
2. Provides `useWorkspace()` hook returning the current workspace.
3. Provides a `wsFetch()` helper (or wraps the existing fetch wrapper if one exists) that injects `X-Compose-Workspace-Id`.

All existing `fetch('/api/...')` calls in the frontend get migrated to `wsFetch('/api/...')`. The fetch-call audit during blueprint will enumerate every site (known sites include `App.jsx`, `useVisionStore.js`, `useDesignStore.js`, plus settings/journal/agent helpers) and `wsFetch` migration is per-site mechanical.

**SSE and WebSocket are out of scope for v1.** `useDesignStore.js` opens an `EventSource` and `useVisionStore.js` opens a `WebSocket`. Tagging those transports needs a different mechanism (query-param `?workspace=<id>` is the most likely choice since headers don't apply to native `EventSource`). Defer to follow-up tickets that actually consume workspace on those transports — until then, SSE/WS connections are workspace-agnostic, exactly as today.

`/api/workspace` no longer errors on ambiguity (it returns boot deterministically — see SD-2). The frontend always gets a usable answer on boot. A future workspace-switcher UI is out of scope.

### SD-4: Wire up HTTP-proxy callers (no-op header injection)

Even though no downstream route requires the header in v1, every caller that proxies to the HTTP server gets the wiring NOW so subsequent tickets don't have to revisit. The injection is no-op today (middleware ignores the header on soft-fallback paths) but ready for tightening.

| Caller | Today | After |
|---|---|---|
| `server/compose-mcp-tools.js` (4 sites) | direct `http.request()` | `_httpRequest(method, path, body)` wrapper reads `_binding.id`, injects header |
| `lib/vision-writer.js` `_fetch()` | accepts `opts.headers` already | injects header from `_binding.id` (passed in via existing plumbing) |
| `bin/compose.js` `httpGet`/`httpPost` (~lines 2450–2480) | string root only | extend `resolveCwdWithWorkspace` to return `{root, id}`; thread `id` to helpers; inject header |
| `server/design-routes.js` direct fetches | inline fetch | use `req.workspace.id` from route handler |
| `server/agent-hooks.js` runtime fetches | static options | **DEFERRED** to COMP-WORKSPACE-AGENT-SVR (cross-process design needed first) |

The `agent-hooks.js` deferral is deliberate: that's a port-4002 problem that needs the full agent-server design. Adding partial wiring there now would be misleading.

### SD-5: What happens to in-process direct callers without header context?

A small number of in-process fetches happen from boot (e.g., `feature-scan.js` → `agent-hooks.js`) where there's no `req` and no `_binding`. For v1 these continue to send no header → fall back to boot workspace. Documented as known-current-behavior. The follow-up tickets that touch each consumer migrate them appropriately.

## Verification gates (this ticket)

- New unit test: `test/workspace-middleware.test.js` — matrix of (header present, header absent, header invalid, ambiguous cwd, exempt path, mutation vs GET).
- New unit test: `test/workspace-routes.test.js` — `GET /api/workspace` returns expected shape; errors map correctly.
- New golden test: `test/golden/http-middleware-multi-workspace.test.js` — 2 workspaces with different headers hit the same server, both `req.workspace` values are correct, both succeed.
- Existing 2547 tests still pass with NO changes (zero-behavior-change is a real verification gate, not a goal).
- Frontend smoke: `npm run dev`, page loads, `wsFetch` requests carry `X-Compose-Workspace-Id` (visible in devtools network tab).
- HTTP-proxy caller wiring: grep confirms all 4 stdio MCP sites + vision-writer + httpGet/Post + design-routes inject the header. `agent-hooks.js` is explicitly deferred to COMP-WORKSPACE-AGENT-SVR (not a v1 acceptance criterion).

## Risks (this ticket)

- **Middleware ordering.** Wrong placement (before `express.json()`, after auth, etc.) could mis-attach `req.workspace`. Mitigated: the explicit insertion line is `server/index.js:49` after `express.json()` and before any route mount. Unit test pins this.
- **Concurrent requests interleaving.** `req.workspace` per request avoids global mutation; safe by construction.
- **Frontend regression.** `wsFetch` migration touches every `fetch('/api/...')` call. Audit during blueprint via grep + verify.
- **Resolver errors leaking 500s.** All resolver error codes mapped to 4xx; unknown errors fall through. `mapResolverErrorToResponse` covered by unit test.
- **`_binding.id` may be null in stdio MCP** (no `set_workspace` called, ambiguous tree). Existing WORKSPACE-ID error paths surface that to the user; the no-header case in this ticket is benign (soft fallback).

## Open questions (resolved or deferred)

- **SettingsStore/DesignSessionManager registries** → deferred to COMP-WORKSPACE-VISION.
- **Agent server cross-process** → deferred to COMP-WORKSPACE-AGENT-SVR.
- **`/api/project/switch` rework** → deferred to COMP-WORKSPACE-VISION (where it gets demoted or rebuilt on the new registries).
- **Mutation-hardness toggle** → deferred to each follow-up ticket (each tightens its own routes).
- **WebSocket workspace tagging** → deferred to COMP-WORKSPACE-VISION (ws is mostly vision broadcasts).

## Files touched

**New:**
- `server/workspace-middleware.js`
- `server/workspace-routes.js`
- `test/workspace-middleware.test.js`
- `test/workspace-routes.test.js`
- `test/golden/http-middleware-multi-workspace.test.js`
- Vite: `src/contexts/WorkspaceContext.jsx` (or wherever the existing context lives) + `src/lib/wsFetch.js`

**Modified:**
- `server/index.js` — mount middleware (line 49 area)
- `server/compose-mcp-tools.js` — `_httpRequest` wrapper, refactor 4 call sites to use it
- `lib/vision-writer.js` — header injection in `_fetch()` (parameter plumbing only — keep behavior identical)
- `bin/compose.js` — extend `resolveCwdWithWorkspace` to `{root, id}`, update `_resolvedCwdCache` consumers, thread `id` through `httpGet`/`httpPost` and their callers (~lines 2450–2491+)
- `server/design-routes.js` — header injection in fetches (still fall back to no-header on soft path)
- Vite frontend: every `fetch('/api/...')` migrated to `wsFetch('/api/...')`

**Estimated:** ~10 files modified, 6 new files, ~600–800 LOC delta.

## Phase 1 unproven assumptions

None requiring a spike. All pieces have established precedent:
- Middleware: boilerplate Express pattern.
- Bootstrap endpoint: trivial.
- React context provider: standard pattern.
- Header injection in stdio MCP: shape mirrors existing `getCurrentWorkspaceId` plumbing from WORKSPACE-ID T6.

The blueprint phase will verify exact line numbers (they may have shifted from the prior session) and audit the full list of frontend fetch sites.
