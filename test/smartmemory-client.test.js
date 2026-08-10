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

function makeStub({
  failStatus = null, quota = false, delayMs = 0, searchResults = [], malformed2xx = false,
  historyEnvelope = null,
} = {}) {
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
      if (req.url === '/memory/reasoning/challenge') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          new_assertion: parsed.assertion ?? '', has_conflicts: false,
          conflicts: [], related_facts_count: 0, overall_confidence: 1.0,
        }));
      }
      if (req.url.startsWith('/memory/reasoning/confidence-history/')) {
        res.writeHead(200);
        return res.end(JSON.stringify(historyEnvelope ?? {
          item_id: 'item-1', current_confidence: 0.5, challenge_count: 1,
          history: [{ timestamp: 't', old_confidence: 1.0, new_confidence: 0.5, decay_factor: 0.5, reason: 'manual_resolution:accept_new' }],
          history_count: 1,
        }));
      }
      if (req.url === '/memory/reasoning/resolve') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          auto_resolved: false, resolution: parsed.strategy ?? 'defer', confidence: 0.8,
          method: 'manual', evidence: null, actions_taken: ['decayed'],
        }));
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

// ── typed-record CRUD (COMP-FOH S01) ────────────────────────────────────────
//
// A second stub, because the CRUD routes need per-method behaviour the ingest
// stub does not model: a 404 that must become `null` rather than a throw, a
// method-aware response body, and header capture for X-Workspace-Id.

function makeCrudStub({ items = {}, failStatus = null, malformed2xx = false, missingField = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      seen.push({
        url: req.url,
        method: req.method,
        body: parsed,
        auth: req.headers.authorization,
        workspace: req.headers['x-workspace-id'],
      });

      if (malformed2xx) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>nope</html>');
      }
      if (failStatus) { res.writeHead(failStatus); return res.end('{"error":"x"}'); }

      const [path, query] = req.url.split('?');

      if (path === '/memory/add') {
        res.writeHead(200); // 200, NOT 201 — C9
        return res.end(JSON.stringify(missingField ? { status: 'created' } : { id: 'item-new', status: 'created' }));
      }
      if (path === '/memory/list') {
        const qs = new URLSearchParams(query || '');
        let all = Object.values(items);
        const k = qs.get('metadata_key');
        const v = qs.get('metadata_value');
        if (k) all = all.filter((it) => String(it.metadata?.[k]) === v);
        const offset = Number(qs.get('offset') ?? 0);
        const limit = Number(qs.get('limit') ?? 50);
        res.writeHead(200);
        return res.end(JSON.stringify(
          missingField
            ? { total: all.length }
            : { items: all.slice(offset, offset + limit), total: all.length, limit, offset },
        ));
      }
      const m = path.match(/^\/memory\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'GET') {
          if (!items[id]) { res.writeHead(404); return res.end('{"detail":"not found"}'); }
          res.writeHead(200);
          return res.end(JSON.stringify(items[id]));
        }
        if (req.method === 'PATCH' || req.method === 'DELETE') {
          if (!items[id]) { res.writeHead(404); return res.end('{"detail":"not found"}'); }
          res.writeHead(200);
          return res.end(JSON.stringify({ status: 'ok', item_id: id }));
        }
      }
      res.writeHead(404);
      res.end('{"detail":"no route"}');
    });
  });
  return { server, seen };
}

async function withCrudStub(opts, fn) {
  const { server, seen } = makeCrudStub(opts);
  await listen(server);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.SM_TEST_KEY = 'crud-key';
  try {
    await fn({ baseUrl, seen });
  } finally {
    delete process.env.SM_TEST_KEY;
    server.close();
  }
}

const crudCfg = (baseUrl, extra = {}) => ({ baseUrl, apiKeyEnv: 'SM_TEST_KEY', ...extra });

describe('createSmartmemoryClient — typed-record CRUD', () => {
  test('createItem posts the wire shape, defaults use_pipeline to false, returns id', async () => {
    await withCrudStub({}, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl, { workspaceId: 'ws-1' }));
      const out = await client.createItem({
        content: 'rendered text',
        memoryType: 'fluid_idea',
        metadata: { handle: 'IDEA-1' },
      });
      assert.equal(out.id, 'item-new');
      assert.equal(seen[0].method, 'POST');
      assert.equal(seen[0].url, '/memory/add');
      assert.deepEqual(seen[0].body, {
        content: 'rendered text',
        memory_type: 'fluid_idea',
        metadata: { handle: 'IDEA-1' },
        use_pipeline: false,
      });
    });
  });

  test('every CRUD call carries X-Workspace-Id when configured', async () => {
    await withCrudStub({ items: { a: { item_id: 'a', metadata: {} } } }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl, { workspaceId: 'ws-42' }));
      await client.createItem({ content: 'c', memoryType: 'fluid_idea' });
      await client.getItem('a');
      await client.listItems();
      await client.updateItem('a', { metadata: { x: 1 } });
      await client.deleteItem('a');
      assert.equal(seen.length, 5);
      for (const s of seen) assert.equal(s.workspace, 'ws-42');
    });
  });

  test('workspaceId omitted → header absent, not the string "undefined"', async () => {
    await withCrudStub({}, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await client.createItem({ content: 'c', memoryType: 'fluid_idea' });
      assert.equal(seen[0].workspace, undefined);
    });
  });

  test('getItem on a missing id returns null, does NOT throw', async () => {
    await withCrudStub({}, async ({ baseUrl }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      assert.equal(await client.getItem('nope'), null);
    });
  });

  test('updateItem and deleteItem on a missing id DO throw 404', async () => {
    await withCrudStub({}, async ({ baseUrl }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await assert.rejects(
        () => client.updateItem('nope', { metadata: {} }),
        (err) => err instanceof SmartmemoryHttpError && err.status === 404,
      );
      await assert.rejects(
        () => client.deleteItem('nope'),
        (err) => err instanceof SmartmemoryHttpError && err.status === 404,
      );
    });
  });

  test('listItems filters on a single metadata pair and honours offset/limit', async () => {
    const items = {};
    for (let i = 1; i <= 120; i += 1) items[`i${i}`] = { item_id: `i${i}`, metadata: { ns: 'fluid' } };
    items.other = { item_id: 'other', metadata: { ns: 'something-else' } };
    await withCrudStub({ items }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      const page = await client.listItems({ metadataKey: 'ns', metadataValue: 'fluid', limit: 50, offset: 0 });
      assert.equal(page.total, 120);
      assert.equal(page.items.length, 50);
      const next = await client.listItems({ metadataKey: 'ns', metadataValue: 'fluid', limit: 50, offset: 100 });
      assert.equal(next.items.length, 20);
      assert.ok(seen[0].url.includes('metadata_key=ns'));
      assert.ok(seen[0].url.includes('metadata_value=fluid'));
    });
  });

  test('listItems refuses half a metadata filter pair before any request', async () => {
    await withCrudStub({}, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await assert.rejects(
        () => client.listItems({ metadataKey: 'ns' }),
        (err) => err instanceof SmartmemoryHttpError && err.status === 0,
      );
      assert.equal(seen.length, 0);
    });
  });

  test('updateItem sends only the fields given, and refuses an empty patch', async () => {
    await withCrudStub({ items: { a: { item_id: 'a', metadata: {} } } }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await client.updateItem('a', { metadata: { k: 'v' } });
      assert.equal(seen[0].method, 'PATCH');
      assert.deepEqual(seen[0].body, { metadata: { k: 'v' } });
      await assert.rejects(
        () => client.updateItem('a', {}),
        (err) => err instanceof SmartmemoryHttpError && err.status === 0,
      );
      assert.equal(seen.length, 1);
    });
  });

  test('deleteItem passes cleanup_orphans only when asked', async () => {
    await withCrudStub({ items: { a: { item_id: 'a', metadata: {} } } }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await client.deleteItem('a');
      await client.deleteItem('a', { cleanupOrphans: true });
      assert.equal(seen[0].url, '/memory/a');
      assert.equal(seen[1].url, '/memory/a?cleanup_orphans=true');
      assert.equal(seen[1].method, 'DELETE');
    });
  });

  test('item ids are URL-encoded, so a slash cannot forge a path', async () => {
    await withCrudStub({}, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await client.getItem('a/../../evil');
      assert.equal(seen[0].url, '/memory/a%2F..%2F..%2Fevil');
    });
  });

  test('missing env key throws before any fetch, on every CRUD method', async () => {
    await withCrudStub({}, async ({ baseUrl, seen }) => {
      delete process.env.SM_TEST_KEY;
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
      for (const call of [
        () => client.createItem({ content: 'c', memoryType: 'fluid_idea' }),
        () => client.getItem('a'),
        () => client.listItems(),
        () => client.updateItem('a', { metadata: {} }),
        () => client.deleteItem('a'),
      ]) {
        await assert.rejects(call, (err) => err instanceof SmartmemoryHttpError && err.status === 0);
      }
      assert.equal(seen.length, 0);
    });
  });

  test('a 2xx HTML body is malformed-response, not a silent success', async () => {
    await withCrudStub({ malformed2xx: true }, async ({ baseUrl }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await assert.rejects(
        () => client.createItem({ content: 'c', memoryType: 'fluid_idea' }),
        (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
      );
    });
  });

  test('a 2xx missing the field the caller reads is malformed-response', async () => {
    await withCrudStub({ missingField: true }, async ({ baseUrl }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await assert.rejects(
        () => client.createItem({ content: 'c', memoryType: 'fluid_idea' }),
        (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
      );
      await assert.rejects(
        () => client.listItems(),
        (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
      );
    });
  });

  test('a 500 surfaces its status', async () => {
    await withCrudStub({ failStatus: 500 }, async ({ baseUrl }) => {
      const client = createSmartmemoryClient(crudCfg(baseUrl));
      await assert.rejects(
        () => client.getItem('a'),
        (err) => err instanceof SmartmemoryHttpError && err.status === 500,
      );
    });
  });

  test('the shipped pipeline surface is untouched', async () => {
    const client = createSmartmemoryClient({ baseUrl: 'http://127.0.0.1:1' });
    for (const m of ['health', 'ingest', 'search', 'createItem', 'getItem', 'listItems', 'updateItem', 'deleteItem']) {
      assert.equal(typeof client[m], 'function', `${m} should be exposed`);
    }
  });
});

describe('createSmartmemoryClient.searchItems', () => {
  function makeSearchStub({ results = [], failStatus = null, missingField = false } = {}) {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
        seen.push({ url: req.url, method: req.method, body: parsed, workspace: req.headers['x-workspace-id'] });
        if (failStatus) { res.writeHead(failStatus); return res.end('{"error":"x"}'); }
        res.writeHead(200);
        res.end(JSON.stringify(missingField ? { total: 0 } : { results }));
      });
    });
    return { server, seen };
  }

  async function withSearchStub(opts, fn) {
    const { server, seen } = makeSearchStub(opts);
    await listen(server);
    servers.push(server);
    process.env.SM_TEST_KEY = 'k';
    try {
      await fn({ baseUrl: `http://127.0.0.1:${server.address().port}`, seen });
    } finally {
      delete process.env.SM_TEST_KEY;
      server.close();
    }
  }

  test('sends channel_weights:{} on every request — not optional', async () => {
    await withSearchStub({ results: [{ item_id: 'a' }] }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY', workspaceId: 'ws-1' });
      await client.searchItems('anything');
      await client.searchItems('again', { topK: 20 });
      assert.equal(seen.length, 2);
      for (const s of seen) {
        assert.deepEqual(
          s.body.channel_weights, {},
          'omitting it lets the API key\'s recall profile disable retrieval channels',
        );
      }
    });
  });

  test('is workspace-scoped, unlike the shipped search()', async () => {
    await withSearchStub({ results: [] }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY', workspaceId: 'ws-9' });
      await client.searchItems('q');
      await client.search('q');
      assert.equal(seen[0].workspace, 'ws-9', 'searchItems must carry the workspace');
      assert.equal(seen[1].workspace, undefined, 'search() is deliberately unchanged');
    });
  });

  test('passes top_k and memory_type only when given', async () => {
    await withSearchStub({ results: [] }, async ({ baseUrl, seen }) => {
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
      await client.searchItems('q');
      await client.searchItems('q', { topK: 40, memoryType: 'fluid_idea' });
      assert.deepEqual(seen[0].body, { query: 'q', channel_weights: {} });
      assert.equal(seen[1].body.top_k, 40);
      assert.equal(seen[1].body.memory_type, 'fluid_idea');
    });
  });

  test('a 2xx without a results array is malformed-response', async () => {
    await withSearchStub({ missingField: true }, async ({ baseUrl }) => {
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
      await assert.rejects(
        () => client.searchItems('q'),
        (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
      );
    });
  });

  test('missing env key throws before any fetch', async () => {
    await withSearchStub({}, async ({ baseUrl, seen }) => {
      delete process.env.SM_TEST_KEY;
      const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
      await assert.rejects(
        () => client.searchItems('q'),
        (err) => err instanceof SmartmemoryHttpError && err.status === 0,
      );
      assert.equal(seen.length, 0);
    });
  });
});

describe('createSmartmemoryClient.challenge', () => {
  test('sends assertion, memory_type and use_llm; returns the raw response', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      await withStub({}, async ({ baseUrl, seen }) => {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        const raw = await client.challenge('X is not Y', { memoryType: 'fluid_decision', useLlm: false });
        assert.equal(raw.has_conflicts, false);
        assert.deepEqual(seen.at(-1).body, { assertion: 'X is not Y', memory_type: 'fluid_decision', use_llm: false });
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });

  test('a 2xx with a non-JSON body is rejected as malformed', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      await withStub({ malformed2xx: true }, async ({ baseUrl }) => {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        await assert.rejects(
          () => client.challenge('x', { memoryType: 'fluid_decision' }),
          (err) => err instanceof SmartmemoryHttpError && /non-JSON body/.test(err.message),
        );
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });

  test('per-call timeoutMs overrides a tiny client default (the load-bearing FOH-3 fix)', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      await withStub({ delayMs: 60 }, async ({ baseUrl }) => {
        // Client default is 20ms; the challenge route delays 60ms.
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY', timeoutMs: 20 });
        // No override → the 20ms default aborts before the 60ms response.
        await assert.rejects(
          () => client.challenge('x', { memoryType: 'fluid_decision' }),
          (err) => err instanceof SmartmemoryHttpError && err.status === 0,
        );
        // Per-call override (2s) beats the delay → succeeds. If the override were
        // dropped, this would time out exactly like the call above.
        const raw = await client.challenge('x', { memoryType: 'fluid_decision', timeoutMs: 2000 });
        assert.equal(raw.has_conflicts, false);
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });
});

describe('createSmartmemoryClient.confidenceHistory (FOH-4)', () => {
  test('GETs the item path and returns the full envelope', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      await withStub({}, async ({ baseUrl, seen }) => {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        const raw = await client.confidenceHistory('item/1'); // needs encoding
        assert.equal(raw.current_confidence, 0.5);
        assert.equal(raw.challenge_count, 1);
        assert.equal(seen.at(-1).url, '/memory/reasoning/confidence-history/item%2F1');
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });

  test('a shaped-but-partial envelope is refused as malformed (missing challenge_count)', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      // The destructive-write classifier reads challenge_count from this
      // envelope; a 2xx without it must never reach the provider.
      const partial = { item_id: 'item-1', current_confidence: 0.5, history: [], history_count: 0 };
      await withStub({ historyEnvelope: partial }, async ({ baseUrl }) => {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        await assert.rejects(
          () => client.confidenceHistory('item-1'),
          (err) => err instanceof SmartmemoryHttpError && err.kind === 'malformed-response',
        );
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });
});

describe('createSmartmemoryClient.resolveConflict (FOH-4)', () => {
  test('POSTs /resolve with ALL THREE cascade flags explicitly false (route defaults are true)', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      await withStub({}, async ({ baseUrl, seen }) => {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY' });
        const raw = await client.resolveConflict({ existingItemId: 'item-9', newFact: 'X supersedes', strategy: 'accept_new' });
        assert.equal(raw.auto_resolved, false);
        assert.deepEqual(seen.at(-1).body, {
          existing_item_id: 'item-9', new_fact: 'X supersedes',
          auto_resolve: false, strategy: 'accept_new', use_llm: false, use_wikipedia: false,
        });
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });

  test('the 8s default timeout survives a tiny client default (an abort here is an ambiguous outcome)', async () => {
    process.env.SM_TEST_KEY = 'k';
    try {
      await withStub({ delayMs: 60 }, async ({ baseUrl }) => {
        // Client default 20ms would abort a 60ms response; the wrapper's own
        // 8s default must win without the caller passing anything.
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_TEST_KEY', timeoutMs: 20 });
        const raw = await client.resolveConflict({ existingItemId: 'item-9', newFact: 'x', strategy: 'accept_new' });
        assert.equal(raw.auto_resolved, false);
      });
    } finally { delete process.env.SM_TEST_KEY; }
  });
});
