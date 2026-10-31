/**
 * COMP-COCKPIT-RIBBON-FEED-1: `buildUnitIndex({withEvents})`. One row table: without it the index is exactly what it was
 * (no `events` key, so `/api/units/index` is unchanged); with it every unit carries the raw interval lists the ribbon draws.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUnitIndex } from '../lib/unit-index.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const ROW = {
  title: 'T', state: 'landed', ready_at: '2026-10-31T01:00:00Z', dispatched_at: '2026-10-31T01:10:00Z', author_done_at: '2026-10-31T01:40:00Z',
  landed_at: '2026-10-31T03:00:00Z', account: 'seat2',
  reviews: [{ round: 1, dispatched_at: '2026-10-31T01:50:00Z', at: '2026-10-31T02:00:00Z' }],
  gates: [{ n: 1, started_at: '2026-10-31T02:30:00Z', done_at: '2026-10-31T02:40:00Z' }],
  deploys: [{ host: 'h', at: '2026-10-31T03:10:00Z', sha: 'abc' }],
};

describe('buildUnitIndex withEvents', () => {
  // [name, option, check(index)]
  const ROWS = [
    ['default: no events key', undefined, (ix) => assert.equal('events' in ix.units[0], false)],
    ['false: no events key', false, (ix) => assert.equal('events' in ix.units[0], false)],
    ['true: raw lists and stamps, shallow copies', true, (ix) => {
      const e = ix.units[0].events;
      assert.deepEqual(e.reviews, ROW.reviews);
      assert.notEqual(e.reviews[0], ROW.reviews[0]);
      assert.deepEqual(e.deploys, ROW.deploys);
      assert.deepEqual([e.ready_at, e.dispatched_at, e.landed_at, e.account], [ROW.ready_at, ROW.dispatched_at, ROW.landed_at, 'seat2']);
      assert.deepEqual([e.owner_waits, e.fix_runs, e.fixes], [[], [], []]);
    }],
  ];
  for (const [name, withEvents, check] of ROWS) {
    it(name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'unit-index-ev-'));
      try {
        mkdirSync(join(root, 'queues'));
        writeFileSync(join(root, 'queues', 'x-units.json'), JSON.stringify({ units: { U1: ROW } }));
        const ix = await buildUnitIndex({ queuesDir: join(root, 'queues'), now: NOW, ...(withEvents === undefined ? {} : { withEvents }) });
        check(ix);
        if (!withEvents) {
          const stripped = await buildUnitIndex({ queuesDir: join(root, 'queues'), now: NOW, withEvents: true });
          assert.deepEqual(stripped.units.map(({ events, ...u }) => u), ix.units);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

describe('buildUnitIndex waiting (COMP-COCKPIT-FIXES-1 B)', () => {
  // [name, row fields, expected waiting]. A finished or dead-state unit never waits, on review or on the owner.
  const DEAD = ['retired', 'superseded', 'folded', 'parked', 'held', 'closed', 'done', 'cancelled', 'killed'];
  const AUTHORED = { author_done_at: '2026-10-31T01:00:00Z' };
  const OPEN_WAIT = { owner_waits: [{ start: '2026-10-31T01:00:00Z' }] };
  const ROWS = [
    ['live state review: still waiting on review', { state: 'review', ...AUTHORED }, 'review'],
    ['live state fix with an open owner wait: still waiting on the owner', { state: 'fix', ...AUTHORED, ...OPEN_WAIT }, 'owner'],
    ['landed unit with an open owner wait: finished, not waiting', { state: 'landed', landed_at: '2026-10-31T03:00:00Z', ...OPEN_WAIT }, null],
    ...DEAD.map((state) => [`dead state ${state}, authored and unreviewed: not waiting on review`, { state, ...AUTHORED }, null]),
    ...DEAD.map((state) => [`dead state ${state} with an open owner wait: not waiting on the owner`, { state, ...OPEN_WAIT }, null]),
  ];
  it('is table-driven', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unit-index-wait-'));
    try {
      mkdirSync(join(root, 'queues'));
      const units = Object.fromEntries(ROWS.map(([, f], i) => [`U${i}`, f]));
      writeFileSync(join(root, 'queues', 'x-units.json'), JSON.stringify({ units }));
      const ix = await buildUnitIndex({ queuesDir: join(root, 'queues'), now: NOW });
      assert.equal(ix.units.length, ROWS.length);
      ROWS.forEach(([name, , want], i) => assert.equal(ix.units.find((u) => u.id === `U${i}`).waiting, want, name));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('ownerWaitSince is the open owner wait start (COUNT-ONE-1)', async () => {
    // [name, row fields, expected ownerWaitSince, expected waiting]
    const SINCE_ROWS = [
      ['an open wait', { owner_waits: [{ start: '2026-10-31T01:00:00Z' }] }, '2026-10-31T01:00:00Z', 'owner'],
      ['an ended wait then an open one: the open start', { owner_waits: [{ start: '2026-10-30T01:00:00Z', end: '2026-10-30T02:00:00Z' }, { start: '2026-10-31T05:00:00Z' }] }, '2026-10-31T05:00:00Z', 'owner'],
      ['only an ended wait', { owner_waits: [{ start: '2026-10-30T01:00:00Z', end: '2026-10-30T02:00:00Z' }] }, null, null],
      ['no waits', {}, null, null],
      ['a landed unit with an open wait is not waiting', { landed_at: '2026-10-31T03:00:00Z', owner_waits: [{ start: '2026-10-31T01:00:00Z' }] }, null, null],
    ];
    const root = mkdtempSync(join(tmpdir(), 'unit-index-since-'));
    try {
      mkdirSync(join(root, 'queues'));
      writeFileSync(join(root, 'queues', 'x-units.json'), JSON.stringify({ units: Object.fromEntries(SINCE_ROWS.map(([, f], i) => [`U${i}`, f])) }));
      const ix = await buildUnitIndex({ queuesDir: join(root, 'queues'), now: NOW });
      SINCE_ROWS.forEach(([name, , since, waiting], i) => {
        const u = ix.units.find((x) => x.id === `U${i}`);
        assert.deepEqual([u.ownerWaitSince, u.waiting], [since, waiting], name);
        assert.equal('events' in u, false, `${name}: no events in the default shape`);
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('DEAD_STATES has one home: ribbon-feed uses the unit-index list', async () => {
    const { DEAD_STATES } = await import('../lib/unit-index.js');
    assert.deepEqual(DEAD_STATES, DEAD);
    assert.equal('DEAD_STATES' in (await import('../lib/ribbon-feed.js')), false);
  });
});
