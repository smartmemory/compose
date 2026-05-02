/**
 * idempotency.test.js — coverage for lib/idempotency.js (COMP-MCP-ROADMAP-WRITER T1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkOrInsert, _resetIdempotency } from '../lib/idempotency.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'idempotency-'));
}

describe('idempotency.checkOrInsert', () => {
  test('first call invokes computeFn and caches result', async () => {
    const cwd = freshCwd();
    let invocations = 0;
    const { result, cached } = await checkOrInsert(cwd, 'key-1', () => {
      invocations += 1;
      return { value: 42 };
    });
    assert.equal(invocations, 1);
    assert.equal(cached, false);
    assert.deepEqual(result, { value: 42 });

    const cachePath = join(cwd, '.compose', 'data', 'idempotency-keys.jsonl');
    assert.ok(existsSync(cachePath), 'cache file should exist after first call');
    const lines = readFileSync(cachePath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.key, 'key-1');
    assert.deepEqual(row.result, { value: 42 });
    assert.ok(typeof row.ts === 'string');
  });

  test('second call with the same key skips computeFn and returns cached', async () => {
    const cwd = freshCwd();
    let invocations = 0;
    const compute = () => { invocations += 1; return { tick: invocations }; };

    const first = await checkOrInsert(cwd, 'replay', compute);
    const second = await checkOrInsert(cwd, 'replay', compute);

    assert.equal(invocations, 1, 'computeFn should run only once');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.result, first.result);
  });

  test('different keys both invoke computeFn', async () => {
    const cwd = freshCwd();
    const r1 = await checkOrInsert(cwd, 'a', () => 1);
    const r2 = await checkOrInsert(cwd, 'b', () => 2);
    assert.equal(r1.result, 1);
    assert.equal(r2.result, 2);
    assert.equal(r1.cached, false);
    assert.equal(r2.cached, false);
  });

  test('rejects empty or non-string keys', async () => {
    const cwd = freshCwd();
    await assert.rejects(() => checkOrInsert(cwd, '', () => 1), /non-empty string/);
    await assert.rejects(() => checkOrInsert(cwd, null, () => 1), /non-empty string/);
    await assert.rejects(() => checkOrInsert(cwd, 123, () => 1), /non-empty string/);
  });

  test('async computeFn is awaited', async () => {
    const cwd = freshCwd();
    const { result } = await checkOrInsert(cwd, 'async', async () => {
      await new Promise(r => setTimeout(r, 5));
      return 'done';
    });
    assert.equal(result, 'done');
  });

  test('concurrent calls with same key produce one mutation', async () => {
    const cwd = freshCwd();
    let invocations = 0;
    const compute = async () => {
      invocations += 1;
      await new Promise(r => setTimeout(r, 10));
      return { n: invocations };
    };

    const [a, b, c] = await Promise.all([
      checkOrInsert(cwd, 'race', compute),
      checkOrInsert(cwd, 'race', compute),
      checkOrInsert(cwd, 'race', compute),
    ]);

    assert.equal(invocations, 1, 'lock should serialize, only first runs computeFn');
    assert.deepEqual(a.result, b.result);
    assert.deepEqual(b.result, c.result);
    const cachedFlags = [a.cached, b.cached, c.cached];
    assert.equal(cachedFlags.filter(Boolean).length, 2, 'two of three should report cached');
  });

  test('cache survives across calls in different process states', async () => {
    const cwd = freshCwd();
    await checkOrInsert(cwd, 'persistent', () => 'first');
    // Simulate a fresh process by re-reading the file via a new call.
    const { result, cached } = await checkOrInsert(cwd, 'persistent', () => 'second-should-not-run');
    assert.equal(cached, true);
    assert.equal(result, 'first');
  });

  test('_resetIdempotency clears the cache', async () => {
    const cwd = freshCwd();
    await checkOrInsert(cwd, 'k', () => 'v1');
    _resetIdempotency(cwd);
    const { result, cached } = await checkOrInsert(cwd, 'k', () => 'v2');
    assert.equal(cached, false);
    assert.equal(result, 'v2');
  });

  test('auto-creates .compose/data/ directory', async () => {
    const cwd = freshCwd();
    // Don't create the .compose dir manually — checkOrInsert should.
    await checkOrInsert(cwd, 'mkdir-test', () => 'ok');
    assert.ok(existsSync(join(cwd, '.compose', 'data')));
  });
});
