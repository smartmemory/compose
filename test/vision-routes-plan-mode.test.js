/**
 * vision-routes-plan-mode.test.js — COMP-ROADMAP-PLAN T5 (S2).
 *
 * A plan session must carry mode='plan' through the REST path. The
 * `/lifecycle/start` handler must prefer an explicit req.body.mode over
 * typeToMode(item.type), and VisionWriter._restEnsureFeatureItem must forward
 * `mode` on the start POST at BOTH call sites (post-create AND existing-item
 * repair). Real Express server on an ephemeral port; no guard (the mode-stamp
 * is independent of the guard).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { VisionStore } = await import(`${ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${ROOT}/server/vision-routes.js`);
const { VisionWriter } = await import(`${ROOT}/lib/vision-writer.js`);

let baseUrl;
let httpServer;
let store;
let dataDir;
let port;

function freshProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'vision-plan-mode-proj-'));
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  return root;
}

before(() => new Promise(res => {
  dataDir = mkdtempSync(join(tmpdir(), 'vision-plan-mode-data-'));
  store = new VisionStore(dataDir);

  const app = express();
  app.use(express.json());
  // VisionWriter probes /api/health to decide REST vs direct mode — mount it so
  // the client-side ensureFeatureItem tests exercise the REST path.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: () => {},
    projectRoot: freshProjectRoot(),
    capabilities: { guard: false }, // mode-stamp is guard-independent
  });

  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    port = httpServer.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => {
  httpServer.closeAllConnections?.();
  httpServer.close(res);
}));

async function post(path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

async function getLifecycle(itemId) {
  const r = await fetch(`${baseUrl}/api/vision/items/${itemId}/lifecycle`, {
    headers: { Connection: 'close' },
  });
  return { status: r.status, body: await r.json() };
}

describe('lifecycle/start — explicit mode (T5 server side)', () => {
  test('prefers req.body.mode over typeToMode', async () => {
    const created = await post('/api/vision/items', { title: 'A plan', type: 'feature' });
    assert.equal(created.status, 201);
    const start = await post(`/api/vision/items/${created.body.id}/lifecycle/start`, {
      featureCode: 'PLAN-EXPLICIT-1', mode: 'plan',
    });
    assert.equal(start.status, 200);
    assert.equal(start.body.mode, 'plan', 'start response stamps mode=plan');

    const lc = await getLifecycle(created.body.id);
    assert.equal(lc.body.mode, 'plan', 'lifecycle.mode persisted as plan');
  });

  test('falls back to typeToMode when no body.mode (build)', async () => {
    const created = await post('/api/vision/items', { title: 'A build', type: 'feature' });
    const start = await post(`/api/vision/items/${created.body.id}/lifecycle/start`, {
      featureCode: 'BUILD-FALLBACK-1',
    });
    assert.equal(start.body.mode, 'build', 'no body.mode → typeToMode → build');
  });

  test('typeToMode fallback still maps bug → fix', async () => {
    const created = await post('/api/vision/items', { title: 'A bug', type: 'bug' });
    const start = await post(`/api/vision/items/${created.body.id}/lifecycle/start`, {
      featureCode: 'BUG-FALLBACK-1',
    });
    assert.equal(start.body.mode, 'fix', 'bug item → fix mode via typeToMode');
  });
});

describe('VisionWriter._restEnsureFeatureItem forwards mode (T5 client side)', () => {
  test('post-create path: a REST-created plan item ends up lifecycle.mode=plan', async () => {
    const wdir = mkdtempSync(join(tmpdir(), 'vision-plan-writer-'));
    const writer = new VisionWriter(wdir, { port });
    // ensureFeatureItem(featureCode, title, mode) — REST path (server is up).
    const id = await writer.ensureFeatureItem('PLAN-VIA-WRITER-1', 'Widget plan', 'plan');
    assert.ok(id);
    const lc = await getLifecycle(id);
    assert.equal(lc.status, 200);
    assert.equal(lc.body.mode, 'plan', 'writer forwarded mode on the post-create start');
    assert.equal(lc.body.featureCode, 'PLAN-VIA-WRITER-1');
  });

  test('existing-item repair path: a UI-created plan item (no lifecycle) starts as plan', async () => {
    // Simulate a UI-created item with NO lifecycle, then ensureFeatureItem must
    // repair it by starting lifecycle with the forwarded mode.
    const created = await post('/api/vision/items', { title: 'UI plan', type: 'feature' });
    const itemId = created.body.id;
    // Bind the item's id as the featureCode-less match target: the writer matches
    // by item.id when there is no lifecycle.featureCode.
    const wdir = mkdtempSync(join(tmpdir(), 'vision-plan-writer-repair-'));
    const writer = new VisionWriter(wdir, { port });
    const returnedId = await writer.ensureFeatureItem(itemId, 'UI plan', 'plan');
    assert.equal(returnedId, itemId, 'repaired the existing item, not a new one');
    const lc = await getLifecycle(itemId);
    assert.equal(lc.status, 200);
    assert.equal(lc.body.mode, 'plan', 'repair path forwarded mode=plan');
  });
});
