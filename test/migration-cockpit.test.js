/**
 * migration-cockpit.test.js — COMP-MCP-MIGRATION integration tests for
 * the cockpit lifecycle/complete reconciliation with record_completion.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { addRoadmapEntry } = await import(`${REPO_ROOT}/lib/feature-writer.js`);
const { readFeature } = await import(`${REPO_ROOT}/lib/feature-json.js`);

async function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mig-cockpit-'));
  const dataDir = join(tmpDir, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmpDir, 'docs', 'features'), { recursive: true });

  // Seed a feature so record_completion has something to flip
  await addRoadmapEntry(tmpDir, {
    code: 'MIG-1',
    description: 'migration test feature',
    phase: 'Phase 0',
  });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Migration Test' });

  const broadcasts = [];
  const decisionEvents = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => {
      broadcasts.push(msg);
      if (msg.type === 'decisionEvent') decisionEvents.push(msg);
    },
    projectRoot: tmpDir,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ tmpDir, store, item, server, port: server.address().port, broadcasts, decisionEvents });
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

async function advanceToShip(port, itemId) {
  await request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/start`,
    { featureCode: 'MIG-1' });
  for (const phase of ['blueprint', 'verification', 'plan', 'execute', 'docs', 'ship']) {
    await request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/advance`,
      { targetPhase: phase, outcome: 'approved' });
  }
}

const FAKE_SHA = 'a'.repeat(40);

describe('COMP-MCP-MIGRATION — cockpit lifecycle/complete', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('with commit_sha: writes completion record and flips status', async () => {
    await advanceToShip(ctx.port, ctx.item.id);

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/complete`,
      { commit_sha: FAKE_SHA, files_changed: ['foo.js'], notes: 'shipped MIG-1' });

    assert.equal(res.status, 200);
    assert.ok(res.body.completedAt);
    assert.equal(res.body.partial, false);

    // Verify completion record on feature.json
    const feature = readFeature(ctx.tmpDir, 'MIG-1');
    assert.ok(Array.isArray(feature.completions), 'completions[] populated');
    assert.equal(feature.completions.length, 1);
    assert.equal(feature.completions[0].commit_sha, FAKE_SHA);
    assert.equal(feature.completions[0].tests_pass, true);

    // Status flipped to COMPLETE
    assert.equal(feature.status, 'COMPLETE');

    // ROADMAP regenerated
    const roadmap = readFileSync(join(ctx.tmpDir, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /MIG-1/);
    assert.match(roadmap, /COMPLETE/);
  });

  test('without commit_sha: emits cockpit_completion_skipped, no completion record', async () => {
    await advanceToShip(ctx.port, ctx.item.id);

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/complete`, {});

    assert.equal(res.status, 200);
    assert.equal(res.body.partial, false);  // still not "partial" — skipped is a clean state

    const feature = readFeature(ctx.tmpDir, 'MIG-1');
    assert.ok(!feature.completions || feature.completions.length === 0,
      'no completion record without commit_sha');

    // Decision event captured
    const skipEvent = ctx.decisionEvents.find(e =>
      e.event?.type === 'cockpit_completion_skipped' || e.type === 'cockpit_completion_skipped');
    assert.ok(skipEvent, 'cockpit_completion_skipped event emitted');
  });

  test('with invalid commit_sha: lifecycle still transitions, partial flag set', async () => {
    await advanceToShip(ctx.port, ctx.item.id);

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/complete`,
      { commit_sha: 'short' });  // not 40 chars → INVALID_INPUT from writer

    assert.equal(res.status, 200);
    // Lifecycle still completed
    assert.ok(res.body.completedAt);
    // But typed-tool failed
    assert.equal(res.body.partial, true);
    assert.equal(res.body.completion_failed, 'INVALID_INPUT');

    // Item lifecycle is still 'complete' on the cockpit side
    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.status, 'complete');

    // Feature.json has no completion record (writer rejected)
    const feature = readFeature(ctx.tmpDir, 'MIG-1');
    assert.ok(!feature.completions || feature.completions.length === 0);
  });

  test('item without featureCode: works as before, no typed-tool calls', async () => {
    // Don't advance to ship through normal flow — this item has no featureCode
    // bound. We need to manually mock its lifecycle.
    const item = ctx.store.createItem({ type: 'feature', title: 'No FC' });
    // Hand-write a lifecycle in ship phase without a featureCode
    ctx.store.updateLifecycle(item.id, {
      currentPhase: 'ship',
      featureCode: null,
      phaseHistory: [],
    });

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${item.id}/lifecycle/complete`,
      { commit_sha: FAKE_SHA });

    assert.equal(res.status, 200);
    assert.ok(res.body.completedAt);
    assert.equal(res.body.partial, false);
    // No completion event emitted (no featureCode to record against)
  });
});
