/**
 * phase-transition-emitter.test.js — Integration: lifecycle endpoints emit DecisionEvents.
 *
 * COMP-OBS-TIMELINE A4: for each of advance/skip/kill/complete and the initial
 * lifecycle start:
 *   ① one DecisionEvent broadcast with kind='phase_transition'
 *   ② shape validates against COMP-OBS-CONTRACT DecisionEvent schema
 *   ③ lifecycle.phaseHistory entry appended
 *
 * Run: node --test test/phase-transition-emitter.test.js
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
  const tmp = mkdtempSync(join(tmpdir(), 'phase-emitter-'));
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

// Create an item with a lifecycle in a known phase, return its id
async function createItemWithLifecycle(port, store, targetPhase = 'explore_design') {
  const item = store.createItem({ type: 'feature', title: 'Phase emitter test feature' });

  // Start lifecycle (goes to explore_design) — that itself emits a DecisionEvent
  const r = await post(port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'TEST-1' });
  assert.equal(r.status, 200, `lifecycle/start failed: ${JSON.stringify(r.body)}`);

  if (targetPhase !== 'explore_design') {
    // Advance to requested phase
    const adv = await post(port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase });
    assert.equal(adv.status, 200, `advance failed: ${JSON.stringify(adv.body)}`);
  }
  return item.id;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('lifecycle/start — emits phase_transition DecisionEvent', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('emits exactly one phase_transition DecisionEvent on lifecycle start', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Start test' });
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'TEST-1' });
    assert.equal(r.status, 200);

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.equal(des.length, 1, `expected 1 phase_transition DE, got ${des.length}`);
    assert.equal(des[0].event.kind, 'phase_transition');
  });

  test('phase_transition event on start validates against schema', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Start schema test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'TEST-1' });

    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.ok(de, 'expected decisionEvent in broadcasts');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('phaseHistory populated after start', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Start history test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'TEST-1' });

    const stored = ctx.store.items.get(item.id);
    assert.ok(Array.isArray(stored.lifecycle.phaseHistory), 'phaseHistory should be an array');
    assert.ok(stored.lifecycle.phaseHistory.length >= 1, 'should have at least one entry');
    assert.equal(stored.lifecycle.phaseHistory[0].to, 'explore_design');
  });
});

describe('lifecycle/advance — emits phase_transition DecisionEvent', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('emits exactly one additional phase_transition on advance', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store);
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'prd' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.equal(des.length, 1, `expected 1 phase_transition DE, got ${des.length}`);
  });

  test('advance DecisionEvent validates against schema', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'prd' });

    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.ok(de, 'expected decisionEvent');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('phaseHistory entry added on advance', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store);
    const beforeLen = ctx.store.items.get(itemId).lifecycle.phaseHistory?.length || 0;
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'prd' });
    const after = ctx.store.items.get(itemId).lifecycle.phaseHistory;
    assert.equal(after.length, beforeLen + 1);
    assert.equal(after[after.length - 1].to, 'prd');
  });
});

describe('lifecycle/skip — emits phase_transition DecisionEvent', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('emits one phase_transition on skip', async () => {
    // advance to prd first (prd is skippable)
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store, 'prd');
    ctx.broadcasts.length = 0;

    // prd is skippable; skip to architecture
    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/skip`, { targetPhase: 'architecture' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.equal(des.length, 1);
  });

  test('skip event validates against schema', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store, 'prd');
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/skip`, { targetPhase: 'architecture' });
    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.ok(de, 'expected decisionEvent after skip');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('phaseHistory entry added on skip', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store, 'prd');
    const beforeLen = ctx.store.items.get(itemId).lifecycle.phaseHistory?.length || 0;
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/skip`, { targetPhase: 'architecture' });
    const after = ctx.store.items.get(itemId).lifecycle.phaseHistory;
    assert.equal(after.length, beforeLen + 1);
  });
});

describe('lifecycle/kill — emits phase_transition DecisionEvent', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('emits one phase_transition on kill', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store);
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/kill`, { reason: 'test kill' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.equal(des.length, 1);
  });

  test('kill event validates against schema', async () => {
    const itemId = await createItemWithLifecycle(ctx.port, ctx.store);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/kill`, { reason: 'test kill' });
    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.ok(de);
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});

describe('lifecycle/complete — emits phase_transition DecisionEvent', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  async function advanceToShip(port, store) {
    const item = store.createItem({ type: 'feature', title: 'Ship test' });
    await post(port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'TEST-1' });
    // Advance through all phases to ship
    const phases = ['prd', 'architecture', 'blueprint', 'verification', 'plan', 'execute', 'report', 'docs', 'ship'];
    for (const phase of phases) {
      const r = await post(port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: phase });
      if (r.status !== 200) throw new Error(`failed to advance to ${phase}: ${JSON.stringify(r.body)}`);
    }
    return item.id;
  }

  test('emits one phase_transition on complete', async () => {
    const itemId = await advanceToShip(ctx.port, ctx.store);
    ctx.broadcasts.length = 0;

    const r = await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/complete`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.equal(des.length, 1);
  });

  test('complete event validates against schema', async () => {
    const itemId = await advanceToShip(ctx.port, ctx.store);
    await post(ctx.port, `/api/vision/items/${itemId}/lifecycle/complete`, {});
    const de = ctx.broadcasts.find(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.ok(de, 'expected a phase_transition decisionEvent for complete');
    const r = v.validate('DecisionEvent', de.event);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});
