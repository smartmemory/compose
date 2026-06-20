/**
 * pipeline-save-wave2.test.js — Wave 2 backend (COMP-PIPE-EDIT-5 / -6).
 *
 * GROUP B: a spec-wide save (no flowName) CREATES a brand-new flows.<name> node
 *          for a just-collapsed sub-flow (steps + input + output), keeps the
 *          parent flow-step's reference, and preserves untouched flows + header.
 * GROUP C: GET /spec returns a stable sha-256 `hash`; POST /save honors an
 *          optional `baseHash` (409 + no-write on mismatch, force bypass, new
 *          hash on success, back-compat when omitted).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);
const { specToModel, collapseToSubflow } = await import(`${ROOT}/src/lib/pipeline-model.js`);

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

function sha256(text) { return createHash('sha256').update(text, 'utf-8').digest('hex'); }

before(() => new Promise(res => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pipeline-save-wave2-'));
  dataDir = join(tmpRoot, '.compose', 'data');
  pipelinesDir = join(tmpRoot, 'pipelines');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(pipelinesDir, { recursive: true });
  copyFileSync(REAL_BUILD, join(pipelinesDir, 'build.stratum.yaml'));

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

// A small SESE spec we can collapse, written to its own file per-test so saves
// don't interfere across tests.
function seseSpecText() {
  return [
    '# metadata:',
    '#   id: sese',
    'version: "0.3"',
    'contracts:',
    '  AOut: {x: {type: string}}',
    '  BOut: {y: {type: string}}',
    '  COut: {z: {type: string}}',
    '  DOut: {w: {type: string}}',
    'flows:',
    '  main:',
    '    input: {seed: {type: string}}',
    '    output: DOut',
    '    steps:',
    '      - id: a',
    '        agent: claude',
    '        intent: a',
    '        inputs: {seed: "$.input.seed"}',
    '        output_contract: AOut',
    '      - id: b',
    '        agent: claude',
    '        intent: b',
    '        inputs: {from_a: "$.steps.a.output.x"}',
    '        output_contract: BOut',
    '        depends_on: [a]',
    '      - id: c',
    '        agent: claude',
    '        intent: c',
    '        inputs: {from_b: "$.steps.b.output.y"}',
    '        output_contract: COut',
    '        depends_on: [b]',
    '      - id: d',
    '        agent: claude',
    '        intent: d',
    '        inputs: {from_c: "$.steps.c.output.z"}',
    '        output_contract: DOut',
    '        depends_on: [c]',
    '  untouched:',
    '    output: AOut',
    '    steps:',
    '      - id: solo',
    '        agent: claude',
    '        intent: solo',
    '        output_contract: AOut',
    '',
  ].join('\n');
}

describe('GROUP B — spec-wide save creates a new collapsed sub-flow', () => {
  test('save WITHOUT flowName creates flows.<sub> with steps+input+output; parent ref + untouched flow preserved', async () => {
    const file = 'sese-b.stratum.yaml';
    writeFileSync(join(pipelinesDir, file), seseSpecText());

    const model = specToModel(YAML.parse(seseSpecText()));
    const r = collapseToSubflow(model, 'main', ['b', 'c'], 'sub');
    assert.equal(r.ok, true, r.reason);
    const flowStepId = model.flows.find(f => f.name === 'main').steps.find(s => s.kind === 'flow').id;

    // Spec-wide save: NO flowName → server writes every model flow, creating
    // the brand-new `sub` flow that does not yet exist on disk.
    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file, model }, // flowName omitted
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);

    const savedParsed = YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8'));

    // The new sub flow exists with steps + input + output.
    assert.ok(savedParsed.flows.sub, 'flows.sub created');
    assert.deepEqual(savedParsed.flows.sub.steps.map(s => s.id), ['b', 'c'], 'sub has the moved steps');
    assert.ok(savedParsed.flows.sub.input && typeof savedParsed.flows.sub.input === 'object', 'sub.input written');
    assert.equal(Object.keys(savedParsed.flows.sub.input).length, 1, 'one input port');
    assert.equal(savedParsed.flows.sub.output, 'COut', 'sub.output written');

    // Parent flow `main` now references the sub-flow via the flow-step.
    const main = savedParsed.flows.main;
    const ids = main.steps.map(s => s.id);
    assert.deepEqual(ids, ['a', flowStepId, 'd'], 'parent flow has a, flow-step, d');
    const flowStep = main.steps.find(s => s.id === flowStepId);
    assert.equal(flowStep.flow, 'sub', 'flow-step references sub');

    // Untouched flow preserved.
    assert.ok(savedParsed.flows.untouched, 'untouched flow preserved');
    assert.deepEqual(savedParsed.flows.untouched.steps.map(s => s.id), ['solo']);

    // Metadata comment header preserved.
    const savedText = readFileSync(join(pipelinesDir, file), 'utf-8');
    assert.ok(savedText.includes('# metadata:'), 'comment header preserved');
  });
});

// A spec with flows.<name>.input, a functions block, workflow.name, and a
// commented contract — to verify the spec-wide save reconciles structural edits
// while preserving comments on untouched nodes.
function structuralSpecText() {
  return [
    'version: "0.3"',
    'contracts:',
    '  # keep this comment on Foo',
    '  Foo:',
    '    a: {type: string}',
    '  Bar:',
    '    b: {type: string}',
    'functions:',
    '  gate_a:',
    '    mode: gate',
    '    timeout: 60',
    '  gate_b:',
    '    mode: gate',
    '    timeout: 120',
    'flows:',
    '  main:',
    '    input:',
    '      seed: {type: string}',
    '      extra: {type: string}',
    '    output: Foo',
    '    steps:',
    '      - id: s1',
    '        agent: claude',
    '        intent: do',
    '        output_contract: Foo',
    '',
  ].join('\n');
}

describe('GROUP B2 — spec-wide save reconciles structural edits (input/functions/workflow.name)', () => {
  test('changing flows.<name>.input AND a functions.<name> field persists on disk; untouched contract keeps its comment', async () => {
    const file = 'structural.stratum.yaml';
    writeFileSync(join(pipelinesDir, file), structuralSpecText());

    const model = specToModel(YAML.parse(structuralSpecText()));
    // Edit a flow input field (add a new field + change an existing one).
    model._doc.flows.main.input.seed = { type: 'number' };      // change type
    model._doc.flows.main.input.added = { type: 'boolean' };    // new field
    delete model._doc.flows.main.input.extra;                   // remove a field
    // Edit a functions field + add + remove.
    model._doc.functions.gate_a.timeout = 999;                  // change
    model._doc.functions.gate_c = { mode: 'gate', timeout: 30 }; // new function
    delete model._doc.functions.gate_b;                         // remove

    // Spec-wide save (NO flowName).
    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);

    const savedText = readFileSync(join(pipelinesDir, file), 'utf-8');
    const saved = YAML.parse(savedText);

    // flows.main.input reconciled.
    assert.equal(saved.flows.main.input.seed.type, 'number', 'input.seed type changed');
    assert.ok(saved.flows.main.input.added, 'input.added created');
    assert.equal(saved.flows.main.input.added.type, 'boolean');
    assert.ok(!('extra' in saved.flows.main.input), 'input.extra removed');

    // functions reconciled.
    assert.equal(saved.functions.gate_a.timeout, 999, 'gate_a.timeout changed');
    assert.ok(saved.functions.gate_c, 'gate_c created');
    assert.equal(saved.functions.gate_c.timeout, 30);
    assert.ok(!('gate_b' in saved.functions), 'gate_b removed');

    // Untouched contract Foo keeps its comment.
    assert.ok(savedText.includes('# keep this comment on Foo'), 'comment on untouched contract preserved');
  });

  test('workflow.name change persists on a spec-wide save', async () => {
    const file = 'wfname.stratum.yaml';
    writeFileSync(join(pipelinesDir, file),
      'version: "0.3"\nworkflow:\n  name: original\n  steps:\n    - id: a\n      agent: x\n');
    const model = specToModel(YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8')));
    // The synthetic flow name reflects workflow.name; change it in _doc.
    model._doc.workflow.name = 'renamed';

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    const saved = YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8'));
    assert.equal(saved.workflow.name, 'renamed', 'workflow.name persisted');
    assert.deepEqual(saved.workflow.steps.map(s => s.id), ['a'], 'steps preserved');
  });
});

describe('GROUP C — conflict hash on GET /spec + POST /save baseHash', () => {
  test('GET /spec returns a stable sha-256 hash of the file text', async () => {
    const { status, data } = await json('/api/pipeline/spec?file=build.stratum.yaml');
    assert.equal(status, 200);
    assert.ok(typeof data.hash === 'string' && data.hash.length === 64, 'hash is a 64-char hex sha-256');
    assert.equal(data.hash, sha256(data.text), 'hash matches sha-256 of returned text');
    // Stable across calls (no write between).
    const again = await json('/api/pipeline/spec?file=build.stratum.yaml');
    assert.equal(again.data.hash, data.hash, 'hash stable across reads');
  });

  test('save with a STALE baseHash returns 409 and does NOT write', async () => {
    const file = 'sese-c1.stratum.yaml';
    writeFileSync(join(pipelinesDir, file), seseSpecText());
    const before = readFileSync(join(pipelinesDir, file), 'utf-8');

    const model = specToModel(YAML.parse(before));
    // Mutate so a write WOULD change the file (rename a step via collapse).
    collapseToSubflow(model, 'main', ['b', 'c'], 'sub');

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file, model, baseHash: 'deadbeef'.repeat(8) }, // bogus 64-char hash
    });
    assert.equal(status, 409, `expected 409, got ${status}`);
    assert.equal(data.conflict, true);
    assert.ok(typeof data.currentHash === 'string' && data.currentHash.length === 64);
    assert.equal(data.currentHash, sha256(before), 'currentHash is the on-disk hash');

    // No write happened.
    assert.equal(readFileSync(join(pipelinesDir, file), 'utf-8'), before, 'file unchanged on conflict');
  });

  test('force:true bypasses the conflict and overwrites', async () => {
    const file = 'sese-c2.stratum.yaml';
    writeFileSync(join(pipelinesDir, file), seseSpecText());
    const model = specToModel(YAML.parse(seseSpecText()));
    collapseToSubflow(model, 'main', ['b', 'c'], 'sub');

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file, model, baseHash: 'deadbeef'.repeat(8), force: true },
    });
    assert.equal(status, 200, `force save failed: ${JSON.stringify(data)}`);
    const saved = YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8'));
    assert.ok(saved.flows.sub, 'force overwrote: sub flow present');
  });

  test('successful save returns the new hash matching the written file', async () => {
    const file = 'sese-c3.stratum.yaml';
    writeFileSync(join(pipelinesDir, file), seseSpecText());
    const onDisk = readFileSync(join(pipelinesDir, file), 'utf-8');
    const baseHash = sha256(onDisk);

    const model = specToModel(YAML.parse(onDisk));
    collapseToSubflow(model, 'main', ['b', 'c'], 'sub');

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file, model, baseHash }, // CORRECT baseHash → no conflict
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    assert.ok(typeof data.hash === 'string' && data.hash.length === 64, 'returns new hash');
    const writtenText = readFileSync(join(pipelinesDir, file), 'utf-8');
    assert.equal(data.hash, sha256(writtenText), 'returned hash matches written file');
    assert.notEqual(data.hash, baseHash, 'hash changed after the write');
  });

  test('save WITHOUT baseHash still works (back-compat)', async () => {
    const file = 'sese-c4.stratum.yaml';
    writeFileSync(join(pipelinesDir, file), seseSpecText());
    const model = specToModel(YAML.parse(seseSpecText()));
    collapseToSubflow(model, 'main', ['b', 'c'], 'sub');

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST',
      body: { file, model }, // no baseHash
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    assert.ok(typeof data.hash === 'string', 'still returns a hash');
    const saved = YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8'));
    assert.ok(saved.flows.sub, 'wrote without baseHash');
  });
});
