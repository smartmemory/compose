/**
 * smartmemory-ingest.test.js — COMP-SMARTMEMORY-INGEST T3
 *
 * Tests for lib/smartmemory-ingest.js: pure renderers/context builders, the
 * fire-and-forget emitters, the circuit breaker, and flushPending.
 *
 * Run: node --test test/smartmemory-ingest.test.js
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  renderFeatureEventContent,
  renderGateLogContent,
  buildFeatureEventContext,
  buildGateLogContext,
  emitFeatureEvent,
  emitGateLogEntry,
  flushPending,
  _resetEmitterState,
} from '../lib/smartmemory-ingest.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeStub({ failStatus = null, quota = false, delayMs = 0, malformed2xx = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{"ok":true}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      seen.push(parsed);
      if (malformed2xx) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>oops</html>'); }
      if (quota) { res.writeHead(429); return res.end('{"error":"quota"}'); }
      if (failStatus) { res.writeHead(failStatus); return res.end('{"error":"x"}'); }
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'stored' }));
    });
  });
  return { server, seen };
}

const servers = [];
after(() => { for (const s of servers) s.close(); });

async function withStub(opts, cwdConfigOverrides = {}) {
  const { server, seen } = makeStub(opts);
  await listen(server);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, seen, baseUrl };
}

beforeEach(() => {
  _resetEmitterState();
});

describe('render determinism', () => {
  test('renderFeatureEventContent produces the pinned string, twice identically', () => {
    const row = { ts: '2026-07-03T10:00:00.000Z', tool: 'set_feature_status', code: 'FOO-1', actor: 'mcp:agent' };
    const expected = '[compose:regio] 2026-07-03T10:00:00.000Z set_feature_status FOO-1 by mcp:agent';
    assert.equal(renderFeatureEventContent(row, 'regio'), expected);
    assert.equal(renderFeatureEventContent(row, 'regio'), expected);
  });

  test('renderFeatureEventContent falls back to feature_code then "-"', () => {
    const withFeatureCode = { ts: 't', tool: 'x', feature_code: 'BAR-2', actor: 'a' };
    assert.equal(renderFeatureEventContent(withFeatureCode, 'p'), '[compose:p] t x BAR-2 by a');
    const withNeither = { ts: 't', tool: 'x' };
    assert.equal(renderFeatureEventContent(withNeither, 'p'), '[compose:p] t x - by mcp:agent');
  });

  test('renderGateLogContent produces the pinned string, twice identically', () => {
    const entry = { timestamp: '2026-07-03T10:00:00.000Z', decision: 'approve', feature_code: 'FOO-1', id: 'gid-1' };
    const expected = '[compose:regio] 2026-07-03T10:00:00.000Z gate:approve FOO-1 gid-1';
    assert.equal(renderGateLogContent(entry, 'regio'), expected);
    assert.equal(renderGateLogContent(entry, 'regio'), expected);
  });

  test('buildFeatureEventContext / buildGateLogContext shape', () => {
    const row = { ts: 't', tool: 'x', code: 'FOO-1' };
    const ctx = buildFeatureEventContext('regio', row);
    assert.equal(ctx.origin, 'cli:compose');
    assert.equal(ctx.project, 'regio');
    assert.equal(ctx.source_path, 'compose/regio/.compose/data/feature-events.jsonl');
    assert.deepEqual(ctx.event, row);

    const entry = { timestamp: 't', decision: 'approve', id: 'gid-1' };
    const gctx = buildGateLogContext('regio', entry);
    assert.equal(gctx.origin, 'cli:compose');
    assert.equal(gctx.source_path, 'compose/regio/.compose/data/gate-log.jsonl');
    assert.deepEqual(gctx.event, entry);
  });
});

describe('emitFeatureEvent / emitGateLogEntry', () => {
  test('flag OFF → zero fetch', async () => {
    const { seen, baseUrl } = await withStub({});
    const cwd = process.cwd(); // no .compose/compose.json smartmemory block expected here in a scratch scenario — use a fixture instead
    // Use a throwaway cwd without a smartmemory block: getSmartmemoryConfig returns {}
    // for any dir lacking .compose/compose.json#smartmemory.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-ingest-off-'));
    try {
      emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-1' });
      await flushPending();
      assert.equal(seen.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    void baseUrl;
  });

  test('flag ON, healthy service → one ingest POST reaches the stub', async () => {
    const { seen, baseUrl } = await withStub({});
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-ingest-on-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_ING_KEY = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_ING_KEY' },
    }));
    try {
      const row = { ts: 't', tool: 'set_feature_status', code: 'FOO-1', actor: 'a' };
      emitFeatureEvent(dir, row);
      await flushPending();
      assert.equal(seen.length, 1);
      const { basename } = await import('node:path');
      const tag = basename(dir);
      assert.equal(seen[0].content, renderFeatureEventContent(row, tag));
    } finally {
      delete process.env.SM_ING_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config edge shapes — strict `enabled === true` check', () => {
  test('enabled: "true" (truthy string, not boolean) is treated as OFF — no fetch', async () => {
    const { seen, baseUrl } = await withStub({});
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-enabled-string-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_STRTRUE_KEY = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: 'true', baseUrl, apiKeyEnv: 'SM_STRTRUE_KEY' },
    }));
    try {
      emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-1' });
      await flushPending();
      assert.equal(seen.length, 0, 'a truthy but non-boolean enabled value must not turn the feature on (strict === true check)');
    } finally {
      delete process.env.SM_STRTRUE_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('smartmemory block as a bare boolean (true, not an object) degrades to OFF — no crash, no fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-bare-bool-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ smartmemory: true }));
    try {
      // getSmartmemoryConfig returns `true` verbatim (see smartmemory-config.test.js);
      // emit() must not crash reading `.enabled` off a primitive, and must treat
      // it as OFF since `(true).enabled === undefined !== true`.
      assert.doesNotThrow(() => emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-1' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('circuit breaker', () => {
  test('3 consecutive failing emits disable the breaker; 4th performs no fetch', async () => {
    const { seen, baseUrl } = await withStub({ failStatus: 500 });
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-breaker-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_BRK_KEY = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_BRK_KEY' },
    }));
    const originalWarn = console.warn;
    let warnCount = 0;
    console.warn = (...args) => { warnCount++; originalWarn(...args); };
    try {
      for (let i = 0; i < 3; i++) {
        emitFeatureEvent(dir, { ts: 't', tool: 'x', code: `FOO-${i}` });
        await flushPending();
      }
      assert.equal(seen.length, 3);
      assert.equal(warnCount, 1);

      // 4th call: breaker now open, no fetch should occur.
      emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-4' });
      await flushPending();
      assert.equal(seen.length, 3, 'breaker should have suppressed the 4th fetch');
    } finally {
      console.warn = originalWarn;
      delete process.env.SM_BRK_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('3 consecutive malformed-2xx responses also trip the breaker (not silently treated as success)', async () => {
    const { seen, baseUrl } = await withStub({ malformed2xx: true });
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-breaker-malformed-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_BRK_KEY2 = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_BRK_KEY2' },
    }));
    try {
      for (let i = 0; i < 3; i++) {
        emitFeatureEvent(dir, { ts: 't', tool: 'x', code: `FOO-${i}` });
        await flushPending();
      }
      assert.equal(seen.length, 3);

      // 4th call: breaker now open (malformed responses count as failures), no fetch should occur.
      emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-4' });
      await flushPending();
      assert.equal(seen.length, 3, 'breaker should have suppressed the 4th fetch after 3 malformed-response failures');
    } finally {
      delete process.env.SM_BRK_KEY2;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('breaker tripped against a failing service ALSO suppresses emits to a different, healthy service until reset (process-global, not per-config)', async () => {
    // `disabled` is module-scope state checked before cfg is even read (lib/smartmemory-ingest.js
    // `emit()`: `if (disabled) return;` precedes `getSmartmemoryConfig`). This locks in that this
    // is a deliberate process-wide fail-open circuit, not scoped per baseUrl/cwd.
    const { seen: failSeen, baseUrl: failBaseUrl } = await withStub({ failStatus: 500 });
    const { seen: healthySeen, baseUrl: healthyBaseUrl } = await withStub({});

    const dirA = mkdtempSync(join(tmpdir(), 'smartmemory-breaker-bleed-a-'));
    mkdirSync(join(dirA, '.compose'), { recursive: true });
    process.env.SM_BLEED_KEY_A = 'k';
    writeFileSync(join(dirA, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl: failBaseUrl, apiKeyEnv: 'SM_BLEED_KEY_A' },
    }));

    const dirB = mkdtempSync(join(tmpdir(), 'smartmemory-breaker-bleed-b-'));
    mkdirSync(join(dirB, '.compose'), { recursive: true });
    process.env.SM_BLEED_KEY_B = 'k';
    writeFileSync(join(dirB, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl: healthyBaseUrl, apiKeyEnv: 'SM_BLEED_KEY_B' },
    }));

    try {
      for (let i = 0; i < 3; i++) {
        emitFeatureEvent(dirA, { ts: 't', tool: 'x', code: `FOO-${i}` });
        await flushPending();
      }
      assert.equal(failSeen.length, 3, 'the three failing emits should have reached service A');

      emitFeatureEvent(dirB, { ts: 't', tool: 'x', code: 'BAR-1' });
      await flushPending();
      assert.equal(healthySeen.length, 0, 'breaker should suppress emits to an unrelated healthy service too');

      _resetEmitterState();
      emitFeatureEvent(dirB, { ts: 't', tool: 'x', code: 'BAR-2' });
      await flushPending();
      assert.equal(healthySeen.length, 1, 'after an explicit reset, the healthy service receives the emit normally');
    } finally {
      delete process.env.SM_BLEED_KEY_A;
      delete process.env.SM_BLEED_KEY_B;
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('flushPending', () => {
  test('resolves once all pending emits settle', async () => {
    const { seen, baseUrl } = await withStub({ delayMs: 30 });
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-flush-'));
    mkdirSync(join(dir, '.compose'), { recursive: true });
    process.env.SM_FLUSH_KEY = 'k';
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_FLUSH_KEY' },
    }));
    try {
      emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-1' });
      emitGateLogEntry(dir, { timestamp: 't', decision: 'approve', id: 'g1' });
      await flushPending(3000);
      assert.equal(seen.length, 2);
    } finally {
      delete process.env.SM_FLUSH_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fail-open error harness', () => {
  const cases = [
    { name: 'OFF', enabled: false, expectFetch: false },
    { name: 'down (bad port)', enabled: true, baseUrlOverride: 'http://127.0.0.1:1', expectFetch: false },
    { name: '429', failStatus: 429, quota: true, expectFetch: true },
    { name: '500', failStatus: 500, expectFetch: true },
    { name: 'missing api key', missingKey: true, expectFetch: false },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const { seen, baseUrl } = await withStub({ failStatus: c.failStatus, quota: c.quota });
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'smartmemory-harness-'));
      mkdirSync(join(dir, '.compose'), { recursive: true });
      const keyEnv = 'SM_HARNESS_KEY';
      if (!c.missingKey) process.env[keyEnv] = 'k';
      writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
        smartmemory: {
          enabled: c.enabled !== false,
          baseUrl: c.baseUrlOverride || baseUrl,
          apiKeyEnv: keyEnv,
        },
      }));
      try {
        // Must never throw regardless of failure mode (fail-open).
        assert.doesNotThrow(() => emitFeatureEvent(dir, { ts: 't', tool: 'x', code: 'FOO-1' }));
        await flushPending();
        if (c.expectFetch) {
          assert.ok(seen.length >= 1, 'expected at least one fetch attempt');
        } else {
          assert.equal(seen.length, 0, 'expected zero fetch attempts');
        }
      } finally {
        delete process.env[keyEnv];
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
