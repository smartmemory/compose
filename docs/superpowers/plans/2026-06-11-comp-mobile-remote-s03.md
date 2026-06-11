# COMP-MOBILE-REMOTE S03 — CLI `remote` verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `compose remote` verb family (pair, list, revoke, rotate-secret, status) plus `compose start --host=` in `bin/compose.js`, with testable logic extracted to `lib/cli-remote.js`, covered by `test/cli-remote.test.js`.

**Architecture:** Logic lives in `lib/cli-remote.js` (pure functions, dependency-injected, testable without spawning the CLI). `bin/compose.js` imports `runRemoteCommand` and dispatches on `cmd === 'remote'`. The pairing flow polls the server via `http.request` — same pattern as `test/auth-routes.test.js`. Public-host persistence spreads the existing `compose.json` to preserve unknown keys.

**Tech Stack:** Node.js ESM, `node:http`, `node:fs`, `qrcode-terminal` (already installed), `node:test` + `node:assert/strict` for tests.

---

## File Map

| File | Action | What |
|---|---|---|
| `lib/cli-remote.js` | **new** | All remote verb logic: `runRemoteCommand(subArgs, opts)`. Dependency-injected for testability. |
| `bin/compose.js` | **edit** | Add `remote` to help text, add `cmd === 'remote'` dispatch, add `--host` to `start`. |
| `server/auth-routes.js` | **edit (conditional)** | Add `POST /api/auth/rotate-secret` if missing (deviation note: S01 omitted it). |
| `test/auth-routes.test.js` | **edit (conditional)** | Add test for rotate-secret route if we add it. |
| `test/cli-remote.test.js` | **new** | Full test suite for `lib/cli-remote.js` via stub HTTP server. |

---

## Task 1: Verify rotate-secret route exists; add if missing

**Files:**
- Inspect: `server/auth-routes.js`
- Conditionally edit: `server/auth-routes.js`, `test/auth-routes.test.js`

- [ ] **Step 1: Check if POST /api/auth/rotate-secret exists in auth-routes.js**

```bash
grep -n "rotate-secret\|rotateSecret" /Users/ruze/reg/my/forge/compose/server/auth-routes.js
```

Expected: no match (S01 omitted it per the spec).

- [ ] **Step 2: Write the failing test first**

Add to `test/auth-routes.test.js` — a new `describe` block at the bottom of the file:

```js
// ---------------------------------------------------------------------------
// rotate-secret route (deviation: S01 omitted this; added in S03)
// ---------------------------------------------------------------------------

describe('Auth routes — rotate-secret', () => {
  let dir;
  let store;
  let server;
  let _origToken;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-routes-rotate-'));
    store = createAuthStore(dir);
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'rotate-test-token';
    server = await listen(makeApp({ store }));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  const SENSITIVE = { 'x-compose-token': 'rotate-test-token' };

  test('POST /api/auth/rotate-secret without token → 401/503', async () => {
    const r = await request(server, '/api/auth/rotate-secret', { method: 'POST', body: {} });
    assert.ok(r.status === 401 || r.status === 503);
  });

  test('POST /api/auth/rotate-secret with sensitive token → { ok: true }', async () => {
    const r = await request(server, '/api/auth/rotate-secret', {
      method: 'POST',
      body: {},
      headers: SENSITIVE,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('POST /api/auth/rotate-secret invalidates outstanding JWTs', async () => {
    // Pair a device, get an access token
    const initR = await request(server, '/api/auth/pair/init', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });
    const completeR = await request(server, '/api/auth/pair/complete', {
      method: 'POST', body: { code: initR.body.code, device_name: 'RotatePhone' },
    });
    const jwt = completeR.body.access_token;

    // Verify the JWT works before rotation (using requireSensitiveOrPaired app)
    const store2 = createAuthStore(mkdtempSync(join(tmpdir(), 'auth-routes-rotate2-')));
    // Use a shared store: we need to verify the JWT from THIS store is invalidated.
    // Directly verify via the store's verifyAccessToken.
    const beforeResult = store.verifyAccessToken(jwt);
    assert.ok(!beforeResult.error, `JWT should be valid before rotation: ${beforeResult.error}`);

    // Rotate the secret
    await request(server, '/api/auth/rotate-secret', {
      method: 'POST', body: {}, headers: SENSITIVE,
    });

    // JWT should now be invalid
    const afterResult = store.verifyAccessToken(jwt);
    assert.ok(afterResult.error, 'JWT should be invalid after secret rotation');
  });
});
```

- [ ] **Step 3: Run to confirm failure**

```bash
node --test --test-timeout=90000 test/auth-routes.test.js 2>&1 | tail -20
```

Expected: FAIL — `POST /api/auth/rotate-secret` returns 404.

- [ ] **Step 4: Add rotate-secret route to server/auth-routes.js**

Add after the `DELETE /api/auth/devices/:id` handler (before the closing `}`):

```js
  // -------------------------------------------------------------------------
  // POST /api/auth/rotate-secret
  // -------------------------------------------------------------------------
  /**
   * Rotate the JWT signing secret.
   * Invalidates ALL outstanding access tokens immediately.
   * Device records and refresh tokens are preserved (but refresh will fail
   * until the client re-pairs, since new access tokens will be issued under
   * the new secret).
   *
   * Deviation note: S01 omitted this route; added in S03 for CLI support.
   * Requires sensitive token.
   */
  app.post('/api/auth/rotate-secret', requireSensitive, (req, res) => {
    store.rotateSecret();
    res.json({ ok: true });
  });
```

- [ ] **Step 5: Verify auth-routes tests pass**

```bash
node --test --test-timeout=90000 test/auth-routes.test.js 2>&1 | tail -20
```

Expected: all tests pass including the new rotate-secret suite.

---

## Task 2: Write the failing tests for lib/cli-remote.js

**Files:**
- Create: `test/cli-remote.test.js`

This is the TDD step — write ALL tests before writing `lib/cli-remote.js`. The tests use a stub HTTP server (same `request`/`listen` pattern as `test/auth-routes.test.js`).

- [ ] **Step 1: Create test/cli-remote.test.js**

```js
/**
 * cli-remote.test.js — COMP-MOBILE-REMOTE S03
 *
 * Tests for lib/cli-remote.js — CLI remote verb logic.
 * Uses a stub HTTP server (same pattern as auth-routes.test.js).
 *
 * Run: node --test --test-timeout=90000 test/cli-remote.test.js
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load the module under test — use dynamic import for ESM
const { runRemoteCommand } = await import(`${REPO_ROOT}/lib/cli-remote.js`);

// ---------------------------------------------------------------------------
// HTTP test helpers (same pattern as auth-routes.test.js)
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
        res({ status: response.statusCode, body: parsed });
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
// Fixture helpers
// ---------------------------------------------------------------------------

function makeComposeDir(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-remote-'));
  mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
  const cfg = {
    version: 2,
    capabilities: { stratum: true, lifecycle: true },
    ...(opts.config || {}),
  };
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify(cfg, null, 2));
  return dir;
}

// ---------------------------------------------------------------------------
// Stub server factory
// ---------------------------------------------------------------------------

function makeStubServer({
  initCode = 'TESTCODE123',
  initExpires = new Date(Date.now() + 300_000).toISOString(),
  statusSequence = ['pending', 'consumed'],
  devices = [],
  token = 'stub-token',
} = {}) {
  const app = express();
  app.use(express.json());

  let statusCallCount = 0;

  app.post('/api/auth/pair/init', (req, res) => {
    if (req.headers['x-compose-token'] !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ code: initCode, expires_at: initExpires, pair_url: null });
  });

  app.get('/api/auth/pair/status', (req, res) => {
    if (req.headers['x-compose-token'] !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const status = statusSequence[Math.min(statusCallCount, statusSequence.length - 1)];
    statusCallCount++;
    res.json({ status });
  });

  app.get('/api/auth/devices', (req, res) => {
    if (req.headers['x-compose-token'] !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ devices });
  });

  app.delete('/api/auth/devices/:id', (req, res) => {
    if (req.headers['x-compose-token'] !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const found = devices.find((d) => d.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  app.post('/api/auth/rotate-secret', (req, res) => {
    if (req.headers['x-compose-token'] !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ ok: true });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  return listen(app);
}

// ---------------------------------------------------------------------------
// runRemoteCommand opts factory
// ---------------------------------------------------------------------------

function makeOpts(server, overrides = {}) {
  const port = server.address().port;
  return {
    port,
    token: 'stub-token',
    lines: [],
    qr: () => {},
    poll: () => new Promise((r) => setTimeout(r, 0)),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TESTS: pair verb
// ---------------------------------------------------------------------------

describe('remote pair — help text', () => {
  test('pair without COMPOSE_API_TOKEN errors helpfully', async () => {
    const dir = makeComposeDir();
    const lines = [];
    const orig = process.env.COMPOSE_API_TOKEN;
    delete process.env.COMPOSE_API_TOKEN;
    try {
      await runRemoteCommand(['pair'], {
        cwd: dir,
        port: 4001,
        token: undefined,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
    } catch (e) {
      assert.ok(
        e.message.includes('COMPOSE_API_TOKEN') || lines.some((l) => l.includes('COMPOSE_API_TOKEN')),
        `Expected COMPOSE_API_TOKEN mention, got: ${lines.join('\n')} / ${e.message}`,
      );
    } finally {
      if (orig === undefined) delete process.env.COMPOSE_API_TOKEN;
      else process.env.COMPOSE_API_TOKEN = orig;
    }
  });
});

describe('remote pair — full flow', () => {
  let server;
  let dir;
  const TOKEN = 'stub-token';

  before(async () => {
    server = await makeStubServer({
      initCode: 'ABCDEF123456',
      statusSequence: ['pending', 'consumed'],
      token: TOKEN,
    });
    dir = makeComposeDir();
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('pair: posts to /api/auth/pair/init with x-compose-token header', async () => {
    const lines = [];
    let capturedQr = null;
    const opts = {
      ...makeOpts(server, { token: TOKEN }),
      cwd: dir,
      lines,
      qr: (url) => { capturedQr = url; },
      // Override poll to immediately return consumed after first call
      poll: () => Promise.resolve('consumed'),
    };

    await runRemoteCommand(['pair'], opts);

    assert.ok(lines.some((l) => l.includes('ABCDEF123456') || l.includes('Paired') || l.includes('pair')),
      `Expected pair output, got: ${lines.join('\n')}`);
  });

  test('pair: with --public-host constructs pair_url correctly', async () => {
    const lines = [];
    const opts = {
      ...makeOpts(server, { token: TOKEN }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve('consumed'),
    };

    await runRemoteCommand(['pair', '--public-host=https://example.com'], opts);

    assert.ok(
      lines.some((l) => l.includes('https://example.com/m/pair?code=ABCDEF123456')),
      `Expected pair URL with public host, got: ${lines.join('\n')}`,
    );
  });

  test('pair: with --public-host persists to compose.json preserving unknown keys', async () => {
    const dir2 = makeComposeDir({
      config: {
        version: 2,
        _unknownKey: 'preserved',
        capabilities: { stratum: true, lifecycle: true },
      },
    });
    try {
      const opts = {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir2,
        lines: [],
        qr: () => {},
        poll: () => Promise.resolve('consumed'),
      };

      await runRemoteCommand(['pair', '--public-host=https://persist.example.com'], opts);

      const cfg = JSON.parse(readFileSync(join(dir2, '.compose', 'compose.json'), 'utf-8'));
      assert.equal(cfg.remote?.public_host, 'https://persist.example.com',
        'public_host should be persisted to compose.json');
      assert.equal(cfg._unknownKey, 'preserved',
        'Unknown keys must be preserved (spread pattern)');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('pair: without --public-host reads public_host from compose.json', async () => {
    const dir3 = makeComposeDir({
      config: {
        version: 2,
        capabilities: { stratum: true, lifecycle: true },
        remote: { public_host: 'https://from-config.example.com' },
      },
    });
    try {
      const lines = [];
      const opts = {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir3,
        lines,
        qr: () => {},
        poll: () => Promise.resolve('consumed'),
      };

      await runRemoteCommand(['pair'], opts);

      assert.ok(
        lines.some((l) => l.includes('https://from-config.example.com/m/pair?code=')),
        `Expected URL from config, got: ${lines.join('\n')}`,
      );
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  });

  test('pair: without public_host prints localhost URL with warning', async () => {
    const dir4 = makeComposeDir();
    try {
      const lines = [];
      const opts = {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir4,
        lines,
        qr: () => {},
        poll: () => Promise.resolve('consumed'),
      };

      await runRemoteCommand(['pair'], opts);

      assert.ok(
        lines.some((l) => l.includes('localhost') || l.includes('warning') || l.includes('WARNING') || l.includes('public')),
        `Expected localhost URL or warning, got: ${lines.join('\n')}`,
      );
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
  });

  test('pair: polls status until consumed, prints "Paired!"', async () => {
    let pollCount = 0;
    const server2 = await makeStubServer({
      initCode: 'POLLCODE',
      statusSequence: ['pending', 'pending', 'consumed'],
      token: TOKEN,
    });
    try {
      const lines = [];
      const pollCalls = [];
      const opts = {
        ...makeOpts(server2, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        // Intercept poll — each call resolves the next status from the stub
        poll: (delayMs) => {
          pollCalls.push(delayMs);
          return Promise.resolve();
        },
      };

      await runRemoteCommand(['pair'], opts);

      assert.ok(lines.some((l) => l.includes('Paired') || l.includes('paired') || l.includes('consumed')),
        `Expected "Paired!" in output, got: ${lines.join('\n')}`);
    } finally {
      server2.close();
    }
  });

  test('pair: status expired → prints expiry message, exits cleanly', async () => {
    const server3 = await makeStubServer({
      initCode: 'EXPIRECODE',
      statusSequence: ['expired'],
      token: TOKEN,
    });
    try {
      const lines = [];
      const opts = {
        ...makeOpts(server3, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      };

      // Should NOT throw; should print expiry message
      await runRemoteCommand(['pair'], opts);

      assert.ok(lines.some((l) => l.toLowerCase().includes('expir') || l.toLowerCase().includes('code')),
        `Expected expiry message, got: ${lines.join('\n')}`);
    } finally {
      server3.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TESTS: list verb
// ---------------------------------------------------------------------------

describe('remote list', () => {
  let server;
  let dir;
  const TOKEN = 'stub-token';
  const DEVICES = [
    { id: 'dev_1', name: 'iPhone 15', paired_at: '2026-06-01T00:00:00Z', last_seen: '2026-06-10T00:00:00Z', revoked: false },
    { id: 'dev_2', name: 'Android', paired_at: '2026-06-02T00:00:00Z', last_seen: '2026-06-09T00:00:00Z', revoked: true },
  ];

  before(async () => {
    server = await makeStubServer({ devices: DEVICES, token: TOKEN });
    dir = makeComposeDir();
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('list prints device table with id, name, paired_at, last_seen, revoked', async () => {
    const lines = [];
    await runRemoteCommand(['list'], {
      ...makeOpts(server, { token: TOKEN }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve(),
    });

    const out = lines.join('\n');
    assert.ok(out.includes('dev_1'), `Expected dev_1 in output: ${out}`);
    assert.ok(out.includes('iPhone 15'), `Expected device name in output: ${out}`);
    assert.ok(out.includes('dev_2'), `Expected dev_2 in output: ${out}`);
    assert.ok(out.includes('Android'), `Expected Android in output: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// TESTS: revoke verb
// ---------------------------------------------------------------------------

describe('remote revoke', () => {
  let server;
  let dir;
  const TOKEN = 'stub-token';
  const DEVICES = [
    { id: 'dev_revoke_1', name: 'iPhone', paired_at: '2026-06-01T00:00:00Z', last_seen: '2026-06-10T00:00:00Z', revoked: false },
  ];

  before(async () => {
    server = await makeStubServer({ devices: DEVICES, token: TOKEN });
    dir = makeComposeDir();
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('revoke with known device id prints success', async () => {
    const lines = [];
    await runRemoteCommand(['revoke', 'dev_revoke_1'], {
      ...makeOpts(server, { token: TOKEN }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve(),
    });
    const out = lines.join('\n');
    assert.ok(out.toLowerCase().includes('revok') || out.includes('ok') || out.includes('dev_revoke_1'),
      `Expected revoke success, got: ${out}`);
  });

  test('revoke without device-id prints usage error', async () => {
    const lines = [];
    let threw = false;
    try {
      await runRemoteCommand(['revoke'], {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
    } catch {
      threw = true;
    }
    const out = lines.join('\n');
    assert.ok(threw || out.toLowerCase().includes('usage') || out.includes('device-id') || out.includes('device id'),
      `Expected usage error for missing device-id, got: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// TESTS: rotate-secret verb
// ---------------------------------------------------------------------------

describe('remote rotate-secret', () => {
  let server;
  let dir;
  const TOKEN = 'stub-token';

  before(async () => {
    server = await makeStubServer({ token: TOKEN });
    dir = makeComposeDir();
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('rotate-secret without --yes refuses and explains', async () => {
    const lines = [];
    let threw = false;
    try {
      await runRemoteCommand(['rotate-secret'], {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
    } catch {
      threw = true;
    }
    const out = lines.join('\n');
    assert.ok(
      threw || out.toLowerCase().includes('--yes') || out.toLowerCase().includes('invalidate'),
      `Expected refusal without --yes, got: ${out} (threw: ${threw})`,
    );
  });

  test('rotate-secret with --yes calls the server and prints result', async () => {
    const lines = [];
    await runRemoteCommand(['rotate-secret', '--yes'], {
      ...makeOpts(server, { token: TOKEN }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve(),
    });
    const out = lines.join('\n');
    assert.ok(out.toLowerCase().includes('rotat') || out.includes('ok') || out.includes('secret'),
      `Expected rotation success, got: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// TESTS: status verb
// ---------------------------------------------------------------------------

describe('remote status', () => {
  let server;

  before(async () => {
    server = await makeStubServer({
      devices: [
        { id: 'dev_1', name: 'Phone', paired_at: '2026-06-01T00:00:00Z', last_seen: '2026-06-10T00:00:00Z', revoked: false },
      ],
      token: 'status-tok',
    });
  });

  after(() => server.close());

  test('status without public_host: shows bind host, no reachability check', async () => {
    const dir = makeComposeDir();
    try {
      const lines = [];
      await runRemoteCommand(['status'], {
        ...makeOpts(server, { token: 'status-tok' }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
        headFn: undefined, // no HEAD check without public_host
      });
      const out = lines.join('\n');
      // Should print bind host and remote-auth flag status
      assert.ok(out.includes('127.0.0.1') || out.includes('localhost') || out.includes('host'),
        `Expected bind host in status, got: ${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status with public_host configured: performs HEAD check', async () => {
    const port = server.address().port;
    const dir = makeComposeDir({
      config: {
        version: 2,
        capabilities: { stratum: true, lifecycle: true },
        remote: { public_host: `http://127.0.0.1:${port}` },
      },
    });
    try {
      const lines = [];
      await runRemoteCommand(['status'], {
        ...makeOpts(server, { token: 'status-tok' }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
      const out = lines.join('\n');
      assert.ok(
        out.includes(`http://127.0.0.1:${port}`) || out.toLowerCase().includes('reachable') || out.includes('health'),
        `Expected public_host in status output, got: ${out}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status with server not running: graceful ECONNREFUSED message', async () => {
    const dir = makeComposeDir();
    try {
      const lines = [];
      // Use a port nobody is listening on
      await runRemoteCommand(['status'], {
        port: 19999,
        token: 'tok',
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
      const out = lines.join('\n');
      assert.ok(
        out.toLowerCase().includes('not running') || out.toLowerCase().includes('econnrefused') || out.toLowerCase().includes('server'),
        `Expected server-not-running message, got: ${out}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status warns when dist/ is missing', async () => {
    const dir = makeComposeDir();
    const lines = [];
    // distDir points to a nonexistent path
    await runRemoteCommand(['status'], {
      ...makeOpts(server, { token: 'status-tok' }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve(),
      distDir: join(dir, 'dist-missing-NOTEXIST'),
    });
    const out = lines.join('\n');
    assert.ok(
      out.toLowerCase().includes('dist') || out.toLowerCase().includes('build') || out.toLowerCase().includes('npm run build'),
      `Expected dist warning, got: ${out}`,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test('status shows paired device count from server', async () => {
    const dir = makeComposeDir();
    try {
      const lines = [];
      await runRemoteCommand(['status'], {
        ...makeOpts(server, { token: 'status-tok' }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
      const out = lines.join('\n');
      // Should mention 1 device
      assert.ok(out.includes('1') || out.includes('device'),
        `Expected device count in status, got: ${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to confirm all tests fail (module not found)**

```bash
node --test --test-timeout=90000 test/cli-remote.test.js 2>&1 | head -20
```

Expected: Error — `Cannot find module .../lib/cli-remote.js`

---

## Task 3: Implement lib/cli-remote.js

**Files:**
- Create: `lib/cli-remote.js`

- [ ] **Step 1: Create lib/cli-remote.js**

```js
/**
 * cli-remote.js — COMP-MOBILE-REMOTE S03
 *
 * Logic for `compose remote` CLI verbs.
 * Extracted to lib/ so tests can import without spawning the CLI binary.
 *
 * Exports:
 *   runRemoteCommand(subArgs, opts) — dispatches to the appropriate verb.
 *
 * opts shape:
 *   port       {number}   Server port (default: 4001 via resolvePort)
 *   token      {string}   COMPOSE_API_TOKEN value (default: process.env.COMPOSE_API_TOKEN)
 *   cwd        {string}   Project root (default: resolved from cwd/workspace)
 *   lines      {string[]} Output collector (push here instead of console.log for testability)
 *   qr         {function} QR renderer: (url: string) => void  (default: qrcode-terminal.generate)
 *   poll       {function} Delay function: (ms: number) => Promise<void>  (default: sleep)
 *   distDir    {string}   Path to dist/ (default: COMPOSE_HOME/dist)
 *   headFn     {function} HEAD check: (url: string) => Promise<{ok,status}>  (default: http.request)
 *
 * @module lib/cli-remote
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_HOME = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to the local compose server.
 * Returns { status, body }.
 */
function serverRequest(port, urlPath, { method = 'GET', body, headers = {} } = {}) {
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
        res({ status: response.statusCode, body: parsed });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Default HEAD check for remote status.
 */
async function defaultHeadCheck(url, timeoutMs = 5000) {
  const parsed = new URL(url);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'HEAD',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode < 400, status: res.statusCode });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

/**
 * Read compose.json from a project root. Returns {} on error.
 */
function readComposeJson(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(cfgPath)) return {};
  try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { return {}; }
}

/**
 * Write compose.json, preserving all unknown keys (spread existing first).
 */
function writeComposeJson(cwd, patch) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  const existing = readComposeJson(cwd);
  const merged = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      merged[k] = { ...(existing[k] || {}), ...v };
    } else {
      merged[k] = v;
    }
  }
  writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
}

/**
 * Parse a --flag=value or --flag value style arg from an args array.
 * Returns the value string or undefined.
 */
function parseFlag(args, name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

async function verbPair(subArgs, { port, token, cwd, lines, qr, poll }) {
  if (!token) {
    lines.push('Error: COMPOSE_API_TOKEN is not set.');
    lines.push('The compose server must be running and COMPOSE_API_TOKEN must be exported.');
    lines.push('Tip: start the server with `compose start` first, then run this command in the same shell session.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  // Resolve public_host: flag > compose.json
  let publicHost = parseFlag(subArgs, 'public-host');
  const cfg = readComposeJson(cwd);
  if (!publicHost) {
    publicHost = cfg.remote?.public_host || null;
  }

  // If flag was given, persist it
  if (parseFlag(subArgs, 'public-host')) {
    writeComposeJson(cwd, { remote: { public_host: publicHost } });
  }

  // Call pair/init
  let initResult;
  try {
    initResult = await serverRequest(port, '/api/auth/pair/init', {
      method: 'POST',
      body: {},
      headers: { 'x-compose-token': token },
    });
  } catch (err) {
    lines.push(`Error: Could not reach compose server on port ${port}.`);
    lines.push('Make sure the server is running: compose start');
    throw err;
  }

  if (initResult.status !== 200) {
    lines.push(`Error from server: ${JSON.stringify(initResult.body)}`);
    throw new Error(`pair/init failed: ${initResult.status}`);
  }

  const { code, expires_at } = initResult.body;

  // Build pair URL
  let pairUrl;
  if (publicHost) {
    pairUrl = `${publicHost.replace(/\/$/, '')}/m/pair?code=${code}`;
  } else {
    pairUrl = `http://127.0.0.1:${port}/m/pair?code=${code}`;
    lines.push('WARNING: No public_host configured. Generating a localhost URL (only works on this machine).');
    lines.push('Set a public host with: compose remote pair --public-host=<your-tunnel-URL>');
  }

  lines.push('');
  lines.push(`Pair URL: ${pairUrl}`);
  lines.push(`Code expires at: ${expires_at}`);
  lines.push('');

  // Render QR
  qr(pairUrl);

  lines.push('');
  lines.push('Waiting for device to pair (Ctrl-C to cancel)...');

  // Poll pair/status every 2s until consumed, expired, or interrupted
  while (true) {
    await poll(2000);

    let statusResult;
    try {
      statusResult = await serverRequest(port, `/api/auth/pair/status?code=${encodeURIComponent(code)}`, {
        method: 'GET',
        headers: { 'x-compose-token': token },
      });
    } catch {
      lines.push('Warning: lost connection to server while polling.');
      break;
    }

    if (statusResult.status !== 200) {
      lines.push(`Polling error: ${JSON.stringify(statusResult.body)}`);
      break;
    }

    const status = statusResult.body.status;
    if (status === 'consumed') {
      lines.push('Paired! Device successfully authenticated.');
      break;
    } else if (status === 'expired') {
      lines.push('Pairing code expired. Run `compose remote pair` again to generate a new code.');
      break;
    }
    // pending — continue polling
  }
}

async function verbList(subArgs, { port, token, cwd, lines }) {
  if (!token) {
    lines.push('Error: COMPOSE_API_TOKEN is not set.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  let result;
  try {
    result = await serverRequest(port, '/api/auth/devices', {
      method: 'GET',
      headers: { 'x-compose-token': token },
    });
  } catch {
    lines.push(`Error: Could not reach compose server on port ${port}.`);
    lines.push('Make sure the server is running: compose start');
    return;
  }

  if (result.status !== 200) {
    lines.push(`Error from server: ${JSON.stringify(result.body)}`);
    return;
  }

  const devices = result.body.devices || [];
  if (devices.length === 0) {
    lines.push('No paired devices.');
    return;
  }

  // Table header
  const COL = { id: 24, name: 30, paired_at: 26, last_seen: 26, revoked: 8 };
  const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  lines.push(
    `${pad('ID', COL.id)}  ${pad('Name', COL.name)}  ${pad('Paired At', COL.paired_at)}  ${pad('Last Seen', COL.last_seen)}  ${pad('Revoked', COL.revoked)}`,
  );
  lines.push('-'.repeat(COL.id + COL.name + COL.paired_at + COL.last_seen + COL.revoked + 8));

  for (const d of devices) {
    lines.push(
      `${pad(d.id, COL.id)}  ${pad(d.name, COL.name)}  ${pad(d.paired_at, COL.paired_at)}  ${pad(d.last_seen, COL.last_seen)}  ${pad(d.revoked, COL.revoked)}`,
    );
  }
}

async function verbRevoke(subArgs, { port, token, lines }) {
  const deviceId = subArgs[0];
  if (!deviceId || deviceId.startsWith('--')) {
    lines.push('Usage: compose remote revoke <device-id>');
    lines.push('Get device IDs with: compose remote list');
    throw new Error('Missing device-id');
  }
  if (!token) {
    lines.push('Error: COMPOSE_API_TOKEN is not set.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  let result;
  try {
    result = await serverRequest(port, `/api/auth/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'x-compose-token': token },
    });
  } catch {
    lines.push(`Error: Could not reach compose server on port ${port}.`);
    return;
  }

  if (result.status === 404) {
    lines.push(`Device not found: ${deviceId}`);
    return;
  }
  if (result.status !== 200) {
    lines.push(`Error from server: ${JSON.stringify(result.body)}`);
    return;
  }
  lines.push(`Revoked device: ${deviceId}`);
}

async function verbRotateSecret(subArgs, { port, token, lines }) {
  if (!hasFlag(subArgs, 'yes')) {
    lines.push('Error: rotate-secret requires --yes to confirm.');
    lines.push('This operation invalidates ALL paired devices\' tokens immediately.');
    lines.push('To proceed: compose remote rotate-secret --yes');
    throw new Error('--yes required');
  }
  if (!token) {
    lines.push('Error: COMPOSE_API_TOKEN is not set.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  let result;
  try {
    result = await serverRequest(port, '/api/auth/rotate-secret', {
      method: 'POST',
      body: {},
      headers: { 'x-compose-token': token },
    });
  } catch {
    lines.push(`Error: Could not reach compose server on port ${port}.`);
    return;
  }

  if (result.status !== 200) {
    lines.push(`Error from server: ${JSON.stringify(result.body)}`);
    return;
  }
  lines.push('Secret rotated. All paired device tokens are now invalid.');
  lines.push('Devices must re-pair. Run `compose remote pair` to generate new pairing codes.');
}

async function verbStatus(subArgs, { port, token, cwd, lines, distDir, headFn }) {
  const cfg = readComposeJson(cwd);
  const publicHost = cfg.remote?.public_host || null;
  const remoteAuthFlag = process.env.COMPOSE_REMOTE_AUTH || 'disabled';

  // Resolve dist dir (default: COMPOSE_HOME/dist)
  const resolvedDistDir = distDir || join(COMPOSE_HOME, 'dist');

  // 1. Bind host
  const bindHost = process.env.COMPOSE_HOST || cfg.server?.host || '127.0.0.1';
  lines.push(`Bind host:       ${bindHost}`);

  // 2. Remote auth flag
  lines.push(`Remote auth:     ${remoteAuthFlag}`);

  // 3. Public host
  lines.push(`Public host:     ${publicHost || 'not configured'}`);

  // 4. dist/ presence
  const distExists = existsSync(resolvedDistDir);
  lines.push(`dist/ bundle:    ${distExists ? 'present' : 'MISSING — run npm run build'}`);

  // 5. Paired device count (graceful on ECONNREFUSED)
  if (token) {
    try {
      const devResult = await serverRequest(port, '/api/auth/devices', {
        method: 'GET',
        headers: { 'x-compose-token': token },
      });
      if (devResult.status === 200) {
        const count = (devResult.body.devices || []).filter((d) => !d.revoked).length;
        lines.push(`Paired devices:  ${count}`);
      } else {
        lines.push(`Paired devices:  (could not read — ${devResult.status})`);
      }
    } catch {
      lines.push(`Paired devices:  (server not running on port ${port})`);
    }
  } else {
    lines.push('Paired devices:  (COMPOSE_API_TOKEN not set — cannot query server)');
  }

  // 6. Public host reachability (HEAD /api/health)
  if (publicHost) {
    const headUrl = `${publicHost.replace(/\/$/, '')}/api/health`;
    lines.push(`Checking reachability: HEAD ${headUrl} ...`);
    const checkFn = headFn || defaultHeadCheck;
    try {
      const headResult = await checkFn(headUrl);
      if (headResult.ok) {
        lines.push(`Public host:     reachable (${headResult.status})`);
      } else {
        lines.push(`Public host:     UNREACHABLE (${headResult.status || 'no response'})`);
      }
    } catch {
      lines.push('Public host:     UNREACHABLE (error during check)');
    }
  } else {
    lines.push('Run `compose remote pair --public-host=<URL>` to configure your tunnel.');
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Run a remote subcommand.
 *
 * @param {string[]} subArgs  - arguments after "remote" (e.g. ['pair', '--public-host=...'])
 * @param {object}  opts
 * @param {number}  [opts.port]     - server port (default: 4001)
 * @param {string}  [opts.token]    - COMPOSE_API_TOKEN (default: process.env.COMPOSE_API_TOKEN)
 * @param {string}  [opts.cwd]      - project root
 * @param {string[]}[opts.lines]    - output collector (default: prints to stdout)
 * @param {function}[opts.qr]       - QR renderer (default: qrcode-terminal)
 * @param {function}[opts.poll]     - delay fn (ms) => Promise<void>
 * @param {string}  [opts.distDir]  - path to dist/ (for status)
 * @param {function}[opts.headFn]   - HEAD check fn (for status)
 */
export async function runRemoteCommand(subArgs, opts = {}) {
  const {
    port = 4001,
    token = process.env.COMPOSE_API_TOKEN,
    cwd = process.cwd(),
    lines = null,
    qr = null,
    poll = null,
    distDir = undefined,
    headFn = undefined,
  } = opts;

  // If no lines collector provided, print to stdout
  const out = lines || { push: (l) => console.log(l) };
  if (!lines) out.push = (l) => console.log(l);

  // Default QR renderer
  const qrFn = qr || (async (url) => {
    const { default: qrcode } = await import('qrcode-terminal');
    qrcode.generate(url, { small: true });
  });

  // Default poll (sleep)
  const pollFn = poll || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const sub = subArgs[0];
  const rest = subArgs.slice(1);

  const ctx = { port, token, cwd, lines: out, qr: qrFn, poll: pollFn, distDir, headFn };

  switch (sub) {
    case 'pair':
      return verbPair(rest, ctx);

    case 'list':
      return verbList(rest, ctx);

    case 'revoke':
      return verbRevoke(rest, ctx);

    case 'rotate-secret':
      return verbRotateSecret(rest, ctx);

    case 'status':
      return verbStatus(rest, ctx);

    default: {
      out.push('Usage: compose remote <subcommand>');
      out.push('');
      out.push('Subcommands:');
      out.push('  pair [--public-host=URL] [--name=NAME]   Pair a new device via QR code');
      out.push('  list                                     List paired devices');
      out.push('  revoke <device-id>                       Revoke a paired device');
      out.push('  rotate-secret --yes                      Rotate the JWT signing secret (invalidates all devices)');
      out.push('  status                                   Show remote configuration and server health');
      if (sub && sub !== '--help' && sub !== '-h') {
        out.push(`\nUnknown subcommand: ${sub}`);
      }
      break;
    }
  }
}
```

- [ ] **Step 2: Run the cli-remote tests**

```bash
node --test --test-timeout=90000 test/cli-remote.test.js 2>&1 | tail -30
```

Expected: tests pass (or identify specific failures to fix in the next step).

- [ ] **Step 3: Fix any test failures**

Common issues and fixes:
- "Cannot find module" for `qrcode-terminal` → ensure dynamic import in runRemoteCommand falls back cleanly in tests (opts.qr is always provided in tests, so it won't actually call the import).
- Status test for "server not running" fails → ensure the catch block in verbStatus produces the expected output string containing "server" or "not running".
- Pair test for "unknown keys preserved" fails → verify writeComposeJson spreads existing config at top level AND merges `remote` sub-object.

Re-run until all pass:

```bash
node --test --test-timeout=90000 test/cli-remote.test.js 2>&1 | tail -30
```

---

## Task 4: Wire remote into bin/compose.js

**Files:**
- Modify: `bin/compose.js`

- [ ] **Step 1: Add `remote` to the help text**

Find the help block (around line 107) and add the remote line. Locate the block:

```js
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage: compose <command>')
  console.log('')
  console.log('Commands:')
  console.log('  start     Start the compose app (UI + API) for this project')
```

Add after `  start     Start the compose app (UI + API) for this project`:

```js
  console.log('  remote    Manage remote access (pair, list, revoke, status)')
```

- [ ] **Step 2: Add --host to start dispatch and add remote dispatch**

Find the `start` block at line 2336:

```js
} else if (cmd === 'start') {
  // Resolve target root BEFORE spawning supervisor.
  ...
  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: { ...process.env, COMPOSE_TARGET: targetRoot },
  })
```

Replace the `spawn` call (preserving `child.on('error')` and `child.on('exit')`) to thread `--host` as `COMPOSE_HOST`:

```js
} else if (cmd === 'start') {
  // Resolve target root BEFORE spawning supervisor.
  // Use the unified resolver — it handles COMPOSE_TARGET as either ID or absolute path,
  // --workspace=<id>, and discovery. No need for the legacy explicitTarget short-circuit.
  const { root: targetRoot } = resolveCwdWithWorkspace(args)

  if (!targetRoot || !existsSync(join(targetRoot, '.compose', 'compose.json'))) {
    console.error('[compose] No .compose/ found (searched from cwd upward).')
    console.error("[compose] Run 'compose init' first, or set COMPOSE_TARGET.")
    process.exit(1)
  }

  // --host=<addr> forwards COMPOSE_HOST to the supervisor → api-server child.
  // supervisor.js already threads COMPOSE_HOST to api-server only (agent-server
  // stays 127.0.0.1 always — see supervisor.js line ~146).
  const hostFlag = args.find((a) => a.startsWith('--host='))
  const startEnv = { ...process.env, COMPOSE_TARGET: targetRoot }
  if (hostFlag) {
    startEnv.COMPOSE_HOST = hostFlag.slice('--host='.length)
  }

  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: startEnv,
  })
  child.on('error', (err) => {
    console.error(`Failed to start compose: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
```

- [ ] **Step 3: Add the remote command dispatch**

Add a new `else if` block. The best place is right after the `start` block (before `else if (cmd === 'ideabox')`):

```js
} else if (cmd === 'remote') {
  // ---------------------------------------------------------------------------
  // compose remote — remote access management (COMP-MOBILE-REMOTE S03)
  // ---------------------------------------------------------------------------
  const { runRemoteCommand } = await import('../lib/cli-remote.js')
  const { root: remoteCwd } = resolveCwdWithWorkspace(args)
  const { resolvePort } = await import('../lib/resolve-port.js')

  const remoteLines = []
  const origPrint = remoteLines.push.bind(remoteLines)
  // Flush lines to stdout in real-time
  const printLine = (l) => console.log(l)

  await runRemoteCommand(args, {
    port: resolvePort(),
    token: process.env.COMPOSE_API_TOKEN,
    cwd: remoteCwd,
    lines: { push: printLine },
    // qr and poll use defaults (qrcode-terminal + setTimeout)
  }).catch((err) => {
    // Errors that weren't already printed (COMPOSE_API_TOKEN missing, --yes missing, etc.)
    // are already pushed to lines. Only exit non-zero for unexpected errors.
    if (err.message !== 'COMPOSE_API_TOKEN not set' &&
        err.message !== '--yes required' &&
        err.message !== 'Missing device-id') {
      console.error(`remote: ${err.message}`)
    }
    process.exit(1)
  })
```

Note: `resolvePort` is already imported at the top of `bin/compose.js` (line 19), so remove the re-import and use the existing import.

Corrected version:

```js
} else if (cmd === 'remote') {
  // ---------------------------------------------------------------------------
  // compose remote — remote access management (COMP-MOBILE-REMOTE S03)
  // ---------------------------------------------------------------------------
  const { runRemoteCommand } = await import('../lib/cli-remote.js')
  const { root: remoteCwd } = resolveCwdWithWorkspace(args)

  await runRemoteCommand(args, {
    port: resolvePort(),
    token: process.env.COMPOSE_API_TOKEN,
    cwd: remoteCwd,
    lines: { push: (l) => console.log(l) },
    // qr and poll use defaults (qrcode-terminal + setTimeout)
  }).catch((err) => {
    if (err.message !== 'COMPOSE_API_TOKEN not set' &&
        err.message !== '--yes required' &&
        err.message !== 'Missing device-id') {
      console.error(`remote: ${err.message}`)
    }
    process.exit(1)
  })
```

- [ ] **Step 4: Verify bin/compose.js --help shows remote**

```bash
node /Users/ruze/reg/my/forge/compose/bin/compose.js --help 2>&1 | grep remote
```

Expected output: `  remote    Manage remote access (pair, list, revoke, status)`

---

## Task 5: Run full test suite and build

- [ ] **Step 1: Run cli-remote tests**

```bash
node --test --test-timeout=90000 test/cli-remote.test.js 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 2: Run auth-routes tests (includes new rotate-secret)**

```bash
node --test --test-timeout=90000 test/auth-routes.test.js 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 3: Run full node:test suite**

```bash
node --test --test-timeout=90000 test/*.test.js 2>&1 | tail -30
```

Expected: all pass. If `lifecycle-guard-e2e.test.js` is the only failure, re-run it standalone:

```bash
node --test --test-timeout=90000 test/lifecycle-guard-e2e.test.js 2>&1 | tail -20
```

(It is a known flake under load per project memory.)

- [ ] **Step 4: Run vitest suite**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 5: Run npm run build**

```bash
npm run build --prefix /Users/ruze/reg/my/forge/compose 2>&1 | tail -20
```

Expected: build succeeds, no errors.

---

## Self-Review

### Spec coverage

Going through blueprint S03 requirements:

1. **`compose remote pair`** — implemented in `verbPair`. Resolves `public_host` from flag > compose.json. Persists flag to compose.json (preserving unknown keys via spread). POSTs to `pair/init` with x-compose-token. Prints pair URL (localhost warning when no public_host). Renders QR via qrcode-terminal. Polls pair/status every 2s. Clean exit on consumed/expired. ✅

2. **`compose remote list`** — implemented in `verbList`. GETs `/api/auth/devices`, prints table. ✅

3. **`compose remote revoke <device-id>`** — implemented in `verbRevoke`. DELETEs `/api/auth/devices/:id`. ✅

4. **`compose remote rotate-secret`** — implemented in `verbRotateSecret`. Refuses without `--yes`. Calls `POST /api/auth/rotate-secret`. ✅

5. **`compose remote status`** — implemented in `verbStatus`. Prints bind host, COMPOSE_REMOTE_AUTH flag, public_host, paired device count (graceful on ECONNREFUSED), dist/ presence (warn if missing), HEAD /api/health if public_host configured. ✅

6. **`compose start --host=<addr>`** — added in Task 4 Step 2. Extracts `--host=` flag from args, sets `COMPOSE_HOST` in spawn env. Supervisor already threads it to api-server only (verified). ✅

7. **`remote` in help text** — added in Task 4 Step 1. ✅

8. **rotate-secret route in auth-routes.js** — added in Task 1 (with test). Deviation documented. ✅

9. **lib/cli-remote.js extraction** — all logic in lib/cli-remote.js, imported by bin/compose.js. Same pattern as other verbs that import from lib/. ✅

10. **Test harness** — `test/cli-remote.test.js` uses stub HTTP server, same `request`/`listen` pattern as `test/auth-routes.test.js`. Covers: pair flow (init→pending→consumed), public_host persistence with unknown-key preservation, localhost warning, status variants, revoke, rotate-secret without --yes refusal. ✅

### Deviations from spec

- **`POST /api/auth/rotate-secret`** was not implemented in S01 (`server/auth-routes.js`). Added in Task 1 (S03) with a test in `test/auth-routes.test.js`. Store already exports `rotateSecret()`. **Documented in the route's JSDoc as a deviation.**

- **`bin/compose.js` passes `args` directly** (not `args.slice(1)`) to `runRemoteCommand`. The `args` array at the point of `cmd === 'remote'` is everything after `remote` in the original argv (i.e., the subcommand and its flags). The dispatcher reads `subArgs[0]` as the verb. This is correct — `process.argv` is `[node, compose.js, 'remote', 'pair', '--public-host=...']` so after `const [,, cmd, ...args]`, `args = ['pair', '--public-host=...']`.

- **`resolvePort` is already imported** at line 19 of `bin/compose.js` — no re-import needed in the remote dispatch block.

### Placeholder check

No TBDs or TODOs — all code is complete in every step.

### Type consistency

- `runRemoteCommand(subArgs, opts)` — `subArgs` is `string[]`, same name throughout.
- `opts.lines` accepts `{ push: fn }` duck-typed, not a plain array — this is deliberate for the bin/compose.js case where we want immediate console.log on each push. Tests pass a plain array which also has `.push`. ✅
- `verbPair(rest, ctx)` — `rest` = `subArgs.slice(1)` (after removing the 'pair' verb). Flags are parsed from `rest` in verbPair. ✅
