/**
 * auth-middleware.test.js — COMP-MOBILE-REMOTE S01
 *
 * Tests for auth-middleware.js:
 *   - createAuthGate: allowlist exact + prefix; sensitive-token pass; JWT pass + req.device;
 *     query-token accepted only for SSE-accept GETs; 401 codes
 *   - createRateLimiter: 429 on exceed + window reset
 *   - requireSensitiveOrPaired: matrix incl. 503-unset-env parity with security.js
 *   - wsUpgradeTokenOk: true/false
 *
 * Uses minimal fake req/res objects — no supertest dependency.
 * Pattern follows test/build-routes.test.js.
 *
 * Run: node --test --test-timeout=90000 test/auth-middleware.test.js
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  createAuthGate,
  requirePairingToken,
  requireSensitiveOrPaired,
  wsUpgradeTokenOk,
  createRateLimiter,
} = await import(`${REPO_ROOT}/server/auth-middleware.js`);
const { createAuthStore } = await import(`${REPO_ROOT}/server/auth-store.js`);

// ---------------------------------------------------------------------------
// Fake req/res helpers (same pattern as build-routes.test.js)
// ---------------------------------------------------------------------------

function makeReq({
  path = '/',
  method = 'GET',
  headers = {},
  query = {},
  url = path,
  ip = '127.0.0.1',
} = {}) {
  return {
    path,
    method,
    url,
    ip,
    query,
    get(name) {
      const k = name.toLowerCase();
      for (const [h, v] of Object.entries(headers)) {
        if (h.toLowerCase() === k) return v;
      }
      return undefined;
    },
    socket: { remoteAddress: ip },
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    _headers: {},
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
    set(k, v) { res._headers[k] = v; return res; },
  };
  return res;
}

function captureMiddleware(mw, req, res) {
  return new Promise((resolve) => {
    mw(req, res, () => resolve('next'));
    // If no next called within the sync path, the response was sent
    if (res._body !== null) resolve('sent');
  });
}

// ---------------------------------------------------------------------------
// Setup: store backed by temp dir
// ---------------------------------------------------------------------------

let _dir;
let _store;
let _origToken;

before(() => {
  _dir = mkdtempSync(join(tmpdir(), 'auth-mw-'));
  _store = createAuthStore(_dir);
  _origToken = process.env.COMPOSE_API_TOKEN;
  process.env.COMPOSE_API_TOKEN = 'test-sensitive-token';
});

after(() => {
  rmSync(_dir, { recursive: true, force: true });
  if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
  else process.env.COMPOSE_API_TOKEN = _origToken;
});

function makeJwt(device) {
  return _store.signAccessToken(device);
}

// ---------------------------------------------------------------------------
// createRateLimiter
// ---------------------------------------------------------------------------

describe('createRateLimiter', () => {
  test('allows requests under the limit', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const req = makeReq({ ip: '1.2.3.4' });
      const res = makeRes();
      const out = await new Promise((resolve) => {
        limiter(req, res, () => resolve('next'));
        if (res._body !== null) resolve('sent');
      });
      assert.equal(out, 'next', `Request ${i + 1} should pass`);
    }
  });

  test('returns 429 when limit exceeded', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const ip = '5.6.7.8';
    // Exhaust limit
    for (let i = 0; i < 2; i++) {
      const req = makeReq({ ip });
      const res = makeRes();
      await new Promise((r) => { limiter(req, res, r); });
    }
    // Next request should 429
    const req = makeReq({ ip });
    const res = makeRes();
    await new Promise((r) => { limiter(req, res, r); if (res._body !== null) r(); });
    assert.equal(res._status, 429);
    assert.ok(res._body.code === 'RateLimited' || res._body.error);
  });

  test('429 response includes Retry-After header', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const ip = '9.10.11.12';
    // Exhaust
    const req1 = makeReq({ ip });
    const res1 = makeRes();
    await new Promise((r) => { limiter(req1, res1, r); });
    // Exceed
    const req2 = makeReq({ ip });
    const res2 = makeRes();
    await new Promise((r) => { limiter(req2, res2, r); if (res2._body !== null) r(); });
    assert.equal(res2._status, 429);
    assert.ok(res2._headers['Retry-After'], 'Retry-After header must be set');
  });

  test('window resets after windowMs (simulated via Date.now)', async () => {
    const windowMs = 5000;
    const limiter = createRateLimiter({ windowMs, max: 1 });
    const ip = '20.21.22.23';

    // Use up the limit
    const req1 = makeReq({ ip });
    const res1 = makeRes();
    await new Promise((r) => { limiter(req1, res1, r); });

    // Advance time past window
    const realNow = Date.now;
    Date.now = () => realNow() + windowMs + 1000;
    try {
      const req2 = makeReq({ ip });
      const res2 = makeRes();
      const out = await new Promise((r) => {
        limiter(req2, res2, () => r('next'));
        if (res2._body !== null) r('sent');
      });
      assert.equal(out, 'next', 'After window reset, request should pass');
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// requirePairingToken
// ---------------------------------------------------------------------------

describe('requirePairingToken', () => {
  let mw;
  before(() => { mw = requirePairingToken(_store); });

  test('valid JWT in Authorization: Bearer → next + req.device', async () => {
    const jwt = makeJwt({ id: 'dev_pt1', name: 'PairingTest' });
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` } });
    const res = makeRes();
    const out = await new Promise((r) => { mw(req, res, () => r('next')); if (res._body !== null) r('sent'); });
    assert.equal(out, 'next');
    assert.ok(req.device);
    assert.equal(req.device.id, 'dev_pt1');
    assert.equal(req.device.name, 'PairingTest');
  });

  test('no token → 401 TokenInvalid', async () => {
    const req = makeReq();
    const res = makeRes();
    await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
    assert.equal(res._status, 401);
    assert.equal(res._body.code, 'TokenInvalid');
  });

  test('invalid JWT → 401 TokenInvalid', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer garbage' } });
    const res = makeRes();
    await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
    assert.equal(res._status, 401);
    assert.equal(res._body.code, 'TokenInvalid');
  });

  test('expired JWT → 401 TokenExpired', async () => {
    const jwt = makeJwt({ id: 'dev_expired', name: 'Expired' });
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 1000; // advance time
    try {
      const req = makeReq({ headers: { authorization: `Bearer ${jwt}` } });
      const res = makeRes();
      await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
      assert.equal(res._status, 401);
      assert.equal(res._body.code, 'TokenExpired');
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// requireSensitiveOrPaired
// ---------------------------------------------------------------------------

describe('requireSensitiveOrPaired', () => {
  let mw;
  before(() => { mw = requireSensitiveOrPaired(_store); });

  test('valid sensitive token → next', async () => {
    const req = makeReq({ headers: { 'x-compose-token': 'test-sensitive-token' } });
    const res = makeRes();
    const out = await new Promise((r) => { mw(req, res, () => r('next')); if (res._body !== null) r('sent'); });
    assert.equal(out, 'next');
  });

  test('valid JWT in Authorization → next + req.device', async () => {
    const jwt = makeJwt({ id: 'dev_sp1', name: 'SensOrPaired' });
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` } });
    const res = makeRes();
    const out = await new Promise((r) => { mw(req, res, () => r('next')); if (res._body !== null) r('sent'); });
    assert.equal(out, 'next');
    assert.ok(req.device);
    assert.equal(req.device.id, 'dev_sp1');
  });

  test('no token, COMPOSE_API_TOKEN set → 401', async () => {
    const req = makeReq();
    const res = makeRes();
    await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
    assert.equal(res._status, 401);
  });

  test('503 when COMPOSE_API_TOKEN unset and no JWT — parity with security.js', async () => {
    const orig = process.env.COMPOSE_API_TOKEN;
    delete process.env.COMPOSE_API_TOKEN;
    try {
      const req = makeReq(); // no token
      const res = makeRes();
      await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
      assert.equal(res._status, 503);
      assert.match(res._body.error, /COMPOSE_API_TOKEN/);
    } finally {
      process.env.COMPOSE_API_TOKEN = orig;
    }
  });

  test('503 parity: COMPOSE_API_TOKEN unset + invalid JWT → 503 (not 401)', async () => {
    // When env is unset, the sensitive-token path returns 503.
    // An invalid JWT should fall through and still see 503.
    const orig = process.env.COMPOSE_API_TOKEN;
    delete process.env.COMPOSE_API_TOKEN;
    try {
      const req = makeReq({ headers: { authorization: 'Bearer invalid.jwt.token' } });
      const res = makeRes();
      await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
      assert.equal(res._status, 503);
    } finally {
      process.env.COMPOSE_API_TOKEN = orig;
    }
  });

  test('wrong sensitive token → 401', async () => {
    const req = makeReq({ headers: { 'x-compose-token': 'wrong-token' } });
    const res = makeRes();
    await new Promise((r) => { mw(req, res, r); if (res._body !== null) r(); });
    assert.equal(res._status, 401);
  });
});

// ---------------------------------------------------------------------------
// createAuthGate
// ---------------------------------------------------------------------------

describe('createAuthGate', () => {
  const allowlist = [
    '/api/health',
    '/api/workspace',
    '/api/auth/pair/complete',
    '/api/auth/refresh',
    '/m',
    '/assets/',
    '/manifest.webmanifest',
    '/m-sw.js',
  ];
  let gate;
  before(() => { gate = createAuthGate({ store: _store, allowlist }); });

  function run(req) {
    const res = makeRes();
    return new Promise((resolve) => {
      gate(req, res, () => resolve({ out: 'next', req, res }));
      if (res._body !== null) resolve({ out: 'sent', req, res });
    });
  }

  test('exact allowlisted path passes without auth', async () => {
    const { out } = await run(makeReq({ path: '/api/health' }));
    assert.equal(out, 'next');
  });

  test('prefix allowlisted path /m passes', async () => {
    const { out } = await run(makeReq({ path: '/m' }));
    assert.equal(out, 'next');
  });

  test('sub-path /m/pair passes (prefix match)', async () => {
    const { out } = await run(makeReq({ path: '/m/pair' }));
    assert.equal(out, 'next');
  });

  test('assets prefix /assets/foo.js passes', async () => {
    const { out } = await run(makeReq({ path: '/assets/foo.js' }));
    assert.equal(out, 'next');
  });

  test('non-allowlisted path without credentials → 401', async () => {
    const { out, res } = await run(makeReq({ path: '/api/build/start' }));
    assert.equal(out, 'sent');
    assert.equal(res._status, 401);
  });

  test('sensitive token passes non-allowlisted path', async () => {
    const req = makeReq({ path: '/api/build/start', headers: { 'x-compose-token': 'test-sensitive-token' } });
    const { out } = await run(req);
    assert.equal(out, 'next');
  });

  test('valid JWT in Bearer passes non-allowlisted path + attaches req.device', async () => {
    const jwt = makeJwt({ id: 'dev_gate1', name: 'GateTest' });
    const req = makeReq({ path: '/api/vision/items', headers: { authorization: `Bearer ${jwt}` } });
    const { out, req: outReq } = await run(req);
    assert.equal(out, 'next');
    assert.ok(outReq.device);
    assert.equal(outReq.device.id, 'dev_gate1');
  });

  test('invalid JWT → 401 TokenInvalid', async () => {
    const req = makeReq({ path: '/api/vision/items', headers: { authorization: 'Bearer bad.jwt.here' } });
    const { out, res } = await run(req);
    assert.equal(out, 'sent');
    assert.equal(res._status, 401);
    assert.equal(res._body.code, 'TokenInvalid');
  });

  test('expired JWT → 401 TokenExpired', async () => {
    const jwt = makeJwt({ id: 'dev_gateexp', name: 'GateExp' });
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 1000;
    try {
      const req = makeReq({ path: '/api/vision/items', headers: { authorization: `Bearer ${jwt}` } });
      const { out, res } = await run(req);
      assert.equal(out, 'sent');
      assert.equal(res._status, 401);
      assert.equal(res._body.code, 'TokenExpired');
    } finally {
      Date.now = realNow;
    }
  });

  test('?token= query param accepted for GET with Accept: text/event-stream', async () => {
    const jwt = makeJwt({ id: 'dev_sse', name: 'SSE' });
    const req = makeReq({
      path: '/api/agent/proxy/stream',
      method: 'GET',
      url: `/api/agent/proxy/stream?token=${jwt}`,
      query: { token: jwt },
      headers: { accept: 'text/event-stream' },
    });
    const { out } = await run(req);
    assert.equal(out, 'next');
  });

  test('?token= query param NOT accepted for non-SSE GET', async () => {
    const jwt = makeJwt({ id: 'dev_nosse', name: 'NoSSE' });
    const req = makeReq({
      path: '/api/vision/items',
      method: 'GET',
      url: `/api/vision/items?token=${jwt}`,
      query: { token: jwt },
      headers: {},
    });
    const { out, res } = await run(req);
    assert.equal(out, 'sent');
    assert.equal(res._status, 401);
  });

  test('?token= with sensitive token on SSE path', async () => {
    const req = makeReq({
      path: '/api/agent/proxy/stream',
      method: 'GET',
      url: '/api/agent/proxy/stream?token=test-sensitive-token',
      query: { token: 'test-sensitive-token' },
      headers: { accept: 'text/event-stream' },
    });
    const { out } = await run(req);
    assert.equal(out, 'next');
  });

  test('SSE proxy path /api/agent/proxy/stream matches even without Accept header', async () => {
    const jwt = makeJwt({ id: 'dev_sseproxy', name: 'SSEProxy' });
    const req = makeReq({
      path: '/api/agent/proxy/stream',
      method: 'GET',
      url: `/api/agent/proxy/stream?token=${jwt}`,
      query: { token: jwt },
      headers: {},
    });
    const { out } = await run(req);
    assert.equal(out, 'next');
  });
});

// ---------------------------------------------------------------------------
// wsUpgradeTokenOk
// ---------------------------------------------------------------------------

describe('wsUpgradeTokenOk', () => {
  test('returns true for valid sensitive token in ?token=', () => {
    const req = { url: '/ws/vision?token=test-sensitive-token' };
    assert.equal(wsUpgradeTokenOk(_store, req), true);
  });

  test('returns true for valid JWT in ?token=', () => {
    const jwt = makeJwt({ id: 'dev_ws1', name: 'WSTest' });
    const req = { url: `/ws/vision?token=${jwt}` };
    assert.equal(wsUpgradeTokenOk(_store, req), true);
  });

  test('returns false for missing ?token=', () => {
    const req = { url: '/ws/vision' };
    assert.equal(wsUpgradeTokenOk(_store, req), false);
  });

  test('returns false for invalid JWT', () => {
    const req = { url: '/ws/vision?token=garbage' };
    assert.equal(wsUpgradeTokenOk(_store, req), false);
  });

  test('returns false for wrong sensitive token', () => {
    const req = { url: '/ws/vision?token=wrong-token' };
    assert.equal(wsUpgradeTokenOk(_store, req), false);
  });

  test('returns false for expired JWT', () => {
    const jwt = makeJwt({ id: 'dev_wsexp', name: 'WSExp' });
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 1000;
    try {
      const req = { url: `/ws/vision?token=${jwt}` };
      assert.equal(wsUpgradeTokenOk(_store, req), false);
    } finally {
      Date.now = realNow;
    }
  });
});
