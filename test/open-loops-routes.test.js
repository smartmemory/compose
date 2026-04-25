/**
 * open-loops-routes.test.js — Integration: 3 REST endpoints for COMP-OBS-LOOPS.
 *
 * Covers:
 *   - GET /api/vision/items/:id/loops — list open loops
 *   - POST /api/vision/items/:id/loops — add loop; broadcast + statusSnapshot
 *   - POST /api/vision/items/:id/loops/:loopId/resolve — resolve; broadcast + statusSnapshot
 *   - 400 when featureless item (no featureCode)
 *   - 404 on unknown item
 *   - Schema validation via SchemaValidator
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const sv = new SchemaValidator();

// ── Helpers ───────────────────────────────────────────────────────────────

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'loops-routes-test-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });

  const store = new VisionStore(dataDir);
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmp,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmp, dataDir, store, broadcasts, server, port });
    });
  });
}

function teardown(ctx) {
  ctx.server.close();
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function post(port, pathUrl, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathUrl, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(port, pathUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathUrl, method: 'GET' },
      (res) => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/vision/items/:id/loops', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('returns empty loops array for new item', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Loops test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-TEST' });

    const r = await get(ctx.port, `/api/vision/items/${item.id}/loops`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.loops, []);
  });

  test('returns open loops after add', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Loops test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-TEST' });
    await post(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'verify X' });

    const r = await get(ctx.port, `/api/vision/items/${item.id}/loops`);
    assert.equal(r.status, 200);
    assert.equal(r.body.loops.length, 1);
    assert.equal(r.body.loops[0].kind, 'deferred');
  });

  test('includeResolved=true returns resolved loops too', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Loops test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-TEST' });
    const addR = await post(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'x' });
    const loopId = addR.body.loop.id;
    await post(ctx.port, `/api/vision/items/${item.id}/loops/${loopId}/resolve`, { note: 'done' });

    // Without includeResolved: empty
    const r1 = await get(ctx.port, `/api/vision/items/${item.id}/loops`);
    assert.equal(r1.body.loops.length, 0);

    // With includeResolved: 1
    const r2 = await get(ctx.port, `/api/vision/items/${item.id}/loops?includeResolved=true`);
    assert.equal(r2.body.loops.length, 1);
  });

  test('404 on unknown item', async () => {
    const r = await get(ctx.port, '/api/vision/items/nonexistent/loops');
    assert.equal(r.status, 404);
  });
});

describe('POST /api/vision/items/:id/loops', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('golden path: add loop → 201 + schema valid + broadcast + statusSnapshot', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Loop add test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-ADD' });
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${item.id}/loops`, {
      kind: 'deferred', summary: 'verify X before merge', ttl_days: 30,
    });
    assert.equal(r.status, 201, `add failed: ${JSON.stringify(r.body)}`);

    const loop = r.body.loop;
    assert.ok(loop.id, 'loop must have id');
    assert.equal(loop.kind, 'deferred');
    assert.equal(loop.summary, 'verify X before merge');
    assert.equal(loop.parent_feature, 'COMP-LOOPS-ADD');
    assert.equal(loop.ttl_days, 30);
    assert.equal(loop.resolution, null);

    // Schema validate OpenLoop
    const { valid, errors } = sv.validate('OpenLoop', loop);
    assert.equal(valid, true, `OpenLoop schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);

    // Broadcast: openLoopsUpdate
    const loopBroadcasts = ctx.broadcasts.filter(b => b.type === 'openLoopsUpdate');
    assert.ok(loopBroadcasts.length >= 1, 'openLoopsUpdate must be broadcast');
    const loopMsg = loopBroadcasts[loopBroadcasts.length - 1];
    assert.equal(loopMsg.itemId, item.id);
    assert.ok(Array.isArray(loopMsg.loops), 'loops must be array');

    // Broadcast: statusSnapshot
    const statusBroadcasts = ctx.broadcasts.filter(b => b.type === 'statusSnapshot');
    assert.ok(statusBroadcasts.length >= 1, 'statusSnapshot must be broadcast after add');
  });

  test('400 when featureless item', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'No FC' });
    // No lifecycle start → no featureCode
    const r = await post(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'x' });
    assert.equal(r.status, 400);
  });

  test('400 when kind missing', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Loop no-kind' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-NK' });
    const r = await post(ctx.port, `/api/vision/items/${item.id}/loops`, { summary: 'test' });
    assert.equal(r.status, 400);
  });

  test('404 on unknown item', async () => {
    const r = await post(ctx.port, '/api/vision/items/unknown/loops', { kind: 'deferred', summary: 'x' });
    assert.equal(r.status, 404);
  });
});

describe('POST /api/vision/items/:id/loops/:loopId/resolve', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('golden path: resolve loop → 200 + resolution set + broadcast + statusSnapshot', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Loop resolve test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-RES' });
    const addR = await post(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'blocked', summary: 'dep waiting' });
    const loopId = addR.body.loop.id;

    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${item.id}/loops/${loopId}/resolve`, { note: 'dep shipped' });
    assert.equal(r.status, 200, `resolve failed: ${JSON.stringify(r.body)}`);

    const loop = r.body.loop;
    assert.ok(loop.resolution, 'resolution must be set');
    assert.equal(loop.resolution.note, 'dep shipped');
    assert.ok(!isNaN(Date.parse(loop.resolution.resolved_at)));

    // Schema validate
    const { valid, errors } = sv.validate('OpenLoop', loop);
    assert.equal(valid, true, `OpenLoop schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);

    // Broadcasts
    const loopBroadcasts = ctx.broadcasts.filter(b => b.type === 'openLoopsUpdate');
    assert.ok(loopBroadcasts.length >= 1, 'openLoopsUpdate must broadcast after resolve');
    const statusBroadcasts = ctx.broadcasts.filter(b => b.type === 'statusSnapshot');
    assert.ok(statusBroadcasts.length >= 1, 'statusSnapshot must broadcast after resolve');
  });

  test('404 when loop not found', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'No loop' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-NF' });
    const r = await post(ctx.port, `/api/vision/items/${item.id}/loops/nonexistent/resolve`, { note: '' });
    assert.equal(r.status, 404);
  });

  test('400 when loop already resolved', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Already resolved' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-LOOPS-AR' });
    const addR = await post(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'x' });
    const loopId = addR.body.loop.id;
    await post(ctx.port, `/api/vision/items/${item.id}/loops/${loopId}/resolve`, { note: 'done' });
    const r2 = await post(ctx.port, `/api/vision/items/${item.id}/loops/${loopId}/resolve`, { note: 'again' });
    assert.equal(r2.status, 400);
  });
});
