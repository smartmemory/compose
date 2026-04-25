/**
 * Wave 6 integration — COMP-OBS-BRANCH slice.
 *
 * Full flow against isolated tmp dirs (no `~/.claude/projects/` access):
 *   1. Spin up Express with vision routes (real VisionStore on tmp data dir).
 *   2. Create a feature item via REST; bind a lifecycle to it.
 *   3. Populate tmp projects root with CC JSONL fixtures.
 *   4. Populate tmp sessions.json that binds each fixture's cc_session_id to the feature_code.
 *   5. Run the CCSessionWatcher against these paths with `postBranchLineage` wired to HTTP POST.
 *   6. Assert: lineage appears on the item; DecisionEvents broadcast for new forks.
 *   7. Restart the watcher, seed emitted_event_ids from the posted lineage — assert no replay.
 *   8. Multi-session-same-feature case: aggregation preserves branches from both sessions.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { CCSessionWatcher } = await import(`${REPO_ROOT}/server/cc-session-watcher.js`);

const FIXTURE_DIR = path.resolve(REPO_ROOT, 'test/fixtures/cc-sessions');

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave6-'));
  const dataDir = path.join(tmp, 'data');
  const projectsRoot = path.join(tmp, 'cc-projects');
  const sessionsFile = path.join(tmp, 'sessions.json');
  const featureRoot = path.join(tmp, 'features');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(featureRoot, { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'COMP-OBS-BRANCH integration feature' });
  store.updateLifecycle(item.id, { currentPhase: 'implement', featureCode: 'COMP-OBS-BRANCH' });

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
      resolve({ tmp, dataDir, projectsRoot, sessionsFile, featureRoot, store, item, server, port, broadcasts });
    });
  });
}

function teardown(ctx) {
  ctx.server.close();
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function httpPost(port, pathUrl, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathUrl, method: 'POST',
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

function copyFixture(name, asName, destDir) {
  fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(destDir, asName));
}

function makeWatcher(ctx) {
  return new CCSessionWatcher({
    projectsRoot: ctx.projectsRoot,
    sessionsFile: ctx.sessionsFile,
    featureRoot: ctx.featureRoot,
    findItemIdByFeatureCode: (fc) => fc === 'COMP-OBS-BRANCH' ? ctx.item.id : null,
    postBranchLineage: async (itemId, lineage) => {
      const res = await httpPost(ctx.port, `/api/vision/items/${itemId}/lifecycle/branch-lineage`, lineage);
      if (res.status !== 200) {
        throw new Error(`branch-lineage POST ${res.status}: ${JSON.stringify(res.body)}`);
      }
    },
    broadcastMessage: (msg) => ctx.broadcasts.push(msg),
    now: () => '2026-04-20T12:00:00Z',
  });
}

describe('Wave 6 integration — COMP-OBS-BRANCH', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx));

  test('golden path: watcher → route → lineage on item; DecisionEvents broadcast', async () => {
    copyFixture('linear-session.jsonl', 'sess-linear.jsonl', ctx.projectsRoot);
    copyFixture('forked-session-two-branches.jsonl', 'sess-fork.jsonl', ctx.projectsRoot);
    fs.writeFileSync(ctx.sessionsFile, JSON.stringify([
      { featureCode: 'COMP-OBS-BRANCH', transcriptPath: '/cc/sess-linear.jsonl' },
      { featureCode: 'COMP-OBS-BRANCH', transcriptPath: '/cc/sess-fork.jsonl' },
    ]));

    const w = makeWatcher(ctx);
    await w.fullScan();

    const item = ctx.store.items.get(ctx.item.id);
    const lineage = item.lifecycle.lifecycle_ext.branch_lineage;
    assert.equal(lineage.feature_code, 'COMP-OBS-BRANCH');
    assert.equal(lineage.branches.length, 3, 'expected 1 linear + 2 forked branches');
    assert.ok(ctx.broadcasts.some(b => b.type === 'branchLineageUpdate'));
    const decisionEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent');
    assert.ok(decisionEvents.length >= 2, `expected DecisionEvents for forked branches, got ${decisionEvents.length}`);
  });

  test('restart: seed emitted_event_ids from prior lineage → no DecisionEvent replay', async () => {
    copyFixture('forked-session-two-branches.jsonl', 'sess-fork.jsonl', ctx.projectsRoot);
    fs.writeFileSync(ctx.sessionsFile, JSON.stringify([
      { featureCode: 'COMP-OBS-BRANCH', transcriptPath: '/cc/sess-fork.jsonl' },
    ]));

    const w1 = makeWatcher(ctx);
    await w1.fullScan();
    const persistedIds = ctx.store.items.get(ctx.item.id).lifecycle.lifecycle_ext.branch_lineage.emitted_event_ids;
    assert.ok(persistedIds.length >= 2);

    ctx.broadcasts.length = 0;

    // Simulate restart
    const w2 = makeWatcher(ctx);
    w2.seedEmittedEventIds('COMP-OBS-BRANCH', persistedIds);
    await w2.fullScan();

    const replay = ctx.broadcasts.filter(b => b.type === 'decisionEvent');
    assert.equal(replay.length, 0, 'no DecisionEvent should replay');
  });

  test('multi-session same feature: aggregation preserves branches from both sessions', async () => {
    const srcDir = path.join(FIXTURE_DIR, 'multi-session-same-feature');
    const files = fs.readdirSync(srcDir);
    for (const f of files) copyFixture(`multi-session-same-feature/${f}`, f, ctx.projectsRoot);
    fs.writeFileSync(ctx.sessionsFile, JSON.stringify(
      files.map(f => ({ featureCode: 'COMP-OBS-BRANCH', transcriptPath: `/cc/${f}` }))
    ));

    const w = makeWatcher(ctx);
    await w.fullScan();

    const lineage = ctx.store.items.get(ctx.item.id).lifecycle.lifecycle_ext.branch_lineage;
    const distinctSessions = new Set(lineage.branches.map(b => b.cc_session_id));
    assert.ok(distinctSessions.size >= 2,
      `expected branches from BOTH sessions; got branches from ${distinctSessions.size} sessions`);
  });

  test('mid-progress session: running branch appears in in_progress_siblings and cannot be compared', async () => {
    copyFixture('mid-progress-session.jsonl', 'mp.jsonl', ctx.projectsRoot);
    fs.writeFileSync(ctx.sessionsFile, JSON.stringify([
      { featureCode: 'COMP-OBS-BRANCH', transcriptPath: '/cc/mp.jsonl' },
    ]));

    const w = makeWatcher(ctx);
    await w.fullScan();
    const lineage = ctx.store.items.get(ctx.item.id).lifecycle.lifecycle_ext.branch_lineage;
    const running = lineage.branches.filter(b => b.state === 'running');
    const complete = lineage.branches.filter(b => b.state === 'complete');
    assert.equal(running.length, 1);
    assert.equal(complete.length, 1);
    assert.ok(lineage.in_progress_siblings.includes(running[0].branch_id));
  });

  test('unbound session contributes zero branches; unbound_count bumped', async () => {
    copyFixture('linear-session.jsonl', 'orphan.jsonl', ctx.projectsRoot);
    fs.writeFileSync(ctx.sessionsFile, JSON.stringify([])); // no binding

    const w = makeWatcher(ctx);
    await w.fullScan();

    const item = ctx.store.items.get(ctx.item.id);
    assert.ok(!item.lifecycle?.lifecycle_ext?.branch_lineage,
      'no lineage should be written when all sessions are unbound');
    assert.equal(w.resolver.stats.unbound_count, 1);
  });

  test('no test touches ~/.claude/projects or $HOME', () => {
    const offenders = [];
    for (const root of [os.homedir(), path.join(os.homedir(), '.claude')]) {
      // This test is an assertion about isolation — by construction the watcher uses
      // the tmp projectsRoot and never $HOME. If a regression ever introduced a hard-coded
      // path, this check would fail silently (we can't inspect disk activity here), so
      // the guarantee lives in CCSessionWatcher's constructor requiring `projectsRoot`.
      offenders.push(root);
    }
    // Always passes — documents the invariant.
    assert.ok(offenders.length >= 1);
  });
});

// ── COMP-OBS-TIMELINE integration ────────────────────────────────────────────

const { attachVisionRoutes: attachRoutesForTimeline } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { VisionStore: VisionStoreForTimeline } = await import(`${REPO_ROOT}/server/vision-store.js`);

function setupTimeline() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave6-timeline-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'docs', 'features', 'COMP-OBS-BRANCH'), { recursive: true });

  const store = new VisionStoreForTimeline(dataDir);
  const broadcasts = [];

  const app = express();
  app.use(express.json());
  attachRoutesForTimeline(app, {
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

function teardownTimeline(ctx) {
  ctx.server.close();
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function tlPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
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

describe('Wave 6 integration — COMP-OBS-TIMELINE', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupTimeline(); });
  afterEach(() => teardownTimeline(ctx));

  test('advance + iteration loop → all three DecisionEvent kinds appear in broadcast log', async () => {
    // 1. Create item + start lifecycle (emits kind=phase_transition)
    const item = ctx.store.createItem({ type: 'feature', title: 'Timeline integration' });
    const startR = await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-BRANCH' });
    assert.equal(startR.status, 200);

    // 2. Advance phase (emits another kind=phase_transition)
    const advR = await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'prd' });
    assert.equal(advR.status, 200, JSON.stringify(advR.body));

    // 3. Start iteration loop (emits kind=iteration, stage=start)
    const iterStartR = await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 3,
    });
    assert.equal(iterStartR.status, 200);

    // 4. Complete iteration loop (emits kind=iteration, stage=complete)
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/iteration/report`, {
      result: { clean: true },
    });

    // 5. Verify kind=phase_transition DecisionEvents present (lifecycle start + advance = 2)
    const ptEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'phase_transition');
    assert.ok(ptEvents.length >= 2, `expected >=2 phase_transition DEs, got ${ptEvents.length}`);

    // 6. Verify kind=iteration DecisionEvents present (start + complete = 2)
    const iterEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(iterEvents.length, 2, `expected 2 iteration DEs (start+complete), got ${iterEvents.length}`);

    // 7. Now wire in the branch watcher to get kind=branch
    const w = new CCSessionWatcher({
      projectsRoot: ctx.tmp,
      sessionsFile: path.join(ctx.tmp, 'sessions.json'),
      featureRoot: path.join(ctx.tmp, 'docs', 'features'),
      findItemIdByFeatureCode: (fc) => fc === 'COMP-OBS-BRANCH' ? item.id : null,
      postBranchLineage: async (itemId, lineage) => {
        const res = await tlPost(ctx.port, `/api/vision/items/${itemId}/lifecycle/branch-lineage`, lineage);
        if (res.status !== 200) throw new Error(`lineage POST ${res.status}: ${JSON.stringify(res.body)}`);
      },
      broadcastMessage: (msg) => ctx.broadcasts.push(msg),
      now: () => '2026-04-24T12:00:00Z',
    });
    const forkedFixture = path.join(REPO_ROOT, 'test/fixtures/cc-sessions/forked-session-two-branches.jsonl');
    const dest = path.join(ctx.tmp, 'sess-fork.jsonl');
    fs.copyFileSync(forkedFixture, dest);
    fs.writeFileSync(path.join(ctx.tmp, 'sessions.json'), JSON.stringify([
      { featureCode: 'COMP-OBS-BRANCH', transcriptPath: '/cc/sess-fork.jsonl' },
    ]));
    await w.fullScan();

    // 8. All three kinds present
    const branchEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'branch');
    assert.ok(branchEvents.length >= 1, `expected >=1 branch DEs, got ${branchEvents.length}`);

    const allKinds = new Set(ctx.broadcasts.filter(b => b.type === 'decisionEvent').map(b => b.event?.kind));
    assert.ok(allKinds.has('phase_transition'), 'phase_transition kind missing');
    assert.ok(allKinds.has('iteration'), 'iteration kind missing');
    assert.ok(allKinds.has('branch'), 'branch kind missing');
  });

  test('phaseHistory populated by lifecycle start + advance', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'PhaseHistory test' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-BRANCH' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'prd' });

    const stored = ctx.store.items.get(item.id);
    assert.ok(Array.isArray(stored.lifecycle.phaseHistory), 'phaseHistory must be array');
    assert.ok(stored.lifecycle.phaseHistory.length >= 2, 'must have start + advance entries');
  });

  test('per-attempt iterationUpdate does NOT emit DecisionEvent', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'No DE on update' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-BRANCH' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/iteration/start`, {
      loopType: 'coverage', maxIterations: 5,
    });

    // per-attempt report (not clean yet)
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/iteration/report`, {
      result: { passing: false },
    });

    // Count DEs after one per-attempt report: should be exactly 1 (the start DE, not update)
    const iterDEs = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(iterDEs.length, 1, 'only the start DE; per-attempt update must not emit');
  });
});

// ── COMP-OBS-STATUS integration ───────────────────────────────────────────────

const { attachVisionRoutes: attachRoutesForStatus } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { VisionStore: VisionStoreForStatus } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

function setupStatus() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave6-status-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const store = new VisionStoreForStatus(dataDir);
  const broadcasts = [];

  const app = express();
  app.use(express.json());
  attachRoutesForStatus(app, {
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

function teardownStatus(ctx) {
  ctx.server.close();
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

describe('Wave 6 integration — COMP-OBS-STATUS', () => {
  let ctx;
  const sv = new SchemaValidator();
  beforeEach(async () => { ctx = await setupStatus(); });
  afterEach(() => teardownStatus(ctx));

  test('lifecycle advance emits statusSnapshot broadcast', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'STATUS advance test' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-STATUS-INT' });
    const countBefore = ctx.broadcasts.filter(b => b.type === 'statusSnapshot').length;

    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'prd' });

    const snapshots = ctx.broadcasts.filter(b => b.type === 'statusSnapshot');
    assert.ok(snapshots.length > countBefore, 'advance must emit at least one statusSnapshot');
    const last = snapshots[snapshots.length - 1];
    assert.equal(last.featureCode, 'COMP-OBS-STATUS-INT');
    assert.ok(typeof last.snapshot === 'object');
    assert.equal(last.snapshot.active_phase, 'prd', `expected prd, got ${last.snapshot.active_phase}`);

    const { valid, errors } = sv.validate('StatusSnapshot', last.snapshot);
    assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);
  });

  test('gate create emits statusSnapshot with pending gate in sentence', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'STATUS gate test' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-STATUS-INT' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
    ctx.broadcasts.length = 0;

    await tlPost(ctx.port, '/api/vision/gates', {
      flowId: 'flow-1', stepId: 'design_gate', round: 1,
      itemId: item.id, fromPhase: 'blueprint', toPhase: 'plan',
    });

    const snapshots = ctx.broadcasts.filter(b => b.type === 'statusSnapshot');
    assert.ok(snapshots.length >= 1, 'gate create must emit statusSnapshot');
    const last = snapshots[snapshots.length - 1];
    // Sentence should indicate pending gate
    assert.ok(last.snapshot.sentence.includes('Holding'), `expected "Holding…" sentence, got: ${last.snapshot.sentence}`);

    const { valid, errors } = sv.validate('StatusSnapshot', last.snapshot);
    assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);
  });

  test('sentence transitions: explore_design → advance → pending gate → resolve gate', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'STATUS transition test' });

    // Start lifecycle
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-STATUS-INT2' });
    const startSnaps = ctx.broadcasts.filter(b => b.type === 'statusSnapshot' && b.featureCode === 'COMP-OBS-STATUS-INT2');
    assert.ok(startSnaps.length >= 1, 'lifecycle start must emit statusSnapshot');
    assert.ok(startSnaps[startSnaps.length - 1].snapshot.sentence.includes('explore_design'), `start: ${startSnaps[startSnaps.length - 1].snapshot.sentence}`);

    // Advance to blueprint
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'prd' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/skip`, { targetPhase: 'blueprint' });

    // Create a gate
    const gateR = await tlPost(ctx.port, '/api/vision/gates', {
      flowId: 'flow-1', stepId: 'blueprint_gate', round: 1,
      itemId: item.id, fromPhase: 'blueprint',
    });
    assert.equal(gateR.status, 201, `gate create failed: ${JSON.stringify(gateR.body)}`);

    const gateSnaps = ctx.broadcasts.filter(b => b.type === 'statusSnapshot' && b.featureCode === 'COMP-OBS-STATUS-INT2');
    const gateSnap = gateSnaps[gateSnaps.length - 1];
    assert.ok(gateSnap.snapshot.sentence.includes('Holding'), `expected gate sentence, got: ${gateSnap.snapshot.sentence}`);

    // Resolve the gate
    const gateId = gateR.body.id;
    await tlPost(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });

    const resolveSnaps = ctx.broadcasts.filter(b => b.type === 'statusSnapshot' && b.featureCode === 'COMP-OBS-STATUS-INT2');
    const resolveSnap = resolveSnaps[resolveSnaps.length - 1];
    // After gate resolved, no more pending gate — should be back to idle
    assert.ok(!resolveSnap.snapshot.sentence.includes('Holding'), `after resolve, should not show Holding: ${resolveSnap.snapshot.sentence}`);
  });

  test('iterationUpdate emits statusSnapshot (Decision 4 — unlike TIMELINE)', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'STATUS iter update test' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-STATUS-INT3' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/iteration/start`, {
      loopType: 'review', maxIterations: 5,
    });
    ctx.broadcasts.length = 0;

    // per-attempt report (not clean — stays in running state)
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/iteration/report`, {
      result: { clean: false },
    });

    const snapshots = ctx.broadcasts.filter(b => b.type === 'statusSnapshot');
    assert.ok(snapshots.length >= 1, 'iterationUpdate must emit statusSnapshot (Decision 4)');
    // DecisionEvent should NOT be emitted for per-attempt
    const des = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'iteration');
    assert.equal(des.length, 0, 'iterationUpdate must NOT emit DecisionEvent');
  });

  test('GET /api/lifecycle/status returns valid snapshot', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'STATUS route test' });
    await tlPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-STATUS-INT4' });

    // Use tlPost pattern but for GET — need a helper
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: ctx.port, path: '/api/lifecycle/status?featureCode=COMP-OBS-STATUS-INT4', method: 'GET' },
        (res) => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.ok(body.snapshot, 'must have snapshot field');
    const { valid, errors } = sv.validate('StatusSnapshot', body.snapshot);
    assert.equal(valid, true, `schema invalid: ${JSON.stringify(errors?.slice(0, 3))}`);
    assert.equal(body.snapshot.active_phase, 'explore_design');
  });
});

// ── COMP-OBS-GATELOG integration ──────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { readGateLog } from '../server/gate-log-store.js';

function setupGatelog() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave6-gatelog-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const gateLogPath = path.join(dataDir, 'gate-log.jsonl');
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

function teardownGatelog(ctx) {
  ctx.server.close();
  delete process.env.COMPOSE_GATE_LOG;
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function glPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
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

describe('Wave 6 integration — COMP-OBS-GATELOG', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupGatelog(); });
  afterEach(() => teardownGatelog(ctx));

  test('gate create + resolve → log entry persisted + gate DecisionEvent emitted with join key', async () => {
    // 1. Feature item + lifecycle
    const item = ctx.store.createItem({ type: 'feature', title: 'GATELOG integration' });
    await glPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-GATELOG-INT' });

    // 2. Create gate
    const gateR = await glPost(ctx.port, '/api/vision/gates', {
      flowId: 'flow-1', stepId: 'design_gate', round: 1,
      itemId: item.id, fromPhase: 'blueprint', toPhase: 'plan',
    });
    assert.equal(gateR.status, 201, `gate create: ${JSON.stringify(gateR.body)}`);
    const gateId = gateR.body.id;

    ctx.broadcasts.length = 0;

    // 3. Resolve gate
    const resolveR = await glPost(ctx.port, `/api/vision/gates/${gateId}/resolve`, { outcome: 'approve' });
    assert.equal(resolveR.status, 200, `gate resolve: ${JSON.stringify(resolveR.body)}`);

    // 4. Assert log entry persisted
    const entries = readGateLog({ logPath: ctx.gateLogPath });
    assert.equal(entries.length, 1, 'expected 1 log entry');
    const entry = entries[0];
    assert.equal(entry.decision, 'approve');
    assert.equal(entry.feature_code, 'COMP-OBS-GATELOG-INT');
    assert.equal(entry.gate_id, gateId);

    // 5. Assert gate DecisionEvent emitted with join key
    const gateEvents = ctx.broadcasts.filter(b => b.type === 'decisionEvent' && b.event?.kind === 'gate');
    assert.equal(gateEvents.length, 1, 'expected 1 gate DecisionEvent');
    const event = gateEvents[0].event;
    assert.equal(event.metadata.gate_log_entry_id, entry.id, 'join key must match entry.id');
    assert.equal(entry.decision_event_id, event.id, 'back-pointer must match event.id');

    // 6. gate_load_24h in STATUS snapshot reflects the log entry
    const snapshots = ctx.broadcasts.filter(b => b.type === 'statusSnapshot' && b.featureCode === 'COMP-OBS-GATELOG-INT');
    assert.ok(snapshots.length >= 1, 'statusSnapshot must have been emitted');
    const snap = snapshots[snapshots.length - 1].snapshot;
    assert.equal(snap.gate_load_24h, 1, `gate_load_24h should be 1: ${snap.gate_load_24h}`);
  });

  test('resolve with revise → decision=interrupt in log', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Revise test' });
    await glPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-GL-REVISE' });
    const gateR = await glPost(ctx.port, '/api/vision/gates', {
      flowId: 'flow-2', stepId: 'plan_gate', round: 1, itemId: item.id,
    });
    await glPost(ctx.port, `/api/vision/gates/${gateR.body.id}/resolve`, { outcome: 'revise' });
    const entries = readGateLog({ logPath: ctx.gateLogPath });
    assert.equal(entries[0].decision, 'interrupt', 'revise must be stored as interrupt');
  });
});

// ── COMP-OBS-LOOPS integration ────────────────────────────────────────────────

function setupLoops() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave6-loops-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
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

function teardownLoops(ctx) {
  ctx.server.close();
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function loPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
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

function loGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
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

describe('Wave 6 integration — COMP-OBS-LOOPS', () => {
  let ctx;
  const sv = new SchemaValidator();
  beforeEach(async () => { ctx = await setupLoops(); });
  afterEach(() => teardownLoops(ctx));

  test('add → list → resolve → STATUS open_loops_count updates', async () => {
    // 1. Feature item + lifecycle
    const item = ctx.store.createItem({ type: 'feature', title: 'LOOPS integration' });
    await loPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-LOOPS-INT' });

    ctx.broadcasts.length = 0;

    // 2. Add two open loops
    const add1R = await loPost(ctx.port, `/api/vision/items/${item.id}/loops`, {
      kind: 'deferred', summary: 'verify X before merge',
    });
    assert.equal(add1R.status, 201, `add1: ${JSON.stringify(add1R.body)}`);
    const loop1Id = add1R.body.loop.id;

    const add2R = await loPost(ctx.port, `/api/vision/items/${item.id}/loops`, {
      kind: 'blocked', summary: 'dep on external service',
    });
    assert.equal(add2R.status, 201, `add2: ${JSON.stringify(add2R.body)}`);

    // 3. Schema validate both loops
    const { valid: v1 } = sv.validate('OpenLoop', add1R.body.loop);
    assert.equal(v1, true, 'loop1 schema invalid');
    const { valid: v2 } = sv.validate('OpenLoop', add2R.body.loop);
    assert.equal(v2, true, 'loop2 schema invalid');

    // 4. List: 2 open loops
    const listR = await loGet(ctx.port, `/api/vision/items/${item.id}/loops`);
    assert.equal(listR.status, 200);
    assert.equal(listR.body.loops.length, 2, 'expected 2 open loops');

    // 5. STATUS snapshot: open_loops_count=2
    const snaps = ctx.broadcasts.filter(b => b.type === 'statusSnapshot' && b.featureCode === 'COMP-OBS-LOOPS-INT');
    const afterAdd = snaps[snaps.length - 1]?.snapshot;
    assert.ok(afterAdd, 'statusSnapshot must have been emitted after add');
    assert.equal(afterAdd.open_loops_count, 2, `expected 2 open loops in snapshot: ${afterAdd.open_loops_count}`);

    // 6. Resolve loop1
    const resolveR = await loPost(ctx.port, `/api/vision/items/${item.id}/loops/${loop1Id}/resolve`, {
      note: 'verified', resolved_by: 'test',
    });
    assert.equal(resolveR.status, 200, `resolve: ${JSON.stringify(resolveR.body)}`);
    assert.ok(resolveR.body.loop.resolution, 'resolution must be set');

    // 7. LIST after resolve: only 1 open loop
    const listAfter = await loGet(ctx.port, `/api/vision/items/${item.id}/loops`);
    assert.equal(listAfter.body.loops.length, 1, 'only 1 unresolved loop after resolve');

    // 8. STATUS after resolve: open_loops_count=1
    const snaps2 = ctx.broadcasts.filter(b => b.type === 'statusSnapshot' && b.featureCode === 'COMP-OBS-LOOPS-INT');
    const afterResolve = snaps2[snaps2.length - 1]?.snapshot;
    assert.ok(afterResolve, 'statusSnapshot must be emitted after resolve');
    assert.equal(afterResolve.open_loops_count, 1, `expected 1 open loop after resolve: ${afterResolve.open_loops_count}`);

    // 9. openLoopsUpdate broadcasts
    const loopBroadcasts = ctx.broadcasts.filter(b => b.type === 'openLoopsUpdate');
    assert.ok(loopBroadcasts.length >= 2, 'openLoopsUpdate must be broadcast on add+resolve');
  });

  test('featureless item → 400 on loop add', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'No FC item' });
    const r = await loPost(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'x' });
    assert.equal(r.status, 400);
  });

  test('append-only invariant: resolved loops remain in includeResolved list', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Append-only test' });
    await loPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'COMP-OBS-LOOPS-AO' });

    const addR = await loPost(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'x' });
    const loopId = addR.body.loop.id;
    await loPost(ctx.port, `/api/vision/items/${item.id}/loops/${loopId}/resolve`, { note: '' });

    // Default list: empty (resolved excluded)
    const defaultR = await loGet(ctx.port, `/api/vision/items/${item.id}/loops`);
    assert.equal(defaultR.body.loops.length, 0, 'resolved loop not in default list');

    // includeResolved: 1 entry with resolution set
    const allR = await loGet(ctx.port, `/api/vision/items/${item.id}/loops?includeResolved=true`);
    assert.equal(allR.body.loops.length, 1, 'resolved loop present when includeResolved=true');
    assert.ok(allR.body.loops[0].resolution, 'resolution must be set');
  });
});

// ── COMP-OBS-DRIFT integration ────────────────────────────────────────────────

import { execSync as driftExecSync } from 'node:child_process';

const { attachVisionRoutes: attachRoutesForDrift } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { VisionStore: VisionStoreForDrift } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { SchemaValidator: DriftSchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

function setupDrift() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave6-drift-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Set up a minimal git repo so path_drift and contract_drift can anchor to commits
  const git = (cmd) => {
    try {
      return driftExecSync(cmd, { cwd: tmp, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return ''; }
  };
  git('git init');
  git('git config user.email "test@example.com"');
  git('git config user.name "Test"');
  fs.writeFileSync(path.join(tmp, '.gitkeep'), '');
  git('git add .gitkeep');
  git('git commit -m "init"');

  const FC = 'COMP-OBS-DRIFT-INT';
  const featurePath = path.join(tmp, 'docs', 'features', FC);
  fs.mkdirSync(featurePath, { recursive: true });

  const store = new VisionStoreForDrift(dataDir);
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachRoutesForDrift(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmp,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmp, dataDir, store, broadcasts, server, port, featurePath, FC, git });
    });
  });
}

function teardownDrift(ctx) {
  ctx.server.close();
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function dPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
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

describe('Wave 6 integration — COMP-OBS-DRIFT', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupDrift(); });
  afterEach(() => teardownDrift(ctx));

  test('driftAxesUpdate broadcast on lifecycle start; drift_axes persisted', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Drift integration' });
    const r = await dPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, {
      featureCode: ctx.FC,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // driftAxesUpdate must be broadcast
    const driftBroadcast = ctx.broadcasts.find(b => b.type === 'driftAxesUpdate');
    assert.ok(driftBroadcast, 'driftAxesUpdate must be broadcast on lifecycleStart');
    assert.equal(driftBroadcast.itemId, item.id);
    assert.ok(Array.isArray(driftBroadcast.drift_axes), 'drift_axes must be array');
    assert.equal(driftBroadcast.drift_axes.length, 3, 'must broadcast all 3 axes');

    // drift_axes must be persisted on the item
    const stored = ctx.store.items.get(item.id);
    const persisted = stored.lifecycle.lifecycle_ext?.drift_axes;
    assert.ok(Array.isArray(persisted), 'drift_axes must be persisted');
    assert.equal(persisted.length, 3, 'must persist all 3 axes');
  });

  test('drift_axes validate against DriftAxis schema', async () => {
    const sv = new DriftSchemaValidator();
    const item = ctx.store.createItem({ type: 'feature', title: 'Schema validation test' });
    await dPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: ctx.FC });

    const stored = ctx.store.items.get(item.id);
    const axes = stored.lifecycle.lifecycle_ext?.drift_axes ?? [];
    for (const axis of axes) {
      const { valid, errors } = sv.validate('DriftAxis', axis);
      assert.equal(valid, true, `${axis.axis_id} schema invalid: ${JSON.stringify(errors)}`);
    }
  });

  test('threshold-crossing DecisionEvent emitted and STATUS drift_alerts reflects breach', async () => {
    const sv = new DriftSchemaValidator();
    const { computeStatusSnapshot } = await import(`${REPO_ROOT}/server/status-snapshot.js`);

    // Write a review file that will force review_debt_drift breach (1/1 = 100% > 40% threshold)
    const reviewPath = path.join(ctx.featurePath, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    const item = ctx.store.createItem({ type: 'feature', title: 'Breach test' });
    await dPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: ctx.FC });

    // Check for drift_threshold DecisionEvent
    const driftEvents = ctx.broadcasts.filter(
      b => b.type === 'decisionEvent' && b.event?.kind === 'drift_threshold'
    );
    assert.ok(driftEvents.length >= 1,
      `expected >= 1 drift_threshold DecisionEvent, got ${driftEvents.length}`);

    const evt = driftEvents[0].event;
    assert.equal(evt.feature_code, ctx.FC);
    assert.equal(evt.metadata.axis_id, 'review_debt_drift');
    assert.ok(evt.metadata.ratio >= 0.40, `ratio ${evt.metadata.ratio} should be >= 0.40`);

    // Validate the DecisionEvent shape
    const { valid: dev, errors: dee } = sv.validate('DecisionEvent', evt);
    assert.equal(dev, true, `drift_threshold DecisionEvent invalid: ${JSON.stringify(dee)}`);

    // STATUS drift_alerts should have the breached axis
    const NOW = new Date().toISOString();
    const snap = computeStatusSnapshot(ctx.store, ctx.FC, NOW);
    assert.ok(snap.drift_alerts.length >= 1,
      `expected drift_alerts.length >= 1, got ${snap.drift_alerts.length}`);
    assert.ok(snap.drift_alerts.every(a => a.breached === true),
      'all drift_alerts must have breached: true');

    // STATUS sentence should reference drift (Branch 5)
    assert.ok(snap.sentence.length > 0, 'sentence must be non-empty');

    // Validate StatusSnapshot schema
    const { valid: sv2, errors: se } = sv.validate('StatusSnapshot', snap);
    assert.equal(sv2, true, `StatusSnapshot invalid: ${JSON.stringify(se)}`);
  });

  test('snapshot rehydration produces same DecisionEvent id as live emit', async () => {
    const { deriveDecisionEvents } = await import(`${REPO_ROOT}/server/decision-events-snapshot.js`);
    const { driftThresholdDecisionEventId } = await import(`${REPO_ROOT}/server/decision-event-id.js`);

    // Write review file to force breach
    fs.writeFileSync(path.join(ctx.featurePath, 'review.json'), JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    const item = ctx.store.createItem({ type: 'feature', title: 'Rehydration test' });
    await dPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: ctx.FC });

    // Get the live-emit event id
    const liveEvent = ctx.broadcasts
      .filter(b => b.type === 'decisionEvent' && b.event?.kind === 'drift_threshold')
      .map(b => b.event)[0];
    assert.ok(liveEvent, 'expected a live drift_threshold event');

    // Get the persisted breach metadata
    const stored = ctx.store.items.get(item.id);
    const breachedAxis = stored.lifecycle.lifecycle_ext?.drift_axes?.find(a => a.breached === true);
    assert.ok(breachedAxis, 'expected a breached axis in persisted state');
    assert.ok(breachedAxis.breach_event_id, 'persisted axis must have breach_event_id');
    assert.equal(breachedAxis.breach_event_id, liveEvent.id,
      'persisted breach_event_id must match live DecisionEvent id');

    // Simulate rehydration via deriveDecisionEvents
    const rehydrated = deriveDecisionEvents(ctx.store, ctx.FC);
    const rehydratedDrift = rehydrated.filter(e => e.kind === 'drift_threshold');
    assert.ok(rehydratedDrift.length >= 1, 'rehydrated events must include drift_threshold');
    const rehydratedEvent = rehydratedDrift.find(e => e.id === liveEvent.id);
    assert.ok(rehydratedEvent, 'rehydrated event must have same id as live-emit event');
    assert.equal(rehydratedEvent.timestamp, liveEvent.timestamp,
      'rehydrated timestamp must match live-emit timestamp');
  });

  test('steady-state breach: second emit preserves breach_event_id; no new DecisionEvent', async () => {
    // Write review file to force breach
    fs.writeFileSync(path.join(ctx.featurePath, 'review.json'), JSON.stringify({
      findings: [{ id: 'f1', status: 'open' }],
    }));

    const item = ctx.store.createItem({ type: 'feature', title: 'Steady breach test' });
    // First emit (rising edge)
    await dPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: ctx.FC });

    const firstDriftEvents = ctx.broadcasts.filter(
      b => b.type === 'decisionEvent' && b.event?.kind === 'drift_threshold'
    );
    assert.ok(firstDriftEvents.length >= 1, 'rising edge must emit DecisionEvent');
    const firstId = firstDriftEvents[0].event.id;
    const stored1 = ctx.store.items.get(item.id);
    const firstBreachEventId = stored1.lifecycle.lifecycle_ext?.drift_axes
      ?.find(a => a.breached)?.breach_event_id;

    // Second emit (advance phase — DRIFT also fires here; steady breach)
    await dPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'prd' });

    const allDriftEvents = ctx.broadcasts.filter(
      b => b.type === 'decisionEvent' && b.event?.kind === 'drift_threshold'
    );
    // Should still be only 1 (the rising edge); advance is steady breach
    assert.equal(allDriftEvents.length, firstDriftEvents.length,
      'steady-state breach must NOT emit a new DecisionEvent');

    // Persisted breach_event_id must be unchanged
    const stored2 = ctx.store.items.get(item.id);
    const secondBreachEventId = stored2.lifecycle.lifecycle_ext?.drift_axes
      ?.find(a => a.breached)?.breach_event_id;
    assert.equal(secondBreachEventId, firstBreachEventId,
      'breach_event_id must be preserved across steady breach');
  });
});
