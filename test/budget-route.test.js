/**
 * budget-route.test.js — GET /api/lifecycle/budget integration tests.
 *
 * Run: node --test test/budget-route.test.js
 *
 * Coverage:
 *   - 400 on missing featureCode
 *   - returns zeroed feature_total for unknown featureCode
 *   - returns feature_total from ledger data
 *   - per_loop_type uses settings maxTotal and ledger usedIterations
 *   - per_loop_type maxTotal is null when no settings configured
 *   - computed_at is a valid ISO timestamp
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { recordIteration } = await import(`${REPO_ROOT}/lib/budget-ledger.js`);
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { SettingsStore } = await import(`${REPO_ROOT}/server/settings-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProjectRoot(settingsContract) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'budget-route-test-'));
  const composeDir = join(projectRoot, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });

  const dataDir = join(composeDir, 'data');
  const store = new VisionStore(dataDir);

  const contract = settingsContract ?? {
    phases: [{ id: 'execute', defaultPolicy: null }],
    iterationDefaults: {
      review:   { maxIterations: 4, timeout: 15, maxTotal: 20 },
      coverage: { maxIterations: 15, timeout: 30, maxTotal: 50 },
    },
    policyModes: ['gate', 'flag', 'skip'],
  };
  const settingsStore = new SettingsStore(dataDir, contract);

  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store, scheduleBroadcast: () => {}, broadcastMessage: () => {},
    projectRoot, settingsStore,
  });

  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, () => resolve({ server, composeDir, projectRoot }));
  });
}

function get(server, urlPath) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/lifecycle/budget', () => {
  let ctx;
  afterEach(() => {
    ctx?.server?.close();
    if (ctx?.projectRoot) rmSync(ctx.projectRoot, { recursive: true, force: true });
  });

  test('returns 400 when featureCode query param is missing', async () => {
    ctx = await makeProjectRoot();
    const res = await get(ctx.server, '/api/lifecycle/budget');
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'should have error field');
    assert.ok(res.body.error.toLowerCase().includes('featurecode'), `error should mention featureCode, got: ${res.body.error}`);
  });

  test('returns zeroed feature_total for unknown featureCode (no ledger entry)', async () => {
    ctx = await makeProjectRoot();
    const res = await get(ctx.server, '/api/lifecycle/budget?featureCode=FEAT-UNKNOWN');
    assert.equal(res.status, 200);
    const { feature_total } = res.body;
    assert.equal(feature_total.usedIterations, 0);
    assert.equal(feature_total.usedActions, 0);
    assert.equal(feature_total.totalTimeMs, 0);
  });

  test('returns feature_total from ledger data', async () => {
    ctx = await makeProjectRoot();
    recordIteration(ctx.composeDir, 'FEAT-A', { iterations: 7, actions: 42, timeMs: 3000 });

    const res = await get(ctx.server, '/api/lifecycle/budget?featureCode=FEAT-A');
    assert.equal(res.status, 200);
    const { featureCode, feature_total } = res.body;
    assert.equal(featureCode, 'FEAT-A');
    assert.equal(feature_total.usedIterations, 7);
    assert.equal(feature_total.usedActions, 42);
    assert.equal(feature_total.totalTimeMs, 3000);
  });

  test('per_loop_type uses settings maxTotal for review and coverage', async () => {
    ctx = await makeProjectRoot();
    recordIteration(ctx.composeDir, 'FEAT-B', { iterations: 5, actions: 10, timeMs: 1000 });

    const res = await get(ctx.server, '/api/lifecycle/budget?featureCode=FEAT-B');
    assert.equal(res.status, 200);
    const { per_loop_type } = res.body;

    // review: maxTotal=20 from settings; usedIterations = feature-level total (5)
    assert.equal(per_loop_type.review.maxTotal, 20, 'review maxTotal should be 20 from settings');
    assert.equal(per_loop_type.review.usedIterations, 5);
    assert.equal(per_loop_type.review.remaining, 15);

    // coverage: maxTotal=50 from settings
    assert.equal(per_loop_type.coverage.maxTotal, 50, 'coverage maxTotal should be 50 from settings');
    assert.equal(per_loop_type.coverage.usedIterations, 5);
    assert.equal(per_loop_type.coverage.remaining, 45);
  });

  test('per_loop_type maxTotal is null when settings has no maxTotal for that loopType', async () => {
    // settings with no maxTotal configured
    ctx = await makeProjectRoot({
      phases: [{ id: 'execute', defaultPolicy: null }],
      iterationDefaults: {
        review: { maxIterations: 4, timeout: 15 },
        // no maxTotal
      },
      policyModes: ['gate', 'flag', 'skip'],
    });
    recordIteration(ctx.composeDir, 'FEAT-C', { iterations: 3, actions: 0, timeMs: 0 });

    const res = await get(ctx.server, '/api/lifecycle/budget?featureCode=FEAT-C');
    assert.equal(res.status, 200);
    const { per_loop_type } = res.body;
    assert.equal(per_loop_type.review.maxTotal, null);
    assert.equal(per_loop_type.review.remaining, null);
    assert.equal(per_loop_type.review.usedIterations, 3);
  });

  test('computed_at is a valid ISO timestamp', async () => {
    ctx = await makeProjectRoot();
    const res = await get(ctx.server, '/api/lifecycle/budget?featureCode=ANY');
    assert.equal(res.status, 200);
    const ts = Date.parse(res.body.computed_at);
    assert.ok(!isNaN(ts), `computed_at should be a valid ISO timestamp, got: ${res.body.computed_at}`);
  });

  test('accumulates usage across multiple recorded iterations', async () => {
    ctx = await makeProjectRoot();
    recordIteration(ctx.composeDir, 'FEAT-D', { iterations: 3, actions: 10, timeMs: 1000 });
    recordIteration(ctx.composeDir, 'FEAT-D', { iterations: 4, actions: 20, timeMs: 2000 });

    const res = await get(ctx.server, '/api/lifecycle/budget?featureCode=FEAT-D');
    assert.equal(res.status, 200);
    assert.equal(res.body.feature_total.usedIterations, 7);
    assert.equal(res.body.feature_total.usedActions, 30);
  });
});
