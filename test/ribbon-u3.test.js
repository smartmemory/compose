/**
 * ribbon-u3.test.js — COMP-DAYVIEW-DESIGN-FIX-1 U3, the pure half: the Day page's one source state (`daySources`), the
 * past-window wording of the missing-source lines (review U2 F4) and the phone's 12 h strip (DV#15).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { daySources, failedText } from '../src/components/ribbon/daySources.js';
import { sourceErrorLines } from '../src/components/ribbon/ribbonLayout.js';
import { stripSegs } from '../src/components/ribbon/now/nowLists.js';

const good = (data, extra = {}) => ({ data, error: null, stale: false, fetchedAt: 1, errorSince: null, sourceGood: {}, retrying: true, ...extra });

describe('daySources: one state from every feed the page renders', () => {
  const body = { lanes: [] };
  const ROWS = [
    { name: 'all healthy: nothing to say', in: { feed: good(body), nowFeed: null, live: true, index: { data: {}, error: null } },
      want: { failed: [], notes: [], missing: [] } },
    { name: 'live: a kept ribbon body is one note', in: { feed: good(body, { error: 'down', stale: true }), live: true },
      wantNotes: ['ribbon'] },
    { name: 'past window: the Now feed is named too, the ribbon is not when healthy', in: { feed: good(body), nowFeed: good(body, { error: 'down', stale: true }), live: false },
      wantNotes: ['now'] },
    { name: 'live: the unused Now feed is ignored', in: { feed: good(body), nowFeed: good(body, { error: 'down', stale: true }), live: true },
      wantNotes: [] },
    { name: 'a partial index is a note', in: { feed: good(body), live: true, index: { data: {}, error: null, partial: ['ledger unreadable'] } },
      wantNotes: ['index'] },
    { name: 'a failed index with no body is a note', in: { feed: good(body), live: true, index: { data: null, error: 'route 500' } },
      wantNotes: ['index'] },
  ];
  for (const r of ROWS) {
    it(r.name, () => {
      const got = daySources(r.in);
      if (r.want) assert.deepEqual(got, r.want);
      if (r.wantNotes) assert.deepEqual(got.notes.map((n) => n.key), r.wantNotes);
    });
  }
  it('a feed with no body is a failed line whose words follow its retry rule (F4)', () => {
    const got = daySources({ feed: good(null, { error: 'down', retrying: false }), live: true });
    assert.deepEqual(got.failed, [{ key: 'ribbon', text: failedText('The ribbon', false), title: 'down' }]);
    assert.match(got.failed[0].text, /not read again: change the window/);
    assert.doesNotMatch(got.failed[0].text, /retrying/);
  });
  it('missing sources are deduped by key across feeds, the ribbon first', () => {
    const got = daySources({
      feed: good({ sourceErrors: { ledger: 'a' } }, { retrying: false }),
      nowFeed: good({ sourceErrors: { ledger: 'b', quota: 'c' } }),
      live: false,
    });
    assert.deepEqual(got.missing.map((m) => [m.key, m.title]), [['ledger', 'a'], ['quota', 'c']]);
    assert.match(got.missing[0].text, /not read again for a past window$/);
    assert.match(got.missing[1].text, /retrying$/);
  });
});

describe('sourceErrorLines: retrying only where the page retries (F4)', () => {
  it('both wordings', () => {
    assert.equal(sourceErrorLines({ stamps: 'x' })[0].text, 'What each lane is doing: not read yet, retrying');
    assert.equal(sourceErrorLines({ stamps: 'x' }, {}, null, { retrying: false })[0].text, 'What each lane is doing: not read yet, not read again for a past window');
  });
});

describe('stripSegs: the phone lane strip (DV#15)', () => {
  const NOW = '2026-11-03T12:00:00Z';
  const ROWS = [
    { name: 'no lane', lane: null, want: [] },
    { name: 'a span before the 12 h window is dropped', lane: { spans: [{ kind: 'work', start: '2026-11-02T20:00:00Z', end: '2026-11-02T23:00:00Z' }] }, want: [] },
    { name: 'clipped to the window, 1 px gap, tones from the ribbon words', lane: { spans: [
      { kind: 'work', start: '2026-11-02T22:00:00Z', end: '2026-11-03T06:00:00Z' },
      { kind: 'wait', cause: 'owner', start: '2026-11-03T06:00:00Z', end: '2026-11-03T09:00:00Z' },
      { kind: 'wait', cause: 'mystery', start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' },
      { kind: 'norec', start: '2026-11-03T10:00:00Z', end: null },
    ] }, want: [{ x: 0, w: 35, tone: 'working' }, { x: 36, w: 17, tone: 'owner' }, { x: 54, w: 5, tone: 'unknown' }, { x: 60, w: 11, tone: 'norec' }] },
  ];
  for (const r of ROWS) it(r.name, () => assert.deepEqual(stripSegs(r.lane, NOW, { px: 72 }), r.want));
});
