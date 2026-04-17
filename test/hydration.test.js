import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingBuffer } from '../server/coalescing-buffer.js';

describe('hydration — buffer semantics', () => {
  it('append-mode buffer delivers messages as array for SSE replay', async () => {
    const flushed = [];
    const buf = new CoalescingBuffer((d) => flushed.push(d), { intervalMs: 10 });
    buf.register('agentMessage', 'append');
    buf.put('agentMessage', { type: 'assistant', content: 'hello' });
    buf.put('agentMessage', { type: 'assistant', content: 'world' });
    await new Promise(r => setTimeout(r, 30));
    buf.stop();
    assert.equal(flushed.length, 1);
    assert.deepEqual(flushed[0].agentMessage, [
      { type: 'assistant', content: 'hello' },
      { type: 'assistant', content: 'world' },
    ]);
  });

  it('latest-wins buffer delivers only most recent state for WS hydrate', async () => {
    const flushed = [];
    const buf = new CoalescingBuffer((d) => flushed.push(d), { intervalMs: 10 });
    buf.register('visionState', 'latest-wins');
    buf.put('visionState', { items: [1] });
    buf.put('visionState', { items: [1, 2] });
    buf.put('visionState', { items: [1, 2, 3] });
    await new Promise(r => setTimeout(r, 30));
    buf.stop();
    assert.equal(flushed.length, 1);
    assert.deepEqual(flushed[0].visionState, { items: [1, 2, 3] });
  });
});

describe('hydration — ring buffer semantics', () => {
  it('keeps only the last 50 messages when push exceeds limit', () => {
    // Simulates the ring buffer in agent-server.js
    const ring = [];
    const LIMIT = 50;
    const track = (msg) => {
      ring.push(msg);
      if (ring.length > LIMIT) ring.shift();
    };
    for (let i = 0; i < 60; i++) track({ v: i });
    assert.equal(ring.length, 50);
    assert.equal(ring[0].v, 10);
    assert.equal(ring[49].v, 59);
  });

  it('snapshot is null when buffer is empty', () => {
    const ring = [];
    const snapshot = ring.length > 0 ? [...ring] : null;
    assert.equal(snapshot, null);
  });

  it('snapshot is a copy, not a reference', () => {
    const ring = [{ v: 1 }, { v: 2 }];
    const snapshot = ring.length > 0 ? [...ring] : null;
    ring.push({ v: 3 });
    assert.equal(snapshot.length, 2);
    assert.equal(ring.length, 3);
  });
});
