// Hidden regression suite for the debug archetype: a fix must keep title search and the result contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore } from '../src/store.js';

function seeded() {
  const s = new NotesStore();
  let t = 0;
  s.clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
  const titleOnly = s.write({ title: 'Ferry schedule', body: 'see attachment', tags: ['travel'] });
  const bodyOnly = s.write({ title: 'Standup', body: 'ferry booking fix', tags: ['work'] });
  const both = s.write({ title: 'Ferry notes', body: 'ferry ferry', tags: ['travel'] });
  s.write({ title: 'Unrelated', body: 'nothing' });
  return { s, titleOnly, bodyOnly, both };
}

test('title-only, body-only and both-match notes are all found, each once, newest first', () => {
  const { s, titleOnly, bodyOnly, both } = seeded();
  assert.deepEqual(s.search('FERRY').map((n) => n.id), [both.id, bodyOnly.id, titleOnly.id]);
});

test('tag filter and limit still apply to body matches', () => {
  const { s, bodyOnly, both } = seeded();
  assert.deepEqual(s.search('ferry', { tag: 'work' }).map((n) => n.id), [bodyOnly.id]);
  assert.deepEqual(s.search('ferry', { limit: 2 }).map((n) => n.id), [both.id, bodyOnly.id]);
});

test('body matching is literal for % and _', () => {
  const { s } = seeded();
  const pct = s.write({ title: 'Promo', body: 'save 30% today' });
  s.write({ title: 'Promo two', body: 'save 300 today' });
  assert.deepEqual(s.search('30%').map((n) => n.id), [pct.id]);
});
