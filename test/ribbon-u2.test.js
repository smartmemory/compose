/**
 * ribbon-u2.test.js — COMP-DAYVIEW-DESIGN-FIX-1 U2: the pure mechanisms behind the true-size Day view.
 *
 * F2 (one owner wait per ask: `reconcileOwnerSpans`), F3 (stale means no stamp in 24 h, not dispatch age), RIBBON-ROWS-1
 * M2 (a kept body's waits are judged on its own clock), RANGE-1 M1 (`clientToSvgX` through the viewBox), M3/M7 helpers
 * (`etaAt`, `etaWord` days, `mergedLabel`, future-only `resetTicks`), and U2-DATA Q2 (`fromLocalInput` across a clock change,
 * in a child process whose TZ is America/New_York).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconcileOwnerSpans } from '../lib/owner-spans.js';
import { clientToSvgX, etaAt, etaWord, laneState, mergedLabel, ownerWaitsAtNow, resetTicks } from '../src/components/ribbon/ribbonLayout.js';
import { phoneLines, workingNow } from '../src/components/ribbon/now/nowLists.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const H = 3_600_000;
const iso = (hAgo) => new Date(NOW - hAgo * H).toISOString();
const own = (start, end, over = {}) => ({ kind: 'wait', cause: 'owner', start: iso(start), end: iso(end), ...over });

describe('F2: reconcileOwnerSpans, the queue is the "at now" owner source', () => {
  const work = { kind: 'work', start: iso(5), end: iso(0) };
  // [name, spans, kept indexes]
  const ROWS = [
    ['an open stamp span (extended to now) is dropped: the queue draws the ask', [work, own(3, 0, { open: true })], [0]],
    ['a closed stamp span under a queue span is the same ask, drawn once', [own(3, 1), own(3, 0, { queueId: 'A' })], [1]],
    ['a closed stamp span with no queue span over it is history and stays', [own(9, 7), own(2, 0, { queueId: 'B' })], [0, 1]],
    ['an answered ask (no queue span) and an open stamp draw nothing at now', [work, own(4, 0, { open: true })], [0]],
    ['queue spans and other waits are never touched', [own(2, 0, { queueId: 'C' }), { kind: 'wait', cause: 'review', start: iso(2), end: iso(0), open: true }], [0, 1]],
    ['no spans', undefined, []],
  ];
  it('rows', () => {
    for (const [name, spans, keep] of ROWS) assert.deepEqual(reconcileOwnerSpans(spans), keep.map((i) => spans[i]), name);
  });
  it('one ask (stamp + queue) draws one owner wait at now', () => {
    const lanes = [{ lane: 'web', spans: reconcileOwnerSpans([own(3, 0, { open: true }), own(3, 0, { queueId: 'A' })]) }];
    assert.deepEqual(ownerWaitsAtNow(lanes, NOW), [{ lane: 'web', queueId: 'A' }]);
  });
});

describe('F3 + ROWS M2: what a lane is doing at now', () => {
  const cur = { id: 'U1', title: 'Search', since: iso(30) };
  const fresh = { lane: 'a', current: cur, next: [], marks: [], eta: { p50: '9h' }, spans: [{ kind: 'work', unit: 'U1', start: iso(1), end: iso(0), open: true }] };
  it('dispatched 30 h ago with a work span from 1 h ago reads working, keeps its ETA and counts as working', () => {
    assert.equal(laneState(fresh, NOW).kind, 'working');
    const line = phoneLines({ lanes: [fresh], now: new Date(NOW).toISOString() }, null, NOW)[0];
    assert.equal(line.tone, 'working');
    assert.equal(line.eta, 'in 9h');
    assert.deepEqual(workingNow(null, { lanes: [fresh], now: new Date(NOW).toISOString() }, null, NOW).map((r) => r.unit), ['U1']);
  });
  it('an open span\'s end is not a stamp: only its start counts, so a 30 h old open span is stale', () => {
    const old = { ...fresh, spans: [{ kind: 'work', unit: 'U1', start: iso(29), end: iso(0), open: true }] };
    assert.equal(laneState(old, NOW).kind, 'stale');
  });
  it('a body 5 min old keeps its known wait on its own clock instead of flipping to working', () => {
    const asOf = NOW - 5 * 60_000;
    const l = { lane: 'a', current: { id: 'U1', since: iso(3) }, spans: [{ kind: 'wait', cause: 'review', unit: 'U1', start: iso(2), end: new Date(asOf).toISOString() }] };
    assert.equal(laneState(l, NOW, new Date(asOf).toISOString()).kind, 'wait');
    assert.equal(laneState(l, NOW).kind, 'working', 'without the body clock the same span is over');
  });
});

describe('RANGE M1: clientToSvgX reads the pointer through the viewBox', () => {
  it('a 1200 x 307 viewBox in a 1200 x 153.5 box (meet: scale 0.5, 300 px each side)', () => {
    const rect = { left: 0, width: 1200, height: 153.5 };
    assert.equal(clientToSvgX(346, rect, 1200, 307), 92);
    assert.equal(clientToSvgX(483, rect, 1200, 307), 366);
  });
  it('a box the viewBox\'s own size maps 1:1 after its left edge', () => {
    assert.equal(clientToSvgX(250, { left: 50, width: 1200, height: 300 }, 1200, 300), 200);
  });
});

describe('M3 + M7 helpers', () => {
  const now = '2026-11-03T12:00:00Z';
  it('etaAt: an ISO time is itself, a duration counts from now, anything else is null', () => {
    assert.equal(etaAt('2026-11-03T15:00:00Z', now), Date.parse('2026-11-03T15:00:00Z'));
    assert.equal(etaAt('9h', now), NOW + 9 * H);
    assert.equal(etaAt('soon', now), null);
    assert.equal(etaAt(null, now), null);
  });
  it('etaWord: over two days reads in days, never "in 200h"', () => {
    assert.equal(etaWord('200h', now), 'in 8d 8h');
    assert.equal(etaWord('9h', now), 'in 9h');
    assert.equal(etaWord('', now), 'unknown');
  });
  it('mergedLabel: two seats are named, more are counted, never "x4"', () => {
    assert.equal(mergedLabel([{ seat: 'seat1' }, { seat: 'seat2' }]), 's1, s2');
    assert.equal(mergedLabel([{ seat: 'seat1' }, { seat: 'seat2' }, { seat: 'seat3' }, { seat: 'codex' }]), '4 seats reset');
  });
  it('resetTicks: a reset that already happened is not drawn ahead', () => {
    const pins = [{ kind: 'seatReset', seat: 'seat1', at: iso(1) }, { kind: 'seatReset', seat: 'seat2', at: iso(-1) }];
    const { ticks } = resetTicks(pins, { from: iso(12), to: iso(-12), now: new Date(NOW).toISOString(), trackPx: 1000 });
    assert.deepEqual(ticks.flatMap((t) => t.items.map((p) => p.seat)), ['seat2']);
  });
});

describe('U2-DATA Q2: the date picker keeps its wall hour across a clock change', () => {
  it('under TZ=America/New_York, a picked 09:00 on 2026-11-02 (EST) from an EDT window is 09:00-05:00', () => {
    const mod = fileURLToPath(new URL('../src/components/ribbon/rangeLogic.js', import.meta.url));
    const code = `import(${JSON.stringify(mod)}).then((m) => process.stdout.write(String(m.fromLocalInput('2026-11-02T09:00', '2026-10-31T12:00:00-04:00'))))`;
    const out = execFileSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, TZ: 'America/New_York' }, encoding: 'utf8' });
    assert.equal(out, '2026-11-02T09:00:00-05:00');
  });
});
