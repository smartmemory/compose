/**
 * COMP-SUBAPP-CONTEXT-1: the pure picking rules behind the context panel's sources block.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLastRun, pickUnits, pickHub, unitCarriesFeature, roadmapOf, sourceGate, stateLine, SourceShapeError,
} from '../src/components/cockpit/contextSources.js';

describe('pickLastRun', () => {
  const runs = [
    { id: 'a', featureCode: 'F-1', startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T01:00:00Z' },
    { id: 'b', featureCode: 'F-1', startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-02T01:00:00Z' },
    { id: 'c', featureCode: 'F-2', startedAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T01:00:00Z' },
    { id: 'd', featureCode: 'F-1X', updatedAt: '2026-11-04T00:00:00Z' },
  ];
  it('takes the latest updatedAt among exact-code runs only', () => {
    const r = pickLastRun(runs, 'F-1');
    assert.equal(r.run.id, 'b');
    assert.equal(r.basis, 'updatedAt');
  });
  it('a run without updatedAt is ranked by startedAt and says so', () => {
    const r = pickLastRun([{ id: 'x', featureCode: 'F-9', startedAt: '2026-11-01T00:00:00Z', updatedAt: null }], 'F-9');
    assert.deepEqual([r.run.id, r.basis], ['x', 'startedAt']);
  });
  it('no match is null, not a throw', () => assert.equal(pickLastRun(runs, 'NOPE'), null));
  it('a non-list body throws the shape error', () => {
    assert.throws(() => pickLastRun({ runs: [] }, 'F-1'), SourceShapeError);
    assert.throws(() => pickLastRun(null, 'F-1'), SourceShapeError);
  });
});

describe('pickUnits (the inHostSelection rule)', () => {
  const belt = { units: [
    { id: 'U1', lane: 'forge', features: ['F-1', 'F-2'] },
    { id: 'F-1', lane: 'forge' }, // id equal to the code never matches
    { id: 'U3', lane: 'forge', features: ['f-1'] }, // case-sensitive
    { id: 'U4', lane: 'ops', features: ['F-1-FU'] }, // no prefix match
    { id: 'U5', lane: 'ops', features: ['F-1'] },
  ] };
  it('keeps exact stamped codes in belt order', () => {
    assert.deepEqual(pickUnits(belt, 'F-1').map((u) => u.id), ['U1', 'U5']);
  });
  it('none is null', () => assert.equal(pickUnits(belt, 'F-9'), null));
  it('a body without units throws the shape error', () => {
    assert.throws(() => pickUnits({}, 'F-1'), SourceShapeError);
    assert.throws(() => pickUnits([], 'F-1'), SourceShapeError);
  });
  it('unitCarriesFeature tolerates a unit with no features', () => assert.equal(unitCarriesFeature({ id: 'x' }, 'F-1'), false));
});

describe('pickHub', () => {
  it('a hub with docs is data; docCount prefers total', () => {
    const h = pickHub({ items: [{ doc_id: 'd' }], total: 7, feature: { title: 'T' } });
    assert.equal(h.docCount, 7);
    assert.equal(h.feature.title, 'T');
  });
  it('no feature and no docs is null (empty)', () => assert.equal(pickHub({ items: [], total: 0, feature: null }), null));
  it('a feature with no docs is still data', () => assert.equal(pickHub({ items: [], feature: { title: 'T' } }).docCount, 0));
  it('a body that is not the contract throws', () => {
    assert.throws(() => pickHub({ feature: null }), SourceShapeError);
    assert.throws(() => pickHub('<html>'), SourceShapeError);
  });
});

describe('roadmap, gate, lines', () => {
  it('roadmapOf', () => {
    assert.deepEqual(roadmapOf({ title: 'T', status: 'planned' }, 'F-1'), { code: 'F-1', title: 'T', status: 'planned' });
    assert.equal(roadmapOf(null, 'F-1'), null);
  });
  it('only `no` is not connected', () => {
    assert.equal(sourceGate('no'), 'notConnected');
    for (const a of ['yes', 'unknown', undefined]) assert.equal(sourceGate(a), 'ready');
  });
  it('every state line names its source', () => {
    assert.equal(stateLine('wiki', 'empty', 'F-1'), 'No Wiki data for F-1');
    assert.equal(stateLine('stratum', 'unavailable', 'F-1'), 'Stratum unavailable');
    assert.equal(stateLine('cadence', 'notConnected', 'F-1'), 'Cadence not connected');
    assert.equal(stateLine('cadence', 'loading', 'F-1'), 'Loading Cadence…');
  });
});
