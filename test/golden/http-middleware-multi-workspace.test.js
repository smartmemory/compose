/**
 * Golden flow for COMP-WORKSPACE-HTTP T10 — multi-workspace middleware routing.
 *
 * Verifies that the workspace middleware (mounted via the same wiring as
 * server/index.js: cors → express.json → attachWorkspaceRoutes →
 * createWorkspaceMiddleware) correctly:
 *
 *   - routes two distinct workspaces by header on the same Express app
 *   - emits X-Compose-Workspace-Fallback when no header is present
 *   - returns 400 WorkspaceUnknown for bogus header ids
 *   - exempts /api/health and /api/workspace from header enforcement
 *   - does not break /api/health under any of the above
 *
 * Topology mirrors test/golden/multi-workspace.test.js: a parent workspace
 * with two child workspaces underneath. getTargetRoot() points at the parent
 * so resolveWorkspace() can discover either child by id.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const express = (await import('express')).default;
const cors = (await import('cors')).default;
const { attachWorkspaceRoutes } = await import(`${ROOT}/server/workspace-routes.js`);
const { createWorkspaceMiddleware } = await import(`${ROOT}/server/workspace-middleware.js`);
const { switchProject } = await import(`${ROOT}/server/project-root.js`);
const { deriveId } = await import(`${ROOT}/lib/discover-workspaces.js`);

function makeWorkspace(root, { workspaceId } = {}) {
  mkdirSync(join(root, '.compose'), { recursive: true });
  if (workspaceId) {
    writeFileSync(
      join(root, '.compose', 'compose.json'),
      JSON.stringify({ version: 1, workspaceId }),
      'utf-8',
    );
  }
  return { root, id: workspaceId ?? deriveId({ root }).id };
}

describe('golden: HTTP middleware multi-workspace routing', () => {
  let dir;
  let parentWs;
  let wsA;
  let wsB;
  let httpServer;
  let baseUrl;

  before(() => new Promise((res) => {
    // Tmpdir topology: parent + two child workspaces
    dir = mkdtempSync(join(tmpdir(), 'compose-golden-http-mw-'));
    parentWs = makeWorkspace(dir, { workspaceId: 'parent-ws-http' });
    const aRoot = join(dir, 'workspace-a');
    const bRoot = join(dir, 'workspace-b');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });
    wsA = makeWorkspace(aRoot, { workspaceId: 'workspace-a-id' });
    wsB = makeWorkspace(bRoot, { workspaceId: 'workspace-b-id' });

    // Point getTargetRoot() at the parent so resolveWorkspace() will discover
    // both children when given their workspaceId via the header.
    switchProject(parentWs.root);

    // Build the Express app mirroring server/index.js wiring exactly:
    //   cors → express.json → attachWorkspaceRoutes → createWorkspaceMiddleware → routes
    const app = express();
    app.use(cors());
    app.use(express.json());
    attachWorkspaceRoutes(app);
    app.use(createWorkspaceMiddleware());

    // Existing-style health route (mirrors the one in server/index.js so we
    // can prove it still works under all middleware scenarios).
    app.get('/api/health', (_req, res) => {
      res.json({ ok: true });
    });

    // Probe route: echoes whatever the middleware attached so the test can
    // assert req.workspace shape and source.
    app.get('/api/probe', (req, res) => {
      res.json({ workspace: req.workspace });
    });

    httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      baseUrl = `http://127.0.0.1:${port}`;
      res();
    });
  }));

  after(() => new Promise((res) => {
    httpServer.closeAllConnections?.();
    httpServer.close(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      res();
    });
  }));

  async function req(path, opts = {}) {
    const r = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { Connection: 'close', ...(opts.headers || {}) },
    });
    let body = null;
    const text = await r.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: r.status, headers: r.headers, body };
  }

  test('two requests with different workspace headers route to the correct workspace', async () => {
    const a = await req('/api/probe', { headers: { 'X-Compose-Workspace-Id': wsA.id } });
    assert.equal(a.status, 200);
    assert.equal(a.body.workspace.id, wsA.id);
    assert.equal(a.body.workspace.root, wsA.root);

    const b = await req('/api/probe', { headers: { 'X-Compose-Workspace-Id': wsB.id } });
    assert.equal(b.status, 200);
    assert.equal(b.body.workspace.id, wsB.id);
    assert.equal(b.body.workspace.root, wsB.root);

    // Cross-check: the two requests must NOT have collapsed onto the same id
    assert.notEqual(a.body.workspace.id, b.body.workspace.id);
    assert.notEqual(a.body.workspace.root, b.body.workspace.root);
  });

  test('no header → fallback source + X-Compose-Workspace-Fallback header', async () => {
    const r = await req('/api/probe');
    assert.equal(r.status, 200);
    assert.equal(r.body.workspace.source, 'fallback');
    assert.equal(r.body.workspace.id, null);
    assert.equal(r.body.workspace.root, parentWs.root);
    assert.equal(r.headers.get('x-compose-workspace-fallback'), 'true');
  });

  test('bogus workspace id → 400 WorkspaceUnknown', async () => {
    const r = await req('/api/probe', { headers: { 'X-Compose-Workspace-Id': 'totally-bogus-id' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'WorkspaceUnknown');
    assert.equal(r.body.id, 'totally-bogus-id');
    assert.ok(r.body.error);
  });

  test('/api/health is exempt — bypasses middleware regardless of header', async () => {
    // No header
    let r = await req('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    // Soft fallback should NOT be emitted on exempt paths
    assert.equal(r.headers.get('x-compose-workspace-fallback'), null);

    // Valid header
    r = await req('/api/health', { headers: { 'X-Compose-Workspace-Id': wsA.id } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });

    // Bogus header — exempt path must still pass (middleware short-circuits
    // before resolveWorkspace), no 400.
    r = await req('/api/health', { headers: { 'X-Compose-Workspace-Id': 'still-bogus' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  test('/api/workspace bootstrap is exempt and returns boot workspace', async () => {
    // No header
    let r = await req('/api/workspace');
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'boot');
    assert.equal(r.body.id, parentWs.id);
    assert.equal(r.body.root, parentWs.root);

    // Bogus header — bootstrap must still succeed (route mounted before
    // middleware; even if it weren't, /api/workspace is in EXEMPT_PATHS).
    r = await req('/api/workspace', { headers: { 'X-Compose-Workspace-Id': 'bogus-bootstrap' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, parentWs.id);
  });
});
