/**
 * graph-stable-layout.test.js — COMP-GRAPH-STABLE-LAYOUT-1: the same card set gets the same Graph layout, and it is
 * still a real layout.
 *
 * GraphView builds under a seeded Math.random (graphStableLayout.withSeededRandom) with elements in id order, and keeps
 * fcose's full randomized layout. Rows: repeatability (twice, Active -> All -> Active, shuffled input), Math.random put
 * back, and quality: on a grouped graph the seeded layout is as good as a plain random one, and the first attempt
 * (hashed start + randomize:false, review H1) is not. Real headless cytoscape + fcose, GraphView's own fcose values.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { sortElements, withSeededRandom, mulberry32 } from '../src/components/vision/graphStableLayout.js';

cytoscape.use(fcose);

const SRC = readFileSync(new URL('../src/components/vision/GraphView.jsx', import.meta.url), 'utf8');

// GraphView.jsx's fcose options, verbatim (the source row below keeps them honest).
const FCOSE = {
  name: 'fcose', quality: 'proof', animate: false, fit: false, padding: 20, nodeSeparation: 80,
  idealEdgeLength: 200, nodeRepulsion: 20000, gravity: 0.3, gravityRange: 1.5,
  tilingPaddingVertical: 12, tilingPaddingHorizontal: 12,
};
const STYLE = [
  { selector: 'node', style: { width: 150, height: 60 } },
  { selector: '[?isGroup]', style: { padding: '24px' } },
];

const made = [];
after(() => { for (const cy of made) cy.destroy(); });
function build(elements, { seeded = true, layout = FCOSE } = {}) {
  const make = () => cytoscape({ elements, headless: true, styleEnabled: true, style: STYLE, layout });
  const cy = seeded ? withSeededRandom(() => make()) : make();
  made.push(cy);
  return cy;
}
const stable = (elements) => build(sortElements(elements));
const positions = cy => Object.fromEntries(cy.nodes().filter(n => !n.data('isGroup')).map(n => [n.id(), n.position()]));

/** `groups` groups of `per` cards: each group a hub with leaves and a short chain, plus a few cross-group links. */
function grouped(groups, per) {
  const els = [];
  for (let g = 0; g < groups; g++) {
    els.push({ data: { id: `group-g${g}`, isGroup: true } });
    for (let i = 0; i < per; i++) els.push({ data: { id: `g${g}c${i}`, status: 'PLANNED', parent: `group-g${g}` } });
    for (let i = 1; i < per; i++) {
      const source = i % 3 === 0 ? `g${g}c${i - 1}` : `g${g}c0`;
      els.push({ data: { id: `e-g${g}-${i}`, source, target: `g${g}c${i}` } });
    }
  }
  for (let g = 0; g < groups; g++) {
    els.push({ data: { id: `x-${g}`, source: `g${g}c1`, target: `g${(g + 1) % groups}c2` } });
  }
  return els;
}
function chain(ids) {
  return [
    ...ids.map(id => ({ data: { id, status: 'PLANNED' } })),
    ...ids.slice(1).map((id, i) => ({ data: { id: `e-${ids[i]}-${id}`, source: ids[i], target: id } })),
  ];
}
function shuffled(arr, seed) {
  const rnd = mulberry32(seed), out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** Mean edge length, overlapping group-box pairs, and bounding-box area, straight after fcose. */
function quality(cy) {
  const edges = cy.edges();
  const meanEdge = edges.reduce((s, e) => {
    const a = e.source().position(), b = e.target().position();
    return s + Math.hypot(a.x - b.x, a.y - b.y);
  }, 0) / edges.length;
  const boxes = cy.nodes('[?isGroup]').map(n => n.boundingBox({ includeLabels: false }));
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) overlaps++;
    }
  }
  const bb = cy.elements().boundingBox({ includeLabels: false });
  return { meanEdge, overlaps, area: bb.w * bb.h };
}

// The first attempt (f263d94a), verbatim: start each card at a point hashed from its id, then randomize:false.
function h1Seed(elements) {
  const unitPair = (id) => {
    let hx = 0x811c9dc5, hy = 0x01000193;
    for (let i = 0; i < id.length; i++) {
      hx = Math.imul(hx ^ id.charCodeAt(i), 0x01000193);
      hy = Math.imul(hy ^ id.charCodeAt(i), 0x85ebca6b);
    }
    hy = Math.imul(hy ^ (hy >>> 15), 0x2c1b3c6d);
    return [(hx >>> 0) / 2 ** 32, (hy >>> 0) / 2 ** 32];
  };
  const cards = elements.filter(el => el.data && el.data.source == null && !el.data.isGroup);
  const span = Math.max(400, 250 * Math.sqrt(cards.length));
  return sortElements(elements).map((el) => {
    if (!el.data || el.data.source != null || el.data.isGroup) return el;
    const [u, v] = unitPair(String(el.data.id));
    return { ...el, position: { x: (u - 0.5) * span, y: (v - 0.5) * span } };
  });
}

/** The quality bar: mean edge length within 1.5x of plain random, no more overlapping group boxes. */
function meetsBar(q, plain) {
  return q.meanEdge <= 1.5 * plain.meanEdge && q.overlaps <= plain.overlaps;
}

describe('the same card set gets the same layout', () => {
  test('the same input built twice gives identical positions', () => {
    const els = grouped(4, 15);
    assert.deepEqual(positions(stable(els)), positions(stable(els)));
  });

  test('Active -> All -> Active gives identical positions', () => {
    const active = chain(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const all = chain(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
    const first = positions(stable(active));
    const middle = positions(stable(all));
    assert.notDeepEqual(middle.a, undefined);
    assert.deepEqual(positions(stable(active)), first);
  });

  test('shuffled element order gives identical positions', () => {
    const els = grouped(4, 15);
    assert.deepEqual(positions(stable(shuffled(els, 7))), positions(stable(els)));
  });

  test('without the seed, two builds differ (the cause)', () => {
    const els = sortElements(grouped(4, 15));
    assert.notDeepEqual(positions(build(els, { seeded: false })), positions(build(els, { seeded: false })));
  });
});

describe('Math.random is put back', () => {
  test('after a build, and after a build that throws', () => {
    const original = Math.random;
    stable(grouped(2, 5));
    assert.equal(Math.random, original);
    assert.throws(() => withSeededRandom(() => { throw new Error('boom'); }), /boom/);
    assert.equal(Math.random, original);
  });
});

describe('the seeded layout is a real layout (review L2)', () => {
  const els = grouped(8, 15); // 120 cards, 8 groups, 120 edges
  // Plain random runs vary, so the bar is the median edge length and the worst overlap count over five of them.
  const runs = Array.from({ length: 5 }, () => quality(build(sortElements(els), { seeded: false })));
  const plain = {
    meanEdge: runs.map(r => r.meanEdge).sort((a, b) => a - b)[2],
    overlaps: Math.max(...runs.map(r => r.overlaps)),
    area: runs.map(r => r.area).sort((a, b) => a - b)[2],
  };
  const fmt = q => `edge ${q.meanEdge.toFixed(0)} px, group overlaps ${q.overlaps}/28, area ${(q.area / 1e6).toFixed(2)} Mpx2`;

  test('seeded build: edge length within 1.5x of plain random, no more overlapping group boxes', () => {
    const q = quality(stable(els));
    console.log(`  plain random (median of 5): ${fmt(plain)} | runs: ${runs.map(r => `${r.meanEdge.toFixed(0)}/${r.overlaps}`).join(' ')}`);
    console.log(`  seeded:                     ${fmt(q)} | edge ${(q.meanEdge / plain.meanEdge).toFixed(2)}x, area ${(q.area / plain.area).toFixed(2)}x`);
    assert.ok(meetsBar(q, plain), `seeded ${fmt(q)} vs plain ${fmt(plain)}`);
  });

  test('the H1 config (hashed start + randomize:false) fails the same bar', () => {
    const q = quality(build(h1Seed(els), { seeded: false, layout: { ...FCOSE, randomize: false } }));
    console.log(`  H1 config:                  ${fmt(q)} | edge ${(q.meanEdge / plain.meanEdge).toFixed(2)}x, area ${(q.area / plain.area).toFixed(2)}x`);
    assert.equal(meetsBar(q, plain), false, `H1 ${fmt(q)} unexpectedly met the bar vs plain ${fmt(plain)}`);
  });
});

describe('GraphView wiring', () => {
  test('the constructor runs under withSeededRandom on id-sorted elements, fcose stays randomized', () => {
    assert.match(SRC, /withSeededRandom\(\(\) => cytoscape\(\{/);
    assert.match(SRC, /elements: sortElements\(elements\)/);
    assert.doesNotMatch(SRC, /randomize:\s*false/);
    for (const [k, v] of Object.entries(FCOSE)) {
      if (k === 'name') continue;
      assert.match(SRC, new RegExp(`${k}: ${typeof v === 'string' ? `'${v}'` : v},`), `GraphView fcose ${k}`);
    }
  });

  test('sort is a plain code-unit compare, not locale collation (review L1)', () => {
    const ids = sortElements([{ data: { id: 'b' } }, { data: { id: 'B' } }, { data: { id: 'a' } }, { data: { id: 'Z' } }]).map(e => e.data.id);
    assert.deepEqual(ids, ['B', 'Z', 'a', 'b']);
  });
});
