import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bl-route-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'BRANCH test' });
  store.updateLifecycle(item.id, { currentPhase: 'implement', featureCode: 'COMP-OBS-BRANCH' });

  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmpDir,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmpDir, store, item, server, port, broadcasts });
    });
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => buf += chunk);
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

const validLineage = (ext = {}) => ({
  feature_code: 'COMP-OBS-BRANCH',
  branches: [],
  in_progress_siblings: [],
  emitted_event_ids: [],
  last_scan_at: '2026-04-20T00:00:00Z',
  ...ext,
});

describe('POST /api/vision/items/:id/lifecycle/branch-lineage', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('200 on a valid empty lineage; broadcasts branchLineageUpdate', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`,
      validLineage());
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(ctx.broadcasts.some(b => b.type === 'branchLineageUpdate' && b.itemId === ctx.item.id));
  });

  test('stored lineage is accessible via lifecycle_ext', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`,
      validLineage({ in_progress_siblings: ['b1', 'b2'] }));
    const item = ctx.store.items.get(ctx.item.id);
    assert.deepEqual(item.lifecycle.lifecycle_ext.branch_lineage.in_progress_siblings, ['b1', 'b2']);
  });

  test('400 on missing feature_code', async () => {
    const { feature_code, ...rest } = validLineage();
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`, rest);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid/i);
  });

  test('400 on unknown top-level field (additionalProperties:false)', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`,
      validLineage({ unexpected: 'nope' }));
    assert.equal(res.status, 400);
  });

  test('400 on malformed BranchOutcome inside branches[]', async () => {
    const bad = validLineage({
      branches: [{ branch_id: 'x' }], // missing required fields
    });
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`, bad);
    assert.equal(res.status, 400);
  });

  test('404 for nonexistent item', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/bogus/lifecycle/branch-lineage`, validLineage());
    assert.equal(res.status, 404);
  });

  test('400 when item has no lifecycle.featureCode', async () => {
    const bareItem = ctx.store.createItem({ type: 'feature', title: 'no-lifecycle item' });
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${bareItem.id}/lifecycle/branch-lineage`, validLineage());
    assert.equal(res.status, 400);
    assert.match(res.body.error, /lifecycle\.featureCode/i);
  });

  test('400 when lineage.feature_code does not match item.lifecycle.featureCode', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`,
      validLineage({ feature_code: 'SOME-OTHER-FEATURE' }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /feature_code.*does not match/i);
  });

  test('idempotent: re-POSTing identical payload yields the same final state', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`, validLineage());
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/branch-lineage`, validLineage());
    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.lifecycle.lifecycle_ext.branch_lineage.feature_code, 'COMP-OBS-BRANCH');
  });
});
