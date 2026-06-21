/**
 * vision-routes-projection-gate.test.js — COMP-ROADMAP-PLAN T6 (S3).
 *
 * projectFeatureStatus writes feature.json by code — meaningless for a mode whose
 * runner.tracksFeatureJson is false (the plan session has no feature.json). The 5
 * lifecycle call sites (start/advance/skip/kill/complete-no-SHA) must SKIP the
 * projection for tracksFeatureJson:false modes, and still project for build.
 *
 * The guard client and the status writer are stubbed (test seams) so no
 * stratum-mcp subprocess and no real feature.json write occurs — we assert
 * purely on whether projectFeatureStatus reached the status writer.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { VisionStore } = await import(`${ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${ROOT}/server/vision-routes.js`);
const guard = await import(`${ROOT}/server/lifecycle-guard.js`);

let baseUrl;
let httpServer;
let store;
let statusWriterCalls;

function freshProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'vision-proj-gate-'));
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  return root;
}

before(() => new Promise(res => {
  // Stub the guard client so register/transition always apply (no subprocess).
  guard._testOnly_resetGuardCache();
  guard._testOnly_setGuardClient({
    register: async () => ({ status: 'registered', checksum: 'c', guard_id: 'g' }),
    transition: async (a) => ({ status: 'applied', current_state: a.toState, verdict: { met: true }, ledger_ref: 'r' }),
  });
  // Record every projectFeatureStatus → status-writer hop, write nothing.
  guard._testOnly_setStatusWriter(async (cwd, args) => {
    statusWriterCalls.push(args);
    return { ok: true };
  });

  store = new VisionStore(mkdtempSync(join(tmpdir(), 'vision-proj-gate-data-')));

  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: () => {},
    projectRoot: freshProjectRoot(),
    capabilities: { guard: true }, // projection gate only runs under the guard
  });

  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    res();
  });
}));

after(() => new Promise(res => {
  guard._testOnly_resetStatusWriter();
  guard._testOnly_resetGuardCache();
  httpServer.closeAllConnections?.();
  httpServer.close(res);
}));

beforeEach(() => { statusWriterCalls = []; });

async function post(path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

async function startItem({ type, featureCode, mode }) {
  const created = await post('/api/vision/items', { title: featureCode, type });
  const start = await post(`/api/vision/items/${created.body.id}/lifecycle/start`,
    mode ? { featureCode, mode } : { featureCode });
  assert.equal(start.status, 200, `start failed: ${JSON.stringify(start.body)}`);
  return created.body.id;
}

describe('projectFeatureStatus gated on tracksFeatureJson (T6)', () => {
  test('plan-session START does NOT project feature status', async () => {
    await startItem({ type: 'feature', featureCode: 'PLAN-NOPROJ-1', mode: 'plan' });
    assert.deepEqual(statusWriterCalls, [], 'plan start must not write feature.json status');
  });

  test('plan-session ADVANCE does NOT project feature status', async () => {
    const id = await startItem({ type: 'feature', featureCode: 'PLAN-NOPROJ-2', mode: 'plan' });
    statusWriterCalls = [];
    const adv = await post(`/api/vision/items/${id}/lifecycle/advance`, { targetPhase: 'plan' });
    assert.equal(adv.status, 200, `advance failed: ${JSON.stringify(adv.body)}`);
    assert.deepEqual(statusWriterCalls, [], 'plan advance must not project status');
  });

  test('plan-session KILL does NOT project feature status', async () => {
    const id = await startItem({ type: 'feature', featureCode: 'PLAN-NOPROJ-3', mode: 'plan' });
    statusWriterCalls = [];
    const kill = await post(`/api/vision/items/${id}/lifecycle/kill`, { reason: 'scrap' });
    assert.equal(kill.status, 200, `kill failed: ${JSON.stringify(kill.body)}`);
    assert.deepEqual(statusWriterCalls, [], 'plan kill must not project status');
  });

  test('build feature START DOES project feature status', async () => {
    await startItem({ type: 'feature', featureCode: 'BUILD-PROJ-1' }); // no mode → build
    assert.equal(statusWriterCalls.length, 1, 'build start must project status once');
    assert.equal(statusWriterCalls[0].code, 'BUILD-PROJ-1');
    assert.equal(statusWriterCalls[0].status, 'IN_PROGRESS', 'genesis phase → IN_PROGRESS');
  });

  test('build feature ADVANCE DOES project feature status', async () => {
    const id = await startItem({ type: 'feature', featureCode: 'BUILD-PROJ-2' });
    statusWriterCalls = [];
    const adv = await post(`/api/vision/items/${id}/lifecycle/advance`, { targetPhase: 'blueprint' });
    assert.equal(adv.status, 200, `advance failed: ${JSON.stringify(adv.body)}`);
    assert.equal(statusWriterCalls.length, 1, 'build advance must project status');
  });
});
