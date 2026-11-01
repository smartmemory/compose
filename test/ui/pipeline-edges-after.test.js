/**
 * COMP-PIPE-EDIT-EDGES-1: the Flow editor reads Stratum v1 `after:` as its edges and
 * writes `after:` back. Before the fix the model surfaced only `depends_on`, so every
 * v1 pipeline (all 11 shipped ones declare `after:`) drew no edges.
 */
import { describe, test, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  specToModel, flowSteps, modelToSpecObject, addDependency, removeDependency, wouldCreateCycle,
} from '../../src/lib/pipeline-model.js';

const PIPELINES = resolve(dirname(fileURLToPath(import.meta.url)), '../../pipelines');

const v1 = (steps) => ({ version: 1, flows: { main: { steps } } });
const v03 = (steps) => ({ workflow: { name: 'main', steps } });
const step = (id, extra = {}) => ({ id, do: 'x', ...extra });
const out = (model) => modelToSpecObject(model).flows.main.steps;
const keysOf = (s) => ({ after: s.after, depends_on: s.depends_on });

// One row per behavior: [name, spec, act(model), expected {after, depends_on} per step id]
const ROWS = [
  ['after only', v1([step('a'), step('b', { after: ['a'] })]), () => {},
    { b: { after: ['a'], depends_on: undefined } }],
  ['depends_on only (read alias) is written as after', v1([step('a'), step('b', { depends_on: ['a'] })]), () => {},
    { b: { after: ['a'], depends_on: undefined } }],
  ['both keys are unioned and written as after', v1([step('a'), step('c'), step('b', { after: ['a'], depends_on: ['c', 'a'] })]), () => {},
    { b: { after: ['a', 'c'], depends_on: undefined } }],
  ['wiring a new edge adds to after', v1([step('a'), step('b')]), (m) => addDependency(m, 'main', 'b', 'a'),
    { b: { after: ['a'], depends_on: undefined } }],
  ['removing the last dep drops the key', v1([step('a'), step('b', { after: ['a'] })]), (m) => removeDependency(m, 'main', 'b', 'a'),
    { b: { after: undefined, depends_on: undefined } }],
  ['v0.3 spec keeps depends_on', v03([step('a'), step('b', { depends_on: ['a'] })]), () => {},
    { b: { after: undefined, depends_on: ['a'] } }],
];

describe('pipeline-model after: edges', () => {
  test.each(ROWS)('%s', (_name, spec, act, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = specToModel(spec);
    act(model);
    const steps = spec.workflow ? modelToSpecObject(model).workflow.steps : out(model);
    for (const [id, want] of Object.entries(expected)) {
      expect(keysOf(steps.find(s => s.id === id))).toEqual(want);
    }
    // `after` never lingers in _extra, so no step carries a duplicated key.
    for (const f of model.flows) for (const s of f.steps) expect(s._extra.after).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(_name.startsWith('both') ? 1 : 0);
    warn.mockRestore();
  });

  test('cycle guard still refuses an after-declared loop', () => {
    const model = specToModel(v1([step('a'), step('b', { after: ['a'] })]));
    expect(wouldCreateCycle(model, 'main', 'a', 'b')).toBe(true);
    expect(wouldCreateCycle(model, 'main', 'b', 'a')).toBe(false);
  });

  test('every shipped pipeline: edge count equals its after: entries and round-trips unchanged', () => {
    const files = readdirSync(PIPELINES).filter(f => f.endsWith('.stratum.yaml'));
    expect(files.length).toBe(11);
    for (const f of files) {
      const doc = YAML.parse(readFileSync(resolve(PIPELINES, f), 'utf8'));
      const model = specToModel(doc);
      let declared = 0; let edges = 0;
      const rawFlows = Object.values(doc.flows || {});
      for (const fl of rawFlows) for (const s of fl.steps || []) declared += (s.after || []).length;
      for (const fl of model.flows) for (const s of fl.steps) edges += s.depends_on.length;
      expect(edges, f).toBe(declared);
      if (process.env.EDGE_COUNTS) console.log(`EDGES ${f} ${edges}`);
      // Round-trip: the serialized step deps equal the input's, with no depends_on key.
      const back = modelToSpecObject(model);
      for (const [name, fl] of Object.entries(back.flows || {})) {
        for (const s of fl.steps || []) {
          const orig = doc.flows[name].steps.find(o => o.id === s.id);
          expect(s.after, `${f}:${name}:${s.id}`).toEqual(orig.after);
          expect(s.depends_on).toBeUndefined();
        }
      }
    }
  });
});
