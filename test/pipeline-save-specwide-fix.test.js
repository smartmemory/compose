/**
 * pipeline-save-specwide-fix.test.js — Codex review FIX 5 (spec-wide save completeness).
 *
 * The spec-wide save path (flowName OMITTED) is the authoritative full-document
 * save: model._doc is the parsed YAML pane. Previously its reconcilers were
 * additive-only and dropped edits. These golden tests assert that on a spec-wide
 * save:
 *   (i)  an unsurfaced step field change (on_approve / isolation) persists, and a
 *        _extra key removed in the model is deleted on disk;
 *   (ii) a flows.<name>.output is CREATED when added and DELETED when removed;
 *   (iii) deleting a flows.<name>.input block / the functions block persists;
 *   (iv) a comment on a genuinely-unchanged contract/step still survives.
 *
 * And that the FLOW-SCOPED save (flowName given) stays additive for _extra
 * (preserves disk-only unsurfaced fields).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);
const { specToModel } = await import(`${ROOT}/src/lib/pipeline-model.js`);

let baseUrl, httpServer, pipelinesDir, tmpRoot;

function json(url, opts = {}) {
  return fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }).then(async r => ({ status: r.status, data: await r.json() }));
}

before(() => new Promise(res => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'pipeline-specwide-'));
  pipelinesDir = join(tmpRoot, 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });
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

// A multi-flow spec with: unsurfaced step fields (on_approve/isolation), a flow
// output, a flow input block, a functions block, and a commented contract.
function richSpecText() {
  return [
    'version: "0.3"',
    'contracts:',
    '  # keep this comment on Foo',
    '  Foo:',
    '    a: {type: string}',
    '  Bar:',
    '    b: {type: string}',
    'functions:',
    '  helper:',
    '    mode: compute',
    '    intent: help',
    'flows:',
    '  main:',
    '    input:',
    '      seed: {type: string}',
    '    output: Foo',
    '    steps:',
    '      - id: gate',
    '        function: gate_fn',
    '        on_approve: work',
    '        on_revise: work',
    '      - id: work',
    '        agent: claude',
    '        intent: do',
    '        isolation: worktree',
    '        skip_if: "false"',
    '        output_contract: Foo',
    '  other:',
    '    input:',
    '      x: {type: string}',
    '    output: Bar',
    '    steps:',
    '      - id: solo',
    '        agent: claude',
    '        intent: solo',
    '        output_contract: Bar',
    '',
  ].join('\n');
}

function writeFresh(file) {
  writeFileSync(join(pipelinesDir, file), richSpecText());
}
function readSaved(file) {
  const text = readFileSync(join(pipelinesDir, file), 'utf-8');
  return { text, parsed: YAML.parse(text) };
}

describe('FIX 5a — spec-wide save updates AND deletes unsurfaced (_extra) step fields', () => {
  test('changed on_approve + isolation persist; a removed _extra key (skip_if) is deleted', async () => {
    const file = '5a.stratum.yaml';
    writeFresh(file);
    const model = specToModel(YAML.parse(richSpecText()));

    const main = model.flows.find(f => f.name === 'main');
    const gate = main.steps.find(s => s.id === 'gate');
    const work = main.steps.find(s => s.id === 'work');
    // Change an unsurfaced gate route.
    gate._extra.on_approve = 'work';      // unchanged value (control)
    gate._extra.on_revise = 'gate';       // CHANGED value
    // Change isolation, and DELETE skip_if from the model step.
    work._extra.isolation = 'none';       // CHANGED
    delete work._extra.skip_if;           // REMOVED

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model }, // spec-wide (no flowName)
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);

    const { parsed } = readSaved(file);
    const savedGate = parsed.flows.main.steps.find(s => s.id === 'gate');
    const savedWork = parsed.flows.main.steps.find(s => s.id === 'work');
    assert.equal(savedGate.on_revise, 'gate', 'changed on_revise persisted');
    assert.equal(savedWork.isolation, 'none', 'changed isolation persisted');
    assert.ok(!('skip_if' in savedWork), 'removed skip_if deleted on spec-wide save');
  });
});

describe('FIX 5b — spec-wide save creates AND deletes flows.<name>.output', () => {
  test('adds output to a flow that lacked it; removes output from a flow that had it', async () => {
    const file = '5b.stratum.yaml';
    // Spec where `main` HAS an output and a third flow `noout` lacks one.
    const text = [
      'version: "0.3"',
      'contracts:',
      '  Foo: {a: {type: string}}',
      '  Bar: {b: {type: string}}',
      'flows:',
      '  main:',
      '    output: Foo',
      '    steps:',
      '      - id: m1',
      '        agent: claude',
      '        intent: m',
      '        output_contract: Foo',
      '  noout:',
      '    steps:',
      '      - id: n1',
      '        agent: claude',
      '        intent: n',
      '        output_contract: Bar',
      '',
    ].join('\n');
    writeFileSync(join(pipelinesDir, file), text);
    const model = specToModel(YAML.parse(text));

    // Remove main.output, add noout.output.
    delete model._doc.flows.main.output;
    model._doc.flows.noout.output = 'Bar';

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);

    const { parsed } = readSaved(file);
    assert.ok(!('output' in parsed.flows.main), 'main.output deleted');
    assert.equal(parsed.flows.noout.output, 'Bar', 'noout.output created');
  });
});

describe('FIX 5c — spec-wide save deletes whole blocks (flow input / functions)', () => {
  test('deleting flows.<name>.input and the functions block persists on disk', async () => {
    const file = '5c.stratum.yaml';
    writeFresh(file);
    const model = specToModel(YAML.parse(richSpecText()));

    delete model._doc.flows.other.input;   // remove a whole flow input block
    delete model._doc.functions;           // remove the whole functions block

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);

    const { parsed } = readSaved(file);
    assert.ok(!('input' in parsed.flows.other), 'other.input block deleted');
    assert.ok(!parsed.functions, 'functions block deleted');
  });

  test('workflow.name deletion persists on a spec-wide save', async () => {
    const file = '5c-wf.stratum.yaml';
    writeFileSync(join(pipelinesDir, file),
      'version: "0.3"\nworkflow:\n  name: original\n  steps:\n    - id: a\n      agent: x\n');
    const model = specToModel(YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8')));
    delete model._doc.workflow.name;

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model },
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    const { parsed } = readSaved(file);
    assert.ok(!('name' in parsed.workflow), 'workflow.name deleted');
    assert.deepEqual(parsed.workflow.steps.map(s => s.id), ['a'], 'steps preserved');
  });
});

describe('FIX 5 (iv) — comments on genuinely-unchanged nodes survive a spec-wide save', () => {
  test('the comment on the untouched Foo contract survives', async () => {
    const file = '5d.stratum.yaml';
    writeFresh(file);
    const model = specToModel(YAML.parse(richSpecText()));
    // Make a tiny unrelated edit so the save does work, but leave Foo untouched.
    model._doc.flows.main.input.seed = { type: 'number' };

    const { status } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model },
    });
    assert.equal(status, 200);
    const { text } = readSaved(file);
    assert.ok(text.includes('# keep this comment on Foo'), 'comment on unchanged contract preserved');
  });
});

describe('FIX 5a — FLOW-SCOPED save stays additive for _extra (regression guard)', () => {
  test('a flow-scoped save does NOT delete a disk _extra key absent from the model step', async () => {
    const file = '5e.stratum.yaml';
    writeFresh(file);
    const model = specToModel(YAML.parse(richSpecText()));
    const work = model.flows.find(f => f.name === 'main').steps.find(s => s.id === 'work');
    // Remove skip_if from the model — but flow-scoped save must PRESERVE it on disk.
    delete work._extra.skip_if;

    const { status, data } = await json('/api/pipeline/save', {
      method: 'POST', body: { file, model, flowName: 'main' }, // FLOW-SCOPED
    });
    assert.equal(status, 200, `save failed: ${JSON.stringify(data)}`);
    const { parsed } = readSaved(file);
    const savedWork = parsed.flows.main.steps.find(s => s.id === 'work');
    assert.equal(savedWork.skip_if, 'false', 'flow-scoped save preserves disk-only skip_if');
  });
});

describe('FIX 2 (server) — workflow.output is reconciled to disk', () => {
  function writeWorkflowSpec(file) {
    writeFileSync(join(pipelinesDir, file), [
      'version: "0.2"',
      'contracts:',
      '  Foo:',
      '    a: {type: string}',
      'workflow:',
      '  name: wf',
      '  output: Foo',
      '  steps:',
      '    - id: only',
      '      agent: claude',
      '      intent: do',
      '      output_contract: Foo',
      '',
    ].join('\n'));
  }

  test('a contract rename that rewrites workflow.output persists on a spec-wide save', async () => {
    const file = 'wfout.stratum.yaml';
    writeWorkflowSpec(file);
    const model = specToModel(YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8')));
    // Simulate a contract rename's effect on the workflow output ref.
    model._doc.workflow.output = 'Renamed';
    const { status } = await json('/api/pipeline/save', { method: 'POST', body: { file, model } });
    assert.equal(status, 200);
    assert.equal(readSaved(file).parsed.workflow.output, 'Renamed', 'workflow.output rename persisted');
  });

  test('deleting workflow.output persists on a spec-wide save', async () => {
    const file = 'wfout-del.stratum.yaml';
    writeWorkflowSpec(file);
    const model = specToModel(YAML.parse(readFileSync(join(pipelinesDir, file), 'utf-8')));
    delete model._doc.workflow.output;
    const { status } = await json('/api/pipeline/save', { method: 'POST', body: { file, model } });
    assert.equal(status, 200);
    assert.equal('output' in (readSaved(file).parsed.workflow), false, 'workflow.output deleted');
  });
});
