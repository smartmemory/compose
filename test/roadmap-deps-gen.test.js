/**
 * roadmap-deps-gen.test.js — COMP-ROADMAP-GRAPH-EDGES-1: the deps.yaml edge
 * generator (lib/roadmap-graph/deps-gen.js) and the canonical projection keeping
 * prose `informs` edges. One row table per concern.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  proseEdges, listItemEdges, phaseGroups, phaseOrderEdges, mergeDepsYaml, planProject, applyWrites,
} from '../lib/roadmap-graph/deps-gen.js';
import { buildRoadmapGraph } from '../server/roadmap-graph-vision.js';

const KNOWN = new Set(['COMP-A', 'COMP-B', 'COMP-C']);
const fmt = (edges) => edges.map((e) => `${e.from}->${e.to}`).sort();

describe('proseEdges: each phrase, and the near misses that must not fire', () => {
  const rows = [
    // [line, context, opts, expected]
    ['Depends on COMP-A.', 'COMP-B', {}, ['COMP-A->COMP-B']],
    ['blocked by COMP-A until it lands', 'COMP-B', {}, ['COMP-A->COMP-B']],
    ['requires `COMP-A` (the store)', 'COMP-B', {}, ['COMP-A->COMP-B']],
    ['remote use waits on **COMP-A**', 'COMP-B', {}, ['COMP-A->COMP-B']],
    ['MUST land AFTER COMP-A has moved', 'COMP-B', {}, ['COMP-A->COMP-B']],
    ['COMP-C (Phase 2) waits on COMP-A', 'COMP-B', {}, ['COMP-A->COMP-C']],
    ['after COMP-A merge the count was 1371', 'COMP-B', { allowAfter: false }, []],
    ['we shipped it after the meeting', 'COMP-B', {}, []],
    ['passes after 44 runs', 'COMP-B', {}, []],
    ['this does not depend on COMP-A any more', 'COMP-B', {}, []],
    ['no longer requires COMP-A', 'COMP-B', {}, []],
    ['depends on COMP-GHOST', 'COMP-B', {}, []],
    ['depends on COMP-B', 'COMP-B', {}, []],
    ['depends on COMP-A', null, {}, []],
  ];
  for (const [line, context, opts, expected] of rows) {
    test(JSON.stringify(line), () => assert.deepEqual(fmt(proseEdges(line, KNOWN, context, opts)), expected));
  }
});

describe('listItemEdges: a ROADMAP `Depends On:` item takes codes before the first ; or sentence end', () => {
  const rows = [
    ['- COMP-B: COMP-A, COMP-C; size field from OPS-X (outside, COMP-C again)', ['COMP-A->COMP-B', 'COMP-C->COMP-B']],
    ['- COMP-B: owner pick of the design shape. COMP-C (Phase 2) waits on it.', []],
    ['- COMP-B: none (changes only the log)', []],
    ['- COMP-GHOST: COMP-A', []],
  ];
  for (const [line, expected] of rows) {
    test(line, () => assert.deepEqual(fmt(listItemEdges(line, KNOWN)), expected));
  }
});

describe('phase order: sequential phases get an edge, 1/1b are parallel, a run ends at another heading', () => {
  const roadmap = [
    '## Phase 1: First — IN_PROGRESS', '', '| # | Feature | Item | Status |', '|---|---|---|---|',
    '| 1 | P-A | a | IN_PROGRESS |', '',
    '## Phase 1b: Side — PLANNED', '', '| # | Feature | Item | Status |', '|---|---|---|---|',
    '| 2 | P-B | b | PLANNED |', '',
    '## Phase 2: Next — PLANNED', '', '| # | Feature | Item | Status |', '|---|---|---|---|',
    '| 3 | P-C | c | PLANNED |', '| 4 | P-D | d | COMPLETE |', '| 5 | P-H | h | PLANNED |', '',
    '## Other epic — PLANNED', '',
    '## Phase 3: Elsewhere — PLANNED', '', '| # | Feature | Item | Status |', '|---|---|---|---|',
    '| 6 | P-E | e | PLANNED |', '',
  ].join('\n');
  const known = new Set(['P-A', 'P-B', 'P-C', 'P-D', 'P-E', 'P-H']);
  const groups = phaseGroups(roadmap);
  const rows = [
    // [case, existing edges, expected phase-order edges]
    ['1 and 1b share base 1: no edge between them; phase 2 hangs off the last row of base 1; COMPLETE row gets none; Phase 3 starts a new run',
      [], ['P-B->P-C', 'P-B->P-H']],
    ['a row that already has an inbound edge gets no phase-order edge', [{ from: 'P-A', to: 'P-H' }], ['P-B->P-C']],
  ];
  for (const [name, existing, expected] of rows) {
    test(name, () => assert.deepEqual(fmt(phaseOrderEdges(groups, known, existing)), expected));
  }
});

describe('mergeDepsYaml: hand-written lines are never touched, generated lines are replaced', () => {
  const g = (code, source = 'prose ROADMAP.md:1') => ({ code, source });
  const hand = '# hand header\ndepends_on:\n  - COMP-H\nconcurrent_with:\n  - COMP-X\n';
  const rows = [
    // [case, existing text, generated, expected text]
    ['adds generated lines after the hand-written ones', hand, { depends_on: [g('COMP-A')] },
      '# hand header\ndepends_on:\n  - COMP-H\n  - COMP-A  # source: prose ROADMAP.md:1\nconcurrent_with:\n  - COMP-X\n'],
    ['replaces a stale generated line, keeps the hand one',
      '# hand header\ndepends_on:\n  - COMP-H\n  - COMP-OLD  # source: prose x.md:9\n', { depends_on: [g('COMP-A')] },
      '# hand header\ndepends_on:\n  - COMP-H\n  - COMP-A  # source: prose ROADMAP.md:1\n'],
    ['nothing generated leaves a hand file byte-identical', hand, {}, hand],
    ['a generated-only file with nothing left to generate is removed',
      '# gen header\ndepends_on:\n  - COMP-OLD  # source: list x.md:1\n', {}, null],
    ['a new file gets the header and a blocks key', null, { blocks: [g('COMP-B', 'phase-order Phase 1 -> Phase 2')] }, 'HEADER'],
  ];
  for (const [name, text, gen, expected] of rows) {
    test(name, () => {
      const out = mergeDepsYaml(text, { depends_on: [], blocks: [], ...gen });
      if (expected === 'HEADER') {
        assert.match(out, /^# Roadmap-graph edges \(COMP-ROADMAP-GRAPH-EDGES-1\)/);
        assert.match(out, /\nblocks:\n {2}- COMP-B {2}# source: phase-order Phase 1 -> Phase 2\n$/);
      } else {
        assert.equal(out, expected);
      }
      // Idempotent: merging the same generated set again changes nothing.
      if (out != null) assert.equal(mergeDepsYaml(out, { depends_on: [], blocks: [], ...gen }), out);
    });
  }
});

function mkProject({ folders, roadmap }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-gen-test-'));
  fs.mkdirSync(path.join(dir, '.compose'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.compose', 'compose.json'), JSON.stringify({ paths: { features: 'docs/features' } }));
  for (const [code, files] of Object.entries(folders)) {
    const fdir = path.join(dir, 'docs', 'features', code);
    fs.mkdirSync(fdir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(fdir, name), body);
  }
  fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
  return dir;
}
const spec = (code, extra = {}) => JSON.stringify({ code, status: 'PLANNED', ...extra });
const plan = (dir) => planProject({ root: dir, featuresDir: path.join(dir, 'docs', 'features'), roadmapPath: path.join(dir, 'ROADMAP.md') });
const ROADMAP = [
  '## Work — PLANNED', '', '| # | Feature | Item | Status |', '|---|---|---|---|',
  '| 1 | COMP-A | a | PLANNED |', '| 2 | COMP-B | b; Depends on COMP-A. | PLANNED |', '| 3 | COMP-C | c | PLANNED |', '',
  'Depends On:', '- COMP-C: COMP-B', '',
].join('\n');

describe('planProject on a real directory: write, rerun, hand entries, ignore list', () => {
  const rows = [
    // [case, folders, expected deps.yaml lines per folder after one run]
    ['generated edges land in the dependent folder with their source',
      { 'COMP-A': { 'feature.json': spec('COMP-A') }, 'COMP-B': { 'feature.json': spec('COMP-B') }, 'COMP-C': { 'feature.json': spec('COMP-C') } },
      { 'COMP-B': ['  - COMP-A  # source: prose ROADMAP.md:6'], 'COMP-C': ['  - COMP-B  # source: list ROADMAP.md:10'] }],
    ['a hand-written entry is kept and the same edge is not generated twice',
      { 'COMP-A': { 'feature.json': spec('COMP-A') }, 'COMP-B': { 'feature.json': spec('COMP-B'), 'deps.yaml': 'depends_on:\n  - COMP-A\n' }, 'COMP-C': { 'feature.json': spec('COMP-C') } },
      { 'COMP-B': ['depends_on:', '  - COMP-A'], 'COMP-C': ['  - COMP-B  # source: list ROADMAP.md:10'] }],
    ['a code under ignore_generated stays out',
      { 'COMP-A': { 'feature.json': spec('COMP-A') }, 'COMP-B': { 'feature.json': spec('COMP-B'), 'deps.yaml': 'ignore_generated:\n  - COMP-A\n' }, 'COMP-C': { 'feature.json': spec('COMP-C') } },
      { 'COMP-B': ['ignore_generated:', '  - COMP-A'], 'COMP-C': ['  - COMP-B  # source: list ROADMAP.md:10'] }],
    ['a dependent with no folder is written as `blocks` in the prerequisite folder',
      { 'COMP-A': { 'feature.json': spec('COMP-A') }, 'COMP-B': { 'feature.json': spec('COMP-B') } },
      { 'COMP-B': ['blocks:', '  - COMP-C  # source: list ROADMAP.md:10'] }],
  ];
  for (const [name, folders, expected] of rows) {
    test(name, () => {
      const dir = mkProject({ folders, roadmap: ROADMAP });
      try {
        applyWrites(plan(dir).writes);
        for (const [code, lines] of Object.entries(expected)) {
          const text = fs.readFileSync(path.join(dir, 'docs', 'features', code, 'deps.yaml'), 'utf-8');
          for (const l of lines) assert.ok(text.split('\n').includes(l), `${code}/deps.yaml missing ${JSON.stringify(l)}:\n${text}`);
        }
        // Idempotent: a second run plans no write.
        assert.deepEqual(plan(dir).writes, []);
        // The canonical projection accepts every generated edge (no DANGLING_EDGE).
        assert.doesNotThrow(() => buildRoadmapGraph(dir));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('canonical projection (CLI / MCP roadmap_graph) keeps prose informs edges, typed for a dashed line', () => {
  const rows = [
    // [case, B's design.md, expected edge strings]
    ['a Predecessor line becomes an informs edge', '# B\n\n**Predecessor:** COMP-A\n', ['COMP-A->COMP-B:informs']],
    ['an informs that restates a deps.yaml dependency folds into it', '# B\n\n**Predecessor:** COMP-A\n', ['COMP-A->COMP-B:dep'], 'depends_on:\n  - COMP-A\n'],
  ];
  for (const [name, design, expected, deps] of rows) {
    test(name, () => {
      const dir = mkProject({
        folders: {
          'COMP-A': { 'feature.json': spec('COMP-A') },
          'COMP-B': { 'feature.json': spec('COMP-B'), 'design.md': design, ...(deps ? { 'deps.yaml': deps } : {}) },
        },
        roadmap: '# Roadmap\n',
      });
      try {
        const { edges } = buildRoadmapGraph(dir);
        assert.deepEqual(edges.map((e) => `${e.source}->${e.target}:${e.type}`).sort(), expected);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
