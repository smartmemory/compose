/**
 * Tests for server/workspace-middleware.js
 *
 * Table-driven coverage of the createWorkspaceMiddleware factory + the
 * mapResolverErrorToResponse helper. No real Express server — we drive
 * the middleware directly with mock req/res/next stubs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path, { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  createWorkspaceMiddleware,
  mapResolverErrorToResponse,
} = await import(`${REPO_ROOT}/server/workspace-middleware.js`);
const {
  WorkspaceUnknown,
  WorkspaceAmbiguous,
  WorkspaceIdCollision,
} = await import(`${REPO_ROOT}/lib/resolve-workspace.js`);
const { deriveId } = await import(`${REPO_ROOT}/lib/discover-workspaces.js`);
const { switchProject } = await import(`${REPO_ROOT}/server/project-root.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq({ path = '/api/foo', method = 'GET', headers = {} } = {}) {
  // express normalizes headers lowercase; mimic that
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { path, method, headers: lower };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
  };
  return res;
}

/** Make a tmp .compose workspace, return {root, id, cleanup}. */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmw-'));
  fs.mkdirSync(path.join(root, '.compose'), { recursive: true });
  fs.writeFileSync(path.join(root, '.compose', 'compose.json'), JSON.stringify({ version: 1 }));
  const { id } = deriveId({ root });
  return {
    root,
    id,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

// ---------------------------------------------------------------------------
// Suite: setup a real workspace as the target root so resolveWorkspace works
// ---------------------------------------------------------------------------

const ws = makeWorkspace();
switchProject(ws.root);

test.after(() => ws.cleanup());

// ---------------------------------------------------------------------------
// Exempt paths
// ---------------------------------------------------------------------------

for (const exemptPath of ['/api/workspace', '/api/project/switch', '/api/health']) {
  test(`exempt path bypass: ${exemptPath}`, () => {
    const mw = createWorkspaceMiddleware();
    const req = mockReq({ path: exemptPath, method: 'POST' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.ok(req.workspace, 'req.workspace populated');
    assert.equal(req.workspace.source, 'exempt');
    assert.equal(req.workspace.id, null);
    assert.equal(req.workspace.root, ws.root);
  });
}

// ---------------------------------------------------------------------------
// Header present + valid
// ---------------------------------------------------------------------------

test('valid header (GET) → req.workspace.id matches', () => {
  const mw = createWorkspaceMiddleware();
  const req = mockReq({
    path: '/api/foo',
    method: 'GET',
    headers: { 'x-compose-workspace-id': ws.id },
  });
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.workspace.id, ws.id);
  assert.equal(req.workspace.root, ws.root);
});

test('valid header (POST) → req.workspace.id matches', () => {
  const mw = createWorkspaceMiddleware();
  const req = mockReq({
    path: '/api/foo',
    method: 'POST',
    headers: { 'x-compose-workspace-id': ws.id },
  });
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.workspace.id, ws.id);
});

// ---------------------------------------------------------------------------
// Header absent → soft fallback (v1 — for ALL methods)
// ---------------------------------------------------------------------------

test('absent header (GET) → fallback with X-Compose-Workspace-Fallback', () => {
  const mw = createWorkspaceMiddleware();
  const req = mockReq({ path: '/api/foo', method: 'GET' });
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.workspace.source, 'fallback');
  assert.equal(req.workspace.id, null);
  assert.equal(req.workspace.root, ws.root);
  assert.equal(res.headers['X-Compose-Workspace-Fallback'], 'true');
});

test('absent header (POST) → fallback (v1 soft fallback for ALL methods)', () => {
  const mw = createWorkspaceMiddleware();
  const req = mockReq({ path: '/api/foo', method: 'POST' });
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.workspace.source, 'fallback');
  assert.equal(res.headers['X-Compose-Workspace-Fallback'], 'true');
  assert.equal(res.statusCode, 200, 'POST without header is NOT 400 in v1');
});

// ---------------------------------------------------------------------------
// Invalid id → 400 WorkspaceUnknown
// ---------------------------------------------------------------------------

test('invalid header id → 400 WorkspaceUnknown', () => {
  const mw = createWorkspaceMiddleware();
  const req = mockReq({
    path: '/api/foo',
    method: 'GET',
    headers: { 'x-compose-workspace-id': 'bogus-nonexistent-id' },
  });
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'WorkspaceUnknown');
  assert.equal(res.body.id, 'bogus-nonexistent-id');
  assert.ok(res.body.error);
});

// ---------------------------------------------------------------------------
// mapResolverErrorToResponse — direct unit tests for error mapping
// ---------------------------------------------------------------------------

test('mapResolverErrorToResponse: WorkspaceAmbiguous → 409 with candidates', () => {
  const res = mockRes();
  const candidates = [{ id: 'a', root: '/a' }, { id: 'b', root: '/b' }];
  const err = new WorkspaceAmbiguous(candidates);
  mapResolverErrorToResponse(err, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'WorkspaceAmbiguous');
  assert.deepEqual(res.body.candidates, candidates);
});

test('mapResolverErrorToResponse: WorkspaceIdCollision → 409 with roots', () => {
  const res = mockRes();
  const err = new WorkspaceIdCollision('dup', ['/r1', '/r2']);
  mapResolverErrorToResponse(err, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'WorkspaceIdCollision');
  assert.deepEqual(res.body.roots, ['/r1', '/r2']);
});

test('mapResolverErrorToResponse: WorkspaceUnknown → 400 with id', () => {
  const res = mockRes();
  const err = new WorkspaceUnknown('missing');
  mapResolverErrorToResponse(err, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'WorkspaceUnknown');
  assert.equal(res.body.id, 'missing');
});

test('mapResolverErrorToResponse: WorkspaceDiscoveryTooBroad → 400', () => {
  const res = mockRes();
  const err = new Error('too broad');
  err.code = 'WorkspaceDiscoveryTooBroad';
  mapResolverErrorToResponse(err, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'WorkspaceDiscoveryTooBroad');
});

test('mapResolverErrorToResponse: unknown error → 500', () => {
  const res = mockRes();
  const err = new Error('whoops');
  mapResolverErrorToResponse(err, res);
  assert.equal(res.statusCode, 500);
  assert.ok(res.body.error);
});
