# COMP-WS-ISOLATION-1 — Audit Findings

**Found:** 2026-09-28, during UAT of the Compose UI.
**Method:** read-only Codex audit (stratum run `d5c03ef63d43`, gpt-6-sol/high) plus live
endpoint probing against a blank target project.
**Status:** filed, not fixed. Deferred by owner in favour of demo readiness.

## Summary

Compose's per-project isolation is sound in its core, and was verified empirically.
Auth sits outside that core and does not re-scope on project switch.

Live control run: with the server switched to a blank project (`~/reg/my/testapp`,
zero files on disk), 13 read endpoints — `/api/ideabox`, `/api/journal`,
`/api/changelog`, `/api/builds`, `/api/completions`, `/api/agents`,
`/api/build/state`, `/api/lifecycle/status`, `/api/files`, `/api/vision/items`,
plus 404s for `/api/roadmap`, `/api/items`, `/api/gates` — returned no `COMP-*`,
`IDEA-*`, `BUG-27` or `forge` strings. No data leaked.

## Confirmed holes, worst first

### 1. Auth store is pinned to the startup project

`_authStore` is constructed once with the startup project's data directory
(`server/index.js:110-112`) and its file paths retain that directory
(`server/auth-store.js:93-112`). It is not rebuilt by `workspaces.switch()`.

After switching to project B:
- `/api/auth/devices` still returns project A's devices (`server/auth-routes.js:157-159`)
- pairing, revocation and secret rotation still persist to A
  (`server/auth-routes.js:169-174,191-193`; `server/auth-store.js:135-140,367-369,487-505`)

A user managing B's devices reads and mutates A's auth state.

### 2. Cross-project token acceptance (remote mode)

The remote auth gate uses that same pinned store and verifies the JWT *before*
project routing (`server/index.js:121-123,174-175,212`;
`server/auth-middleware.js:192-209`). A device paired under A can switch the
server to B and use its A-issued token against B's routes
(`server/auth-store.js:200-212`). Pairing under B also broadcasts the A-store
device name and id to B's active vision clients (`server/auth-routes.js:82-107`).

### 3. `X-Compose-Workspace-Id` is selective, not validated

The header selects a workspace but is never checked against the active switch
target (`server/workspace-middleware.js:44-68`;
`server/workspace-runtime.js:191-202,227-228`). A stale header routes reads **and
writes** to the old project. WebSocket upgrades make the same selection and can
hydrate the old project's vision state (`server/index.js:250-269`;
`server/vision-server.js:390-396,436-439`).

### 4. Project-info routes ignore the header

`/api/project` and `/api/workspace` run before workspace resolution and read the
active process root (`server/index.js:174-185,202-212`;
`server/workspace-routes.js:17-23`). A client bound to A querying either after a
switch to B receives B's metadata, disagreeing with every other route.

## Safe by design — preserve these

- `switchProject()` resets root, data dir and config cache; `getTargetRoot()` /
  `getDataDir()` prefer the request's AsyncLocalStorage binding
  (`server/project-root.js:48-76,101-109,154-167`)
- Each runtime context owns its vision store, session manager, watcher and vision
  server; an ordinary switch stops the old watchers and closes its sockets
  (`server/workspace-runtime.js:110-121,149-188`)
- Build routes pass the bound root to runners; design dispatch keeps its captured
  root after the HTTP response (`server/build-routes.js:34-46,80-102`;
  `server/design-routes.js:299-302,367-370`)
- FLUID creates a fresh provider from the request's project root
  (`lib/fluid/factory.js:196-197,227-233`; `lib/fluid/local-provider.js:120-123`)

## Not verified

Exhaustive behaviour of arbitrary in-flight callbacks across a switch. The audit
was read-only and did not exercise a switch during a live build or design session.

## Related

Client-side counterpart (stale UI state on switch) was fixed separately on
2026-09-28 in `src/App.jsx` / `src/components/vision/useIdeaboxStore.js`. The
remaining client stores listed in that audit (vision slices, design store,
docs/canvas/journal view state, un-namespaced `compose:*` localStorage keys) are
still unaddressed.
