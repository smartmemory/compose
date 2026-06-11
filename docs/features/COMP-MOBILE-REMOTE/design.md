# COMP-MOBILE-REMOTE — Remote transport + auth for the mobile PWA

> **Status: DESIGN DOCUMENT — Phase 1 artifact, nothing here is implemented yet.**
> Reviewers: evaluate as a design (decisions, scope, contracts), not as shipped code.

**Status:** DESIGN (refreshed 2026-06-11 against post-COMP-MOBILE-1 main — see Reality Check)
**Created:** 2026-05-10
**Group:** COMP-MOBILE
**Predecessor:** [COMP-MOBILE](../COMP-MOBILE/design.md) (foundation: PWA + token plumbing), [COMP-MOBILE-1](../COMP-MOBILE-1/design.md) (monitoring loop; shipped 2026-06-11)

## Reality Check (2026-06-11 verification against main)

Code-verified deltas since this design was written; the sections below are amended accordingly:

1. **The API server does not serve the SPA.** Vite (port **5195**, not 5173) serves the shell in dev and proxies `/api`+`/ws` to 4001; `server/index.js` has no `express.static`. A tunnel exposing only 4001 would never load the PWA. **New scope: 4001 gains static serving of `dist/`** (SPA fallback for `/m/*` → `dist/index.html`; `public/m-sw.js` and `manifest.webmanifest` are copied into `dist/` by Vite). Harmless on localhost; required for remote. `compose remote status` warns if `dist/` is missing (run `npm run build`).
2. **The agent-server (4002) surface is smaller than this design assumed.** Actual 4002 routes: `GET /api/health`, `GET /api/agent/stream` (SSE, unauth), `POST /api/agent/session`, `POST /api/agent/message`, `POST /api/agent/interrupt` (all three requireSensitiveToken), `GET /api/agent/session/status` (unauth). **`/api/agent/:id` and `/api/agent/:id/stop` are 4001 routes** (`server/agent-spawn.js:212`, attached via vision-server). **Latent bug found:** mobile `AgentCard.jsx:34` / `AgentDetailView.jsx:31` call stop via `agentServerUrl()` → 4002 → 404 — mobile agent-kill is broken today and the fetch-mocked tests can't see it. Fix folded into this feature: those call sites switch to relative `wsFetch('/api/agent/:id/stop')` (4001), which also removes them from the proxy surface. The proxy route table (§ Agent server) is corrected to the real 4002-only set.
3. **AGENT_PORT consolidation already happened** (COMP-MOBILE-1 S01): `useInteractiveSession.js`, `AgentCard.jsx`, `AgentDetailView.jsx` use `agentServerUrl()`. Remaining raw-`fetch` sites that bypass `wsFetch`: `useInteractiveSession.js:18,:42,:83` and the EventSource in `agentStream.js:121` — exactly the sites that migrate to the proxy paths in this feature.
4. **WS upgrade is a manual `server.on('upgrade')` handler** (`server/index.js:143-156`) routing `/ws/files` and `/ws/vision`, destroying unknown paths. The remote-auth check for WS mounts there, before `handleUpgrade()`.
5. **Express surface today: 103 routes (60 mutating) on 4001** — confirms default-deny over route-by-route patching.
6. **No JWT/QR deps exist; no rate-limiting anywhere.** Decisions in § Security details: minimal hand-assembled HS256 JWT on `node:crypto` primitives (zero new supply-chain surface for the auth component; HMAC is the vetted primitive, the JWT envelope is base64url+JSON), `qrcode` + `qrcode-terminal` as the only new deps, and a ~20-line in-house fixed-window per-IP limiter for the two public auth endpoints.
7. **Supervisor doesn't thread `COMPOSE_HOST`** — `server/supervisor.js` must pass it through to the api-server child (agent-server stays 127.0.0.1 always).
8. Threat-model line refs drifted 1–30 lines (routes all still exist, all still unauthenticated beyond the conditional `guardAuth`); current anchors: project switch `server/index.js:70`, file write `file-watcher.js:51`, vision PATCH `vision-routes.js:102`, ideabox `ideabox-routes.js:76`, settings `settings-routes.js:19`.

---

## Why

[`COMP-MOBILE`](../COMP-MOBILE/) ships a PWA at `/m` that works on home wifi using the existing build-time `x-compose-token`. To use it from mobile data — i.e., the phone is on cellular and the laptop is at home — three things have to happen:

1. The compose HTTP server (port 4001) must be reachable from outside `127.0.0.1`.
2. Auth must work without baking a token into the build (the build-time token is fine for "your laptop where the supervisor generated it"; it's wrong for "your phone, paired once, persists forever").
3. The pairing flow must be ergonomic — typing tokens on a phone is a non-starter.

This ticket addresses (2) and (3) entirely. For (1), users bring their own tunnel: Tailscale Funnel, Cloudflare Tunnel, ngrok, or self-hosted reverse proxy. Compose ships clear instructions and a one-line check (`compose remote status`) but does not auto-launch tunnels. That's COMP-MOBILE-REMOTE-AUTOTUNNEL if/when demand arises.

## Prior art

Claude Code's `/remote-control` runs an outbound-polling client against an Anthropic-operated relay, with QR pairing and OAuth via claude.ai. We can't realistically operate a relay (single-user dev tool, ongoing cost). Cursor/Aider don't ship remote at all. The pragmatic gap-filler is **BYO tunnel + first-class server auth + first-class pairing UX**, which is what this ticket delivers.

## Goal

A `compose remote pair` command and a cockpit "Pair mobile" modal that, given a tunneled URL, return a QR code and pairing URL. The phone scans, opens, and is authenticated for 30 days with rolling 15-minute access tokens that auto-refresh. The server enforces token validity on every non-public route. Devices are listable and revocable.

## Non-goals

- **Tunnel automation.** Filed as `COMP-MOBILE-REMOTE-AUTOTUNNEL` for a future ticket.
- **Compose-operated relay.** Out — we don't run infrastructure.
- **OAuth via GitHub/Google.** Token-based auth is sufficient for a single-user dev tool. Multi-user team sharing is a different ticket entirely.
- **Push notifications.** Filed as `COMP-MOBILE-PUSH` (needs Web Push + endpoint storage).
- **Hardening of every existing route's input validation.** This ticket adds an authentication gate; it does not audit every existing mutating endpoint for additional checks. Auth alone gates access; existing per-route validation is unchanged.

## Threat model

Once compose binds beyond 127.0.0.1, **every existing HTTP route is reachable**. The current server has many unauthenticated mutating endpoints — project switching (`server/index.js:70`), file writes (`server/file-watcher.js:50`), vision-item PATCH (`server/vision-routes.js:73`), ideabox CRUD (`server/ideabox-routes.js:75`), design-session routes (`server/design-routes.js:243`), settings (`server/settings-routes.js:19`), session-routes (`server/session-routes.js:29`). A "patch only the mobile endpoints" approach would leave the rest open.

**Therefore the auth model is default-deny for non-localhost traffic.** Localhost (cockpit) keeps working unchanged. Anything hitting the public-bound interface goes through the auth middleware, with a small explicit allowlist for the bootstrap path.

## Token model

Three concrete token types:

| Token | TTL | Purpose | Where stored |
|---|---|---|---|
| **Pairing code** | 5 minutes, single use | Embedded in pairing URL/QR; consumed once during the pairing flow | In-memory only on the server |
| **Refresh token** | 30 days, rotates on use | Allows the device to mint new access tokens | localStorage on the device; **hashed** in `.compose/data/remote-auth.json` |
| **Access token** | 15 minutes | Sent on every request to authenticate | localStorage; not persisted server-side (stateless JWT) |

Access tokens are **JWTs** signed with a server secret. Server validates signature + expiry on each request. No DB lookup per request — only on refresh.

Refresh tokens are **opaque random strings** (hashed at rest, like passwords). The server-side store is `.compose/data/remote-auth.json`:

```json
{
  "secret": "<server-side JWT signing secret, generated on first run>",
  "devices": [
    {
      "id": "dev_abc123",
      "name": "iPhone 15 (Safari)",
      "user_agent": "<truncated UA from pairing time>",
      "paired_at": "2026-05-10T14:00:00Z",
      "last_seen": "2026-05-10T14:23:01Z",
      "refresh_hash": "<sha256(random part of current refresh token)>",
      "refresh_history": [ { "hash": "<sha256(retired)>", "retired_at": "2026-05-10T14:10:00Z" } ],
      "revoked": false
    }
  ]
}
```

## Server-side architecture

### Bind address

Today `server/index.js:158` hard-codes `127.0.0.1` and `bin/compose.js` exposes `compose start` (not `serve`). Changes:

- `server/index.js` reads `process.env.COMPOSE_HOST` (default `127.0.0.1`) when calling `server.listen`.
- `bin/compose.js start` accepts `--host=<address>` and forwards it via env. New subcommand `compose start --host=0.0.0.0`.
- `.compose/compose.json` gains `"server": { "host": "0.0.0.0" }` as a persistent override; CLI flag wins over config; env wins over both (so supervisor can pass it).

When bound to non-localhost, **refuse to start** unless `COMPOSE_REMOTE_AUTH=enabled` is also set (the user explicitly acknowledges the security model). Validation runs synchronously before `listen` so misconfiguration fails fast — no runtime proxy-detection (that signal arrives only after startup, too late).

Print a loud startup banner:

```
[compose] WARNING: bound to 0.0.0.0 — accessible from local network and beyond
[compose] Auth gate active: localhost trusted; remote requests require pairing token.
[compose] Run `compose remote pair --public-host=<URL>` from the cockpit terminal to add a device.
```

### Agent server (port 4002) — proxy through 4001

The mobile flows hit a SECOND server: `agent-server.js` on port 4002 (default). `useInteractiveSession`, `AgentDetailView` kill, the global SSE stream — all of those go to `:4002` directly. Today CORS on 4002 is localhost-only; auth is none. Two options:

| Option | Pros | Cons |
|---|---|---|
| **Remote-bind 4002 too** | Direct, no extra hops | Doubles the auth surface; requires duplicating the auth gate on 4002; tunnel must forward two ports |
| **Proxy through 4001** | Single port to expose; single auth gate; tunnel config is one host | Adds latency; requires forwarding SSE through Express |

**Decision: proxy through 4001.** Add `/api/agent/proxy/*` routes on the API server that forward to `127.0.0.1:${AGENT_PORT}` after auth-gate clearance. SSE forwarding uses Express's response stream pass-through. Mobile hooks switch from `${AGENT_PORT}` URLs to relative `/api/agent/proxy/*` paths; cockpit continues to hit `:4002` directly when on localhost (no behavior change).

This keeps **only port 4001 exposed remotely**. Agent server stays localhost-only — defense in depth.

**Specific routes to proxy** (corrected 2026-06-11 to the real 4002 surface):
- `GET /api/agent/proxy/stream` → `:4002/api/agent/stream` (SSE — forward `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`; pipe the response stream unbuffered; 4002 has no SSE heartbeat, so the proxy must not impose idle timeouts shorter than the tunnel's)
  - **SSE auth transport (round-2 finding #2):** `EventSource` cannot set headers, so the gate accepts `?token=<access JWT>` on this route (same query-param contract as WS upgrades; validated identically, filtered from access logs). The mobile stream URL comes from a function (fresh token per (re)connect — `agentStream.js` already reconnects on error, which naturally picks up refreshed tokens). In legacy/localhost mode the gate isn't mounted and the bare URL keeps working.
- `POST /api/agent/proxy/session` → `:4002/api/agent/session`
- `POST /api/agent/proxy/message` → `:4002/api/agent/message`
- `POST /api/agent/proxy/interrupt` → `:4002/api/agent/interrupt`
- `GET /api/agent/proxy/session/status` → `:4002/api/agent/session/status`

**NOT proxied** (they were never 4002 routes): `GET /api/agent/:id` and `POST /api/agent/:id/stop` live on 4001 (`agent-spawn.js:212`). Mobile's `AgentCard.jsx:34`/`AgentDetailView.jsx:31` currently mis-target them at 4002 via `agentServerUrl()` — a live 404 bug fixed in this feature by switching those call sites to relative `wsFetch('/api/agent/...')`.

Mobile call sites that migrate to proxy paths: `useInteractiveSession.js` (:18 session POST, :42 status poll, :83 interrupt) and the SSE URL in `agentStream.js` (mobile entry only — `defaultAgentStreamUrl()` grows a mode switch). Desktop keeps direct `:4002` calls (localhost only). The proxy forwards `x-compose-token`/`Authorization` headers through after auth-gate clearance, since 4002's mutating routes still check the sensitive token.

### Auth middleware — default-deny for non-localhost

`server/security.js` already has `requireSensitiveToken` (build-time token check). The new model:

**Trust model (REVISED 2026-06-11 — design-gate blocker).** Loopback source IP is NOT a usable trust signal under the BYO-tunnel model this feature targets: cloudflared/tailscaled/ngrok/ssh -L all run on the same machine, so *tunneled remote traffic arrives from 127.0.0.1* and an IP-based bypass would wave it through unauthenticated. Header heuristics (X-Forwarded-For) fail too — `ssh -L` adds none. Therefore:

- **Remote mode OFF (default, localhost bind):** the auth gate is not mounted at all. Zero behavior change for every existing workflow.
- **Remote mode ON (`COMPOSE_REMOTE_AUTH=enabled`):** NO IP-based trust. Every request needs a credential — either the sensitive token (`x-compose-token === COMPOSE_API_TOKEN`; cockpit and CLI have it) or a valid pairing JWT — except the bootstrap allowlist.

```
authGate(req, res, next):            // mounted ONLY in remote mode
  if req.path in PUBLIC_REMOTE_ALLOWLIST: next()
  elif req has valid sensitive token:  next()   // cockpit / CLI / supervisor children
  elif req has valid pairing JWT:      req.device = {...}; next()
  else: 401 (TokenExpired | TokenInvalid)
```

Cockpit compatibility in remote mode: `wsFetch` in `'cockpit'` mode attaches `x-compose-token` on **every** request (today only `withComposeToken` callers do) — one change in one place. Desktop WebSocket connects (`useVisionStore`, file-watcher WS) append `?token=<sensitive>` via the same function-URL pattern mobile uses; the WS upgrade handler accepts sensitive token or JWT in the query param. These cockpit changes are inert when remote mode is off.

**Mounted globally, BEFORE all route handlers** (after `cors`, after `express.json`, before everything else — and only when remote mode is on):

`PUBLIC_REMOTE_ALLOWLIST` contains exactly:
- `GET /api/health`
- `GET /api/workspace` (design-gate finding #4: `WorkspaceContext.jsx:30` fetches it at app boot, before any route — including `/m/pair` — can render; read-only workspace metadata, accepted leak, documented)
- `POST /api/auth/pair/complete`
- `POST /api/auth/refresh`
- All static `/m/*` and `/manifest.webmanifest`, `/m-sw.js` (PWA shell + pair page must load before auth)
- Asset paths under `/assets/`

**Static serving prerequisite (2026-06-11):** these static paths are served by Vite today, not by 4001. This feature adds `express.static(dist/)` + SPA fallback (`/m/*` → `dist/index.html`) to `server/index.js`, mounted AFTER the auth gate (the gate allowlists them) so a single tunneled port serves shell + API. Dev workflow on localhost is unchanged (Vite 5195 keeps proxying). Remote always uses the built bundle.

`requirePairingToken`:
1. Reads `Authorization: Bearer <jwt>` (preferred) or `x-compose-token: <jwt>` (back-compat).
2. Verifies JWT signature + expiry against the server secret.
3. On valid token, attaches `req.device = { id, name }` and calls `next()`.
4. On invalid, returns `401 { error, code: 'TokenInvalid' }`.
5. On expired, returns `401 { error, code: 'TokenExpired' }` so the client knows to refresh.

**Sensitive-route compatibility (REVISED 2026-06-11 — design-gate finding #2).** Routes guarded by `requireSensitiveToken` (build start/abort `build-routes.js:39`, agent stop `agent-spawn.js:212`, journal POST, spawn, …) do an exact `x-compose-token === COMPOSE_API_TOKEN` check; a paired device's JWT would be rejected even after passing the gate. Two-part fix:

1. **4001 routes:** new composite `requireSensitiveOrPaired` (in `server/auth-middleware.js`) replaces `requireSensitiveToken` at every existing call site — accepts the exact sensitive token (legacy path, unchanged behavior) OR a valid pairing JWT (sets `req.device`). When remote mode is off, the JWT branch simply never matches anything.
2. **4002 (proxied) routes:** the proxy, after gate clearance, **injects the real sensitive token server-side** (`x-compose-token: process.env.COMPOSE_API_TOKEN`) into the forwarded request. The agent-server stays completely unchanged — it keeps its exact-match check, and the secret never leaves the server process.

**Important:** the auth gate is mounted at the express app level, so EVERY route — including ones not enumerated in this design (vision routes, file-watcher, settings, design, sessions, ideabox) — is automatically protected from non-localhost access. No route-by-route patching.

### New routes (`server/auth-routes.js`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/pair/init` | requires sensitive token (cockpit/CLI) | Returns `{ code, expires_at, pair_url }` — code is single-use, 5-min TTL |
| `GET /api/auth/pair/status?code=...` | requires sensitive token (only CLI/cockpit poll it; both hold the token — keeps it off the public allowlist) | For CLI polling — returns `{ status: "pending" \| "consumed" \| "expired" }` |
| `POST /api/auth/pair/complete` | none (uses code as the auth) | Body `{ code, device_name? }`; consumes code, creates device, returns `{ access_token, refresh_token, device_id, expires_in }`. UA captured from request. |
| `POST /api/auth/refresh` | none (uses refresh token as the auth) | Body `{ refresh_token }`; rotates refresh, returns `{ access_token, refresh_token, expires_in }` |
| `GET /api/auth/devices` | requires sensitive token | Lists paired devices |
| `DELETE /api/auth/devices/:id` | requires sensitive token | Revokes a device (sets `revoked: true`; subsequent refresh attempts fail) |

### Pairing flow (sequence)

```
1. Cockpit/CLI ──POST /api/auth/pair/init──▶ Server
                ◀─{code, pair_url}─────────
2. Server prints QR(pair_url) + URL string

3. Phone scans QR → opens pair_url → /m/pair?code=XXX

4. /m/pair page ──POST /api/auth/pair/complete {code, device_name}──▶ Server
                ◀─{access_token, refresh_token, device_id}──────────
5. Phone stores both tokens in localStorage, calls setSensitiveToken(access_token).
   Phone redirects to /m/agents.

6. Phone sends every API request with Authorization: Bearer <access_token>
7. On 401 TokenExpired → POST /api/auth/refresh {refresh_token}
                       ◀─{new tokens}─
   Update storage, retry original request.
8. On 401 TokenInvalid (refresh also failed) → redirect to /m/pair (re-pair)
```

### Pairing URL shape

`https://<tunnel-host>/m/pair?code=ABCDEF123456`

The cockpit/CLI must know the public host. Two options:

1. **User-supplied:** `compose remote pair --public-host=https://forge.tail-abc.ts.net`. Stored in `.compose/compose.json` after first run. Required if compose can't auto-detect.
2. **Auto-detect:** request to `https://api.cloudflare.com/cdn-cgi/trace` (yields client IP, not hostname) — useless. Drop.

Decision: user-supplied. Document common values for Tailscale/Cloudflare/ngrok in the README.

## CLI

```
compose remote pair [--public-host=URL] [--name=DEVICE_NAME]
  → Calls /api/auth/pair/init, prints QR + URL, polls status, prints "Paired!" on success.

compose remote list
  → Calls /api/auth/devices, prints table.

compose remote revoke <device-id>
  → Calls DELETE /api/auth/devices/:id.

compose remote status
  → Prints: bind address, public host (if configured), paired device count, tunnel reachability check (HEAD request to public_host/api/health, expects 200).
```

## Cockpit

New "Pair mobile device" modal:
- Trigger: header dropdown menu OR a top-level "Devices" page
- On open: calls `POST /api/auth/pair/init`, displays QR + URL string
- Listens to `/ws/vision` for `devicePaired` event (server broadcasts when pair completes)
- Below QR: list of paired devices with revoke buttons (calls `DELETE /api/auth/devices/:id`)

QR rendering: `qrcode` npm dep, rendered to a canvas inline (no external service).

## Mobile (PWA)

### New route `/m/pair?code=XXX`

`src/mobile/pages/PairPage.jsx`:
- Reads `?code` from URL
- Asks the user for a device name (optional, prefills with `${platform} (${browser})`)
- POSTs `/api/auth/pair/complete`
- On success: stores both tokens (access + refresh + expiry timestamp) in localStorage, calls `setSensitiveToken(access_token)` and `setAuthMode('mobile-paired')`, then redirects to `/m/agents`. Refresh is reactive (driven by `wsFetch`'s `getValidAccessToken()` + retry-on-401), not a proactive timer.
- On error: shows the error, suggests `compose remote pair` to generate a new code
- **Codeless state (bare `/m/pair`, no `?code`):** the page is also the "re-pair required" screen — wsFetch redirects here on unrecoverable gate 401s. It renders instructions ("This device is no longer paired. On your desktop, run `compose remote pair` or open Cockpit → Pair mobile, then scan the new QR code.") and a paste-the-pairing-URL input as a camera-less fallback. No API calls are made until a code is present.

### Token storage + refresh

`src/lib/compose-api.js` extended:

```js
// New: persistent token storage + refresh
const ACCESS_KEY = 'compose:mobile:accessToken';
const REFRESH_KEY = 'compose:mobile:refreshToken';
const EXPIRY_KEY = 'compose:mobile:accessExpiry';

let _refreshPromise = null;

export async function getValidAccessToken() {
  const tok = localStorage.getItem(ACCESS_KEY);
  const exp = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10);
  if (tok && exp > Date.now() + 30_000) return tok;  // 30s skew
  return refreshAccessToken();
}

export async function refreshAccessToken() {
  if (_refreshPromise) return _refreshPromise;
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) throw new Error('NoRefreshToken');
  _refreshPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  }).then(async (r) => {
    if (!r.ok) {
      // Clear stored JWT state and drop to legacy mode (dual-mode contract).
      // Restore the in-memory token to what legacy mode would have: the
      // legacy ?token= pairing value if this device ever had one, else null
      // (NOT the stale access JWT). Whether the next request then succeeds
      // (localhost / legacy server) or gate-401s (remote server → wsFetch's
      // catch path redirects to /m/pair) is the server's call.
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(EXPIRY_KEY);
      setSensitiveToken(localStorage.getItem('compose:mobile:sensitiveToken') || null);
      setAuthMode('cockpit'); // legacy
      throw new Error('RefreshFailed');
    }
    const j = await r.json();
    localStorage.setItem(ACCESS_KEY, j.access_token);
    localStorage.setItem(REFRESH_KEY, j.refresh_token);
    localStorage.setItem(EXPIRY_KEY, String(Date.now() + j.expires_in * 1000));
    setSensitiveToken(j.access_token);
    return j.access_token;
  }).finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}
```

### Central auth abstraction (not hook-by-hook migration)

Hook-by-hook migration leaves intermediate states broken. Instead, **`wsFetch` itself becomes auth-aware** based on a runtime mode:

```js
// src/lib/wsFetch.js — extended
let _mode = 'cockpit';  // 'cockpit' | 'mobile-paired'

export function setAuthMode(mode) { _mode = mode; }

export async function wsFetch(url, opts = {}) {
  if (_mode === 'mobile-paired') {
    // Ensure access token is fresh BEFORE the request. Refresh failure does
    // NOT redirect here — refreshAccessToken() has already dropped us to
    // legacy mode; the request proceeds with the sensitive-token headers and
    // only a remote-gate 401 below triggers the /m/pair redirect.
    try { await getValidAccessToken(); } catch { /* now in legacy mode */ }
  }
  const headers = { ...(opts.headers || {}) };
  if (_workspaceId) headers['X-Compose-Workspace-Id'] = _workspaceId;
  const tok = getSensitiveToken();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;  // mobile path
  // back-compat: x-compose-token still injected when relevant via withComposeToken in callers

  let r = await fetch(url, { ...opts, headers });

  // Keyed off the remote gate's distinctive body codes, NOT _mode — the mode
  // may have just been dropped to legacy by a failed refresh, but a gate 401
  // still means this server demands pairing. Localhost (gate unmounted) and
  // plain requireSensitiveToken 401s carry no `code`, so legacy mode on a
  // non-remote server can never hit this branch.
  if (r.status === 401) {
    const body = await r.clone().json().catch(() => ({}));
    if (body.code === 'TokenExpired') {
      try {
        await refreshAccessToken();   // re-enters 'mobile-paired' on success
      } catch {
        // Gate demanded a JWT and we can't mint one — re-pair is the only path.
        window.location.href = '/m/pair';
        throw new Error('NeedsPairing');
      }
      r = await fetch(url, { ...opts, headers: { ...headers, Authorization: `Bearer ${getSensitiveToken()}` } });
    }
    if (r.status === 401) {
      const again = await r.clone().json().catch(() => ({}));
      if (again.code === 'TokenExpired' || again.code === 'TokenInvalid') {
        window.location.href = '/m/pair';
        throw new Error('NeedsPairing');
      }
      // 401 without a gate code: legacy sensitive-token failure — surface normally
    }
  }

  return r;
}
```

**Dual-mode boot contract (REVISED 2026-06-11 — round-2 finding #1).** `MobileApp` does NOT unconditionally enter paired mode. On mount:

```
if (localStorage has compose:mobile:refreshToken)  → setAuthMode('mobile-paired')
else                                                → stay 'cockpit' (legacy) mode
```

Legacy mode is today's behavior verbatim: `?token=` query pairing → `setSensitiveToken` → `withComposeToken` headers; works on localhost/home-wifi exactly as shipped by COMP-MOBILE. `'mobile-paired'` is entered only after `PairPage` stores a refresh token (or on a later boot that finds one). A failed refresh in paired mode clears the stored tokens and falls back to legacy mode (not a hard redirect) when the server doesn't demand JWT auth; the redirect-to-`/m/pair` path applies only to 401s from the remote gate. Remote auth is therefore strictly additive — with remote mode off, no behavioral change anywhere. Cockpit never calls `setAuthMode`; default `'cockpit'` mode skips token refresh entirely. Auth handling stays in one place (`wsFetch`).

Direct `fetch()` callsites in mobile (e.g. raw URL calls in `useInteractiveSession.js:22`, agent-server URLs in `agentStream.js:112`) get audited and migrated to `wsFetch` as part of M2/M3/M4 hardening — not all today; M2-M4 already migrated the obvious ones via T9. Remaining direct-fetch sites are tracked in the blueprint phase.

### WebSocket auth

`createReconnectingWS` currently takes a string URL. Extend to accept `string | () => string` so the URL is computed fresh per connect (handles refresh):

```js
function resolveUrl(u) { return typeof u === 'function' ? u() : u; }
// inside connect()
const ws = new WebSocket(resolveUrl(url));
```

Backward-compatible — cockpit code passing a string keeps working. Mobile passes a function that includes the current access token as `?token=...`.

**Raw-WS migration (design-gate finding #4):** only `useRoadmapItems.js:58` uses `createReconnectingWS` today; `usePendingGates.js:46`, `useIdeas.js:75`, `useLiveAgents.js:50`, and `useActiveBuild.js:62` open raw `new WebSocket('/ws/vision')` with their own reconnect loops. **In scope:** all four migrate to `createReconnectingWS(urlFn)` so token injection lives in one place (also deletes four duplicated reconnect implementations — net LOC down). Desktop WS connects gain the same function-URL treatment (token appended only in remote mode).

Server-side `/ws/vision` handshake reads `req.url` query params, validates the JWT, accepts or rejects the upgrade. Filter `?token=` from access logs.

**WS during access-token expiry mid-connection:** server holds the connection open until the next message — JWT is checked only on connection. If a long-lived WS outlives a token (15min → next refresh), the existing socket keeps streaming; refresh happens out of band on the next HTTP request. New WS reconnects (after server restart, network hiccup) get a fresh token via the function-URL pattern. Acceptable tradeoff for v1.

### Pair page — no auth, no token

`/m/pair?code=...` is in `PUBLIC_REMOTE_ALLOWLIST` server-side, and the page itself bypasses `wsFetch`'s mobile-paired mode (uses raw `fetch` for the bootstrap exchange). After pairing succeeds, `PairPage` stores tokens, calls `setAuthMode('mobile-paired')`, then redirects.

## Security details

- **JWT implementation (decision 2026-06-11).** Minimal HS256 JWT assembled in `server/auth-store.js` on `node:crypto` primitives (`createHmac` + `timingSafeEqual`, base64url envelope) — no JWT dependency. Rationale: zero added supply-chain surface on the auth component; HMAC-SHA256 is the vetted primitive and the JWT envelope is just encoding. Only `alg: HS256` is ever accepted on verify (hardcoded; no algorithm negotiation, which removes the classic `alg:none`/RS-confusion attacks).
- **JWT signing key.** Generated on first start, stored in `.compose/data/remote-auth.json`. Rotation: `compose remote rotate-secret` invalidates ALL tokens (deliberately destructive — used after a leak).
- **Refresh token rotation + reuse detection (SPECIFIED 2026-06-11 — design-gate finding #3).** Refresh tokens are structured `<device_id>.<random-32-bytes-base64url>` so the server can map any presented token to its device without scanning. Per device the store keeps `refresh_hash` (current) plus `refresh_history` (bounded ring of the last 5 retired hashes with retirement timestamps). Refresh flow: look up device by the id prefix → hash the random part → matches `refresh_hash` → rotate (retire current into history, issue new) → matches an entry in `refresh_history` → **reuse detected, revoke the device immediately** → matches nothing → generic 401 (indistinguishable from garbage; no oracle). Rotation and the history append are a single atomic file write (temp+rename, same pattern as `writeActiveBuild`).
- **Pairing-code TTL.** 5 minutes, single use. Stored in-memory; lost on server restart. Pairing must be completed in the same server lifetime as init.
- **Rate limiting.** `POST /api/auth/pair/complete` and `/api/auth/refresh` (the two PUBLIC endpoints) rate-limited per source IP (10/min) via a ~20-line in-house fixed-window limiter (no dep exists in the codebase; not worth adding one for two endpoints). `pair/init` is already behind the sensitive token.
- **TLS warning.** When bound to non-localhost without TLS termination upstream, log a warning every 60s. Some tunnels (Cloudflare, Tailscale Funnel) terminate TLS for you; ngrok does too. Self-hosted reverse proxies are user's responsibility.
- **Origin checks.** Skip — token IS the auth. The token-in-URL pairing concern is mitigated by the 5-minute TTL and single-use nature.
- **Audit log.** Each pair, refresh, and revoke writes a line to `.compose/data/remote-auth-audit.log` with timestamp, device id, and event.

## Verification gates (post-implementation)

| Phase | Acceptance |
|---|---|
| Pairing | Run `compose remote pair --public-host=...`, scan QR with phone, see "Paired!" in CLI within 30s. PWA loads with workspace data. |
| Refresh | Wait 16 minutes (or set `ACCESS_TOKEN_TTL=60` for faster test), interact with PWA, confirm refresh fires automatically and no UI disruption. |
| Revoke | Revoke device from cockpit, observe phone's next request returns 401 → redirect to /m/pair. |
| Lifetime | Server restart preserves paired devices (refresh tokens persist; pairing codes don't). |
| Concurrent | Pair 2 phones, both work simultaneously, revoking one doesn't affect the other. |
| Reuse defense | Capture a refresh token, do a refresh (server rotates), replay the OLD refresh — server detects reuse and revokes the device. Phone's next refresh fails → re-pair. |
| Bind safety | `compose start --host=0.0.0.0` (or `COMPOSE_HOST=0.0.0.0`) without `COMPOSE_REMOTE_AUTH=enabled` refuses to start. |

## Files (preliminary)

**New (server):**
- `server/auth-routes.js` — pair/init, pair/status, pair/complete, refresh, devices list, revoke
- `server/auth-store.js` — `.compose/data/remote-auth.json` read/write, JWT sign/verify, refresh-token hash/rotate
- `server/auth-middleware.js` — `requirePairingToken`, `requireSensitiveOrPaired` composite
- `test/auth-routes.test.js`, `test/auth-store.test.js`, `test/auth-middleware.test.js`

**New (CLI):**
- `bin/compose.js` — `remote pair`, `remote list`, `remote revoke`, `remote status` subcommands
- Adds `qrcode-terminal` dep
- `test/cli-remote.test.js`

**New (cockpit):**
- `src/components/cockpit/PairDeviceModal.jsx` — QR + URL + paired devices list with revoke
- Adds `qrcode` dep for canvas rendering
- `test/ui/pair-device-modal.test.jsx`

**New (mobile):**
- `src/mobile/pages/PairPage.jsx` — handles `/m/pair?code=...`
- Routing change in `src/mobile/MobileApp.jsx` to recognize `/m/pair`
- `test/ui/mobile-pair.test.jsx`

**Modified:**
- `server/index.js` — bind to configurable host; refuse non-localhost without auth flag; mount auth routes; mount auth gate before all routes; auth check in the manual WS-upgrade handler (:143-156); `express.static(dist/)` + `/m/*` SPA fallback; `/api/agent/proxy/*` forwarder
- `server/supervisor.js` — thread `COMPOSE_HOST` to the api-server child (agent-server stays 127.0.0.1)
- `src/mobile/components/AgentCard.jsx`, `AgentDetailView.jsx` — fix latent 404: agent stop/status are 4001 routes; switch from `agentServerUrl()` to relative `wsFetch` paths
- `server/security.js` — add composite middleware
- `lib/wsReconnect.js` — accept function URL
- `src/lib/compose-api.js` — token storage (`getValidAccessToken`, `refreshAccessToken`), localStorage keys, expiry tracking
- `src/lib/wsFetch.js` — central auth-aware mode: `setAuthMode('cockpit' | 'mobile-paired')`, automatic token freshness + refresh + redirect-to-pair on hard 401. **No hook migration.** Existing mobile hooks keep using `wsFetch` unchanged; behavior changes are owned by the wrapper.
- A small audit pass on direct `fetch()` callsites in mobile code (M2/M3/M4 already migrated obvious ones; remaining stragglers — esp. `useInteractiveSession.js:22`, `agentStream.js:112` — switch to `wsFetch` to inherit auth handling)
- `index.html` — `/m/pair` recognized as mobile path (already covered by `startsWith('/m')` check)

**Estimated:** ~25 files, ~1500 LOC.

## Open questions — RESOLVED (2026-06-11, leans adopted)

1. **Default device name on pairing.** RESOLVED: prefill from platform+browser parsing of `navigator.userAgent`, editable text field.
2. **Cockpit token also subject to JWT?** RESOLVED: no — cockpit keeps the build-time `VITE_COMPOSE_API_TOKEN` on the localhost path; the JWT system is mobile/remote-only. Unifying is out of scope.
3. **Tunnel detection for status command.** RESOLVED: `compose remote status` without a configured public host prints bind/devices and prompts to run `compose remote pair --public-host=...`; with one, it HEADs `<public_host>/api/health`. It also warns when `dist/` is missing (remote needs the built bundle).
4. **Other pair-flow allowlist gaps.** RESOLVED at research: bootstrap fetches are `/m/*` (SPA fallback), `/assets/*`, `/manifest.webmanifest`, `/m-sw.js` (exists in `public/`, copied to `dist/` by Vite), plus the two auth POSTs and `/api/health`. The service worker's `SHELL` list (`public/m-sw.js:4`) caches `/m` and `/manifest.webmanifest` only — covered. Blueprint Phase 5 re-audits against the actual built `dist/`.
