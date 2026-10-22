// Hidden checks for the debug archetype: the tag filter must work for every way a note gets its tags.
// Each test name starts with its check id in brackets (lib/archetypes/debug.js scores per check id).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore } from '../src/store.js';

function fresh() {
  const s = new NotesStore();
  let t = 0;
  s.clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
  return s;
}

// Rows as an older export left them: mixed-case tags.
const LEGACY = [
  { title: 'Ferry schedule', body: 'Summer timetable', tags: ['Travel', 'Boats'], createdAt: '2025-06-01T09:00:00.000Z' },
  { title: 'Packing list', body: 'Passport and ferry tickets', tags: ['TRAVEL'], createdAt: '2025-06-02T09:00:00.000Z' },
  { title: 'Standup', body: 'Ferry booking fix', tags: ['Work'], createdAt: '2025-06-03T09:00:00.000Z' },
];

test('[tag-filter-written] notes written with mixed-case tags are found by the tag in any case', () => {
  const s = fresh();
  const a = s.write({ title: 'Ferry A', body: 'x', tags: ['Travel'] });
  const b = s.write({ title: 'Ferry B', body: 'x', tags: ['travel', ' TRAVEL '] });
  for (const q of ['travel', 'Travel', 'TRAVEL', ' travel ']) {
    assert.deepEqual(s.search('ferry', { tag: q }).map((n) => n.id), [b.id, a.id], `tag query ${JSON.stringify(q)}`);
  }
});

test('[tag-filter-update] a note retagged through update is found by the tag in any case', () => {
  const s = fresh();
  const n = s.write({ title: 'Ferry notes', body: 'x', tags: ['old'] });
  const other = s.write({ title: 'Ferry other', body: 'x', tags: ['old'] });
  assert.notEqual(s.update(n.id, { tags: ['Travel'] }), null);
  for (const q of ['travel', 'Travel', 'TRAVEL']) {
    assert.deepEqual(s.search('ferry', { tag: q }).map((x) => x.id), [n.id], `tag query ${JSON.stringify(q)}`);
  }
  assert.deepEqual(s.search('ferry', { tag: 'old' }).map((x) => x.id), [other.id]);
});

test('[tag-filter-seeded] rows loaded through importNotes with mixed-case tags are found by the tag in any case', () => {
  const s = fresh();
  const [ferry, packing, standup] = s.importNotes(LEGACY);
  for (const q of ['travel', 'Travel', 'TRAVEL']) {
    assert.deepEqual(s.search('timetable', { tag: q }).map((x) => x.id), [ferry], `tag query ${JSON.stringify(q)}`);
    assert.deepEqual(s.search('passport', { tag: q }).map((x) => x.id), [packing], `tag query ${JSON.stringify(q)}`);
  }
  assert.deepEqual(s.search('booking', { tag: 'work' }).map((x) => x.id), [standup]);
});

test('[tag-normalized] update stores each tag once, trimmed and lower-case', () => {
  const s = fresh();
  const n = s.write({ title: 'Ferry notes', body: 'x' });
  assert.deepEqual(s.update(n.id, { tags: ['Travel', 'travel', ' TRAVEL ', 'Boats'] }).tags, ['boats', 'travel']);
  assert.deepEqual(s.recall(n.id).tags, ['boats', 'travel']);
});

test('[tag-normalized] importNotes stores each tag once, trimmed and lower-case', () => {
  const s = fresh();
  const ids = s.importNotes([...LEGACY, { title: 'Dupes', body: 'x', tags: ['Fun', 'fun', 'FUN'] }]);
  assert.deepEqual(s.recall(ids[0]).tags, ['boats', 'travel']);
  assert.deepEqual(s.recall(ids[1]).tags, ['travel']);
  assert.deepEqual(s.recall(ids[3]).tags, ['fun']);
});
