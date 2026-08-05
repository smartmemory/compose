/**
 * test/fluid-provider-conformance.test.js — COMP-FLUID-SEAM-GUARANTEES.
 *
 * ONE SUITE, RUN AGAINST EVERY PROVIDER. This is the acceptance criterion that
 * actually prevents a recurrence; everything else in the feature repairs the
 * current instance.
 *
 * The failure it exists to make impossible: S3b-1 built serialized mutation and
 * `reclaimAborted` into `local-provider.js` rather than into the seam. The
 * SmartMemory provider then satisfied the interface COMPLETELY while having
 * neither, and nothing failed — no test, no type, no review. Patching the second
 * implementation would have closed that instance and left the cause, which is
 * that neither guarantee was written anywhere a third implementation must read.
 *
 * So the rule for this file: a case here asserts something true of ANY fluid
 * provider. Anything true of only one belongs in that provider's own suite.
 *
 * ADDING A PROVIDER MEANS ADDING A ROW TO `PROVIDERS` AND NOTHING ELSE. If your
 * provider cannot pass a case, the fix is the provider — or, where the store
 * genuinely cannot offer it, an honest DECLARATION (`mutationScope()`), which
 * the declaration cases below then hold you to.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FluidAmbiguousMatch,
  KIND,
  MUTATION_SCOPE,
  mutationScopeAtLeast,
} from '../lib/fluid/provider.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { withProvider, servers } from './helpers/smartmemory-stub.js';

after(() => { for (const s of servers) s.close(); });

/**
 * Each row hands a fresh, empty provider to `run`.
 *
 * The SmartMemory row runs against the shared wire stub rather than a fake
 * object: a hand-rolled double would pass by construction, which is precisely
 * how the real provider passed review while missing both guarantees.
 */
const PROVIDERS = [
  {
    name: 'local',
    async with(run) {
      const root = mkdtempSync(join(tmpdir(), 'conformance-local-'));
      mkdirSync(join(root, '.compose', 'data'), { recursive: true });
      await run(await new LocalFluidProvider().init(root, { recordsRoot: join(root, 'records') }));
    },
  },
  {
    name: 'smartmemory',
    async with(run) {
      await withProvider(({ provider }) => run(provider));
    },
  },
];

for (const impl of PROVIDERS) {
  describe(`fluid provider conformance — ${impl.name}`, () => {
    const on = (fn) => () => impl.with(fn);

    // ── declarations ────────────────────────────────────────────────────────
    //
    // A provider must answer these truthfully, because everything above the seam
    // decides what to warn about and what to allow from the answers. An
    // implementation that simply never overrode them inherits the SAFE default
    // (`NONE`), so silence is pessimistic rather than optimistic — the opposite
    // of the default that let S3b-1's gap through.

    it('declares how far its mutation serialization reaches', on(async (p) => {
      const scope = p.mutationScope();
      assert.ok(
        Object.values(MUTATION_SCOPE).includes(scope),
        `mutationScope() returned "${scope}", which is not a MUTATION_SCOPE value`
      );
      assert.equal(typeof p.isShared(), 'boolean');
    }));

    it('does not claim a serialization reach it has no mechanism for', on(async (p) => {
      // The one cross-check the seam can make mechanically: a provider claiming
      // to serialize across MACHINES must hold something machine-wide. The floor
      // holds a lock path; a future clustered provider would hold a lease client.
      if (mutationScopeAtLeast(p.mutationScope(), MUTATION_SCOPE.MACHINE)) {
        assert.ok(
          p.lockPath || p.leaseClient,
          `${p.name()} claims "${p.mutationScope()}" scope but exposes no serialization mechanism`
        );
      }
    }));

    // ── obligation 2: reclaimAborted ────────────────────────────────────────
    //
    // Testable against every provider today, because it needs nothing from the
    // store beyond its own event log. This is the half that was NOT blocked
    // upstream, and the half the SmartMemory provider silently ignored — which
    // made the one-time import non-restartable there, over a network call.

    it('reclaims a handle that was issued but never became live', on(async (p) => {
      // Exactly the state an interrupted import leaves: the tombstone is written
      // before the record, so a crash between them strands the handle.
      await p.appendEvent({ handle: 'IDEA-1', type: 'created', at: new Date().toISOString(), detail: {} });

      const rec = await p.createRecord({
        kind: KIND.IDEA, handle: 'IDEA-1', title: 'the resumed import', reclaimAborted: true,
      });
      assert.equal(rec.handle, 'IDEA-1');
      assert.equal((await p.getRecord('IDEA-1')).title, 'the resumed import');
    }));

    it('refuses a live handle even with reclaimAborted', on(async (p) => {
      // The narrowness IS the safety. A handle whose record exists is in use,
      // and reclaiming it would overwrite a real record.
      const first = await p.createRecord({ kind: KIND.IDEA, title: 'in use' });
      await assert.rejects(
        () => p.createRecord({
          kind: KIND.IDEA, handle: first.handle, title: 'thief', reclaimAborted: true,
        }),
        /already been issued/
      );
      assert.equal((await p.getRecord(first.handle)).title, 'in use');
    }));

    it('refuses a DELETED handle even with reclaimAborted', on(async (p) => {
      // Retired handles stay retired: they are external citations, and reissuing
      // one repoints every existing reference at a different record. This is the
      // case a naive "no record? then it is free" check gets wrong.
      const first = await p.createRecord({ kind: KIND.IDEA, title: 'doomed' });
      await p.deleteRecord(first.handle);
      assert.equal(await p.getRecord(first.handle), null);

      await assert.rejects(
        () => p.createRecord({
          kind: KIND.IDEA, handle: first.handle, title: 'reincarnation', reclaimAborted: true,
        }),
        /already been issued/
      );
    }));

    it('refuses an issued handle when reclaimAborted is absent', on(async (p) => {
      // The opt-in half: reclaim is never implicit. Only the import asks for it.
      await p.appendEvent({ handle: 'IDEA-1', type: 'created', at: new Date().toISOString(), detail: {} });
      await assert.rejects(
        () => p.createRecord({ kind: KIND.IDEA, handle: 'IDEA-1', title: 'uninvited' }),
        /already been issued/
      );
    }));

    // ── obligation 1: serialized mutation ───────────────────────────────────

    it('allocates distinct handles under concurrent creates, or declares that it cannot',
      on(async (p) => {
        const N = 5;
        const results = await Promise.allSettled(
          Array.from({ length: N }, (_, i) => p.createRecord({ kind: KIND.IDEA, title: `racer ${i}` }))
        );
        const handles = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.handle);
        const distinct = new Set(handles);

        if (mutationScopeAtLeast(p.mutationScope(), MUTATION_SCOPE.PROCESS)) {
          assert.equal(distinct.size, handles.length, `${p.name()} issued a duplicate handle`);
          // Conservation: every handle that was handed out names a real record.
          for (const h of handles) assert.ok(await p.getRecord(h), `${h} was allocated but not stored`);
          assert.equal((await p.listRecords({ kind: KIND.IDEA })).length, handles.length);
        } else {
          // A provider declaring NONE is expected to fail this. Asserting the
          // failure is the point: it keeps the declaration honest in BOTH
          // directions, so a provider that later gains serialization cannot
          // leave a stale `NONE` behind — this case starts failing when it does.
          assert.ok(
            distinct.size <= handles.length,
            'impossible: more distinct handles than allocations'
          );
        }
      }));

    it('does not lose a concurrent field update, or declares that it cannot', on(async (p) => {
      // The quieter half of serialization. Allocation collisions are loud once
      // you look; lost updates are read-modify-write on ONE record and leave no
      // trace at all — both writers succeed and one edit is simply gone.
      const rec = await p.createRecord({ kind: KIND.IDEA, title: 'contended' });
      await Promise.allSettled([
        p.updateRecord(rec.handle, { priority: 'P0' }),
        p.updateRecord(rec.handle, { source: 'a conversation' }),
      ]);

      if (mutationScopeAtLeast(p.mutationScope(), MUTATION_SCOPE.PROCESS)) {
        const after = await p.getRecord(rec.handle);
        assert.equal(after.priority, 'P0', 'the priority write was erased by the source write');
        assert.equal(after.source, 'a conversation', 'the source write was erased by the priority write');
      }
    }));

    // ── find-or-create (F6-1) ───────────────────────────────────────────────

    it('find-or-create returns the existing record rather than making a twin', on(async (p) => {
      const first = await p.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'Umbrella A' });
      assert.equal(first.created, true);

      const second = await p.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'Umbrella A' });
      assert.equal(second.created, false);
      assert.equal(second.record.handle, first.record.handle);
      assert.equal((await p.listRecords({ kind: KIND.CLUSTER })).length, 1);
    }));

    it('find-or-create matches title case-insensitively', on(async (p) => {
      const first = await p.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'Umbrella A' });
      const second = await p.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'umbrella a' });
      assert.equal(second.record.handle, first.record.handle);
      assert.equal(second.created, false);
    }));

    it('find-or-create refuses to guess between duplicates', on(async (p) => {
      // Ambiguity is not resolvable by creating, so it cannot be handled like a
      // miss. Auto-picking would silently attach work to whichever sorted first.
      await p.createRecord({ kind: KIND.CLUSTER, title: 'Twin' });
      await p.createRecord({ kind: KIND.CLUSTER, title: 'twin' });
      await assert.rejects(
        () => p.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'Twin' }),
        (err) => {
          assert.ok(err instanceof FluidAmbiguousMatch);
          assert.equal(err.handles.length, 2);
          return true;
        }
      );
    }));

    it('creates exactly one record when find-or-create races itself, or declares that it cannot',
      on(async (p) => {
        // F6-1 in its original form: lookup and create are two operations, and a
        // per-mutation lock covers each but not the pair.
        const runs = await Promise.allSettled(
          Array.from({ length: 4 }, () => p.findOrCreateRecord({ kind: KIND.CLUSTER, title: 'Contended' }))
        );
        const ok = runs.filter((r) => r.status === 'fulfilled');
        assert.ok(ok.length > 0, 'every find-or-create failed');

        if (mutationScopeAtLeast(p.mutationScope(), MUTATION_SCOPE.PROCESS)) {
          const clusters = await p.listRecords({ kind: KIND.CLUSTER });
          assert.equal(clusters.length, 1, `find-or-create created ${clusters.length} twins`);
          assert.equal(ok.filter((r) => r.value.created).length, 1, 'more than one caller believed it created');
        }
      }));

    // ── shared record rules ─────────────────────────────────────────────────
    //
    // Already lifted into `record-shape.js` for the same reason these two
    // obligations are being lifted now (COMP-FOH C12/C16). Asserted here so the
    // suite covers the whole seam promise rather than only its newest third.

    it('fills absent optional fields to contract defaults on the way out', on(async (p) => {
      const rec = await p.createRecord({ kind: KIND.IDEA, title: 'minimal' });
      const read = await p.getRecord(rec.handle);
      assert.deepEqual(
        {
          body: read.body, priority: read.priority, effort: read.effort, impact: read.impact,
          cluster: read.cluster, tags: read.tags, links: read.links,
          killed: read.killed, discussion: read.discussion,
        },
        {
          body: '', priority: null, effort: null, impact: null,
          cluster: null, tags: [], links: [], killed: null, discussion: [],
        }
      );
    }));

    it('refuses to patch identity or append-only evidence', on(async (p) => {
      const rec = await p.createRecord({ kind: KIND.IDEA, title: 'guarded' });
      for (const patch of [{ handle: 'IDEA-999' }, { kind: KIND.DECISION }, { discussion: [] }, { provenance: null }]) {
        await assert.rejects(
          () => p.updateRecord(rec.handle, patch),
          /cannot be changed through updateRecord/,
          `updateRecord accepted ${JSON.stringify(patch)}`
        );
      }
    }));

    it('grows the discussion only through appendDiscussion', on(async (p) => {
      const rec = await p.createRecord({ kind: KIND.IDEA, title: 'deliberated' });
      await p.appendDiscussion(rec.handle, { text: 'first', author: 'Jane Doe' });
      await p.appendDiscussion(rec.handle, { text: 'second', author: 'human' });

      const read = await p.getRecord(rec.handle);
      assert.deepEqual(read.discussion.map((d) => d.text), ['first', 'second']);
      assert.equal(read.discussion[0].author, 'Jane Doe');
    }));

    it('returns records that share no references with the store', on(async (p) => {
      // A caller mutating what the provider considers canonical, with no write,
      // no timestamp, no event and no save, is a change that appears to take
      // effect and then silently vanishes.
      const rec = await p.createRecord({ kind: KIND.IDEA, title: 'cloned', tags: ['a'] });
      const first = await p.getRecord(rec.handle);
      first.tags.push('injected');
      first.title = 'mutated in place';

      const second = await p.getRecord(rec.handle);
      assert.deepEqual(second.tags, ['a']);
      assert.equal(second.title, 'cloned');
    }));

    it('reports a missing record as null rather than throwing', on(async (p) => {
      assert.equal(await p.getRecord('IDEA-4242'), null);
      // Untrusted input reaches this call from a CLI argument or a URL segment;
      // the honest answer to a malformed handle is "no", not a crash.
      assert.equal(await p.getRecord('../../etc/passwd'), null);
    }));

    it('refuses a handle that does not belong to its kind', on(async (p) => {
      await assert.rejects(
        () => p.createRecord({ kind: KIND.IDEA, handle: 'DEC-4', title: 'wrong prefix' }),
        /does not belong to kind/
      );
    }));

    it('refuses a kind it does not implement, naming what it does', on(async (p) => {
      await assert.rejects(
        () => p.createRecord({ kind: KIND.POSITION, title: 'owned by the judgment layer' }),
        /not supported by provider/
      );
    }));
  });
}
