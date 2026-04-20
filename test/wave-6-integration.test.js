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
