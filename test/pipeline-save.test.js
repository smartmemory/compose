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
import { createHash } from 'node:crypto';
import YAML from 'yaml';

// E1: a flow-scoped save requires the loaded file's baseHash (server sha256). A
// real editor sends the hash it got from GET /spec; these round-trip tests load
// the file immediately before saving, so the current on-disk hash is the baseline.
const sha256 = (text) => createHash('sha256').update(text, 'utf-8').digest('hex');
const baseHashOf = (filePath) => sha256(readFileSync(filePath, 'utf-8'));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);
const { specToModel, renameStep, renameContract, addContract, setContractField } = await import(`${ROOT}/src/lib/pipeline-model.js`);

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
    // E3 converted build.stratum.yaml to a TS v1 spec. Version-keyed discovery:
    // v1 → version 1, and the flow list is the real flow keys (those with steps[]),
    // which for v1 excludes the `entry:` pointer (a string, not a flow object).
    assert.equal(entry.version, 1);
    assert.ok(entry.flows.includes('build'));
    assert.ok(entry.flows.includes('review_check'));
    assert.ok(entry.flows.includes('coverage_check'));
    assert.ok(!entry.flows.includes('entry'), 'the `entry:` pointer is not surfaced as a flow');
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
      body: { file: 'build.stratum.yaml', model, flowName: 'build', baseHash: sha256(originalText) },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.file, 'build.stratum.yaml');

    const savedText = readFileSync(filePath, 'utf-8');
    const savedParsed = YAML.parse(savedText);

    // build.stratum.yaml is a TS v1 spec (E3). Assert the v1 shape explicitly so a
    // future revert (or a v0.3 fixture swap) fails loudly instead of mis-asserting.
    assert.equal(originalParsed.version, 1, 'fixture is the v1 build pipeline');

    // --- The `# metadata:` comment header survives in the file text. ---
    assert.ok(
      savedText.includes('# metadata:'),
      'leading `# metadata:` comment header must survive the save',
    );
    assert.ok(savedText.includes('#   id: build'), 'metadata id comment line survives');

    // --- Every flow + subflow is unchanged (counts + ids). The v1 `flows.entry`
    // key is a STRING pointer, not a flow object, so step comparison iterates only
    // real flow keys (those with a steps[] array). ---
    assert.deepEqual(
      Object.keys(savedParsed.flows).sort(),
      Object.keys(originalParsed.flows).sort(),
      'all flow keys preserved (including the entry pointer)',
    );
    const flowKeysWithSteps = (parsed) =>
      Object.keys(parsed.flows).filter(name => Array.isArray(parsed.flows[name]?.steps));
    for (const name of flowKeysWithSteps(originalParsed)) {
      const before = originalParsed.flows[name].steps.map(s => s.id);
      const afterIds = savedParsed.flows[name].steps.map(s => s.id);
      assert.deepEqual(afterIds, before, `flow "${name}" step ids unchanged`);
    }
    assert.equal(savedParsed.flows.entry, 'build', 'the entry flow pointer is preserved');

    // --- The `review` id in the review_check subflow is preserved (v1 keeps the
    // cross-model review as a subflow; the build flow's review is now the
    // review_lenses fanout + review_merge reducer, not a `flow:` ref step). ---
    const reviewCheckReview = savedParsed.flows.review_check.steps.find(s => s.id === 'review');
    assert.ok(reviewCheckReview, 'review_check.review preserved');
    assert.equal(reviewCheckReview.agent, '$.input.reviewer_agent', 'review_check.review is the agent step');
    assert.equal(reviewCheckReview.out, 'ReviewResult', 'review_check.review keeps its ReviewResult contract');
    const reviewMerge = savedParsed.flows.build.steps.find(s => s.id === 'review_merge');
    assert.ok(reviewMerge, 'build.review_merge preserved');
    assert.equal(reviewMerge.out, 'ReviewResult', 'review_merge reduces to ReviewResult');

    // --- Untouched fields preserved (v1 nested gate routes, fanout over/isolation). ---
    const designGate = savedParsed.flows.build.steps.find(s => s.id === 'design_gate');
    assert.equal(designGate.gate.on_approve, 'prd');
    assert.equal(designGate.gate.on_revise, 'explore_design');

    const execute = savedParsed.flows.build.steps.find(s => s.id === 'execute');
    assert.equal(execute.fanout.over, '${decompose.output.tasks}');
    assert.equal(execute.fanout.isolation, 'worktree');

    const reviewLenses = savedParsed.flows.build.steps.find(s => s.id === 'review_lenses');
    assert.equal(reviewLenses.fanout.isolation, 'none', 'isolation: none preserved');
    assert.equal(reviewLenses.fanout.over, '${review_triage.output.tasks}');

    // --- Body comment preservation: an in-flow comment line survives. ---
    assert.ok(
      savedText.includes('Task-only subflow: cross-model implementation review') ||
      savedText.includes('consumer fanout'),
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
      method: 'POST', body: { file: 'syn.stratum.yaml', model, flowName: 'workflow', baseHash: baseHashOf(synPath) },
    });
    assert.equal(ok.status, 200, `save failed: ${JSON.stringify(ok.data)}`);
    const after = YAML.parse(readFileSync(synPath, 'utf-8'));
    assert.deepEqual(after.workflow.steps.map(s => s.id), ['a', 'b']);

    // Saving a non-matching flow name must 400 — NOT silently overwrite workflow.steps.
    const bad = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file: 'syn.stratum.yaml', model: { flows: [{ name: 'ghost', steps: [{ id: 'z' }] }] }, flowName: 'ghost', baseHash: baseHashOf(synPath) },
    });
    assert.equal(bad.status, 400, 'unknown flow name must not clobber workflow.steps');
    const untouched = YAML.parse(readFileSync(synPath, 'utf-8'));
    assert.deepEqual(untouched.workflow.steps.map(s => s.id), ['a', 'b'], 'workflow.steps untouched after rejected save');
  });
});

describe('POST /api/pipeline/save — unsurfaced fields survive an incomplete _extra (finding 2)', () => {
  test('a stale client that drops _extra.fanout does not delete it from disk (+ C3 intent→do)', async () => {
    const filePath = join(pipelinesDir, 'build.stratum.yaml');
    const model = specToModel(YAML.parse(readFileSync(filePath, 'utf-8')));

    const buildFlow = model.flows.find(f => f.name === 'build');
    const execute = buildFlow.steps.find(s => s.id === 'execute');
    // v1: execute is a consumer fanout; its disk-only structure lives in
    // _extra.fanout (the v1 analog of v0.3's top-level isolation/source fields).
    assert.equal(execute._extra.fanout.isolation, 'worktree', 'precondition: fanout is in _extra');

    // C3: the surfaced instruction ("intent") of a v1 step is backed by the `do`
    // field, not the python-era `intent`. review_merge is a regular v1 step with a
    // `do` — the editor surfaces it as `intent` and must write it back to `do`.
    const reviewMerge = buildFlow.steps.find(s => s.id === 'review_merge');
    assert.equal(reviewMerge._intentKey, 'do', 'precondition: v1 instruction is backed by `do`');
    assert.ok(/Merge/.test(reviewMerge.intent), 'precondition: the do text is surfaced as intent');
    reviewMerge.intent = 'EDITED review-merge instruction';

    // Simulate a buggy/stale client: DROP the fanout block from execute's _extra.
    delete execute._extra.fanout;

    const { status } = await json('/api/pipeline/save', {
      method: 'POST', body: { file: 'build.stratum.yaml', model, flowName: 'build', baseHash: baseHashOf(filePath) },
    });
    assert.equal(status, 200);

    const saved = YAML.parse(readFileSync(filePath, 'utf-8'));
    const savedExecute = saved.flows.build.steps.find(s => s.id === 'execute');
    // finding 2: the dropped disk-only field survives.
    assert.equal(savedExecute.fanout.isolation, 'worktree', 'disk-only field preserved despite incomplete _extra');
    assert.equal(savedExecute.fanout.over, '${decompose.output.tasks}', 'other unsurfaced fields intact');

    // C3: the surfaced edit landed on `do`, NOT `intent`, and the saved v1 spec is
    // schema-valid (no v1 build-flow step carries an undeclared `intent` field).
    const savedReviewMerge = saved.flows.build.steps.find(s => s.id === 'review_merge');
    assert.equal(savedReviewMerge.do, 'EDITED review-merge instruction', 'the surfaced edit was written to `do`');
    assert.equal(savedReviewMerge.intent, undefined, 'no python-era `intent` field on a v1 step');
    const withIntent = saved.flows.build.steps.filter(s => 'intent' in s).map(s => s.id);
    assert.deepEqual(withIntent, [], 'no v1 build-flow step carries an undeclared `intent` field');
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
      // Rename through the lib (sets the _renamedFrom hint) then drop _extra.fanout
      // (v1 disk-only structure — the analog of v0.3's isolation field).
      renameStep(model, 'build', 'execute', 'execute2');
      const renamed = model.flows.find(f => f.name === 'build').steps.find(s => s.id === 'execute2');
      assert.equal(renamed._renamedFrom, 'execute', 'precondition: rename hint recorded');
      delete renamed._extra.fanout;

      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'build.stratum.yaml', model, flowName: 'build', baseHash: baseHashOf(fp) }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);

      const savedText = readFileSync(fp, 'utf-8');
      const saved = YAML.parse(savedText);
      const node = saved.flows.build.steps.find(s => s.id === 'execute2');
      assert.ok(node, 'renamed step present under new id');
      assert.ok(!saved.flows.build.steps.find(s => s.id === 'execute'), 'old id gone');
      assert.equal(node.fanout.isolation, 'worktree', 'disk-only field preserved across rename despite dropped _extra');

      // C4: referential integrity — no v1 reference (after[]/nested gate route)
      // may still point at the ghost `execute` id after the rename reaches disk.
      const stale = [];
      for (const s of saved.flows.build.steps) {
        if (Array.isArray(s.after) && s.after.includes('execute')) stale.push(`${s.id}.after`);
        if (s.gate) for (const k of ['on_approve', 'on_revise', 'on_kill']) {
          if (s.gate[k] === 'execute') stale.push(`${s.id}.gate.${k}`);
        }
      }
      assert.deepEqual(stale, [], 'no dangling `execute` reference survives the rename');
      // execute_merge (the gate that followed execute) now points at execute2.
      const execMerge = saved.flows.build.steps.find(s => s.id === 'execute_merge');
      assert.ok(execMerge.after.includes('execute2'), 'execute_merge.after rewritten to execute2');
      assert.equal(execMerge.gate.on_revise, 'execute2', 'execute_merge gate.on_revise rewritten to execute2');
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
        body: JSON.stringify({ file: 'chain.stratum.yaml', model, flowName: 'ff', baseHash: baseHashOf(synPath) }),
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
      body: JSON.stringify({ file: 'resave.stratum.yaml', model, flowName: 'ff', baseHash: baseHashOf(p) }),
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

// ===========================================================================
// COMP-PIPE-EDIT-4 — save persists contracts + propagates contract renames
// ===========================================================================

// A synthetic spec that references a contract at ALL THREE sites
// (step.output_contract, flows.<name>.output, functions.<name>.output) plus an
// untouched contract carrying a comment we assert survives.
const MULTIREF_SPEC = `version: "0.3"

contracts:
  # PhaseResult: this comment must survive an untouched-contract save.
  PhaseResult:
    phase:   {type: string}
    outcome: {type: string, values: [complete, skipped, failed]}
  Foo:
    a: {type: string}

functions:
  gen:
    mode: function
    output: Foo

flows:
  main:
    output: Foo
    steps:
      - id: produce
        agent: claude
        intent: make a Foo
        output_contract: Foo
      - id: consume
        agent: claude
        intent: use it
        output_contract: PhaseResult
        depends_on: [produce]
`;

describe('POST /api/pipeline/save — persists contracts + contract-rename propagation', () => {
  test('renaming a contract rewrites all three ref sites on disk and preserves untouched-contract comments', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-contract-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const p = join(localPipelines, 'multiref.stratum.yaml');
    writeFileSync(p, MULTIREF_SPEC);

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
      const model = specToModel(YAML.parse(readFileSync(p, 'utf-8')));
      renameContract(model, 'Foo', 'FooV2');

      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'multiref.stratum.yaml', model, flowName: 'main', baseHash: baseHashOf(p) }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);

      const savedText = readFileSync(p, 'utf-8');
      const saved = YAML.parse(savedText);

      // The contracts key was renamed.
      assert.ok(saved.contracts.FooV2, 'contracts key renamed to FooV2');
      assert.ok(!('Foo' in saved.contracts), 'old Foo contract key gone');

      // Site 1: step.output_contract.
      const produce = saved.flows.main.steps.find(s => s.id === 'produce');
      assert.equal(produce.output_contract, 'FooV2', 'step output_contract rewritten on disk');

      // Site 2: flows.<name>.output.
      assert.equal(saved.flows.main.output, 'FooV2', 'flows.main.output rewritten on disk');

      // Site 3: functions.<name>.output.
      assert.equal(saved.functions.gen.output, 'FooV2', 'functions.gen.output rewritten on disk');

      // Untouched contract keeps its comment.
      assert.ok(
        savedText.includes('this comment must survive'),
        'comment on the untouched PhaseResult contract survives',
      );
      assert.ok(saved.contracts.PhaseResult, 'untouched contract preserved');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  test('save persists a newly-added contract and a new field', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-newcontract-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const p = join(localPipelines, 'multiref.stratum.yaml');
    writeFileSync(p, MULTIREF_SPEC);

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
      const model = specToModel(YAML.parse(readFileSync(p, 'utf-8')));
      addContract(model, 'NewC');
      setContractField(model, 'NewC', 'flag', { type: 'boolean' });

      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'multiref.stratum.yaml', model, flowName: 'main', baseHash: baseHashOf(p) }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);

      const saved = YAML.parse(readFileSync(p, 'utf-8'));
      assert.deepEqual(saved.contracts.NewC, { flag: { type: 'boolean' } }, 'new contract persisted');
      assert.ok(saved.contracts.Foo, 'existing contracts preserved');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  test('contract rename propagates to step.output_contract in a NON-selected flow', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-xflow-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const p = join(localPipelines, 'xflow.stratum.yaml');
    // Two flows, BOTH with a step whose output_contract is `Old`.
    writeFileSync(p,
      'version: "0.3"\ncontracts:\n  Old:\n    x: {type: string}\nflows:\n' +
      '  a:\n    steps:\n      - id: s1\n        agent: x\n        output_contract: Old\n' +
      '  b:\n    steps:\n      - id: s2\n        agent: y\n        output_contract: Old\n');

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
      const model = specToModel(YAML.parse(readFileSync(p, 'utf-8')));
      renameContract(model, 'Old', 'New');
      // Save while editing ONLY flow `a`; flow `b` must still get its ref rewritten.
      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'xflow.stratum.yaml', model, flowName: 'a', baseHash: baseHashOf(p) }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);

      const saved = YAML.parse(readFileSync(p, 'utf-8'));
      assert.ok(saved.contracts.New && !('Old' in saved.contracts), 'contract key renamed');
      assert.equal(saved.flows.a.steps[0].output_contract, 'New', 'selected flow ref rewritten');
      assert.equal(saved.flows.b.steps[0].output_contract, 'New', 'NON-selected flow ref also rewritten (no broken ref)');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });
});

// ===========================================================================
// Flag-day round 2 — D2 (version-derived intent key), D3 (new-step default),
// D4 (diff-driven _extra ref persistence)
// ===========================================================================

describe('POST /api/pipeline/save — flag-day round 2 (D2/D3/D4)', () => {
  async function saveIn(spec, file, mutate) {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-d234-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const fp = join(localPipelines, file);
    writeFileSync(fp, spec);
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(app, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(app);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const model = specToModel(YAML.parse(readFileSync(fp, 'utf-8')));
      const flowName = mutate(model);
      const r = await fetch(`${url}/api/pipeline/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, model, flowName, baseHash: baseHashOf(fp) }),
      });
      assert.equal(r.status, 200, `save failed: ${await r.text()}`);
      return { saved: YAML.parse(readFileSync(fp, 'utf-8')), model };
    } finally {
      await new Promise(r => srv.close(r));
    }
  }

  // D2: the intent key is VERSION-derived, not presence-derived. A v1 step
  // carrying BOTH `do` and `intent` must round-trip to `do` only.
  test('D2: a v1 step with both do and intent round-trips to `do` only', async () => {
    const spec = 'version: 1\nflows:\n  entry: f\n  f:\n    steps:\n'
      + '      - id: s1\n        agent: claude\n        do: "real v1 instruction"\n        intent: "stray python-era intent"\n';
    const { saved, model } = await saveIn(spec, 'd2.stratum.yaml', () => 'f');
    const s1model = model.flows.find(f => f.name === 'f').steps.find(s => s.id === 's1');
    assert.equal(s1model._intentKey, 'do', 'intent key is version-derived (v1 → do)');
    assert.equal(s1model.intent, 'real v1 instruction', 'surfaced value comes from the version-correct field');
    const s1 = saved.flows.f.steps.find(s => s.id === 's1');
    assert.equal(s1.do, 'real v1 instruction', 'do preserved');
    assert.equal(s1.intent, undefined, 'stray python-era intent dropped — v1 stays schema-valid');
  });

  // D3: a NEW step created in the editor (no _intentKey) defaults to the version's
  // physical field, not `intent`.
  test('D3: a new step added to a v1 pipeline serializes `do`, never `intent`', async () => {
    const spec = 'version: 1\nflows:\n  entry: f\n  f:\n    steps:\n      - id: s1\n        agent: claude\n        do: "x"\n';
    const { saved } = await saveIn(spec, 'd3.stratum.yaml', (model) => {
      // A brand-new step object as the add-step path produces it, minus _intentKey
      // (proves the SERVER default is version-derived even for an old client).
      model.flows.find(f => f.name === 'f').steps.push({
        id: 's2', kind: 'agent', agent: 'claude', intent: 'new step instruction',
        inputs: {}, ensure: [], depends_on: [], _extra: {},
      });
      return 'f';
    });
    const s2 = saved.flows.f.steps.find(s => s.id === 's2');
    assert.equal(s2.do, 'new step instruction', 'new v1 step writes `do`');
    assert.equal(s2.intent, undefined, 'new v1 step carries no undeclared `intent`');
    // No step in the flow carries a stray intent.
    assert.deepEqual(saved.flows.f.steps.filter(s => 'intent' in s).map(s => s.id), []);
  });

  // D4: the flow-scoped save persists EVERY rewritten _extra field (diff-driven),
  // not an allowlist — a rename rewrites `when` templates on other steps too.
  test('D4: rename persists a rewritten `when` template on another step', async () => {
    const spec = 'version: 1\nflows:\n  entry: f\n  f:\n    steps:\n'
      + '      - id: execute\n        agent: claude\n        do: "run"\n        out: R\n'
      + '      - id: guard\n        agent: claude\n        do: "check"\n        when: "${execute.output.ok}"\n';
    const { saved } = await saveIn(spec, 'd4.stratum.yaml', (model) => {
      renameStep(model, 'f', 'execute', 'execute2');
      return 'f';
    });
    assert.ok(saved.flows.f.steps.find(s => s.id === 'execute2'), 'step renamed on disk');
    const guard = saved.flows.f.steps.find(s => s.id === 'guard');
    assert.equal(guard.when, '${execute2.output.ok}', 'the rewritten `when` template reached disk');
    // No dangling reference to the old id anywhere in the saved text.
    const text = JSON.stringify(saved);
    assert.ok(!/\$\{execute\.output/.test(text), 'no `${execute.output...}` reference survives');
  });
});

// ===========================================================================
// Flag-day round 3 — E1: the diff-driven flow-scoped merge must not silently
// resurrect a stale editor's value against a disk another writer moved.
// ===========================================================================

describe('POST /api/pipeline/save — flag-day round 3 (E1 stale-baseline guard)', () => {
  test('E1: flow-scoped save requires baseHash; a stale hash 409s (no resurrection); force overrides', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-e1-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const fp = join(localPipelines, 'e1.stratum.yaml');
    writeFileSync(fp,
      'version: 1\nflows:\n  entry: f\n  f:\n    steps:\n      - id: s1\n        agent: claude\n        do: "x"\n        marker: v1\n');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(app, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(app);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const save = (body) => fetch(`${url}/api/pipeline/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const markerOf = () => YAML.parse(readFileSync(fp, 'utf-8')).flows.f.steps[0].marker;

    try {
      // Client A loads the spec (marker=v1) → captures baseHash H1.
      const staleText = readFileSync(fp, 'utf-8');
      const H1 = sha256(staleText);
      const staleModel = specToModel(YAML.parse(staleText)); // s1._extra.marker === 'v1'

      // (a) A flow-scoped save WITHOUT baseHash is refused (400) — the diff-driven
      // merge has no baseline to detect staleness.
      const noHash = await save({ file: 'e1.stratum.yaml', model: staleModel, flowName: 'f' });
      assert.equal(noHash.status, 400, 'flow-scoped save requires baseHash');
      assert.equal(markerOf(), 'v1', 'nothing written');

      // Writer B moves marker to v2 on disk (a legitimate concurrent save).
      const bModel = specToModel(YAML.parse(readFileSync(fp, 'utf-8')));
      bModel.flows.find(f => f.name === 'f').steps.find(s => s.id === 's1')._extra.marker = 'v2';
      const bSave = await save({ file: 'e1.stratum.yaml', model: bModel, flowName: 'f', baseHash: H1 });
      assert.equal(bSave.status, 200);
      assert.equal(markerOf(), 'v2', 'writer B landed v2');

      // (b) Client A (STALE, still marker=v1) resubmits with its old H1 → 409, and
      // the diff-driven merge does NOT resurrect v1.
      const stale = await save({ file: 'e1.stratum.yaml', model: staleModel, flowName: 'f', baseHash: H1 });
      assert.equal(stale.status, 409, 'a stale baseHash is a conflict');
      assert.equal(markerOf(), 'v2', 'stale save must NOT resurrect v1');

      // (c) force:true is the explicit last-writer-wins override — resurrection is
      // then user intent, not a silent hazard.
      const forced = await save({ file: 'e1.stratum.yaml', model: staleModel, flowName: 'f', force: true });
      assert.equal(forced.status, 200);
      assert.equal(markerOf(), 'v1', 'force resurrects v1 (explicit last-writer-wins)');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });
});

// ===========================================================================
// Flag-day round 4 — F1 (strict force===true) + F2 (partial-model bypass)
// ===========================================================================

describe('POST /api/pipeline/save — flag-day round 4 (E1 guard bypasses)', () => {
  async function withServer(fn) {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-f12-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(app, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(app);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const save = (body) => fetch(`${url}/api/pipeline/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try { await fn({ localPipelines, save }); } finally { await new Promise(r => srv.close(r)); }
  }

  // F1: only a STRICT boolean `force === true` may bypass the E1 guard — a
  // truthy-but-non-boolean force ("false", 1, {}) must fall through to the guard.
  test('F1: a truthy-but-non-boolean `force` does NOT bypass the stale-baseline guard', async () => {
    await withServer(async ({ localPipelines, save }) => {
      const fp = join(localPipelines, 'f1.stratum.yaml');
      writeFileSync(fp,
        'version: 1\nflows:\n  entry: f\n  f:\n    steps:\n      - id: s1\n        agent: claude\n        do: "x"\n        marker: v1\n');
      const H1 = sha256(readFileSync(fp, 'utf-8'));
      const staleModel = specToModel(YAML.parse(readFileSync(fp, 'utf-8')));
      const markerOf = () => YAML.parse(readFileSync(fp, 'utf-8')).flows.f.steps[0].marker;

      // Writer B moves marker to v2 (disk now diverges from H1).
      const bModel = specToModel(YAML.parse(readFileSync(fp, 'utf-8')));
      bModel.flows.find(f => f.name === 'f').steps.find(s => s.id === 's1')._extra.marker = 'v2';
      assert.equal((await save({ file: 'f1.stratum.yaml', model: bModel, flowName: 'f', baseHash: H1 })).status, 200);
      assert.equal(markerOf(), 'v2');

      // A stale save with a NON-strict-boolean force must 409 (not bypass), no write.
      for (const badForce of ['false', 1, {}, 'true', 0.0]) {
        const r = await save({ file: 'f1.stratum.yaml', model: staleModel, flowName: 'f', baseHash: H1, force: badForce });
        assert.equal(r.status, 409, `force:${JSON.stringify(badForce)} must not bypass the guard`);
        assert.equal(markerOf(), 'v2', 'no resurrection under a non-strict force');
      }

      // Only strict force===true overrides.
      assert.equal((await save({ file: 'f1.stratum.yaml', model: staleModel, flowName: 'f', force: true })).status, 200);
      assert.equal(markerOf(), 'v1', 'strict force===true resurrects (explicit last-writer-wins)');
    });
  });

  // F2: an omitted `flowName` does NOT make a PARTIAL model a spec-wide save.
  test('F2: a partial model without flowName is flow-scoped (baseHash required), not spec-wide', async () => {
    await withServer(async ({ localPipelines, save }) => {
      const fp = join(localPipelines, 'f2.stratum.yaml');
      // TWO flows on disk.
      writeFileSync(fp,
        'version: 1\nflows:\n  entry: a\n  a:\n    steps:\n      - id: s1\n        agent: claude\n        do: "x"\n        marker: keep\n  b:\n    steps:\n      - id: s2\n        agent: claude\n        do: "y"\n');
      const before = readFileSync(fp, 'utf-8');

      // A PARTIAL model (only flow `a`, no _doc) with NO flowName and NO baseHash
      // must NOT slip through the hash-optional spec-wide branch → 400.
      const partial = { flows: [{ name: 'a', steps: [{ id: 's1', kind: 'agent', agent: 'claude', intent: 'sneaky edit', _intentKey: 'do', inputs: {}, ensure: [], depends_on: [], _extra: {} }] }] };
      const r = await save({ file: 'f2.stratum.yaml', model: partial });
      assert.equal(r.status, 400, 'partial model without flowName is flow-scoped → baseHash required');
      assert.equal(readFileSync(fp, 'utf-8'), before, 'nothing written for the rejected partial save');

      // A GENUINE full-document save (covers BOTH disk flows, carries _doc) still
      // requires a baseHash under G1 (always-require contract), but stays spec-wide
      // for MERGE behavior — the untouched flow `b` survives.
      const full = specToModel(YAML.parse(readFileSync(fp, 'utf-8')));
      full.flows.find(f => f.name === 'a').steps.find(s => s.id === 's1').intent = 'genuine edit';
      const g = await save({ file: 'f2.stratum.yaml', model: full, baseHash: sha256(readFileSync(fp, 'utf-8')) });
      assert.equal(g.status, 200, 'genuine full-document save (covers all disk flows) succeeds with baseHash');
      const saved = YAML.parse(readFileSync(fp, 'utf-8'));
      assert.equal(saved.flows.a.steps[0].do, 'genuine edit');
      assert.ok(saved.flows.b, 'the untouched flow `b` survives the spec-wide save');
    });
  });
});

// ===========================================================================
// Flag-day round 5 — G1 (always-require baseHash), G2 (creation gate on
// classification), G3 (hash check before parse)
// ===========================================================================

describe('POST /api/pipeline/save — flag-day round 5 (G1/G2/G3)', () => {
  async function withServer(fn) {
    const localDir = mkdtempSync(join(tmpdir(), 'pipeline-g-'));
    const localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(app, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    const srv = createServer(app);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const save = (body) => fetch(`${url}/api/pipeline/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try { await fn({ localPipelines, save }); } finally { await new Promise(r => srv.close(r)); }
  }

  // G1: the coversFullDocument spoof — an empty `_doc` object + stub flow bodies
  // that cover every disk flow NAME (but with empty steps) previously classified
  // spec-wide and slipped through the HASH-OPTIONAL branch, destructively deleting
  // real steps with no baseHash. Under the always-require contract that spoof is a
  // 400 (missing baseHash), the stale variant is a 409, and disk is untouched.
  test('G1: the coversFullDocument spoof is refused without a fresh baseHash (no destructive save)', async () => {
    await withServer(async ({ localPipelines, save }) => {
      const fp = join(localPipelines, 'g1.stratum.yaml');
      writeFileSync(fp,
        'version: 1\nflows:\n  entry: a\n  a:\n    steps:\n      - id: s1\n        agent: claude\n        do: "real a work"\n  b:\n    steps:\n      - id: s2\n        agent: claude\n        do: "real b work"\n');
      const before = readFileSync(fp, 'utf-8');
      const H1 = sha256(before);

      // The spoof: a NON-empty `_doc` + stub flow bodies covering BOTH disk flow
      // NAMES with EMPTY steps. coversFullDocument() → true (classifies spec-wide),
      // so under the old hash-optional spec-wide branch this would replace/delete
      // every real step. No flowName, no baseHash.
      const spoof = {
        _doc: { version: 1, flows: { entry: 'a', a: { steps: [] }, b: { steps: [] } } },
        flows: [{ name: 'a', steps: [] }, { name: 'b', steps: [] }],
      };
      const noHash = await save({ file: 'g1.stratum.yaml', model: spoof });
      assert.equal(noHash.status, 400, 'spec-wide spoof without baseHash is refused (always-require)');
      assert.equal(readFileSync(fp, 'utf-8'), before, 'nothing written for the hash-free spoof');

      // Same spoof with a STALE hash (disk moved on) is a 409, still no write.
      writeFileSync(fp, before.replace('real a work', 'moved on'));
      const moved = readFileSync(fp, 'utf-8');
      const stale = await save({ file: 'g1.stratum.yaml', model: spoof, baseHash: H1 });
      assert.equal(stale.status, 409, 'a stale baseHash is a conflict even for a spec-wide save');
      assert.equal(readFileSync(fp, 'utf-8'), moved, 'nothing written for the stale spec-wide save');

      // A GENUINE spec-wide save WITH the fresh baseHash is unchanged (200), and the
      // spec-wide merge still preserves the untouched flow.
      const full = specToModel(YAML.parse(moved));
      full.flows.find(f => f.name === 'a').steps.find(s => s.id === 's1').intent = 'edited a';
      const ok = await save({ file: 'g1.stratum.yaml', model: full, baseHash: sha256(moved) });
      assert.equal(ok.status, 200, 'genuine spec-wide save with a fresh baseHash succeeds');
      const saved = YAML.parse(readFileSync(fp, 'utf-8'));
      assert.equal(saved.flows.a.steps[0].do, 'edited a');
      assert.equal(saved.flows.b.steps[0].do, 'real b work', 'the untouched flow b survives');
    });
  });

  // G2: the spec-wide-ONLY flow-creation path must gate on the computed `specWide`
  // classification, not a bare `!flowName`. A request with no flowName but a partial
  // model that does NOT cover the full document is flow-scoped-classified — it must
  // NOT auto-create a model-only flow (the documented spec-wide-only behavior).
  test('G2: a flow-scoped-classified request cannot perform spec-wide-only flow creation', async () => {
    await withServer(async ({ localPipelines, save }) => {
      const fp = join(localPipelines, 'g2.stratum.yaml');
      // TWO flows on disk: a and b.
      writeFileSync(fp,
        'version: 1\nflows:\n  entry: a\n  a:\n    steps:\n      - id: s1\n        agent: claude\n        do: "x"\n  b:\n    steps:\n      - id: s2\n        agent: claude\n        do: "y"\n');
      const before = readFileSync(fp, 'utf-8');

      // A model that carries a `_doc` but MISSES disk flow `b` (so coversFullDocument
      // → false → flow-scoped-classified), no flowName, valid baseHash, and a NEW
      // model-only flow `newflow` not on disk. Old code (`!flowName`) would create
      // `newflow`; the classification gate (`specWide`) must block it → 400.
      const model = {
        _doc: { version: 1, flows: { entry: 'a', a: { steps: [{ id: 's1', agent: 'claude', do: 'x' }] }, newflow: { steps: [{ id: 'n1', agent: 'claude', do: 'z' }] } } },
        flows: [
          { name: 'a', steps: [{ id: 's1', kind: 'agent', agent: 'claude', intent: 'x', _intentKey: 'do', inputs: {}, ensure: [], depends_on: [], _extra: {} }] },
          { name: 'newflow', steps: [{ id: 'n1', kind: 'agent', agent: 'claude', intent: 'z', _intentKey: 'do', inputs: {}, ensure: [], depends_on: [], _extra: {} }] },
        ],
      };
      const r = await save({ file: 'g2.stratum.yaml', model, baseHash: sha256(before) });
      assert.equal(r.status, 400, 'flow-scoped-classified request cannot create a model-only flow');
      assert.equal(readFileSync(fp, 'utf-8'), before, 'nothing written; the model-only flow was not created');
      assert.ok(!YAML.parse(readFileSync(fp, 'utf-8')).flows.newflow, 'newflow never landed on disk');
    });
  });

  // G3: the hash check evaluates RAW disk bytes BEFORE parsing, so a stale baseHash
  // is a 409 even when the on-disk YAML is malformed (round 4's parse-before-classify
  // reorder regressed this to a 400 — parse threw first). Restore HEAD's 409.
  test('G3: a stale baseHash on malformed disk YAML is a 409, not a 400', async () => {
    await withServer(async ({ localPipelines, save }) => {
      const fp = join(localPipelines, 'g3.stratum.yaml');
      // Malformed YAML on disk (unterminated flow sequence): YAML.parse throws.
      writeFileSync(fp, 'version: 1\nflows: [unterminated\n');
      const before = readFileSync(fp, 'utf-8');
      assert.throws(() => YAML.parse(before), 'precondition: disk YAML is genuinely unparseable');

      const model = { flows: [{ name: 'a', steps: [] }] };

      // A STALE (non-matching) baseHash must 409 on the raw bytes BEFORE the parse
      // is attempted — parseability is irrelevant to the staleness verdict.
      const stale = await save({ file: 'g3.stratum.yaml', model, baseHash: 'deadbeefstalehash' });
      assert.equal(stale.status, 409, 'stale hash → 409 regardless of disk parseability');
      assert.equal(readFileSync(fp, 'utf-8'), before, 'nothing written');

      // A MATCHING baseHash passes the guard, then the parse legitimately fails → 400.
      const matched = await save({ file: 'g3.stratum.yaml', model, baseHash: sha256(before) });
      assert.equal(matched.status, 400, 'a matching hash on malformed disk falls through to the parse 400');
      assert.equal(readFileSync(fp, 'utf-8'), before, 'still nothing written');
    });
  });
});

// ===========================================================================
// COMP-PIPE-EDIT-7 — POST /api/pipeline/save-as-template
// ===========================================================================

describe('POST /api/pipeline/save-as-template', () => {
  let localDir, localPipelines, url, srv;

  before(async () => {
    localDir = mkdtempSync(join(tmpdir(), 'pipeline-tmpl-'));
    localPipelines = join(localDir, 'pipelines');
    mkdirSync(localPipelines, { recursive: true });
    // Seed an existing template (real metadata key) to test id-collision.
    writeFileSync(join(localPipelines, 'existing.stratum.yaml'),
      'metadata:\n  id: existing-tmpl\n  label: Existing\nversion: "0.3"\nflows:\n  f:\n    steps:\n      - id: a\n        agent: x\n');

    const localApp = express();
    localApp.use(express.json({ limit: '5mb' }));
    attachPipelineRoutes(localApp, {
      broadcastMessage: () => {}, scheduleBroadcast: () => {},
      getDataDir: () => join(localDir, 'data'), getPipelinesDir: () => localPipelines, stratumClient: null,
    });
    srv = createServer(localApp);
    await new Promise(r => srv.listen(0, r));
    url = `http://127.0.0.1:${srv.address().port}`;
  });
  after(async () => { if (srv) await new Promise(r => srv.close(r)); });

  function post(path, body) {
    return fetch(`${url}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, data: await r.json() }));
  }

  function modelFor(specText) {
    return specToModel(YAML.parse(specText));
  }

  test('writes a new file with a real metadata key that appears via GET /templates', async () => {
    const model = modelFor(MULTIREF_SPEC);
    const { status, data } = await post('/api/pipeline/save-as-template', {
      filename: 'my-template.stratum.yaml',
      model,
      metadata: { id: 'my-template', label: 'My Template', description: 'desc', category: 'custom' },
    });
    assert.equal(status, 200, `save-as-template failed: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.file, 'my-template.stratum.yaml');

    // The written file has a REAL metadata: key (not a comment).
    const written = readFileSync(join(localPipelines, 'my-template.stratum.yaml'), 'utf-8');
    const parsed = YAML.parse(written);
    assert.equal(parsed.metadata.id, 'my-template', 'real metadata key present');
    assert.equal(parsed.metadata.label, 'My Template');
    // Contracts serialized in (excluding TaskGraph).
    assert.ok(parsed.contracts.Foo, 'contracts block written');
    assert.ok(parsed.flows.main, 'flows passthrough written');

    // It shows up via the templates endpoint (which keys on metadata.id).
    const r = await fetch(`${url}/api/pipeline/templates`);
    const tdata = await r.json();
    assert.ok(tdata.templates.find(t => t.id === 'my-template'), 'new template discoverable via /templates');
  });

  test('refuses to overwrite an existing file (create-only)', async () => {
    // existing.stratum.yaml is already on disk.
    const model = modelFor(MULTIREF_SPEC);
    const { status } = await post('/api/pipeline/save-as-template', {
      filename: 'existing.stratum.yaml',
      model,
      metadata: { id: 'brand-new-id' },
    });
    assert.equal(status, 400, 'overwrite of an existing file must be refused');
  });

  test('refuses a duplicate metadata.id', async () => {
    const model = modelFor(MULTIREF_SPEC);
    const { status } = await post('/api/pipeline/save-as-template', {
      filename: 'fresh-file.stratum.yaml',
      model,
      metadata: { id: 'existing-tmpl' },  // collides with the seeded template's id
    });
    assert.equal(status, 409, 'duplicate metadata.id must be refused');
  });

  test('requires metadata.id', async () => {
    const model = modelFor(MULTIREF_SPEC);
    const { status } = await post('/api/pipeline/save-as-template', {
      filename: 'no-id.stratum.yaml',
      model,
      metadata: { label: 'no id' },
    });
    assert.equal(status, 400, 'missing metadata.id must be refused');
  });

  test('refuses a non-bare / non-.stratum.yaml filename (traversal-safe)', async () => {
    const model = modelFor(MULTIREF_SPEC);
    const a = await post('/api/pipeline/save-as-template', {
      filename: '../escape.stratum.yaml', model, metadata: { id: 'x1' },
    });
    assert.equal(a.status, 400, 'path traversal refused');
    const b = await post('/api/pipeline/save-as-template', {
      filename: 'notyaml.txt', model, metadata: { id: 'x2' },
    });
    assert.equal(b.status, 400, 'non-.stratum.yaml refused');
  });
});
