/**
 * cli-resolve-workspace.test.js — COMP-WORKSPACE-HTTP T7.
 *
 * Pins the shape change on `resolveCwdWithWorkspace` (now `{ root, id }`)
 * and asserts the loops CLI threads the workspace id through `httpGet` /
 * `httpPost` as `X-Compose-Workspace-Id` (or omits the header when no
 * workspace resolves).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

const { resolveWorkspace } = await import(`${REPO_ROOT}/lib/resolve-workspace.js`);

// ── Shape pin: resolveWorkspace returns { root, id, ... } so the CLI's
//    resolveCwdWithWorkspace cache shape `{ root, id }` is sourced correctly.
describe('resolveWorkspace shape (T7)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cli-resolve-ws-shape-'));
    mkdirSync(join(tmp, '.compose'), { recursive: true });
    writeFileSync(
      join(tmp, '.compose', 'compose.json'),
      JSON.stringify({ workspaceId: 'wsx-shape' }),
    );
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('resolveWorkspace returns { root, id } source-of-truth for cache', () => {
    const ws = resolveWorkspace({ cwd: tmp, workspaceId: 'wsx-shape' });
    assert.equal(typeof ws.root, 'string');
    assert.equal(typeof ws.id, 'string');
    assert.equal(ws.id, 'wsx-shape');
  });
});

// ── Header injection: spawn the loops CLI against a tiny server that
//    captures inbound headers and asserts X-Compose-Workspace-Id.

function setupCaptureServer() {
  const captured = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    captured.push({ method: req.method, path: req.path, headers: req.headers });
    next();
  });
  // Minimal route: list items returns one with featureCode WS-CLI
  app.get('/api/vision/items', (_req, res) => {
    res.json({ items: [{ id: 'item-1', lifecycle: { featureCode: 'WS-CLI' } }] });
  });
  app.get('/api/vision/items/:id/loops', (_req, res) => {
    res.json({ loops: [] });
  });
  return new Promise((resolveSrv) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolveSrv({ server, port, captured });
    });
  });
}

function makeWorkspaceDir(id) {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-resolve-ws-cli-'));
  mkdirSync(join(tmp, '.compose'), { recursive: true });
  writeFileSync(
    join(tmp, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: id }),
  );
  return tmp;
}

function runLoopsCLI(args, cwd, env = {}, timeoutMs = 8000) {
  return new Promise((resolveCli, reject) => {
    const child = spawn(process.execPath, [COMPOSE_BIN, 'loops', ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveCli({ status: code, stdout, stderr });
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

describe('compose loops CLI — X-Compose-Workspace-Id header (T7)', () => {
  let srv;
  beforeEach(async () => { srv = await setupCaptureServer(); });
  afterEach(() => { srv.server.close(); });

  test('injects X-Compose-Workspace-Id when workspace resolves', async () => {
    const wsDir = makeWorkspaceDir('wsx-cli');
    try {
      const r = await runLoopsCLI(
        ['list', '--feature', 'WS-CLI'],
        wsDir,
        { COMPOSE_URL: `http://localhost:${srv.port}` },
      );
      assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
      assert.ok(srv.captured.length > 0, 'expected server to receive at least one request');
      for (const req of srv.captured) {
        assert.equal(
          req.headers['x-compose-workspace-id'],
          'wsx-cli',
          `expected header on ${req.method} ${req.path}, got ${JSON.stringify(req.headers)}`,
        );
      }
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  test('omits X-Compose-Workspace-Id when no workspace resolves', async () => {
    // Run from /tmp with no workspace lineage; CLI should still operate
    // (header simply absent → server middleware soft-falls back).
    const noWsDir = mkdtempSync(join(tmpdir(), 'cli-resolve-no-ws-'));
    try {
      const r = await runLoopsCLI(
        ['list', '--feature', 'WS-CLI'],
        noWsDir,
        {
          COMPOSE_URL: `http://localhost:${srv.port}`,
          // Ensure no inherited COMPOSE_TARGET points at a real workspace.
          COMPOSE_TARGET: '',
        },
      );
      assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
      assert.ok(srv.captured.length > 0, 'expected server to receive at least one request');
      for (const req of srv.captured) {
        assert.equal(
          req.headers['x-compose-workspace-id'],
          undefined,
          `expected NO header on ${req.method} ${req.path}, got ${req.headers['x-compose-workspace-id']}`,
        );
      }
    } finally {
      rmSync(noWsDir, { recursive: true, force: true });
    }
  });
});
