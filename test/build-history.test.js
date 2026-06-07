/**
 * build-history.test.js — COMP-COCKPIT-3 run history writer/reader.
 *
 * Golden flow: append build records to build-history.jsonl, read them back
 * most-recent-first, bounded. Plus resilience: missing file, malformed lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBuildHistory, readBuildHistory } from '../lib/build-history.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'build-history-'));
}

test('appendBuildHistory creates the file and round-trips a record', () => {
  const dir = freshDir();
  try {
    const rec = {
      featureCode: 'FEAT-1', mode: 'feature', status: 'complete',
      startedAt: '2026-06-08T00:00:00.000Z', completedAt: '2026-06-08T00:01:00.000Z',
      durationMs: 60000, cost_usd: 0.12, input_tokens: 100, output_tokens: 50,
      stepCount: 4, failureReason: null, itemId: 'abc',
    };
    appendBuildHistory(dir, rec);
    assert.ok(existsSync(join(dir, 'build-history.jsonl')));
    const out = readBuildHistory(dir);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], rec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildHistory returns most-recent-first and honors limit', () => {
  const dir = freshDir();
  try {
    for (let i = 0; i < 5; i++) {
      appendBuildHistory(dir, { featureCode: `F${i}`, status: 'complete' });
    }
    const all = readBuildHistory(dir);
    assert.equal(all.length, 5);
    assert.equal(all[0].featureCode, 'F4', 'newest first');
    assert.equal(all[4].featureCode, 'F0', 'oldest last');

    const limited = readBuildHistory(dir, { limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0].featureCode, 'F4');
    assert.equal(limited[1].featureCode, 'F3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildHistory returns [] when file is missing', () => {
  const dir = freshDir();
  try {
    assert.deepEqual(readBuildHistory(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildHistory skips malformed lines', () => {
  const dir = freshDir();
  try {
    const path = join(dir, 'build-history.jsonl');
    writeFileSync(path,
      JSON.stringify({ featureCode: 'OK1', status: 'complete' }) + '\n' +
      'not-json-garbage\n' +
      JSON.stringify({ featureCode: 'OK2', status: 'failed' }) + '\n');
    const out = readBuildHistory(dir);
    assert.equal(out.length, 2);
    assert.equal(out[0].featureCode, 'OK2');
    assert.equal(out[1].featureCode, 'OK1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendBuildHistory never throws on a bad dir (build path safety)', () => {
  // A non-existent nested path should be created; an impossible path should not throw.
  assert.doesNotThrow(() => appendBuildHistory('/dev/null/cannot/exist', { featureCode: 'X' }));
});
