/**
 * auth-routes.test.js — COMP-MOBILE-REMOTE S01
 *
 * Full pairing flow + edge cases over a real Express+http server.
 * Pattern: test/build-routes.test.js (http.request, no supertest dep).
 *
 * Coverage:
 *   - Full pairing flow: init → status pending → complete → status consumed
 *     → JWT works via middleware → refresh rotates → reuse revokes
 *   - Rate limit on complete/refresh (429 after 10)
 *   - Devices list / revoke
 *   - broadcast called on complete
 *
 * Run: node --test --test-timeout=90000 test/auth-routes.test.js
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createAuthStore } = await import(`${REPO_ROOT}/server/auth-store.js`);
const { attachAuthRoutes } = await import(`${REPO_ROOT}/server/auth-routes.js`);
const { requireSensitiveOrPaired } = await import(`${REPO_ROOT}/server/auth-middleware.js`);
const { requireSensitiveToken } = await import(`${REPO_ROOT}/server/security.js`);

// ---------------------------------------------------------------------------
// HTTP helpers (same pattern as build-routes.test.js)
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

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp({ store, broadcast = null, sensitive = requireSensitiveToken }) {
  const app = express();
  app.use(express.json());
  attachAuthRoutes(app, { store, broadcast, requireSensitive: sensitive });
  return app;
}

// ---------------------------------------------------------------------------
// Full pairing flow
// ---------------------------------------------------------------------------

describe('Auth routes — full pairing flow', () => {
  let dir;
  let store;
  let server;
  let _origToken;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-routes-'));
    store = createAuthStore(dir);
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'route-test-token';
    server = await listen(makeApp({ store }));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  const SENSITIVE = { 'x-compose-token': 'route-test-token' };

  test('POST /api/auth/pair/init without token → 401/503', async () => {
    const r = await request(server, '/api/auth/pair/init', { method: 'POST', body: {} });
    assert.ok(r.status === 401 || r.status === 503);
  });

  test('POST /api/auth/pair/init with token → code + expires_at', async () => {
    const r = await request(server, '/api/auth/pair/init', {
      method: 'POST',
      body: {},
      headers: SENSITIVE,
    });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.code === 'string' && r.body.code.length > 0);
    assert.ok(!isNaN(Date.parse(r.body.expires_at)));
    assert.equal(r.body.pair_url, null);
  });

  test('GET /api/auth/pair/status?code= without token → 401/503', async () => {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    const r = await request(server, `/api/auth/pair/status?code=${initR.body.code}`, {
      method: 'GET',
    });
    assert.ok(r.status === 401 || r.status === 503);
  });

  test('GET /api/auth/pair/status returns pending for fresh code', async () => {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    const code = initR.body.code;
    const r = await request(server, `/api/auth/pair/status?code=${code}`, {
      method: 'GET', headers: SENSITIVE,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
  });

  test('POST /api/auth/pair/complete consumes code → tokens + device_id', async () => {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    const code = initR.body.code;

    const completeR = await request(server, '/api/auth/pair/complete', {
      method: 'POST',
      body: { code, device_name: 'My iPhone' },
    });
    assert.equal(completeR.status, 200);
    assert.ok(typeof completeR.body.access_token === 'string');
    assert.ok(typeof completeR.body.refresh_token === 'string');
    assert.ok(typeof completeR.body.device_id === 'string');
    assert.ok(typeof completeR.body.expires_in === 'number');

    // Status should now be consumed
    const statusR = await request(server, `/api/auth/pair/status?code=${code}`, {
      method: 'GET', headers: SENSITIVE,
    });
    assert.equal(statusR.status, 200);
    assert.equal(statusR.body.status, 'consumed');
  });

  test('Paired JWT works to list devices (via requireSensitiveOrPaired)', async () => {
    // Create a fresh app that uses requireSensitiveOrPaired for devices route
    const store2 = createAuthStore(mkdtempSync(join(tmpdir(), 'auth-routes2-')));
    const sensitive2 = requireSensitiveOrPaired(store2);
    const app2 = express();
    app2.use(express.json());
    attachAuthRoutes(app2, {
      store: store2,
      requireSensitive: sensitive2,
    });
    const server2 = await listen(app2);
    const _origTok2 = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'tok2';
    try {
      const initR = await request(server2, '/api/auth/pair/init', {
        method: 'POST', body: {}, headers: { 'x-compose-token': 'tok2' },
      });
      const completeR = await request(server2, '/api/auth/pair/complete', {
        method: 'POST', body: { code: initR.body.code, device_name: 'Test' },
      });
      const jwt = completeR.body.access_token;
      // Use JWT to access a sensitive endpoint
      const devR = await request(server2, '/api/auth/devices', {
        method: 'GET',
        headers: { authorization: `Bearer ${jwt}` },
      });
      assert.equal(devR.status, 200);
      assert.ok(Array.isArray(devR.body.devices));
    } finally {
      server2.close();
      if (_origTok2 === undefined) delete process.env.COMPOSE_API_TOKEN;
      else process.env.COMPOSE_API_TOKEN = _origTok2;
    }
  });

  test('second complete with same code → 400 CodeInvalid', async () => {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    const code = initR.body.code;
    await request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code, device_name: 'First' },
    });
    const r2 = await request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code, device_name: 'Second' },
    });
    assert.equal(r2.status, 400);
    assert.ok(r2.body.code === 'CodeInvalid');
  });

  test('missing code in complete → 400', async () => {
    const r = await request(server, '/api/auth/pair/complete', {
      method: 'POST', body: {},
    });
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Refresh rotation
// ---------------------------------------------------------------------------

describe('Auth routes — refresh token rotation', () => {
  let dir;
  let store;
  let server;
  let _origToken;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-routes-refresh-'));
    store = createAuthStore(dir);
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'refresh-test-token';
    server = await listen(makeApp({ store }));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  const SENSITIVE = { 'x-compose-token': 'refresh-test-token' };

  async function pair(name = 'RefreshPhone') {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    return request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code: initR.body.code, device_name: name },
    });
  }

  test('POST /api/auth/refresh rotates tokens', async () => {
    const { body: paired } = await pair('RotateTest');
    const r = await request(server, '/api/auth/refresh', {
      method: 'POST',
      body: { refresh_token: paired.refresh_token },
    });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.access_token === 'string');
    assert.ok(typeof r.body.refresh_token === 'string');
    assert.notEqual(r.body.refresh_token, paired.refresh_token);
  });

  test('old refresh token replay → 401', async () => {
    const { body: paired } = await pair('ReplayTest');
    const r1 = await request(server, '/api/auth/refresh', {
      method: 'POST', body: { refresh_token: paired.refresh_token },
    });
    assert.equal(r1.status, 200);
    const r2 = await request(server, '/api/auth/refresh', {
      method: 'POST', body: { refresh_token: paired.refresh_token },
    });
    assert.equal(r2.status, 401);
    assert.equal(r2.body.code, 'TokenInvalid');
  });

  test('missing refresh_token → 401', async () => {
    const r = await request(server, '/api/auth/refresh', {
      method: 'POST', body: {},
    });
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Devices list / revoke
// ---------------------------------------------------------------------------

describe('Auth routes — devices list and revoke', () => {
  let dir;
  let store;
  let server;
  let _origToken;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-routes-devices-'));
    store = createAuthStore(dir);
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'devices-test-token';
    server = await listen(makeApp({ store }));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  const SENSITIVE = { 'x-compose-token': 'devices-test-token' };

  async function pair(name) {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    return request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code: initR.body.code, device_name: name },
    });
  }

  test('GET /api/auth/devices without token → 401/503', async () => {
    const r = await request(server, '/api/auth/devices', { method: 'GET' });
    assert.ok(r.status === 401 || r.status === 503);
  });

  test('GET /api/auth/devices lists paired devices', async () => {
    await pair('ListDevice1');
    await pair('ListDevice2');
    const r = await request(server, '/api/auth/devices', {
      method: 'GET', headers: SENSITIVE,
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.devices));
    assert.ok(r.body.devices.length >= 2);
    // No hash fields
    for (const d of r.body.devices) {
      assert.ok(!('refresh_hash' in d));
      assert.ok(!('refresh_history' in d));
    }
  });

  test('DELETE /api/auth/devices/:id revokes device → { ok: true }', async () => {
    const { body: paired } = await pair('RevokeTarget');
    const r = await request(server, `/api/auth/devices/${paired.device_id}`, {
      method: 'DELETE', headers: SENSITIVE,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    // Subsequent refresh fails
    const refreshR = await request(server, '/api/auth/refresh', {
      method: 'POST', body: { refresh_token: paired.refresh_token },
    });
    assert.equal(refreshR.status, 401);
  });

  test('DELETE /api/auth/devices/:id with unknown id → 404', async () => {
    const r = await request(server, '/api/auth/devices/dev_doesnotexist', {
      method: 'DELETE', headers: SENSITIVE,
    });
    assert.equal(r.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('Auth routes — rate limiting', () => {
  let dir;
  let store;
  let server;
  let _origToken;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-routes-rl-'));
    store = createAuthStore(dir);
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'rl-test-token';
    server = await listen(makeApp({ store }));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  test('POST /api/auth/pair/complete rate-limited after 10 requests from same IP', async () => {
    // Send 10 requests with a dummy code (all will fail with 400 CodeInvalid but still count)
    const requests = [];
    for (let i = 0; i < 11; i++) {
      requests.push(
        request(server, '/api/auth/pair/complete', {
          method: 'POST',
          body: { code: 'FAKECODE' },
        }),
      );
    }
    const results = await Promise.all(requests);
    const statuses = results.map((r) => r.status);
    assert.ok(
      statuses.some((s) => s === 429),
      `Expected at least one 429 in [${statuses.join(', ')}]`,
    );
  });

  test('POST /api/auth/refresh rate-limited after 10 requests from same IP', async () => {
    // New store+server to reset rate limit state
    const dir2 = mkdtempSync(join(tmpdir(), 'auth-routes-rl2-'));
    const store2 = createAuthStore(dir2);
    const _orig2 = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'rl2-test-token';
    const server2 = await listen(makeApp({ store: store2 }));
    try {
      const requests = [];
      for (let i = 0; i < 11; i++) {
        requests.push(
          request(server2, '/api/auth/refresh', {
            method: 'POST',
            body: { refresh_token: 'fake.token' },
          }),
        );
      }
      const results = await Promise.all(requests);
      const statuses = results.map((r) => r.status);
      assert.ok(
        statuses.some((s) => s === 429),
        `Expected at least one 429 in [${statuses.join(', ')}]`,
      );
    } finally {
      server2.close();
      rmSync(dir2, { recursive: true, force: true });
      if (_orig2 === undefined) delete process.env.COMPOSE_API_TOKEN;
      else process.env.COMPOSE_API_TOKEN = _orig2;
    }
  });
});

// ---------------------------------------------------------------------------
// Broadcast on pair/complete
// ---------------------------------------------------------------------------

describe('Auth routes — broadcast on pair/complete', () => {
  let dir;
  let store;
  let server;
  let _origToken;
  let broadcasts;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-routes-bc-'));
    store = createAuthStore(dir);
    broadcasts = [];
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'bc-test-token';
    server = await listen(makeApp({
      store,
      broadcast: (msg) => broadcasts.push(msg),
    }));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  test('broadcast called with devicePaired message on successful complete', async () => {
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: { 'x-compose-token': 'bc-test-token' },
    });
    const code = initR.body.code;
    const before = broadcasts.length;

    await request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code, device_name: 'BroadcastPhone' },
    });

    assert.equal(broadcasts.length, before + 1);
    const msg = broadcasts[broadcasts.length - 1];
    assert.equal(msg.type, 'devicePaired');
    assert.ok(typeof msg.device_id === 'string');
    assert.equal(msg.name, 'BroadcastPhone');
    assert.ok(!isNaN(Date.parse(msg.timestamp)));
  });

  test('broadcast not called on failed complete (bad code)', async () => {
    const before = broadcasts.length;
    await request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code: 'BADCODE' },
    });
    assert.equal(broadcasts.length, before, 'No broadcast on failed complete');
  });

  test('null broadcast (no broadcast fn) does not throw', async () => {
    // This is covered by the main flow tests that don't pass broadcast
    const dir2 = mkdtempSync(join(tmpdir(), 'auth-routes-nobc-'));
    const store2 = createAuthStore(dir2);
    const _orig2 = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'nobc-token';
    const server2 = await listen(makeApp({ store: store2 /* no broadcast */ }));
    try {
      const initR = await request(server2, '/api/auth/pair/init', {
        method: 'POST', body: {}, headers: { 'x-compose-token': 'nobc-token' },
      });
      const r = await request(server2, '/api/auth/pair/complete', {
        method: 'POST', body: { code: initR.body.code, device_name: 'NoBcPhone' },
      });
      assert.equal(r.status, 200);
    } finally {
      server2.close();
      rmSync(dir2, { recursive: true, force: true });
      if (_orig2 === undefined) delete process.env.COMPOSE_API_TOKEN;
      else process.env.COMPOSE_API_TOKEN = _orig2;
    }
  });
});
