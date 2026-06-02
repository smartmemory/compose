/**
 * COMP-MCP-ENFORCE Slice 4 — opt-in loopback REST auth on the guarded lifecycle
 * mutation endpoints. Default OFF (the frontend does not yet send the token, so
 * forcing it would break the cockpit). When capabilities.guardAuth is true AND
 * COMPOSE_API_TOKEN is set, the mutation endpoints require x-compose-token —
 * defense-in-depth on top of the guard for headless/CI surfaces.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

function req(port, method, path, body, headers = {}) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (rs) => { let b = ''; rs.on('data', c => b += c); rs.on('end', () => { try { res({ status: rs.statusCode, body: JSON.parse(b) }); } catch { res({ status: rs.statusCode, body: b }); } }); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

function makeApp(capabilities) {
  const tmp = mkdtempSync(join(tmpdir(), 'lg-auth-'));
  mkdirSync(join(tmp, 'data'), { recursive: true });
  const store = new VisionStore(join(tmp, 'data'));
  const item = store.createItem({ type: 'feature', title: 'auth test' });
  // give it a lifecycle so advance reaches past the 404
  store.updateLifecycle(item.id, { currentPhase: 'explore_design', featureCode: 'AUTH-1', startedAt: new Date().toISOString() });
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, { store, scheduleBroadcast: () => {}, broadcastMessage: () => {}, projectRoot: tmp, capabilities });
  return { app, item };
}

let servers = [];
function listen(app) {
  return new Promise((res) => { const s = app.listen(0, () => res(s)); servers.push(s); });
}

const prevToken = process.env.COMPOSE_API_TOKEN;
before(() => { process.env.COMPOSE_API_TOKEN = 'tok-123'; });
after(() => {
  for (const s of servers) s.close();
  if (prevToken === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = prevToken;
});

test('guardAuth OFF: lifecycle mutation needs no token (legacy)', async () => {
  const { app, item } = makeApp({ guard: false, guardAuth: false });
  const s = await listen(app);
  const { port } = s.address();
  const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
  assert.notEqual(r.status, 401, 'no auth required when guardAuth off');
});

test('guardAuth ON: mutation without token → 401', async () => {
  const { app, item } = makeApp({ guard: false, guardAuth: true });
  const s = await listen(app);
  const { port } = s.address();
  const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
  assert.equal(r.status, 401, JSON.stringify(r.body));
});

test('guardAuth ON: mutation WITH valid token → not 401', async () => {
  const { app, item } = makeApp({ guard: false, guardAuth: true });
  const s = await listen(app);
  const { port } = s.address();
  const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' }, { 'x-compose-token': 'tok-123' });
  assert.notEqual(r.status, 401, JSON.stringify(r.body));
});

test('guardAuth ON: a READ endpoint is not gated (only mutations)', async () => {
  const { app, item } = makeApp({ guard: false, guardAuth: true });
  const s = await listen(app);
  const { port } = s.address();
  const r = await req(port, 'GET', `/api/vision/items/${item.id}/lifecycle`);
  assert.notEqual(r.status, 401, 'reads stay open');
});

test('guardAuth ON: PATCH item (status mutation) is gated', async () => {
  const { app, item } = makeApp({ guard: false, guardAuth: true });
  const s = await listen(app);
  const { port } = s.address();
  const noTok = await req(port, 'PATCH', `/api/vision/items/${item.id}`, { status: 'complete' });
  assert.equal(noTok.status, 401);
  const withTok = await req(port, 'PATCH', `/api/vision/items/${item.id}`, { confidence: 5 }, { 'x-compose-token': 'tok-123' });
  assert.notEqual(withTok.status, 401);
});

test('guardAuth ON: iteration/start is gated', async () => {
  const { app, item } = makeApp({ guard: false, guardAuth: true });
  const s = await listen(app);
  const { port } = s.address();
  const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/iteration/start`, { type: 'review' });
  assert.equal(r.status, 401);
});

test('guardAuth ON but COMPOSE_API_TOKEN unset → 503 fail-closed (not open)', async () => {
  const prev = process.env.COMPOSE_API_TOKEN;
  delete process.env.COMPOSE_API_TOKEN;
  try {
    const { app, item } = makeApp({ guard: false, guardAuth: true });
    const s = await listen(app);
    const { port } = s.address();
    const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
    assert.equal(r.status, 503, 'misconfigured auth disables mutations, never opens them');
  } finally {
    process.env.COMPOSE_API_TOKEN = prev;
  }
});
