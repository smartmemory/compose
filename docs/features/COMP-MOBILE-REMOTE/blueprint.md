# COMP-MOBILE-REMOTE — Implementation Blueprint

> **Status: BLUEPRINT — Phase 4 artifact. Implements `design.md` (refreshed + gated 2026-06-11, 7 Codex rounds).**

**Related Documents**
- Back: `design.md` (Phase 1, REVIEW CLEAN)
- Forward: implementation slices S01–S05 (Phase 7)

## Verified code reality (read/verified 2026-06-11)

### Server core (4001)
- `server/index.js` — cors `:50` (localhost-regex origin), `express.json()` `:51`, route attach `:53-55` (workspace, graph-layout, workspace middleware), inline `/api/health` `:57`, `/api/project/switch` `:70`, fileWatcher/visionServer attach `:96-109`, **manual WS upgrade handler `:143-156`** (`/ws/files` → fileWatcher.wss, `/ws/vision` → visionServer.wss, else `socket.destroy()`), `server.listen(PORT, '127.0.0.1')` `:158`. **No `express.static` anywhere in server/** — SPA comes from Vite (port **5195**, `vite.config.js:13`) in dev; `dist/` (incl. `m-sw.js`, `manifest.webmanifest` copied from `public/`) is served by nobody.
- `server/security.js` (23 LOC) — only `requireSensitiveToken` (exact `x-compose-token === COMPOSE_API_TOKEN`; 503 when env unset).
- **`requireSensitiveToken` swap accounting (CLASSIFIED — BP-gate finding #4).** Three categories, verified by grep:
  - *Direct-import route guards (2 files, import-swap):* `build-routes.js:17` import → guards `:39,:60`; `vision-routes.js:54` import → conditional `guardAuth` wrapper `:80`.
  - *DI wiring points (1 file, value-swap — covers three consumers at once):* `vision-server.js:214` (→ journal-routes `:83`), `:228` (→ graph-export tokenGate `:323`), `:233` (→ agent-spawn `:41,:212,:247`). Swapping the injected function here is the whole fix for those consumers.
  - *Not edits:* JSDoc/signature mentions (`journal-routes.js:53,:55`, `agent-spawn.js:25,:38`, `graph-export.js:320,:324`) — parameter names, untouched.
  - Net: **2 import swaps + 3 DI values + the security.js shim.** 4002's sites (`agent-server.js:122,142,163`) stay as-is — the proxy injects the real token.
- `server/vision-server.js` — `broadcastMessage` available to attached routes via the options object (`:84`, `:91`); used for the `devicePaired` broadcast.
- `server/supervisor.js` — `PROCESSES` `:26-45` (api-server fork, agent-server fork, vite spawn), `ensureComposeApiToken` `:54-63` (generates `COMPOSE_API_TOKEN`, exposes `VITE_COMPOSE_API_TOKEN`, `VITE_AGENT_PORT`). Does NOT read/thread `COMPOSE_HOST`.

### Agent server (4002)
- `server/agent-server.js` — cors `:60` (localhost regex), `GET /api/health` `:63`, `GET /api/agent/stream` `:94-116` (SSE: headers `:95-98` incl. `X-Accel-Buffering: no`, `flushHeaders()` `:99`, hydrate event `:105`, close cleanup `:115`; `broadcast()` `:79-88`; **no heartbeat**), `POST /api/agent/session` `:122`, `POST /api/agent/message` `:142`, `POST /api/agent/interrupt` `:163` (all three `requireSensitiveToken`), `GET /api/agent/session/status` `:189` (unauth). Listens `127.0.0.1` `:261` — unchanged forever.

### Client libs
- `src/lib/wsFetch.js` (28 LOC) — workspace-header wrapper only; `_workspaceId` set by WorkspaceProvider; `wsFetch` `:24-28`.
- `src/lib/compose-api.js` (17 LOC) — `COMPOSE_API_TOKEN` from `VITE_COMPOSE_API_TOKEN` `:1`, `_runtimeToken` + `setSensitiveToken`/`getSensitiveToken`/`withComposeToken` `:5-17`.
- `src/lib/wsReconnect.js` (87 LOC) — `createReconnectingWS({url,...})`, **string URL only**: `new WebSocket(url)` `:30`; exponential backoff; `close()` idempotent.
- `src/lib/agentStream.js` — `new EventSource(url)` `:121`; `defaultAgentStreamUrl()` `:186` (returns `agentServerUrl('/api/agent/stream')`).
- `src/contexts/WorkspaceContext.jsx` — raw `fetch('/api/workspace')` at `:40` **on app boot**, before any route renders (allowlist dependency).

### Mobile
- `src/mobile/MobileApp.jsx` — `TABS` `:16`, `readTabFromPathname` `:20` (regex `/^\/m(?:\/([^/?#]+))?\/?$/` — `/m/pair` currently falls through to DEFAULT_TAB, so routing needs an explicit pair branch BEFORE tab parsing), legacy `?token=` boot `:32-54` area (localStorage key `compose:mobile:sensitiveToken`).
- Raw `new WebSocket('/ws/vision')` hooks to migrate to `createReconnectingWS(urlFn)`: `useActiveBuild.js:72`, `useIdeas.js:85`, `useLiveAgents.js:60`, `usePendingGates.js:56`. Already migrated: `useRoadmapItems.js` (uses `createReconnectingWS`).
- `useInteractiveSession.js` — raw fetch helper `:18` (all POSTs funnel through it: session, interrupt) + status poll `:42`. **Design said 3 sites; reality is 2** (correction #1).
- Latent 404 bug: `AgentCard.jsx:34`, `AgentDetailView.jsx:31` call `wsFetch(agentServerUrl('/api/agent/:id/stop'))` → 4002, but the route lives on 4001 (`agent-spawn.js:212`).

### CLI / deps
- `bin/compose.js` — `cmd === 'start'` at `:2336`. No `remote` verb.
- `package.json` — express `^4.21`, node `>=18`; **no** qrcode / qrcode-terminal / JWT libs; no rate-limit dep anywhere.

## Corrections table (design assumption vs reality)

| # | Design said | Reality | Resolution |
|---|---|---|---|
| 1 | `useInteractiveSession.js:18,:42,:83` — 3 raw fetch sites | 2 sites: helper `:18` (funnels POSTs) + status poll `:42` | Migrate the helper + poll; blueprint follows reality |
| 2 | `agentStream.js:112` EventSource | `:121` (drift) | Anchors updated |
| 3 | Mobile raw-WS hooks at `:46,:62,:75,:50` | Actual: usePendingGates `:56`, useActiveBuild `:72`, useIdeas `:85`, useLiveAgents `:60` | Anchors updated |
| 4 | "Vite on 5173" (original doc) | 5195 (`vite.config.js:13`) | Already fixed in design refresh |
| 5 | `/m/pair` "already covered by startsWith('/m')" (index.html) | True for index.html, but `MobileApp.readTabFromPathname:20` maps unknown segments to the agents tab — pair page needs an explicit route branch | PairPage branch added before tab parsing (S05) |
| 6 | `requireSensitiveToken` swap "at every call site" | 16 call sites across 6 files on 4001 (list above); `vision-routes.js:80` is a conditional wrapper needing a one-line change | S02 swaps all; agent-server's 3 sites excluded by design |

## File Plan

| File | Action | Slice | What |
|---|---|---|---|
| `server/auth-store.js` | new | S01 | Device store (`.compose/data/remote-auth.json`, temp+rename atomic), HS256 JWT sign/verify on node:crypto (alg hardcoded), pairing codes (in-memory, 5-min TTL, single-use), refresh rotation + history ring (5) + reuse-revoke, `rotateSecret`, audit log appender |
| `server/auth-middleware.js` | new | S01 | `createAuthGate({store, allowlist})`, `requirePairingToken(store)`, `requireSensitiveOrPaired(store)`, `wsUpgradeTokenOk(store, req)`, `createRateLimiter({windowMs, max})` (in-house fixed window) |
| `server/auth-routes.js` | new | S01 | `attachAuthRoutes(app, {store, broadcast})`: pair/init (sensitive), **pair/status (sensitive — BP-gate finding #2: only CLI/cockpit poll it and both hold the token; NOT allowlisted)**, pair/complete (public, rate-limited), refresh (public, rate-limited), devices list/revoke (sensitive); `devicePaired` broadcast on complete |
| `test/auth-store.test.js` | new | S01 | JWT roundtrip/expiry/garbage/alg-confusion, code TTL+single-use, rotation, reuse-revoke, history bound, secret rotation, atomic persistence |
| `test/auth-middleware.test.js` | new | S01 | Gate allowlist/credential matrix, composite, limiter, WS query-token check |
| `test/auth-routes.test.js` | new | S01 | Full pairing flow over supertest-style harness (match existing server test conventions), refresh rotation, revoke, rate-limit 429 |
| `server/index.js` | edit | S02 | `COMPOSE_HOST` (env > config > default 127.0.0.1) + refuse non-localhost without `COMPOSE_REMOTE_AUTH=enabled` + banner; mount auth gate (remote mode only) after `:51`; mount auth routes; WS upgrade auth in `:143-156` handler; `express.static(dist/)` + `/m/*` SPA fallback; `/api/agent/proxy/*` forwarder (SSE pass-through, server-side `x-compose-token` injection) |
| `server/security.js` | edit | S02 | Re-export composite or import-shim so existing imports keep working |
| `server/agent-spawn.js`, `build-routes.js`, `journal-routes.js`, `graph-export.js`, `vision-server.js`, `vision-routes.js` | edit | S02 | Swap `requireSensitiveToken` → `requireSensitiveOrPaired` at the 16 verified 4001 call sites |
| `server/supervisor.js` | edit | S02 | Thread `COMPOSE_HOST`/`COMPOSE_REMOTE_AUTH` to api-server child only |
| `test/remote-gate.test.js` | new | S02 | Gate off = zero change; gate on = credential matrix incl. loopback-not-trusted; WS upgrade accept/reject; static allowlist; proxy auth + token injection + SSE headers |
| `bin/compose.js` | edit | S03 | `compose remote pair|list|revoke|status|rotate-secret`; `start --host=`; public_host persistence in `.compose/compose.json` |
| `package.json` | edit | S03 | deps: `qrcode-terminal` (CLI), `qrcode` (cockpit) |
| `test/cli-remote.test.js` | new | S03 | Verb parsing, pair polling loop, status output incl. dist-missing warning |
| `src/components/cockpit/PairDeviceModal.jsx` | new | S04 | QR canvas + pair URL + device list/revoke; listens `devicePaired` |
| `test/ui/pair-device-modal.test.jsx` | new | S04 | Modal flow, revoke, devicePaired live update |
| `src/lib/compose-api.js` | edit | S05 | `getValidAccessToken`, `refreshAccessToken` (single-flight, legacy-fallback per design pseudocode), storage keys |
| `src/lib/wsFetch.js` | edit | S05 | `setAuthMode`; paired-mode pre-refresh; gate-coded 401 handling (TokenExpired→refresh-retry, TokenInvalid→/m/pair); cockpit mode attaches `x-compose-token` on every request when token present |
| `src/lib/wsReconnect.js` | edit | S05 | `url: string \| () => string` (resolve per connect) |
| `src/lib/wsUrl.js` | new | S05 | Shared `visionWsUrl()` / `filesWsUrl()` / `streamUrl(path)` URL builders — append `?token=` (access JWT in paired mode, sensitive token in cockpit-remote mode, nothing on plain localhost); single place for WS **and SSE** credential transport (BP-gate findings #1, round-2 #1). The auth gate accepts `?token=` on `Accept: text/event-stream` GETs and WS upgrades only (header auth everywhere else); tokens filtered from logs |
| `src/mobile/hooks/useRoadmapItems.js` | edit | S05 | Its `createReconnectingWS` call switches from fixed string (`:20` builder, `:58` call) to `() => visionWsUrl()` |
| `src/components/vision/useVisionStore.js`, `useIdeaboxStore.js`, `src/components/Canvas.jsx`, `src/components/PopoutView.jsx` | edit | S05 | Desktop WS call sites (`:193,:41,:265,:120`) swap inline URL construction for the shared builders (mechanical; behavior identical on localhost) |
| `src/components/vision/useDesignStore.js` | edit | S05 | NOT a WS site (round-2 correction): `EventSource('/api/design/stream?...')` at `:240` (route `design-routes.js:557`) — switches to `streamUrl('/api/design/stream')` so design SSE carries the query token in remote mode |
| `src/lib/agentStream.js` | edit | S05 | `defaultAgentStreamUrl()` mode switch → `/api/agent/proxy/stream` (+ `?token=` in paired mode) |
| `src/mobile/pages/PairPage.jsx` | new | S05 | Code consumption + codeless re-pair screen + paste-URL fallback |
| `src/mobile/MobileApp.jsx` | edit | S05 | `/m/pair` route branch before tab parsing; dual-mode boot (refresh token present → paired mode) |
| `src/mobile/hooks/useInteractiveSession.js` | edit | S05 | Helper `:18` + poll `:42` → wsFetch + proxy paths |
| `src/mobile/hooks/useActiveBuild.js`, `useIdeas.js`, `useLiveAgents.js`, `usePendingGates.js` | edit | S05 | Raw WS → `createReconnectingWS(urlFn)` |
| `src/mobile/components/AgentCard.jsx`, `AgentDetailView.jsx` | edit | S05 | 404 fix: stop/status → relative 4001 paths |
| `test/ui/mobile-pair.test.jsx` | new | S05 | Pair flow, dual-mode boot, refresh single-flight, 401 ladder, codeless screen |
| `test/ui/mobile-remote-auth.test.jsx` | new | S05 | wsFetch mode matrix, wsReconnect function-URL, hook migrations keep behavior |

## Boundary Map

### S01: server auth core
Produces:
  server/auth-store.js → createAuthStore, signAccessToken, verifyAccessToken (function)
  server/auth-middleware.js → createAuthGate, requirePairingToken, requireSensitiveOrPaired, wsUpgradeTokenOk, createRateLimiter (function)
  server/auth-routes.js → attachAuthRoutes (function)

Consumes: nothing (leaf node)

### S02: bind, gate mount, proxy, static
Produces:
  server/index.js → resolveComposeHost, attachAgentProxy (function)

Consumes:
  from S01: server/auth-middleware.js → createAuthGate, requireSensitiveOrPaired, wsUpgradeTokenOk
  from S01: server/auth-routes.js → attachAuthRoutes
  from S01: server/auth-store.js → createAuthStore

### S03: CLI remote verbs
Produces: nothing (integration only)

Consumes:
  from S01: server/auth-store.js → createAuthStore

### S04: cockpit pairing modal
Produces:
  src/components/cockpit/PairDeviceModal.jsx → PairDeviceModal (component)

Consumes: nothing (leaf node)

### S05: client auth + mobile pairing
Produces:
  src/lib/compose-api.js → getValidAccessToken, refreshAccessToken (function)
  src/lib/wsFetch.js → setAuthMode (function)
  src/mobile/pages/PairPage.jsx → PairPage (component)

Consumes:
  from S02: server/index.js → attachAgentProxy

## Implementation notes per slice

### S01 (pure server lib — no wiring)
- HS256 JWT: header `{"alg":"HS256","typ":"JWT"}` fixed; verify rejects any other header bytes; `crypto.timingSafeEqual` on signatures; claims `{sub: device_id, name, iat, exp}`; clock skew ±30s.
- Refresh token format `<device_id>.<32B base64url random>`; store hash of random part only. Rotation + history append + persistence in one atomic write.
- Pairing codes: `crypto.randomBytes(9)` base32-ish uppercase (QR-friendly); Map in module state; sweep on access.
- Rate limiter: fixed window Map<ip, {count, windowStart}>, 10/min default, 429 with `Retry-After`; sweep opportunistically.
- Audit log: append-only JSONL `.compose/data/remote-auth-audit.log` (pair/refresh/revoke/reuse-revoke/rotate-secret events).

### S02
- Remote-mode detection: `const remoteMode = host !== '127.0.0.1' && host !== 'localhost'`; refuse start if remoteMode && `COMPOSE_REMOTE_AUTH !== 'enabled'` (synchronous, before `listen`).
- **Gate mounted only in remote mode** — when off, the gate's `app.use` never happens. **Precise compatibility guarantee (BP-gate finding #3):** remote-mode-off adds NO auth checks anywhere and does not alter the behavior of any *existing* route or the WS upgrade path; the static-serving and `/api/agent/proxy/*` mounts are additive new routes present in both modes (useful on localhost too, and keeping them unconditional means they're exercised by everyday use rather than only behind the flag). The S02 test asserts: gate middleware absent when off, every existing route's behavior unchanged, new routes additive.
- WS upgrade: in the `:143-156` handler, when remoteMode, parse `?token=` → `wsUpgradeTokenOk` (sensitive token or valid JWT) else write `HTTP/1.1 401` + destroy. Filter token from any logging.
- Static: `express.static(distDir, { index: false })` + GET fallback for `/m`-prefixed paths → `dist/index.html`; mounted after the gate; gate allowlists `/m`, `/assets`, `/manifest.webmanifest`, `/m-sw.js`, `GET /api/health`, `GET /api/workspace`, `POST /api/auth/pair/complete`, `POST /api/auth/refresh`. Missing `dist/` → 503 with "run npm run build" message on those paths (not a crash).
- Proxy: `http.request` to `127.0.0.1:${AGENT_PORT}` per design route table; pipe req/res streams both ways; copy SSE headers verbatim; inject `x-compose-token: process.env.COMPOSE_API_TOKEN` (strip any client-sent value); no body buffering; abort upstream on client close.
- `requireSensitiveOrPaired` swap: the composite must behave EXACTLY like `requireSensitiveToken` when no auth store is configured (e.g. tests that hit 503-when-env-unset must keep passing unchanged).

### S03
- `compose remote pair`: POST pair/init via local server (sensitive token from env or `.compose` supervisor session), render `qrcode-terminal`, poll pair/status every 2s until consumed/expired (Ctrl-C safe).
- `remote status`: prints bind host, remote-auth flag, public_host, device count, `dist/` presence, and HEAD `<public_host>/api/health` result when configured.

### S04
- Modal opens → pair/init → QR via `qrcode` to canvas; subscribes to `devicePaired` on the existing `/ws/vision` connection (via the store's message handler registry — same pattern as gate events in `visionMessageHandler.js`); device list below with two-step revoke.

### S05
- Implement exactly the design's dual-mode pseudocode (gated 7 rounds — do not improvise): `refreshAccessToken` failure → clear keys, restore legacy token, `setAuthMode('cockpit')`, throw; `wsFetch` 401 ladder keyed on gate body codes; `MobileApp` boot reads refresh-token presence.
- WS URL functions: paired mode appends `?token=<access JWT>` (fresh read per connect); cockpit remote mode appends sensitive token; localhost appends nothing.
- Hook migration to `createReconnectingWS` must preserve each hook's message handling verbatim (the four hooks' reconnect loops are duplicates of what the helper already does — net deletion).

## Verification Table (Phase 5)

| Ref | Claim | Verified |
|---|---|---|
| index.js :50,:51,:53-55,:57,:70,:96-109,:143-156,:158 | mount order, upgrade handler, hardcoded bind | ✅ explorer + Codex design gate (line-cited both rounds) |
| security.js 23 LOC single export | requireSensitiveToken only | ✅ read this session |
| 16 requireSensitiveToken call sites on 4001 (6 files) | swap list | ✅ grep this session (excludes agent-server's 3) |
| agent-server.js :60,:63,:79-88,:94-116,:122,:142,:163,:189,:261 | routes, SSE internals, localhost bind | ✅ explorer + grep this session |
| supervisor.js :26-45,:54-63 | processes, token threading, no COMPOSE_HOST | ✅ read this session |
| wsFetch.js :24-28; compose-api.js (17 LOC); wsReconnect.js :30 | current shapes | ✅ read this session |
| agentStream.js :121,:186 | EventSource + default URL | ✅ grep this session (corrections #2) |
| WorkspaceContext.jsx :40 | boot fetch /api/workspace | ✅ grep this session |
| MobileApp.jsx :16,:20,:30 | tab regex; /m/pair falls to default tab | ✅ grep this session (corrections #5) |
| Raw-WS hooks :56,:60,:72,:85; useRoadmapItems already migrated | migration set | ✅ grep this session (corrections #3) |
| useInteractiveSession :18,:42 | 2 raw-fetch sites not 3 | ✅ grep this session (corrections #1) |
| AgentCard.jsx:34 / AgentDetailView.jsx:31 → 4001 route agent-spawn.js:212 | latent 404 | ✅ read + grep this session |
| bin/compose.js :2336 start; package.json no auth deps | CLI anchor, deps | ✅ grep this session |
| public/m-sw.js exists (SHELL list :4); dist/ contains m-sw.js + manifest | static inventory | ✅ ls this session |
| vision-server.js :84,:91 broadcastMessage availability | devicePaired broadcast path | ✅ grep this session |
| Boundary Map | validateBoundaryMap | ✅ see gate note below |
