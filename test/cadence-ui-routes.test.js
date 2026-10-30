/**
 * COMPOSE-CADENCE-TAB-1: /api/cadence-ui mount. Real sibling handler on the package's own fixture roots
 * (`cadence/ui/tests/fixtures`, read-only), a fake command runner, loopback ephemeral port. One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { attachCadenceUiRoutes } from '../server/cadence-ui-routes.js';
import { resolveCadenceUiDir } from '../lib/cadence-ui-link.js';

const uiDir = resolveCadenceUiDir();
const FIX = uiDir ? join(uiDir, 'tests', 'fixtures') : null;
const BY_SCRIPT = { 'usage_watch.py': 'usage', 'jobs.py': 'jobs', 'owner_queue.py': 'owner' };

async function withApp(opts, fn) {
  const app = express();
  const mounted = await attachCadenceUiRoutes(app, opts);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`, mounted, server.address().port); } finally { server.close(); }
}

// Raw path: fetch() would normalise `..` away before it reaches the server.
function rawGet(port, path) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', fail);
    req.end();
  });
}

// [method, path, status, key the JSON body must carry (or null)]
const ROWS = [
  ['GET', '/api/cadence-ui/available', 200, 'available'],
  ['GET', '/api/cadence-ui/belt', 200, 'units'],
  ['GET', '/api/cadence-ui/seats', 200, 'seats'],
  ['GET', '/api/cadence-ui/chains', 200, 'chains'],
  ['GET', '/api/cadence-ui/attention', 200, 'asks'],
  ['GET', '/api/cadence-ui/review', 200, 'inReview'],
  ['GET', '/api/cadence-ui/diary', 200, 'events'],
  ['GET', '/api/cadence-ui/diary?family=job&limit=5', 200, 'events'],
  ['GET', '/api/cadence-ui/diary?family=nope', 400, 'error'],
  ['GET', '/api/cadence-ui/health', 200, 'ok'],
  ['GET', '/api/cadence-ui/nope', 404, 'error'],
  ['GET', '/api/cadence-ui', 404, 'error'],
  ['GET', '/api/cadence-ui/belt/extra', 404, 'error'],
  ['GET', '/api/cadence-ui/index.html', 404, 'error'],
  ['RAW', '/api/cadence-ui/../../etc/passwd', 404, null],
  ['RAW', '/api/cadence-ui/%2e%2e/%2e%2e/etc/passwd', 404, null],
  ['RAW', '/api/cadence-ui/..%2fbelt', 404, null],
  ['POST', '/api/cadence-ui/belt', 405, 'error'],
  ['PUT', '/api/cadence-ui/seats', 405, 'error'],
  ['DELETE', '/api/cadence-ui/diary', 405, 'error'],
];

describe('attachCadenceUiRoutes', () => {
  it('mounts nothing when the sibling is absent or in remote mode', async () => {
    await withApp({ uiDir: null }, async (base, mounted) => {
      assert.equal(mounted, false);
      assert.equal((await fetch(`${base}/api/cadence-ui/available`)).status, 404);
      assert.equal((await fetch(`${base}/api/cadence-ui/belt`)).status, 404);
    });
    if (uiDir) await withApp({ uiDir, remote: true }, async (base, mounted) => {
      assert.equal(mounted, false);
      assert.equal((await fetch(`${base}/api/cadence-ui/belt`)).status, 404);
    });
  });

  it('serves every route read-only and runs only the four fixed commands', { skip: !uiDir }, async () => {
    const ran = [];
    const run = async ({ argv }) => {
      ran.push(argv);
      const key = argv[2] === 'cadence' ? 'page' : BY_SCRIPT[argv[1].split('/').pop()];
      return readFileSync(join(FIX, 'cmd', `${key}.json`), 'utf8');
    };
    await withApp({ uiDir, opsRoot: join(FIX, 'ops'), stateDir: join(FIX, 'state'), scriptsDir: '/scripts', run }, async (base, mounted, port) => {
      assert.equal(mounted, true);
      for (const [method, path, status, key] of ROWS) {
        if (method === 'RAW') {
          assert.equal(await rawGet(port, path), status, path);
          continue;
        }
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, status, `${method} ${path}`);
        if (key) assert.ok(key in (await res.json()), `${method} ${path} carries ${key}`);
      }
    });
    const shapes = new Set(ran.map((a) => (a[2] === 'cadence' ? a.slice(1).join(' ') : `${a[1].split('/').pop()} ${a.slice(2).join(' ')}`)));
    assert.deepEqual([...shapes].sort(), ['-m cadence page --json', 'jobs.py list --json', 'owner_queue.py list --json', 'usage_watch.py status --json']);
  });
});
