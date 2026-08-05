/**
 * fluid-smartmemory-provider.test.js — COMP-FOH FOH-1 S02
 *
 * The provider against a raw node:http stub that models the real SmartMemory
 * CRUD routes (same pattern as test/smartmemory-client.test.js — no express, no
 * mocking library). The stub IS the wire contract, so every correction in the
 * blueprint becomes an assertion about what the adapter actually sends.
 *
 * The stub deliberately reproduces two server behaviours that broke earlier
 * revisions of this design, so the tests would catch a regression to them:
 *   - it stamps its own `metadata.created_at` on every add
 *   - its PATCH metadata merge is a ONE-LEVEL spread, not a deep merge
 *
 * Run: node --test test/fluid-smartmemory-provider.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FluidConfigError, FluidRecordNotFound, CAP } from '../lib/fluid/provider.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { assertValid } from '../lib/fluid/schema.js';
import { SmartMemoryFluidProvider } from '../lib/fluid/smartmemory-provider.js';
// The stub IS the wire contract, so it lives in one place and every suite that
// exercises this provider asserts against the same server behaviour.
import { withProvider, servers } from './helpers/smartmemory-stub.js';

after(() => { for (const s of servers) s.close(); });

/**
 * A minimal but honest SmartMemory. Items live in a Map keyed by item_id.
 * `clock` makes the server-stamped created_at deterministic and orderable.
 */

describe('SmartMemoryFluidProvider — configuration', () => {
  const base = { baseUrl: 'http://x', apiKeyEnv: 'SM_FLUID_KEY', workspaceId: 'ws' };

  test('each missing setting throws FluidConfigError naming it, before any network call', async () => {
    process.env.SM_FLUID_KEY = 'k';
    try {
      const cases = [
        [{ ...base, baseUrl: undefined }, 'smartmemory.baseUrl'],
        [{ ...base, apiKeyEnv: undefined }, 'smartmemory.apiKeyEnv'],
        [{ ...base, workspaceId: undefined }, 'fluid.smartmemory.workspaceId'],
      ];
      for (const [cfg, setting] of cases) {
        await assert.rejects(
          () => new SmartMemoryFluidProvider().init('/tmp', cfg),
          (err) => err instanceof FluidConfigError && err.message.includes(setting),
          `expected a FluidConfigError naming ${setting}`,
        );
      }
    } finally {
      delete process.env.SM_FLUID_KEY;
    }
  });

  test('an empty API key env value is a config error, not a request failure', async () => {
    process.env.SM_FLUID_KEY = '';
    try {
      await assert.rejects(
        () => new SmartMemoryFluidProvider().init('/tmp', base),
        (err) => err instanceof FluidConfigError && err.message.includes('SM_FLUID_KEY'),
      );
    } finally {
      delete process.env.SM_FLUID_KEY;
    }
  });
});

describe('SmartMemoryFluidProvider — seam contract', () => {
  // FOH-2 added RECALL. The rest stay undeclared and keep inheriting the base
  // class's refusal — a capability and its implementation move together.
  test('declares storage + RECALL; the remaining semantic capabilities still throw', async () => {
    await withProvider(async ({ provider }) => {
      assert.ok(provider.has(CAP.RECORDS) && provider.has(CAP.EVENTS) && provider.has(CAP.LINKS));
      assert.ok(provider.has(CAP.RECALL), 'FOH-2 declares RECALL');
      for (const cap of [CAP.CHALLENGE, CAP.CONVICTION, CAP.CALIBRATION, CAP.CONTRADICTION]) {
        assert.equal(provider.has(cap), false, `${cap} must not be declared`);
      }
      await assert.rejects(() => provider.challenge('IDEA-1'), /FluidCapabilityUnavailable|capability/i);
    });
  });

  test('supports the floor\'s five kinds, and refuses position/joint', async () => {
    await withProvider(async ({ provider }) => {
      for (const kind of ['idea', 'decision', 'thread', 'question', 'cluster']) {
        assert.ok(provider.supportedKinds().has(kind), `${kind} should be supported`);
      }
      for (const kind of ['position', 'joint']) {
        assert.equal(provider.supportedKinds().has(kind), false);
      }
    });
  });

  test('getRecord returns null on a miss; mutating paths throw FluidRecordNotFound', async () => {
    await withProvider(async ({ provider }) => {
      assert.equal(await provider.getRecord('IDEA-999'), null);
      assert.equal(await provider.getRecord('not-a-handle'), null);
      await assert.rejects(() => provider.updateRecord('IDEA-999', { title: 'x' }), FluidRecordNotFound);
      await assert.rejects(() => provider.deleteRecord('IDEA-999'), FluidRecordNotFound);
      await assert.rejects(() => provider.addLink('IDEA-999', { type: 'informs', target: 'IDEA-1' }), FluidRecordNotFound);
    });
  });

  test('every unpatchable field is refused by the shared rule', async () => {
    await withProvider(async ({ provider }) => {
      const rec = await provider.createRecord({ title: 'keep' });
      for (const field of ['handle', 'kind', 'provenance', 'discussion', 'id', 'created_at', 'updated_at']) {
        await assert.rejects(
          () => provider.updateRecord(rec.handle, { [field]: field === 'discussion' ? [] : 'x' }),
          /cannot be changed through updateRecord/,
          `${field} must be refused`,
        );
      }
    });
  });
});

describe('SmartMemoryFluidProvider — wire mapping', () => {
  test('memory_type is fluid_<kind>, never the bare kind', async () => {
    await withProvider(async ({ provider, items }) => {
      await provider.createRecord({ kind: 'decision', title: 'a decision' });
      const types = [...items.values()].map((i) => i.memory_type);
      assert.ok(types.includes('fluid_decision'), `expected fluid_decision, got ${types}`);
      assert.equal(types.includes('decision'), false, 'must not collide with SmartMemory\'s own decision type');
      assert.ok(types.includes('fluid_event'), 'events carry their own wire type');
    });
  });

  test('the record is one opaque blob, with three flat lookup fields beside it', async () => {
    await withProvider(async ({ provider, items }) => {
      const rec = await provider.createRecord({ title: 'sealed', body: 'prose' });
      const item = [...items.values()].find((i) => i.metadata.fluid_ns === 'compose.fluid.v1');
      assert.deepEqual(
        Object.keys(item.metadata).sort(),
        ['created_at', 'fluid_ns', 'fluid_record_json', 'handle', 'kind'].sort(),
      );
      assert.equal(typeof item.metadata.fluid_record_json, 'string');
      assert.equal(JSON.parse(item.metadata.fluid_record_json).handle, rec.handle);
    });
  });

  test('content carries title, body AND discussion so recall can reach the prose', async () => {
    await withProvider(async ({ provider, items }) => {
      const rec = await provider.createRecord({ title: 'the title', body: 'the body' });
      await provider.appendDiscussion(rec.handle, { text: 'the discussion' });
      const item = [...items.values()].find((i) => i.metadata.fluid_ns === 'compose.fluid.v1');
      for (const fragment of ['the title', 'the body', 'the discussion']) {
        assert.ok(item.content.includes(fragment), `content should contain "${fragment}"`);
      }
    });
  });

  test('every request carries X-Workspace-Id', async () => {
    await withProvider(async ({ provider, seen }) => {
      const rec = await provider.createRecord({ title: 't' });
      await provider.updateRecord(rec.handle, { title: 't2' });
      await provider.listRecords();
      assert.ok(seen.length > 0);
      for (const s of seen) assert.equal(s.workspace, 'ws-test');
    });
  });
});

describe('SmartMemoryFluidProvider — round trip fidelity (D-FOH-2)', () => {
  test('nulls, empty containers, nested objects and JSON-looking prose all survive', async () => {
    await withProvider(async ({ provider }) => {
      const created = await provider.createRecord({
        title: 'fidelity',
        body: '{"looks": "like json"}',
        tags: [],
        links: [],
        source: null,
        priority: null,
        provenance: { origin: 'cli:ideabox', author: null },
      });
      const read = await provider.getRecord(created.handle);
      assert.deepEqual(read, created, 'the record must round-trip deep-equal');
      assert.equal(read.body, '{"looks": "like json"}');
      assert.equal(read.priority, null);
      assert.equal(read.source, null);
      assert.deepEqual(read.tags, []);
      assert.equal(read.provenance.author, null);
    });
  });

  test('the server stamping its own created_at does NOT alter the record\'s', async () => {
    await withProvider(async ({ provider, items }) => {
      const created = await provider.createRecord({ title: 'provenance' });
      const item = [...items.values()].find((i) => i.metadata.fluid_ns === 'compose.fluid.v1');
      // Both layers exist and disagree — which is expected and correct.
      assert.ok(item.metadata.created_at.startsWith('2026-01-01'), 'server layer present');
      const read = await provider.getRecord(created.handle);
      assert.equal(read.created_at, created.created_at, 'record layer untouched');
      assert.notEqual(read.created_at, item.metadata.created_at);
    });
  });

  test('a field cleared in a second write reads back cleared, not resurrected (C14b)', async () => {
    await withProvider(async ({ provider }) => {
      const rec = await provider.createRecord({ title: 't', priority: 'P1', status_label: 'triaged' });
      await provider.updateRecord(rec.handle, { priority: null, status_label: null });
      const read = await provider.getRecord(rec.handle);
      assert.equal(read.priority, null, 'priority must clear');
      assert.equal(read.status_label, null, 'status_label must clear');
    });
  });
});

describe('SmartMemoryFluidProvider — handles', () => {
  test('allocates sequentially per kind and never reuses a deleted handle', async () => {
    await withProvider(async ({ provider }) => {
      const a = await provider.createRecord({ title: 'one' });
      const b = await provider.createRecord({ title: 'two' });
      assert.equal(a.handle, 'IDEA-1');
      assert.equal(b.handle, 'IDEA-2');
      const c = await provider.createRecord({ kind: 'cluster', title: 'grouping' });
      assert.equal(c.handle, 'CLUS-1');

      await provider.deleteRecord(b.handle);
      const d = await provider.createRecord({ title: 'three' });
      assert.equal(d.handle, 'IDEA-3', 'the deleted handle must stay retired');
      await assert.rejects(
        () => provider.createRecord({ title: 'reuse', handle: 'IDEA-2' }),
        /already been issued/,
      );
    });
  });

  test('a caller-supplied handle must match its kind', async () => {
    await withProvider(async ({ provider }) => {
      await assert.rejects(
        () => provider.createRecord({ kind: 'idea', title: 'x', handle: 'DEC-4' }),
        /does not belong to kind/,
      );
    });
  });

  test('duplicate handles resolve to the earliest and are repaired on write (D-FOH-4)', async () => {
    await withProvider(async ({ provider, items }) => {
      const first = await provider.createRecord({ title: 'original' });

      // Forge the race the store cannot prevent: a second live item on the same
      // handle, created later by the server's own clock.
      const clone = [...items.values()].find((i) => i.metadata.fluid_ns === 'compose.fluid.v1');
      const dupRecord = { ...JSON.parse(clone.metadata.fluid_record_json), title: 'racing duplicate' };
      items.set('item-forged', {
        item_id: 'item-forged',
        content: 'racing duplicate',
        memory_type: 'fluid_idea',
        metadata: { ...clone.metadata, fluid_record_json: JSON.stringify(dupRecord), created_at: '2026-01-01T00:00:59Z' },
      });

      // Read: deterministic, earliest wins, no throw.
      const read = await provider.getRecord(first.handle);
      assert.equal(read.title, 'original', 'the earliest record wins the handle');

      // Write: repairs, keeping the earliest and rehoming the later one.
      await provider.updateRecord(first.handle, { title: 'edited' });
      const after = await provider.getRecord(first.handle);
      assert.equal(after.title, 'edited');

      const forged = items.get('item-forged');
      const rehomed = JSON.parse(forged.metadata.fluid_record_json);
      assert.notEqual(rehomed.handle, first.handle, 'the duplicate must get a fresh handle');
      assert.equal(rehomed.title, 'racing duplicate', 'and must not be discarded');
    });
  });
});

describe('SmartMemoryFluidProvider — pagination', () => {
  test('enumeration returns all 120 records, not the first page of 50 (C5)', async () => {
    await withProvider(async ({ provider }) => {
      for (let i = 0; i < 120; i += 1) {
        await provider.createRecord({ title: `idea ${i}` });
      }
      const all = await provider.listRecords();
      assert.equal(all.length, 120, 'a silently truncated list would delete the rest of the ideabox');
      assert.equal(new Set(all.map((r) => r.handle)).size, 120, 'handles must all be distinct');
    });
  });
});

describe('SmartMemoryFluidProvider — events and links', () => {
  test('events are separate items that outlive the record (tombstone invariant)', async () => {
    await withProvider(async ({ provider, items }) => {
      const rec = await provider.createRecord({ title: 'doomed' });
      await provider.deleteRecord(rec.handle);

      const recordItems = [...items.values()].filter((i) => i.metadata.fluid_ns === 'compose.fluid.v1');
      assert.equal(recordItems.length, 0, 'the record is gone');

      const events = await provider.readEvents(rec.handle);
      const types = events.map((e) => e.type);
      assert.ok(types.includes('created'), 'the creation tombstone survives deletion');
      assert.ok(types.includes('deleted'));
      const deleted = events.find((e) => e.type === 'deleted');
      assert.ok('discussion' in deleted.detail, 'deletion carries the evidence into the log');
    });
  });

  test('a status change is recorded as its lifecycle event, not a generic update', async () => {
    await withProvider(async ({ provider }) => {
      const rec = await provider.createRecord({ title: 'promote me' });
      await provider.updateRecord(rec.handle, { status: 'promoted' });
      const types = (await provider.readEvents(rec.handle)).map((e) => e.type);
      assert.ok(types.includes('promoted'), `expected a promoted event, got ${types}`);
    });
  });

  test('links round-trip and re-adding one is a silent no-op', async () => {
    await withProvider(async ({ provider }) => {
      const rec = await provider.createRecord({ title: 'linked' });
      const link = { type: 'informs', target: 'IDEA-99' };
      await provider.addLink(rec.handle, link);
      await provider.addLink(rec.handle, link);
      const read = await provider.getRecord(rec.handle);
      assert.equal(read.links.length, 1, 'idempotent');
      const linked = (await provider.readEvents(rec.handle)).filter((e) => e.type === 'linked');
      assert.equal(linked.length, 1, 'a repeat must not inflate the lifecycle history');

      await provider.removeLink(rec.handle, link);
      assert.deepEqual((await provider.getRecord(rec.handle)).links, []);
    });
  });

  test('an invalid link type is refused at the write', async () => {
    await withProvider(async ({ provider }) => {
      const rec = await provider.createRecord({ title: 'x' });
      await assert.rejects(() => provider.addLink(rec.handle, { type: 'nonsense', target: 'IDEA-2' }), /invalid link type/);
    });
  });
});

describe('SmartMemoryFluidProvider — the pilot workload', () => {
  test('clusters-first ordering, as the ideabox import actually writes it', async () => {
    await withProvider(async ({ provider }) => {
      // The import creates clusters BEFORE ideas, because members reference them
      // by handle. An idea-only provider throws on the first line of this.
      const cluster = await provider.createRecord({ kind: 'cluster', title: 'Theme A' });
      const one = await provider.createRecord({ kind: 'idea', title: 'first', cluster: cluster.handle, cluster_order: 1 });
      const two = await provider.createRecord({ kind: 'idea', title: 'second', cluster: cluster.handle, cluster_order: 2 });

      const inCluster = await provider.listRecords({ cluster: cluster.handle });
      assert.deepEqual(inCluster.map((r) => r.handle), [one.handle, two.handle], 'stable cluster order');
      assert.equal((await provider.listRecords({ kind: 'cluster' })).length, 1);
    });
  });
});

describe('SmartMemoryFluidProvider — recall (FOH-2)', () => {
  test('declares RECALL and answers; the floor refuses', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      assert.ok(provider.has(CAP.RECALL), 'the capability must be declared');
      const rec = await provider.createRecord({ title: 'findable' });
      queueHits([{ handle: rec.handle, score: 0.9 }]);
      const hits = await provider.recall('findable');
      assert.equal(hits.length, 1);
    });
    // The capability difference IS the seam's point: same call, same input.
    const floor = new LocalFluidProvider();
    await floor.init(mkdtempSync(join(tmpdir(), 'fluid-recall-')), {});
    await assert.rejects(() => floor.recall('anything'), /FluidCapabilityUnavailable|capability/i);
  });

  test('a hit is {handle, score, record}, and record validates against the contract', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const rec = await provider.createRecord({ title: 'shaped', body: 'prose' });
      queueHits([{ handle: rec.handle, score: 0.75 }]);
      const [hit] = await provider.recall('shaped');
      assert.deepEqual(Object.keys(hit).sort(), ['handle', 'record', 'score']);
      assert.equal(hit.handle, rec.handle);
      assert.equal(hit.score, 0.75);
      assert.deepEqual(hit.record, rec);
      // Would fail if score were glued onto the record: the schema is
      // additionalProperties:false.
      assertValid('record', hit.record, 'record');
    });
  });

  test('a missing score is null, never 0', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const rec = await provider.createRecord({ title: 'unscored' });
      queueHits([{ handle: rec.handle, score: undefined }]);
      const [hit] = await provider.recall('unscored');
      assert.equal(hit.score, null, '0 would sort as a real, terrible score');
    });
  });

  test('cluster is excluded even when ranked above a recallable kind', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const cluster = await provider.createRecord({ kind: 'cluster', title: 'Theme' });
      const idea = await provider.createRecord({ kind: 'idea', title: 'An idea' });
      // Server ranks the non-recallable one first — the config-dial failure mode.
      queueHits([
        { handle: cluster.handle, score: 0.99 },
        { handle: idea.handle, score: 0.10 },
      ]);
      const hits = await provider.recall('anything');
      assert.deepEqual(hits.map((h) => h.handle), [idea.handle],
        'output filtering must hold regardless of what the server embedded');
    });
  });

  test('all four recallable kinds come back, decision included', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const made = [];
      for (const kind of ['idea', 'thread', 'question', 'decision']) {
        made.push(await provider.createRecord({ kind, title: `a ${kind}` }));
      }
      queueHits(made.map((r, i) => ({ handle: r.handle, score: 1 - i / 10 })));
      const hits = await provider.recall('anything');
      assert.deepEqual(hits.map((h) => h.handle), made.map((r) => r.handle));
    });
  });

  // Owner ruling 2026-08-04 made decisions recallable. §Q3's objection was
  // surfacing a superseded decision "as if it were live" — so the load-bearing
  // property is that a hit is DISTINGUISHABLE, not that it is withheld.
  test('a killed decision is recalled but carries its status, so a caller can tell', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const dec = await provider.createRecord({ kind: 'decision', title: 'Use Postgres' });
      await provider.updateRecord(dec.handle, {
        status: 'killed',
        killed: { at: '2026-08-04T00:00:00Z', reason: 'superseded by DEC-2' },
      });
      queueHits([{ handle: dec.handle, score: 0.9 }]);
      const [hit] = await provider.recall('database choice');
      assert.equal(hit.handle, dec.handle, 'killed decisions are still findable');
      assert.equal(hit.record.status, 'killed', 'and never look live');
      assert.equal(hit.record.killed.reason, 'superseded by DEC-2');
    });
  });

  test('non-fluid items in the same workspace are dropped', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const rec = await provider.createRecord({ title: 'ours' });
      queueHits([
        { item: { item_id: 'foreign', content: 'someone else', memory_type: 'semantic', metadata: {} }, score: 0.99 },
        { handle: rec.handle, score: 0.5 },
      ]);
      const hits = await provider.recall('anything');
      assert.deepEqual(hits.map((h) => h.handle), [rec.handle]);
    });
  });

  test('an unreadable blob is skipped, not fatal', async () => {
    await withProvider(async ({ provider, queueHits }) => {
      const rec = await provider.createRecord({ title: 'good' });
      queueHits([
        {
          item: {
            item_id: 'corrupt',
            content: 'x',
            memory_type: 'fluid_idea',
            metadata: { fluid_ns: 'compose.fluid.v1', handle: 'IDEA-99', kind: 'idea', fluid_record_json: '{not json' },
          },
          score: 0.99,
        },
        { handle: rec.handle, score: 0.5 },
      ]);
      const hits = await provider.recall('anything');
      assert.deepEqual(hits.map((h) => h.handle), [rec.handle], 'one corrupt row must not break recall');
    });
  });

  test('reconstructs records from the hit itself — no follow-up fetch', async () => {
    await withProvider(async ({ provider, queueHits, seen }) => {
      const rec = await provider.createRecord({ title: 'no n+1', body: 'body text' });
      queueHits([{ handle: rec.handle, score: 0.9 }]);
      seen.length = 0;
      const [hit] = await provider.recall('anything');
      assert.deepEqual(hit.record, rec);
      const gets = seen.filter((s) => s.method === 'GET' && s.path.startsWith('/memory/') && s.path !== '/memory/list');
      assert.equal(gets.length, 0, 'the blob rides back on the hit; a per-hit GET would be N+1');
    });
  });

  test('duplicate handles collapse to the earliest, including on an equal timestamp', async () => {
    await withProvider(async ({ provider, items, queueHits }) => {
      const rec = await provider.createRecord({ title: 'original' });
      const live = [...items.values()].find((i) => i.metadata.fluid_ns === 'compose.fluid.v1');

      const dupe = (id, createdAt, title) => ({
        item_id: id,
        content: title,
        memory_type: 'fluid_idea',
        metadata: {
          ...live.metadata,
          created_at: createdAt,
          fluid_record_json: JSON.stringify({ ...JSON.parse(live.metadata.fluid_record_json), title }),
        },
      });

      // Different timestamps: earliest created_at wins.
      queueHits([
        { item: dupe('later', '2026-01-01T00:00:09Z', 'later copy'), score: 0.9 },
        { item: dupe('earlier', '2026-01-01T00:00:01Z', 'earlier copy'), score: 0.4 },
      ]);
      let hits = await provider.recall('anything');
      assert.equal(hits.length, 1, 'one handle, one hit');
      assert.equal(hits[0].record.title, 'earlier copy');
      assert.equal(hits[0].score, 0.9, 'the surviving hit keeps its original rank and score');

      // Equal timestamps: item_id breaks the tie, matching D-FOH-4.
      queueHits([
        { item: dupe('bbb', '2026-01-01T00:00:05Z', 'bbb copy'), score: 0.9 },
        { item: dupe('aaa', '2026-01-01T00:00:05Z', 'aaa copy'), score: 0.4 },
      ]);
      hits = await provider.recall('anything');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].record.title, 'aaa copy', 'lexicographic item_id, not arbitrary');
      assert.equal(hits[0].handle, rec.handle);
    });
  });

  test('limit defaults to 10, clamps, and tolerates garbage', async () => {
    await withProvider(async ({ provider, queueHits, seen }) => {
      const made = [];
      for (let i = 0; i < 12; i += 1) made.push(await provider.createRecord({ title: `idea ${i}` }));
      const queue = () => queueHits(made.map((r, i) => ({ handle: r.handle, score: 1 - i / 100 })));

      queue();
      assert.equal((await provider.recall('q')).length, 10, 'default');

      for (const bad of [0, -5, 'x', null, 1.5e400]) {
        queue();
        assert.equal((await provider.recall('q', { limit: bad })).length, 10, `garbage ${String(bad)} → default`);
      }

      queue();
      assert.equal((await provider.recall('q', { limit: 3 })).length, 3);

      // Fetch bounds: floor at limit 1, cap at limit 100.
      seen.length = 0;
      queue();
      await provider.recall('q', { limit: 1 });
      assert.equal(seen.find((s) => s.path === '/memory/search').body.top_k, 20, 'MIN_FETCH floor, not limit*4');

      seen.length = 0;
      queue();
      await provider.recall('q', { limit: 100 });
      assert.equal(seen.find((s) => s.path === '/memory/search').body.top_k, 200, 'TOP_K_CAP');
    });
  });

  test('every recall pins channel_weights:{} and carries the workspace', async () => {
    await withProvider(async ({ provider, queueHits, seen }) => {
      const rec = await provider.createRecord({ title: 'x' });
      queueHits([{ handle: rec.handle, score: 1 }]);
      seen.length = 0;
      await provider.recall('q');
      const req = seen.find((s) => s.path === '/memory/search');
      assert.deepEqual(req.body.channel_weights, {},
        'without this the API key\'s recall profile can disable retrieval channels');
      assert.equal(req.workspace, 'ws-test');
    });
  });

  test('an edited record: we never reindex, and the payload is CURRENT', async () => {
    await withProvider(async ({ provider, queueHits, seen }) => {
      const rec = await provider.createRecord({ title: 'first title', body: 'first body' });
      seen.length = 0;
      await provider.updateRecord(rec.handle, { body: 'second body' });

      // The invariant that is actually true: no reindex call exists to make.
      assert.equal(seen.filter((s) => s.path.includes('reindex')).length, 0);
      assert.ok(seen.some((s) => s.method === 'PATCH' && s.body?.content?.includes('second body')),
        'content is rewritten on update');

      // Deliberately NOT asserting "the edited record is unfindable" — that is
      // false. Lexical channels see the new text; only the vector lags.
      assert.equal((await provider.getRecord(rec.handle)).body, 'second body');
      queueHits([{ handle: rec.handle, score: 0.5 }]);
      const [hit] = await provider.recall('anything');
      assert.equal(hit.record.body, 'second body', 'hits carry current state, not indexed state');
    });
  });
});
