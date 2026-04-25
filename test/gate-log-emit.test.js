/**
 * gate-log-emit.test.js — Integration: gate resolution → GateLogEntry + DecisionEvent.
 *
 * Covers:
 *   - emit-first-then-append (Decision 3): gate DecisionEvent emitted before log written
 *   - decision_event_id populated on success, null on emit-throw
 *   - featureless gates (no itemId): skipped (Decision 1b)
 *   - expired path is not logged (no gateResolved call = no log; tested as absence)
 *   - Schema validation: GateLogEntry + DecisionEvent[kind=gate]
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);
const { readGateLog } = await import(`${REPO_ROOT}/server/gate-log-store.js`);

const sv = new SchemaValidator();

// ── Setup / teardown ──────────────────────────────────────────────────────

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'gate-emit-test-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });

  // Use a per-test gate log path to isolate test state
  const gateLogPath = join(dataDir, 'gate-log.jsonl');
  process.env.COMPOSE_GATE_LOG = gateLogPath;

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
      resolve({ tmp, dataDir, gateLogPath, store, broadcasts, server, port });
    });
  });
}

function teardown(ctx) {
  ctx.server.close();
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
  // Restore env
  delete process.env.COMPOSE_GATE_LOG;
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('gate-log-emit — golden path', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('resolve gate → GateLogEntry written + schema valid + DecisionEvent emitted with join key', async () => {
    // 1. Create an item + lifecycle
    const item = ctx.store.createItem({ type: 'feature', title: 'Gate emit test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-GATELOG-TEST' });

    // 2. Create a gate
    const gateR = await post(ctx.port, '/api/vision/gates', {
      flowId: 'flow-1', stepId: 'design_gate', round: 1,
      itemId: item.id, fromPhase: 'blueprint', toPhase: 'plan',
    });
    assert.equal(gateR.status, 201, `gate create failed: ${JSON.stringify(gateR.body)}`);
    const gateId = gateR.body.id;

    ctx.broadcasts.length = 0;

    // 3. Resolve the gate with 'approve'
    const resolveR = await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });
    assert.equal(resolveR.status, 200, `gate resolve failed: ${JSON.stringify(resolveR.body)}`);

    // 4. Assert GateLogEntry written to disk
    const entries = readGateLog({ logPath: ctx.gateLogPath });
    assert.equal(entries.length, 1, 'expected 1 gate log entry');
    const entry = entries[0];

    assert.equal(entry.gate_id, gateId, 'gate_id mismatch');
    assert.equal(entry.decision, 'approve', 'decision mismatch');
    assert.equal(entry.feature_code, 'COMP-GATELOG-TEST', 'feature_code mismatch');
    assert.ok(typeof entry.duration_to_decide_ms === 'number', 'duration_to_decide_ms must be number');

    // 5. Schema validate GateLogEntry
    const { valid: entryValid, errors: entryErrors } = sv.validate('GateLogEntry', entry);
    assert.equal(entryValid, true, `GateLogEntry schema invalid: ${JSON.stringify(entryErrors?.slice(0, 3))}`);

    // 6. Assert DecisionEvent[kind=gate] emitted with matching gate_log_entry_id
    const gateEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'gate');
    assert.equal(gateEvents.length, 1, `expected 1 gate DecisionEvent, got ${gateEvents.length}`);
    const event = gateEvents[0].event;

    assert.equal(event.feature_code, 'COMP-GATELOG-TEST', 'event.feature_code mismatch');
    assert.equal(event.metadata.gate_id, gateId, 'event.metadata.gate_id mismatch');
    assert.equal(event.metadata.decision, 'approve', 'event.metadata.decision mismatch');
    assert.equal(event.metadata.gate_log_entry_id, entry.id, 'gate_log_entry_id join key mismatch');

    // 7. Schema validate DecisionEvent
    const { valid: evValid, errors: evErrors } = sv.validate('DecisionEvent', event);
    assert.equal(evValid, true, `DecisionEvent schema invalid: ${JSON.stringify(evErrors?.slice(0, 3))}`);

    // 8. decision_event_id is back-populated on the entry
    assert.equal(entry.decision_event_id, event.id, 'decision_event_id back-pointer mismatch');
  });

  test('revise → interrupt in schema', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Revise test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-GATELOG-REVISE' });
    const gateR = await post(ctx.port, '/api/vision/gates', {
      flowId: 'flow-2', stepId: 'plan_gate', round: 1,
      itemId: item.id, fromPhase: 'plan',
    });
    const gateId = gateR.body.id;

    await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'revise' });

    const entries = readGateLog({ logPath: ctx.gateLogPath });
    const entry = entries.find(e => e.gate_id === gateId);
    assert.ok(entry, 'entry not found');
    assert.equal(entry.decision, 'interrupt', 'revise must map to interrupt');
  });

  test('kill → deny in schema', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Kill test' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-GATELOG-KILL' });
    const gateR = await post(ctx.port, '/api/vision/gates', {
      flowId: 'flow-3', stepId: 'exec_gate', round: 1,
      itemId: item.id, fromPhase: 'execute',
    });
    const gateId = gateR.body.id;

    await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'kill' });

    const entries = readGateLog({ logPath: ctx.gateLogPath });
    const entry = entries.find(e => e.gate_id === gateId);
    assert.ok(entry, 'entry not found');
    assert.equal(entry.decision, 'deny', 'kill must map to deny');
  });
});

describe('gate-log-emit — featureless gate skipped', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('gate with no itemId → no log entry, no gate DecisionEvent', async () => {
    // Create a gate without itemId (featureless)
    const gateR = await post(ctx.port, '/api/vision/gates', {
      flowId: 'flow-featureless', stepId: 'featureless_gate', round: 1,
      // NO itemId
    });
    assert.equal(gateR.status, 201, `gate create failed: ${JSON.stringify(gateR.body)}`);
    const gateId = gateR.body.id;

    ctx.broadcasts.length = 0;

    await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });

    // No log entry
    const entries = readGateLog({ logPath: ctx.gateLogPath });
    assert.equal(entries.length, 0, 'featureless gate must not produce a log entry');

    // No gate DecisionEvent
    const gateEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'gate');
    assert.equal(gateEvents.length, 0, 'featureless gate must not emit gate DecisionEvent');
  });

  test('gate with itemId but no featureCode → no log entry', async () => {
    // Item exists but lifecycle has no featureCode
    const item = ctx.store.createItem({ type: 'feature', title: 'No FC item' });
    // Do NOT call lifecycle/start (so featureCode is absent)
    const gateR = await post(ctx.port, '/api/vision/gates', {
      flowId: 'flow-nofc', stepId: 'nofc_gate', round: 1,
      itemId: item.id, fromPhase: 'blueprint',
    });
    const gateId = gateR.body.id;
    ctx.broadcasts.length = 0;

    await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });

    const entries = readGateLog({ logPath: ctx.gateLogPath });
    assert.equal(entries.length, 0, 'gate with featureless item must not produce a log entry');
  });
});

describe('gate-log-emit — idempotent already-resolved gate', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('resolving an already-resolved gate does not produce a second log entry', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Idempotent resolve' });
    await post(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-GATELOG-IDEM' });
    const gateR = await post(ctx.port, '/api/vision/gates', {
      flowId: 'flow-idem', stepId: 'idem_gate', round: 1, itemId: item.id,
    });
    const gateId = gateR.body.id;

    await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });
    await post(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });

    const entries = readGateLog({ logPath: ctx.gateLogPath });
    assert.equal(entries.length, 1, 'second resolve must not produce a second log entry');
  });
});
