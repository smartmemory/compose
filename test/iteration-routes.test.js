/**
 * iteration-routes.test.js — Integration tests for iteration orchestration REST endpoints.
 *
 * Tests: start loop, report results (clean/dirty/max), abort, conflict handling.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { SettingsStore } = await import(`${REPO_ROOT}/server/settings-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { loadSchema } = await import(`${REPO_ROOT}/server/schema-validator.js`);

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'iter-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmpDir, 'docs', 'features', 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const settingsStore = new SettingsStore(dataDir, {
    phases: [{ id: 'execute', defaultPolicy: null }],
    iterationDefaults: { review: { maxIterations: 4 }, coverage: { maxIterations: 15 } },
    policyModes: ['gate', 'flag', 'skip'],
  });

  // Create item with lifecycle
  const item = store.createItem({ type: 'feature', title: 'Iteration Test' });
  store.updateLifecycle(item.id, {
    featureCode: 'TEST-1',
    currentPhase: 'execute',
    startedAt: new Date().toISOString(),
  });

  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmpDir,
    settingsStore,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ tmpDir, store, item, server, port, broadcasts });
    });
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('iteration routes', () => {
  let ctx;

  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => { ctx.server.close(); rmSync(ctx.tmpDir, { recursive: true, force: true }); });

  test('start review loop', async () => {
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    assert.equal(res.status, 200);
    assert.equal(res.body.loopType, 'review');
    assert.equal(res.body.status, 'running');
    assert.equal(res.body.count, 0);
    assert.equal(res.body.maxIterations, 2); // settings say 4, the standard review cap is 2
    assert.equal(res.body.capped_from, 4);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationStarted'));
  });

  test('start with invalid loopType returns 400', async () => {
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'invalid' });
    assert.equal(res.status, 400);
  });

  test('start while loop running returns 409', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    assert.equal(res.status, 409);
  });

  test('report clean result completes loop', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, {
      result: { clean: true, summary: 'All good', findings: [] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.continue, false);
    assert.equal(res.body.outcome, 'clean');
    assert.equal(res.body.count, 1);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationComplete' && b.outcome === 'clean'));
  });

  test('report dirty result continues loop', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, {
      result: { clean: false, summary: 'Issues found', findings: [{ severity: 'LOW', class: 'naming', title: 'bug1' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.continue, true);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.outcome, null);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationUpdate'));
  });

  test('report past max iterations returns max_reached', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review', maxIterations: 2 });
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: false } });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: false } });
    assert.equal(res.status, 200);
    assert.equal(res.body.continue, false);
    assert.equal(res.body.outcome, 'max_reached');
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationComplete' && b.outcome === 'max_reached'));
  });

  test('abort running loop', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'coverage' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/abort`, { reason: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.body.aborted, true);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationComplete' && b.outcome === 'aborted'));
  });

  test('report on completed loop returns 409', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: true } });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: true } });
    assert.equal(res.status, 409);
  });

  test('coverage loop uses passing exit criteria', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'coverage' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, {
      result: { passing: true, summary: 'All tests pass', failures: [] },
    });
    assert.equal(res.body.continue, false);
    assert.equal(res.body.outcome, 'clean');
  });

  // COMP-DOGFOOD-REVIEW-LOOP-1 (review-loop.md:6 and :8)
  describe('round cap, finding class, redesign stop', () => {
    const url = (c, leaf) => `/api/vision/items/${c.item.id}/lifecycle/iteration/${leaf}`;
    const start = (c, body) => post(c.port, url(c, 'start'), { loopType: 'review', ...body });
    const report = (c, findings) => post(c.port, url(c, 'report'), { result: { clean: false, findings } });
    const stateOf = (c) => c.store.items.get(c.item.id).lifecycle.iterationState;

    // SEC-CONTROL-SECRETS-1: the two Codex reviews, titles verbatim (review-r1.md:23, review-r2.md:18).
    // alternatives-r2.md:6 names the class: "M1 again, same class"; the reviews carried no class line,
    // so it is supplied by hand as a reviewer would under the new rule.
    const R1 = { severity: 'MEDIUM', class: 'secret-redaction-heuristic', title: 'the new word heuristic leaks a long mixed base64 key, even with an explicit secret name' };
    const R2 = { severity: 'MEDIUM', class: 'secret-redaction-heuristic', title: 'word allowances still admit random base64 keys, including the original shape family' };

    test('SEC-CONTROL-SECRETS-1 replay: same class in round 2 needs a redesign and refuses round 3', async () => {
      await start(ctx, { tier: 'security' });
      const r1 = await report(ctx, [R1]);
      assert.equal(r1.body.continue, true);
      const r2 = await report(ctx, [R2]);
      assert.equal(r2.status, 200);
      assert.equal(r2.body.continue, false);
      assert.equal(r2.body.outcome, 'same_class');
      assert.equal(r2.body.needs_redesign, true);
      assert.deepEqual(r2.body.class, ['secret-redaction-heuristic']);
      assert.match(r2.body.reason, /review-loop\.md:8/);
      assert.equal(stateOf(ctx).needs_redesign, true);
      const r3 = await report(ctx, [R2]);
      assert.equal(r3.status, 409);
      assert.equal(r3.body.code, 'NEEDS_REDESIGN');
      assert.equal(stateOf(ctx).count, 2, 'a refused round writes nothing');
      // the stored state matches the contract
      const { ajv, schema } = loadSchema(join(REPO_ROOT, 'contracts', 'iteration-loop.schema.json'));
      const ok = ajv.getSchema(`${schema.$id}#/definitions/loopState`);
      assert.ok(ok(stateOf(ctx)), JSON.stringify(ok.errors));
    });

    test('bounded with maxIterations 2 is refused; settings 4 gives cap 2 and capped_from 4', async () => {
      const bad = await start(ctx, { tier: 'bounded', maxIterations: 2 });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'ROUND_CAP_EXCEEDED');
      assert.match(bad.body.error, /review-loop\.md:6/);
      assert.equal(ctx.store.items.get(ctx.item.id).lifecycle.iterationState, undefined, 'a refused start writes nothing');
      const ok = await start(ctx, {});
      assert.equal(ok.status, 200);
      assert.equal(ok.body.cap, 2);
      assert.equal(ok.body.maxIterations, 2);
      assert.equal(ok.body.capped_from, 4);
      assert.equal(ok.body.tier, 'standard');
    });

    test('a coverage loop keeps today\'s behaviour', async () => {
      const res = await post(ctx.port, url(ctx, 'start'), { loopType: 'coverage' });
      assert.equal(res.body.maxIterations, 15);
      assert.equal(res.body.cap, undefined);
    });

    test('a MEDIUM or HIGH with no class is refused and writes nothing', async () => {
      await start(ctx, {});
      for (const severity of ['MEDIUM', 'HIGH']) {
        const res = await report(ctx, [{ severity, title: 'no class' }]);
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'FINDING_CLASS_REQUIRED');
      }
      assert.equal(stateOf(ctx).count, 0);
      const low = await report(ctx, [{ severity: 'LOW', title: 'nit' }]);
      assert.equal(low.status, 200);
    });

    test('security tier: round 2 with a new-class HIGH is allowed round 3, once', async () => {
      await start(ctx, { tier: 'security' });
      await report(ctx, [{ severity: 'MEDIUM', class: 'a' }]);
      const r2 = await report(ctx, [{ severity: 'HIGH', class: 'b' }]);
      assert.equal(r2.body.continue, true);
      assert.match(r2.body.reason, /3rd round allowed/);
      assert.equal(r2.body.maxIterations, 3);
      const r3 = await report(ctx, [{ severity: 'HIGH', class: 'c' }]);
      assert.equal(r3.body.continue, false);
      assert.equal(r3.body.outcome, 'max_reached');
    });

    test('security tier: round 2 with a repeated class gets no round 3; a non-security tier gets none either', async () => {
      await start(ctx, { tier: 'security' });
      await report(ctx, [{ severity: 'HIGH', class: 'a' }]);
      const r2 = await report(ctx, [{ severity: 'HIGH', class: ' A ' }]);
      assert.equal(r2.body.continue, false);
      assert.equal(r2.body.outcome, 'same_class');
      await post(ctx.port, url(ctx, 'abort'), { reason: 'x', redesign_note: 'docs/features/TEST-1/note.md' });
      writeFileSync(join(ctx.tmpDir, 'docs', 'features', 'TEST-1', 'note.md'), 'alt');
      await post(ctx.port, url(ctx, 'abort'), { redesign_note: 'docs/features/TEST-1/note.md' });
      await start(ctx, { tier: 'standard' });
      await report(ctx, [{ severity: 'MEDIUM', class: 'a' }]);
      const s2 = await report(ctx, [{ severity: 'HIGH', class: 'b' }]);
      assert.equal(s2.body.outcome, 'max_reached');
    });

    test('abort on a needs_redesign loop needs an existing in-repo note; the reason is stored', async () => {
      await start(ctx, {});
      await report(ctx, [{ severity: 'MEDIUM', class: 'a' }]);
      await report(ctx, [{ severity: 'MEDIUM', class: 'a' }]);
      for (const body of [{ reason: 'x' }, { redesign_note: 'docs/features/TEST-1/missing.md' }, { redesign_note: '../../etc/hosts' }]) {
        const res = await post(ctx.port, url(ctx, 'abort'), body);
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'REDESIGN_NOTE_REQUIRED');
      }
      assert.equal(stateOf(ctx).status, 'running');
      writeFileSync(join(ctx.tmpDir, 'docs', 'features', 'TEST-1', 'alternatives.md'), 'half a page');
      const ok = await post(ctx.port, url(ctx, 'abort'), { reason: 'same class twice', redesign_note: 'docs/features/TEST-1/alternatives.md' });
      assert.equal(ok.status, 200);
      assert.equal(stateOf(ctx).abort_reason, 'same class twice');
      assert.equal(stateOf(ctx).redesign_note, 'docs/features/TEST-1/alternatives.md');
      assert.equal(stateOf(ctx).outcome, 'aborted');
    });

    test('a plain abort stores its reason', async () => {
      await start(ctx, {});
      const ok = await post(ctx.port, url(ctx, 'abort'), { reason: 'owner changed scope' });
      assert.equal(ok.status, 200);
      assert.equal(stateOf(ctx).abort_reason, 'owner changed scope');
    });
  });
});
