/**
 * COMP-PARITY-3-1: POST /api/environment-health/repair-hooks — guarded, local,
 * idempotent hook repair. Real Express app on an ephemeral port, an injected
 * req.workspace, and a STUB runCommand (no real shell-out). Asserts the command
 * that would run, the --force toggle, the refreshed `hooks` payload, and that a
 * failing runner degrades to { ok:false } rather than a 500.
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
const TOKEN = 'test-sensitive-token';

/** Workspace fixture with a real .git/hooks dir we can write hook files into. */
function makeWorkspaceFixture(wsId) {
  const dir = mkdtempSync(join(tmpdir(), 'health-repair-ws-'));
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  return { id: wsId, root: dir };
}

/** A Compose-marked, correct hook for `ws` (what install would write). */
function compoHook(type, ws) {
  return [
    '#!/usr/bin/env bash',
    `${HOOK_MARKERS[type]} managed by compose.`,
    `COMPOSE_NODE="${NODE}"`,
    `COMPOSE_BIN="${BIN}"`,
    `COMPOSE_WORKSPACE_ID="${ws}"`,
    'exit 0',
  ].join('\n');
}

/**
 * Start an app with an injected workspace + a stub runCommand. The stub records
 * every invocation and, on success, simulates `compose hooks install` by
 * writing correct hook files for both managed types into the workspace .git/hooks.
 */
function startServer({ workspace, runResult, runImpl }) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, nextFn) => {
    req.workspace = workspace;
    nextFn();
  });
  const runCommand = (opts) => {
    calls.push(opts);
    if (runImpl) return runImpl(opts);
    // Default success stub: emulate install writing both hooks for the workspace.
    if (workspace?.root) {
      for (const type of ['post-commit', 'pre-push']) {
        writeFileSync(join(workspace.root, '.git', 'hooks', type), compoHook(type, workspace.id));
      }
    }
    return runResult ?? { status: 0, stdout: 'installed', stderr: '', error: null };
  };
  attachHealthRoutes(app, { composeBin: BIN, composeNode: NODE, runCommand });
  return new Promise((res) => {
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      res({ httpServer, baseUrl: `http://127.0.0.1:${httpServer.address().port}`, calls });
    });
  });
}

async function repair(baseUrl, body, { token = TOKEN } = {}) {
  const headers = { 'Content-Type': 'application/json', Connection: 'close' };
  if (token != null) headers['x-compose-token'] = token;
  const r = await fetch(`${baseUrl}/api/environment-health/repair-hooks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
}

describe('POST /api/environment-health/repair-hooks', () => {
  const cleanups = [];
  // The route is gated by requireSensitiveOrPaired; with no pairing store it
  // falls back to the sensitive-token path (503 unset, 401 mismatch, pass on match).
  let _origToken;
  before(() => {
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
  });
  after(() => {
    cleanups.forEach((fn) => fn());
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });
  function track(server, ...dirs) {
    cleanups.push(() => server.httpServer.close());
    for (const d of dirs) cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  }

  test('runs `hooks install --post-commit --pre-push --workspace=<id>` and returns refreshed hooks', async () => {
    const ws = makeWorkspaceFixture('ws-fixture');
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { status, body } = await repair(server.baseUrl, {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Exactly one command, with the expected verb + flags + workspace, no --force.
    assert.equal(server.calls.length, 1);
    const args = server.calls[0].args;
    assert.deepEqual(args.slice(0, 4), ['hooks', 'install', '--post-commit', '--pre-push']);
    assert.ok(args.includes('--workspace=ws-fixture'));
    assert.ok(!args.includes('--force'));
    assert.equal(server.calls[0].cwd, ws.root);
    assert.match(body.ranCommand, /hooks install --post-commit --pre-push --workspace=ws-fixture/);

    // Recomputed hooks reflect the freshly-written, correct hook files.
    assert.deepEqual(body.hooks['post-commit'], { state: 'installed-current', workspace: 'ws-fixture' });
    assert.deepEqual(body.hooks['pre-push'], { state: 'installed-current', workspace: 'ws-fixture' });
  });

  test('force:true appends --force (foreign-overwrite path)', async () => {
    const ws = makeWorkspaceFixture('ws-fixture');
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { body } = await repair(server.baseUrl, { force: true });
    assert.equal(body.ok, true);
    assert.ok(server.calls[0].args.includes('--force'));
    assert.match(body.ranCommand, /--force$/);
  });

  test('omits --force when force is falsey', async () => {
    const ws = makeWorkspaceFixture('ws-fixture');
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    await repair(server.baseUrl, { force: false });
    assert.ok(!server.calls[0].args.includes('--force'));
  });

  test('failing runner → { ok:false } with error+stderr, never a 500', async () => {
    const ws = makeWorkspaceFixture('ws-fixture');
    const server = await startServer({
      workspace: ws,
      runImpl: () => ({ status: 1, stdout: '', stderr: 'a foreign pre-push hook already exists', error: null }),
    });
    track(server, ws.root);

    const { status, body } = await repair(server.baseUrl, {});
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /status 1/);
    assert.match(body.stderr, /foreign pre-push hook/);
  });

  test('runner that throws → { ok:false }, never a 500', async () => {
    const ws = makeWorkspaceFixture('ws-fixture');
    const server = await startServer({
      workspace: ws,
      runImpl: () => { throw new Error('spawn boom'); },
    });
    track(server, ws.root);

    const { status, body } = await repair(server.baseUrl, {});
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /spawn boom/);
  });

  test('no workspace on request → { ok:false }, command never runs', async () => {
    const server = await startServer({ workspace: undefined });
    cleanups.push(() => server.httpServer.close());

    const { status, body } = await repair(server.baseUrl, {});
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /no workspace root/);
    assert.equal(server.calls.length, 0);
  });

  test('mutation guard: rejects with 401 when no token is sent, command never runs', async () => {
    const ws = makeWorkspaceFixture('ws-fixture');
    const server = await startServer({ workspace: ws });
    track(server, ws.root);

    const { status } = await repair(server.baseUrl, {}, { token: null });
    assert.equal(status, 401);
    assert.equal(server.calls.length, 0);
  });
});
