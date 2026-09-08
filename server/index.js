import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { WorkspaceRuntime } from './workspace-runtime.js';
import { attachWorkspaceRoutes } from './workspace-routes.js';
import { createWorkspaceMiddleware } from './workspace-middleware.js';
import { getTargetRoot, getDataDir, ensureDataDir, loadProjectConfig, withProjectContext, COMPOSE_HOME } from './project-root.js';
import { resolveStratumEngine } from './stratum-client.js';
import { probeStratumBin, resolveStratumBin } from '../lib/stratum-engine.js';
import { createAuthStore } from './auth-store.js';
import { createAuthGate, wsUpgradeTokenOk } from './auth-middleware.js';
import { attachAuthRoutes } from './auth-routes.js';
import { configureAuthStore, requireSensitiveToken } from './security.js';
import { resolveComposeHost, attachAgentProxy } from './remote-utils.js';

// Re-export for Boundary Map (S02) and tests
export { resolveComposeHost, attachAgentProxy };

// ---------------------------------------------------------------------------
// Remote mode detection — synchronous, before any app setup.
// Exits early if non-localhost bind without COMPOSE_REMOTE_AUTH=enabled.
// ---------------------------------------------------------------------------

const _host = resolveComposeHost();
const remoteMode = _host !== '127.0.0.1' && _host !== 'localhost';

if (remoteMode && process.env.COMPOSE_REMOTE_AUTH !== 'enabled') {
  console.error('[compose] ERROR: bound to non-localhost without COMPOSE_REMOTE_AUTH=enabled.');
  console.error('[compose] Set COMPOSE_REMOTE_AUTH=enabled to acknowledge the security model, then retry.');
  process.exit(1);
}

// Load project config and verify stratum capability matches reality.
// The probe targets the TS engine binary (COMP-STRATUM-TS).
const projectConfig = loadProjectConfig();
if (projectConfig.capabilities.stratum) {
  let stratumEngine;
  let stratumBin;
  try {
    stratumEngine = resolveStratumEngine();
    stratumBin = resolveStratumBin('cli', getTargetRoot());
  } catch (err) {
    console.error(`[compose] ${err.message}`);
    process.exit(1);
  }
  // C1: existence alone is not enough — a bare `stratum` on $PATH can EXIST yet
  // not speak the query contract (miniconda's CLI answers "Unknown command" and
  // even exits 0), which used to half-enable the adapter with every call broken.
  // The probe now verifies the binary actually returns the flows projection.
  const probe = probeStratumBin(stratumBin);
  if (!probe.ok) {
    console.error(`[compose] stratum ${stratumEngine} binary is unusable but capabilities.stratum=true: ${probe.reason}`);
    console.error('[compose] Install @smartmemory/stratum or set COMPOSE_STRATUM_TS_CLI_BIN to the live query/gate CLI');
    projectConfig.capabilities.stratum = false;
  }
}

// Handle unexpected errors — fatal startup errors exit (supervisor retries),
// runtime errors keep the process alive to preserve PTY sessions.
//
// stdio death is fatal by design: when the parent process dies, stdout/stderr
// become dead sockets and every console.* write throws EPIPE. Logging from the
// uncaughtException handler then throws again, which re-enters the handler via
// the stream's error emission — an infinite setImmediate loop pinning a core
// (observed 2026-09-01: 2 days at 100% CPU as an orphan). So: stream errors on
// stdio exit immediately, and every log in an error/signal path is guarded.
const isDeadStdio = (err) =>
  err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ERR_STREAM_WRITE_AFTER_END');
const safeLog = (...args) => {
  try {
    console.error(...args);
  } catch {
    process.exit(0); // stdio is gone — parent died, nothing left to serve logs to
  }
};
process.stdout.on('error', (err) => {
  if (isDeadStdio(err)) process.exit(0);
});
process.stderr.on('error', (err) => {
  if (isDeadStdio(err)) process.exit(0);
});
let serverListening = false;
process.on('uncaughtException', (err) => {
  if (isDeadStdio(err)) process.exit(0);
  if (!serverListening && err.code === 'EADDRINUSE') {
    safeLog(`[compose] Port in use, exiting for supervisor retry: ${err.message}`);
    process.exit(1);
  }
  safeLog('[compose] Uncaught exception (process kept alive):', err.message);
  safeLog(err.stack);
});
process.on('unhandledRejection', (reason) => {
  safeLog('[compose] Unhandled rejection (process kept alive):', reason);
});
process.on('SIGTERM', () => {
  safeLog('[compose] SIGTERM received, shutting down gracefully');
  process.exit(0);
});

const PORT = process.env.PORT || 4001;
const app = express();

// ---------------------------------------------------------------------------
// Auth store — created early so the gate can be mounted before route handlers.
// Created in BOTH modes (pairing setup on localhost is a supported flow).
// ensureDataDir() called here so getDataDir() is stable for the store.
// ---------------------------------------------------------------------------
ensureDataDir();
const _authStore = createAuthStore(getDataDir());
configureAuthStore(_authStore);

app.use(cors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth gate (remote mode ONLY) — mounted AFTER express.json(), BEFORE all
// route handlers. When off: this block does not execute — zero behavior change.
// ---------------------------------------------------------------------------
if (remoteMode) {
  app.use(createAuthGate({
    store: _authStore,
    allowlist: [
      '/m',                        // PWA shell + pair page and all sub-paths
      '/assets/',                  // static assets
      '/manifest.webmanifest',
      '/m-sw.js',
      '/api/health',               // health check (read-only, no secrets)
      '/api/workspace',            // boot fetch: WorkspaceContext.jsx:40
      '/api/auth/pair/complete',   // pairing bootstrap (code is the auth)
      '/api/auth/refresh',         // token refresh (refresh token is the auth)
    ],
    // Query-token (?token=) accepted ONLY on these exact stream paths —
    // EventSource cannot send headers. Everything else is header-auth.
    streamPaths: [
      '/api/agent/proxy/stream',
      '/api/design/stream',
    ],
  }));
}

// ---------------------------------------------------------------------------
// Auth routes (BOTH modes) — pairing setup on localhost (ahead of enabling
// remote) is a supported flow. broadcast is a late-bound closure: visionServer
// is declared below; by the time any pairing request arrives the server is
// listening and visionServer is fully initialized.
// ---------------------------------------------------------------------------
attachAuthRoutes(app, {
  store: _authStore,
  // Configured public host (compose remote pair --public-host=...) so the
  // cockpit modal can compose the real pair URL. Read per-request: the CLI
  // may persist it while the server is running.
  getPublicHost: () => {
    try {
      const cfg = JSON.parse(readFileSync(path.join(getDataDir(), '..', 'compose.json'), 'utf-8'));
      return cfg?.remote?.public_host || null;
    } catch { return null; }
  },
  broadcast: (msg) => {
    if (typeof workspaces?.active?.visionServer?.broadcastMessage === 'function') {
      activeVision().broadcastMessage(msg);
    }
  },
  requireSensitive: requireSensitiveToken,
});

// ---------------------------------------------------------------------------
// Each workspace installs its agent proxy after workspace resolution. The
// proxy stamps the selected root and sensitive token for the SDK process.
// ---------------------------------------------------------------------------
const _agentPort = parseInt(process.env.AGENT_PORT || '4002', 10);

attachWorkspaceRoutes(app);
app.use(createWorkspaceMiddleware({ resolveKnownWorkspace: (id) => workspaces.resolveKnownWorkspace(id) }));

// `remote` lets clients (desktop cockpit served through a tunnel) detect
// remote mode at boot and switch their WS/SSE URLs to token-carrying form.
app.get('/api/health', (_req, res) => res.json({ ok: true, remote: remoteMode }));
app.get('/api/status', (_req, res) => res.json({ session: 2, phase: '0.4-brainstorm', upSince: new Date().toISOString() }));

// Project info + switching
app.get('/api/project', (_req, res) => {
  const root = getTargetRoot();
  res.json({
    targetRoot: root,
    name: path.basename(root),
    dataDir: getDataDir(),
  });
});

const server = http.createServer(app);
const workspaces = new WorkspaceRuntime(server, { agentPort: _agentPort });
try { workspaces.switch(getTargetRoot(), projectConfig); }
catch (err) {
  console.error(`[compose] Workspace startup failed: ${err.message}`);
  process.exit(1);
}

// Accessors always select the current context; old requests retain their own router.
const activeVision = () => workspaces.active.visionServer;
app.post('/api/project/switch', (req, res) => {
  const { path: projectPath } = req.body || {};
  if (typeof projectPath !== 'string' || !projectPath) return res.status(400).json({ error: 'path is required' });
  try {
    const { binding } = workspaces.switch(projectPath);
    res.json({ ok: true, targetRoot: binding.targetRoot, name: path.basename(binding.targetRoot) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.use((req, res, next) => workspaces.handle(req, res, next));

// ---------------------------------------------------------------------------
// Static serving + SPA fallback (BOTH modes — additive)
// Mounted AFTER all API routes so /api/* is never shadowed.
// In dev Vite (5195) serves the SPA; in remote mode the built dist/ is used.
// ---------------------------------------------------------------------------
const _distDir = path.join(COMPOSE_HOME, 'dist');
const _distExists = () => {
  try { return existsSync(_distDir) && statSync(_distDir).isDirectory(); }
  catch { return false; }
};

// Source checkouts keep Vite/HMR on :5195. Published installs have no Vite or
// src/ by design, so compose start serves the prebuilt desktop shell on :4001.
app.use(express.static(_distDir, {
  index: process.env.COMPOSE_PACKAGED_UI === '1' ? 'index.html' : false,
}));

// /m/* SPA fallback — paths matching /m or /m/...
app.get(/^\/m(\/|$)/, (_req, res) => {
  if (!_distExists()) {
    return res.status(503).json({ error: 'PWA bundle not built — run npm run build' });
  }
  res.sendFile(path.join(_distDir, 'index.html'));
});

// Manual WebSocket upgrade routing — avoids the ws library bug where multiple
// WebSocketServers on the same HTTP server write 400 on each other's connections
server.on('upgrade', (req, socket, head) => {
  // S02: remote-mode WS auth — check ?token= (sensitive or JWT) before upgrade
  // Token value is never logged.
  if (remoteMode && !wsUpgradeTokenOk(_authStore, req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const workspaceId = req.headers['x-compose-workspace-id'] || url.searchParams.get('workspaceId');
  let context = workspaces.active;
  if (workspaceId) {
    try {
      const resolved = workspaces.resolveKnownWorkspace(workspaceId);
      context = resolved && workspaces.get(resolved.root);
    } catch { context = null; }
    if (!context) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  const { fileWatcher, visionServer } = context;
  const wss = url.pathname === '/ws/files' ? fileWatcher.wss
    : url.pathname === '/ws/vision' ? visionServer.wss : null;
  if (!wss) { socket.destroy(); return; }
  withProjectContext(context.binding, () => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
});

server.listen(PORT, _host, () => {
  serverListening = true;
  console.log(`Compose server running on http://${_host}:${PORT}`);
  console.log(`File watcher WebSocket: ws://${_host}:${PORT}/ws/files`);
  console.log(`Vision WebSocket: ws://${_host}:${PORT}/ws/vision`);
  if (remoteMode) {
    console.log('[compose] WARNING: bound to ' + _host + ' — accessible from local network and beyond');
    console.log('[compose] Auth gate active: localhost trusted; remote requests require pairing token.');
    console.log('[compose] Run `compose remote pair --public-host=<URL>` from the cockpit terminal to add a device.');
  }
});
