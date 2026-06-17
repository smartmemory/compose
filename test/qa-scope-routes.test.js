/**
 * Integration test for GET /api/qa-scope — real Express app on an ephemeral
 * port, with the qa-scoping mapper INJECTED (readFeature/mapFilesToRoutes/
 * classifyRoutes) so no disk fixtures are needed. req.workspace is injected by a
 * tiny test middleware to control which workspace root the mapper sees.
 *
 * Covers: golden (filesChanged → affected/adjacent/unmapped via injected mapper),
 * unknown code (found:false), empty diff (emptyDiff:true, mapper not called),
 * missing param, no workspace (no 500), and mapper-throws degrade.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachQaScopeRoutes } = await import(`${ROOT}/server/qa-scope-routes.js`);

/**
 * Start an app whose injected req.workspace + mapper deps are configurable.
 * `deps` is forwarded straight to attachQaScopeRoutes (readFeature/mapFilesToRoutes/
 * classifyRoutes stubs).
 */
function startServer({ workspace, deps = {} }) {
  const app = express();
  app.use((req, _res, nextFn) => {
    req.workspace = workspace;
    nextFn();
  });
  attachQaScopeRoutes(app, deps);
  return new Promise((res) => {
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      res({ httpServer, baseUrl: `http://127.0.0.1:${httpServer.address().port}` });
    });
  });
}

async function getScope(baseUrl, qs = '') {
  const r = await fetch(`${baseUrl}/api/qa-scope${qs}`, { headers: { Connection: 'close' } });
  return { status: r.status, body: await r.json() };
}

describe('GET /api/qa-scope', () => {
  const cleanups = [];
  after(() => cleanups.forEach((fn) => fn()));
  function track(server) {
    cleanups.push(() => server.httpServer.close());
  }

  test('golden: known featureCode with filesChanged → found:true, routes flow through the injected mapper', async () => {
    const calls = { read: [], map: [], classify: [] };
    const deps = {
      readFeature: (cwd, code) => {
        calls.read.push([cwd, code]);
        return { filesChanged: ['pages/users/[id].tsx', 'lib/util.ts'] };
      },
      mapFilesToRoutes: (files, cfg) => {
        calls.map.push([files, cfg]);
        return {
          affectedRoutes: ['/users/:id'],
          unmappedFiles: ['lib/util.ts'],
          framework: 'nextjs',
          docsOnly: false,
        };
      },
      classifyRoutes: (routes, allKnown) => {
        calls.classify.push([routes, allKnown]);
        return { affected: ['/users/:id'], adjacent: ['/users'] };
      },
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getScope(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.equal(body.featureCode, 'COMP-X');
    assert.equal(body.framework, 'nextjs');
    assert.equal(body.docsOnly, false);
    assert.equal(body.emptyDiff, false);
    assert.deepEqual(body.filesChanged, ['pages/users/[id].tsx', 'lib/util.ts']);
    assert.deepEqual(body.affected, ['/users/:id']);
    assert.deepEqual(body.adjacent, ['/users']);
    assert.deepEqual(body.unmappedFiles, ['lib/util.ts']);

    // Pipeline wired exactly like the CLI: readFeature(root, code) →
    // mapFilesToRoutes(filesChanged, {cwd: root}) → classifyRoutes(routes, []).
    assert.deepEqual(calls.read, [['/repo/one', 'COMP-X']]);
    assert.deepEqual(calls.map, [[['pages/users/[id].tsx', 'lib/util.ts'], { cwd: '/repo/one' }]]);
    assert.deepEqual(calls.classify, [[['/users/:id'], []]]);
  });

  test('unknown featureCode (readFeature → null) → found:false, status 200, mapper not called', async () => {
    let mapped = false;
    const deps = {
      readFeature: () => null,
      mapFilesToRoutes: () => { mapped = true; return { affectedRoutes: [], unmappedFiles: [], framework: 'unknown', docsOnly: false }; },
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getScope(server.baseUrl, '?featureCode=NOPE');
    assert.equal(status, 200);
    assert.deepEqual(body, { found: false, featureCode: 'NOPE' });
    assert.equal(mapped, false);
  });

  test('empty filesChanged → found:true, emptyDiff:true, mapper NOT called', async () => {
    let mapped = false;
    const deps = {
      readFeature: () => ({ filesChanged: [] }),
      mapFilesToRoutes: () => { mapped = true; return { affectedRoutes: [], unmappedFiles: [], framework: 'unknown', docsOnly: false }; },
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getScope(server.baseUrl, '?featureCode=COMP-EMPTY');
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.equal(body.emptyDiff, true);
    assert.deepEqual(body.affected, []);
    assert.deepEqual(body.adjacent, []);
    assert.deepEqual(body.filesChanged, []);
    assert.equal(body.framework, 'unknown');
    assert.equal(mapped, false);
  });

  test('feature with no filesChanged field (undefined) → emptyDiff:true', async () => {
    const deps = { readFeature: () => ({ /* no filesChanged */ }) };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { body } = await getScope(server.baseUrl, '?featureCode=COMP-NF');
    assert.equal(body.found, true);
    assert.equal(body.emptyDiff, true);
  });

  test('missing featureCode query param → found:false, error', async () => {
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' } });
    track(server);

    const { status, body } = await getScope(server.baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { found: false, error: 'featureCode required' });
  });

  test('no workspace on request → found:false, no 500', async () => {
    const server = await startServer({ workspace: undefined });
    track(server);

    const { status, body } = await getScope(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.deepEqual(body, { found: false, error: 'no workspace root', featureCode: 'COMP-X' });
  });

  test('mapFilesToRoutes throws → found:true with error, no 500', async () => {
    const deps = {
      readFeature: () => ({ filesChanged: ['src/app.js'] }),
      mapFilesToRoutes: () => { throw new Error('boom'); },
    };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getScope(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.equal(body.featureCode, 'COMP-X');
    assert.equal(body.error, 'boom');
  });

  test('readFeature throws → found:false (treated as unreadable feature), no 500', async () => {
    const deps = { readFeature: () => { throw new Error('disk gone'); } };
    const server = await startServer({ workspace: { id: 'ws-1', root: '/repo/one' }, deps });
    track(server);

    const { status, body } = await getScope(server.baseUrl, '?featureCode=COMP-X');
    assert.equal(status, 200);
    assert.deepEqual(body, { found: false, featureCode: 'COMP-X' });
  });
});
