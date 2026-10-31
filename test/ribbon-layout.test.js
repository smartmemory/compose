/**
 * ribbon-layout.test.js — the pure half of the Day ribbon (COMP-COCKPIT-RIBBON-ROWS-1).
 *
 * One row table: each row runs one layout/wording function and states what it must return. Times are the
 * day fixture's (now Sat 31 Oct 16:40, offset -07:00), so the strings are the ones the mock shows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AXIS_STEP, axisStepHours, axisTicks, etaLabel, fmtDur, isLive, layoutLanes, tipText, windowTitle, xOf } from '../src/components/ribbon/ribbonLayout.js';

const day = JSON.parse(readFileSync(new URL('./fixtures/ribbon/day.json', import.meta.url), 'utf8'));
const NOW = '2026-10-31T16:40:00-07:00';
const at = (h) => `2026-10-31T${h}:00-07:00`;
const win = (hours) => ['2026-10-31T00:00:00-07:00', new Date(Date.parse('2026-10-31T00:00:00-07:00') + hours * 3_600_000).toISOString()];
const ids = (rows) => rows.map((r) => r.lane);
const folded = layoutLanes(day.lanes, { idleOpen: false, seats: [{ label: 'seat3', pct: 21 }] });
const opsOf = (g) => g.find((x) => x.group === 'ops');

const ROWS = [
  // xOf / isLive
  { name: 'xOf: from is 0', run: () => xOf('2026-10-31T00:00:00-07:00', ...win(10), 1000), want: 0 },
  { name: 'xOf: half way', run: () => xOf('2026-10-31T05:00:00-07:00', ...win(10), 1000), want: 500 },
  { name: 'xOf: to is the width', run: () => xOf(win(10)[1], ...win(10), 1000), want: 1000 },
  { name: 'isLive: now inside', run: () => isLive(day.from, day.to, NOW), want: true },
  { name: 'isLive: now after the window', run: () => isLive('2026-10-29T18:00:00-07:00', '2026-10-30T18:00:00-07:00', NOW), want: false },
  // AXIS_STEP
  { name: 'AXIS_STEP: 6 h is 1 h ticks', run: () => axisStepHours(...win(6)), want: 1 },
  { name: 'AXIS_STEP: the day default (36 h) is 3 h', run: () => axisStepHours(day.from, day.to), want: 3 },
  { name: 'AXIS_STEP: 3 d is 12 h', run: () => axisStepHours(...win(72)), want: 12 },
  { name: 'AXIS_STEP: a week is 1 d', run: () => axisStepHours(...win(168)), want: 24 },
  { name: 'AXIS_STEP: table is named and ends open', run: () => AXIS_STEP[AXIS_STEP.length - 1].maxHours, want: Infinity },
  // axis ticks
  { name: 'axisTicks: day window labels the 3 h ticks, midnight is a day', run: () => axisTicks(day.from, day.to, 1096).map((k) => k.label).join(','), want: '21:00,Sat 31,03:00,06:00,09:00,12:00,15:00,18:00,21:00,Sun 1,03:00' },
  { name: 'axisTicks: never closer than 48 px', run: () => { const k = axisTicks(...win(168), 300); return Math.min(...k.slice(1).map((t, i) => t.x - k[i].x)) >= 48; }, want: true },
  // layoutLanes
  { name: 'layoutLanes: PRODUCT then OPS', run: () => folded.map((g) => g.label).join(','), want: 'PRODUCT,OPS' },
  { name: 'layoutLanes: idle lanes leave the rows', run: () => ids(opsOf(folded).rows).join(','), want: 'ops,wiki' },
  { name: 'layoutLanes: one idle row per group with the names', run: () => `${opsOf(folded).idle.n}:${opsOf(folded).idle.names.join('|')}`, want: '3:maya|docs|trader' },
  { name: 'layoutLanes: a group with no idle lane has no idle row', run: () => folded[0].idle, want: null },
  { name: 'layoutLanes: seat note when the seat is under 50%', run: () => opsOf(folded).idle.seatNote, want: '(seat3 has room for them)' },
  { name: 'layoutLanes: no note when the seat is at 50% or more', run: () => opsOf(layoutLanes(day.lanes, { seats: [{ label: 'seat3', pct: 50 }] })).idle.seatNote, want: null },
  { name: 'layoutLanes: no note when no seat reading is passed', run: () => opsOf(layoutLanes(day.lanes)).idle.seatNote, want: null },
  { name: 'layoutLanes: open flag is carried', run: () => opsOf(layoutLanes(day.lanes, { idleOpen: true })).idle.open, want: true },
  // fmtDur
  { name: 'fmtDur: hours and minutes', run: () => fmtDur(270 * 60_000), want: '4h 30m' },
  { name: 'fmtDur: minutes only', run: () => fmtDur(40 * 60_000), want: '40m' },
  { name: 'fmtDur: whole hours', run: () => fmtDur(120 * 60_000), want: '2h' },
  { name: 'fmtDur: days and hours', run: () => fmtDur((51 * 60) * 60_000), want: '2d 3h' },
  // window title, ETA label
  { name: 'windowTitle: day default reads relative to now', run: () => windowTitle(day.from, day.to, NOW), want: 'Lanes · yesterday 18:00 to tomorrow 06:00' },
  { name: 'windowTitle: other windows read as dates', run: () => windowTitle('2026-10-20T18:00:00-07:00', '2026-10-22T06:00:00-07:00', NOW), want: 'Lanes · Tue 20 Oct 18:00 to Thu 22 Oct 06:00' },
  { name: 'windowTitle: a past window near now still reads as dates', run: () => windowTitle('2026-10-29T18:00:00-07:00', '2026-10-30T18:00:00-07:00', NOW), want: 'Lanes · Thu 29 Oct 18:00 to Fri 30 Oct 18:00' },
  { name: 'etaLabel: same day, next day, further out', run: () => [etaLabel(at('21:30'), NOW), etaLabel('2026-11-01T02:00:00-07:00', NOW), etaLabel('2026-11-02T12:00:00-07:00', NOW)].join('|'), want: '21:30|02:00 Sun|Mon' },
  // tipText per kind and cause
  { name: 'tip work (ongoing)', run: () => tipText({ kind: 'work', lane: '2.0', title: 'Search filters by workspace', start: at('09:30'), end: NOW, now: NOW }), want: '2.0 · working on Search filters by workspace\nsince 09:30 (7h 10m)' },
  { name: 'tip work (finished)', run: () => tipText({ kind: 'work', lane: '2.0', title: 'Beta banner', start: at('06:00'), end: at('09:20'), now: NOW }), want: '2.0 · working on Beta banner\n06:00 to 09:20 (3h 20m)' },
  { name: 'tip wait review', run: () => tipText({ kind: 'wait', lane: '2.0', cause: 'review', title: 'T', start: at('09:30'), end: at('14:00'), now: NOW }), want: '2.0 · waiting on review 4h 30m\nT\n09:30 to 14:00' },
  { name: 'tip wait quota', run: () => tipText({ kind: 'wait', lane: '2.0', cause: 'quota', title: 'T', start: at('16:00'), end: NOW, now: NOW }).split('\n')[0], want: '2.0 · waiting on quota 40m' },
  { name: 'tip wait owner reads "on you"', run: () => tipText({ kind: 'wait', lane: 'ops', cause: 'owner', title: 'T', start: at('14:40'), end: NOW, now: NOW }).split('\n')[0], want: 'ops · waiting on you 2h' },
  { name: 'tip wait gate', run: () => tipText({ kind: 'wait', lane: 'ops', cause: 'gate', title: 'T', start: at('15:40'), end: NOW, now: NOW }).split('\n')[0], want: 'ops · waiting on gate 1h' },
  { name: 'tip wait unknown', run: () => tipText({ kind: 'wait', lane: 'ops', cause: 'unknown', title: 'T', start: at('15:40'), end: NOW, now: NOW }).split('\n')[0], want: 'ops · waiting (cause not recorded) 1h' },
  { name: 'tip notRecorded', run: () => tipText({ kind: 'notRecorded', lane: 'web', start: at('00:00'), end: at('07:00'), why: 'No start stamp for this span; work may have happened.', now: NOW }), want: 'web · not recorded 7h\nNo start stamp for this span; work may have happened.' },
  { name: 'tip land', run: () => tipText({ kind: 'land', title: 'Auth retry', at: '2026-10-30T22:10:00-07:00', now: NOW }), want: 'Landed · Auth retry\nyesterday 22:10 · click for detail' },
  { name: 'tip deploy', run: () => tipText({ kind: 'deploy', title: 'Beta banner', at: at('09:25'), now: NOW }).split('\n')[0], want: 'Deployed · Beta banner' },
  { name: 'tip deployFail', run: () => tipText({ kind: 'deployFail', title: 'Pricing grid', at: at('12:10'), now: NOW }).split('\n')[0], want: 'Deploy failed · Pricing grid' },
  { name: 'tip decide', run: () => tipText({ kind: 'decide', title: 'Hold beta', at: at('04:00'), now: NOW }).split('\n')[0], want: 'Decided for you · Hold beta' },
  { name: 'tip current (working)', run: () => tipText({ kind: 'current', title: 'Search filters by workspace', since: at('09:30'), now: NOW }), want: 'Working on Search filters by workspace since 09:30 (7h 10m)' },
  { name: 'tip current (waiting)', run: () => tipText({ kind: 'current', title: 'Session token refresh', cause: 'review', since: at('11:40'), now: NOW }), want: 'Session token refresh waiting on review since 11:40' },
  { name: 'tip next', run: () => tipText({ kind: 'next', titles: ['Clerk retry', 'Docs nav'] }), want: 'Next: Clerk retry, then Docs nav' },
  { name: 'tip eta', run: () => tipText({ kind: 'eta', p50: '2026-11-02T12:00:00-07:00', asOf: NOW, now: NOW }), want: 'Expected landing of the current unit: Mon (estimate.py, as of 16:40)' },
  { name: 'tip prev', run: () => tipText({ kind: 'prev', p50: '2026-11-02T12:00:00-07:00', asOf: at('12:10'), now: NOW }), want: 'Earlier estimate: Mon (as of 12:10)' },
  { name: 'tip hold band', run: () => tipText({ kind: 'hold', label: 'Batch hold', start: at('10:00'), end: at('12:00'), source: 'holds', now: NOW }), want: 'Hold · Batch hold\ntoday 10:00 to 12:00 · holds' },
  { name: 'tip outage band, ongoing', run: () => tipText({ kind: 'outage', label: 'API outage', start: at('15:00'), end: null, now: NOW }), want: 'Outage · API outage\ntoday 15:00 to ongoing' },
  { name: 'tip region names the source', run: () => tipText({ kind: 'region', source: 'stamps.dispatched_at', why: 'stamps begin 2026-09-01' }), want: 'Not recorded · stamps.dispatched_at\nstamps begin 2026-09-01' },
  { name: 'tip seatReset at the gate', run: () => tipText({ kind: 'seatReset', label: 'seat2 18:10', at: at('18:10'), atGate: true, now: NOW }), want: 'Seat reset · seat2 18:10\ntoday 18:10 · at the quota gate' },
  { name: 'tip expiry', run: () => tipText({ kind: 'expiry', label: 'credits 11-10', at: '2026-11-10T00:00:00-07:00', now: NOW }).split('\n')[0], want: 'Expiry · credits 11-10' },
];

for (const row of ROWS) {
  test(row.name, () => assert.deepEqual(row.run(), row.want));
}
