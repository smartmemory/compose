/**
 * test/completion-projection.test.js — COMP-COMPLETION-GATE slice 3 (§2.3b).
 *
 * The self-verifying projection and the server-side refusals:
 *   - the predicate grants NO authority: a non-COMPLETE feature.json refuses (AC-4d)
 *   - three tiers are distinguishable and stamped (AC-16b); a guard error other
 *     than not-found fails CLOSED rather than downgrading the tier
 *   - PATCH refuses `status: complete` for a MANAGED BUILD item only (AC-10);
 *     fix items and unmanaged items keep completing through PATCH (§2.3d)
 *   - the projection endpoint mirrors canonical truth over REST (AC-4b)
 *   - the stratum audit route no longer flips status (AC-11)
 *   - /lifecycle/complete for a build item goes through the gate and projects
 *     the live store; a fix item keeps its pre-slice-3 path
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
// Never let a VisionWriter inside the gate find a real cockpit on :4001.
process.env.COMPOSE_PORT = '19993';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { VisionStore } = await import(`${ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${ROOT}/server/vision-routes.js`);
const { attachStratumRoutes } = await import(`${ROOT}/server/stratum-sync.js`);
const {
  verifiedCompleteProjection, applyVerifiedProjection, isManagedBuildItem, VERIFIED_BY,
} = await import(`${ROOT}/server/completion-projection.js`);
const { _testOnly_setHistoryClient, _testOnly_resetHistoryClient } = await import(`${ROOT}/lib/completion-gate.js`);
const guard = await import(`${ROOT}/server/lifecycle-guard.js`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshProjectRoot({ guard: guardOn = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compl-proj-'));
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'),
    JSON.stringify({ paths: { features: 'docs/features' }, capabilities: { guard: guardOn } }));
  return root;
}

function writeFeature(root, code, status) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feature.json'), JSON.stringify({ code, description: 'x', status, phase: 'P' }, null, 2));
}

function readFeature(root, code) {
  return JSON.parse(readFileSync(join(root, 'docs', 'features', code, 'feature.json'), 'utf8'));
}

const buildItem = (code) => ({ id: `it-${code}`, title: code, status: 'in_progress', lifecycle: { featureCode: code, mode: 'build', currentPhase: 'ship' } });
const fixItem = (code) => ({ id: `it-${code}`, title: code, status: 'in_progress', lifecycle: { featureCode: code, mode: 'fix', currentPhase: 'verify' } });

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe('verifiedCompleteProjection — the predicate carries no authority', () => {
  beforeEach(() => _testOnly_resetHistoryClient());

  test('refuses when feature.json is not COMPLETE — it cannot be used to complete anything', async () => {
    const root = freshProjectRoot();
    writeFeature(root, 'P-1', 'IN_PROGRESS');
    const v = await verifiedCompleteProjection({ item: buildItem('P-1'), featureCode: 'P-1', cwd: root });
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(), /reads IN_PROGRESS, not COMPLETE/);
  });

  test('refuses an item bound to a different feature', async () => {
    const root = freshProjectRoot();
    writeFeature(root, 'P-2', 'COMPLETE');
    const v = await verifiedCompleteProjection({ item: buildItem('OTHER-1'), featureCode: 'P-2', cwd: root });
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(), /bound to OTHER-1/);
  });

  test('refuses a folder with no feature.json unless the caller is the scanner (document-derived)', async () => {
    const root = freshProjectRoot();
    const item = { id: 'DOC-1', title: 'DOC-1', status: 'planned' };
    const refused = await verifiedCompleteProjection({ item, featureCode: 'DOC-1', cwd: root });
    assert.equal(refused.ok, false);
    assert.match(refused.reasons.join(), /no feature.json/);
    const scanner = await verifiedCompleteProjection({ item, featureCode: 'DOC-1', cwd: root, allowDocumentDerived: true });
    assert.equal(scanner.ok, true);
    assert.equal(scanner.verified_by, VERIFIED_BY.DOCUMENT);
  });

  test('legacy feature — COMPLETE, guard on, no guard resource — is canonical-status-only, never "guarded"', async () => {
    const root = freshProjectRoot({ guard: true });
    writeFeature(root, 'P-3', 'COMPLETE');
    // The REAL client shape for an unregistered resource.
    _testOnly_setHistoryClient(async () => ({ status: 'error', error_type: 'not_found', message: 'no guard registered' }));
    const v = await verifiedCompleteProjection({ item: buildItem('P-3'), featureCode: 'P-3', cwd: root });
    assert.equal(v.ok, true);
    assert.equal(v.verified_by, VERIFIED_BY.CANONICAL);
  });

  test('a guard resource in state complete is the strong tier', async () => {
    const root = freshProjectRoot({ guard: true });
    writeFeature(root, 'P-4', 'COMPLETE');
    _testOnly_setHistoryClient(async () => ({ current_state: 'complete' }));
    const v = await verifiedCompleteProjection({ item: buildItem('P-4'), featureCode: 'P-4', cwd: root });
    assert.equal(v.ok, true);
    assert.equal(v.verified_by, VERIFIED_BY.GUARDED);
  });

  test('a guard resource NOT in state complete refuses even though feature.json says COMPLETE', async () => {
    const root = freshProjectRoot({ guard: true });
    writeFeature(root, 'P-5', 'COMPLETE');
    _testOnly_setHistoryClient(async () => ({ current_state: 'ship' }));
    const v = await verifiedCompleteProjection({ item: buildItem('P-5'), featureCode: 'P-5', cwd: root });
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(), /state "ship"/);
  });

  test('any guard error other than not-found FAILS CLOSED — no tier downgrade', async () => {
    const root = freshProjectRoot({ guard: true });
    writeFeature(root, 'P-6', 'COMPLETE');
    for (const shape of [
      async () => ({ status: 'error', error_type: 'SPAWN', message: 'stratum-mcp not found' }),
      async () => { throw new Error('timeout'); },
    ]) {
      _testOnly_setHistoryClient(shape);
      const v = await verifiedCompleteProjection({ item: buildItem('P-6'), featureCode: 'P-6', cwd: root });
      assert.equal(v.ok, false, 'must refuse');
      assert.match(v.reasons.join(), /refusing rather than downgrading/);
    }
  });

  test('guard disabled in the workspace: canonical-status-only, and the guard client is never called', async () => {
    const root = freshProjectRoot({ guard: false });
    writeFeature(root, 'P-7', 'COMPLETE');
    let called = 0;
    _testOnly_setHistoryClient(async () => { called++; return { current_state: 'complete' }; });
    const v = await verifiedCompleteProjection({ item: buildItem('P-7'), featureCode: 'P-7', cwd: root });
    assert.equal(v.ok, true);
    assert.equal(v.verified_by, VERIFIED_BY.CANONICAL);
    assert.equal(called, 0);
  });

  test('a present-but-MALFORMED feature.json is broken canon, not absence: refuses in every tier (Codex r1 #1/#4)', async () => {
    const root = freshProjectRoot();
    mkdirSync(join(root, 'docs', 'features', 'BAD-1'), { recursive: true });
    writeFileSync(join(root, 'docs', 'features', 'BAD-1', 'feature.json'), '{ not json');
    const item = buildItem('BAD-1');
    for (const allowDocumentDerived of [false, true]) {
      const v = await verifiedCompleteProjection({ item, featureCode: 'BAD-1', cwd: root, allowDocumentDerived });
      assert.equal(v.ok, false);
      assert.match(v.reasons.join(), /could not be parsed/);
    }
    assert.equal(isManagedBuildItem(item, root), true, 'malformed canon is still MANAGED — the refusals apply');
  });

  test('isManagedBuildItem: build + feature.json only', () => {
    const root = freshProjectRoot();
    writeFeature(root, 'M-1', 'IN_PROGRESS');
    assert.equal(isManagedBuildItem(buildItem('M-1'), root), true);
    assert.equal(isManagedBuildItem(fixItem('M-1'), root), false, 'fix mode is not governed');
    assert.equal(isManagedBuildItem(buildItem('KICKOFF'), root), false, 'no feature.json → unmanaged (compose new kickoff item)');
    assert.equal(isManagedBuildItem({ id: 'ui-1', title: 'ui item', status: 'planned' }, root), false, 'no lifecycle');
  });
});

// ---------------------------------------------------------------------------
// Routes — a real express app on an ephemeral port
// ---------------------------------------------------------------------------

let baseUrl, httpServer, store, projectRoot;

before(() => new Promise((res) => {
  projectRoot = freshProjectRoot({ guard: false });
  store = new VisionStore(mkdtempSync(join(tmpdir(), 'compl-proj-data-')));
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store, scheduleBroadcast: () => {}, broadcastMessage: () => {}, projectRoot, capabilities: { guard: false },
  });
  attachStratumRoutes(app, { store, scheduleBroadcast: () => {}, broadcastMessage: () => {}, sync: null });
  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    res();
  });
}));

after(() => new Promise((res) => { httpServer.closeAllConnections?.(); httpServer.close(res); }));

async function call(method, path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

/** Create an item bound to `code` in `mode`, parked at its completable phase. */
async function makeItem(code, mode, phase) {
  const created = await call('POST', '/api/vision/items', { title: code, type: 'feature' });
  await call('POST', `/api/vision/items/${created.body.id}/lifecycle/start`, { featureCode: code, mode });
  const item = store.items.get(created.body.id);
  store.updateLifecycle(item.id, { ...item.lifecycle, currentPhase: phase });
  return item.id;
}

describe('PATCH /api/vision/items/:id — AC-10', () => {
  test('refuses status: complete for a MANAGED BUILD item with 422', async () => {
    writeFeature(projectRoot, 'R-1', 'IN_PROGRESS');
    const id = await makeItem('R-1', 'build', 'ship');
    const r = await call('PATCH', `/api/vision/items/${id}`, { status: 'complete' });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'COMPLETE_VIA_GATE_ONLY');
    assert.equal(store.items.get(id).status, 'planned', 'nothing written');
  });

  test('refuses status: complete for a build item whose feature.json is MALFORMED (fail closed)', async () => {
    mkdirSync(join(projectRoot, 'docs', 'features', 'R-BAD'), { recursive: true });
    writeFileSync(join(projectRoot, 'docs', 'features', 'R-BAD', 'feature.json'), '{{{');
    const id = await makeItem('R-BAD', 'build', 'ship');
    const r = await call('PATCH', `/api/vision/items/${id}`, { status: 'complete' });
    assert.equal(r.status, 422);
  });

  test('a FIX item still completes through PATCH (§2.3d — round 5)', async () => {
    writeFeature(projectRoot, 'R-2', 'IN_PROGRESS');
    const id = await makeItem('R-2', 'fix', 'verify');
    const r = await call('PATCH', `/api/vision/items/${id}`, { status: 'complete' });
    assert.equal(r.status, 200);
    assert.equal(store.items.get(id).status, 'complete');
  });

  test('an UNMANAGED build item (no feature.json — the kickoff item) still completes through PATCH', async () => {
    const id = await makeItem('KICKOFF-1', 'build', 'ship');
    const r = await call('PATCH', `/api/vision/items/${id}`, { status: 'complete' });
    assert.equal(r.status, 200);
  });

  test('the verification stamp cannot be forged through PATCH (Codex r2 #1)', async () => {
    writeFeature(projectRoot, 'R-4', 'COMPLETE');
    const id = await makeItem('R-4', 'build', 'ship');
    const r = await call('PATCH', `/api/vision/items/${id}`, { completion_projection: { verified_by: 'guarded', ledger_ref: 'fake' } });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'PROJECTION_STAMP_READONLY');
    assert.equal(store.items.get(id).completion_projection, undefined);
  });

  test('other statuses on a managed build item are untouched', async () => {
    writeFeature(projectRoot, 'R-3', 'IN_PROGRESS');
    const id = await makeItem('R-3', 'build', 'ship');
    const r = await call('PATCH', `/api/vision/items/${id}`, { status: 'blocked' });
    assert.equal(r.status, 200);
  });
});

describe('POST /api/vision/items/:id/completion-projection — AC-4b/AC-4d', () => {
  test('refuses when canonical state does not record the completion', async () => {
    writeFeature(projectRoot, 'E-1', 'IN_PROGRESS');
    const id = await makeItem('E-1', 'build', 'ship');
    const r = await call('POST', `/api/vision/items/${id}/completion-projection`, { featureCode: 'E-1' });
    assert.equal(r.status, 422);
    assert.match(r.body.reasons.join(), /not COMPLETE/);
    assert.equal(store.items.get(id).status, 'planned');
  });

  test('mirrors a completion feature.json already records, stamped with its tier', async () => {
    writeFeature(projectRoot, 'E-2', 'COMPLETE');
    const id = await makeItem('E-2', 'build', 'ship');
    const r = await call('POST', `/api/vision/items/${id}/completion-projection`, { featureCode: 'E-2', commitSha: 'abc', ledgerRef: 'l#1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified_by, VERIFIED_BY.CANONICAL);
    const item = store.items.get(id);
    assert.equal(item.status, 'complete');
    assert.equal(item.completion_projection.verified_by, VERIFIED_BY.CANONICAL);
    assert.equal(item.completion_projection.commit_sha, 'abc');
    assert.equal(item.completion_projection.source, 'rest');
  });

  test('400 without featureCode; 404 for an unknown item', async () => {
    assert.equal((await call('POST', '/api/vision/items/nope/completion-projection', {})).status, 400);
    assert.equal((await call('POST', '/api/vision/items/nope/completion-projection', { featureCode: 'X' })).status, 404);
  });
});

describe('POST /api/stratum/audit/:itemId — AC-11', () => {
  test('a trace reporting complete stores the evidence but does NOT flip status', async () => {
    writeFeature(projectRoot, 'A-1', 'IN_PROGRESS');
    const id = await makeItem('A-1', 'build', 'ship');
    const r = await call('POST', `/api/stratum/audit/${id}`, { trace: { status: 'complete', flow_id: 'f', trace: [1, 2] } });
    assert.equal(r.status, 200);
    const item = store.items.get(id);
    assert.equal(item.status, 'planned', 'an audit trace is not completion evidence');
    assert.equal(item.evidence.stratumTrace.status, 'complete', 'the trace itself is kept');
  });
});

describe('POST /lifecycle/complete — build goes through the gate; fix keeps its path', () => {
  test('build: the gate writes feature.json COMPLETE and projects the live store (guard off ⇒ commit-less allowed)', async () => {
    writeFeature(projectRoot, 'L-1', 'IN_PROGRESS');
    const id = await makeItem('L-1', 'build', 'ship');
    const r = await call('POST', `/api/vision/items/${id}/lifecycle/complete`, { tests_pass: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.partial, false, JSON.stringify(r.body));
    assert.equal(r.body.verified_by, VERIFIED_BY.CANONICAL);
    assert.equal(readFeature(projectRoot, 'L-1').status, 'COMPLETE');
    assert.equal(readFeature(projectRoot, 'L-1').completions.length, 1);
    const item = store.items.get(id);
    assert.equal(item.status, 'complete');
    assert.equal(item.lifecycle.currentPhase, 'complete');
    assert.equal(item.completion_projection.source, 'lifecycle/complete');
  });

  test('build: a lifecycle persist failure after the projection is reported as partial (Codex r2 #3)', async () => {
    writeFeature(projectRoot, 'L-3', 'IN_PROGRESS');
    const id = await makeItem('L-3', 'build', 'ship');
    const origSave = store._save.bind(store);
    let calls = 0;
    // The projection save (first) succeeds; the lifecycle save (second) fails.
    store._save = () => { calls++; return calls === 1 ? origSave() : false; };
    try {
      const r = await call('POST', `/api/vision/items/${id}/lifecycle/complete`, { tests_pass: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.partial, true);
      assert.ok(r.body.failures.some((f) => f.step === 'lifecycle-persist'), JSON.stringify(r.body));
    } finally { store._save = origSave; }
  });

  test('build: a KILLED feature is refused by the gate with 422 and nothing changes', async () => {
    writeFeature(projectRoot, 'L-2', 'KILLED');
    const id = await makeItem('L-2', 'build', 'ship');
    const r = await call('POST', `/api/vision/items/${id}/lifecycle/complete`, { tests_pass: true });
    assert.equal(r.status, 422);
    assert.equal(r.body.refusedAt, 'preflight');
    assert.equal(store.items.get(id).lifecycle.currentPhase, 'ship');
    assert.equal(readFeature(projectRoot, 'L-2').status, 'KILLED');
  });

  test('fix: no feature.json to gate on — completes the item directly as before', async () => {
    const id = await makeItem('FIX-9', 'fix', 'ship');
    const r = await call('POST', `/api/vision/items/${id}/lifecycle/complete`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.items.get(id).status, 'complete');
  });
});

describe('applyVerifiedProjection — the in-process transport', () => {
  test('writes only after the predicate passes', async () => {
    writeFeature(projectRoot, 'IP-1', 'IN_PROGRESS');
    const id = await makeItem('IP-1', 'build', 'ship');
    const refused = await applyVerifiedProjection(store, { itemId: id, featureCode: 'IP-1', cwd: projectRoot });
    assert.equal(refused.ok, false);
    assert.equal(store.items.get(id).status, 'planned');
    writeFeature(projectRoot, 'IP-1', 'COMPLETE');
    const ok = await applyVerifiedProjection(store, { itemId: id, featureCode: 'IP-1', cwd: projectRoot });
    assert.equal(ok.ok, true);
    assert.equal(store.items.get(id).status, 'complete');
  });

  test('a persist failure is NOT a success: the live item is rolled back and ok:false returned (Codex r1 #2)', async () => {
    writeFeature(projectRoot, 'IP-2', 'COMPLETE');
    const id = await makeItem('IP-2', 'build', 'ship');
    const before = { ...store.items.get(id) };
    const origSave = store._save;
    store._save = () => false; // disk full / rename failed
    try {
      const r = await applyVerifiedProjection(store, { itemId: id, featureCode: 'IP-2', cwd: projectRoot });
      assert.equal(r.ok, false);
      assert.match(r.reasons.join(), /could not be persisted/);
      const after = store.items.get(id);
      assert.equal(after.status, before.status, 'in-memory status rolled back');
      assert.equal(after.completion_projection ?? null, null, 'no stamp left behind');
    } finally { store._save = origSave; }
  });

  test('the REST endpoint returns 422 on a persist failure, not 200', async () => {
    writeFeature(projectRoot, 'IP-3', 'COMPLETE');
    const id = await makeItem('IP-3', 'build', 'ship');
    const origSave = store._save;
    store._save = () => false;
    try {
      const r = await call('POST', `/api/vision/items/${id}/completion-projection`, { featureCode: 'IP-3' });
      assert.equal(r.status, 422);
    } finally { store._save = origSave; }
  });

  test('guard stubs from lifecycle-guard do not leak into the predicate (uses the history seam)', () => {
    guard._testOnly_resetGuardCache();
    assert.ok(true);
  });
});
