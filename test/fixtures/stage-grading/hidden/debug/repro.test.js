// Repro: a note whose body contains the query is not returned by search_notes.
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

test('search_notes finds a note by a word in its body', () => {
  const store = new NotesStore();
  const note = store.write({ title: 'Standup', body: 'Ship the ferry booking fix on Friday' });
  assert.deepEqual(store.search('ferry').map((n) => n.id), [note.id]);
  store.close();
});
