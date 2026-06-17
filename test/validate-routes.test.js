/**
 * Unit tests for server/validate-routes.js:
 *   - summarizeFindings  (severity rollup, ignores unknowns)
 *   - GET /api/validate   against a lightweight Express harness with INJECTED
 *     validateFeature/validateProject stubs (no real validator, no fs) and an
 *     injected req.workspace.
 *
 * The wrap-to-real-validator wiring is covered against the real backend in
 * test/integration/validate-routes.test.js.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachValidateRoutes, summarizeFindings } = await import(`${ROOT}/server/validate-routes.js`);

describe('summarizeFindings', () => {
  test('empty findings → all-zero rollup', () => {
    assert.deepEqual(summarizeFindings([]), { error: 0, warning: 0, info: 0 });
  });

  test('no-arg → all-zero rollup', () => {
    assert.deepEqual(summarizeFindings(), { error: 0, warning: 0, info: 0 });
  });

  test('counts error/warning/info; ignores unknown severities and nullish', () => {
    const findings = [
      { severity: 'error', kind: 'A' },
      { severity: 'error', kind: 'B' },
      { severity: 'warning', kind: 'C' },
      { severity: 'info', kind: 'D' },
      { severity: 'critical', kind: 'E' }, // unknown — ignored
      null,                                 // nullish — ignored
      { kind: 'F' },                        // no severity — ignored
    ];
    assert.deepEqual(summarizeFindings(findings), { error: 2, warning: 1, info: 1 });
  });
});

/**
 * Start an app whose injected req.workspace + validator stubs are configurable.
 * `calls` records every stub invocation so tests can assert the (root, code) args.
 */
function startServer({ workspace, validateFeature, validateProject, calls }) {
  const app = express();
  app.use((req, _res, nextFn) => {
    req.workspace = workspace;
    nextFn();
  });
  attachValidateRoutes(app, {
    validateFeature: async (...args) => {
      calls.feature.push(args);
      return validateFeature(...args);
    },
    validateProject: async (...args) => {
      calls.project.push(args);
      return validateProject(...args);
    },
  });
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

describe('GET /api/validate (injected stubs)', () => {
  const servers = [];
  let calls;

  before(() => {});
  after(() => servers.forEach((s) => s.httpServer.close()));

  function mkCalls() {
    calls = { feature: [], project: [] };
    return calls;
  }

  test('project scope (default) → 200 with scope, findings, bySeverity from the stub', async () => {
    const c = mkCalls();
    const projectFindings = [
      { severity: 'error', kind: 'ROUNDTRIP_NOT_FIXED_POINT', detail: 'diverges' },
      { severity: 'warning', kind: 'ROADMAP_LOSSY', detail: 'lossy', feature_code: 'FOO-1' },
      { severity: 'info', kind: 'ROADMAP_NARRATIVE_OWNED', detail: 'narrative' },
    ];
    const server = await startServer({
      workspace: { id: 'ws-1', root: '/repo/one' },
      validateFeature: () => { throw new Error('should not be called'); },
      validateProject: () => ({ scope: 'project', validated_at: '2026-01-01T00:00:00.000Z', findings: projectFindings }),
      calls: c,
    });
    servers.push(server);

    const { status, body } = await getValidate(server.baseUrl);
    assert.equal(status, 200);
    assert.equal(body.scope, 'project');
    assert.deepEqual(body.findings, projectFindings);
    assert.deepEqual(body.bySeverity, { error: 1, warning: 1, info: 1 });
    // project validator called with (root, {}); feature validator untouched.
    assert.equal(c.project.length, 1);
    assert.equal(c.project[0][0], '/repo/one');
    assert.deepEqual(c.project[0][1], {});
    assert.equal(c.feature.length, 0);
  });

  test('feature scope → calls validateFeature with (root, code) and returns its findings', async () => {
    const c = mkCalls();
    const featureFindings = [
      { severity: 'error', kind: 'ARTIFACT_MISSING', detail: 'no design', feature_code: 'FOO-1' },
    ];
    const server = await startServer({
      workspace: { id: 'ws-1', root: '/repo/one' },
      validateFeature: () => ({ scope: 'feature', feature_code: 'FOO-1', validated_at: '2026-01-01T00:00:00.000Z', findings: featureFindings }),
      validateProject: () => { throw new Error('should not be called'); },
      calls: c,
    });
    servers.push(server);

    const { status, body } = await getValidate(server.baseUrl, '?scope=feature&featureCode=FOO-1');
    assert.equal(status, 200);
    assert.equal(body.scope, 'feature');
    assert.equal(body.feature_code, 'FOO-1');
    assert.deepEqual(body.findings, featureFindings);
    assert.deepEqual(body.bySeverity, { error: 1, warning: 0, info: 0 });
    assert.equal(c.feature.length, 1);
    assert.deepEqual(c.feature[0], ['/repo/one', 'FOO-1']);
    assert.equal(c.project.length, 0);
  });

  test('feature scope WITHOUT code → 400, validator not called', async () => {
    const c = mkCalls();
    const server = await startServer({
      workspace: { id: 'ws-1', root: '/repo/one' },
      validateFeature: () => { throw new Error('should not be called'); },
      validateProject: () => { throw new Error('should not be called'); },
      calls: c,
    });
    servers.push(server);

    const { status, body } = await getValidate(server.baseUrl, '?scope=feature');
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'scope=feature requires featureCode' });
    assert.equal(c.feature.length, 0);
    assert.equal(c.project.length, 0);
  });

  test('malformed code (INVALID_INPUT thrown by validator) → 400', async () => {
    const c = mkCalls();
    const server = await startServer({
      workspace: { id: 'ws-1', root: '/repo/one' },
      validateFeature: () => { throw Object.assign(new Error('bad code'), { code: 'INVALID_INPUT' }); },
      validateProject: () => { throw new Error('should not be called'); },
      calls: c,
    });
    servers.push(server);

    const { status, body } = await getValidate(server.baseUrl, '?scope=feature&featureCode=not_a_code');
    assert.equal(status, 400);
    assert.equal(body.error, 'bad code');
    assert.equal(c.feature.length, 1);
  });

  test('no workspace on request → 200 { unavailable: true }, never 500', async () => {
    const c = mkCalls();
    const server = await startServer({
      workspace: undefined,
      validateFeature: () => { throw new Error('should not be called'); },
      validateProject: () => { throw new Error('should not be called'); },
      calls: c,
    });
    servers.push(server);

    const { status, body } = await getValidate(server.baseUrl);
    assert.equal(status, 200);
    assert.equal(body.unavailable, true);
    assert.deepEqual(body.findings, []);
    assert.deepEqual(body.bySeverity, { error: 0, warning: 0, info: 0 });
    assert.equal(c.feature.length, 0);
    assert.equal(c.project.length, 0);
  });

  test('non-INVALID_INPUT validator failure degrades to 200 { unavailable: true } with error', async () => {
    const c = mkCalls();
    const server = await startServer({
      workspace: { id: 'ws-1', root: '/repo/one' },
      validateFeature: () => { throw new Error('should not be called'); },
      validateProject: () => { throw new Error('disk on fire'); },
      calls: c,
    });
    servers.push(server);

    const { status, body } = await getValidate(server.baseUrl);
    assert.equal(status, 200);
    assert.equal(body.unavailable, true);
    assert.equal(body.scope, 'project');
    assert.equal(body.error, 'disk on fire');
    assert.deepEqual(body.findings, []);
    assert.deepEqual(body.bySeverity, { error: 0, warning: 0, info: 0 });
  });

  test('severity grouping: mixed-severity stub → correct rollup, findings pass through verbatim', async () => {
    const c = mkCalls();
    const findings = [
      { severity: 'error', kind: 'E1', detail: 'd1', feature_code: 'A-1' },
      { severity: 'error', kind: 'E2', detail: 'd2' },
      { severity: 'warning', kind: 'W1', detail: 'd3', source: 'xref' },
      { severity: 'info', kind: 'I1', detail: 'd4' },
      { severity: 'info', kind: 'I2', detail: 'd5' },
      { severity: 'info', kind: 'I3', detail: 'd6' },
    ];
    const server = await startServer({
      workspace: { id: 'ws-1', root: '/repo/one' },
      validateFeature: () => { throw new Error('unused'); },
      validateProject: () => ({ scope: 'project', validated_at: 'X', findings }),
      calls: c,
    });
    servers.push(server);

    const { body } = await getValidate(server.baseUrl, '?scope=project');
    assert.deepEqual(body.bySeverity, { error: 2, warning: 1, info: 3 });
    // verbatim: kind/detail/feature_code/source intact
    assert.deepEqual(body.findings, findings);
  });
});
