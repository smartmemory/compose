/**
 * Integration test for GET /api/validate — real Express app on an ephemeral
 * port, the REAL lib/feature-validator.js backend, and a real tmp workspace
 * fixture on disk. req.workspace is injected by a tiny test middleware to
 * control which workspace root the validator runs against.
 *
 * Confirms the wrap is wired to the actual validator (not just the injected
 * stubs covered in test/validate-routes.test.js).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const express = (await import('express')).default;
const { attachValidateRoutes } = await import(`${ROOT}/server/validate-routes.js`);

/** Start an app whose injected req.workspace is configurable; real validator. */
function startServer({ workspace }) {
  const app = express();
  app.use((req, _res, nextFn) => {
    req.workspace = workspace;
    nextFn();
  });
  attachValidateRoutes(app); // default deps → REAL validateFeature/validateProject
  return new Promise((res) => {
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      res({ httpServer, baseUrl: `http://127.0.0.1:${httpServer.address().port}` });
    });
  });
}

async function getValidate(baseUrl, qs = '') {
  const r = await fetch(`${baseUrl}/api/validate${qs}`, { headers: { Connection: 'close' } });
  return { status: r.status, body: await r.json() };
}

describe('GET /api/validate (real validator)', () => {
  const cleanups = [];
  after(() => cleanups.forEach((fn) => fn()));

  function track(server, ...dirs) {
    cleanups.push(() => server.httpServer.close());
    for (const d of dirs) cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  }

  test('feature scope, unknown feature → 200 with a FEATURE_NOT_FOUND error finding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'validate-ws-'));
    const server = await startServer({ workspace: { id: 'ws-fixture', root: dir } });
    track(server, dir);

    // ZZZ-NONEXISTENT-9 is strict-regex-valid but exists in no source in a fresh tmp dir.
    const { status, body } = await getValidate(server.baseUrl, '?scope=feature&featureCode=ZZZ-NONEXISTENT-9');
    assert.equal(status, 200);
    assert.equal(body.scope, 'feature');
    assert.equal(body.feature_code, 'ZZZ-NONEXISTENT-9');
    const notFound = body.findings.find((f) => f.kind === 'FEATURE_NOT_FOUND');
    assert.ok(notFound, 'expected a FEATURE_NOT_FOUND finding from the real validator');
    assert.equal(notFound.severity, 'error');
    // rollup reflects the real finding
    assert.equal(body.bySeverity.error, 1);
  });

  test('project scope → 200, scope=project, findings array, bySeverity present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'validate-ws-'));
    const server = await startServer({ workspace: { id: 'ws-fixture', root: dir } });
    track(server, dir);

    const { status, body } = await getValidate(server.baseUrl); // default scope=project
    assert.equal(status, 200);
    assert.equal(body.scope, 'project');
    assert.ok(Array.isArray(body.findings));
    assert.ok(body.bySeverity && typeof body.bySeverity === 'object');
    for (const sev of ['error', 'warning', 'info']) {
      assert.equal(typeof body.bySeverity[sev], 'number');
    }
    // local-only: no `external` passed → no network/xref resolution, just disk facts.
  });

  test('no workspace on request → 200 { unavailable: true }, never 500', async () => {
    const server = await startServer({ workspace: undefined });
    cleanups.push(() => server.httpServer.close());

    const { status, body } = await getValidate(server.baseUrl);
    assert.equal(status, 200);
    assert.equal(body.unavailable, true);
    assert.deepEqual(body.findings, []);
  });
});
