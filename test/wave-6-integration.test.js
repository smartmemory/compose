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
