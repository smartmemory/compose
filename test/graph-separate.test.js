/**
 * graph-separate.test.js — COMP-WIKI-GRAPH-SURFACES-1: no Graph card covers another's label.
 *
 * separateBoxes (pure) over a table of box layouts, the real merged SmartMemory graph among them; then separateLayout
 * over a headless cytoscape with groups, so the mechanism GraphView runs (cards inside a group, then groups moved whole
 * with the loose cards) is what is asserted, not only the helper.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cytoscape from 'cytoscape';
import { separateBoxes, separateLayout } from '../src/components/vision/graphSeparate.js';

const CARD = { w: 150, h: 60 };
const card = (id, x, y) => ({ id, x, y, ...CARD });
const real = JSON.parse(readFileSync(new URL('./fixtures/graph-separate-smartmemory.json', import.meta.url), 'utf8'))
  .boxes.map(([id, x, y, w, h]) => ({ id, x, y, w, h }));

/** Pairs of boxes closer than `gap` on both axes (a rounding hair allowed). */
function crowded(boxes, positions, gap) {
  const at = boxes.map((b) => ({ ...b, ...(positions.get(b.id) ?? {}) }));
  const out = [];
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) {
      const a = at[i], b = at[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap - 1e-6 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap - 1e-6) out.push([a.id, b.id]);
    }
  }
  return out;
}

const PILE = Array.from({ length: 60 }, (_, i) => card(`p${i}`, 0, 0));
const ROW = Array.from({ length: 12 }, (_, i) => card(`r${i}`, i * 40, 0));

const CASES = [
  // name, boxes, gap, moved (exact count or null), max edge sends
  ['already apart: nothing moves', [card('a', 0, 0), card('b', 400, 0), card('c', 0, 300)], 16, 0, 0],
  ['two cards on one spot', [card('a', 0, 0), card('b', 0, 0)], 16, null, 0],
  ['a row of cards 40 px apart', ROW, 16, null, 0],
  ['sixty cards on one spot', PILE, 16, null, 0],
  ['a group box over loose cards', [{ id: 'g', x: 0, y: 0, w: 600, h: 400 }, card('a', 50, 20), card('b', -100, -80), card('c', 700, 0)], 24, null, 0],
  ['the merged SmartMemory graph (440 boxes, 52 groups)', real, 24, null, 5],
];

describe('separateBoxes: every box ends at least `gap` from every other', () => {
  for (const [name, boxes, gap, moved, maxEdge] of CASES) {
    test(name, () => {
      const r = separateBoxes(boxes, { gap });
      assert.deepEqual(crowded(boxes, r.positions, gap), []);
      if (moved !== null) assert.equal(r.positions.size, moved);
      assert.ok(r.unplaced.length <= maxEdge, `${r.unplaced.length} boxes sent to the edge (max ${maxEdge})`);
      // The same input gives the same output, so a reload never reshuffles the graph.
      assert.deepEqual([...separateBoxes(boxes, { gap }).positions], [...r.positions]);
    });
  }
});

describe('separateLayout over a cytoscape graph with groups', () => {
  test('cards inside a group, the groups and the loose cards all end apart; group members stay inside their group', () => {
    const els = [
      { data: { id: 'g1' } }, { data: { id: 'g2' } },
      ...['a', 'b', 'c'].map((id) => ({ data: { id, parent: 'g1' }, position: { x: 0, y: 0 } })),
      ...['d', 'e'].map((id) => ({ data: { id, parent: 'g2' }, position: { x: 30, y: 10 } })),
      { data: { id: 'loose' }, position: { x: 10, y: 5 } },
    ];
    const cy = cytoscape({ headless: true, styleEnabled: true, elements: els,
      style: [{ selector: 'node', style: { width: 150, height: 60, shape: 'round-rectangle' } }, { selector: ':parent', style: { padding: 24 } }] });
    const before = cy.nodes().filter((n) => !n.isParent()).map((n) => [n.id(), n.parent().id()]);
    separateLayout(cy);
    const box = (n, labels) => { const b = n.boundingBox({ includeLabels: labels }); return { id: n.id(), x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2, w: b.w, h: b.h }; };
    const leaves = cy.nodes().filter((n) => !n.isParent()).map((n) => box(n, false));
    assert.deepEqual(crowded(leaves, new Map(), 0), [], 'no two cards overlap');
    const top = cy.nodes().filter((n) => !n.parent().length).map((n) => box(n, true));
    assert.deepEqual(crowded(top, new Map(), 0), [], 'no group overlaps another group or a loose card');
    assert.deepEqual(cy.nodes().filter((n) => !n.isParent()).map((n) => [n.id(), n.parent().id()]), before, 'membership unchanged');
    cy.destroy(); // a live headless instance keeps a timer, and the test process would never exit
  });
});
