/**
 * COMP-COCKPIT-RIBBON-METER-1: the two meter cards and the two server readers behind them. One explicit row table:
 * each row is a behaviour with its own input, including every field a card cannot source (`not recorded`, never a number).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { seatCard, moneyCard, NOT_RECORDED } from '../src/components/ribbon/meter/meterCards.js';
import { apiCreditText } from '../src/components/cockpit/cost/costLogic.js';
import { jumpOf, seatOfWall, laneOfSession } from '../src/components/cockpit/notify/notifyLogic.js';
import { attachUsageRoutes, creditRow, hourlyRows, closedHoursWindow, localIso } from '../server/usage-routes.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const val = (card, label) => card.rows.find((r) => r.label === label);
const SEAT = { id: 'seat2', label: 'Claude Team seat 2', five_h: { used_pct: 96.2, resets_at: '2026-10-31T13:30:00.000Z' }, seven_d: { used_pct: null, resets_at: null, status: 'missing' } };
const SPEND = { ceiling: { text: 'spend today $2,403 / $4,000 (60%) · last 1h $153 (trip $350)', pct: 60 }, spend: { text: 'last 1h $153 API-equiv · 12 calls' } };

const ROWS = [
  ['a Team seat: 5h rounded, 7d says 5h-only, reset clock plus distance, the three no-source lines say not recorded', () => {
    const c = seatCard(SEAT, NOW);
    assert.equal(val(c, '5h used').value, '96%');
    assert.equal(val(c, '7d used').value, 'Team seats are 5h-only');
    assert.match(val(c, 'resets').value, /^\d\d:\d\d \(in 1\.5h\)$/);
    for (const k of ['burn', 'on it', 'auto-hop']) assert.deepEqual(val(c, k), { label: k, value: NOT_RECORDED, missing: true });
    assert.equal(val(c, 'ready work'), undefined);
    assert.equal(c.link.to, 'usage');
  }],
  ['a seat with a 7d reading and idle headroom prints both, ready work from seat_idle', () => {
    const c = seatCard({ ...SEAT, seven_d: { used_pct: 61.4, resets_at: '2026-11-03T00:00:00.000Z', status: 'ok' }, seat_idle: { used_pct: 16, hours_left: 3.4, ready_units: 95 } }, NOW);
    assert.equal(val(c, '7d used').value, '61%');
    assert.equal(val(c, 'ready work').value, '95 units ready, 3.4h left in this window');
  }],
  ['a seat with no readings at all: every number is not recorded, never 0%', () => {
    const c = seatCard({ id: 'seat9', label: 'Claude Team seat 9', five_h: { used_pct: null, resets_at: null }, seven_d: { used_pct: null, resets_at: null } }, NOW);
    for (const k of ['5h used', 'resets', '7d used']) assert.equal(val(c, k).missing, true, k);
    assert.ok(!c.rows.some((r) => /^0%/.test(r.value)));
  }],
  ['money with every source: today and last hour from the data, closed-hour peak, Codex against the cap in the data, credit not set and on hold', () => {
    const hourly = { value: { buckets: [{ start: '2026-10-31T01:00:00+00:00', usd: 40 }, { start: '2026-10-31T02:00:00+00:00', usd: 235 }, { start: '2026-10-31T03:00:00+00:00', usd: 120 }] }, error: null };
    const c = moneyCard({ spend: SPEND, codex: { pts: 9, cap: 13 }, hourly, credit: { value: { balance_usd: null, hold: true }, error: null } });
    assert.match(val(c, 'today').value, /\$2,403 \/ \$4,000/);
    assert.match(val(c, 'last hour').value, /\$153/);
    assert.match(val(c, 'closed hours').value, /^peak \$235 at \d\d:\d\d$/);
    assert.equal(c.bars.hours.length, 3);
    assert.equal(c.bars.max, 235);
    assert.equal(val(c, 'Codex').value, '9 of 13 pts today');
    assert.equal(val(c, 'API credit').value, 'balance not set · API billing on hold');
    assert.equal(c.link.to, 'usage');
  }],
  ['money with nothing: hourly, Codex, today and last hour are all not recorded; credit still reads', () => {
    const c = moneyCard({});
    for (const k of ['today', 'last hour', 'hourly', 'Codex']) assert.equal(val(c, k).value, NOT_RECORDED, k);
    assert.equal(c.bars, null);
    assert.equal(val(c, 'API credit').value, 'reading…');
  }],
  ['money with the hourly reader down or empty: hourly stays not recorded and no bars', () => {
    assert.equal(val(moneyCard({ hourly: { value: null, error: 'timed out' } }), 'hourly').value, NOT_RECORDED);
    assert.equal(moneyCard({ hourly: { value: { buckets: [] }, error: null } }).bars, null);
  }],
  ['a down spend panel prints its own reason, not a number', () => {
    const c = moneyCard({ spend: { ceiling: { down: 'ceiling unavailable: timed out' }, spend: { down: 'spend unavailable: timed out' } } });
    assert.equal(val(c, 'today').value, 'ceiling unavailable: timed out');
    assert.equal(val(c, 'last hour').value, 'spend unavailable: timed out');
  }],
  ['API credit text: a number, null balance, hold, an error, pending', () => {
    assert.equal(apiCreditText({ value: { balance_usd: 412.6, hold: false }, error: null }), 'API credit: $413 left');
    assert.equal(apiCreditText({ value: { balance_usd: null, hold: false }, error: null }), 'API credit: balance not set');
    assert.equal(apiCreditText({ value: { balance_usd: null, hold: true }, error: null }), 'API credit: balance not set · API billing on hold');
    assert.equal(apiCreditText({ value: null, error: 'reader missing: /x' }), 'API credit: unavailable: reader missing: /x');
    assert.equal(apiCreditText(null), 'API credit: reading…');
  }],
  ['tray rows: a seat wall names its seat, a lane lead names its lane, the others name neither', () => {
    assert.equal(seatOfWall('seat1 5h'), 'seat1');
    assert.equal(seatOfWall('load1'), null);
    assert.equal(laneOfSession('ops-main'), 'ops');
    assert.equal(laneOfSession('wk-topic'), null);
    assert.deepEqual(jumpOf({ seat: 'seat2' }), { kind: 'seat', id: 'seat2', label: 'Show seat2 ▸' });
    assert.deepEqual(jumpOf({ lane: 'ops' }), { kind: 'lane', id: 'ops', label: 'Show ops lane ▸' });
    assert.equal(jumpOf({ kind: 'security' }), null);
  }],
  ['server readers: credit keeps a null balance, hourly keeps closed buckets only, a bad document throws', () => {
    assert.deepEqual(creditRow({ balance_usd: null, hold: true, reserve_usd: 10, as_of: 'x' }), { balance_usd: null, hold: true, reserve_usd: 10, as_of: 'x' });
    assert.throws(() => creditRow({}), /no status/);
    assert.deepEqual(hourlyRows({ buckets: [{ start: 'a', usd: 1.5, by_engine: {} }, null, { usd: 3 }] }), [{ start: 'a', usd: 1.5 }]);
    assert.throws(() => hourlyRows({}), /no buckets/);
  }],
  ['the hourly window runs from local midnight to the top of this hour, and is empty in the first hour', () => {
    const w = closedHoursWindow(new Date(2026, 9, 31, 14, 37, 12).getTime());
    assert.equal(w.from, localIso(new Date(2026, 9, 31, 0, 0, 0)));
    assert.equal(w.to, localIso(new Date(2026, 9, 31, 14, 0, 0)));
    assert.match(w.to, /^2026-10-31T14:00:00[+-]\d\d:\d\d$/);
    assert.equal(closedHoursWindow(new Date(2026, 9, 31, 0, 40, 0).getTime()), null);
  }],
  ['LIVE-DATA-1: warm reads the hourly source once at attach, and a rejecting reader still leaves /api/usage/hourly answering', async () => {
    let calls = 0;
    const app = express();
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(String(m));
    attachUsageRoutes(app, { warm: true, readHourly: async () => { calls += 1; throw new Error('spend_attr down'); }, readCredit: async () => ({}), readSeats: async () => ({ seats: [] }) });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    const server = await new Promise((r) => { const s2 = app.listen(0, '127.0.0.1', () => r(s2)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/usage/hourly`);
      assert.equal(res.status, 200);
    } finally { server.close(); console.warn = orig; }
    assert.ok(warns.some((w) => /spend_attr unavailable/.test(w)));
    const quiet = express();
    attachUsageRoutes(quiet, { readHourly: async () => { calls += 1; return {}; }, readCredit: async () => ({}), readSeats: async () => ({ seats: [] }) });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, 'without warm nothing is read at attach');
  }],
];

for (const [name, fn] of ROWS) test(name, fn);
