import { describe, it, expect } from 'vitest';
import cytoscape from 'cytoscape';
import { elementKey, planRefresh, syncElements } from '../../src/components/graphSync.js';

// COMP-ROADMAP-GRAPH-ZOOM-DRIFT-1: a refresh must not throw away the viewport the user set.
const n = (id, color = '#aaa') => ({ data: { id, label: id, color } });
const e = (s, t) => ({ data: { id: `${s}-${t}`, source: s, target: t } });
const base = [n('a'), n('b'), e('a', 'b')];
const withColor = [n('a', '#f00'), n('b'), e('a', 'b')];
const withExtra = [...base, n('c')];

const state = (key, elements) => ({ key, setKey: elementKey(elements) });

describe('GraphRenderer refresh policy', () => {
  const rows = [
    // name, prev, next, touched, expected
    ['data-only refresh', state('dagre|false|graph', base), state('dagre|false|graph', withColor), true, { recreate: false, relayout: false, fit: false, restore: false }],
    ['data-only refresh, untouched', state('dagre|false|graph', base), state('dagre|false|graph', withColor), false, { recreate: false, relayout: false, fit: false, restore: false }],
    ['set change, untouched', state('dagre|false|graph', base), state('dagre|false|graph', withExtra), false, { recreate: false, relayout: true, fit: true, restore: false }],
    ['set change after a user zoom', state('dagre|false|graph', base), state('dagre|false|graph', withExtra), true, { recreate: false, relayout: true, fit: false, restore: true }],
    ['theme change after a user zoom', state('dagre|false|graph', base), state('dagre|true|graph', base), true, { recreate: true, relayout: true, fit: false, restore: true }],
    ['first mount', null, state('dagre|false|graph', base), false, { recreate: true, relayout: true, fit: true, restore: false }],
  ];
  it.each(rows)('%s', (_name, prev, next, touched, expected) => {
    expect(planRefresh(prev, next, touched)).toEqual(expected);
  });
});

describe('syncElements patches one live instance', () => {
  const make = () => cytoscape({ headless: true, elements: base });
  const rows = [
    ['colour change keeps the set', withColor, false],
    ['added node reports a set change', withExtra, true],
    ['removed node reports a set change', [n('a')], true],
  ];
  it.each(rows)('%s', (_name, next, setChanged) => {
    const cy = make();
    const nodeA = cy.getElementById('a');
    expect(syncElements(cy, next)).toBe(setChanged);
    expect(cy.getElementById('a')).toEqual(nodeA); // same element object: nothing was rebuilt
    expect(cy.nodes().length).toBe(next.filter((x) => !x.data.source).length);
    expect(cy.getElementById('a').data('color')).toBe(next[0].data.color);
  });
});
