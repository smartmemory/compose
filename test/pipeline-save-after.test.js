/**
 * COMP-PIPE-EDIT-EDGES-1 F1: the save path writes the dependency list under the
 * spec version's own key (`after` for v1, `depends_on` for v0.3), never both, and
 * keeps comments on untouched lines. One row table, one real server per row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);
const { specToModel, addDependency } = await import(`${ROOT}/src/lib/pipeline-model.js`);

const sha256 = (t) => createHash('sha256').update(t, 'utf-8').digest('hex');

const V1 = (a, b) => `version: 1\n# keep me\nflows:\n  entry: main\n  main:\n    steps:\n      - id: a\n        agent: x\n        timeout: 30  # trailing note\n        do: "A"\n      - id: b\n        agent: y\n        do: "B"\n${b}`;
const V03 = 'version: "0.3"\nworkflow:\n  name: w\n  steps:\n    - id: a\n      agent: x\n      intent: "A"\n    - id: b\n      agent: y\n      intent: "B"\n';

const stepsOf = (doc) => doc.workflow ? doc.workflow.steps : doc.flows.main.steps;
const dep = (doc, id) => { const s = stepsOf(doc).find(x => x.id === id); return { after: s.after, depends_on: s.depends_on }; };

// [name, yaml on disk, flow name, mutate(model), expected for step b, text that must survive]
const ROWS = [
  ['v1 save of a wired edge writes `after` only', V1('', ''), 'main', (m) => addDependency(m, 'main', 'b', 'a'),
    { after: ['a'], depends_on: undefined }, '# keep me'],
  ['v0.3 save keeps `depends_on`', V03, 'w', (m) => addDependency(m, 'w', 'b', 'a'),
    { after: undefined, depends_on: ['a'] }, null],
  ['a v1 node on disk with both keys is saved with one', V1('', '        after: [a]\n        depends_on: [a]\n'), 'main', () => {},
    { after: ['a'], depends_on: undefined }, '# trailing note'],
  ['an unchanged `after` keeps its flow style and trailing comment', V1('', '        after: [a]  # b waits on a\n'), 'main', () => {},
    { after: ['a'], depends_on: undefined }, '# b waits on a'],
  ['a v1 node with only the legacy key is saved as `after`', V1('', '        depends_on: [a]\n'), 'main', () => {},
    { after: ['a'], depends_on: undefined }, '# keep me'],
];

async function save(yamlText, flowName, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-save-after-'));
  const pipelines = join(dir, 'pipelines');
  mkdirSync(pipelines, { recursive: true });
  const fp = join(pipelines, 't.stratum.yaml');
  writeFileSync(fp, yamlText);
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  attachPipelineRoutes(app, {
    broadcastMessage: () => {}, scheduleBroadcast: () => {},
    getDataDir: () => join(dir, 'data'), getPipelinesDir: () => pipelines, stratumClient: null,
  });
  const srv = createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const model = specToModel(YAML.parse(yamlText));
    mutate(model);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/pipeline/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 't.stratum.yaml', model, flowName, baseHash: sha256(yamlText) }),
    });
    assert.equal(r.status, 200, `save failed: ${await r.text()}`);
    return { text: readFileSync(fp, 'utf-8'), doc: YAML.parse(readFileSync(fp, 'utf-8')) };
  } finally {
    await new Promise(r => srv.close(r));
  }
}

describe('POST /api/pipeline/save: dependency key follows the spec version', () => {
  for (const [name, yamlText, flow, mutate, want, survives] of ROWS) {
    test(name, async () => {
      const { text, doc } = await save(yamlText, flow, mutate);
      assert.deepEqual(dep(doc, 'b'), want);
      if (survives) assert.ok(text.includes(survives), `comment ${survives} lost`);
    });
  }

  test('wire then save round-trips: reloading the saved file shows the same edge', async () => {
    const { text, doc } = await save(V1('', ''), 'main', (m) => addDependency(m, 'main', 'b', 'a'));
    assert.equal(/depends_on/.test(text), false);
    assert.deepEqual(specToModel(doc).flows[0].steps.find(s => s.id === 'b').depends_on, ['a']);
  });
});
