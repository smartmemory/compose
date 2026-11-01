/**
 * graph-layout-persist.test.js — COMP-GRAPH-LAYOUT-PERSIST-1: a rebuilt Graph keeps the owner's saved positions.
 *
 * cytoscape({ layout }) runs fcose synchronously inside the constructor, so a `layoutstop` listener registered after it
 * never fires. GraphView used to apply saved positions from such a listener, so every rebuild (filter or group toggle)
 * came up on a fresh random fcose layout. Rows: (1) the premise, on a real headless cytoscape with fcose; (2) the
 * post-construction step puts saved positions back, places new nodes, and runs separate, fit, viewport in order;
 * (3) GraphView calls that step right after constructing and holds no dead listener.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { separateLayout } from '../src/components/vision/graphSeparate.js';

cytoscape.use(fcose);

const SRC = readFileSync(new URL('../src/components/vision/GraphView.jsx', import.meta.url), 'utf8');
const ids = ['a', 'b', 'c', 'd', 'e'];
const elements = () => [
  ...ids.map(id => ({ data: { id, status: 'PLANNED' } })),
  ...ids.slice(1).map((id, i) => ({ data: { id: `e${i}`, source: ids[i], target: id } })),
];
const made = [];
const build = () => {
  const cy = cytoscape({
    elements: elements(), headless: true, styleEnabled: true,
    style: [{ selector: 'node', style: { width: 150, height: 60 } }],
    layout: { name: 'fcose', animate: false, quality: 'draft' },
  });
  made.push(cy);
  return cy;
};
// a live headless instance keeps a timer, and the test process would never exit
after(() => { for (const cy of made) cy.destroy(); });
const SAVED = { a: { x: 1000, y: 2000 }, b: { x: -500, y: 40 } };
const apply = (cy) => {
  for (const n of cy.nodes()) { const s = SAVED[n.id()]; if (s) n.position(s); }
};

describe('post-construction layout step', () => {
  test('premise: a layoutstop listener registered after the constructor never fires', () => {
    const cy = build();
    let fired = false;
    cy.one('layoutstop', () => { fired = true; });
    assert.equal(fired, false);
    assert.notDeepEqual(cy.$id('a').position(), SAVED.a, 'fcose ignored the saved spot');
  });

  test('settleAfterLayout restores saved positions, runs the steps in order, and only when positions are loaded', async () => {
    const { settleAfterLayout } = await import('../src/components/vision/graphAfterLayout.js');
    for (const loaded of [true, false]) {
      const cy = build();
      const calls = [];
      settleAfterLayout(cy, {
        savedLoaded: loaded,
        applySavedAndCapture: (c) => { calls.push('apply'); apply(c); },
        separateLayout: (c) => { calls.push('separate'); separateLayout(c); },
        applyReadableViewport: () => calls.push('viewport'),
      });
      assert.deepEqual(calls, loaded ? ['apply', 'separate', 'viewport'] : ['separate', 'viewport']);
      if (loaded) {
        // separateLayout may nudge a card that overlaps; these two are 3000 px apart, so they must not move
        assert.deepEqual(cy.$id('a').position(), SAVED.a);
        assert.deepEqual(cy.$id('b').position(), SAVED.b);
      }
    }
  });
});

describe('GraphView wiring', () => {
  test('no dead layoutstop listener after the constructor', () => {
    assert.doesNotMatch(SRC, /cy\.one\('layoutstop'/);
  });

  test('settleAfterLayout is called right after the cytoscape constructor, with the saved-position pieces', () => {
    const at = SRC.indexOf('cytoscape({'); // also matches the seeded wrapper, withSeededRandom(() => cytoscape({
    assert.ok(at >= 0, 'GraphView constructs cytoscape');
    const after = SRC.slice(at);
    const m = after.match(/cyRef\.current = cy;\s*(?:\/\/[^\n]*\s*)*settleAfterLayout\(cy, \{([\s\S]*?)\}\);/);
    assert.ok(m, 'settleAfterLayout(cy, {...}) follows cyRef.current = cy');
    for (const k of ['savedLoaded: savedPositionsLoadedRef.current', 'applySavedAndCapture', 'separateLayout', 'applyReadableViewport']) {
      assert.ok(m[1].includes(k), `passes ${k}`);
    }
  });
});
