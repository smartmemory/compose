/**
 * workspace-routes.test.js — GET /api/workspace boot-deterministic shape.
 *
 * Spins up a real Express app on an ephemeral port; uses switchProject() to
 * point getTargetRoot() at a tmpdir so the route resolves to a known root.
 *
 * Acceptance (T2 of COMP-WORKSPACE-HTTP):
 *   - Returns { id, root, source: 'boot' }
 *   - Works in tmpdir
 *   - Does NOT 409 in nested-workspace setup (parent root with child .compose/)
 *   - id is a string (not the {id, root, configPath} object from deriveId)
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { attachWorkspaceRoutes } = await import(`${ROOT}/server/workspace-routes.js`);
const { switchProject } = await import(`${ROOT}/server/project-root.js`);

let baseUrl;
let httpServer;
const tmpdirsToCleanup = [];

function freshDir(prefix = 'ws-routes-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpdirsToCleanup.push(d);
  return d;
}

function makeWorkspace(root, opts = {}) {
  mkdirSync(join(root, '.compose'), { recursive: true });
  if (opts.workspaceId) {
    writeFileSync(
      join(root, '.compose', 'compose.json'),
      JSON.stringify({ workspaceId: opts.workspaceId }),
      'utf-8',
    );
  }
}

before(() => new Promise(res => {
  const app = express();
  app.use(express.json());
  attachWorkspaceRoutes(app);
  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => {
  httpServer.closeAllConnections?.();
  httpServer.close(() => {
    for (const d of tmpdirsToCleanup) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    res();
  });
}));

async function get(path) {
  const r = await fetch(`${baseUrl}${path}`, { headers: { Connection: 'close' } });
  const body = await r.json();
  return { status: r.status, body };
}

describe('GET /api/workspace', () => {
  test('returns {id, root, source:"boot"} in tmpdir', async () => {
    const dir = freshDir();
    makeWorkspace(dir, { workspaceId: 'boot-test' });
    switchProject(dir);

    const { status, body } = await get('/api/workspace');
    assert.equal(status, 200);
    assert.equal(body.source, 'boot');
    assert.equal(body.root, dir);
    assert.equal(body.id, 'boot-test');
  });

  test('id is a string, not an object', async () => {
    const dir = freshDir();
    makeWorkspace(dir, { workspaceId: 'string-id' });
    switchProject(dir);

    const { body } = await get('/api/workspace');
    assert.equal(typeof body.id, 'string');
    // explicit guard against the {id, root, configPath} object slipping through
    assert.equal(body.id, 'string-id');
    assert.ok(!('configPath' in body), 'response must not leak configPath');
  });

  test('falls back to basename when no workspaceId in compose.json', async () => {
    const dir = freshDir('ws-routes-basename-');
    makeWorkspace(dir); // no workspaceId in config
    switchProject(dir);

    const { status, body } = await get('/api/workspace');
    assert.equal(status, 200);
    assert.equal(body.id, basename(dir));
    assert.equal(body.root, dir);
    assert.equal(body.source, 'boot');
  });

  test('does NOT 409 in nested-workspace setup (parent contains child .compose/)', async () => {
    // SD-2: route is boot-deterministic — getTargetRoot() returns whatever was
    // resolved at boot, deriveId() reads that root only. No descendant scan,
    // so a nested child workspace must NOT cause WorkspaceAmbiguous (409).
    const parent = freshDir('ws-routes-nested-');
    makeWorkspace(parent, { workspaceId: 'parent-ws' });
    const child = join(parent, 'inner');
    mkdirSync(child);
    makeWorkspace(child, { workspaceId: 'child-ws' });
    switchProject(parent);

    const { status, body } = await get('/api/workspace');
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.notEqual(status, 409);
    assert.equal(body.id, 'parent-ws');
    assert.equal(body.root, parent);
    assert.equal(body.source, 'boot');
  });
});
