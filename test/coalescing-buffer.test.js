// compose/test/coalescing-buffer.test.js
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingBuffer } from '../server/coalescing-buffer.js';

describe('CoalescingBuffer', () => {
  describe('latest-wins mode', () => {
    it('delivers only the last put value for a key', async () => {
      const flushed = [];
      const buf = new CoalescingBuffer((data) => flushed.push(structuredClone(data)), { intervalMs: 10 });
      buf.register('state', 'latest-wins');
      buf.put('state', { v: 1 });
      buf.put('state', { v: 2 });
      buf.put('state', { v: 3 });
      await new Promise(r => setTimeout(r, 30));
      buf.stop();
      assert.equal(flushed.length, 1);
      assert.deepEqual(flushed[0].state, { v: 3 });
    });

    it('does not call flushFn when no data is pending', async () => {
      let calls = 0;
      const buf = new CoalescingBuffer(() => calls++, { intervalMs: 10 });
      buf.register('state', 'latest-wins');
      await new Promise(r => setTimeout(r, 30));
      buf.stop();
      assert.equal(calls, 0);
    });

    it('flush-rate: 100 rapid puts produce at most ceil(100ms/intervalMs) flushes', async () => {
      const flushed = [];
      const buf = new CoalescingBuffer((data) => flushed.push(structuredClone(data)), { intervalMs: 20 });
      buf.register('state', 'latest-wins');
      for (let i = 0; i < 100; i++) buf.put('state', { v: i });
      await new Promise(r => setTimeout(r, 100));
      buf.stop();
      assert.ok(flushed.length <= 5, `expected ≤5 flushes, got ${flushed.length}`);
      assert.deepEqual(flushed[0].state, { v: 99 });
    });
  });

  describe('append mode', () => {
    it('delivers all put values as an array', async () => {
      const flushed = [];
      const buf = new CoalescingBuffer((data) => flushed.push(structuredClone(data)), { intervalMs: 10 });
      buf.register('msgs', 'append');
      buf.put('msgs', 'a');
      buf.put('msgs', 'b');
      buf.put('msgs', 'c');
      await new Promise(r => setTimeout(r, 30));
      buf.stop();
      assert.equal(flushed.length, 1);
      assert.deepEqual(flushed[0].msgs, ['a', 'b', 'c']);
    });
  });

  describe('mixed keys', () => {
    it('each key respects its own mode independently', async () => {
      const flushed = [];
      const buf = new CoalescingBuffer((data) => flushed.push(structuredClone(data)), { intervalMs: 10 });
      buf.register('state', 'latest-wins');
      buf.register('msgs', 'append');
      buf.put('state', { v: 1 });
      buf.put('state', { v: 2 });
      buf.put('msgs', 'x');
      buf.put('msgs', 'y');
      await new Promise(r => setTimeout(r, 30));
      buf.stop();
      assert.equal(flushed.length, 1);
      assert.deepEqual(flushed[0].state, { v: 2 });
      assert.deepEqual(flushed[0].msgs, ['x', 'y']);
    });
  });

  describe('stop()', () => {
    it('clears the interval; no flush after stop', async () => {
      let calls = 0;
      const buf = new CoalescingBuffer(() => calls++, { intervalMs: 10 });
      buf.register('state', 'latest-wins');
      buf.put('state', { v: 1 });
      buf.stop();
      await new Promise(r => setTimeout(r, 50));
      assert.equal(calls, 0);
    });
  });
});
