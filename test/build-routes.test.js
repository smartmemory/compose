/**
 * build-routes.test.js — POST /api/build/start, POST /api/build/abort.
 *
 * Run: node --test test/build-routes.test.js
 *
 * Coverage:
 *   - 401 without sensitive token
 *   - 400 when featureCode missing
 *   - 400 when mode is invalid
 *   - 200 on valid start (forwards mode/template/description correctly)
 *   - 409 when runBuild rejects with "already active"
 *   - 200 on abort with (dataDir, featureCode)
 *   - 400 on abort without featureCode
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { attachBuildRoutes } = await import(`${REPO_ROOT}/server/build-routes.js`);

const TOKEN = 'test-build-token';

function makeApp({ runBuild, abortBuild, getDataDir }) {
  const app = express();
  app.use(express.json());
  attachBuildRoutes(app, { runBuild, abortBuild, getDataDir });
  return app;
}

function listen(app) {
  return new Promise((res) => {
    const server = http.createServer(app);
    server.listen(0, () => res(server));
  });
}

function request(server, urlPath, { method = 'POST', body, headers = {} } = {}) {
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
      response.on('data', d => buf += d);
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

describe('Build routes', () => {
  let _origToken;

  before(() => {
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
  });

  after(() => {
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  let server;
  afterEach(() => { server?.close(); server = null; });

  test('POST /api/build/start without token returns 401', async () => {
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      body: { featureCode: 'F-1' },
    });
    assert.equal(res.status, 401);
  });

  test('POST /api/build/start without featureCode returns 400', async () => {
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /featureCode/);
  });

  test('POST /api/build/start with invalid mode returns 400', async () => {
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'F-1', mode: 'fix' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /feature.*bug/i);
  });

  test('POST /api/build/start with mode=feature calls runBuild and returns result', async () => {
    let captured = null;
    server = await listen(makeApp({
      runBuild: async (featureCode, opts) => {
        captured = { featureCode, opts };
        return { started: true, featureCode };
      },
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'F-1', mode: 'feature', description: 'do the thing' },
    });
    assert.equal(res.status, 200);
    assert.equal(captured.featureCode, 'F-1');
    assert.equal(captured.opts.mode, 'feature');
    assert.equal(captured.opts.description, 'do the thing');
    assert.equal(captured.opts.template, undefined, 'feature mode should not pass template');
    assert.equal(res.body.started, true);
  });

  test('POST /api/build/start with mode=bug forwards template=bug-fix', async () => {
    let captured = null;
    server = await listen(makeApp({
      runBuild: async (featureCode, opts) => { captured = { featureCode, opts }; return { ok: true }; },
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'BUG-7', mode: 'bug', description: 'reproduce X' },
    });
    assert.equal(res.status, 200);
    assert.equal(captured.opts.mode, 'bug');
    assert.equal(captured.opts.template, 'bug-fix');
    assert.equal(captured.opts.description, 'reproduce X');
  });

  test('POST /api/build/start when build is already active returns 409', async () => {
    server = await listen(makeApp({
      runBuild: async () => { throw new Error('Build is already active for F-1'); },
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'F-1' },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already active/i);
  });

  test('POST /api/build/start surfaces other runBuild errors as 500', async () => {
    server = await listen(makeApp({
      runBuild: async () => { throw new Error('disk full'); },
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'F-1' },
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'disk full');
  });

  test('POST /api/build/abort without featureCode returns 400', async () => {
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/abort', {
      headers: { 'x-compose-token': TOKEN },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /featureCode/);
  });

  test('POST /api/build/abort without token returns 401', async () => {
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      abortBuild: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/abort', {
      body: { featureCode: 'F-1' },
    });
    assert.equal(res.status, 401);
  });

  test('POST /api/build/abort calls abortBuild(dataDir, featureCode)', async () => {
    let captured = null;
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      abortBuild: async (dataDir, featureCode) => {
        captured = { dataDir, featureCode };
        return { aborted: true, featureCode };
      },
      getDataDir: () => '/tmp/test-data-dir',
    }));
    const res = await request(server, '/api/build/abort', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'F-2' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(captured, { dataDir: '/tmp/test-data-dir', featureCode: 'F-2' });
    assert.equal(res.body.aborted, true);
  });
});
