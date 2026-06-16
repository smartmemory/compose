/**
 * Integration test for GET /api/environment-health — real Express app on an
 * ephemeral port, real lib backends (deps/version), and real `.git/hooks`
 * fixtures on disk. req.workspace is injected by a tiny test middleware to
 * control which workspace root + id the hooks are checked against.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const express = (await import('express')).default;
const { attachHealthRoutes } = await import(`${ROOT}/server/health-routes.js`);
const { HOOK_MARKERS } = await import(`${ROOT}/lib/hooks-status.js`);

const NODE = '/fixture/node';
const BIN = '/fixture/compose.js';

function makeWorkspaceFixture(wsId, { prePush } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'health-ws-'));
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  if (prePush) writeFileSync(join(hooksDir, 'pre-push'), prePush);
  return { id: wsId, root: dir };
}

function compoHook(ws) {
  return [
    '#!/usr/bin/env bash',
    `${HOOK_MARKERS['pre-push']} blocks push.`,
    `COMPOSE_NODE="${NODE}"`,
    `COMPOSE_BIN="${BIN}"`,
    `COMPOSE_WORKSPACE_ID="${ws}"`,
    'exit 0',
  ].join('\n');
}

/** Start an app whose injected req.workspace + packageRoot are configurable. */
function startServer({ workspace, packageRoot }) {
  const app = express();
  app.use((req, _res, nextFn) => {
    req.workspace = workspace;
    nextFn();
  });
  attachHealthRoutes(app, { packageRoot, composeBin: BIN, composeNode: NODE });
  return new Promise((res) => {
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      res({ httpServer, baseUrl: `http://127.0.0.1:${httpServer.address().port}` });
    });
  });
}

async function getHealth(baseUrl, qs = '') {
  const r = await fetch(`${baseUrl}/api/environment-health${qs}`, { headers: { Connection: 'close' } });
  return { status: r.status, body: await r.json() };
}

describe('GET /api/environment-health', () => {
  const cleanups = [];
  after(() => cleanups.forEach((fn) => fn()));

  function track(server, ...dirs) {
    cleanups.push(() => server.httpServer.close());
    for (const d of dirs) cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  }

  test('full shape against real deps + a real installed-current hook fixture', async () => {
    const ws = makeWorkspaceFixture('ws-fixture', { prePush: compoHook('ws-fixture') });
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { status, body } = await getHealth(server.baseUrl);
    assert.equal(status, 200);
    assert.ok(['ok', 'warn', 'error'].includes(body.summary));
    // dependencies/binaries: real backend → present/missing arrays (never throws here)
    assert.ok(body.dependencies && (Array.isArray(body.dependencies.missing) || body.dependencies.unavailable));
    // must NOT leak absolute host filesystem paths (scannedPaths stripped)
    assert.equal(body.dependencies.scannedPaths, undefined);
    assert.ok(body.binaries && (Array.isArray(body.binaries.missing) || body.binaries.unavailable));
    // version: real backend → either a drift object or null (offline), never throws
    assert.ok(body.version === null || typeof body.version === 'object');
    // hooks: post-commit absent, pre-push installed-current with verified workspace
    assert.equal(body.hooks['post-commit'].state, 'absent');
    assert.deepEqual(body.hooks['pre-push'], { state: 'installed-current', workspace: 'ws-fixture' });
  });

  test('null workspace id → pre-push reported workspace-unverified, never false-current', async () => {
    const ws = makeWorkspaceFixture(null, { prePush: compoHook('whatever') });
    ws.id = null; // simulate the fallback (no X-Compose-Workspace-Id header yet)
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { body } = await getHealth(server.baseUrl);
    assert.equal(body.hooks['pre-push'].state, 'workspace-unverified');
  });

  test('stale workspace id → installed-stale STALE_WORKSPACE_ID with expected id', async () => {
    const ws = makeWorkspaceFixture('expected-ws', { prePush: compoHook('a-different-ws') });
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { body } = await getHealth(server.baseUrl);
    assert.equal(body.hooks['pre-push'].state, 'installed-stale');
    assert.equal(body.hooks['pre-push'].reason, 'STALE_WORKSPACE_ID');
    assert.deepEqual(body.hooks['pre-push'].expected, { workspaceId: 'expected-ws' });
  });

  test('foreign hook → state foreign and summary error', async () => {
    const ws = makeWorkspaceFixture('ws-fixture', { prePush: '#!/usr/bin/env bash\necho not ours\n' });
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { body } = await getHealth(server.baseUrl);
    assert.equal(body.hooks['pre-push'].state, 'foreign');
    assert.equal(body.summary, 'error');
  });

  test('degrade: bad packageRoot (no .compose-deps.json) → both dep sections unavailable, no 500', async () => {
    const emptyPkg = mkdtempSync(join(tmpdir(), 'health-pkg-'));
    const ws = makeWorkspaceFixture('ws-fixture', { prePush: compoHook('ws-fixture') });
    const server = await startServer({ workspace: ws, packageRoot: emptyPkg });
    track(server, ws.root, emptyPkg);

    const { status, body } = await getHealth(server.baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body.dependencies, { unavailable: true });
    assert.deepEqual(body.binaries, { unavailable: true });
    // version also unavailable (no package.json) → null; summary still computes
    assert.equal(body.version, null);
    assert.ok(['ok', 'warn', 'error'].includes(body.summary));
  });

  test('no workspace on request → hooks unavailable, still 200', async () => {
    const server = await startServer({ workspace: undefined });
    cleanups.push(() => server.httpServer.close());

    const { status, body } = await getHealth(server.baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body.hooks, { unavailable: true });
  });
});
