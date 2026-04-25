/**
 * iteration-emitter.test.js — Integration: iteration endpoints emit DecisionEvents correctly.
 *
 * COMP-OBS-TIMELINE A5:
 *   - start emits exactly 1 DecisionEvent (kind=iteration, stage implied by metadata)
 *   - report-with-status=complete emits exactly 1 DecisionEvent
 *   - report-with-status≠complete (per-attempt) emits ZERO DecisionEvents
 *   - abort emits 1 DecisionEvent with outcome='aborted'→mapped to 'fail'
 *
 * Run: node --test test/iteration-emitter.test.js
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const v = new SchemaValidator();

// ── test harness ─────────────────────────────────────────────────────────────

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'iter-emitter-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmp, 'docs', 'features', 'TEST-1'), { recursive: true });

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
      resolve({ tmp, store, server, port, broadcasts });
    });
  });
}

function teardown(ctx) {
  ctx.server.close();
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', c => buf += c);
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

// Setup item with lifecycle ready for iteration
async function setupItemWithLifecycle(ctx) {
  const item = ctx.store.createItem({ type: 'feature', title: 'Iter emitter test' });
  await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'TEST-1' });
  return item.id;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('iteration/start — emits one DecisionEvent', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('start emits exactly 1 iteration DecisionEvent', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 3,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(des.length, 1, `expected 1 iteration DE on start, got ${des.length}`);
  });

  test('start iteration event validates against schema', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'coverage', maxIterations: 5,
    });

    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.ok(de, 'expected iteration decisionEvent');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('start event feature_code matches item lifecycle featureCode', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 3,
    });
    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(de.event.feature_code, 'TEST-1');
  });
});

describe('iteration/report — complete emits 1 DE; per-attempt update emits 0 DE', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  async function startLoop(ctx, itemId, loopType = 'review') {
    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType, maxIterations: 5,
    });
    assert.equal(r.status, 200);
  }

  test('per-attempt report (exitCriteria not met) emits ZERO DecisionEvents', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await startLoop(ctx, itemId, 'review');
    ctx.broadcasts.length = 0;

    // report with clean=false → iterationUpdate (NOT complete)
    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
      result: { clean: false },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.continue, true);

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent');
    assert.equal(des.length, 0, `per-attempt update must NOT emit DecisionEvent, got ${des.length}`);

    // but iterationUpdate was broadcast
    const updates = ctx.broadcasts.filter(b => b.type === 'iterationUpdate');
    assert.equal(updates.length, 1, 'expected iterationUpdate broadcast');
  });

  test('report with exit-criteria met (clean=true) emits exactly 1 DecisionEvent', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await startLoop(ctx, itemId, 'review');

    // one per-attempt (no DE)
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
      result: { clean: false },
    });

    ctx.broadcasts.length = 0;
    // complete (clean=true) → iterationComplete + one DE
    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
      result: { clean: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.continue, false);

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(des.length, 1, `expected 1 iteration DE on complete, got ${des.length}`);
  });

  test('complete DecisionEvent validates against schema', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await startLoop(ctx, itemId, 'coverage');
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
      result: { passing: true },
    });

    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.ok(de, 'expected iteration decisionEvent on complete');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('max_reached (loop exhausted) also emits exactly 1 DecisionEvent', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 2,
    });

    // exhaust all attempts
    for (let i = 0; i < 2; i++) {
      await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
        result: { clean: false },
      });
    }

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    // 1 from start + 1 from complete = 2 total
    assert.equal(des.length, 2);
    const completeDe = des.find(d => d.event.metadata?.outcome === 'fail');
    assert.ok(completeDe, 'expected fail outcome on max_reached complete event');
  });
});

describe('iteration/abort — emits 1 DecisionEvent with fail outcome', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('abort emits exactly 1 iteration DecisionEvent', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 5,
    });
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/abort`, {});
    assert.equal(r.status, 200);

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(des.length, 1, `expected 1 iteration DE on abort, got ${des.length}`);
  });

  test('abort DecisionEvent validates against schema', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 5,
    });
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/abort`, {});

    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.ok(de, 'expected iteration decisionEvent on abort');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('abort DecisionEvent metadata.outcome maps to fail', async () => {
    const itemId = await setupItemWithLifecycle(ctx);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 5,
    });
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/iteration/abort`, {});

    // There will be 2 iteration DEs (start + abort/complete); find the one with outcome
    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    const abortDe = des.find(d => d.event.metadata?.outcome != null);
    assert.ok(abortDe, 'expected iteration DE with outcome for abort');
    assert.equal(abortDe.event.metadata.outcome, 'fail', 'aborted iteration outcome should map to fail');
  });
});
