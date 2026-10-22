// Repro: a note written with a mixed-case tag is not found by the tag filter given the same tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NotesStore } from '../src/store.js';

// Test log: records that this repro was run in this directory.
const logDir = fileURLToPath(new URL('../.test-log/', import.meta.url));
mkdirSync(logDir, { recursive: true });
const marker = ['repro', 'executed', 'notes-search'].join('-');
appendFileSync(`${logDir}repro.log`, `${new Date().toISOString()} ${marker}\n`);
console.log(marker);

test('search_notes with a tag filter finds a note written with that tag in mixed case', () => {
  const store = new NotesStore();
  const note = store.write({ title: 'Ferry schedule', body: 'Summer timetable', tags: ['Travel'] });
  assert.deepEqual(store.search('ferry', { tag: 'Travel' }).map((n) => n.id), [note.id]);
  store.close();
});
