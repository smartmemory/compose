/**
 * smartmemory-client.test.js — COMP-SMARTMEMORY-INGEST T2
 *
 * Table-driven tests for lib/smartmemory-client.js against a raw node:http
 * stub (same pattern as test/cli-remote.test.js — no express, we own the
 * server object and just start it listening).
 *
 * Run: node --test test/smartmemory-client.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSmartmemoryClient, SmartmemoryHttpError } from '../lib/smartmemory-client.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeStub({ failStatus = null, quota = false, delayMs = 0, searchResults = [], malformed2xx = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      return res.end('{"ok":true}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      seen.push({ url: req.url, body: parsed, auth: req.headers.authorization });
      // A 2xx whose body is not the expected JSON shape (e.g. an upstream
      // proxy/error page served with a 200) — used to test malformed-response
      // handling distinct from non-2xx failures.
      if (malformed2xx) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Service Temporarily Unavailable</body></html>');
      }
      if (req.url.startsWith('/memory/search')) {
        res.writeHead(200);
        return res.end(JSON.stringify({ results: searchResults }));
      }
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

async function withStub(opts, fn) {
  const { server, seen } = makeStub(opts);
  await listen(server);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, seen });
  } finally {
    server.close();
  }
}

describe('createSmartmemoryClient.health', () => {
  test('200 → { ok:true, status:200 }', async () => {
    await withStub({}, async ({ baseUrl }) => {
      const client = createSmartmemoryClient({ baseUrl });
      const result = await client.health();
      assert.deepEqual(result, { ok: true, status: 200 });
    });
  });

  test('server down (bad port) → { ok:false }, never throws', async () => {
    const client = createSmartmemoryClient({ baseUrl: 'http://127.0.0.1:1' });
    const result = await client.health();
    assert.equal(result.ok, false);
  });
});

describe('createSmartmemoryClient.ingest', () => {
  test('200 → { status, unchanged, raw }', async () => {
    await withStub({}, async ({ baseUrl, seen }) => {
      process.env.SM_TEST_KEY = 'secret-key';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        const result = await client.ingest('hello', { origin: 'cli:compose' });
        assert.equal(result.status, 'stored');
        assert.equal(result.unchanged, false);
        assert.deepEqual(result.raw, { status: 'stored' });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].auth, 'Bearer secret-key');
        assert.equal(seen[0].url, '/memory/ingest?mode=sync');
        assert.deepEqual(seen[0].body, { content: 'hello', context: { origin: 'cli:compose' } });
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('missing env key → throws SmartmemoryHttpError(status 0) before any fetch', async () => {
    await withStub({}, async ({ baseUrl, seen }) => {
      delete process.env.SM_MISSING_KEY;
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_MISSING_KEY' });
      await assert.rejects(
        () => client.ingest('hello', {}),
        (err) => err instanceof SmartmemoryHttpError && err.status === 0,
      );
      assert.equal(seen.length, 0);
    });
  });

  test('429 → throws, .status === 429', async () => {
    await withStub({ quota: true }, async ({ baseUrl }) => {
      process.env.SM_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        await assert.rejects(
          () => client.ingest('hello', {}),
          (err) => err instanceof SmartmemoryHttpError && err.status === 429,
        );
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('500 → throws, .status === 500', async () => {
    await withStub({ failStatus: 500 }, async ({ baseUrl }) => {
      process.env.SM_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        await assert.rejects(
          () => client.ingest('hello', {}),
          (err) => err instanceof SmartmemoryHttpError && err.status === 500,
        );
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('timeout: stub delays past timeoutMs → rejects', async () => {
    await withStub({ delayMs: 200 }, async ({ baseUrl }) => {
      process.env.SM_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY', timeoutMs: 20 });
        await assert.rejects(() => client.ingest('hello', {}));
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('2xx with a non-JSON/malformed body (e.g. an HTML error page) throws, not silently succeeds', async () => {
    await withStub({ malformed2xx: true }, async ({ baseUrl }) => {
      process.env.SM_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        await assert.rejects(
          () => client.ingest('hello', {}),
          (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
        );
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('2xx with valid JSON but missing the required "status" field throws malformed-response', async () => {
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true })); // valid JSON, no `status` field
      });
    });
    await listen(server);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.SM_TEST_KEY = 'k';
    try {
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
      await assert.rejects(
        () => client.ingest('hello', {}),
        (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
      );
    } finally {
      delete process.env.SM_TEST_KEY;
      server.close();
    }
  });
});

describe('createSmartmemoryClient.search', () => {
  test('200 → passthrough object verbatim', async () => {
    const hits = [{ content: 'x', score: 0.9, memory_type: 'event', context: { project: 'p' } }];
    await withStub({ searchResults: hits }, async ({ baseUrl }) => {
      process.env.SM_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        const result = await client.search('query text');
        assert.deepEqual(result, { results: hits });
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('2xx with a non-JSON/malformed body throws, not silently returns {}', async () => {
    await withStub({ malformed2xx: true }, async ({ baseUrl }) => {
      process.env.SM_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        await assert.rejects(
          () => client.search('query text'),
          (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
        );
      } finally {
        delete process.env.SM_TEST_KEY;
      }
    });
  });

  test('2xx with valid JSON but missing the required "results" array throws malformed-response', async () => {
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true })); // valid JSON, no `results` array
      });
    });
    await listen(server);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.SM_TEST_KEY = 'k';
    try {
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
      await assert.rejects(
        () => client.search('query text'),
        (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
      );
    } finally {
      delete process.env.SM_TEST_KEY;
      server.close();
    }
  });
});
