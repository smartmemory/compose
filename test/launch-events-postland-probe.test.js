import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { readLaunchEvents, recordLaunchEvent } from '../lib/launch-events.js';

if (!isMainThread) {
  const { root, store, event, rendezvous } = workerData;
  const snapshotCount = new Int32Array(rendezvous);
  const read = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    const snapshot = read(path, ...args);
    if (path === store) {
      // Let both writers take their real disk snapshot before either can append.
      // Bound the wait so a serialized writer can also finish.
      if (Atomics.add(snapshotCount, 0, 1) === 0) {
        Atomics.wait(snapshotCount, 0, 1, 2000);
      } else {
        Atomics.notify(snapshotCount, 0);
      }
    }
    return snapshot;
  };
  syncBuiltinESMExports();
  parentPort.postMessage(recordLaunchEvent(root, event).status);
} else {
  test('overlapping refusal writers persist only one row for the same key', async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'n3-launch-probe-'));
    const store = join(root, '.compose', 'data', 'feature-events.jsonl');
    const at = '2026-11-04T00:00:00.000Z';
    const event = {
      tool: 'launch.refused', source: 'detach_job', ts: at, at,
      idempotency_key: 'launch.refused:n3-probe:fixture:0', label: 'n3-probe',
      mark: 'n3-probe:fixture', session: 'probe', unit: 'N3-PROBE', lane: null,
      attempt: 0, exit_code: 77, gate_line: 'WORK MODEL GATE (claude shim): test refusal',
    };

    fs.mkdirSync(dirname(store), { recursive: true });
    fs.writeFileSync(store, '');
    const rendezvous = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const writers = [];
    t.after(async () => {
      await Promise.all(writers.map((writer) => writer.terminate()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const statuses = await Promise.all([0, 1].map(async () => {
      const writer = new Worker(new URL(import.meta.url), { workerData: { root, store, event, rendezvous } });
      writers.push(writer);
      const [status] = await once(writer, 'message');
      return status;
    }));

    assert.deepEqual(statuses.sort(), ['duplicate', 'written']);
    assert.equal(readLaunchEvents(root).filter((row) => row.idempotency_key === event.idempotency_key).length, 1,
      `writer statuses: ${statuses.join(', ')}`);
  });
}
