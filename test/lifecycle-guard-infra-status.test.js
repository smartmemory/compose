/**
 * A guard that never answered is not a guard that said no.
 *
 * For two months a timed-out `guard transition` reached the user as HTTP 422
 * "transition refused by guard" (stratum-client.js, f7865d4): an infrastructure
 * failure reported as a rejection of their evidence. The route now splits the
 * two. These tests drive the REAL route and the REAL guardedTransition; only
 * the stratum subprocess client is substituted, with the exact envelopes
 * stratum-client.js produces.
 */
import { test, after } from 'node:test';
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
const { _testOnly_setGuardClient, _testOnly_resetGuardCache, _testOnly_setStatusWriter, _testOnly_resetStatusWriter } =
  await import(`${REPO_ROOT}/server/lifecycle-guard.js`);

function req(port, method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (rs) => { let b = ''; rs.on('data', c => b += c); rs.on('end', () => res({ status: rs.statusCode, body: JSON.parse(b) })); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const servers = [];
after(() => { for (const s of servers) s.close(); _testOnly_resetStatusWriter(); });

async function appWithGuardAnswering(transitionResult, { phase = 'explore_design' } = {}) {
  _testOnly_resetGuardCache();
  _testOnly_setStatusWriter(async () => {});
  _testOnly_setGuardClient({
    register: async () => ({ status: 'registered', checksum: 'c', guard_id: 'g' }),
    policy: async () => ({ status: 'ok' }),
    transition: async () => transitionResult,
  });
  const tmp = mkdtempSync(join(tmpdir(), 'lg-infra-'));
  mkdirSync(join(tmp, 'data'), { recursive: true });
  const store = new VisionStore(join(tmp, 'data'));
  const item = store.createItem({ type: 'feature', title: 'infra' });
  store.updateLifecycle(item.id, { currentPhase: phase, featureCode: 'INFRA-1', startedAt: new Date().toISOString() });
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, { store, scheduleBroadcast: () => {}, broadcastMessage: () => {}, projectRoot: tmp, capabilities: { guard: true, guardAuth: false } });
  const s = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); servers.push(s); });
  return { port: s.address().port, item, store };
}

// The exact envelope runGuard returns on a timed-out subprocess.
const TIMED_OUT = { error: { code: 'TIMEOUT', message: 'Stratum guard timed out', detail: 'exit=-1 stdout=<empty>' } };
// The exact envelope on a genuine refusal (exit 0, status refused).
const REFUSED = { status: 'refused', verdict: { met: false, unmet: ['design.md absent'] } };

// `skip` needs a skippable phase (build mode: prd → blueprint); `advance` any edge.
for (const [route, phase] of [['advance', 'explore_design'], ['skip', 'prd']]) {
  test(`${route}: a guard TIMEOUT is 503 "guard unavailable", never a refusal`, async () => {
    const { port, item, store } = await appWithGuardAnswering(TIMED_OUT, { phase });
    const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/${route}`, { targetPhase: 'blueprint' });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, 'guard unavailable');
    assert.equal(r.body.guardError.code, 'TIMEOUT');
    assert.notEqual(r.body.error, 'transition refused by guard');
    assert.equal(store.items.get(item.id).lifecycle.currentPhase, phase, 'still fail-closed: no mutation');
  });

  test(`${route}: a genuine refusal is still 422 "transition refused by guard"`, async () => {
    const { port, item, store } = await appWithGuardAnswering(REFUSED, { phase });
    const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/${route}`, { targetPhase: 'blueprint' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error, 'transition refused by guard');
    assert.deepEqual(r.body.verdict, REFUSED.verdict, 'the verdict travels with a refusal');
    assert.equal(store.items.get(item.id).lifecycle.currentPhase, phase);
  });
}

for (const code of ['SPAWN', 'GUARD_UNREACHABLE', 'PARSE_ERROR', 'UNKNOWN']) {
  test(`advance: guard error ${code} is infrastructure, 503`, async () => {
    const { port, item } = await appWithGuardAnswering({ error: { code, message: `m:${code}`, detail: '' } });
    const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.guardError.code, code);
  });
}

test('advance: a policy-level guard error (guard ran, could not apply) stays 422', async () => {
  const { port, item } = await appWithGuardAnswering({ status: 'error', error_type: 'policy_checksum_mismatch', message: 'stale' });
  const r = await req(port, 'POST', `/api/vision/items/${item.id}/lifecycle/advance`, { targetPhase: 'blueprint' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error, 'transition refused by guard');
});
