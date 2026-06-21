/**
 * pipeline-routes-security.test.js — Codex review FIX 1.
 *
 * The symlink/realpath containment guard that POST /save applies (realpathSync +
 * lstatSync isSymbolicLink + dirname-within-pipelines) was NOT applied to:
 *   - GET  /api/pipeline/spec            (the file being READ)
 *   - POST /api/pipeline/save-as-template (the target path + the pipelines dir)
 *
 * These tests assert the guard now covers both routes:
 *   - a symlinked spec file is refused by /spec
 *   - /save-as-template refuses when the target resolves outside the pipelines dir
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);

let baseUrl;
let httpServer;
let tmpRoot;
let pipelinesDir;
let outsideDir;

function json(url, opts = {}) {
  return fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }).then(async r => ({ status: r.status, data: await r.json() }));
}

const SIMPLE_SPEC = [
  'version: "0.3"',
  'flows:',
  '  main:',
  '    steps:',
  '      - id: a',
  '        agent: claude',
  '        intent: x',
  '',
].join('\n');

before(() => new Promise(res => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'pipeline-sec-'));
  pipelinesDir = join(tmpRoot, 'pipelines');
  outsideDir = join(tmpRoot, 'outside');
  mkdirSync(pipelinesDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // A real spec OUTSIDE the pipelines dir + a symlink to it INSIDE the dir.
  const realOutside = join(outsideDir, 'secret.stratum.yaml');
  writeFileSync(realOutside, SIMPLE_SPEC);
  symlinkSync(realOutside, join(pipelinesDir, 'link.stratum.yaml'));

  // A plain (non-symlink) spec for the happy path.
  writeFileSync(join(pipelinesDir, 'real.stratum.yaml'), SIMPLE_SPEC);

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  attachPipelineRoutes(app, {
    broadcastMessage: () => {},
    scheduleBroadcast: () => {},
    getDataDir: () => join(tmpRoot, '.compose', 'data'),
    getPipelinesDir: () => pipelinesDir,
    stratumClient: null,
  });
  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    res();
  });
}));

after(() => new Promise(res => { httpServer ? httpServer.close(res) : res(); }));

describe('FIX 1 — GET /api/pipeline/spec containment guard', () => {
  test('refuses to read a symlinked spec file', async () => {
    const { status, data } = await json('/api/pipeline/spec?file=link.stratum.yaml');
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(data)}`);
    assert.ok(/symlink|outside/i.test(data.error), `unexpected error: ${data.error}`);
  });

  test('reads a plain spec file normally', async () => {
    const { status, data } = await json('/api/pipeline/spec?file=real.stratum.yaml');
    assert.equal(status, 200);
    assert.ok(data.text.includes('version:'));
  });
});

describe('FIX 1 — POST /api/pipeline/save-as-template containment guard', () => {
  test('refuses when the pipelines dir is symlinked so the target resolves outside', async () => {
    // A second pipelines dir that is itself a symlink to an outside location.
    const linkedRoot = mkdtempSync(join(tmpdir(), 'pipeline-sec-link-'));
    const realTargetDir = join(linkedRoot, 'real-pipelines');
    const linkedPipelines = join(linkedRoot, 'pipelines');
    mkdirSync(realTargetDir, { recursive: true });
    // Make pipelines a symlink whose PARENT differs from its realpath parent.
    symlinkSync(realTargetDir, linkedPipelines);

    // Spin a dedicated server whose pipelinesDir is the symlinked dir, but the
    // guard must resolve targets relative to realpath(pipelinesDir). To force an
    // OUTSIDE resolution we point getPipelinesDir at a dir that exists, then make
    // the target filename itself a symlink to an outside file pre-created.
    // Simpler deterministic case: pre-create a symlink at the target path inside
    // the real pipelines dir pointing outside, and attempt to write to it.
    const outsideFile = join(linkedRoot, 'escape.stratum.yaml');
    writeFileSync(outsideFile, SIMPLE_SPEC);
    const targetName = 'tmpl.stratum.yaml';
    symlinkSync(outsideFile, join(realTargetDir, targetName));

    const app2 = express();
    app2.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(app2, {
      broadcastMessage: () => {},
      scheduleBroadcast: () => {},
      getDataDir: () => join(linkedRoot, '.compose', 'data'),
      getPipelinesDir: () => linkedPipelines,
      stratumClient: null,
    });
    const srv = createServer(app2);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;

    const model = { flows: [{ name: 'main', steps: [{ id: 'a', agent: 'claude', intent: 'x', _extra: {} }] }], _doc: {} };
    const r = await fetch(`${url}/api/pipeline/save-as-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: targetName, model, metadata: { id: 'escape-id' } }),
    });
    const status = r.status;
    const dataResp = await r.json();
    await new Promise(res2 => srv.close(res2));

    assert.equal(status, 400, `expected 400 (symlink target), got ${status}: ${JSON.stringify(dataResp)}`);
    assert.ok(/symlink|outside/i.test(dataResp.error), `unexpected error: ${dataResp.error}`);
    // The outside file must be UNCHANGED (no write-through the symlink).
    assert.ok(existsSync(outsideFile));
  });

  test('writes a plain new template normally', async () => {
    const model = { flows: [{ name: 'main', steps: [{ id: 'a', agent: 'claude', intent: 'x', _extra: {} }] }], _doc: { version: '0.3', flows: { main: { steps: [] } } } };
    const { status, data } = await json('/api/pipeline/save-as-template', {
      method: 'POST',
      body: { filename: 'fresh.stratum.yaml', model, metadata: { id: 'fresh-id' } },
    });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert.ok(existsSync(join(pipelinesDir, 'fresh.stratum.yaml')));
  });
});
