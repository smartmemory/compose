/**
 * availability-check.test.js — FORGE-PL L1: a transient failure is not "no" (one row table across the
 * four hooks' shared probe). Only a definitive answer sets `no`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkAvailability } from '../src/components/cockpit/availabilityCheck.js';

const ok = (json) => async () => ({ ok: true, status: 200, json: async () => json });
const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });
const boom = (msg) => async () => { throw new Error(msg); };
const seq = (...fns) => { let i = 0; return (...a) => fns[Math.min(i++, fns.length - 1)](...a); };

const DECIDE = {
  ops: (j) => (Array.isArray(j?.pages) && j.pages.length ? 'yes' : 'no'),
  stratum: (j) => (j?.available === true ? 'yes' : 'no'),
  cadence: (j) => (j?.available === true ? 'yes' : 'no'),
  wiki: (j) => (j?.available === true ? 'yes' : 'no'),
};

describe('checkAvailability: one row table across ops, stratum, cadence, wiki', () => {
  const rows = [
    { name: 'ok -> yes', hook: 'ops', fetch: ok({ pages: ['a'] }), state: 'yes', fetches: 1, warns: 0, waits: 0 },
    { name: 'ok, definitively absent -> no', hook: 'stratum', fetch: ok({ available: false }), state: 'no', fetches: 1, warns: 0, waits: 0 },
    { name: 'ok, empty pages -> no', hook: 'ops', fetch: ok({ pages: [] }), state: 'no', fetches: 1, warns: 0, waits: 0 },
    { name: '404 route absent -> no, no retry', hook: 'cadence', fetch: status(404), state: 'no', fetches: 1, warns: 0, waits: 0 },
    { name: 'network error then ok -> yes after one retry, warned once', hook: 'wiki', fetch: seq(boom('ECONNREFUSED'), ok({ available: true })), state: 'yes', fetches: 2, warns: 1, waits: 1 },
    { name: '503 then ok -> yes', hook: 'stratum', fetch: seq(status(503), ok({ available: true })), state: 'yes', fetches: 2, warns: 1, waits: 1 },
    { name: 'error twice -> still unknown, warned once', hook: 'cadence', fetch: boom('socket hang up'), state: 'unknown', fetches: 2, warns: 1, waits: 1 },
    { name: '500 twice -> still unknown, warned once', hook: 'ops', fetch: status(500), state: 'unknown', fetches: 2, warns: 1, waits: 1 },
    { name: 'error then definitive no -> no', hook: 'wiki', fetch: seq(boom('reset'), ok({ available: false })), state: 'no', fetches: 2, warns: 1, waits: 1 },
  ];
  test('rows', async () => {
    for (const r of rows) {
      let fetches = 0; const warns = []; let waits = 0; const urls = [];
      const fetchFn = async (url) => { fetches += 1; urls.push(url); return r.fetch(url); };
      const got = await checkAvailability({
        name: r.hook, url: `/api/${r.hook}/available`, decide: DECIDE[r.hook], fetchFn,
        wait: async (ms) => { waits += 1; assert.equal(ms, 3000, `${r.name}: retry after 3 s`); },
        warn: (m) => warns.push(m),
      });
      assert.equal(got.state, r.state, r.name);
      assert.equal(fetches, r.fetches, `${r.name} fetches`);
      assert.equal(warns.length, r.warns, `${r.name} warns`);
      assert.equal(waits, r.waits, `${r.name} waits`);
      for (const w of warns) assert.match(w, new RegExp(`^\\[nav\\] ${r.hook} availability check failed: .+`), r.name);
    }
  });

  test('an unmounted caller stops quietly (no retry, no warning)', async () => {
    const warns = [];
    const got = await checkAvailability({ name: 'ops', url: '/x', decide: DECIDE.ops, fetchFn: boom('x'), wait: async () => {}, warn: (m) => warns.push(m), isLive: () => false });
    assert.equal(got.state, 'unknown');
    assert.equal(warns.length, 0);
  });
});
