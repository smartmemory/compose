/**
 * launch-routes.test.js — POST /api/build/start modes 'new' and 'bug' resume.
 *
 * Run: node --test test/launch-routes.test.js
 *
 * Covers the PARITY-2 additions to attachBuildRoutes:
 *   - mode=new forwards the trimmed description as the intent to runNew
 *   - mode=new with blank description → 400 /intent/
 *   - mode=bug resume=true reads active-build.json and forwards resumeFlowId
 *   - resume=true on a non-bug mode → 400
 *   - resume=true with no/mismatched active build → 409
 *   - resume=true when the active build is a different mode → 409
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { attachBuildRoutes } = await import(`${REPO_ROOT}/server/build-routes.js`);

const TOKEN = 'test-launch-token';

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

describe('Launch routes (PARITY-2: new + resume)', () => {
  let _origToken;
  let dataDir;

  before(() => {
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
    dataDir = mkdtempSync(join(tmpdir(), 'launch-routes-'));
  });

  after(() => {
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
    rmSync(dataDir, { recursive: true, force: true });
  });

  let server;
  afterEach(() => { server?.close(); server = null; });

  function writeActiveBuild(obj) {
    writeFileSync(join(dataDir, 'active-build.json'), JSON.stringify(obj));
  }

  test('mode=new forwards trimmed intent to runNew', async () => {
    let seen = null;
    server = await listen(makeApp({
      runNew: async (intent) => { seen = intent; return { ok: true, flowId: 'n-1' }; },
      getDataDir: () => dataDir,
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'new', description: '  add a widget  ' },
    });
    assert.equal(res.status, 200);
    assert.equal(seen, 'add a widget');
    assert.equal(res.body.flowId, 'n-1');
  });

  test('mode=new with blank description returns 400 /intent/', async () => {
    server = await listen(makeApp({
      runNew: async () => ({ ok: true }),
      getDataDir: () => dataDir,
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { mode: 'new', description: '   ' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /intent/i);
  });

  test('mode=bug resume=true forwards resumeFlowId from active-build.json', async () => {
    writeActiveBuild({ featureCode: 'BUG-9', flowId: 'flow-42', mode: 'bug' });
    let opts = null;
    server = await listen(makeApp({
      runBuild: async (_code, o) => { opts = o; return { ok: true }; },
      getDataDir: () => dataDir,
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'BUG-9', mode: 'bug', resume: true },
    });
    assert.equal(res.status, 200);
    assert.equal(opts.resumeFlowId, 'flow-42');
    assert.equal(opts.template, 'bug-fix');
  });

  test('resume=true on a non-bug mode returns 400', async () => {
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      getDataDir: () => dataDir,
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'F-1', mode: 'feature', resume: true },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /resume/i);
  });

  test('resume=true with mismatched active build returns 409', async () => {
    writeActiveBuild({ featureCode: 'OTHER-1', flowId: 'flow-1', mode: 'bug' });
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      getDataDir: () => dataDir,
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'BUG-9', mode: 'bug', resume: true },
    });
    assert.equal(res.status, 409);
  });

  test('resume=true when active build is a different mode returns 409', async () => {
    writeActiveBuild({ featureCode: 'BUG-9', flowId: 'flow-7', mode: 'feature' });
    server = await listen(makeApp({
      runBuild: async () => ({ ok: true }),
      getDataDir: () => dataDir,
    }));
    const res = await request(server, '/api/build/start', {
      headers: { 'x-compose-token': TOKEN },
      body: { featureCode: 'BUG-9', mode: 'bug', resume: true },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /not resumable|mode=/i);
  });
});
