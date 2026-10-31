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
