/**
 * feature-scaffold-route.test.js — POST /api/features/scaffold (COMP-PARITY-9).
 *
 * Run: node --test test/feature-scaffold-route.test.js
 *
 * Coverage:
 *   - Real-backend golden: a valid POST against a temp project dir scaffolds
 *     docs/features/<CODE>/feature.json + design.md + a new ROADMAP.md row, and
 *     returns the COMPACT body (no roadmap echo).
 *   - Compact return: a writer that ALSO returns a bulky roadmap field must not
 *     have that field passed through to the response.
 *   - 400 on invalid code (writer never called).
 *   - 400 on missing description (writer never called).
 *   - 409 on duplicate code ("already exists").
 *   - 400 on other writer errors.
 *   - 401 without token; 503 with no COMPOSE_API_TOKEN configured.
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { attachFeatureScaffoldRoutes } = await import(`${REPO_ROOT}/server/feature-scaffold-routes.js`);
const { addRoadmapEntry: realAddRoadmapEntry } = await import(`${REPO_ROOT}/lib/feature-writer.js`);

const TOKEN = 'test-scaffold-token';

function makeApp(deps) {
  const app = express();
  app.use(express.json());
  attachFeatureScaffoldRoutes(app, deps);
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
        try { parsed = JSON.parse(buf); } catch { /* leave raw */ }
        res({ status: response.statusCode, body: parsed });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

// Minimal compose project: a local-provider workspace with a ROADMAP.md so
// addRoadmapEntry's renderRoadmap has something to regenerate.
function makeTempProject() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scaffold-route-'));
  fs.mkdirSync(join(dir, '.compose'), { recursive: true });
  fs.writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
    version: 1,
    capabilities: { lifecycle: true },
    paths: { features: 'docs/features', roadmap: 'ROADMAP.md' },
  }));
  fs.mkdirSync(join(dir, 'docs', 'features'), { recursive: true });
  fs.writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Backlog\n\n| Feature | Status | Description |\n|---------|--------|-------------|\n');
  return dir;
}

describe('Feature scaffold route', () => {
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
  const tmpDirs = [];
  afterEach(() => {
    server?.close();
    server = null;
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  test('golden: real backend scaffolds feature.json + design.md + ROADMAP row, compact body', async () => {
    const dir = makeTempProject();
    tmpDirs.push(dir);
    server = await listen(makeApp({
      addRoadmapEntry: realAddRoadmapEntry,
      getProjectRoot: () => dir,
    }));
    const res = await request(server, '/api/features/scaffold', {
      headers: { 'x-compose-token': TOKEN },
      body: { code: 'COMP-PARITY-9-FIX', description: 'Scaffold from UI', phase: 'Backlog' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.code, 'COMP-PARITY-9-FIX');
    assert.equal(res.body.phase, 'Backlog');
    assert.equal(typeof res.body.roadmap_path, 'string');

    // Disk effects: feature.json + seed design.md + a ROADMAP row.
    const featureDir = join(dir, 'docs', 'features', 'COMP-PARITY-9-FIX');
    assert.ok(fs.existsSync(join(featureDir, 'feature.json')), 'feature.json written');
    assert.ok(fs.existsSync(join(featureDir, 'design.md')), 'seed design.md written');
    const feature = JSON.parse(fs.readFileSync(join(featureDir, 'feature.json'), 'utf-8'));
    assert.equal(feature.code, 'COMP-PARITY-9-FIX');
    assert.equal(feature.description, 'Scaffold from UI');
    const roadmap = fs.readFileSync(join(dir, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /COMP-PARITY-9-FIX/);

    // Compact: no field carries the regenerated roadmap markdown.
    for (const [k, v] of Object.entries(res.body)) {
      if (k === 'roadmap_path') continue; // a path string, not the document
      if (typeof v === 'string') {
        assert.ok(!/\n\|/.test(v) && !/^#\s/m.test(v), `field "${k}" looks like roadmap markdown`);
      }
    }
  });

  test('compact return: a bulky writer field is NOT passed through', async () => {
    const dir = makeTempProject();
    tmpDirs.push(dir);
    const bulky = '# Roadmap\n\n| Feature | Status |\n|---|---|\n| A | PLANNED |\n'.repeat(50);
    let called = 0;
    server = await listen(makeApp({
      addRoadmapEntry: async (cwd, args) => {
        called += 1;
        return {
          code: args.code,
          phase: args.phase,
          position: 1,
          roadmap_path: 'ROADMAP.md',
          roundtrip: { ok: true },
          roadmap: bulky,           // a hostile bulky field
          fullRoadmap: bulky,       // another one
        };
      },
      getProjectRoot: () => dir,
    }));
    const res = await request(server, '/api/features/scaffold', {
      headers: { 'x-compose-token': TOKEN },
      body: { code: 'COMP-FOO-1', description: 'x', phase: 'Backlog' },
    });
    assert.equal(res.status, 200);
    assert.equal(called, 1);
    assert.equal(res.body.roadmap, undefined, 'must not echo roadmap field');
    assert.equal(res.body.fullRoadmap, undefined, 'must not echo fullRoadmap field');
    assert.equal(res.body.roundtrip, undefined, 'only whitelisted keys are returned');
    const keys = Object.keys(res.body).sort();
    assert.deepEqual(keys, ['code', 'featurePath', 'ok', 'phase', 'position', 'roadmap_path']);
  });

  test('invalid code returns 400 and never calls the writer', async () => {
    let called = 0;
    server = await listen(makeApp({
      addRoadmapEntry: async () => { called += 1; return {}; },
      getProjectRoot: () => '/tmp/x',
    }));
    const res = await request(server, '/api/features/scaffold', {
      // Trailing hyphen fails FEATURE_CODE_RE_STRICT even after upper-casing
      // (the handler upper-cases first, so a "lower-case" string would be valid).
      headers: { 'x-compose-token': TOKEN },
      body: { code: 'COMP-FOO-', description: 'x' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid feature code/i);
    assert.equal(called, 0);
  });

  test('missing description returns 400 and never calls the writer', async () => {
    let called = 0;
    server = await listen(makeApp({
      addRoadmapEntry: async () => { called += 1; return {}; },
      getProjectRoot: () => '/tmp/x',
    }));
    const res = await request(server, '/api/features/scaffold', {
      headers: { 'x-compose-token': TOKEN },
      body: { code: 'COMP-FOO-1' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /description is required/i);
    assert.equal(called, 0);
  });

  test('duplicate code returns 409', async () => {
    server = await listen(makeApp({
      addRoadmapEntry: async () => { throw new Error('feature-writer: feature "COMP-FOO-1" already exists'); },
      getProjectRoot: () => '/tmp/x',
    }));
    const res = await request(server, '/api/features/scaffold', {
      headers: { 'x-compose-token': TOKEN },
      body: { code: 'COMP-FOO-1', description: 'dup' },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already exists/i);
  });

  test('other writer errors return 400', async () => {
    server = await listen(makeApp({
      addRoadmapEntry: async () => { throw new Error('feature-writer: ROADMAP.md is hand-authored'); },
      getProjectRoot: () => '/tmp/x',
    }));
    const res = await request(server, '/api/features/scaffold', {
      headers: { 'x-compose-token': TOKEN },
      body: { code: 'COMP-FOO-1', description: 'narrative' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /hand-authored/i);
  });

  test('without token returns 401', async () => {
    server = await listen(makeApp({
      addRoadmapEntry: async () => ({ code: 'COMP-FOO-1', phase: 'Backlog', position: 1, roadmap_path: 'ROADMAP.md' }),
      getProjectRoot: () => '/tmp/x',
    }));
    const res = await request(server, '/api/features/scaffold', {
      body: { code: 'COMP-FOO-1', description: 'x' },
    });
    assert.equal(res.status, 401);
  });

  test('without COMPOSE_API_TOKEN configured returns 503', async () => {
    const prev = process.env.COMPOSE_API_TOKEN;
    delete process.env.COMPOSE_API_TOKEN;
    try {
      server = await listen(makeApp({
        addRoadmapEntry: async () => ({ code: 'COMP-FOO-1', phase: 'Backlog', position: 1, roadmap_path: 'ROADMAP.md' }),
        getProjectRoot: () => '/tmp/x',
      }));
      const res = await request(server, '/api/features/scaffold', {
        headers: { 'x-compose-token': 'whatever' },
        body: { code: 'COMP-FOO-1', description: 'x' },
      });
      assert.equal(res.status, 503);
    } finally {
      process.env.COMPOSE_API_TOKEN = prev;
    }
  });
});
