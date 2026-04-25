/**
 * status-route.test.js — Tests for GET /api/lifecycle/status.
 *
 * TDD red-phase: written before the route exists in vision-routes.js.
 *
 * Covers:
 *   - ?featureCode=<FC> returns valid snapshot
 *   - Missing featureCode returns no-feature snapshot (not 400)
 *   - Non-existent featureCode returns idle baseline (feature not found)
 *   - Response shape: { snapshot: StatusSnapshot }
 *   - Schema validity of returned snapshot
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(port, pathUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathUrl, method: 'GET' },
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
    req.end();
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let ctx;

beforeEach(() => new Promise((resolve) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-route-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Status Route Test Feature' });

  // Start lifecycle so featureCode is bound
  store.updateLifecycle(item.id, {
    currentPhase: 'execute',
    featureCode: 'COMP-OBS-STATUS-ROUTE-TEST',
    startedAt: new Date().toISOString(),
  });

  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmp,
  });

  const server = app.listen(0, () => {
    const port = server.address().port;
    ctx = { tmp, store, item, server, port, broadcasts };
    resolve();
  });
}));

afterEach(() => {
  ctx.server.close();
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/lifecycle/status', () => {
  test('returns 200 with valid snapshot for known featureCode', async () => {
    const { status, body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.snapshot, 'response must have snapshot field');
    const v = new SchemaValidator();
    const { valid, errors } = v.validate('StatusSnapshot', body.snapshot);
    assert.equal(valid, true, `snapshot schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);
  });

  test('snapshot sentence is non-empty string', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.equal(typeof body.snapshot.sentence, 'string');
    assert.ok(body.snapshot.sentence.length > 0);
  });

  test('snapshot active_phase matches current lifecycle phase', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.equal(body.snapshot.active_phase, 'execute');
  });

  test('missing featureCode returns no-feature snapshot (not 400)', async () => {
    const { status, body } = await httpGet(ctx.port, '/api/lifecycle/status');
    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.ok(body.snapshot, 'must have snapshot');
    assert.equal(body.snapshot.sentence, 'Select a feature to see status.');
    const v = new SchemaValidator();
    const { valid, errors } = v.validate('StatusSnapshot', body.snapshot);
    assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors)}`);
  });

  test('non-existent featureCode returns no-feature snapshot (not 404)', async () => {
    const { status, body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=NONEXISTENT-FC');
    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.ok(body.snapshot, 'must have snapshot');
    const v = new SchemaValidator();
    const { valid, errors } = v.validate('StatusSnapshot', body.snapshot);
    assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors)}`);
  });

  test('cta is always null in v1', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.equal(body.snapshot.cta, null);
  });

  test('gate_load_24h is 0 (TODO stub)', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.equal(body.snapshot.gate_load_24h, 0);
  });

  test('pending_gates is an array', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.ok(Array.isArray(body.snapshot.pending_gates));
  });

  test('drift_alerts is an array', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.ok(Array.isArray(body.snapshot.drift_alerts));
  });

  test('computed_at is a valid ISO datetime', async () => {
    const { body } = await httpGet(ctx.port, '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-ROUTE-TEST');
    assert.ok(!isNaN(Date.parse(body.snapshot.computed_at)), `invalid computed_at: ${body.snapshot.computed_at}`);
  });
});
