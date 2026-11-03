/**
 * ribbon-owner-wait.test.js — COMP-DAYVIEW-DESIGN-FIX-1 U1: what a lane is doing at now (S1/S2) and the owner wait (C3).
 *
 * The mechanism, not the picture: `laneState` is the one answer the NOW text, the phone list and the legend share;
 * `ownerWaits` puts every open owner ask on a lane; `withOwnerOpen` keeps only the asks the WHAT line still counts, so
 * the headline count and the owner spans drawn at now are the same number over the same queue.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { laneState, ownerWaitsAtNow, withOwnerOpen, STALE_MS } from '../src/components/ribbon/ribbonLayout.js';
import { ownerWaits } from '../server/ribbon-routes.js';
import { ownerAsks } from '../src/components/cockpit/notify/notifyLogic.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (hAgo) => new Date(NOW - hAgo * 3_600_000).toISOString();
const span = (kind, over = {}) => ({ kind, start: iso(2), end: iso(0), ...over });
const lane = (name, spans = [], current = null) => ({ lane: name, spans, current });

describe('laneState', () => {
  // [name, lane, want(kind, cause, phrase)]
  const ROWS = [
    ['nothing at now is null', lane('a', [span('work', { end: iso(1) })]), null],
    ['current unit dispatched 3h ago is working with its age', lane('a', [span('work')], { id: 'U1', since: iso(3) }), ['working', undefined, 'working 3h']],
    ['current unit with no dispatch stamp is working with no age', lane('a', [span('work')], { id: 'U1' }), ['working', undefined, 'working']],
    ['dispatched over 24h ago and nothing waits is stale', lane('a', [span('work')], { id: 'U1', since: iso(30) }), ['stale', undefined, 'stale: working 1d 6h, no stamp in 24h']],
    ['a review wait wins over the current unit', lane('a', [span('work'), span('wait', { cause: 'review' })], { id: 'U1', since: iso(5) }), ['wait', 'review', null]],
    ['an owner wait wins over a review wait and counts from the ask', lane('a', [span('wait', { cause: 'review' }), span('wait', { cause: 'owner', since: iso(4) })], { id: 'U1', since: iso(30) }), ['wait', 'owner', null]],
    ['a stale lane with a wait is a wait, not stale', lane('a', [span('wait', { cause: 'gate' })], { id: 'U1', since: iso(48) }), ['wait', 'gate', null]],
    ['a notRecorded span is never a state', lane('a', [span('notRecorded')]), null],
  ];
  it('rows', () => {
    for (const [name, l, want] of ROWS) {
      const got = laneState(l, NOW);
      if (want === null) { assert.equal(got, null, name); continue; }
      assert.equal(got.kind, want[0], name);
      if (want[1]) assert.equal(got.cause, want[1], name);
      if (want[2]) assert.equal(got.phrase, want[2], name);
    }
  });
  it('the stale line is exactly 24h of dispatch age', () => {
    assert.equal(laneState(lane('a', [], { id: 'U1', since: new Date(NOW - STALE_MS).toISOString() }), NOW).kind, 'working');
    assert.equal(laneState(lane('a', [], { id: 'U1', since: new Date(NOW - STALE_MS - 60_000).toISOString() }), NOW).kind, 'stale');
  });
  it('a review wait counts from the start of its open span (U2 RIBBON-ROWS-1 M1), an owner wait from the ask', () => {
    assert.equal(laneState(lane('a', [span('wait', { cause: 'review' })], { id: 'U1', since: iso(5) }), NOW).since, NOW - 2 * 3_600_000);
    assert.equal(laneState(lane('a', [span('wait', { cause: 'gate', start: iso(7) })], { id: 'U1', since: iso(5) }), NOW).since, NOW - 7 * 3_600_000);
    assert.equal(laneState(lane('a', [span('wait', { cause: 'owner', start: iso(1) })], { id: 'U1', since: iso(5) }), NOW).since, NOW - 3_600_000);
  });
});

describe('ownerWaits (the producer)', () => {
  const ts = (hAgo) => (NOW - hAgo * 3_600_000) / 1000;
  const queue = [
    { id: 'A', status: 'open', by: 'forge-main', ts: ts(3), text: 'ASK: ship it?' },
    { id: 'B', status: 'open', by: 'notify-ntfy', ts: ts(1), text: 'ASK: subscribe?' },
    { id: 'C', status: 'open', by: 'forge-main', ts: ts(2), text: 'FYI: deployed' },
    { id: 'D', status: 'open', by: 'x', ts: ts(5), text: 'ASK: which?', unit: 'U7' },
    { id: 'E', status: 'open', by: 'x', ts: ts(6), text: 'ASK: old' },
    { id: 'E', status: 'closed', closed_ts: ts(4) },
  ];
  const units = [{ id: 'U7', lane: 'web' }];
  const got = ownerWaits({ queue, units, lanes: ['forge', 'web', 'ops'], from: NOW - 24 * 3_600_000, to: NOW, now: NOW });

  it('only open asks are open, each on its lane; an FYI is never an ask', () => {
    assert.deepEqual(got.open.map((o) => `${o.id}@${o.lane}`).sort(), ['A@forge', 'B@ops', 'D@web']);
    assert.equal(got.open.find((o) => o.id === 'A').age, 3 * 3600);
  });
  it('spans: by lane, then unit lane, then the ops row with laneGuess; a closed ask ends at its close', () => {
    const by = Object.fromEntries(got.spans.map((s) => [s.span.queueId, s]));
    assert.deepEqual(Object.keys(by).sort(), ['A', 'B', 'D', 'E']);
    assert.deepEqual([by.A.lane, by.A.span.laneGuess, by.A.span.cause, by.A.span.end], ['forge', false, 'owner', iso(0)]);
    assert.deepEqual([by.B.lane, by.B.span.laneGuess], ['ops', true]);
    assert.match(by.B.span.why, /no lane named: shown on ops/);
    assert.equal(by.D.lane, 'web');
    assert.equal(by.E.span.end, iso(4));
  });
  it('an ask before the window opens is clipped to the window, its since keeps the real ask time', () => {
    const w = ownerWaits({ queue, units, lanes: ['forge'], from: NOW - 3_600_000, to: NOW, now: NOW });
    const a = w.spans.find((s) => s.span.queueId === 'A').span;
    assert.deepEqual([a.start, a.since], [iso(1), iso(3)]);
  });
});

describe('headline count equals the owner spans drawn at now', () => {
  const ts = (hAgo) => (NOW - hAgo * 3_600_000) / 1000;
  const queue = [
    { id: 'A', status: 'open', by: 'forge-main', ts: ts(3), text: 'ASK: ship it?' },
    { id: 'B', status: 'open', by: 'web-main', ts: ts(1), text: 'SECURITY: rotate?' },
    { id: 'C', status: 'open', by: 'forge-main', ts: ts(2), text: 'FYI: deployed' },
  ];
  const feedOf = () => {
    const lanes = [lane('forge'), lane('web'), lane('ops')];
    const ow = ownerWaits({ queue, units: [], lanes: lanes.map((l) => l.lane), from: NOW - 24 * 3_600_000, to: NOW, now: NOW });
    for (const { lane: name, span: s } of ow.spans) lanes.find((l) => l.lane === name).spans.push(s);
    return { lanes, owner: { open: ow.open } };
  };
  it('with no notify state', () => {
    const feed = feedOf();
    const asks = ownerAsks(feed.owner.open, null, NOW);
    const drawn = ownerWaitsAtNow(withOwnerOpen(feed, asks.rows.map((r) => r.id), NOW).lanes, NOW);
    assert.equal(asks.n, 2);
    assert.deepEqual(drawn.map((d) => d.queueId).sort(), asks.rows.map((r) => r.id).sort());
  });
  it('an ask the headline no longer counts is not drawn at now either', () => {
    const feed = feedOf();
    const drawn = ownerWaitsAtNow(withOwnerOpen(feed, ['B'], NOW).lanes, NOW);
    assert.deepEqual(drawn.map((d) => d.queueId), ['B']);
  });
  it('an unknown headline (null ids) drops nothing', () => {
    const feed = feedOf();
    assert.equal(withOwnerOpen(feed, null, NOW), feed);
  });
});
