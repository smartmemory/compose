/**
 * ribbon-mark-cards.test.js — the card text behind every Day ribbon mark (COMP-COCKPIT-RIBBON-MARKS-1).
 *
 * One row table over `cardFor`, built on the RIBBON-ROWS-1 day fixture (now Sat 31 Oct 16:40, offset -07:00).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardFor, laneOf } from '../src/components/ribbon/marks/markCards.js';

const day = JSON.parse(readFileSync(new URL('./fixtures/ribbon/day.json', import.meta.url), 'utf8'));
const NOW = '2026-10-31T16:40:00-07:00';
const at = (h) => `2026-10-31T${h}:00-07:00`;
const mark = (laneName, kind, unit) => day.lanes.find((l) => l.lane === laneName).marks.find((m) => m.kind === kind && (unit ? m.unit === unit : true));
const ctx = { now: NOW, lanes: day.lanes, seats: [] };
const lines = (c) => [`${c.icon} ${c.title}`.trim(), c.name, c.sub, c.body, c.id, c.links.map((l) => l.label).join('|')].filter(Boolean).join(' / ');

const ROWS = [
  { name: 'land: title, lane, time, unit page', item: mark('2.0', 'land', 'S-3'), want: '✓ Landed / Beta banner / 2.0 lane · today 09:20 / S-3 / unit page ▸' },
  { name: 'land without a unit: no id, no link', item: { ...mark('2.0', 'land', 'S-3'), unit: null }, want: '✓ Landed / Beta banner / today 09:20' },
  { name: 'deploy: live on the target', item: mark('2.0', 'deploy'), want: '▲ Deployed / Beta banner live on smartmemory.ai / 2.0 lane · today 09:25 / S-3 / unit page ▸' },
  { name: 'deployFail: red and says so', item: mark('web', 'deployFail'), want: '▲ Deploy failed / Pricing grid did not go live on smartmemory.ai / web lane · today 12:10 / W-1 / unit page ▸', tone: 'bad' },
  { name: 'decide: text, how to reverse, both links', item: mark('ops', 'decide'), want: '⚖︎ Decided for you / Skip the load hold for authors / ops lane · today 12:20 / Allowed authors to skip the load hold. Reverse: Remove the bypass flag. / O-2 / unit page ▸|reverse ▸' },
  { name: 'decide with no reversal recorded: says so, no reverse link', item: { ...mark('ops', 'decide'), reverse: null }, want: '⚖︎ Decided for you / Skip the load hold for authors / ops lane · today 12:20 / Allowed authors to skip the load hold. Reverse: not recorded. / O-2 / unit page ▸' },
  { name: 'seatReset: window, reading and queued work', item: day.pins[0], c: { ...ctx, seats: [{ label: 'seat2', pct: 96 }], lanes: [{ lane: 'ops', seat: 'seat2', idle: false }] }, want: '↻ seat2 resets 18:10 / 5h window resets in 1h 30m. It is at 96% now with ops work queued.', tone: 'warn' },
  { name: 'seatReset already past: says it reset, not "resets in 0m"', item: { ...day.pins[0], at: at('15:00') }, want: '↻ seat2 reset 15:00 / 5h window reset today 15:00.', tone: 'warn' },
  { name: 'decide with no title (owner-queue row): name is the cut text, body does not repeat a short one', item: { kind: 'decide', at: at('12:20'), unit: null, title: null, text: 'Skipped round 2', reverse: 'Request round 2', source: 'owner-queue' }, want: '⚖︎ Decided for you / Skipped round 2 / today 12:20 / Reverse: Request round 2. / reverse ▸' },
  { name: 'decide with a long untitled text and a reversal that already says Reverse: cut name, cut body, no doubled word', item: { kind: 'decide', at: at('12:20'), unit: 'X-1', title: null, text: 'W'.repeat(120), reverse: 'Reverse: the rows become blockers', source: 'owner-queue' }, want: `⚖︎ Decided for you / ${'W'.repeat(89)}… / today 12:20 / ${'W'.repeat(120)}. Reverse: the rows become blockers. / X-1 / unit page ▸|reverse ▸` },
  { name: 'deploy with no title: the unit is the name and a target equal to it is not repeated', item: { kind: 'deploy', at: at('09:25'), unit: 'mac-cockpit', title: null, text: 'mac-cockpit', source: 'stamps' }, want: '▲ Deployed / mac-cockpit live / today 09:25 / mac-cockpit / unit page ▸' },
  { name: 'seatReset with no seat reading: only the window', item: day.pins[1], want: '↻ seat1 resets 19:30 / 5h window resets in 2h 50m.' },
  { name: 'expiry: label and date', item: { kind: 'expiry', at: '2026-11-10T00:00:00-07:00', label: 'API credits expire 11-10' }, want: '◇ API credits expire 11-10 / Tue 10 Nov 00:00' },
  { name: 'hold ongoing', item: { kind: 'hold', start: at('14:00'), end: null, label: 'Load hold', source: 'launch holds' }, want: 'Hold: Load hold, 2h 40m so far / today 14:00 to ongoing. Source: launch holds.' },
  { name: 'outage with an end', item: { kind: 'outage', start: at('12:00'), end: at('13:30'), label: 'API 503s', source: 'outage notices' }, want: 'Outage since 12:00 / API 503s / Lasted 1h 30m. Source: outage notices.', tone: 'bad' },
  { name: 'eta slipped: p50, p80, as of, earlier estimate, initiative link', item: { kind: 'eta', lane: '2.0', p50: '2026-11-02T12:00:00-07:00', p80: '2026-11-02T18:00:00-07:00', asOf: NOW, prev: { p50: '2026-11-01T20:00:00-07:00', asOf: at('10:00') } }, want: '◆ Expected landing / 2.0 lane / p50 Mon, p80 Mon. As of 16:40. Earlier estimate: 20:00 Sun (as of 10:00). / How far is 2.0 from flipping? ▸' },
  { name: 'eta not slipped, other lane: no earlier row, no link', item: { kind: 'eta', lane: 'web', p50: at('21:30'), p80: '2026-11-01T01:00:00-07:00', asOf: NOW, prev: null }, want: '◆ Expected landing / web lane / p50 21:30, p80 01:00 Sun. As of 16:40.' },
  { name: 'eta without p80: the row is dropped', item: { kind: 'eta', lane: 'web', p50: at('21:30'), asOf: NOW, prev: null }, want: '◆ Expected landing / web lane / p50 21:30. As of 16:40.' },
  { name: 'cluster: count and near time', item: { kind: 'cluster', at: at('08:42'), count: 2, items: [mark('web', 'land'), mark('web', 'deploy')] }, want: '2 events / near today 08:42' },
];

for (const r of ROWS) {
  test(`cardFor ${r.name}`, () => {
    const c = cardFor(r.item, r.c || ctx);
    assert.equal(lines(c), r.want);
    if (r.tone) assert.equal(c.tone, r.tone);
  });
}

test('cardFor cluster lists its items newest first, each opening its own card', () => {
  const items = [mark('web', 'land'), mark('web', 'deploy')];
  const c = cardFor({ kind: 'cluster', at: at('08:42'), count: 2, items }, ctx);
  assert.deepEqual(c.list.map((i) => `${i.glyph} ${i.text} ${i.at}`), ['▲ Pricing grid 08:45', '✓ Pricing grid 08:40']);
  assert.equal(cardFor(c.list[0].action.item, ctx).title, 'Deployed');
});

test('laneOf finds the lane of a cluster member and returns null for a stranger', () => {
  assert.equal(laneOf(mark('wiki', 'land'), day.lanes), 'wiki');
  assert.equal(laneOf({ kind: 'land', at: at('01:01'), unit: 'X' }, day.lanes), null);
});

test('cardFor an unknown kind is a plain titled card, not a throw', () => {
  assert.equal(cardFor({ kind: 'zzz', title: 'T' }, ctx).title, 'T');
});
