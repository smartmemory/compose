import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { FileWatcherServer } from './file-watcher.js';
import { VisionStore } from './vision-store.js';
import { VisionServer } from './vision-server.js';
import { SessionManager } from './session-manager.js';
import { scanFeatures, seedFeatures, scanSubPackages, seedSubPackages } from './feature-scan.js';
import { attachGraphExportRoutes } from './graph-export.js';
import { attachWorkspaceRoutes } from './workspace-routes.js';
import { attachGraphLayoutRoutes } from './graph-layout-routes.js';
import { createWorkspaceMiddleware } from './workspace-middleware.js';
import { getTargetRoot, getDataDir, ensureDataDir, loadProjectConfig, resolveProjectPath, switchProject, COMPOSE_HOME } from './project-root.js';
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

// Load project config and verify stratum capability matches reality
const projectConfig = loadProjectConfig();
if (projectConfig.capabilities.stratum) {
  try {
    execFileSync('which', ['stratum-mcp'], { stdio: 'ignore' });
  } catch {
    console.error('[compose] stratum-mcp not found but capabilities.stratum=true');
    console.error('[compose] Run: compose init (will auto-install) or compose init --no-stratum');
    projectConfig.capabilities.stratum = false;
  }
}

// Handle unexpected errors — fatal startup errors exit (supervisor retries),
// runtime errors keep the process alive to preserve PTY sessions
let serverListening = false;
process.on('uncaughtException', (err) => {
  if (!serverListening && err.code === 'EADDRINUSE') {
    console.error(`[compose] Port in use, exiting for supervisor retry: ${err.message}`);
    process.exit(1);
  }
  console.error('[compose] Uncaught exception (process kept alive):', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[compose] Unhandled rejection (process kept alive):', reason);
});
process.on('SIGTERM', () => {
  console.log('[compose] SIGTERM received, shutting down gracefully');
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
    if (typeof visionServer?.broadcastMessage === 'function') {
      visionServer.broadcastMessage(msg);
    }
  },
  requireSensitive: requireSensitiveToken,
});

// ---------------------------------------------------------------------------
// Agent proxy (BOTH modes — additive) — mounted after the gate so gate clears
// requests first. Proxy injects the real sensitive token server-side.
// ---------------------------------------------------------------------------
const _agentPort = parseInt(process.env.AGENT_PORT || '4002', 10);
attachAgentProxy(app, { agentPort: _agentPort });

attachWorkspaceRoutes(app);
attachGraphLayoutRoutes(app);
app.use(createWorkspaceMiddleware());

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

app.post('/api/project/switch', (req, res) => {
  const { path: projectPath } = req.body || {};
  if (!projectPath) return res.status(400).json({ error: 'path is required' });
  try {
    const result = switchProject(projectPath);
    ensureDataDir();
    // Reload store from new data directory
    visionStore.reloadFrom(result.dataDir);
    // Re-scan features and sub-packages from new project
    try {
      const features = scanFeatures();
      if (features.length > 0) seedFeatures(features, visionStore);
      const packages = scanSubPackages();
      if (packages.length > 0) seedSubPackages(packages, visionStore);
    } catch (err) {
      console.error('[compose] Feature scan after switch:', err.message);
    }
    // Broadcast new state to all connected clients
    visionServer.scheduleBroadcast();
    res.json({ ok: true, targetRoot: result.targetRoot, name: path.basename(result.targetRoot) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const server = http.createServer(app);
const fileWatcher = new FileWatcherServer();
fileWatcher.attach(server, app);

const visionStore = new VisionStore(getDataDir());
const sessionManager = new SessionManager({
  getFeaturePhase: (featureCode) => {
    const item = visionStore.getItemByFeatureCode(featureCode);
    return item?.lifecycle?.currentPhase || null;
  },
  featureRoot: resolveProjectPath('features'),
});
const visionServer = new VisionServer(visionStore, sessionManager, { config: projectConfig });
visionServer.attach(server, app);

// Seed feature folders and sub-packages into vision store on startup
try {
  const features = scanFeatures();
  if (features.length > 0) seedFeatures(features, visionStore);
  const packages = scanSubPackages();
  if (packages.length > 0) seedSubPackages(packages, visionStore);
} catch (err) {
  console.error('[compose] Feature scan startup error:', err.message);
}

// Wire feature folder changes → auto-reseed vision store
fileWatcher.onFeatureChanged = (_relativePath) => {
  try {
    const features = scanFeatures();
    seedFeatures(features, visionStore);
    visionServer.scheduleBroadcast();
  } catch (err) {
    console.error('[compose] Feature reseed error:', err.message);
  }
};

// Wire build state changes → broadcast over /ws/vision
fileWatcher.onBuildStateChanged = (state) => {
  if (state) {
    // Broadcast flat payload per STRAT-COMP-4 contract
    visionServer.broadcastMessage({ type: 'buildState', ...state });
  }
};

// Wire pipelines/*.stratum.yaml external changes → broadcast `specChanged` on
// the VISION WS (COMP-PIPE-EDIT-6 — the channel the pipeline editor store uses,
// not /ws/files). The message already carries { type:'specChanged', file, path }.
fileWatcher.onSpecChanged = (message) => {
  visionServer.broadcastMessage(message);
};

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

app.use(express.static(_distDir, { index: false }));

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
