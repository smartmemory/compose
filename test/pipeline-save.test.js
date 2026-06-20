/**
 * pipeline-save.test.js — Golden round-trip test for the pipeline save path
 * (COMP-PIPE-EDIT-1 / T2).
 *
 * Copies the REAL multi-flow build.stratum.yaml into a temp pipelines dir,
 * loads it into the model, applies an IDENTITY edit to ONE flow, saves through
 * POST /api/pipeline/save, re-reads, and asserts the save preserved:
 *   - every flow and subflow (counts + ids unchanged),
 *   - the duplicate `review` id staying correctly in BOTH its flows,
 *   - the leading `# metadata:` comment header (it is a COMMENT, not a key),
 *   - untouched fields byte-for-meaning: `isolation: none`, gate routes,
 *     parallel `source`.
 *
 * Also exercises the discovery endpoint and the path-traversal guard.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);
const { specToModel, renameStep } = await import(`${ROOT}/src/lib/pipeline-model.js`);

const REAL_BUILD = `${ROOT}/pipelines/build.stratum.yaml`;

let baseUrl;
let httpServer;
let dataDir;
let pipelinesDir;

function json(url, opts = {}) {
  return fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }).then(async r => ({ status: r.status, data: await r.json() }));
}

before(() => new Promise(res => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pipeline-save-'));
  dataDir = join(tmpRoot, '.compose', 'data');
  pipelinesDir = join(tmpRoot, 'pipelines');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(pipelinesDir, { recursive: true });

  // Copy the REAL build spec into the temp pipelines dir (never edit the real file).
  copyFileSync(REAL_BUILD, join(pipelinesDir, 'build.stratum.yaml'));
  // Copy a workflow.steps-shaped spec (new.stratum.yaml) for the flow-location test.
  copyFileSync(`${ROOT}/pipelines/new.stratum.yaml`, join(pipelinesDir, 'new.stratum.yaml'));
  // A symlink inside pipelines/ pointing OUTSIDE it — the save guard must refuse it.
  const outsideTarget = join(tmpRoot, 'outside.stratum.yaml');
  writeFileSync(outsideTarget, 'version: "0.2"\nworkflow:\n  name: outside\n  steps: []\n');
  try { symlinkSync(outsideTarget, join(pipelinesDir, 'evil.stratum.yaml')); } catch { /* fs may forbid */ }

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  attachPipelineRoutes(app, {
    broadcastMessage: () => {},
    scheduleBroadcast: () => {},
    getDataDir: () => dataDir,
    getPipelinesDir: () => pipelinesDir,
    stratumClient: null,
  });

  httpServer = createServer(app);
  httpServer.listen(0, () => {
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    res();
  });
}));

after(() => new Promise(res => { httpServer ? httpServer.close(res) : res(); }));

describe('GET /api/pipeline/specs — filename-based discovery', () => {
  test('lists the build spec with version + flows (no metadata reliance)', async () => {
    const { status, data } = await json('/api/pipeline/specs');
    assert.equal(status, 200);
    const entry = data.specs.find(s => s.file === 'build.stratum.yaml');
    assert.ok(entry, 'build.stratum.yaml discovered by filename');
    assert.equal(entry.version, '0.3');
    assert.ok(entry.flows.includes('build'));
    assert.ok(entry.flows.includes('review_check'));
    assert.ok(entry.flows.includes('parallel_review'));
  });

  test('GET /api/pipeline/spec returns raw text by filename (incl. comment-metadata specs)', async () => {
    const { status, data } = await json('/api/pipeline/spec?file=build.stratum.yaml');
    assert.equal(status, 200);
    assert.equal(data.file, 'build.stratum.yaml');
    assert.ok(data.text.includes('# metadata:'), 'raw text includes the comment metadata header');
    assert.ok(data.text.includes('flows:'), 'raw text is the full spec');
  });

  test('GET /api/pipeline/spec rejects a path-traversal filename', async () => {
    const { status } = await json('/api/pipeline/spec?file=../../../etc/passwd');
    assert.equal(status, 400);
  });
});

describe('POST /api/pipeline/save — golden round-trip on build.stratum.yaml', () => {
  test('identity edit to one flow preserves all flows, metadata header, and untouched fields', async () => {
    const filePath = join(pipelinesDir, 'build.stratum.yaml');
    const originalText = readFileSync(filePath, 'utf-8');
    const originalParsed = YAML.parse(originalText);

    // Build the model and do an IDENTITY edit on ONE flow (build): rename a
    // step to itself, which round-trips the normalized step path without
    // changing anything semantically. (Identity = the strongest fidelity test.)
    const model = specToModel(originalParsed);

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file: 'build.stratum.yaml', model, flowName: 'build' },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.file, 'build.stratum.yaml');

    const savedText = readFileSync(filePath, 'utf-8');
    const savedParsed = YAML.parse(savedText);

    // --- The `# metadata:` comment header survives in the file text. ---
    assert.ok(
      savedText.includes('# metadata:'),
      'leading `# metadata:` comment header must survive the save',
    );
    assert.ok(savedText.includes('#   id: build'), 'metadata id comment line survives');

    // --- Every flow + subflow is unchanged (counts + ids). ---
    assert.deepEqual(
      Object.keys(savedParsed.flows).sort(),
      Object.keys(originalParsed.flows).sort(),
      'all flows preserved',
    );
    for (const name of Object.keys(originalParsed.flows)) {
      const before = originalParsed.flows[name].steps.map(s => s.id);
      const afterIds = savedParsed.flows[name].steps.map(s => s.id);
      assert.deepEqual(afterIds, before, `flow "${name}" step ids unchanged`);
    }

    // --- The duplicated `review` id stays correctly in BOTH its flows. ---
    const reviewCheckReview = savedParsed.flows.review_check.steps.find(s => s.id === 'review');
    const buildReview = savedParsed.flows.build.steps.find(s => s.id === 'review');
    assert.ok(reviewCheckReview, 'review_check.review preserved');
    assert.ok(buildReview, 'build.review preserved');
    assert.equal(reviewCheckReview.agent, '$.input.reviewer_agent', 'review_check.review is the agent step');
    assert.equal(buildReview.flow, 'parallel_review', 'build.review is the sub-flow ref step');

    // --- Untouched fields byte-preserved (gate routes, parallel source, isolation: none). ---
    const designGate = savedParsed.flows.build.steps.find(s => s.id === 'design_gate');
    assert.equal(designGate.on_approve, 'prd');
    assert.equal(designGate.on_revise, 'explore_design');
    assert.equal(designGate.function, 'design_gate');

    const execute = savedParsed.flows.build.steps.find(s => s.id === 'execute');
    assert.equal(execute.source, '$.steps.decompose.output.tasks');
    assert.equal(execute.isolation, 'worktree');

    const reviewLenses = savedParsed.flows.parallel_review.steps.find(s => s.id === 'review_lenses');
    assert.equal(reviewLenses.isolation, 'none', 'isolation: none preserved');
    assert.equal(reviewLenses.source, '$.steps.triage.output.tasks');

    // --- Body comment preservation: an in-flow comment line survives. ---
    assert.ok(
      savedText.includes('--- Main flow: compose feature lifecycle ---') ||
      savedText.includes('Sub-flow: review'),
      'body comments survive the Document-mutate save',
    );

    // --- contracts block intact. ---
    assert.ok(savedParsed.contracts.PhaseResult);
    assert.ok(savedParsed.contracts.ReviewResult);
  });
});

describe('POST /api/pipeline/save — guards', () => {
  test('rejects a nonexistent file with 400', async () => {
    const { status } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file: 'does-not-exist.stratum.yaml', model: { flows: [] }, flowName: 'x' },
    });
    assert.equal(status, 400);
  });

  test('rejects a path-traversal file with 400', async () => {
    const { status } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file: '../../../etc/passwd', model: { flows: [] }, flowName: 'x' },
    });
    assert.equal(status, 400);
  });

  test('refuses to write through a symlink that escapes the pipelines dir', async () => {
    // The symlink target is outside pipelines/; the guard must reject it.
    const { status } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file: 'evil.stratum.yaml', model: { flows: [{ name: 'outside', steps: [] }] }, flowName: 'outside' },
    });
    assert.equal(status, 400, 'symlink escape must be refused');
  });
});

describe('POST /api/pipeline/save — workflow.steps flow location (finding 4)', () => {
  test('saves a workflow.steps spec and never clobbers it for a non-matching flow name', async () => {
    // Synthetic v0.3 spec with workflow.steps and NO workflow.name.
    const synPath = join(pipelinesDir, 'syn.stratum.yaml');
    writeFileSync(synPath,
      'version: "0.3"\nworkflow:\n  steps:\n    - id: a\n      agent: x\n    - id: b\n      agent: y\n');
    const model = specToModel(YAML.parse(readFileSync(synPath, 'utf-8')));
    assert.deepEqual(model.flows.map(f => f.name), ['workflow'], 'no-name workflow → synthetic "workflow" flow');

    // Saving the synthetic "workflow" flow succeeds and writes workflow.steps.
    const ok = await json('/api/pipeline/save', {
      method: 'POST', body: { file: 'syn.stratum.yaml', model, flowName: 'workflow' },
    });
    assert.equal(ok.status, 200, `save failed: ${JSON.stringify(ok.data)}`);
    const after = YAML.parse(readFileSync(synPath, 'utf-8'));
    assert.deepEqual(after.workflow.steps.map(s => s.id), ['a', 'b']);

    // Saving a non-matching flow name must 400 — NOT silently overwrite workflow.steps.
    const bad = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file: 'syn.stratum.yaml', model: { flows: [{ name: 'ghost', steps: [{ id: 'z' }] }] }, flowName: 'ghost' },
    });
    assert.equal(bad.status, 400, 'unknown flow name must not clobber workflow.steps');
    const untouched = YAML.parse(readFileSync(synPath, 'utf-8'));
    assert.deepEqual(untouched.workflow.steps.map(s => s.id), ['a', 'b'], 'workflow.steps untouched after rejected save');
  });
});

describe('POST /api/pipeline/save — unsurfaced fields survive an incomplete _extra (finding 2)', () => {
  test('a stale client that drops _extra.isolation does not delete it from disk', async () => {
    const filePath = join(pipelinesDir, 'build.stratum.yaml');
    const model = specToModel(YAML.parse(readFileSync(filePath, 'utf-8')));

    const buildFlow = model.flows.find(f => f.name === 'build');
    const execute = buildFlow.steps.find(s => s.id === 'execute');
    assert.equal(execute._extra.isolation, 'worktree', 'precondition: isolation is in _extra');

    // Simulate a buggy/stale client: edit a surfaced field, but DROP isolation
    // from the payload's _extra entirely.
    execute.intent = 'EDITED INTENT FOR TEST';
    delete execute._extra.isolation;

    const { status } = await json('/api/pipeline/save', {
      method: 'POST', body: { file: 'build.stratum.yaml', model, flowName: 'build' },
    });
    assert.equal(status, 200);

    const saved = YAML.parse(readFileSync(filePath, 'utf-8'));
    const savedExecute = saved.flows.build.steps.find(s => s.id === 'execute');
    assert.equal(savedExecute.isolation, 'worktree', 'disk-only field preserved despite incomplete _extra');
    assert.equal(savedExecute.intent, 'EDITED INTENT FOR TEST', 'the surfaced edit was applied');
    assert.equal(savedExecute.source, '$.steps.decompose.output.tasks', 'other unsurfaced fields intact');
  });

  test('a RENAMED step still preserves disk-only fields when the client drops _extra', async () => {
    // Fresh temp copy so this test is independent of the edit above.
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-rename-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    copyFileSync(REAL_BUILD, join(localPipelines, 'build.stratum.yaml'));

    const localApp = express();
    localApp.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(localApp, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(localApp);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;

    try {
      const fp = join(localPipelines, 'build.stratum.yaml');
      const model = specToModel(YAML.parse(readFileSync(fp, 'utf-8')));
      // Rename through the lib (sets the _renamedFrom hint) then drop _extra.isolation.
      renameStep(model, 'build', 'execute', 'execute2');
      const renamed = model.flows.find(f => f.name === 'build').steps.find(s => s.id === 'execute2');
      assert.equal(renamed._renamedFrom, 'execute', 'precondition: rename hint recorded');
      delete renamed._extra.isolation;

      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'build.stratum.yaml', model, flowName: 'build' }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);

      const saved = YAML.parse(readFileSync(fp, 'utf-8'));
      const node = saved.flows.build.steps.find(s => s.id === 'execute2');
      assert.ok(node, 'renamed step present under new id');
      assert.ok(!saved.flows.build.steps.find(s => s.id === 'execute'), 'old id gone');
      assert.equal(node.isolation, 'worktree', 'disk-only field preserved across rename despite dropped _extra');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  test('a rename CHAIN with id reuse (B->C, A->B) matches each step to its own disk node', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-chain-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const synPath = join(localPipelines, 'chain.stratum.yaml');
    // Two steps, each with a UNIQUE disk-only marker field (lands in _extra).
    writeFileSync(synPath,
      'version: "0.3"\nflows:\n  ff:\n    steps:\n      - id: A\n        agent: x\n        marker: alpha\n      - id: B\n        agent: y\n        marker: beta\n');

    const localApp = express();
    localApp.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(localApp, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(localApp);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;

    try {
      const model = specToModel(YAML.parse(readFileSync(synPath, 'utf-8')));
      // Chain: B->C then A->B, so the step that was A now reuses B's former id.
      renameStep(model, 'ff', 'B', 'C');
      renameStep(model, 'ff', 'A', 'B');
      // Drop the disk-only markers from the client payload, forcing node matching.
      for (const s of model.flows.find(f => f.name === 'ff').steps) delete s._extra.marker;

      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'chain.stratum.yaml', model, flowName: 'ff' }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);

      const saved = YAML.parse(readFileSync(synPath, 'utf-8'));
      const byId = Object.fromEntries(saved.flows.ff.steps.map(s => [s.id, s]));
      // The step now called B was originally A → must keep alpha (NOT beta).
      assert.equal(byId.B.marker, 'alpha', 'renamed A->B kept A\'s disk marker');
      // The step now called C was originally B → must keep beta.
      assert.equal(byId.C.marker, 'beta', 'renamed B->C kept B\'s disk marker');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  test('save → rename → save preserves disk fields (rename hints reset after save)', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-resave-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const p = join(localPipelines, 'resave.stratum.yaml');
    writeFileSync(p,
      'version: "0.3"\nflows:\n  ff:\n    steps:\n      - id: A\n        agent: x\n        marker: alpha\n');

    const localApp = express();
    localApp.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(localApp, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(localApp);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const post = (model) => fetch(`${url}/api/pipeline/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'resave.stratum.yaml', model, flowName: 'ff' }),
    });

    try {
      // First rename A->B and save.
      const model = specToModel(YAML.parse(readFileSync(p, 'utf-8')));
      renameStep(model, 'ff', 'A', 'B');
      assert.equal((await post(model)).status, 200);

      // Simulate the store's post-save cleanup: drop the rename hint for the
      // saved flow (so the next rename re-anchors to the now-current disk id).
      for (const s of model.flows.find(f => f.name === 'ff').steps) delete s._renamedFrom;

      // Second rename B->C, drop the disk-only marker from the payload, save.
      renameStep(model, 'ff', 'B', 'C');
      const stepC = model.flows.find(f => f.name === 'ff').steps.find(s => s.id === 'C');
      assert.equal(stepC._renamedFrom, 'B', 'second rename anchors to the post-save id B');
      delete stepC._extra.marker;
      assert.equal((await post(model)).status, 200);

      const saved = YAML.parse(readFileSync(p, 'utf-8'));
      const node = saved.flows.ff.steps.find(s => s.id === 'C');
      assert.ok(node, 'final id C present');
      assert.equal(node.marker, 'alpha', 'disk marker survived save→rename→save');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });
});
