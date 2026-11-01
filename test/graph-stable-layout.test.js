/**
 * graph-stable-layout.test.js — COMP-GRAPH-STABLE-LAYOUT-1: the same card set always gets the same Graph layout.
 *
 * The read-only project graph (?project=...) loads and saves no layout, and fcose defaults to `randomize: true`, so
 * every rebuild (Status filter, group toggle) reshuffled every card. Rows run a real headless cytoscape with fcose.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { seedPositions, STABLE_FCOSE } from '../src/components/vision/graphStableLayout.js';

cytoscape.use(fcose);

const ids = (n, p = 'c') => Array.from({ length: n }, (_, i) => `${p}${i}`);
const set = (nodeIds) => [
  ...nodeIds.map(id => ({ data: { id, status: 'PLANNED' } })),
  ...nodeIds.slice(1).map((id, i) => ({ data: { id: `e-${nodeIds[i]}-${id}`, source: nodeIds[i], target: id } })),
];
const OLD = { name: 'fcose', quality: 'proof', animate: false, fit: false, padding: 20, nodeSeparation: 80, idealEdgeLength: 200, nodeRepulsion: 20000, gravity: 0.3, gravityRange: 1.5 };
const NEW = { ...OLD, ...STABLE_FCOSE };

/** Build, read every node position, destroy (a leaked instance hangs the suite). */
function positions(elements, layout) {
  const cy = cytoscape({ elements, headless: true, styleEnabled: true, style: [{ selector: 'node', style: { width: 150, height: 60 } }], layout });
  try {
    return Object.fromEntries(cy.nodes().map(n => [n.id(), { x: n.position('x'), y: n.position('y') }]));
  } finally { cy.destroy(); }
}

describe('stable Graph layout', () => {
  test('cause: the old fcose options give a different layout on every build of the same cards', () => {
    assert.notDeepEqual(positions(set(ids(8)), OLD), positions(set(ids(8)), OLD));
  });
  test('same cards twice: identical positions', () => {
    assert.deepEqual(positions(seedPositions(set(ids(8))), NEW), positions(seedPositions(set(ids(8))), NEW));
  });

  test('Active -> All -> Active: the same card set comes back to the same positions', () => {
    const active = ids(8), all = [...ids(8), ...ids(14, 'x')];
    const first = positions(seedPositions(set(active)), NEW);
    positions(seedPositions(set(all)), NEW);
    assert.deepEqual(positions(seedPositions(set(active)), NEW), first);
  });

  test('element order does not matter', () => {
    const els = set(ids(12));
    const shuffled = [...els].sort((a, b) => (a.data.id < b.data.id ? 1 : -1));
    assert.deepEqual(positions(seedPositions(els), NEW), positions(seedPositions(shuffled), NEW));
  });

  test('grouped cards (compound parents) are stable too, and groups get no seeded position', () => {
    const grouped = () => [
      { data: { id: 'group-A', isGroup: true } }, { data: { id: 'group-B', isGroup: true } },
      ...ids(10).map((id, i) => ({ data: { id, status: 'PLANNED', parent: i < 5 ? 'group-A' : 'group-B' } })),
      { data: { id: 'link', source: 'c0', target: 'c7' } },
    ];
    assert.equal(seedPositions(grouped()).filter(e => e.position).length, 10);
    assert.deepEqual(positions(seedPositions(grouped()), NEW), positions(seedPositions(grouped()), NEW));
  });

  test('seeds are distinct per id and do not mutate the input', () => {
    const els = set(ids(40));
    const seeded = seedPositions(els);
    assert.equal(els.some(e => e.position), false);
    const pts = seeded.filter(e => e.position).map(e => `${e.position.x},${e.position.y}`);
    assert.equal(new Set(pts).size, 40);
  });
});
