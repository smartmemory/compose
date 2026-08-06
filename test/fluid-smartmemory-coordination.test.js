/**
 * fluid-smartmemory-coordination.test.js — COMP-FLUID-SEAM-GUARANTEES.
 *
 * The two server primitives that moved `mutationScope()` from NONE to CLUSTER:
 * the monotonic sequence behind handle allocation (SVC-ALLOC-1) and the scoped
 * lease behind every mutation (SVC-LEASE-1).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE CONFORMANCE SUITE
 * ---------------------------------------------------------
 * The conformance suite's concurrency cases are written against `Promise.all`
 * and whatever interleaving the event loop happens to produce. Measured while
 * writing this: its "does not lose a concurrent field update" case passes with
 * the lease AND with the lease removed — the two read-modify-write cycles simply
 * never overlapped. A test that cannot fail is not cover, so the lost-update
 * case here FORCES the overlap instead of hoping for it, and was verified to
 * fail with `_withLease` reduced to a pass-through.
 *
 * The sequence cases are the same idea applied to allocation: they assert the
 * server counter is what issues handles, that it is seeded from a workspace that
 * predates it, and that a caller-supplied handle raises it — three properties
 * that a "read the max and add one" implementation also satisfies, so each one
 * is pinned to an observable REQUEST rather than to the returned string.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { SmartMemoryFluidProvider } from '../lib/fluid/smartmemory-provider.js';
import { makeServer } from './helpers/smartmemory-stub.js';
import { KIND } from '../lib/fluid/provider.js';

const opened = [];
after(() => { for (const s of opened) s.close(); });

/**
 * A provider on a fresh stub, with the client left reachable so a test can wrap
 * one method to force an interleaving. `withProvider` in the shared helper does
 * not expose that hook, and adding one there would give every suite a seam it
 * does not need.
 */
async function withStore(fn, { wrapClient } = {}) {
  const { server, items, seen } = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  opened.push(server);
  process.env.SM_FLUID_KEY = 'test-key';
  try {
    const provider = await new SmartMemoryFluidProvider().init('/tmp/does-not-matter', {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'SM_FLUID_KEY',
      workspaceId: 'ws-test',
      timeoutMs: 5000,
    });
    if (wrapClient) wrapClient(provider.client);
    await fn({ provider, items, seen, server });
  } finally {
    delete process.env.SM_FLUID_KEY;
    server.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paths = (seen, re) => seen.filter((s) => re.test(s.path));

describe('handle allocation — the server counter (SVC-ALLOC-1)', () => {
  test('a handle comes from POST /memory/sequences/{name}/next, not from a scan', async () => {
    await withStore(async ({ provider, seen }) => {
      const rec = await provider.createRecord({ kind: KIND.IDEA, title: 'first' });
      assert.equal(rec.handle, 'IDEA-1');
      const allocs = paths(seen, /^\/memory\/sequences\/compose\.fluid\.handle\.idea\/next$/);
      assert.equal(allocs.length, 1, 'exactly one allocation per create');
      assert.equal(allocs[0].method, 'POST');
    });
  });

  test('the counter is seeded from a workspace that predates it, never restarting at 1', async () => {
    // The migration case, and the one a naive cutover gets wrong: these handles
    // were issued by a pre-sequence Compose, so the counter has never seen them.
    // Starting at 1 would reissue IDEA-1 on top of a live record.
    await withStore(async ({ provider }) => {
      for (const handle of ['IDEA-1', 'IDEA-2', 'IDEA-7']) {
        await provider.appendEvent({
          handle, type: 'created', at: new Date().toISOString(), detail: {},
        });
      }
      const rec = await provider.createRecord({ kind: KIND.IDEA, title: 'after the gap' });
      assert.equal(rec.handle, 'IDEA-8', 'must continue past the highest handle ever issued');
    });
  });

  test('the seeding scan runs ONCE — a second create does not re-enumerate the store', async () => {
    // The actual win. Allocation used to read every record UNION every event on
    // every create; if that comes back, this count goes up.
    await withStore(async ({ provider, seen }) => {
      await provider.createRecord({ kind: KIND.IDEA, title: 'one' });
      const afterFirst = seen.length;
      await provider.createRecord({ kind: KIND.IDEA, title: 'two' });
      const second = seen.slice(afterFirst);

      const enumerations = second.filter(
        (s) => s.path === '/memory/list' && /metadata_key=fluid_ns/.test(s.query ?? ''),
      );
      assert.equal(
        enumerations.length, 0,
        `the second create re-enumerated the store ${enumerations.length} time(s)`,
      );
      // And it still peeks + allocates, so the counter is genuinely in the path.
      assert.equal(paths(second, /^\/memory\/sequences\/[^/]+$/).length, 1, 'one peek');
      assert.equal(paths(second, /\/next$/).length, 1, 'one allocation');
    });
  });

  test('a caller-supplied handle raises the counter, so it cannot be issued twice', async () => {
    // The import path. Without the raise, the counter still sits at 0 and the
    // next automatic handle collides with the one just written by hand.
    await withStore(async ({ provider }) => {
      await provider.createRecord({ kind: KIND.IDEA, handle: 'IDEA-1', title: 'imported' });
      const next = await provider.createRecord({ kind: KIND.IDEA, title: 'allocated' });
      assert.equal(next.handle, 'IDEA-2');
    });
  });

  test('a sequential import stays gapless', async () => {
    // `floor: n - 1` rather than `floor: n` is what buys this: $max(n-1) then
    // $inc leaves the counter at exactly n. Gaps are legal, but an import that
    // silently skipped every other number would look like data loss.
    await withStore(async ({ provider }) => {
      for (const n of [1, 2, 3]) {
        await provider.createRecord({ kind: KIND.IDEA, handle: `IDEA-${n}`, title: `i${n}` });
      }
      const next = await provider.createRecord({ kind: KIND.IDEA, title: 'after import' });
      assert.equal(next.handle, 'IDEA-4');
    });
  });

  test('counters are per kind', async () => {
    await withStore(async ({ provider }) => {
      const idea = await provider.createRecord({ kind: KIND.IDEA, title: 'i' });
      const cluster = await provider.createRecord({ kind: KIND.CLUSTER, title: 'c' });
      assert.equal(idea.handle, 'IDEA-1');
      assert.equal(cluster.handle, 'CLUS-1');
    });
  });

  test('concurrent creates never share a handle', async () => {
    await withStore(async ({ provider }) => {
      const made = await Promise.all(
        Array.from({ length: 8 }, (_, i) => provider.createRecord({ kind: KIND.IDEA, title: `r${i}` })),
      );
      const handles = made.map((r) => r.handle);
      assert.equal(new Set(handles).size, 8, `duplicate handle in ${handles}`);
      for (const h of handles) assert.ok(await provider.getRecord(h), `${h} was allocated but not stored`);
    });
  });
});

describe('mutation serialization — the scoped lease (SVC-LEASE-1)', () => {
  test('a mutation acquires and releases the lease', async () => {
    await withStore(async ({ provider, seen }) => {
      const rec = await provider.createRecord({ kind: KIND.IDEA, title: 'x' });
      const acquires = seen.filter((s) => s.path === '/memory/locks/compose.fluid.mutate' && s.method === 'POST');
      const releases = seen.filter((s) => s.path === '/memory/locks/compose.fluid.mutate' && s.method === 'DELETE');
      assert.equal(acquires.length, 1);
      assert.equal(releases.length, 1, 'a lease held past the write blocks every other writer');
      assert.ok(rec.handle);
    });
  });

  test('allocation is NOT wrapped in the lease', async () => {
    // Deliberate: `$inc` is atomic, so serializing allocations would be slower
    // and no safer. Asserted so a later "make it consistent" refactor is a
    // conscious decision rather than a drive-by.
    await withStore(async ({ provider, seen }) => {
      await provider._nextHandle(KIND.IDEA);
      assert.equal(seen.filter((s) => s.path.startsWith('/memory/locks/')).length, 0);
    });
  });

  test('a concurrent field update is not lost — FORCED interleaving', async () => {
    // Verified to FAIL with `_withLease` reduced to `(op, fn) => fn()`.
    //
    // The first writer's READ is delayed so the second writer's entire
    // read-modify-write lands inside the first's read→write gap. Unserialized,
    // the first writer then writes a record it read before the second existed,
    // and the second's edit is gone behind two 200s.
    let firstRead = true;
    await withStore(async ({ provider }) => {
      const rec = await provider.createRecord({ kind: KIND.IDEA, title: 'contended' });
      firstRead = true;

      const results = await Promise.allSettled([
        provider.updateRecord(rec.handle, { priority: 'P0' }),
        // Let the slow reader get in first and take the lease.
        sleep(20).then(() => provider.updateRecord(rec.handle, { source: 'a conversation' })),
      ]);
      for (const r of results) {
        assert.equal(r.status, 'fulfilled', `an update failed: ${r.reason?.message}`);
      }

      const after = await provider.getRecord(rec.handle);
      assert.equal(after.priority, 'P0', 'the priority write was erased by the source write');
      assert.equal(after.source, 'a conversation', 'the source write was erased by the priority write');
    }, {
      wrapClient(client) {
        const original = client.listItems;
        client.listItems = async (...args) => {
          const result = await original.apply(client, args);
          if (firstRead) { firstRead = false; await sleep(250); }
          return result;
        };
      },
    });
  });

  test('a mutation that cannot take the lease throws and writes nothing', async () => {
    // Fail-closed. Proceeding unserialized is the one outcome the mechanism
    // exists to prevent, so exhausting the backoff must be loud.
    await withStore(async ({ provider, items }) => {
      const before = items.size;
      provider.client.acquireLock = async () => null; // a live holder, forever
      await assert.rejects(
        () => provider.createRecord({ kind: KIND.IDEA, title: 'never written' }),
        /could not acquire the mutation lease/,
      );
      assert.equal(items.size, before, 'a refused mutation must not leave a partial write');
    });
  });

  test('find-or-create resolves lookup and create under ONE hold', async () => {
    await withStore(async ({ provider, seen }) => {
      const first = await provider.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'Umbrella' });
      assert.equal(first.created, true);
      const acquires = seen.filter(
        (s) => s.path === '/memory/locks/compose.fluid.mutate' && s.method === 'POST',
      );
      assert.equal(acquires.length, 1, 'lookup and create must not take the lease twice');
    });
  });

  test('the declaration and the mechanism agree', async () => {
    await withStore(async ({ provider }) => {
      assert.equal(provider.mutationScope(), 'cluster');
      assert.ok(provider.leaseClient, 'a CLUSTER claim needs an exposed mechanism');
      assert.equal(provider.isShared(), true);
    });
  });
});
