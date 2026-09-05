import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${ROOT}/server/vision-routes.js`);

function request(port, path, body) {
  const data = JSON.stringify(body ?? {});
  return new Promise((resolveRequest, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
    } }, (res) => {
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolveRequest({ status: res.statusCode, body: JSON.parse(out) }));
    });
    req.on('error', reject); req.end(data);
  });
}

async function setup({ guard = false, guardAuth = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'backfill-route-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  writeFileSync(join(root, 'README.md'), 'fixture\n'); git('add', '-A'); git('commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD').trim();
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'BF-ROUTE-1'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({
    paths: { features: 'docs/features' }, capabilities: { guard, guardAuth },
  }));
  writeFileSync(join(root, 'docs', 'features', 'BF-ROUTE-1', 'feature.json'), JSON.stringify({
    code: 'BF-ROUTE-1', description: 'fixture', phase: 'P', status: 'PLANNED',
  }));
  const store = new VisionStore(join(root, '.compose', 'data'));
  const item = store.createItem({ type: 'feature', title: 'BF route', status: 'in_progress' });
  const now = new Date().toISOString();
  store.updateLifecycle(item.id, {
    featureCode: 'BF-ROUTE-1', mode: 'build', currentPhase: 'explore_design', startedAt: now,
    phaseHistory: [{ phase: 'explore_design', step: 'explore_design', enteredAt: now, exitedAt: null,
      from: null, to: 'explore_design', outcome: null, timestamp: now }],
  });
  const app = express(); app.use(express.json());
  const broadcasts = [];
  let scheduled = 0;
  attachVisionRoutes(app, {
    store, projectRoot: root, capabilities: { guard, guardAuth },
    scheduleBroadcast: () => { scheduled += 1; }, broadcastMessage: (message) => { broadcasts.push(message); },
  });
  const server = await new Promise((resolveServer, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolveServer(s));
    s.once('error', reject);
  });
  return { root, sha, store, item, server, port: server.address().port, broadcasts, scheduled: () => scheduled };
}

function failNthSave(store, n) {
  const real = store._save.bind(store);
  let calls = 0;
  store._save = (...args) => {
    calls += 1;
    return calls === n ? false : real(...args);
  };
  return () => { store._save = real; };
}

function markerCli(root) {
  const marker = join(root, 'stratum-was-spawned');
  const script = join(root, 'never-run.cjs');
  writeFileSync(script, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nprocess.exit(1);\n`);
  chmodSync(script, 0o755);
  return { marker, script };
}

describe('POST /api/vision/items/:id/lifecycle/backfill', () => {
  let ctx;
  // describe-level hooks ALSO fire for nested t.test subtests, so a test with
  // subtests gets several setups; track every one or the overwritten servers
  // leak and keep the process alive past the suite.
  const opened = [];
  beforeEach(async () => { ctx = await setup(); opened.push(ctx); });
  afterEach(() => {
    for (const c of opened.splice(0)) { c.server.close(); rmSync(c.root, { recursive: true, force: true }); }
    ctx = undefined;
  });

  test('returns 404 for missing items or missing lifecycle', async () => {
    const missing = await request(ctx.port, '/api/vision/items/nope/lifecycle/backfill', {});
    assert.equal(missing.status, 404);
    const plain = ctx.store.createItem({ type: 'feature', title: 'plain' });
    const noLifecycle = await request(ctx.port, `/api/vision/items/${plain.id}/lifecycle/backfill`, {});
    assert.equal(noLifecycle.status, 404);
  });

  test('requires a non-blank reason', async () => {
    const r = await request(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/backfill`, { reason: '  ' });
    assert.equal(r.status, 400);
  });

  test('echoes the gate refusal taxonomy as 422', async () => {
    const item = ctx.store.items.get(ctx.item.id);
    item.lifecycle.currentPhase = 'complete_backfilled';
    const r = await request(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/backfill`, {
      commit_sha: ctx.sha, tests_pass: true, files_changed: [], reason: 'retry a terminal lifecycle', occurrences: [],
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.refusedAt, 'guard');
    assert.ok(Array.isArray(r.body.reasons));
  });

  test('uses the lifecycle mutation auth guard', async () => {
    const guarded = await setup({ guardAuth: true });
    try {
      const r = await request(guarded.port, `/api/vision/items/${guarded.item.id}/lifecycle/backfill`, {
        commit_sha: guarded.sha, tests_pass: true, files_changed: [], reason: 'requires auth', occurrences: [],
      });
      assert.equal(r.status, 503);
    } finally {
      guarded.server.close();
      rmSync(guarded.root, { recursive: true, force: true });
    }
  });

  test('is reachable from a non-completable phase and lets the gate write the terminal lifecycle', async () => {
    const r = await request(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/backfill`, {
      commit_sha: ctx.sha, tests_pass: true, files_changed: [], reason: 'lifecycle adopted late', occurrences: [],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ctx.store.items.get(ctx.item.id).lifecycle.currentPhase, 'complete_backfilled');
    assert.ok(ctx.store.items.get(ctx.item.id).lifecycle.completedAt);
  });

  test('a finalized retry returns its record without new route events or a checkpoint', async () => {
    const { getTargetRoot, switchProject } = await import('../server/project-root.js');
    const priorTarget = getTargetRoot();
    switchProject(ctx.root);
    try {
      const body = { commit_sha: ctx.sha, tests_pass: true, files_changed: [], reason: 'lifecycle adopted late', occurrences: [] };
      const first = await request(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/backfill`, body);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.status, 'finalized');
      const checkpoint = join(ctx.root, '.compose', 'data', 'checkpoints-BF-ROUTE-1.jsonl');
      const checkpointsBefore = existsSync(checkpoint) ? readFileSync(checkpoint, 'utf8').trim().split('\n').length : 0;
      const eventsBefore = ctx.broadcasts.length;
      const scheduledBefore = ctx.scheduled();

      const second = await request(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/backfill`, body);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.status, 'finalized');
      assert.equal(second.body.replayed, true);
      assert.deepEqual(second.body.backfill, first.body.backfill);
      assert.equal(ctx.broadcasts.length, eventsBefore, 'a finalized replay emits no route events');
      assert.equal(ctx.scheduled(), scheduledBefore, 'a finalized replay schedules no broadcast');
      const checkpointsAfter = existsSync(checkpoint) ? readFileSync(checkpoint, 'utf8').trim().split('\n').length : 0;
      assert.equal(checkpointsAfter, checkpointsBefore, 'a finalized replay writes no checkpoint');
    } finally {
      switchProject(priorTarget);
    }
  });

  test('uses the persisted guard flag for both crash-then-retry projection directions', async (t) => {
    const { _testOnly_resetGuardCache, resourceId } = await import('../server/lifecycle-guard.js');
    const { guardHistory } = await import('../server/stratum-client.js');
    const savedHome = process.env.HOME;
    const savedCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
    const home = mkdtempSync(join(tmpdir(), 'backfill-route-home-'));
    process.env.HOME = home;
    t.after(() => {
      _testOnly_resetGuardCache();
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedCli === undefined) delete process.env.COMPOSE_STRATUM_TS_CLI_BIN;
      else process.env.COMPOSE_STRATUM_TS_CLI_BIN = savedCli;
      rmSync(home, { recursive: true, force: true });
    });
    const body = (sha) => ({ commit_sha: sha, tests_pass: true, files_changed: [], reason: 'crash then retry', occurrences: [] });

    await t.test('guard on at persistence remains consulted after config flips off', async (st) => {
      const guarded = await setup({ guard: true });
      // Register on the SUBTEST context: a hook registered on the parent from inside a subtest never runs, leaking the server.
      st.after(() => { guarded.server.close(); rmSync(guarded.root, { recursive: true, force: true }); });
      _testOnly_resetGuardCache();
      const restore = failNthSave(guarded.store, 2);
      let first;
      try { first = await request(guarded.port, `/api/vision/items/${guarded.item.id}/lifecycle/backfill`, body(guarded.sha)); } finally { restore(); }
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.status, 'pending');
      const intentPath = join(guarded.root, '.compose', 'data', 'completion-intents', 'BF-ROUTE-1.json');
      assert.equal(JSON.parse(readFileSync(intentPath, 'utf8')).guarded, true);
      const configPath = join(guarded.root, '.compose', 'compose.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.capabilities.guard = false;
      writeFileSync(configPath, JSON.stringify(config));

      const retry = await request(guarded.port, `/api/vision/items/${guarded.item.id}/lifecycle/backfill`, body(guarded.sha));
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.guarded, true);
      assert.equal(guarded.store.items.get(guarded.item.id).completion_projection.verified_by, 'guarded');
    });

    await t.test('guard off at persistence stays process-free after config flips on', async (st) => {
      const unguarded = await setup({ guard: false });
      st.after(() => { unguarded.server.close(); rmSync(unguarded.root, { recursive: true, force: true }); });
      const restore = failNthSave(unguarded.store, 2);
      let first;
      try { first = await request(unguarded.port, `/api/vision/items/${unguarded.item.id}/lifecycle/backfill`, body(unguarded.sha)); } finally { restore(); }
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.status, 'pending');
      const configPath = join(unguarded.root, '.compose', 'compose.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.capabilities.guard = true;
      writeFileSync(configPath, JSON.stringify(config));

      const { marker, script } = markerCli(unguarded.root);
      process.env.COMPOSE_STRATUM_TS_CLI_BIN = script;
      await guardHistory(resourceId('BF-ROUTE-1', unguarded.root, 'build'));
      assert.equal(existsSync(marker), true, 'the marker CLI must prove it can observe a guard spawn');
      unlinkSync(marker);

      const retry = await request(unguarded.port, `/api/vision/items/${unguarded.item.id}/lifecycle/backfill`, body(unguarded.sha));
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.guarded, false);
      assert.equal(existsSync(marker), false, 'the persisted guard-off retry must spawn no stratum process');
      assert.equal(unguarded.store.items.get(unguarded.item.id).completion_projection.verified_by, 'canonical-status-only');
    });
  });
});
