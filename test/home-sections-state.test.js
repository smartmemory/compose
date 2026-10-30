/**
 * home-sections-state.test.js — COMP-AUDIT-18: what Home shows, from store data only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHomeSections, needsYouCount, HOME_RECENT_LIMIT } from '../src/components/vision/homeSectionsState.js';
import { graphInitialViewport, largestGroupCentre, READABLE_ZOOM } from '../src/components/vision/graphInitialViewport.js';

const feat = (id, status, extra = {}) => ({ id, type: 'feature', title: id, status, ...extra });

describe('deriveHomeSections', () => {
  test('Needs you: pending gates of ALL features, blocked items, open decisions, last 3 errors (newest first)', () => {
    const items = [
      feat('a', 'in_progress'),
      feat('b', 'blocked'),
      { id: 'd', type: 'decision', title: 'd', status: 'planned' },
      { id: 'd2', type: 'decision', title: 'd2', status: 'complete' },
    ];
    const gates = [
      { id: 'g1', itemId: 'a', status: 'pending' },
      { id: 'g2', itemId: 'a', status: 'approved' },
      { id: 'g3', itemId: 'gone', status: 'pending' },
    ];
    const agentErrors = [1, 2, 3, 4].map(n => ({ message: `e${n}`, timestamp: `2026-10-30T0${n}:00:00Z` }));
    const { needsYou } = deriveHomeSections({ items, gates, agentErrors });
    assert.deepEqual(needsYou.gates.map(g => g.gate.id), ['g1', 'g3']);
    assert.equal(needsYou.gates[0].item.id, 'a');
    assert.equal(needsYou.gates[1].item, null);
    assert.deepEqual(needsYou.queue.map(e => e.item.id).sort(), ['b', 'd']);
    assert.deepEqual(needsYou.errors.map(e => e.message), ['e4', 'e3', 'e2']);
    assert.equal(needsYouCount(needsYou), 2 + 2 + 3);
  });

  test('sections are empty when there is nothing', () => {
    const s = deriveHomeSections({});
    assert.equal(needsYouCount(s.needsYou), 0);
    assert.deepEqual([s.running.build, s.running.agents, s.inProgress, s.recentlyChanged, s.recentBuilds], [null, [], [], [], []]);
  });

  test('In progress = features with status in_progress only', () => {
    const items = [feat('a', 'in_progress'), feat('b', 'planned'), { id: 't', type: 'task', status: 'in_progress' }];
    assert.deepEqual(deriveHomeSections({ items }).inProgress.map(i => i.id), ['a']);
  });

  test('Recently changed: done features sorted by updatedAt desc, labelled by last edit, capped; missing dates last', () => {
    const items = [
      feat('old', 'complete', { updatedAt: '2026-01-01T00:00:00Z' }),
      feat('nodate', 'done'),
      feat('new', 'complete', { updatedAt: '2026-10-29T00:00:00Z' }),
      feat('open', 'in_progress', { updatedAt: '2026-10-30T00:00:00Z' }),
      ...[1, 2, 3, 4, 5].map(n => feat(`m${n}`, 'complete', { updatedAt: `2026-06-0${n}T00:00:00Z` })),
    ];
    const ids = deriveHomeSections({ items }).recentlyChanged.map(i => i.id);
    assert.equal(ids.length, HOME_RECENT_LIMIT);
    assert.deepEqual(ids, ['new', 'm5', 'm4', 'm3', 'm2']);
  });

  test('Running now: the active build and only running agents; Recent builds capped', () => {
    const s = deriveHomeSections({
      activeBuild: { featureCode: 'X-1' },
      spawnedAgents: [{ agentId: 'a1', status: 'running' }, { agentId: 'a2', status: 'complete' }],
      buildHistory: [1, 2, 3, 4, 5, 6, 7].map(n => ({ featureCode: `F-${n}`, status: 'complete' })),
    });
    assert.equal(s.running.build.featureCode, 'X-1');
    assert.deepEqual(s.running.agents.map(a => a.agentId), ['a1']);
    assert.deepEqual(s.recentBuilds.map(b => b.featureCode), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5']);
  });
});

describe('graphInitialViewport', () => {
  const at = (x, y) => ({ x, y });
  test('fit already readable keeps the fitted view; below the floor zooms to it, centred by priority', () => {
    const rows = [
      { name: 'readable fit', fitted: 1.5, c: { focused: at(1, 1) }, zoom: 1.5, centre: null },
      { name: 'exactly the floor', fitted: READABLE_ZOOM, c: { focused: at(1, 1) }, zoom: READABLE_ZOOM, centre: null },
      { name: 'focused wins', fitted: 0.3, c: { focused: at(1, 1), inProgress: at(2, 2), largestGroup: at(3, 3) }, zoom: READABLE_ZOOM, centre: at(1, 1) },
      { name: 'in-progress next', fitted: 0.3, c: { focused: null, inProgress: at(2, 2), largestGroup: at(3, 3) }, zoom: READABLE_ZOOM, centre: at(2, 2) },
      { name: 'largest group last', fitted: 0.3, c: { largestGroup: at(3, 3) }, zoom: READABLE_ZOOM, centre: at(3, 3) },
      { name: 'no candidate: graph centre', fitted: 0.3, c: {}, zoom: READABLE_ZOOM, centre: null },
      { name: 'no candidates object', fitted: 0.05, c: undefined, zoom: READABLE_ZOOM, centre: null },
    ];
    for (const r of rows) {
      assert.deepEqual(graphInitialViewport({ fittedZoom: r.fitted, candidates: r.c }), { zoom: r.zoom, centre: r.centre }, r.name);
    }
    assert.ok(READABLE_ZOOM * 9 >= 10);
  });

  test('largestGroupCentre: biggest group mean, ties to first seen, junk ignored', () => {
    assert.deepEqual(largestGroupCentre([
      { group: 'A', x: 0, y: 0 }, { group: 'B', x: 10, y: 10 }, { group: 'B', x: 20, y: 30 },
      { group: null, x: 99, y: 99 }, { group: 'B', x: NaN, y: 0 },
    ]), { x: 15, y: 20 });
    assert.deepEqual(largestGroupCentre([{ group: 'A', x: 1, y: 1 }, { group: 'B', x: 5, y: 5 }]), { x: 1, y: 1 });
    assert.equal(largestGroupCentre([]), null);
    assert.equal(largestGroupCentre(undefined), null);
  });
});
