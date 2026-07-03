/**
 * smartmemory-hooks.test.js — COMP-SMARTMEMORY-INGEST T4
 *
 * Integration tests for the two hook sites: lib/feature-events.js#appendEvent
 * and server/gate-log-store.js#appendGateLogEntry. Verifies:
 *   - Flag ON: the durable local write still happens, and exactly one live
 *     ingest POST reaches the stub with content matching the shared renderer.
 *   - Flag OFF (byte-identity): zero fetches, and the JSONL row / return value
 *     are unchanged apart from the always-dynamic `ts` field.
 *
 * Run: node --test test/smartmemory-hooks.test.js
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { appendEvent } from '../lib/feature-events.js';
import { appendGateLogEntry } from '../server/gate-log-store.js';
import { switchProject, getTargetRoot } from '../server/project-root.js';
import { renderFeatureEventContent, renderGateLogContent, flushPending, _resetEmitterState } from '../lib/smartmemory-ingest.js';
import { runSync } from '../lib/smartmemory-sync.js';

function listen(server) {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

function makeStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      seen.push(parsed);
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'stored' }));
    });
  });
  return { server, seen };
}

const servers = [];
after(() => { for (const s of servers) s.close(); });

// The hooks dispatch the emit via a lazy dynamic import() of
// smartmemory-ingest.js, which resolves at least one microtask after
// appendEvent/appendGateLogEntry return (before `pending` even gains the
// in-flight ingest promise). Poll briefly for the stub to observe the
// request, then drain with flushPending.
async function waitForSeen(seen, count, timeoutMs = 2000) {
  const start = Date.now();
  while (seen.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  _resetEmitterState();
});

describe('appendEvent (feature-events hook)', () => {
  test('flag ON: durable write happens + one live ingest POST matches the renderer', async () => {
    const { server, seen } = makeStub();
    await listen(server);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-hook-events-on-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_HOOK_KEY = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_HOOK_KEY' },
    }));
    try {
      const row = appendEvent(dir, { tool: 'set_feature_status', code: 'FOO-1', from: 'A', to: 'B' });
      // Durable local write happened.
      const text = readFileSync(join(dir, '.compose', 'data', 'feature-events.jsonl'), 'utf-8');
      assert.match(text, /"tool":"set_feature_status"/);

      await waitForSeen(seen, 1);
      await flushPending();
      assert.equal(seen.length, 1);
      const tag = basename(dir);
      assert.equal(seen[0].content, renderFeatureEventContent(row, tag));
      assert.equal(seen[0].context.origin, 'cli:compose');
      assert.equal(seen[0].context.project, tag);
    } finally {
      delete process.env.SM_HOOK_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flag OFF: byte-identity — zero fetches, JSONL row unchanged except ts, return value unchanged except ts', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (...args) => { fetchCalls++; return originalFetch(...args); };

    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-hook-events-off-'));
    // No .compose/compose.json at all → getSmartmemoryConfig returns {}.
    try {
      const row = appendEvent(dir, { tool: 'set_feature_status', code: 'FOO-1', from: 'A', to: 'B' });
      await flushPending();
      assert.equal(fetchCalls, 0);

      const text = readFileSync(join(dir, '.compose', 'data', 'feature-events.jsonl'), 'utf-8');
      const parsed = JSON.parse(text.trim().split('\n')[0]);
      const { ts: parsedTs, ...parsedRest } = parsed;
      const { ts: rowTs, ...rowRest } = row;
      assert.deepEqual(parsedRest, rowRest);
      assert.match(parsedTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(rowTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Return value carries the standard field set.
      assert.equal(row.tool, 'set_feature_status');
      assert.equal(row.code, 'FOO-1');
      assert.equal(row.actor, 'mcp:agent');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('appendGateLogEntry (gate-log-store hook)', () => {
  test('flag ON: durable write happens + one live ingest POST matches the renderer', async () => {
    const { server, seen } = makeStub();
    await listen(server);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-hook-gatelog-on-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_HOOK_KEY2 = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_HOOK_KEY2' },
    }));
    const logPath = join(dir, '.compose', 'data', 'gate-log.jsonl');
    process.env.COMPOSE_GATE_LOG = logPath;
    const originalRoot = getTargetRoot();
    switchProject(dir);
    try {
      const entry = { id: 'gid-hook-1', timestamp: '2026-07-03T10:00:00.000Z', decision: 'approve', feature_code: 'FOO-1' };
      appendGateLogEntry(entry);
      const text = readFileSync(logPath, 'utf-8');
      assert.match(text, /"id":"gid-hook-1"/);

      await waitForSeen(seen, 1);
      await flushPending();
      assert.equal(seen.length, 1);
      const tag = basename(dir);
      assert.equal(seen[0].content, renderGateLogContent(entry, tag));
      assert.equal(seen[0].context.origin, 'cli:compose');
      assert.equal(seen[0].context.project, tag);
    } finally {
      switchProject(originalRoot);
      delete process.env.SM_HOOK_KEY2;
      delete process.env.COMPOSE_GATE_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flag OFF: byte-identity — zero fetches, JSONL row unchanged', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (...args) => { fetchCalls++; return originalFetch(...args); };

    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-hook-gatelog-off-'));
    const logPath = join(dir, '.compose', 'data', 'gate-log.jsonl');
    process.env.COMPOSE_GATE_LOG = logPath;
    const originalRoot = getTargetRoot();
    switchProject(dir);
    try {
      const entry = { id: 'gid-hook-2', timestamp: '2026-07-03T10:00:00.000Z', decision: 'deny', feature_code: 'FOO-1' };
      appendGateLogEntry(entry);
      await flushPending();
      assert.equal(fetchCalls, 0);

      const text = readFileSync(logPath, 'utf-8');
      const parsed = JSON.parse(text.trim().split('\n')[0]);
      assert.deepEqual(parsed, entry);
    } finally {
      switchProject(originalRoot);
      delete process.env.COMPOSE_GATE_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cross-path idempotency: live emit then sync re-read the SAME persisted row', () => {
  test('live-emitted content and sync-emitted content for the identical row are byte-identical (a real dedupe backend would treat the re-sync as a no-op)', async () => {
    // Same "repeat-content -> unchanged" stub shape as test/smartmemory-sync.test.js,
    // so this test proves the load-bearing invariant end-to-end through the REAL
    // appendEvent hook AND the REAL runSync walker hitting the SAME backend --
    // not just two separate unit tests that each call the shared renderer once.
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { content, context } = JSON.parse(body || '{}');
        seen.push({ content, context });
        const unchanged = seen.filter((s) => s.content === content).length > 1;
        res.writeHead(200);
        res.end(JSON.stringify({ status: unchanged ? 'unchanged' : 'stored' }));
      });
    });
    await listen(server);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-hook-sync-crosscheck-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_XCHK_KEY = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_XCHK_KEY' },
    }));
    try {
      appendEvent(dir, { tool: 'set_feature_status', code: 'FOO-1', from: 'A', to: 'B' });
      await waitForSeen(seen, 1);
      await flushPending();
      assert.equal(seen.length, 1, 'live emit should have reached the stub');

      const result = await runSync({ cwd: dir });
      assert.equal(seen.length, 2, 'sync should re-post the same event');
      assert.equal(
        seen[1].content, seen[0].content,
        'live-emit and sync must render byte-identical content for the same persisted row',
      );
      assert.equal(result.unchanged, 1, 'the backend recognizes the re-synced item as a no-op (content-hash idempotent)');
      assert.equal(result.ingested, 0);
    } finally {
      delete process.env.SM_XCHK_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
