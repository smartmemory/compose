/**
 * loops-cli.test.js — CLI tests for `compose loops add|list|resolve`.
 *
 * Spawns a real server on a tmp port and drives the CLI against it.
 * Uses spawn (async) not spawnSync to avoid blocking the event loop.
 * Covers:
 *   - add: text output, JSON output
 *   - list: text + JSON output; stale rendering
 *   - resolve: text output
 *   - --feature required enforcement
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

// ── Helpers ───────────────────────────────────────────────────────────────

function setupServer() {
  const tmp = mkdtempSync(join(tmpdir(), 'loops-cli-test-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new VisionStore(dataDir);

  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: () => {},
    projectRoot: tmp,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmp, store, server, port });
    });
  });
}

function teardown(ctx) {
  ctx.server.close();
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

function httpPost(port, pathUrl, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathUrl, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** Async CLI runner using spawn (non-blocking). */
function runCLI(args, env = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPOSE_BIN, 'loops', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('compose loops — --feature required', () => {
  test('exits non-zero when --feature omitted for add', async () => {
    const r = await runCLI(['add', '--kind', 'deferred', '--summary', 'test'], {}, 3000);
    assert.notEqual(r.status, 0, 'must exit non-zero when --feature missing');
    assert.ok(r.stderr.includes('--feature'), `expected --feature in error: ${r.stderr}`);
  });

  test('list exits non-zero when --feature omitted', async () => {
    const r = await runCLI(['list'], {}, 3000);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('--feature'));
  });

  test('resolve exits non-zero when --feature omitted', async () => {
    const r = await runCLI(['resolve', 'some-id', '--note', 'done'], {}, 3000);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('--feature'));
  });
});

describe('compose loops add', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => teardown(ctx));

  test('add outputs loop id in text mode', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'CLI loop test' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'CLI-LOOPS' });

    const r = await runCLI(['add', '--feature', 'CLI-LOOPS', '--kind', 'deferred', '--summary', 'verify X'], {
      COMPOSE_URL: `http://localhost:${ctx.port}`,
    });
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('Created loop'), `expected "Created loop": ${r.stdout}`);
    assert.ok(r.stdout.includes('deferred'), `expected kind: ${r.stdout}`);
  });

  test('add --format json outputs JSON with loop id', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'JSON add test' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'CLI-LOOPS-JSON' });

    const r = await runCLI(['add', '--feature', 'CLI-LOOPS-JSON', '--kind', 'blocked', '--summary', 'dep waiting', '--format', 'json'], {
      COMPOSE_URL: `http://localhost:${ctx.port}`,
    });
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, 'must be valid JSON');
    assert.ok(parsed.id, 'loop.id must be present');
    assert.equal(parsed.kind, 'blocked');
  });
});

describe('compose loops list', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => teardown(ctx));

  test('list outputs loop entries in text mode', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'List test' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'CLI-LIST' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'deferred', summary: 'loop one' });

    const r = await runCLI(['list', '--feature', 'CLI-LIST'], {
      COMPOSE_URL: `http://localhost:${ctx.port}`,
    });
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('loop one') || r.stdout.includes('[open]'), `expected loop in output: ${r.stdout}`);
  });

  test('list --format json outputs array', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'JSON list test' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'CLI-LIST-JSON' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'open_question', summary: 'should we X?' });

    const r = await runCLI(['list', '--feature', 'CLI-LIST-JSON', '--format', 'json'], {
      COMPOSE_URL: `http://localhost:${ctx.port}`,
    });
    assert.equal(r.status, 0, `CLI stderr: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); });
    assert.ok(Array.isArray(parsed), 'must be array');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].kind, 'open_question');
  });

  test('stale loop shows >TTL in output', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Stale test' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'CLI-STALE' });
    // Inject a stale loop directly into the store
    const staleLoop = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'deferred',
      summary: 'very old loop',
      created_at: new Date(Date.now() - 100 * 86400000).toISOString(), // 100 days ago
      parent_feature: 'CLI-STALE',
      resolution: null,
      ttl_days: 1,
    };
    ctx.store.updateLifecycleExt(item.id, 'open_loops', [staleLoop]);

    const r = await runCLI(['list', '--feature', 'CLI-STALE'], {
      COMPOSE_URL: `http://localhost:${ctx.port}`,
    });
    assert.equal(r.status, 0, `CLI stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('>TTL') || r.stdout.includes('TTL'), `expected >TTL badge: ${r.stdout}`);
  });
});

describe('compose loops resolve', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => teardown(ctx));

  test('resolve outputs resolved loop id', async () => {
    const item = ctx.store.createItem({ type: 'feature', title: 'Resolve test' });
    await httpPost(ctx.port, `/api/vision/items/${item.id}/lifecycle/start`, { featureCode: 'CLI-RESOLVE' });
    const addR = await httpPost(ctx.port, `/api/vision/items/${item.id}/loops`, { kind: 'blocked', summary: 'waiting on dep' });
    const loopId = addR.body.loop.id;

    const r = await runCLI(['resolve', loopId, '--feature', 'CLI-RESOLVE', '--note', 'dep shipped'], {
      COMPOSE_URL: `http://localhost:${ctx.port}`,
    });
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('Resolved loop') || r.stdout.includes(loopId.slice(0, 8)), `expected resolved message: ${r.stdout}`);
  });
});
