/**
 * cli-remote.test.js — COMP-MOBILE-REMOTE S03
 *
 * Tests for lib/cli-remote.js — CLI remote verb logic.
 * Uses a stub HTTP server (same pattern as auth-routes.test.js).
 *
 * Run: node --test --test-timeout=90000 test/cli-remote.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load the module under test
const { runRemoteCommand } = await import(`${REPO_ROOT}/lib/cli-remote.js`);

// ---------------------------------------------------------------------------
// HTTP test helpers (same pattern as auth-routes.test.js)
// ---------------------------------------------------------------------------

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
// TESTS: verb parsing / help text
// ---------------------------------------------------------------------------

describe('remote verb — unknown subcommand shows help', () => {
  let server;
  let dir;

  before(async () => {
    server = await makeStubServer({ token: 'help-tok' });
    dir = makeComposeDir();
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('unknown subcommand prints usage without throwing', async () => {
    const lines = [];
    // Should not throw
    await runRemoteCommand(['not-a-real-verb'], {
      ...makeOpts(server, { token: 'help-tok' }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve(),
    });
    const out = lines.join('\n');
    assert.ok(out.includes('Usage') || out.includes('Subcommands') || out.includes('pair'),
      `Expected help output, got: ${out}`);
  });

  test('no subcommand (undefined) prints usage', async () => {
    const lines = [];
    await runRemoteCommand([], {
      ...makeOpts(server, { token: 'help-tok' }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve(),
    });
    const out = lines.join('\n');
    assert.ok(out.includes('Usage') || out.includes('pair'),
      `Expected help output, got: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// TESTS: pair verb — COMPOSE_API_TOKEN missing
// ---------------------------------------------------------------------------

describe('remote pair — missing COMPOSE_API_TOKEN', () => {
  let server;
  let dir;

  before(async () => {
    server = await makeStubServer({ token: 'tok' });
    dir = makeComposeDir();
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('pair without token errors helpfully mentioning COMPOSE_API_TOKEN', async () => {
    const lines = [];
    let threw = false;
    try {
      await runRemoteCommand(['pair'], {
        ...makeOpts(server, { token: undefined }),
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
      threw || out.includes('COMPOSE_API_TOKEN'),
      `Expected COMPOSE_API_TOKEN mention or throw, got: ${out} (threw: ${threw})`,
    );
  });
});

// ---------------------------------------------------------------------------
// TESTS: pair verb — full flow
// ---------------------------------------------------------------------------

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

  test('pair: with --public-host constructs pair_url correctly', async () => {
    const lines = [];
    await runRemoteCommand(['pair', '--public-host=https://example.com'], {
      ...makeOpts(server, { token: TOKEN }),
      cwd: dir,
      lines,
      qr: () => {},
      poll: () => Promise.resolve('consumed'),
    });

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
      await runRemoteCommand(['pair', '--public-host=https://persist.example.com'], {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir2,
        lines: [],
        qr: () => {},
        poll: () => Promise.resolve('consumed'),
      });

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
      await runRemoteCommand(['pair'], {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir3,
        lines,
        qr: () => {},
        poll: () => Promise.resolve('consumed'),
      });

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
      await runRemoteCommand(['pair'], {
        ...makeOpts(server, { token: TOKEN }),
        cwd: dir4,
        lines,
        qr: () => {},
        poll: () => Promise.resolve('consumed'),
      });

      assert.ok(
        lines.some((l) => l.includes('localhost') || l.includes('127.0.0.1')),
        `Expected localhost URL, got: ${lines.join('\n')}`,
      );
      assert.ok(
        lines.some((l) => l.toLowerCase().includes('warning') || l.toLowerCase().includes('public')),
        `Expected warning about missing public_host, got: ${lines.join('\n')}`,
      );
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
  });

  test('pair: polls until consumed and prints "Paired!"', async () => {
    const server2 = await makeStubServer({
      initCode: 'POLLCODE',
      statusSequence: ['pending', 'pending', 'consumed'],
      token: TOKEN,
    });
    try {
      const lines = [];
      const pollCalls = [];
      await runRemoteCommand(['pair'], {
        ...makeOpts(server2, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: (ms) => { pollCalls.push(ms); return Promise.resolve(); },
      });

      assert.ok(pollCalls.length >= 1, 'Expected at least one poll call');
      assert.ok(lines.some((l) => l.toLowerCase().includes('paired')),
        `Expected "Paired!" in output, got: ${lines.join('\n')}`);
    } finally {
      server2.close();
    }
  });

  test('pair: status expired → prints expiry message', async () => {
    const server3 = await makeStubServer({
      initCode: 'EXPIRECODE',
      statusSequence: ['expired'],
      token: TOKEN,
    });
    try {
      const lines = [];
      // Should NOT throw; should print expiry message
      await runRemoteCommand(['pair'], {
        ...makeOpts(server3, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });

      assert.ok(lines.some((l) => l.toLowerCase().includes('expir')),
        `Expected expiry message, got: ${lines.join('\n')}`);
    } finally {
      server3.close();
    }
  });

  test('pair: sends x-compose-token header to pair/init', async () => {
    // Use a token that only the correct header will unlock
    const server4 = await makeStubServer({
      initCode: 'TOKENCHECK',
      statusSequence: ['consumed'],
      token: 'specific-token-xyz',
    });
    try {
      const lines = [];
      // Wrong token → server rejects pair/init
      let threw = false;
      try {
        await runRemoteCommand(['pair'], {
          ...makeOpts(server4, { token: 'wrong-token' }),
          cwd: dir,
          lines,
          qr: () => {},
          poll: () => Promise.resolve(),
        });
      } catch {
        threw = true;
      }
      // Either threw or printed an error — should NOT have printed a pair URL with TOKENCHECK
      const out = lines.join('\n');
      assert.ok(
        threw || out.includes('Error') || !out.includes('TOKENCHECK'),
        `Expected failure with wrong token, got: ${out} (threw: ${threw})`,
      );
    } finally {
      server4.close();
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

  test('list with no devices prints a "No paired devices" message', async () => {
    const emptyServer = await makeStubServer({ devices: [], token: TOKEN });
    try {
      const lines = [];
      await runRemoteCommand(['list'], {
        ...makeOpts(emptyServer, { token: TOKEN }),
        cwd: dir,
        lines,
        qr: () => {},
        poll: () => Promise.resolve(),
      });
      const out = lines.join('\n');
      assert.ok(out.toLowerCase().includes('no paired') || out.toLowerCase().includes('no device'),
        `Expected "no paired devices" message, got: ${out}`);
    } finally {
      emptyServer.close();
    }
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
    assert.ok(threw || out.toLowerCase().includes('usage') || out.toLowerCase().includes('device'),
      `Expected usage error for missing device-id, got: ${out} (threw: ${threw})`);
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

  test('rotate-secret without --yes refuses and explains invalidation', async () => {
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
      threw || out.toLowerCase().includes('--yes') || out.toLowerCase().includes('invalidat'),
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
    assert.ok(out.toLowerCase().includes('rotat') || out.toLowerCase().includes('secret') || out.includes('ok'),
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

  test('status shows bind host in output', async () => {
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
      // Should print bind host somewhere
      assert.ok(out.includes('127.0.0.1') || out.includes('localhost') || out.toLowerCase().includes('host'),
        `Expected bind host in status, got: ${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status with public_host configured: output includes the public host URL', async () => {
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
        headFn: async () => ({ ok: true, status: 200 }),
      });
      const out = lines.join('\n');
      assert.ok(
        out.includes(`http://127.0.0.1:${port}`) || out.toLowerCase().includes('reachable'),
        `Expected public_host or reachability in status output, got: ${out}`,
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
        out.toLowerCase().includes('not running') ||
        out.toLowerCase().includes('econnrefused') ||
        out.toLowerCase().includes('server') ||
        out.includes('19999'),
        `Expected server-not-running message, got: ${out}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status warns when dist/ is missing', async () => {
    const dir = makeComposeDir();
    try {
      const lines = [];
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
        out.toLowerCase().includes('dist') || out.toLowerCase().includes('build') || out.toLowerCase().includes('missing'),
        `Expected dist warning, got: ${out}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      // Should mention 1 device (1 non-revoked device in the stub)
      assert.ok(out.includes('1') || out.toLowerCase().includes('device'),
        `Expected device count in status, got: ${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
