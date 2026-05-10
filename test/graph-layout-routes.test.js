/**
 * graph-layout-routes.test.js — GET/POST /api/graph/layout
 *
 * Acceptance:
 *   - GET on empty store returns { positions: {} }
 *   - POST stores; subsequent GET returns the stored positions
 *   - POST merges with existing (partial update preserves untouched entries)
 *   - Invalid body returns 400
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { attachGraphLayoutRoutes } = await import(`${ROOT}/server/graph-layout-routes.js`);
const { switchProject } = await import(`${ROOT}/server/project-root.js`);

let baseUrl;
let httpServer;
const tmpdirsToCleanup = [];

function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'graph-layout-'));
  mkdirSync(join(d, '.compose', 'data'), { recursive: true });
  tmpdirsToCleanup.push(d);
  return d;
}

before(() => new Promise(res => {
  const app = express();
  app.use(express.json());
  attachGraphLayoutRoutes(app);
  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => {
  httpServer.close(() => res());
  for (const d of tmpdirsToCleanup) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
}));

beforeEach(() => {
  // Each test gets a fresh project root so layout file starts empty.
  switchProject(freshDir());
});

describe('GET /api/graph/layout', () => {
  test('returns empty positions when no file exists', async () => {
    const r = await fetch(`${baseUrl}/api/graph/layout`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { positions: {} });
  });
});

describe('POST /api/graph/layout', () => {
  test('persists and round-trips positions', async () => {
    const post = await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { a: { x: 10, y: 20 }, b: { x: -5, y: 7.5 } } }),
    });
    assert.equal(post.status, 200);
    const postBody = await post.json();
    assert.equal(postBody.ok, true);

    const get = await fetch(`${baseUrl}/api/graph/layout`);
    const body = await get.json();
    assert.deepEqual(body.positions, { a: { x: 10, y: 20 }, b: { x: -5, y: 7.5 } });
  });

  test('merges partial updates with existing entries', async () => {
    await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } }),
    });
    // Update only `a`, add new `c`. `b` should remain.
    await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { a: { x: 100, y: 100 }, c: { x: 3, y: 3 } } }),
    });
    const get = await fetch(`${baseUrl}/api/graph/layout`);
    const body = await get.json();
    assert.deepEqual(body.positions, {
      a: { x: 100, y: 100 },
      b: { x: 2, y: 2 },
      c: { x: 3, y: 3 },
    });
  });

  test('null entry deletes a position', async () => {
    await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } }),
    });
    await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { a: null } }),
    });
    const get = await fetch(`${baseUrl}/api/graph/layout`);
    const body = await get.json();
    assert.deepEqual(body.positions, { b: { x: 2, y: 2 } });
  });

  test('rejects missing positions object', async () => {
    const r = await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  test('skips invalid coordinates silently', async () => {
    await fetch(`${baseUrl}/api/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: {
        ok: { x: 1, y: 2 },
        bad1: { x: 'no', y: 0 },
        bad2: { x: 1 },
        bad3: 'string',
      }}),
    });
    const get = await fetch(`${baseUrl}/api/graph/layout`);
    const body = await get.json();
    assert.deepEqual(body.positions, { ok: { x: 1, y: 2 } });
  });
});
