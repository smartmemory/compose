/**
 * build-all-gsd-routes.test.js — POST /api/build/start modes 'all' and 'gsd'.
 *
 * Run: node --test test/build-all-gsd-routes.test.js
 *
 * Covers the PARITY-8 additions to attachBuildRoutes:
 *   - mode=all calls runBuildAll and needs no featureCode
 *   - mode=gsd calls runGsd with the featureCode
 *   - mode=gsd with no featureCode → 400 featureCode required
 *   - runBuildAll/runGsd errors surface as 500
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { attachBuildRoutes } = await import(`${REPO_ROOT}/server/build-routes.js`);

const TOKEN = 'test-gsd-token';

function makeApp(deps) {
  const app = express();
  app.use(express.json());
  attachBuildRoutes(app, deps);
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
    hostname: '127.0.0.1', port, path: urlPath, method,
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

describe('Build-all / GSD routes (PARITY-8)', () => {
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

  test('mode=all calls runBuildAll and needs no featureCode', async () => {
    let called = false;
    server = await listen(makeApp({
      runBuildAll: async () => { called = true; return { ok: true, started: 3 }; },
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'all' },
    });
    assert.equal(res.status, 200);
    assert.equal(called, true);
    assert.equal(res.body.started, 3);
  });

  test('mode=all returns {ok:true} when runBuildAll resolves undefined', async () => {
    server = await listen(makeApp({
      runBuildAll: async () => undefined,
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'all' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('mode=gsd calls runGsd with the featureCode', async () => {
    let seen = null;
    server = await listen(makeApp({
      runGsd: async (code) => { seen = code; return { ok: true }; },
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'gsd', featureCode: 'COMP-X-1' },
    });
    assert.equal(res.status, 200);
    assert.equal(seen, 'COMP-X-1');
  });

  test('mode=gsd with no featureCode returns 400', async () => {
    server = await listen(makeApp({
      runGsd: async () => ({ ok: true }),
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'gsd' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /featureCode/i);
  });

  test('forwards cwd=getTargetRoot() to the runners (binds dispatch to active project)', async () => {
    let allOpts = null;
    let gsdOpts = null;
    server = await listen(makeApp({
      runBuildAll: async (o) => { allOpts = o; return { ok: true }; },
      runGsd: async (_c, o) => { gsdOpts = o; return { ok: true }; },
      getDataDir: () => '/tmp/x',
      getTargetRoot: () => '/sentinel/project-root',
    }));
    await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'all' },
    });
    await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'gsd', featureCode: 'COMP-X-1' },
    });
    assert.equal(allOpts.cwd, '/sentinel/project-root');
    assert.equal(gsdOpts.cwd, '/sentinel/project-root');
  });

  test('mode=gsd concurrent-run refusal surfaces as 409, not 500', async () => {
    server = await listen(makeApp({
      runGsd: async () => {
        throw new Error('runGsd: another gsd run owns COMP-X-1 (pid 123 alive). Refusing to start a concurrent run.');
      },
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'gsd', featureCode: 'COMP-X-1' },
    });
    assert.equal(res.status, 409);
  });

  test('runBuildAll error surfaces as 500', async () => {
    server = await listen(makeApp({
      runBuildAll: async () => { throw new Error('boom'); },
      getDataDir: () => '/tmp/x',
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'all' },
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /boom/);
  });
});
