import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { CliProgress } from '../lib/cli-progress.js';

function fixture(t, { isTTY = true, expanded = false } = {}) {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  stream.isTTY = isTTY;
  stream.columns = 120;
  const progress = new CliProgress({ stream, expanded });
  t.after(() => progress.finish());
  return { progress, output: () => output };
}

function manifest(output) {
  const lines = stripVTControlCharacters(output).split('\n').map(line => line.trim());
  const start = lines.findLastIndex(line => line.startsWith('File manifest ('));
  return start === -1 ? [] : lines.slice(start, lines.indexOf('', start));
}

test('an execute step shows the changed file count and paths in sorted order', (t) => {
  const { progress, output } = fixture(t);
  progress.stepStart(1, 2, 'execute');
  progress.recordFilesChanged(['b.js', 'a.js']);
  progress.stepDone('execute');

  assert.deepEqual(manifest(output()), ['File manifest (2 files)', 'a.js', 'b.js']);
});

test('a later step adds new files without duplicating files already reported', (t) => {
  const { progress, output } = fixture(t, { expanded: true });
  progress.stepStart(1, 2, 'execute');
  progress.recordFilesChanged(['a.js', 'b.js']);
  progress.stepDone('execute');
  const nextUpdate = output().length;
  progress.stepStart(2, 2, 'docs');
  progress.recordFilesChanged(['c.js', 'b.js']);
  progress.stepDone('docs');

  assert.deepEqual(manifest(output().slice(nextUpdate)), ['File manifest (3 files)', 'a.js', 'b.js', 'c.js']);
  const afterUpdate = output();
  progress.recordFilesChanged(['b.js', 'a.js']);
  assert.equal(output(), afterUpdate);
});

test('the manifest shows only the first ten sorted paths and counts the rest', (t) => {
  const { progress, output } = fixture(t);
  const paths = Array.from({ length: 12 }, (_, index) => `file-${String(index + 1).padStart(2, '0')}.js`);
  progress.stepStart('∥0', '?', 'execute');
  progress.recordFilesChanged([...paths].reverse());

  assert.deepEqual(manifest(output()), ['File manifest (12 files)', ...paths.slice(0, 10), '… and 2 more']);
});

test('piped progress uses plain text and the final summary includes the distinct count', (t) => {
  const { progress, output } = fixture(t, { isTTY: false });
  progress.stepStart(1, 2, 'execute');
  progress.recordFilesChanged(['b.js', 'a.js']);
  progress.stepDone('execute');
  progress.stepStart(2, 2, 'ship');
  progress.recordFilesChanged(['c.js', 'b.js']);
  progress.stepDone('ship');
  progress.finish();

  assert.doesNotMatch(output(), /\x1b/);
  assert.deepEqual(manifest(output()), ['File manifest (3 files)', 'a.js', 'b.js', 'c.js']);
  const summary = output().slice(output().indexOf('Build summary'));
  assert.match(summary, /result: OK\s+3 files/);
});
