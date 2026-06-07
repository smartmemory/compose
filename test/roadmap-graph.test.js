/**
 * roadmap-graph.test.js — unit tests for the roadmap dependency graph generator
 * (COMP-ROADMAP-GRAPH-1). Covers the model rules (drop, dangling refusal,
 * edge normalization), collection (status precedence, deps.yaml validation),
 * and render idempotency.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildGraph, depsToEdges, DanglingEdgeError, DROP_STATUSES } from '../lib/roadmap-graph/model.js';
import { collectGraphInputs } from '../lib/roadmap-graph/collect.js';
import { renderGraphHtml } from '../lib/roadmap-graph/render.js';
import { buildRoadmapGraph, generateRoadmapGraph, checkRoadmapGraph } from '../lib/roadmap-graph/index.js';

// ---- fixture helpers -------------------------------------------------------

function mkProject(features = {}, { roadmap = null, config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
  fs.mkdirSync(path.join(dir, '.compose'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: 'testproj', paths: { features: 'docs/features' }, ...config }, null, 2));
  for (const [code, spec] of Object.entries(features)) {
    const fdir = path.join(dir, 'docs', 'features', code);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'feature.json'), JSON.stringify({
      code, description: spec.description || `${code} desc`, status: spec.status || 'PLANNED',
      phase: spec.phase || 'Phase 0', position: spec.position ?? 1,
      ...(spec.name ? { name: spec.name } : {}),
      ...(spec.track ? { track: spec.track } : {}),
      ...(spec.priority ? { priority: spec.priority } : {}),
    }, null, 2));
    if (spec.deps != null) fs.writeFileSync(path.join(fdir, 'deps.yaml'), spec.deps);
    if (spec.design) fs.writeFileSync(path.join(fdir, 'design.md'), spec.design);
  }
  if (roadmap) fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
  return dir;
}

// ---- model.buildGraph ------------------------------------------------------

describe('model.buildGraph', () => {
  test('drops COMPLETE/SUPERSEDED/KILLED nodes', () => {
    const nodes = [
      { id: 'A', status: 'PLANNED' },
      { id: 'B', status: 'COMPLETE' },
      { id: 'C', status: 'SUPERSEDED' },
      { id: 'D', status: 'KILLED' },
      { id: 'E', status: 'IN_PROGRESS' },
    ];
    const { nodes: out, dropped } = buildGraph({ nodes, rawEdges: [], knownCodes: new Set(['A','B','C','D','E']) });
    assert.deepEqual(out.map(n => n.id).sort(), ['A', 'E']);
    assert.deepEqual(dropped.sort(), ['B', 'C', 'D']);
  });

  test('refuses to emit on a dangling edge (unknown target)', () => {
    const nodes = [{ id: 'A', status: 'PLANNED' }];
    assert.throws(
      () => buildGraph({ nodes, rawEdges: [{ from: 'A', to: 'GHOST', type: 'dep' }], knownCodes: new Set(['A']) }),
      (err) => err instanceof DanglingEdgeError && err.code === 'DANGLING_EDGE' && err.dangling.length === 1,
    );
  });

  test('dangling error names the actual unknown endpoint (from, not just to)', () => {
    const nodes = [{ id: 'B', status: 'PLANNED' }];
    // edge GHOST -> B: the source is unknown, the target B is known
    let err;
    try { buildGraph({ nodes, rawEdges: [{ from: 'GHOST', to: 'B', type: 'dep' }], knownCodes: new Set(['B']) }); }
    catch (e) { err = e; }
    assert.ok(err instanceof DanglingEdgeError);
    assert.deepEqual(err.dangling[0].missing, ['GHOST']);
    assert.match(err.message, /GHOST is not a known feature/);
    assert.doesNotMatch(err.message, /B is not a known feature/);
  });

  test('silently drops an edge to a known-but-dropped node (not dangling)', () => {
    const nodes = [{ id: 'A', status: 'PLANNED' }, { id: 'B', status: 'COMPLETE' }];
    const { edges } = buildGraph({
      nodes, rawEdges: [{ from: 'B', to: 'A', type: 'dep' }], knownCodes: new Set(['A', 'B']),
    });
    assert.equal(edges.length, 0, 'edge to a completed (dropped) node is silently removed, not an error');
  });

  test('dedups identical edges and sorts deterministically', () => {
    const nodes = [{ id: 'A', status: 'PLANNED' }, { id: 'B', status: 'PLANNED' }, { id: 'C', status: 'PLANNED' }];
    const raw = [
      { from: 'B', to: 'A', type: 'dep' },
      { from: 'B', to: 'A', type: 'dep' }, // dup
      { from: 'C', to: 'A', type: 'dep' },
    ];
    const { edges } = buildGraph({ nodes, rawEdges: raw, knownCodes: new Set(['A', 'B', 'C']) });
    assert.equal(edges.length, 2);
    assert.deepEqual(edges, [
      { source: 'B', target: 'A', type: 'dep' },
      { source: 'C', target: 'A', type: 'dep' },
    ]);
  });

  test('maps status to lowercase template vocabulary + defaults', () => {
    const nodes = [{ id: 'A', status: 'IN_PROGRESS', name: 'Alpha' }];
    const { nodes: out } = buildGraph({ nodes, rawEdges: [], knownCodes: new Set(['A']) });
    assert.equal(out[0].status, 'in_progress');
    assert.equal(out[0].priority, 'medium');
    assert.equal(out[0].track, 'standalone');
    assert.equal(out[0].label, 'A\nAlpha');
  });
});

describe('model.depsToEdges', () => {
  test('depends_on -> prerequisite->dependent; blocks -> inverse; concurrent canonicalized', () => {
    const e = depsToEdges('F', { depends_on: ['X'], blocks: ['Y'], concurrent_with: ['A'] });
    assert.deepEqual(e, [
      { from: 'X', to: 'F', type: 'dep' },
      { from: 'F', to: 'Y', type: 'dep' },
      { from: 'A', to: 'F', type: 'concurrent' }, // canonicalized min<max => A,F
    ]);
  });
  test('tolerates missing/empty keys', () => {
    assert.deepEqual(depsToEdges('F', {}), []);
    assert.deepEqual(depsToEdges('F', { depends_on: null }), []);
  });
});

// ---- collect ---------------------------------------------------------------

describe('collectGraphInputs', () => {
  test('feature.json status wins; ROADMAP-only feature falls back with a warning', () => {
    const roadmap = [
      '# Test Roadmap', '',
      '## Phase 0', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | RG-A-1 | folder feature | PLANNED |',
      '| 2 | RG-ROADONLY-1 | only in roadmap | IN_PROGRESS |',
      '',
    ].join('\n');
    const dir = mkProject({ 'RG-A-1': { status: 'PARTIAL' } }, { roadmap });
    const { nodes, knownCodes, warnings } = collectGraphInputs(dir);
    const a = nodes.find(n => n.id === 'RG-A-1');
    assert.equal(a.status, 'PARTIAL', 'feature.json status wins over ROADMAP row');
    assert.ok(knownCodes.has('RG-ROADONLY-1'), 'ROADMAP-only feature joins the node universe');
    assert.ok(warnings.some(w => w.includes('RG-ROADONLY-1')), 'unregistered feature surfaces a warning');
  });

  test('invalid deps.yaml is skipped with a warning (not fatal)', () => {
    const dir = mkProject({ A: { status: 'PLANNED', deps: 'depends_on:\n  - "lowercase-bad"\n' } });
    const { rawEdges, warnings } = collectGraphInputs(dir);
    assert.equal(rawEdges.length, 0);
    assert.ok(warnings.some(w => w.includes('invalid deps.yaml')));
  });

  test('external-prefix codes are known-but-unrendered: dep target absent from ROADMAP does not dangle', () => {
    const dir = mkProject({
      'RG-A-1': { status: 'PLANNED', deps: 'depends_on:\n  - STRAT-X-1\n' }, // external dep, nowhere local
      'STRAT-OWNED-1': { status: 'PLANNED' }, // external-prefixed folder
    }, { config: { externalPrefixes: ['STRAT-'] } });
    const { nodes, knownCodes } = collectGraphInputs(dir);
    assert.ok(!nodes.some(n => n.id === 'STRAT-OWNED-1'), 'external-prefixed folder is not rendered');
    assert.ok(knownCodes.has('STRAT-X-1'), 'external dep target is known even without a ROADMAP row');
    assert.ok(knownCodes.has('STRAT-OWNED-1'), 'external folder is a known code');
    // and the whole pipeline must not refuse on the external edge
    assert.doesNotThrow(() => generateRoadmapGraph(dir));
    const a = nodes.find(n => n.id === 'RG-A-1');
    assert.ok(a, 'local feature still rendered');
  });

  test('design.md frontmatter overrides feature.json display metadata', () => {
    const design = '---\nname: Designed Name\ntrack: knowledge\npriority: high\n---\n# body\n';
    const dir = mkProject({ A: { status: 'PLANNED', name: 'JsonName', track: 'platform', design } });
    const { nodes } = collectGraphInputs(dir);
    const a = nodes.find(n => n.id === 'A');
    assert.equal(a.name, 'Designed Name');
    assert.equal(a.track, 'knowledge');
    assert.equal(a.priority, 'high');
  });
});

// ---- render idempotency ----------------------------------------------------

describe('renderGraphHtml', () => {
  test('is deterministic for identical inputs', () => {
    const input = {
      nodes: [{ id: 'A', label: 'A\nAlpha', name: 'Alpha', status: 'planned', priority: 'medium', track: 'standalone', desc: '' }],
      edges: [],
      config: { title: 'T', subtitle: '', tracks: { standalone: '#64748b' } },
    };
    const h1 = renderGraphHtml(input);
    const h2 = renderGraphHtml(input);
    assert.equal(h1, h2);
    assert.ok(h1.includes('const nodes ='));
    assert.ok(h1.includes('"id": "A"'));
    assert.ok(h1.includes('@generated:nodes:start'));
  });
});

// ---- end-to-end via index --------------------------------------------------

describe('generate/check', () => {
  test('generate then check reports a fixed point (zero diff on re-run)', () => {
    const dir = mkProject({
      A: { status: 'PLANNED', position: 1 },
      B: { status: 'PLANNED', position: 2, deps: 'depends_on:\n  - A\n' },
      DONE: { status: 'COMPLETE', position: 3 },
    });
    const gen = generateRoadmapGraph(dir);
    assert.equal(gen.nodeCount, 2, 'COMPLETE node dropped');
    assert.equal(gen.edgeCount, 1);
    assert.equal(gen.droppedCount, 1);

    const chk = checkRoadmapGraph(dir);
    assert.equal(chk.matches, true, 'regenerated output is byte-identical');

    // second generate produces an identical file
    const before = fs.readFileSync(gen.path, 'utf-8');
    generateRoadmapGraph(dir);
    const after = fs.readFileSync(gen.path, 'utf-8');
    assert.equal(before, after);
  });

  test('check reports stale when the file is hand-mutated', () => {
    const dir = mkProject({ A: { status: 'PLANNED' } });
    const gen = generateRoadmapGraph(dir);
    fs.appendFileSync(gen.path, '\n<!-- tampered -->\n');
    const chk = checkRoadmapGraph(dir);
    assert.equal(chk.matches, false);
    assert.match(chk.diffSummary, /stale/);
  });

  test('check reports missing before first generate', () => {
    const dir = mkProject({ A: { status: 'PLANNED' } });
    const chk = checkRoadmapGraph(dir);
    assert.equal(chk.exists, false);
    assert.match(chk.diffSummary, /missing/);
  });

  test('generate refuses (throws) on a dangling deps.yaml edge', () => {
    const dir = mkProject({ A: { status: 'PLANNED', deps: 'depends_on:\n  - NOSUCH\n' } });
    assert.throws(() => generateRoadmapGraph(dir), (e) => e.code === 'DANGLING_EDGE');
  });

  test('honors compose.json#roadmap_graph.out and custom tracks', () => {
    const dir = mkProject(
      { A: { status: 'PLANNED', track: 'knowledge' } },
      { config: { roadmap_graph: { out: 'docs/graph.html', title: 'Custom', tracks: { knowledge: '#123456' } } } },
    );
    const gen = generateRoadmapGraph(dir);
    assert.ok(gen.path.endsWith(path.join('docs', 'graph.html')));
    const html = fs.readFileSync(gen.path, 'utf-8');
    assert.ok(html.includes('"title": "Custom"'));
    assert.ok(html.includes('#123456'));
  });
});

describe('edge cases', () => {
  test('empty project yields a valid 0-node graph (no throw)', () => {
    const dir = mkProject({});
    const gen = generateRoadmapGraph(dir);
    assert.equal(gen.nodeCount, 0);
    assert.equal(gen.edgeCount, 0);
    const html = fs.readFileSync(gen.path, 'utf-8');
    assert.ok(html.includes('const nodes = []'));
  });

  test('concurrent_with renders a single canonicalized concurrent edge', () => {
    const dir = mkProject({
      'RG-X-1': { status: 'PLANNED', position: 1, deps: 'concurrent_with:\n  - RG-Y-1\n' },
      'RG-Y-1': { status: 'PLANNED', position: 2, deps: 'concurrent_with:\n  - RG-X-1\n' }, // both declare it
    });
    const built = buildRoadmapGraph(dir);
    const conc = built.edges.filter(e => e.type === 'concurrent');
    assert.equal(conc.length, 1, 'reciprocal concurrent declarations dedup to one edge');
    assert.deepEqual(conc[0], { source: 'RG-X-1', target: 'RG-Y-1', type: 'concurrent' });
  });
});

test('DROP_STATUSES is the documented set', () => {
  assert.deepEqual([...DROP_STATUSES].sort(), ['COMPLETE', 'KILLED', 'SUPERSEDED']);
});
