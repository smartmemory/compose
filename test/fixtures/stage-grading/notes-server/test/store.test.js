// Golden suite: NotesStore behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesStore } from '../src/store.js';

function fresh() {
  const store = new NotesStore();
  let t = 0;
  store.clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
  return store;
}

test('write then recall returns the stored note', () => {
  const s = fresh();
  const n = s.write({ title: ' Groceries ', body: 'milk, eggs', tags: ['Home', 'home', 'list'] });
  assert.equal(n.title, 'Groceries');
  assert.deepEqual(s.recall(n.id), { id: n.id, title: 'Groceries', body: 'milk, eggs', tags: ['home', 'list'], createdAt: n.createdAt });
});

test('write rejects a missing title, a non-string body and bad tags', () => {
  const s = fresh();
  for (const bad of [{ body: 'x' }, { title: '  ', body: 'x' }, { title: 't', body: 3 }, { title: 't', body: '', tags: 'a' }, { title: 't', body: '', tags: [''] }]) {
    assert.throws(() => s.write(bad), { code: 'INVALID' });
  }
});

test('recall of an unknown id is null; a non-integer id is refused', () => {
  const s = fresh();
  assert.equal(s.recall(42), null);
  assert.throws(() => s.recall('1'), { code: 'INVALID' });
});

test('search matches the title', () => {
  const s = fresh();
  const n = s.write({ title: 'Kafka partitions', body: 'notes from the talk' });
  s.write({ title: 'Unrelated', body: 'nothing here' });
  assert.deepEqual(s.search('kafka').map((x) => x.id), [n.id]);
});

test('search matches the body', () => {
  const s = fresh();
  const n = s.write({ title: 'Meeting', body: 'Discussed the SQLite migration plan' });
  assert.deepEqual(s.search('sqlite').map((x) => x.id), [n.id]);
});

test('search is case-insensitive and returns a note matching title and body once', () => {
  const s = fresh();
  const n = s.write({ title: 'Rust', body: 'rust borrow checker' });
  assert.deepEqual(s.search('RUST').map((x) => x.id), [n.id]);
});

test('search treats % and _ literally', () => {
  const s = fresh();
  const pct = s.write({ title: 'Sale', body: '50% off' });
  s.write({ title: 'Other', body: '500 items' });
  const under = s.write({ title: 'snake_case', body: '' });
  s.write({ title: 'snakeXcase', body: '' });
  assert.deepEqual(s.search('50%').map((x) => x.id), [pct.id]);
  assert.deepEqual(s.search('snake_').map((x) => x.id), [under.id]);
});

test('search returns newest first and honours limit', () => {
  const s = fresh();
  const ids = [1, 2, 3].map((i) => s.write({ title: `log ${i}`, body: '' }).id);
  assert.deepEqual(s.search('log').map((x) => x.id), ids.reverse());
  assert.equal(s.search('log', { limit: 2 }).length, 2);
  assert.throws(() => s.search('log', { limit: 0 }), { code: 'INVALID' });
  assert.throws(() => s.search('  '), { code: 'INVALID' });
});

test('search filters by tag', () => {
  const s = fresh();
  const work = s.write({ title: 'Standup', body: 'daily', tags: ['work'] });
  s.write({ title: 'Standup comedy', body: 'tickets', tags: ['fun'] });
  assert.deepEqual(s.search('standup', { tag: 'WORK' }).map((x) => x.id), [work.id]);
});

test('remove deletes the note and its tags', () => {
  const s = fresh();
  const n = s.write({ title: 'tmp', body: '', tags: ['x'] });
  assert.equal(s.remove(n.id), true);
  assert.equal(s.recall(n.id), null);
  assert.equal(s.remove(n.id), false);
  assert.deepEqual(s.search('tmp', { tag: 'x' }), []);
});

test('notes persist across reopening a file database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-golden-'));
  try {
    const path = join(dir, 'notes.db');
    const a = new NotesStore(path);
    const n = a.write({ title: 'durable', body: 'kept' });
    a.close();
    const b = new NotesStore(path);
    assert.equal(b.recall(n.id).body, 'kept');
    assert.equal(b.search('kept').length, 1);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
