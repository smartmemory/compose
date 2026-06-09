/**
 * graph-export-routes.test.js — COMP-COCKPIT-10 (S02): graph export routes
 * wired, orphan vision routes removed.
 *
 * Run: node --test test/graph-export-routes.test.js
 *
 * Coverage:
 *   - GET  /api/export/roadmap-graph returns HTML (content-type html, non-empty body)
 *   - POST /api/export/roadmap-graph/save writes docs/roadmap-graph.html under a
 *     tmp target root and returns { ok: true, path }
 *   - Deleted orphan routes 404: GET /api/vision/blocked, POST /api/vision/ui,
 *     POST /api/plan/parse
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { attachGraphExportRoutes } = await import(`${REPO_ROOT}/server/graph-export.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { switchProject, getTargetRoot } = await import(`${REPO_ROOT}/server/project-root.js`);

// ─── Harness ────────────────────────────────────────────────────────────────

function makeStore() {
  const items = new Map();
  const item = {
    id: 'item-1',
    type: 'feature',
    title: 'TEST-1',
    status: 'planned',
    description: 'TEST-1 test feature\nA feature for export tests',
    lifecycle: { featureCode: 'TEST-1' },
  };
  items.set(item.id, item);
  const connections = new Map();
  return {
    items,
    connections,
    getState() {
      return { items: Array.from(items.values()), connections: Array.from(connections.values()) };
    },
    createItem() { throw new Error('not used'); },
    updateItem() {},
  };
}

function listen(app) {
  return new Promise((res) => {
    const server = http.createServer(app);
    server.listen(0, () => res(server));
  });
}

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
      response.on('data', d => buf += d);
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not JSON */ }
        res({ status: response.statusCode, headers: response.headers, text: buf, json });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const TOKEN = 'test-export-token';

describe('graph export routes (COMP-COCKPIT-10)', () => {
  let server;
  let tmpRoot;
  let originalRoot;
  let _origToken;

  before(async () => {
    originalRoot = getTargetRoot();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-export-routes-'));
    switchProject(tmpRoot);
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;

    const app = express();
    app.use(express.json());
    const store = makeStore();
    const { requireSensitiveToken } = await import(`${REPO_ROOT}/server/security.js`);
    attachGraphExportRoutes(app, { store, requireSensitiveToken });
    attachVisionRoutes(app, {
      store,
      scheduleBroadcast: () => {},
      broadcastMessage: () => {},
      projectRoot: tmpRoot,
    });
    server = await listen(app);
  });

  after(() => {
    server?.close();
    switchProject(originalRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  test('GET /api/export/roadmap-graph returns non-empty HTML', async () => {
    const res = await request(server, '/api/export/roadmap-graph');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.text.length > 0, 'body should be non-empty');
    assert.match(res.text, /<html/i);
  });

  test('POST /api/export/roadmap-graph/save without token returns 401', async () => {
    const res = await request(server, '/api/export/roadmap-graph/save', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('POST /api/export/roadmap-graph/save writes docs/roadmap-graph.html and returns {ok, path}', async () => {
    const res = await request(server, '/api/export/roadmap-graph/save', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const expected = path.join(tmpRoot, 'docs', 'roadmap-graph.html');
    assert.equal(res.json.path, expected);
    assert.ok(fs.existsSync(expected), 'roadmap-graph.html should exist on disk');
    const written = fs.readFileSync(expected, 'utf-8');
    assert.match(written, /<html/i);
  });

  test('GET /api/vision/blocked is removed (404)', async () => {
    const res = await request(server, '/api/vision/blocked');
    assert.equal(res.status, 404);
  });

  test('POST /api/vision/ui is removed (404)', async () => {
    const res = await request(server, '/api/vision/ui', { method: 'POST', body: { lens: 'x' } });
    assert.equal(res.status, 404);
  });

  test('POST /api/plan/parse is removed (404)', async () => {
    const res = await request(server, '/api/plan/parse', { method: 'POST', body: { filePath: 'docs/x.md' } });
    assert.equal(res.status, 404);
  });
});
