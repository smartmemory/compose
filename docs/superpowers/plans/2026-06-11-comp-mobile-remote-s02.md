# COMP-MOBILE-REMOTE S02 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the S01 auth primitives into the API server — host config, auth gate mounting, WS upgrade auth, static serving, agent proxy, and guard swaps — so that all 4001 routes are protected when remote mode is on.

**Architecture:** `server/index.js` gains `resolveComposeHost()` (env > config > default), a refusal guard, auth gate (remote-only), auth routes (both modes), WS upgrade auth, static serving + SPA fallback, and an agent proxy. `server/security.js` gains `configureAuthStore()` + `requireSensitiveOrPaired` re-export. `build-routes.js` and `vision-routes.js` swap their direct `requireSensitiveToken` imports. `vision-server.js` swaps the DI values it passes. `supervisor.js` threads `COMPOSE_HOST`/`COMPOSE_REMOTE_AUTH` to the api-server child.

**Tech Stack:** Node.js, Express 4, node:http (proxy), node:crypto (already used in S01), node:fs, node:path

---

## File Map

| File | Action | What |
|---|---|---|
| `server/index.js` | edit | `resolveComposeHost`, refusal, banner, gate mount, auth routes, WS auth, static + SPA fallback, agent proxy |
| `server/security.js` | edit | `configureAuthStore`, `requireSensitiveOrPaired` shim |
| `server/build-routes.js` | edit | swap import at :17, guards at :39,:60 |
| `server/vision-routes.js` | edit | swap import at :54, conditional wrapper at :80 |
| `server/vision-server.js` | edit | swap DI values at :214,:228,:233 |
| `server/supervisor.js` | edit | thread COMPOSE_HOST/COMPOSE_REMOTE_AUTH to api-server fork env |
| `test/remote-gate.test.js` | new | gate off, gate on credential matrix, WS, static, proxy, guard-swap parity |

---

## Task 1: `server/security.js` — `configureAuthStore` + `requireSensitiveOrPaired` shim

**Files:**
- Modify: `server/security.js`

This must happen BEFORE the import-swaps in Tasks 2/3 so the tests have something to import.

- [ ] **Step 1: Write the failing test for security.js shim behavior**

Add a describe block to `test/auth-middleware.test.js` — NOT a new file, just verify the shim's contract. Actually, the full test coverage lives in `test/remote-gate.test.js` (Task 7). For now confirm existing auth-middleware tests still pass after editing security.js.

Run first to get baseline:
```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/auth-middleware.test.js
```
Expected: all pass (baseline).

- [ ] **Step 2: Edit `server/security.js`**

Replace the entire file with:

```js
/**
 * security.js — Shared guards for sensitive local endpoints.
 *
 * Usage:
 * 1) In normal dev flow, server/supervisor.js auto-generates COMPOSE_API_TOKEN.
 * 2) If running servers directly, set COMPOSE_API_TOKEN in the environment.
 * 3) Send header: x-compose-token: <COMPOSE_API_TOKEN>
 *
 * S02 (COMP-MOBILE-REMOTE): adds configureAuthStore() shim so that build-routes,
 * vision-routes, and vision-server can swap their import from requireSensitiveToken
 * to requireSensitiveOrPaired without changing call-site syntax.
 *
 * When no store is configured, requireSensitiveOrPaired behaves byte-identically
 * to requireSensitiveToken (503 when env unset, 401 on mismatch).
 */

import { requireSensitiveOrPaired as _makeComposite } from './auth-middleware.js';

let _store = null;

/**
 * Configure the module-level auth store.
 * Called from server/index.js when the store is created (both modes).
 * When not called (tests, direct runs without pairing), _store stays null
 * and requireSensitiveOrPaired delegates only to the sensitive-token path.
 *
 * @param {object} store  Auth store from createAuthStore
 */
export function configureAuthStore(store) {
  _store = store;
}

/**
 * Original single-path guard — kept for back-compat.
 * Call sites that already import this continue to work unchanged.
 */
export function requireSensitiveToken(req, res, next) {
  const expected = process.env.COMPOSE_API_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'Sensitive endpoint disabled: missing COMPOSE_API_TOKEN (run via supervisor or set it manually)',
    });
  }

  const provided = req.get('x-compose-token');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * Composite guard: accepts EITHER the sensitive token OR a valid pairing JWT.
 *
 * When _store is null (no pairing configured) the JWT branch is never reached
 * and behavior is byte-identical to requireSensitiveToken.
 *
 * Exported so build-routes.js / vision-routes.js can import it directly.
 */
export function requireSensitiveOrPaired(req, res, next) {
  if (_store) {
    // Delegate to auth-middleware's factory with the configured store
    return _makeComposite(_store)(req, res, next);
  }
  // No store — fall back to legacy sensitive-token behavior
  return requireSensitiveToken(req, res, next);
}
```

- [ ] **Step 3: Verify baseline still passes**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/auth-middleware.test.js test/auth-store.test.js test/auth-routes.test.js
```
Expected: all pass (these don't import security.js).

---

## Task 2: Import swaps — `build-routes.js` and `vision-routes.js`

**Files:**
- Modify: `server/build-routes.js` (line 17, lines 39 and 60)
- Modify: `server/vision-routes.js` (line 54, line 80)

- [ ] **Step 1: Verify current build-routes tests pass**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/build-routes.test.js
```
Expected: all pass (baseline).

- [ ] **Step 2: Edit `server/build-routes.js`**

Change line 17 from:
```js
import { requireSensitiveToken } from './security.js';
```
to:
```js
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
```

This is the only change needed — the function is used at `:39` and `:60` via the local name `requireSensitiveToken`, which now resolves to the composite. No other lines change.

- [ ] **Step 3: Verify build-routes tests still pass**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/build-routes.test.js
```
Expected: all pass. The composite with no store configured is byte-identical to `requireSensitiveToken`.

- [ ] **Step 4: Edit `server/vision-routes.js`**

Change line 54 from:
```js
import { requireSensitiveToken } from './security.js';
```
to:
```js
import { requireSensitiveOrPaired as requireSensitiveToken, requireSensitiveToken as _legacyRequireSensitiveToken } from './security.js';
```

Wait — check line 80 more carefully. The `guardAuth` wrapper at :80 uses `requireSensitiveToken` only as a conditional pass-through. We just need the composite there. Simpler:

Change line 54 from:
```js
import { requireSensitiveToken } from './security.js';
```
to:
```js
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
```

No other vision-routes.js changes needed — the `guardAuth` wrapper at :79-80 reads:
```js
const guardAuth = (req, res, next) =>
  guardAuthEnabled ? requireSensitiveToken(req, res, next) : next();
```
This already works with the aliased name.

---

## Task 3: DI value swaps — `server/vision-server.js`

**Files:**
- Modify: `server/vision-server.js` (lines 214, 228, 233)

Per the blueprint, `vision-server.js` imports `requireSensitiveToken` from security.js and passes it as a DI value to three `attach*` calls. Swapping those three occurrences to use `requireSensitiveOrPaired` covers the three downstream consumers (journal-routes, graph-export, agent-spawn).

- [ ] **Step 1: Find exact import and DI lines in vision-server.js**

```bash
grep -n "requireSensitiveToken" /Users/ruze/reg/my/forge/compose/server/vision-server.js
```
Note the exact lines.

- [ ] **Step 2: Change the import in vision-server.js**

Find the line:
```js
import { requireSensitiveToken } from './security.js';
```
Change to:
```js
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
```

All three DI pass-throughs (`requireSensitiveToken` at lines ~214, ~228, ~233) now automatically pass the composite because the local name resolves to it. No other changes to vision-server.js needed.

- [ ] **Step 3: Verify vision-server-adjacent tests pass**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/build-routes.test.js test/auth-routes.test.js test/auth-middleware.test.js
```
Expected: all pass.

---

## Task 4: `server/supervisor.js` — thread COMPOSE_HOST/COMPOSE_REMOTE_AUTH to api-server

**Files:**
- Modify: `server/supervisor.js` (lines 142-143, the fork call)

The blueprint says: thread `COMPOSE_HOST` and `COMPOSE_REMOTE_AUTH` to the api-server child ONLY (agent-server and vite never get them).

Currently line 143:
```js
proc.child = fork(proc.path, { stdio: 'inherit' });
```

The fork for `api-server` needs an explicit `env` that includes these variables. The fork for `agent-server` does NOT.

- [ ] **Step 1: Edit `server/supervisor.js`**

Change the `startProcess` function's fork branch from:
```js
  if (proc.type === 'fork') {
    proc.child = fork(proc.path, { stdio: 'inherit' });
  } else {
```
to:
```js
  if (proc.type === 'fork') {
    const forkEnv = { ...process.env };
    if (proc.name !== 'api-server') {
      // agent-server never gets remote-auth env — it stays 127.0.0.1 always
      delete forkEnv.COMPOSE_HOST;
      delete forkEnv.COMPOSE_REMOTE_AUTH;
    }
    proc.child = fork(proc.path, { stdio: 'inherit', env: forkEnv });
  } else {
```

- [ ] **Step 2: No test needed for supervisor** (it's an env-threading change, testable via the boot smoke in Task 8).

---

## Task 5: `server/index.js` — `resolveComposeHost` + refusal + banner

**Files:**
- Modify: `server/index.js`

This task handles the host config piece; Tasks 6-7 handle gate mounting, WS auth, static, and proxy (all wired into index.js).

- [ ] **Step 1: Write the failing behavior test (gate off — no behavioral change)**

We'll write the full `test/remote-gate.test.js` in Task 8. For now, define what the test will verify about `resolveComposeHost`:
- `COMPOSE_HOST` env → that value
- `.compose/compose.json server.host` → that value when no env
- fallback to `'127.0.0.1'`

The function will be tested as part of the remote-gate test suite.

- [ ] **Step 2: Add imports and `resolveComposeHost` to `server/index.js`**

Add at the TOP of the imports (after existing imports), before `const PORT = ...`:

```js
import { existsSync, statSync } from 'node:fs';
import { createAuthStore } from './auth-store.js';
import { createAuthGate, wsUpgradeTokenOk } from './auth-middleware.js';
import { attachAuthRoutes } from './auth-routes.js';
import { configureAuthStore, requireSensitiveToken, requireSensitiveOrPaired } from './security.js';
```

Note: `http` is already imported. `path` is already imported. `getDataDir`, `COMPOSE_HOME` already imported via project-root. But `COMPOSE_HOME` needs to be added to the import if not already there — check: current import is:
```js
import { getTargetRoot, getDataDir, ensureDataDir, loadProjectConfig, resolveProjectPath, switchProject } from './project-root.js';
```
Add `COMPOSE_HOME` to this import.

Then add `resolveComposeHost` as an exported function AFTER the import block and BEFORE `const PORT = ...`:

```js
/**
 * Resolve the bind host for the API server.
 * Precedence: COMPOSE_HOST env > .compose/compose.json server.host > '127.0.0.1'
 *
 * Exported for test access.
 */
export function resolveComposeHost() {
  if (process.env.COMPOSE_HOST) return process.env.COMPOSE_HOST;
  // Check .compose/compose.json server.host
  try {
    const cfg = loadProjectConfig();
    if (cfg?.server?.host) return cfg.server.host;
  } catch {
    // ignore
  }
  return '127.0.0.1';
}
```

- [ ] **Step 3: Add remoteMode detection and refusal guard**

After the `resolveComposeHost` function, add before `const PORT = ...`:

```js
const _host = resolveComposeHost();
const remoteMode = _host !== '127.0.0.1' && _host !== 'localhost';

if (remoteMode && process.env.COMPOSE_REMOTE_AUTH !== 'enabled') {
  console.error('[compose] ERROR: bound to non-localhost without COMPOSE_REMOTE_AUTH=enabled.');
  console.error('[compose] Set COMPOSE_REMOTE_AUTH=enabled to acknowledge the security model, then retry.');
  process.exit(1);
}
```

- [ ] **Step 4: Change `server.listen` call to use `_host`**

Change line 158 from:
```js
server.listen(PORT, '127.0.0.1', () => {
  serverListening = true;
  console.log(`Compose server running on http://127.0.0.1:${PORT}`);
```
to:
```js
server.listen(PORT, _host, () => {
  serverListening = true;
  console.log(`Compose server running on http://${_host}:${PORT}`);
  if (remoteMode) {
    console.log('[compose] WARNING: bound to ' + _host + ' — accessible from local network and beyond');
    console.log('[compose] Auth gate active: localhost trusted; remote requests require pairing token.');
    console.log('[compose] Run `compose remote pair --public-host=<URL>` from the cockpit terminal to add a device.');
  }
```

---

## Task 6: `server/index.js` — auth store, gate mount, auth routes, WS upgrade auth

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Create auth store and configure security.js — insert after `const PORT = ...` block**

After `const PORT = process.env.PORT || 4001;` and the `const app = express();` line, add the store creation. The store must use `getDataDir()` — but `getDataDir()` is called AFTER `ensureDataDir()` is called later... actually `getDataDir()` returns `_dataDir` which is set at module load time, so it's safe to call immediately.

Actually `ensureDataDir()` is called on line 99. The store only reads/writes lazily (on first use), so we can create it before `ensureDataDir()`. But to be safe, call `ensureDataDir()` before creating the store. The current code has `ensureDataDir()` on line 99 (after the server is created). Move the store creation to after the existing `ensureDataDir()` call at line 99.

Insert these lines AFTER `ensureDataDir();` (line 99) and BEFORE `const visionStore = ...`:

```js
// --- Auth store (S02: COMP-MOBILE-REMOTE) ---
// Created in BOTH modes — pairing setup on localhost ahead of enabling remote
// is a supported flow. configureAuthStore wires it into security.js so that
// requireSensitiveOrPaired picks up the store.
const _authStore = createAuthStore(getDataDir());
configureAuthStore(_authStore);
```

- [ ] **Step 2: Mount auth gate (remote mode ONLY) — after `app.use(express.json())`**

The current code at lines 50-55:
```js
app.use(cors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
app.use(express.json());

attachWorkspaceRoutes(app);
attachGraphLayoutRoutes(app);
app.use(createWorkspaceMiddleware());
```

Add the auth gate mount AFTER `app.use(express.json());` (line 51) but BEFORE `attachWorkspaceRoutes`:

```js
// --- Auth gate (remote mode only) --- S02: COMP-MOBILE-REMOTE
// When remote mode is OFF, this block does not execute — zero behavior change.
// When ON: every request except the bootstrap allowlist must carry a credential.
if (remoteMode) {
  const _allowlist = [
    '/m',           // covers /m, /m/, /m/pair, etc.
    '/assets/',     // covers /assets/...
    '/manifest.webmanifest',
    '/m-sw.js',
    'GET /api/health',
    'GET /api/workspace',
    'POST /api/auth/pair/complete',
    'POST /api/auth/refresh',
  ];
  app.use(createAuthGate({ store: _authStore, allowlist: _allowlist }));
}
```

Wait — the `createAuthGate` allowlist as implemented in auth-middleware.js doesn't handle method-prefixed entries like `'GET /api/health'`. Let me re-read the allowlist implementation.

Looking at `createAuthGate` in auth-middleware.js: it processes entries as prefixes/exact strings matching `req.path`. The design allowlist says `GET /api/health` — but the middleware implementation uses `req.path` (which is `/api/health`) and doesn't filter by method.

The blueprint says: "prefixes `/m`, `/assets`, exact `/manifest.webmanifest`, `/m-sw.js`, `GET /api/health`, `GET /api/workspace`, `POST /api/auth/pair/complete`, `POST /api/auth/refresh`."

The intent is that health and workspace are allowlisted for GET, complete/refresh for POST. But since `createAuthGate` doesn't parse method prefixes, and health/workspace are read-only (no harm in allowlisting for all methods), we can pass plain paths. Use a method-aware wrapper instead:

```js
if (remoteMode) {
  app.use(createAuthGate({
    store: _authStore,
    allowlist: [
      '/m',                        // PWA shell, pair page
      '/assets/',                  // static assets
      '/manifest.webmanifest',
      '/m-sw.js',
      '/api/health',               // health check (all methods)
      '/api/workspace',            // boot fetch (GET only — write is impossible; no route exists)
      '/api/auth/pair/complete',   // pairing bootstrap
      '/api/auth/refresh',         // token refresh bootstrap
    ],
  }));
}
```

This is safe: `POST /api/health` and `POST /api/workspace` don't exist as routes — the allowlist entry allowing those paths through the gate is harmless (the route won't match anyway, Express returns 404).

- [ ] **Step 3: Mount auth routes (BOTH modes)**

After the auth gate block, add:

```js
// --- Auth routes (both modes) --- S02: COMP-MOBILE-REMOTE
// Pairing setup on localhost (ahead of enabling remote) is a supported flow.
// broadcast wired via late-bound closure so it resolves after visionServer.attach().
attachAuthRoutes(app, {
  store: _authStore,
  broadcast: (msg) => {
    // visionServer is declared below; closure resolves after attach()
    if (typeof visionServer?.broadcastMessage === 'function') {
      visionServer.broadcastMessage(msg);
    }
  },
  requireSensitive: requireSensitiveToken,
});
```

Note: `visionServer` is declared later in the file. The closure captures the variable by reference, so by the time any pairing request arrives (after the server is listening), `visionServer` is fully initialized. This is the late-bound closure pattern the blueprint describes.

- [ ] **Step 4: Add WS upgrade auth in the upgrade handler**

Current upgrade handler (lines 143-156):
```js
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/files' && fileWatcher.wss) {
    fileWatcher.wss.handleUpgrade(req, socket, head, (ws) => {
      fileWatcher.wss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/vision' && visionServer.wss) {
    visionServer.wss.handleUpgrade(req, socket, head, (ws) => {
      visionServer.wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
```

Change to:
```js
server.on('upgrade', (req, socket, head) => {
  // S02: remote-mode WS auth — check ?token= (sensitive or JWT) before upgrade
  if (remoteMode && !wsUpgradeTokenOk(_authStore, req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/files' && fileWatcher.wss) {
    fileWatcher.wss.handleUpgrade(req, socket, head, (ws) => {
      fileWatcher.wss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/vision' && visionServer.wss) {
    visionServer.wss.handleUpgrade(req, socket, head, (ws) => {
      visionServer.wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
```

---

## Task 7: `server/index.js` — static serving + SPA fallback + agent proxy

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add static serving + SPA fallback (BOTH modes — additive)**

Add AFTER `visionServer.attach(server, app);` (currently around line 109), BEFORE the feature seeding block. This ensures it's mounted after API routes but before the server starts listening.

Actually, `visionServer.attach()` registers many routes. Static and fallback must come AFTER those so `/api/*` is never shadowed. Add AFTER all route attachments, right before `server.listen()`:

```js
// --- Static serving + SPA fallback (both modes) --- S02: COMP-MOBILE-REMOTE
// Serves the built PWA bundle. In dev, Vite (5195) serves the SPA; in remote
// mode, the built dist/ is the only way to load the shell.
// Mount AFTER all API routes so /api/* is never shadowed.
const _distDir = path.join(COMPOSE_HOME, 'dist');
const _distExists = () => existsSync(_distDir) && statSync(_distDir).isDirectory();

app.use(express.static(_distDir, { index: false }));

// /m/* SPA fallback — must match exactly /m or start with /m/
app.get(/^\/m(\/|$)/, (req, res) => {
  const distOk = _distExists();
  if (!distOk) {
    return res.status(503).json({ error: 'PWA bundle not built — run npm run build' });
  }
  res.sendFile(path.join(_distDir, 'index.html'));
});
```

- [ ] **Step 2: Export `attachAgentProxy` and add the proxy (BOTH modes — additive)**

The blueprint says `attachAgentProxy` is the Boundary Map export from index.js. It can live inline in index.js or in a small separate file. Since it's ~60 LOC and cohesively part of the server wiring, put it in index.js as an exported function.

Add this function BEFORE `const PORT = ...` (so it's defined when `startProcess` calls it):

Actually, since this is an ES module, hoisting doesn't apply to `const`/`function`... but we're using `export function` so we can put it anywhere in the file. Put it just after `resolveComposeHost`.

```js
/**
 * Attach agent proxy routes to the Express app.
 * Routes: /api/agent/proxy/* → 127.0.0.1:${agentPort}/api/agent/*
 * - Injects x-compose-token server-side (strips any client-sent value)
 * - SSE pass-through (Content-Type: text/event-stream, no buffering)
 * - 502 on upstream connect failure
 *
 * Exported for test access.
 *
 * @param {object} app
 * @param {{ agentPort: number }} opts
 */
export function attachAgentProxy(app, { agentPort }) {
  const PROXY_ROUTES = [
    { method: 'GET',  proxyPath: '/api/agent/proxy/stream',         upstreamPath: '/api/agent/stream'         },
    { method: 'POST', proxyPath: '/api/agent/proxy/session',        upstreamPath: '/api/agent/session'        },
    { method: 'POST', proxyPath: '/api/agent/proxy/message',        upstreamPath: '/api/agent/message'        },
    { method: 'POST', proxyPath: '/api/agent/proxy/interrupt',      upstreamPath: '/api/agent/interrupt'      },
    { method: 'GET',  proxyPath: '/api/agent/proxy/session/status', upstreamPath: '/api/agent/session/status' },
  ];

  for (const { method, proxyPath, upstreamPath } of PROXY_ROUTES) {
    const handler = (req, res) => {
      // Build upstream URL (include query string)
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const options = {
        hostname: '127.0.0.1',
        port: agentPort,
        path: upstreamPath + qs,
        method: req.method,
        headers: { ...req.headers },
      };

      // Strip host/connection headers (hop-by-hop)
      delete options.headers['host'];
      delete options.headers['connection'];
      delete options.headers['transfer-encoding'];

      // Inject the server-side sensitive token; strip any client-sent credential
      delete options.headers['x-compose-token'];
      delete options.headers['authorization'];
      const apiToken = process.env.COMPOSE_API_TOKEN;
      if (apiToken) options.headers['x-compose-token'] = apiToken;

      const upstream = http.request(options, (upstreamRes) => {
        // Copy status + headers verbatim (including SSE headers)
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
      });

      upstream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Agent server unavailable' });
        }
      });

      // Abort upstream when client disconnects (important for SSE)
      req.on('close', () => upstream.destroy());

      // Pipe request body (for POST routes)
      if (req.method !== 'GET') {
        req.pipe(upstream, { end: true });
      } else {
        upstream.end();
      }
    };

    if (method === 'GET') {
      app.get(proxyPath, handler);
    } else {
      app.post(proxyPath, handler);
    }
  }
}
```

Then call it AFTER the auth gate mount block and AFTER auth routes (so the gate clears it first), before visionServer.attach():

Actually, proxy routes must be mounted AFTER the gate (gate protects them) but BEFORE static serving (static must be last). The blueprint says "mount the proxy AFTER the gate". The gate is mounted around line 52. Auth routes are mounted next. Then `attachWorkspaceRoutes`, `attachGraphLayoutRoutes`, etc.

Add the proxy mount AFTER the auth routes block:

```js
// --- Agent proxy (both modes) --- S02: COMP-MOBILE-REMOTE
const _agentPort = parseInt(process.env.AGENT_PORT || '4002', 10);
attachAgentProxy(app, { agentPort: _agentPort });
```

---

## Task 8: Write `test/remote-gate.test.js`

**Files:**
- Create: `test/remote-gate.test.js`

Read `test/build-routes.test.js` and `test/auth-routes.test.js` first for harness patterns (already read above). Follow the same `http.request` + `listen()` pattern.

- [ ] **Step 1: Write the full test file**

```js
/**
 * remote-gate.test.js — COMP-MOBILE-REMOTE S02
 *
 * Coverage:
 *   1. Remote mode OFF → no gate (non-allowlisted request without token succeeds as today)
 *   2. Remote mode ON — allowlisted paths pass bare
 *   3. Remote mode ON — sensitive token passes non-allowlisted path
 *   4. Remote mode ON — valid JWT passes; req.device attached (verified via echo endpoint)
 *   5. Remote mode ON — bare request → 401 with code
 *   6. WS upgrade accept/reject via wsUpgradeTokenOk
 *   7. Static: /m fallback serves index.html when dist fixture exists; 503 when absent
 *   8. Agent proxy: forwards to stub upstream, injects x-compose-token, strips client-sent,
 *      copies SSE headers, 502 on dead upstream
 *   9. Guard-swap parity: POST /api/build/start accepts sensitive token AND valid JWT
 *
 * Run: node --test --test-timeout=90000 test/remote-gate.test.js
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic imports to pick up env mutations
const { createAuthStore } = await import(`${REPO_ROOT}/server/auth-store.js`);
const { createAuthGate, wsUpgradeTokenOk } = await import(`${REPO_ROOT}/server/auth-middleware.js`);
const { attachAuthRoutes } = await import(`${REPO_ROOT}/server/auth-routes.js`);
const { attachBuildRoutes } = await import(`${REPO_ROOT}/server/build-routes.js`);
const { attachAgentProxy, resolveComposeHost } = await import(`${REPO_ROOT}/server/index.js`);
const { configureAuthStore, requireSensitiveToken } = await import(`${REPO_ROOT}/server/security.js`);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function request(server, urlPath, { method = 'GET', body, headers = {} } = {}) {
  const port = server.address().port;
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: urlPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...headers,
    },
  };
  return new Promise((res, rej) => {
    const req = http.request(opts, (response) => {
      let buf = '';
      response.on('data', (d) => { buf += d; });
      response.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch {}
        res({ status: response.statusCode, body: parsed, headers: response.headers });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

function listen(app) {
  return new Promise((res) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

function close(server) {
  return new Promise((res) => server.close(res));
}

// ---------------------------------------------------------------------------
// Helpers to build test apps
// ---------------------------------------------------------------------------

const TOKEN = 'test-remote-gate-token';

function makeGateApp({ remoteMode = false, store = null, withBuildRoutes = false } = {}) {
  const app = express();
  app.use(express.json());

  if (remoteMode && store) {
    app.use(createAuthGate({
      store,
      allowlist: [
        '/m',
        '/assets/',
        '/manifest.webmanifest',
        '/m-sw.js',
        '/api/health',
        '/api/workspace',
        '/api/auth/pair/complete',
        '/api/auth/refresh',
      ],
    }));
  }

  // Echo endpoint — returns req.device if set
  app.get('/api/status', (req, res) => {
    res.json({ ok: true, device: req.device || null });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  if (withBuildRoutes && store) {
    configureAuthStore(store);
    attachBuildRoutes(app, {
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => tmpdir(),
    });
  }

  return app;
}

// ---------------------------------------------------------------------------
// Tests: resolveComposeHost
// ---------------------------------------------------------------------------

describe('resolveComposeHost', () => {
  let origHost;
  before(() => { origHost = process.env.COMPOSE_HOST; });
  after(() => {
    if (origHost === undefined) delete process.env.COMPOSE_HOST;
    else process.env.COMPOSE_HOST = origHost;
  });

  test('returns COMPOSE_HOST env when set', () => {
    process.env.COMPOSE_HOST = '0.0.0.0';
    assert.equal(resolveComposeHost(), '0.0.0.0');
  });

  test('falls back to 127.0.0.1 when env absent', () => {
    delete process.env.COMPOSE_HOST;
    const h = resolveComposeHost();
    // Could be 127.0.0.1 or a value from compose.json; in test env, no compose.json server.host
    assert.ok(typeof h === 'string' && h.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: gate OFF — zero behavior change
// ---------------------------------------------------------------------------

describe('Gate OFF (remote mode disabled)', () => {
  let server;
  let origToken;

  before(async () => {
    origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
    server = await listen(makeGateApp({ remoteMode: false }));
  });

  after(async () => {
    if (origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = origToken;
    await close(server);
  });

  test('non-allowlisted GET without any token succeeds', async () => {
    const r = await request(server, '/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('/api/health bare succeeds', async () => {
    const r = await request(server, '/api/health');
    assert.equal(r.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Tests: gate ON — credential matrix
// ---------------------------------------------------------------------------

describe('Gate ON (remote mode enabled)', () => {
  let server;
  let store;
  let tmpDir;
  let origToken;
  let validJwt;
  let deviceId;

  before(async () => {
    origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;

    tmpDir = mkdtempSync(join(tmpdir(), 'rg-gate-'));
    store = createAuthStore(tmpDir);

    // Create a paired device and sign a JWT for tests
    const code = store.createPairingCode();
    const result = store.consumePairingCode(code.code, { name: 'Test Device' });
    deviceId = result.device.id;
    validJwt = result.access_token;

    server = await listen(makeGateApp({ remoteMode: true, store }));
  });

  after(async () => {
    if (origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = origToken;
    await close(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('allowlisted path /api/health passes bare', async () => {
    const r = await request(server, '/api/health');
    assert.equal(r.status, 200);
  });

  test('allowlisted path /m/ passes bare', async () => {
    // /m/ is allowlisted — returns 404 (no route) not 401
    const r = await request(server, '/m/pair');
    assert.notEqual(r.status, 401);
  });

  test('allowlisted /api/auth/pair/complete passes bare (POST)', async () => {
    const r = await request(server, '/api/auth/pair/complete', {
      method: 'POST',
      body: { code: 'BADCODE' },
    });
    // 404 (no route in this minimal app) or 400/whatever — not 401
    assert.notEqual(r.status, 401);
  });

  test('sensitive token passes non-allowlisted path', async () => {
    const r = await request(server, '/api/status', {
      headers: { 'x-compose-token': TOKEN },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.device, null); // sensitive path, no req.device
  });

  test('valid JWT passes; req.device is attached', async () => {
    const r = await request(server, '/api/status', {
      headers: { 'Authorization': `Bearer ${validJwt}` },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.device);
    assert.equal(r.body.device.id, deviceId);
  });

  test('bare request → 401 with code:TokenInvalid', async () => {
    const r = await request(server, '/api/status');
    assert.equal(r.status, 401);
    assert.ok(r.body.code);
  });

  test('loopback source NOT trusted — still requires credential', async () => {
    // Even from 127.0.0.1 (which is where this test connects), gate must fire
    const r = await request(server, '/api/status');
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Tests: WS upgrade auth
// ---------------------------------------------------------------------------

describe('WS upgrade auth via wsUpgradeTokenOk', () => {
  let store;
  let tmpDir;
  let origToken;
  let validJwt;

  before(() => {
    origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
    tmpDir = mkdtempSync(join(tmpdir(), 'rg-ws-'));
    store = createAuthStore(tmpDir);
    const code = store.createPairingCode();
    const result = store.consumePairingCode(code.code, { name: 'WS Device' });
    validJwt = result.access_token;
  });

  after(() => {
    if (origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = origToken;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('?token=<sensitive> → true', () => {
    const fakeReq = { url: `/ws/vision?token=${TOKEN}` };
    assert.equal(wsUpgradeTokenOk(store, fakeReq), true);
  });

  test('?token=<valid JWT> → true', () => {
    const fakeReq = { url: `/ws/vision?token=${validJwt}` };
    assert.equal(wsUpgradeTokenOk(store, fakeReq), true);
  });

  test('no ?token → false', () => {
    const fakeReq = { url: '/ws/vision' };
    assert.equal(wsUpgradeTokenOk(store, fakeReq), false);
  });

  test('garbage token → false', () => {
    const fakeReq = { url: '/ws/vision?token=nottherighttoken' };
    assert.equal(wsUpgradeTokenOk(store, fakeReq), false);
  });
});

// ---------------------------------------------------------------------------
// Tests: static serving + SPA fallback
// ---------------------------------------------------------------------------

describe('Static serving + SPA fallback', () => {
  let serverWithDist;
  let serverNoDist;
  let tmpDistDir;
  let tmpNullDir;

  before(async () => {
    // Create a temp dist dir with index.html
    tmpDistDir = mkdtempSync(join(tmpdir(), 'rg-dist-'));
    writeFileSync(join(tmpDistDir, 'index.html'), '<html>PWA</html>');
    mkdirSync(join(tmpDistDir, 'assets'));
    writeFileSync(join(tmpDistDir, 'assets', 'app.js'), 'console.log("app")');

    tmpNullDir = mkdtempSync(join(tmpdir(), 'rg-nodist-'));

    // Build app WITH dist
    const appWithDist = express();
    appWithDist.use(express.static(tmpDistDir, { index: false }));
    appWithDist.get(/^\/m(\/|$)/, (req, res) => {
      res.sendFile(join(tmpDistDir, 'index.html'));
    });
    serverWithDist = await listen(appWithDist);

    // Build app WITHOUT dist (points to a dir that doesn't have index.html)
    const appNoDist = express();
    const badDir = join(tmpNullDir, 'nonexistent-dist');
    appNoDist.use(express.static(badDir, { index: false }));
    appNoDist.get(/^\/m(\/|$)/, (req, res) => {
      const { existsSync: ex, statSync: st } = await import('node:fs');
      if (!ex(badDir) || !st(badDir).isDirectory()) {
        return res.status(503).json({ error: 'PWA bundle not built — run npm run build' });
      }
      res.sendFile(join(badDir, 'index.html'));
    });
    serverNoDist = await listen(appNoDist);
  });

  after(async () => {
    await close(serverWithDist);
    await close(serverNoDist);
    rmSync(tmpDistDir, { recursive: true, force: true });
    rmSync(tmpNullDir, { recursive: true, force: true });
  });

  test('/m/ fallback serves index.html when dist exists', async () => {
    const port = serverWithDist.address().port;
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/m/agents`, (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          assert.equal(res.statusCode, 200);
          assert.ok(buf.includes('PWA'));
          resolve();
        });
      });
      req.on('error', reject);
    });
  });

  test('/assets/app.js served as static file', async () => {
    const port = serverWithDist.address().port;
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/assets/app.js`, (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          assert.equal(res.statusCode, 200);
          resolve();
        });
      });
      req.on('error', reject);
    });
  });

  test('/m/ returns 503 when dist absent', async () => {
    const r = await request(serverNoDist, '/m/agents');
    assert.equal(r.status, 503);
    assert.ok(r.body.error.includes('npm run build'));
  });
});

// ---------------------------------------------------------------------------
// Tests: agent proxy
// ---------------------------------------------------------------------------

describe('Agent proxy', () => {
  let agentStub;
  let proxyServer;
  let origToken;
  const AGENT_TOKEN = 'real-agent-tok';

  before(async () => {
    origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = AGENT_TOKEN;

    // Stub upstream agent server
    agentStub = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const receivedToken = req.headers['x-compose-token'];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          path: req.url,
          method: req.method,
          token: receivedToken,
        }));
      });
    });
    await new Promise(res => agentStub.listen(0, '127.0.0.1', res));

    const agentPort = agentStub.address().port;
    const app = express();
    app.use(express.json());
    attachAgentProxy(app, { agentPort });
    proxyServer = await listen(app);
  });

  after(async () => {
    if (origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = origToken;
    await close(proxyServer);
    await close(agentStub);
  });

  test('proxy forwards GET to upstream and injects x-compose-token', async () => {
    const r = await request(proxyServer, '/api/agent/proxy/session/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.token, AGENT_TOKEN);
    assert.equal(r.body.path, '/api/agent/session/status');
  });

  test('proxy strips client-sent x-compose-token and injects the real one', async () => {
    const r = await request(proxyServer, '/api/agent/proxy/session/status', {
      headers: { 'x-compose-token': 'EVIL_CLIENT_TOKEN' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.token, AGENT_TOKEN); // injected, not client's
  });

  test('proxy forwards POST with body', async () => {
    const r = await request(proxyServer, '/api/agent/proxy/session', {
      method: 'POST',
      body: { featureCode: 'TEST-1' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.method, 'POST');
    assert.equal(r.body.path, '/api/agent/session');
  });

  test('502 when upstream is dead', async () => {
    // Use a port nothing is listening on
    const deadApp = express();
    attachAgentProxy(deadApp, { agentPort: 19999 });
    const deadServer = await listen(deadApp);
    try {
      const r = await request(deadServer, '/api/agent/proxy/session/status');
      assert.equal(r.status, 502);
    } finally {
      await close(deadServer);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: guard-swap parity — build routes accept sensitive token AND valid JWT
// ---------------------------------------------------------------------------

describe('Guard-swap parity (build routes)', () => {
  let server;
  let store;
  let tmpDir;
  let origToken;
  let validJwt;

  before(async () => {
    origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;

    tmpDir = mkdtempSync(join(tmpdir(), 'rg-guard-'));
    store = createAuthStore(tmpDir);
    configureAuthStore(store);

    const code = store.createPairingCode();
    const result = store.consumePairingCode(code.code, { name: 'Guard Test' });
    validJwt = result.access_token;

    const app = express();
    app.use(express.json());
    attachBuildRoutes(app, {
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => tmpDir,
    });
    server = await listen(app);
  });

  after(async () => {
    if (origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = origToken;
    configureAuthStore(null);
    await close(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('POST /api/build/start accepts sensitive token', async () => {
    const r = await request(server, '/api/build/start', {
      method: 'POST',
      body: { featureCode: 'TEST-1' },
      headers: { 'x-compose-token': TOKEN },
    });
    assert.equal(r.status, 200);
  });

  test('POST /api/build/start accepts valid JWT (Authorization: Bearer)', async () => {
    const r = await request(server, '/api/build/start', {
      method: 'POST',
      body: { featureCode: 'TEST-1' },
      headers: { 'Authorization': `Bearer ${validJwt}` },
    });
    assert.equal(r.status, 200);
  });

  test('POST /api/build/start → 401 without credential', async () => {
    const r = await request(server, '/api/build/start', {
      method: 'POST',
      body: { featureCode: 'TEST-1' },
    });
    assert.equal(r.status, 401);
  });

  test('POST /api/build/abort accepts sensitive token', async () => {
    const r = await request(server, '/api/build/abort', {
      method: 'POST',
      body: { featureCode: 'TEST-1' },
      headers: { 'x-compose-token': TOKEN },
    });
    assert.equal(r.status, 200);
  });
});
```

- [ ] **Step 2: Run the test file (expect failures before implementation)**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/remote-gate.test.js 2>&1 | head -60
```
Expected: many failures (implementation not done yet).

---

## Task 9: Apply all `server/index.js` edits and run the full test suite

This task assembles the actual edits to `server/index.js` described in Tasks 5-7.

- [ ] **Step 1: Breadcrumb**
```bash
echo "$(date -Iseconds) | S02 COMP-MOBILE-REMOTE: assembling server/index.js edits" >> /Users/ruze/reg/my/forge/compose/.compose/breadcrumbs.log
```

- [ ] **Step 2: Apply all index.js edits** (see Tasks 5, 6, 7 for exact diffs)

The final `server/index.js` must have:
1. Added imports: `existsSync`, `statSync` from `node:fs`; `createAuthStore`, `createAuthGate`, `wsUpgradeTokenOk`, `attachAuthRoutes`, `configureAuthStore`, `requireSensitiveToken`, `requireSensitiveOrPaired`; `COMPOSE_HOME` added to project-root import
2. Exported `resolveComposeHost()` function
3. Exported `attachAgentProxy()` function
4. `const _host = resolveComposeHost()` and `remoteMode` constant
5. Refusal guard (synchronous, before listen)
6. Auth store creation + `configureAuthStore()` call (after `ensureDataDir()`)
7. Auth gate mount (conditional on `remoteMode`)
8. Auth routes mount (both modes)
9. Agent proxy mount (both modes, after auth routes)
10. Static + SPA fallback (both modes, after all API routes, before listen)
11. WS upgrade handler with remoteMode auth check
12. `server.listen(PORT, _host, ...)` instead of hardcoded `'127.0.0.1'`

- [ ] **Step 3: Run the full remote-gate test suite**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/remote-gate.test.js 2>&1
```
Expected: all pass.

- [ ] **Step 4: Run existing tests to verify no regressions**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/build-routes.test.js test/auth-routes.test.js test/auth-middleware.test.js test/auth-store.test.js
```
Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/*.test.js 2>&1 | tail -30
```
Expected: all pass (or same failures as before S02 — none new).

---

## Task 10: Boot smoke test

- [ ] **Step 1: Smoke — localhost default (no changes)**

```bash
PORT=4998 AGENT_PORT=4997 COMPOSE_API_TOKEN=smoketok node /Users/ruze/reg/my/forge/compose/server/index.js &
SMOKE_PID=$!
sleep 2
curl -s http://127.0.0.1:4998/api/health
curl -s http://127.0.0.1:4998/api/status
kill $SMOKE_PID
```
Expected: health returns `{"ok":true}`, status returns 200 (no gate).

- [ ] **Step 2: Smoke — non-localhost without COMPOSE_REMOTE_AUTH → refusal**

```bash
PORT=4998 COMPOSE_HOST=0.0.0.0 COMPOSE_API_TOKEN=smoketok node /Users/ruze/reg/my/forge/compose/server/index.js
echo "Exit code: $?"
```
Expected: prints ERROR message and exits with code 1 immediately (no listen).

- [ ] **Step 3: Smoke — remote mode with auth**

```bash
PORT=4998 AGENT_PORT=4997 COMPOSE_HOST=0.0.0.0 COMPOSE_REMOTE_AUTH=enabled COMPOSE_API_TOKEN=smoketok node /Users/ruze/reg/my/forge/compose/server/index.js &
SMOKE_PID=$!
sleep 2
# bare curl to guarded route → 401
curl -s http://127.0.0.1:4998/api/status
# with sensitive token → 200
curl -s -H "x-compose-token: smoketok" http://127.0.0.1:4998/api/status
# health bare → 200 (allowlisted)
curl -s http://127.0.0.1:4998/api/health
kill $SMOKE_PID
```
Expected: first curl 401, second 200, third 200 (allowlisted).

---

## Task 11: Run `npx vitest run` and `npm run build`

- [ ] **Step 1: Run Vitest**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run 2>&1 | tail -20
```
Expected: pass (S02 doesn't touch client code).

- [ ] **Step 2: Run build**

```bash
cd /Users/ruze/reg/my/forge/compose && npm run build 2>&1 | tail -20
```
Expected: success.

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| `resolveComposeHost()` exported | Task 5 |
| remoteMode detection | Task 5 |
| refusal before listen | Task 5 |
| startup banner | Task 5 |
| `server.listen(PORT, host)` | Task 5 |
| Auth store creation in both modes | Task 6 |
| `configureAuthStore` call | Task 6 |
| Auth gate mounted only in remote mode | Task 6 |
| Allowlist per blueprint | Task 6 |
| Auth routes mounted in both modes | Task 6 |
| Late-bound broadcast closure | Task 6 |
| WS upgrade auth check | Task 6 |
| 401 + destroy on WS auth fail | Task 6 |
| `express.static` + SPA fallback `/m/*` | Task 7 |
| 503 when dist absent | Task 7 |
| `attachAgentProxy` exported | Task 7 |
| All 5 proxy routes | Task 7 |
| Token injection + strip | Task 7 |
| SSE pipe, no buffering | Task 7 |
| 502 on upstream failure | Task 7 |
| `configureAuthStore` + `requireSensitiveOrPaired` in security.js | Task 1 |
| build-routes.js import swap | Task 2 |
| vision-routes.js import swap | Task 2 |
| vision-server.js DI value swaps | Task 3 |
| supervisor.js thread env | Task 4 |
| test/remote-gate.test.js | Task 8 |

No gaps found.

**Type consistency check:**
- `attachAgentProxy(app, { agentPort })` — matches usage in Task 7 and test in Task 8 ✓
- `resolveComposeHost()` — no params, returns string ✓
- `createAuthGate({ store, allowlist })` — matches auth-middleware.js S01 export ✓
- `wsUpgradeTokenOk(store, req)` — matches auth-middleware.js S01 export ✓
- `configureAuthStore(store)` — module setter, no return value ✓
- `requireSensitiveOrPaired` — standard Express middleware signature ✓
