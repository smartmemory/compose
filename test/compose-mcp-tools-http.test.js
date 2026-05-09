/**
 * compose-mcp-tools-http.test.js — Verify the _httpRequest wrapper centralizes
 * http.request boilerplate and injects X-Compose-Workspace-Id from _binding.id.
 *
 * Strategy: stand up a small in-process http server that captures incoming
 * request method/path/headers/body, then drive the 4 callsites refactored in
 * COMP-WORKSPACE-HTTP T5 (toolGetCurrentSession, toolBindSession, _postLifecycle
 * via toolKillFeature, _postGate via toolApproveGate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  toolGetCurrentSession,
  toolBindSession,
  toolKillFeature,
  toolApproveGate,
  toolSetWorkspace,
} from '../server/compose-mcp-tools.js';

// Helper: spin up an http server that captures every request and replies 200 JSON.
function startCaptureServer() {
  const captured = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      captured.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: buf,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, captured });
    });
  });
}

// Reset the module-level _binding by importing a helper. Since we can't easily
// reset module state from outside, we control it via toolSetWorkspace (which
// requires a real workspace). For the "no header" case we rely on the fact that
// _binding starts as null until something sets it. To reset between tests we
// re-import via dynamic import with a cache-buster is overkill — instead we
// test the no-binding case first, then the with-binding case.

test('T5 _httpRequest: header absent when _binding is null (initial state)', async (t) => {
  const { server, port, captured } = await startCaptureServer();
  t.after(() => server.close());
  process.env.COMPOSE_PORT = String(port);

  // toolGetCurrentSession with featureCode hits GET /api/session/current
  await toolGetCurrentSession({ featureCode: 'TEST-1' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'GET');
  assert.match(captured[0].url, /^\/api\/session\/current\?featureCode=TEST-1$/);
  assert.equal(captured[0].headers['x-compose-workspace-id'], undefined,
    'header must be absent when _binding is null');
});

test('T5 _httpRequest: GET callsite preserves path + method (no body)', async (t) => {
  const { server, port, captured } = await startCaptureServer();
  t.after(() => server.close());
  process.env.COMPOSE_PORT = String(port);

  await toolGetCurrentSession({ featureCode: 'F-2' });
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].body, '');
});

test('T5 _httpRequest: POST callsite (_postLifecycle via toolKillFeature) sends JSON body', async (t) => {
  const { server, port, captured } = await startCaptureServer();
  t.after(() => server.close());
  process.env.COMPOSE_PORT = String(port);

  await toolKillFeature({ id: 'ITEM-1', reason: 'no longer needed' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].url, '/api/vision/items/ITEM-1/lifecycle/kill');
  assert.equal(captured[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(captured[0].body), { reason: 'no longer needed' });
});

test('T5 _httpRequest: POST callsite (_postGate via toolApproveGate) sends JSON body', async (t) => {
  const { server, port, captured } = await startCaptureServer();
  t.after(() => server.close());
  process.env.COMPOSE_PORT = String(port);

  await toolApproveGate({ gateId: 'G-1', outcome: 'approved', comment: 'ok' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].url, '/api/vision/gates/G-1/resolve');
  assert.deepEqual(JSON.parse(captured[0].body), { outcome: 'approved', comment: 'ok' });
});

test('T5 _httpRequest: POST callsite (toolBindSession) sends JSON body', async (t) => {
  const { server, port, captured } = await startCaptureServer();
  t.after(() => server.close());
  process.env.COMPOSE_PORT = String(port);

  await toolBindSession({ featureCode: 'F-BIND' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].url, '/api/session/bind');
  assert.deepEqual(JSON.parse(captured[0].body), { featureCode: 'F-BIND' });
});

test('T5 _httpRequest: header injected when _binding.id is set, on all 4 callsites', async (t) => {
  const { server, port, captured } = await startCaptureServer();
  t.after(() => {
    server.close();
    // Best-effort: nothing public to clear _binding; remaining tests in this
    // file are above this one. Subsequent test files run in isolation per node:test.
  });
  process.env.COMPOSE_PORT = String(port);

  // Set a binding by directly mutating module state via toolSetWorkspace.
  // toolSetWorkspace calls resolveWorkspace + switchProject, which we want to
  // avoid in a unit test. Instead, monkey-patch by importing the module and
  // poking _binding via a test hook. Since none exists, we use toolSetWorkspace
  // with the current cwd (a real workspace exists at the repo root).
  try {
    toolSetWorkspace({});
  } catch {
    // If no workspace can be resolved here, skip the with-binding subset.
    t.skip('No workspace available to set _binding for header-injection assertion');
    return;
  }

  await toolGetCurrentSession({ featureCode: 'F-A' });
  await toolKillFeature({ id: 'ITEM-A', reason: 'r' });
  await toolApproveGate({ gateId: 'G-A', outcome: 'approved' });
  await toolBindSession({ featureCode: 'F-B' });

  assert.equal(captured.length, 4);
  for (const c of captured) {
    assert.ok(c.headers['x-compose-workspace-id'],
      `header missing on ${c.method} ${c.url}`);
    assert.match(c.headers['x-compose-workspace-id'], /.+/);
  }
});
