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
    const server = app.listen(0, '127.0.0.1', () => {
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

  test('without commit_sha (guard off): the gate records a commit-less completion — nothing is skipped', async () => {
    // COMP-COMPLETION-GATE slice 3: a managed build item completes THROUGH the
    // gate. With the guard off, a commit-less completion is the no-repo path
    // (NULL_SHA record), the same thing `compose record-completion` without a
    // SHA does. The old `cockpit_completion_skipped` best-effort branch — item
    // complete, feature.json untouched — was the drift the gate exists to end.
    await advanceToShip(ctx.port, ctx.item.id);

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/complete`, {});

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.partial, false);

    const feature = readFeature(ctx.tmpDir, 'MIG-1');
    assert.equal(feature.completions.length, 1);
    assert.equal(feature.completions[0].commit_sha, '0'.repeat(40));
    assert.equal(feature.status, 'COMPLETE');
    assert.equal(ctx.store.items.get(ctx.item.id).completion_projection.verified_by, 'canonical-status-only');

    const skipEvent = ctx.decisionEvents.find(e =>
      e.event?.type === 'cockpit_completion_skipped' || e.type === 'cockpit_completion_skipped');
    assert.ok(!skipEvent, 'nothing was skipped');
  });

  test('with invalid commit_sha: the gate REFUSES — lifecycle does not transition, nothing written', async () => {
    // Pre-slice-3 this was 200 + partial with the item marked complete and no
    // record: a completion the cockpit showed and canon did not have. A refusal
    // now writes nothing on either side.
    await advanceToShip(ctx.port, ctx.item.id);

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/complete`,
      { commit_sha: 'short' });  // not 40 chars → INVALID_INPUT from writer

    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(res.body.reasons.join(), /INVALID_INPUT|40/);

    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.lifecycle.currentPhase, 'ship', 'lifecycle untouched');
    assert.notEqual(item.status, 'complete');

    const feature = readFeature(ctx.tmpDir, 'MIG-1');
    assert.ok(!feature.completions || feature.completions.length === 0);
    assert.notEqual(feature.status, 'COMPLETE');
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
