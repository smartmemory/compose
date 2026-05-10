# COMP-MOBILE-REMOTE — Remote transport + auth for the mobile PWA

**Status:** DESIGN
**Created:** 2026-05-10
**Group:** COMP-MOBILE
**Predecessor:** [COMP-MOBILE](../COMP-MOBILE/design.md) (foundation: PWA + token plumbing)

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
      "refresh_hash": "<sha256(refresh_token)>",
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

**Specific routes to proxy** (mobile-only — verified from code):
- `GET /api/agent/proxy/agent/stream` → `:4002/api/agent/stream` (SSE)
- `GET /api/agent/proxy/agent/:id` → `:4002/api/agent/:id` (status)
- `POST /api/agent/proxy/agent/:id/stop` → `:4002/api/agent/:id/stop` (kill)
- `GET /api/agent/proxy/agent/session/status` → `:4002/api/agent/session/status`
- `POST /api/agent/proxy/agent/session/message` → `:4002/api/agent/session/message`

Mobile hooks (`useInteractiveSession.js:14`, `AgentDetailView.jsx:6`, `agentStream.js:112`) update their URL bases to `/api/agent/proxy/agent/...`. Desktop `AgentStream.jsx` keeps direct `:4002` calls (localhost only).

### Auth middleware — default-deny for non-localhost

`server/security.js` already has `requireSensitiveToken` (build-time token check). The new model:

**Mounted globally, BEFORE all route handlers** (after `cors`, after `express.json`, before everything else):

```
authGate(req, res, next):
  if req is from 127.0.0.1 / ::1:
    next()  // localhost = trusted, no change to cockpit behavior
  elif req.path is in PUBLIC_REMOTE_ALLOWLIST:
    next()  // /api/health, /api/auth/pair/complete, /api/auth/refresh, /m/* static
  else:
    requirePairingToken(req, res, next)
```

`PUBLIC_REMOTE_ALLOWLIST` contains exactly:
- `GET /api/health`
- `POST /api/auth/pair/complete`
- `POST /api/auth/refresh`
- All static `/m/*` and `/manifest.webmanifest`, `/m-sw.js` (PWA shell + pair page must load before auth)
- Asset paths under `/assets/`

`requirePairingToken`:
1. Reads `Authorization: Bearer <jwt>` (preferred) or `x-compose-token: <jwt>` (back-compat).
2. Verifies JWT signature + expiry against the server secret.
3. On valid token, attaches `req.device = { id, name }` and calls `next()`.
4. On invalid, returns `401 { error, code: 'TokenInvalid' }`.
5. On expired, returns `401 { error, code: 'TokenExpired' }` so the client knows to refresh.

The existing `requireSensitiveToken` (build-time token) continues to gate sensitive endpoints **on the localhost path**. On the remote path, `requirePairingToken` is sufficient — the JWT itself carries authority.

**Important:** the auth gate is mounted at the express app level, so EVERY route — including ones not enumerated in this design (vision routes, file-watcher, settings, design, sessions, ideabox) — is automatically protected from non-localhost access. No route-by-route patching.

### New routes (`server/auth-routes.js`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/pair/init` | requires sensitive token (cockpit/CLI) | Returns `{ code, expires_at, pair_url }` — code is single-use, 5-min TTL |
| `GET /api/auth/pair/status?code=...` | none (uses code as the auth) | For CLI polling — returns `{ status: "pending" \| "consumed" \| "expired" }` |
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
      // Hard fail — needs re-pairing
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(EXPIRY_KEY);
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
    // Ensure access token is fresh BEFORE the request
    try { await getValidAccessToken(); } catch { window.location.href = '/m/pair'; throw new Error('NeedsPairing'); }
  }
  const headers = { ...(opts.headers || {}) };
  if (_workspaceId) headers['X-Compose-Workspace-Id'] = _workspaceId;
  const tok = getSensitiveToken();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;  // mobile path
  // back-compat: x-compose-token still injected when relevant via withComposeToken in callers

  let r = await fetch(url, { ...opts, headers });

  if (_mode === 'mobile-paired' && r.status === 401) {
    const body = await r.clone().json().catch(() => ({}));
    if (body.code === 'TokenExpired') {
      await refreshAccessToken();
      r = await fetch(url, { ...opts, headers: { ...headers, Authorization: `Bearer ${getSensitiveToken()}` } });
    }
    if (r.status === 401) {
      window.location.href = '/m/pair';
      throw new Error('NeedsPairing');
    }
  }

  return r;
}
```

`MobileApp` calls `setAuthMode('mobile-paired')` on mount. Cockpit doesn't call it; default `'cockpit'` mode skips token refresh entirely. **Every existing call site (mobile hooks AND cockpit) keeps working without code changes** — auth handling is now in one place.

Direct `fetch()` callsites in mobile (e.g. raw URL calls in `useInteractiveSession.js:22`, agent-server URLs in `agentStream.js:112`) get audited and migrated to `wsFetch` as part of M2/M3/M4 hardening — not all today; M2-M4 already migrated the obvious ones via T9. Remaining direct-fetch sites are tracked in the blueprint phase.

### WebSocket auth

`createReconnectingWS` currently takes a string URL. Extend to accept `string | () => string` so the URL is computed fresh per connect (handles refresh):

```js
function resolveUrl(u) { return typeof u === 'function' ? u() : u; }
// inside connect()
const ws = new WebSocket(resolveUrl(url));
```

Backward-compatible — cockpit code passing a string keeps working. Mobile passes a function that includes the current access token as `?token=...`.

Server-side `/ws/vision` handshake reads `req.url` query params, validates the JWT, accepts or rejects the upgrade. Filter `?token=` from access logs.

**WS during access-token expiry mid-connection:** server holds the connection open until the next message — JWT is checked only on connection. If a long-lived WS outlives a token (15min → next refresh), the existing socket keeps streaming; refresh happens out of band on the next HTTP request. New WS reconnects (after server restart, network hiccup) get a fresh token via the function-URL pattern. Acceptable tradeoff for v1.

### Pair page — no auth, no token

`/m/pair?code=...` is in `PUBLIC_REMOTE_ALLOWLIST` server-side, and the page itself bypasses `wsFetch`'s mobile-paired mode (uses raw `fetch` for the bootstrap exchange). After pairing succeeds, `PairPage` stores tokens, calls `setAuthMode('mobile-paired')`, then redirects.

## Security details

- **JWT signing key.** Generated on first start, stored in `.compose/data/remote-auth.json`. Rotation: `compose remote rotate-secret` invalidates ALL tokens (deliberately destructive — used after a leak).
- **Refresh token rotation.** Each refresh issues a new refresh token; old one is invalidated. Theft detection: if an old refresh token is used after rotation, **revoke the device immediately** (well-known refresh-token-reuse defense).
- **Pairing-code TTL.** 5 minutes, single use. Stored in-memory; lost on server restart. Pairing must be completed in the same server lifetime as init.
- **Rate limiting.** `POST /api/auth/pair/init` and `/refresh` rate-limited per source IP (10/min). Pair-complete is naturally rate-limited by the code TTL.
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
- `server/index.js` — bind to configurable host; refuse non-localhost without auth flag; mount auth routes
- `server/security.js` — add composite middleware
- `lib/wsReconnect.js` — accept function URL
- `src/lib/compose-api.js` — token storage (`getValidAccessToken`, `refreshAccessToken`), localStorage keys, expiry tracking
- `src/lib/wsFetch.js` — central auth-aware mode: `setAuthMode('cockpit' | 'mobile-paired')`, automatic token freshness + refresh + redirect-to-pair on hard 401. **No hook migration.** Existing mobile hooks keep using `wsFetch` unchanged; behavior changes are owned by the wrapper.
- A small audit pass on direct `fetch()` callsites in mobile code (M2/M3/M4 already migrated obvious ones; remaining stragglers — esp. `useInteractiveSession.js:22`, `agentStream.js:112` — switch to `wsFetch` to inherit auth handling)
- `index.html` — `/m/pair` recognized as mobile path (already covered by `startsWith('/m')` check)

**Estimated:** ~25 files, ~1500 LOC.

## Open questions

1. **Default device name on pairing.** Use `navigator.userAgent` parsing, or just ask the user to type one? Lean: prefill with platform+browser, allow edit.
2. **Cockpit token also subject to JWT?** Today the cockpit uses build-time `VITE_COMPOSE_API_TOKEN`. Keeping that for the cockpit (it's localhost-only) means the JWT system is mobile-only. Simplest. If we want unified, that's a much bigger refactor — out of scope.
3. **Tunnel detection for status command.** `compose remote status` does a HEAD request to the public host. If the user hasn't set one, we can't verify reachability. Lean: prompt to run `compose remote pair --public-host=...` first.
4. **Are there other pair-flow allowlist gaps?** `/m/*` static + `/api/auth/pair/complete` + `/api/auth/refresh` are already in `PUBLIC_REMOTE_ALLOWLIST`. Audit during blueprint phase that no other bootstrap path leaks (e.g., manifest fetches, SW registration).
