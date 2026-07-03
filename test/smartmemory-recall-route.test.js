/**
 * Integration test for GET /api/smartmemory/recall — real Express app on an
 * ephemeral port, all deps (getConfig/createClient/readFeature/
 * resolveFeaturesPath/resolveProjectTag) INJECTED so no disk fixtures or real
 * SmartMemory backend are needed. req.workspace is injected by a tiny test
 * middleware, mirroring test/qa-scope-routes.test.js.
 *
 * Covers the four response-envelope cases from
 * docs/features/COMP-SMARTMEMORY-RECALL/blueprint.md: OFF, ON+empty-code
 * (probe), ON+healthy, ON+unreachable — plus the degrade-never-fail
 * (readFeature throws), query-construction (description present/absent), and
 * snippet-truncation-boundary cases from the blueprint's Test Plan.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachSmartmemoryRoutes } = await import(`${ROOT}/server/smartmemory-routes.js`);

function startServer({ workspace, deps = {} }) {
  const app = express();
  app.use((req, _res, nextFn) => {
    req.workspace = workspace;
    nextFn();
  });
  attachSmartmemoryRoutes(app, deps);
  return new Promise((res) => {
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      res({ httpServer, baseUrl: `http://127.0.0.1:${httpServer.address().port}` });
    });
  });
}

async function getRecall(baseUrl, qs = '') {
  const r = await fetch(`${baseUrl}/api/smartmemory/recall${qs}`, { headers: { Connection: 'close' } });
  return { status: r.status, body: await r.json() };
}

function trackingDeps({ getConfig, readFeature, resolveFeaturesPath, resolveProjectTag, search } = {}) {
  const calls = { createClient: [], search: [], readFeature: [] };
  const deps = {};
  if (getConfig) deps.getConfig = getConfig;
  if (readFeature) {
    deps.readFeature = (...args) => {
      calls.readFeature.push(args);
      return readFeature(...args);
    };
  }
  if (resolveFeaturesPath) deps.resolveFeaturesPath = resolveFeaturesPath;
  if (resolveProjectTag) deps.resolveProjectTag = resolveProjectTag;
  if (search) {
    deps.createClient = (cfg) => {
      calls.createClient.push(cfg);
      return {
        search: async (q, o) => {
          calls.search.push([q, o]);
          return search(q, o);
        },
      };
    };
  }
  return { deps, calls };
}

describe('GET /api/smartmemory/recall', () => {
  const cleanups = [];
  after(() => cleanups.forEach((fn) => fn()));
  function track(server) {
    cleanups.push(() => server.httpServer.close());
  }

  test('flag OFF → {enabled:false}, zero client calls', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: false }),
      search: () => { throw new Error('should not be called'); },
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false });
    assert.equal(calls.createClient.length, 0);
    assert.equal(calls.search.length, 0);
  });

  test('flag OFF via absent block ({}) → {enabled:false}', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({}),
      search: () => { throw new Error('should not be called'); },
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false });
    assert.equal(calls.createClient.length, 0);
  });

  test('no workspace root → {enabled:false}, no client', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      search: () => { throw new Error('should not be called'); },
    });
    const server = await startServer({ workspace: undefined, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false });
    assert.equal(calls.createClient.length, 0);
  });

  test('empty featureCode (probe) → results:[], invalidFeatureCode:true, no query issued', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      search: () => { throw new Error('should not be called'); },
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: true, available: true, results: [], invalidFeatureCode: true });
    assert.equal(calls.createClient.length, 0);
    assert.equal(calls.search.length, 0);
  });

  test('whitespace featureCode → same as empty', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      search: () => { throw new Error('should not be called'); },
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=%20%20');
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: true, available: true, results: [], invalidFeatureCode: true });
    assert.equal(calls.createClient.length, 0);
  });

  test('ON healthy → full envelope, description-joined query, readFeature called with resolved absolute features dir', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      readFeature: () => ({ description: 'Desc words' }),
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      search: () => ([
        {
          id: 'm1',
          content: 'x'.repeat(400),
          score: 0.9,
          memory_type: 'decision',
          context: { event: { ts: '2026-05-02T16:11:11Z' }, project: 'projA' },
        },
      ]),
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.available, true);
    assert.equal(body.featureCode, 'COMP-X');
    assert.equal(body.project, 'projB');
    assert.equal(body.results.length, 1);
    const [r] = body.results;
    assert.equal(r.id, 'm1');
    assert.equal(r.snippet.length, 281);
    assert.ok(r.snippet.endsWith('…'));
    assert.equal(r.score, 0.9);
    assert.equal(r.memoryType, 'decision');
    assert.equal(r.ts, '2026-05-02T16:11:11Z');
    assert.equal(r.project, 'projA');

    assert.deepEqual(calls.search, [['COMP-X Desc words', { top_k: 10 }]]);
    assert.deepEqual(calls.readFeature, [['/repo/one', 'COMP-X', '/abs/features']]);
  });

  test('ON, feature absent (readFeature → null) → query falls back to plain code', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      readFeature: () => null,
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      search: () => ([]),
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.deepEqual(calls.search, [['COMP-X', { top_k: 10 }]]);
  });

  test('ON, feature present but no description → plain code', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      readFeature: () => ({}),
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      search: () => ([]),
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.deepEqual(calls.search, [['COMP-X', { top_k: 10 }]]);
  });

  test('ON unreachable → {enabled:true, available:false, error}, no 500', async () => {
    const deps = {
      getConfig: () => ({ enabled: true }),
      readFeature: () => null,
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      createClient: () => ({
        search: async () => { throw new Error('ECONNREFUSED'); },
      }),
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.available, false);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  });

  test('ON, client.search() throws on a malformed/non-JSON response → classified unreachable (available:false), not empty results', async () => {
    // Locks the Codex round-3 finding: the shared client (lib/smartmemory-client.js)
    // now throws SmartmemoryHttpError when a 2xx search response body can't be
    // parsed, rather than silently resolving {}. Any thrown error from search()
    // — this stub doesn't depend on the client's exact error type — must land in
    // the available:false branch, never be swallowed into an empty results:[] envelope.
    const deps = {
      getConfig: () => ({ enabled: true }),
      readFeature: () => null,
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      createClient: () => ({
        search: async () => { throw new Error('malformed response body'); },
      }),
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: true, available: false, error: 'malformed response body' });
    assert.equal(body.results, undefined);
  });

  test('ON, readFeature throws → degrades to plain-code query, still 200', async () => {
    const { deps, calls } = trackingDeps({
      getConfig: () => ({ enabled: true }),
      readFeature: () => { throw new Error('disk gone'); },
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      search: () => ([]),
    });
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.deepEqual(calls.search, [['COMP-X', { top_k: 10 }]]);
  });

  test('snippet truncation boundary: 280 chars unchanged, 281 chars truncated with ellipsis', async () => {
    const deps280 = {
      getConfig: () => ({ enabled: true }),
      readFeature: () => null,
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      createClient: () => ({
        search: async () => ([{ id: 'm280', content: 'a'.repeat(280) }]),
      }),
    };
    const server280 = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps: deps280 });
    track(server280);
    const { body: body280 } = await getRecall(server280.baseUrl, '?featureCode=COMP-X');
    assert.equal(body280.results[0].snippet.length, 280);
    assert.ok(!body280.results[0].snippet.endsWith('…'));

    const deps281 = {
      getConfig: () => ({ enabled: true }),
      readFeature: () => null,
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      createClient: () => ({
        search: async () => ([{ id: 'm281', content: 'a'.repeat(281) }]),
      }),
    };
    const server281 = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps: deps281 });
    track(server281);
    const { body: body281 } = await getRecall(server281.baseUrl, '?featureCode=COMP-X');
    assert.equal(body281.results[0].snippet.length, 281);
    assert.ok(body281.results[0].snippet.endsWith('…'));
  });

  test('ON healthy, using the REAL createSmartmemoryClient over an actual http stub — proves the cross-feature contract end-to-end', async () => {
    // Every other case in this file stubs `createClient`/`search` directly, which
    // only proves the route satisfies its own injected-deps interface. This test
    // deliberately does NOT override `createClient`, so the route falls through to
    // `defaultCreateClient` -> INGEST's real `createSmartmemoryClient` -> real
    // `fetch` -> a real node:http stub emulating SmartMemory's /memory/search wire
    // shape. This is the actual cross-feature contract point the two blueprints
    // both cite (COMP-SMARTMEMORY-INGEST client `search()` <-> COMP-SMARTMEMORY-RECALL
    // route `mapHit`) and it was previously only exercised through stubs on both sides.
    const stub = createServer((req, res) => {
      if (req.url.startsWith('/memory/search')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.writeHead(200);
          res.end(JSON.stringify({
            results: [{
              id: 'm1',
              content: 'a prior decision',
              score: 0.85,
              memory_type: 'decision',
              context: { event: { ts: '2026-05-02T16:11:11Z' }, project: 'projA' },
            }],
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', resolveListen));
    const stubBaseUrl = `http://127.0.0.1:${stub.address().port}`;
    process.env.SM_ROUTE_REAL_KEY = 'test-key';

    const deps = {
      getConfig: () => ({ enabled: true, baseUrl: stubBaseUrl, apiKeyEnv: 'SM_ROUTE_REAL_KEY' }),
      readFeature: () => ({ description: 'Desc words' }),
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      // createClient intentionally NOT overridden.
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);
    try {
      const { status, body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
      assert.equal(status, 200);
      assert.equal(body.enabled, true);
      assert.equal(body.available, true);
      assert.equal(body.results.length, 1);
      assert.equal(body.results[0].id, 'm1');
      assert.equal(body.results[0].memoryType, 'decision');
      assert.equal(body.results[0].ts, '2026-05-02T16:11:11Z');
      assert.equal(body.results[0].project, 'projA');
    } finally {
      delete process.env.SM_ROUTE_REAL_KEY;
      stub.close();
    }
  });

  test('search returning {results:[...]} shape (not bare array) is handled', async () => {
    const deps = {
      getConfig: () => ({ enabled: true }),
      readFeature: () => null,
      resolveFeaturesPath: () => '/abs/features',
      resolveProjectTag: () => 'projB',
      createClient: () => ({
        search: async () => ({ results: [{ id: 'm1', content: 'x' }] }),
      }),
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);
    const { body } = await getRecall(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].id, 'm1');
  });
});
