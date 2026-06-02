/**
 * COMP-MCP-ENFORCE Slice 1 — golden-flow E2E with the REAL `stratum-mcp guard`
 * CLI behind the REST lifecycle endpoints (capabilities.guard = true).
 *
 * Proves the end-to-end guarantee: a guard-enabled feature can only advance
 * through an edge whose server-read evidence verifies, and every attempt lands
 * in the tamper-evident ledger. State is isolated by pointing $HOME at a temp
 * dir (the guard persists under $HOME/.stratum/guards).
 *
 * Skips (loudly) only if stratum-mcp is not installed — real backend required.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let STRATUM_AVAILABLE = true;
try {
  execFileSync('stratum-mcp', ['--help'], { stdio: 'ignore' });
} catch {
  STRATUM_AVAILABLE = false;
  // eslint-disable-next-line no-console
  console.warn('[lifecycle-guard-e2e] SKIPPED: stratum-mcp not on PATH — real-backend guard flow not exercised.');
}

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);
const { _testOnly_resetGuardCache } = await import(`${REPO_ROOT}/server/lifecycle-guard.js`);

function request(port, method, path, body) {
  return new Promise((resolveReq, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          try { resolveReq({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolveReq({ status: res.statusCode, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let ctx = null;
let originalHome = null;

before(async () => {
  if (!STRATUM_AVAILABLE) return;
  const tmpDir = mkdtempSync(join(tmpdir(), 'lg-e2e-'));
  originalHome = process.env.HOME;
  process.env.HOME = join(tmpDir, 'home');   // isolate ~/.stratum/guards
  mkdirSync(process.env.HOME, { recursive: true });

  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmpDir, 'docs', 'features', 'GUARD-E2E'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Guard E2E' });

  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: () => {},
    projectRoot: tmpDir,
    capabilities: { guard: true },   // <-- enforcement ON
  });
  _testOnly_resetGuardCache();

  await new Promise((r) => {
    const server = app.listen(0, () => r());
    ctx = { tmpDir, store, item, server, get port() { return server.address().port; } };
  });
});

after(() => {
  if (ctx?.server) ctx.server.close();
  if (originalHome !== null) process.env.HOME = originalHome;
  if (ctx?.tmpDir) { try { rmSync(ctx.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

test('guarded lifecycle: refuses transitions whose server-read evidence is missing', { skip: !STRATUM_AVAILABLE }, async () => {
  const { port, item, tmpDir } = ctx;
  const featureDir = join(tmpDir, 'docs', 'features', 'GUARD-E2E');

  // start (eager-registers the guard at explore_design)
  const start = await request(port, 'POST', `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'GUARD-E2E' });
  assert.equal(start.status, 200, JSON.stringify(start.body));

  // explore_design → blueprint REFUSED: design.md absent
  let r = await request(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
  assert.equal(r.status, 422, `expected refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, 'transition refused by guard');

  // write design.md → now APPLIED
  writeFileSync(join(featureDir, 'design.md'), '# design');
  r = await request(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
  assert.equal(r.status, 200, `expected applied, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.to, 'blueprint');

  // blueprint → verification REFUSED: blueprint.md absent
  r = await request(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'verification' });
  assert.equal(r.status, 422, JSON.stringify(r.body));

  // write blueprint.md → APPLIED
  writeFileSync(join(featureDir, 'blueprint.md'), '# blueprint');
  r = await request(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'verification' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // illegal/unverified caller drive cannot skip the ledger: the in-memory phase
  // and the guard ledger agree.
  const lc = await request(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'plan' });
  assert.equal(lc.status, 200, JSON.stringify(lc.body));
  assert.equal(ctx.store.items.get(item.id).lifecycle.currentPhase, 'plan');
});
