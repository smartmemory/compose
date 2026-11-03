/**
 * COMP-LOOPBACK-HOST-GUARD-1: the local API answers only a loopback Host/Origin. Real express app on a loopback ephemeral
 * port, the real sibling handlers, the real middleware. http.request (not fetch) so the Host header can be forged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopbackGuard, guardUpgrade, isLoopbackHost, isLoopbackRequest } from '../server/loopback-guard.js';
import { attachCadenceUiRoutes } from '../server/cadence-ui-routes.js';
import { attachStratumUiRoutes } from '../server/stratum-ui-routes.js';
import { resolveCadenceUiDir } from '../lib/cadence-ui-link.js';
import { resolveStratumUiDir } from '../lib/stratum-ui-link.js';
import { localCaller } from '../server/wiki-routes.js';

const cadenceDir = resolveCadenceUiDir();
const stratumDir = resolveStratumUiDir();
const FOREIGN = 'review-probe.invalid:4001';

function call(port, { method = 'GET', path, host, origin, body }) {
  return new Promise((done, fail) => {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => done({ status: res.statusCode, body: data }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

// Mirrors server/index.js: guard first, then the two sub-app mounts, then json + ordinary routes.
async function withApp(fn, { remote = false } = {}) {
  const app = express();
  const ran = { post: 0 };
  if (!remote) app.use(loopbackGuard());
  const dir = mkdtempSync(join(tmpdir(), 'loopback-guard-'));
  if (stratumDir) await attachStratumUiRoutes(app, { uiDir: stratumDir, env: { STRATUM_STATE_ROOT: dir } });
  const ranCommands = [];
  if (cadenceDir) {
    await attachCadenceUiRoutes(app, {
      uiDir: cadenceDir,
      opsRoot: join(cadenceDir, 'tests', 'fixtures'),
      stateDir: dir,
      scriptsDir: dir,
      run: async (...a) => { ranCommands.push(a); return { code: 1, stdout: '', stderr: '' }; },
    });
  }
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/activity', (_req, res) => { ran.post += 1; res.json({ ok: true }); });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(server.address().port, { ran, ranCommands }); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

const LOOP_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

describe('isLoopbackHost / isLoopbackRequest', () => {
  it('accepts loopback names with or without a port and nothing else', () => {
    for (const h of LOOP_HOSTS) { assert.ok(isLoopbackHost(h)); assert.ok(isLoopbackHost(`${h}:5195`)); }
    for (const h of [undefined, '', FOREIGN, 'localhost.evil.com', '127.0.0.1.evil.com:80', 'evil.com:80@127.0.0.1', '127.0.0.2', '0.0.0.0:4001', 'localhost:99999999', ' localhost']) {
      assert.equal(isLoopbackHost(h), false, String(h));
    }
  });
  it('wiki-routes localCaller is the same check', () => {
    for (const req of [{ headers: { host: 'localhost:4001' } }, { headers: { host: FOREIGN } }, { headers: { host: '[::1]:4001', origin: 'http://[::1]:5195' } }, { headers: { host: '127.0.0.1', origin: 'http://evil.test' } }]) {
      assert.equal(localCaller(req), isLoopbackRequest(req));
    }
  });
});

describe('loopback guard on the local API', () => {
  it('a foreign Host gets 403 {error:{code:"HOST"}} on health, both sub-apps and a POST, and no handler runs', async () => {
    await withApp(async (port, { ran, ranCommands }) => {
      const rows = [['GET', '/api/health'], ['GET', '/api/cadence-ui/seats'], ['GET', '/api/cadence-ui/available'], ['GET', '/api/stratum-ui/runs'], ['GET', '/api/stratum-ui/available'], ['GET', '/api/nope-anything'], ['POST', '/api/activity']];
      for (const [method, path] of rows) {
        const r = await call(port, { method, path, host: FOREIGN, body: method === 'POST' ? '{}' : undefined });
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.equal(JSON.parse(r.body).error.code, 'HOST', `${method} ${path}`);
      }
      assert.equal(ran.post, 0);
      assert.equal(ranCommands.length, 0);
    });
  });

  it('a foreign Origin with a loopback Host gets 403 on the same routes', async () => {
    await withApp(async (port, { ran }) => {
      for (const origin of ['http://review-probe.invalid:4001', 'http://localhost.evil.com', 'null', 'file://']) {
        for (const [method, path] of [['GET', '/api/health'], ['GET', '/api/cadence-ui/seats'], ['GET', '/api/stratum-ui/runs'], ['POST', '/api/activity']]) {
          const r = await call(port, { method, path, host: `127.0.0.1:${port}`, origin, body: method === 'POST' ? '{}' : undefined });
          assert.equal(r.status, 403, `${origin} ${method} ${path}`);
        }
      }
      assert.equal(ran.post, 0);
    });
  });

  it('a loopback Host answers 200 with and without a loopback Origin', async () => {
    await withApp(async (port, { ran }) => {
      for (const h of LOOP_HOSTS) {
        for (const origin of [undefined, `http://${h}:5195`]) {
          const host = `${h}:${port}`;
          assert.equal((await call(port, { path: '/api/health', host, origin })).status, 200, `${host} ${origin}`);
          if (cadenceDir) assert.equal((await call(port, { path: '/api/cadence-ui/seats', host, origin })).status, 200, `seats ${host}`);
          if (stratumDir) assert.equal((await call(port, { path: '/api/stratum-ui/available', host, origin })).status, 200, `stratum ${host}`);
        }
      }
      assert.equal((await call(port, { method: 'POST', path: '/api/activity', host: `127.0.0.1:${port}`, body: '{}' })).status, 200);
      assert.equal(ran.post, 1);
    });
  });

  it('remote mode (guard not mounted): a non-loopback Host is not refused by the guard', async () => {
    await withApp(async (port) => {
      assert.equal((await call(port, { path: '/api/health', host: 'compose.example.test' })).status, 200);
    }, { remote: true });
  });
});

describe('defense in depth: the mounts refuse a foreign Host without the app guard', () => {
  it('cadence and stratum handlers answer 403 HOST on their own', async () => {
    const app = express();
    const dir = mkdtempSync(join(tmpdir(), 'loopback-guard-'));
    if (stratumDir) await attachStratumUiRoutes(app, { uiDir: stratumDir, env: { STRATUM_STATE_ROOT: dir } });
    if (cadenceDir) await attachCadenceUiRoutes(app, { uiDir: cadenceDir, opsRoot: join(cadenceDir, 'tests', 'fixtures'), stateDir: dir, scriptsDir: dir, run: async () => ({ code: 1, stdout: '', stderr: '' }) });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const port = server.address().port;
      if (cadenceDir) {
        assert.equal((await call(port, { path: '/api/cadence-ui/seats', host: FOREIGN })).status, 403);
        assert.equal((await call(port, { path: '/api/cadence-ui/seats', host: `127.0.0.1:${port}` })).status, 200);
      }
      if (stratumDir) {
        const r = await call(port, { path: '/api/stratum-ui/runs', host: FOREIGN });
        assert.equal(r.status, 403);
        assert.equal(JSON.parse(r.body).error.code, 'HOST');
        assert.equal((await call(port, { path: '/api/stratum-ui/runs', host: `localhost:${port}` })).status, 200);
      }
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('agent server (4002) guard', () => {
  it('Host-only: foreign Host 403, loopback Host passes whatever the Origin (the remote proxy forwards the browser Origin)', async () => {
    const app = express();
    app.use(loopbackGuard({ origin: false }));
    app.get('/api/agent/session/status', (_req, res) => res.json({ ok: true }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const port = server.address().port;
      assert.equal((await call(port, { path: '/api/agent/session/status', host: FOREIGN })).status, 403);
      assert.equal((await call(port, { path: '/api/agent/session/status', host: `127.0.0.1:${port}` })).status, 200);
      assert.equal((await call(port, { path: '/api/agent/session/status', host: `127.0.0.1:${port}`, origin: 'https://compose.example.test' })).status, 200);
    } finally { server.close(); }
  });
  it('agent-server.js mounts it before cors and the agent app', () => {
    const src = readFileSync(new URL('../server/agent-server.js', import.meta.url), 'utf8');
    const g = src.indexOf('app.use(loopbackGuard({ origin: false }));');
    assert.ok(g > 0);
    assert.ok(src.indexOf('app.use(cors(') > g);
    assert.ok(src.indexOf('app.use(workspaceServer.app)') > g);
  });
});

describe('WebSocket upgrade guard', () => {
  it('guardUpgrade refuses a foreign Host/Origin with 403 and lets loopback through', async () => {
    let upgraded = 0;
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
      if (!guardUpgrade(req, socket)) return;
      upgraded += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const up = (host, origin) => new Promise((done, fail) => {
      const headers = { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
      if (origin) headers.origin = origin;
      const req = http.request({ host: '127.0.0.1', port, path: '/ws/files', headers });
      req.on('response', (res) => { res.resume(); done(res.statusCode); });
      req.on('upgrade', (res, socket) => { socket.destroy(); done(res.statusCode); });
      req.on('error', fail);
      req.end();
    });
    try {
      assert.equal(await up(FOREIGN), 403);
      assert.equal(await up(`127.0.0.1:${port}`, 'http://evil.test'), 403);
      assert.equal(upgraded, 0);
      assert.equal(await up(`127.0.0.1:${port}`, 'http://localhost:5195'), 101);
      assert.equal(upgraded, 1);
    } finally { server.close(); }
  });
});

describe('server/index.js wiring (source pin: the module boots the whole cockpit, so it is not imported)', () => {
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  it('mounts the guard in local mode only, before cors, both sub-app mounts and every route', () => {
    const guard = src.indexOf('if (!remoteMode) app.use(loopbackGuard());');
    assert.ok(guard > 0);
    for (const needle of ['app.use(cors(', 'await attachStratumUiRoutes(app', 'await attachCadenceUiRoutes(app', 'app.use(express.json())', 'app.get(', 'app.post(']) {
      const at = src.indexOf(needle);
      assert.ok(at > guard, `${needle} must come after the guard`);
    }
    assert.equal(src.slice(0, guard).includes('app.use('), false, 'nothing is mounted before the guard');
  });
  it('checks upgrades in local mode before any routing', () => {
    const up = src.indexOf("server.on('upgrade'");
    assert.ok(up > 0);
    assert.ok(src.indexOf('if (!remoteMode && !guardUpgrade(req, socket)) return;', up) > up);
    assert.ok(src.indexOf('if (!remoteMode && !guardUpgrade', up) < src.indexOf('new URL(req.url', up));
  });
  it('wiki-routes keeps no regex copy of its own', () => {
    const wiki = readFileSync(new URL('../server/wiki-routes.js', import.meta.url), 'utf8');
    assert.equal(/LOOPBACK_(HOST|ORIGIN)_RE\s*=/.test(wiki), false);
  });
});

describe('Vite dev server (5195)', () => {
  // The /api proxy is a string target, which Vite treats as changeOrigin:true: the backend sees Host 127.0.0.1:4001 whatever the
  // browser sent (probed, COMP-LOOPBACK-HOST-GUARD-1). So Vite's own Host check is the only Host defense on that path; never open it.
  it('vite.config.js does not widen server.allowedHosts', () => {
    const cfg = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
    assert.equal(/allowedHosts/.test(cfg), false);
  });
});
