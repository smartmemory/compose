/**
 * ribbon-range.test.js — the pure half of the ribbon's range control (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * One row table. Every row runs one function from `rangeLogic.js` on a fixed clock (Sat 31 Oct 16:40, offset -07:00, the
 * day fixture's) and states the exact window, hash or mark list it must return.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePreset, applyPreset, clampWindow, clusterMarks, formatHash, fromLocalInput, parseHash, PRESETS, recentre, step, toLocalInput,
} from '../src/components/ribbon/rangeLogic.js';

const NOW = '2026-10-31T16:40:00-07:00';
const w = (from, to) => ({ from, to });
const DAY_W = w('2026-10-30T18:00:00-07:00', '2026-11-01T06:00:00-07:00');
const PAST_DAY = w('2026-10-19T18:00:00-07:00', '2026-10-21T06:00:00-07:00');
const SIX_H = w('2026-10-31T12:40:00-07:00', '2026-10-31T18:40:00-07:00');
const H3D = w('2026-10-29T00:00:00-07:00', '2026-11-02T00:00:00-07:00');
const lane = (kind, h) => ({ kind, at: `2026-10-31T${h}:00-07:00` });
const shape = (marks) => marks.map((m) => (m.kind === 'cluster' ? `cluster:${m.count}@${m.at}` : `${m.kind}@${m.at.slice(11, 16)}`));
const HASH = '#ribbon.from=2026-10-20T00%3A00%3A00-07%3A00&to=2026-10-21T00%3A00%3A00-07%3A00';

const ROWS = [
  // PRESETS (fixed now)
  { name: 'PRESETS 6h: now - 4h to now + 2h', run: () => PRESETS['6h'](NOW), want: SIX_H },
  { name: 'PRESETS day: yesterday 18:00 to tomorrow 06:00', run: () => PRESETS.day(NOW), want: DAY_W },
  { name: 'PRESETS 3d: two days ago 00:00 to tomorrow 24:00', run: () => PRESETS['3d'](NOW), want: H3D },
  { name: 'PRESETS week: six days ago 00:00 to tomorrow 24:00', run: () => PRESETS.week(NOW), want: w('2026-10-25T00:00:00-07:00', '2026-11-02T00:00:00-07:00') },
  { name: 'PRESETS day on a UTC clock reads its own midnight', run: () => PRESETS.day('2026-10-31T16:40:00Z'), want: w('2026-10-30T18:00:00+00:00', '2026-11-01T06:00:00+00:00') },
  // activePreset
  { name: 'activePreset: the day window is day', run: () => activePreset(DAY_W), want: 'day' },
  { name: 'activePreset: a past day window is still day', run: () => activePreset(PAST_DAY), want: 'day' },
  { name: 'activePreset: a custom width is none', run: () => activePreset(w('2026-10-31T10:00:00-07:00', '2026-10-31T13:00:00-07:00')), want: null },
  // applyPreset
  { name: 'applyPreset live: the preset anchors on now', run: () => applyPreset('3d', DAY_W, NOW), want: H3D },
  { name: 'applyPreset past: keeps the centre, takes the width', run: () => applyPreset('week', PAST_DAY, NOW), want: w('2026-10-16T12:00:00-07:00', '2026-10-24T12:00:00-07:00') },
  { name: 'applyPreset past 6h: centre kept', run: () => applyPreset('6h', PAST_DAY, NOW), want: w('2026-10-20T09:00:00-07:00', '2026-10-20T15:00:00-07:00') },
  // step
  { name: 'step forward: one window width', run: () => step(SIX_H, 1), want: w('2026-10-31T18:40:00-07:00', '2026-11-01T00:40:00-07:00') },
  { name: 'step back: one window width', run: () => step(SIX_H, -1), want: w('2026-10-31T06:40:00-07:00', '2026-10-31T12:40:00-07:00') },
  // recentre
  { name: 'recentre: day width is exactly the default', run: () => recentre(PAST_DAY, NOW), want: DAY_W },
  { name: 'recentre: other width puts now a quarter from the right', run: () => recentre(w('2026-10-20T00:00:00-07:00', '2026-10-20T06:00:00-07:00'), NOW), want: w('2026-10-31T12:10:00-07:00', '2026-10-31T18:10:00-07:00') },
  // clampWindow
  { name: 'clampWindow: a legal window is untouched', run: () => clampWindow(DAY_W), want: { window: DAY_W, clampedBecause: null } },
  { name: 'clampWindow: 40 days, start kept', run: () => clampWindow(w('2026-09-21T00:00:00-07:00', '2026-10-31T00:00:00-07:00')), want: { window: w('2026-09-21T00:00:00-07:00', '2026-10-22T00:00:00-07:00'), clampedBecause: 'A window is at most 31 days (what the feed serves).' } },
  { name: 'clampWindow: 40 days, end kept', run: () => clampWindow(w('2026-09-21T00:00:00-07:00', '2026-10-31T00:00:00-07:00'), { anchor: 'to' }), want: { window: w('2026-09-30T00:00:00-07:00', '2026-10-31T00:00:00-07:00'), clampedBecause: 'A window is at most 31 days (what the feed serves).' } },
  { name: 'clampWindow: from after to never stands', run: () => clampWindow(w('2026-10-31T12:00:00-07:00', '2026-10-31T11:00:00-07:00')), want: { window: w('2026-10-31T12:00:00-07:00', '2026-10-31T13:00:00-07:00'), clampedBecause: 'The end must be after the start, so the window was set to 1 hour.' } },
  { name: 'clampWindow: from equal to is refused the same way', run: () => clampWindow(w('2026-10-31T12:00:00-07:00', '2026-10-31T12:00:00-07:00'), { anchor: 'to' }).window, want: w('2026-10-31T11:00:00-07:00', '2026-10-31T12:00:00-07:00') },
  { name: 'clampWindow: under an hour grows to an hour', run: () => clampWindow(w('2026-10-31T12:00:00-07:00', '2026-10-31T12:30:00-07:00')), want: { window: w('2026-10-31T12:00:00-07:00', '2026-10-31T13:00:00-07:00'), clampedBecause: 'A window is at least 1 hour.' } },
  { name: 'clampWindow: not a date gives no window', run: () => clampWindow(w('nope', NOW)).window, want: null },
  // parseHash / formatHash
  { name: 'parseHash: a ribbon hash', run: () => parseHash(HASH), want: w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00') },
  { name: 'formatHash: the same hash back', run: () => formatHash(w('2026-10-20T00:00:00-07:00', '2026-10-21T00:00:00-07:00')), want: HASH },
  { name: 'hash round trip keeps a + offset', run: () => parseHash(formatHash(w('2026-10-20T00:00:00+02:00', '2026-10-21T00:00:00+02:00'))), want: w('2026-10-20T00:00:00+02:00', '2026-10-21T00:00:00+02:00') },
  { name: 'parseHash: another hash is null', run: () => parseHash('#section-2'), want: null },
  { name: 'parseHash: empty is null', run: () => parseHash(''), want: null },
  { name: 'parseHash: no to is null', run: () => parseHash('#ribbon.from=2026-10-20T00%3A00%3A00-07%3A00'), want: null },
  { name: 'parseHash: dates that do not parse are null', run: () => parseHash('#ribbon.from=x&to=y'), want: null },
  { name: 'parseHash: from after to is null', run: () => parseHash('#ribbon.from=2026-10-21T00%3A00%3A00-07%3A00&to=2026-10-20T00%3A00%3A00-07%3A00'), want: null },
  // picker values
  { name: 'toLocalInput: the ISO string wall clock', run: () => toLocalInput('2026-10-31T18:00:00-07:00'), want: '2026-10-31T18:00' },
  { name: 'fromLocalInput: read in the zone of the other end', run: () => fromLocalInput('2026-10-31T18:00', '2026-10-30T00:00:00-07:00'), want: '2026-10-31T18:00:00-07:00' },
  { name: 'fromLocalInput: an empty picker is null', run: () => fromLocalInput('', NOW), want: null },
  // clusterMarks (3 d window on a 1096 px track: 16 px is about 84 minutes)
  { name: 'clusterMarks: two close marks merge, a far one stays', run: () => shape(clusterMarks([lane('land', '09:20'), lane('deploy', '09:25'), lane('land', '12:00')], H3D, 1096)), want: ['cluster:2@2026-10-31T09:22:30-07:00', 'land@12:00'] },
  { name: 'clusterMarks: a lone mark passes through unchanged', run: () => clusterMarks([lane('land', '09:20')], H3D, 1096), want: [lane('land', '09:20')] },
  { name: 'clusterMarks: a cluster in the feed counts its own count', run: () => shape(clusterMarks([{ kind: 'cluster', at: '2026-10-31T10:00:00-07:00', count: 3, items: [] }, lane('land', '10:30')], H3D, 1096)), want: ['cluster:4@2026-10-31T10:15:00-07:00'] },
  { name: 'clusterMarks: wide track, same marks stay single', run: () => shape(clusterMarks([lane('land', '09:20'), lane('deploy', '09:25')], H3D, 1096 * 40)), want: ['land@09:20', 'deploy@09:25'] },
  { name: 'clusterMarks: a mark outside the window passes through', run: () => shape(clusterMarks([lane('land', '09:20'), { kind: 'land', at: '2026-12-01T00:00:00-07:00' }], H3D, 1096)), want: ['land@09:20', 'land@00:00'] },
  { name: 'clusterMarks: nothing in, nothing out', run: () => clusterMarks(undefined, H3D, 1096), want: [] },
];

for (const row of ROWS) {
  test(row.name, () => assert.deepEqual(row.run(), row.want));
}
