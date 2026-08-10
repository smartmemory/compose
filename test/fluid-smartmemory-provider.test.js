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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAP,
  CONVICTION_STRATEGIES,
  FluidConfigError,
  FluidInvalidStrategy,
  FluidKindUnsupported,
  FluidRecordNotFound,
  FluidResolutionConflict,
  FluidResolutionIndeterminate,
  FluidResolutionNoOp,
} from '../lib/fluid/provider.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { assertValid } from '../lib/fluid/schema.js';
import { SmartMemoryFluidProvider } from '../lib/fluid/smartmemory-provider.js';
import { challengeIdea, convictionOf, resolveIdeaChallenge, IdeaboxNotFound } from '../lib/fluid/ideabox-ops.js';
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
  // FOH-2 added RECALL; FOH-3 CHALLENGE; FOH-4 CONVICTION; FOH-5 CONTRADICTION.
  // CALIBRATION alone stays undeclared (no subject exists) and keeps inheriting
  // the base class's refusal — a capability and its impl move together.
  test('declares storage + RECALL + CHALLENGE + CONVICTION + CONTRADICTION; CALIBRATION still throws', async () => {
    await withProvider(async ({ provider }) => {
      assert.ok(provider.has(CAP.RECORDS) && provider.has(CAP.EVENTS) && provider.has(CAP.LINKS));
      assert.ok(provider.has(CAP.RECALL), 'FOH-2 declares RECALL');
      assert.ok(provider.has(CAP.CHALLENGE), 'FOH-3 declares CHALLENGE');
      assert.ok(provider.has(CAP.CONVICTION), 'FOH-4 declares CONVICTION');
      assert.ok(provider.has(CAP.CONTRADICTION), 'FOH-5 declares CONTRADICTION');
      assert.equal(provider.has(CAP.CALIBRATION), false, 'CALIBRATION must not be declared');
      // The still-undeclared capability inherits the base refusal.
      await assert.rejects(() => provider.calibration('all'), /FluidCapabilityUnavailable|capability/i);
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

describe('SmartMemoryFluidProvider — challenge (FOH-3)', () => {
  // These pin the PROVIDER's contract: exact-type send, fluid-namespace + self
  // filtering, and retained-only aggregates. Actual contradiction DETECTION is
  // SmartMemory's own responsibility (and its suite's) — the stub, like the
  // recall stub, returns queued conflicts rather than running a detector. The
  // negation-pair text documents the intended real-world shape; it is not what
  // the stub keys on (the stub keys on the exact memory_type).
  async function seedContradiction(provider) {
    const a = await provider.createRecord({ kind: 'decision', title: 'Postgres is the datastore' });
    const b = await provider.createRecord({ kind: 'decision', title: 'Postgres is not the datastore' });
    const idea = await provider.createRecord({ kind: 'idea', title: 'Postgres is not the datastore' });
    return { a, b, idea };
  }

  test('the floor provider without CHALLENGE refuses', async () => {
    const floor = new LocalFluidProvider();
    await floor.init(mkdtempSync(join(tmpdir(), 'fluid-challenge-')), {});
    await assert.rejects(() => floor.challenge('IDEA-1'), /FluidCapabilityUnavailable|capability/i);
  });

  test('golden: a decision is challenged against another decision, self excluded', async () => {
    await withProvider(async ({ provider, items, queueConflicts, seen }) => {
      const { a, b, idea } = await seedContradiction(provider);
      // Queue B (decision) AND the idea AND A itself as candidate conflicts.
      queueConflicts([
        { handle: b.handle, existingFact: 'Postgres is not the datastore', confidence: 0.9 },
        { handle: idea.handle, existingFact: 'idea says otherwise', confidence: 0.9 },
        { handle: a.handle, existingFact: 'self', confidence: 0.9 },
      ]);
      const result = await provider.challenge(a.handle, { useLlm: false });

      assert.equal(result.hasConflicts, true);
      assert.deepEqual(result.conflicts.map((c) => c.handle), [b.handle],
        'only the same-kind (decision) conflict survives; idea filtered by exact-type, self excluded');
      assert.equal(result.conflicts[0].conflictType, 'direct_contradiction');
      // The wrapper sent the record's EXACT wire type, and use_llm:false.
      const sent = seen.find((s) => s.path === '/memory/reasoning/challenge');
      assert.equal(sent.body.memory_type, 'fluid_decision');
      assert.equal(sent.body.use_llm, false);
    });
  });

  test('D1c: aggregates are recomputed from retained conflicts, not the server total', async () => {
    await withProvider(async ({ provider, items, queueConflicts }) => {
      const { a } = await seedContradiction(provider);
      // A non-fluid item typed fluid_decision (passes the server exact-type
      // filter) but WITHOUT our namespace — the provider must drop it (D1a) and
      // then report hasConflicts:false, confidence:1.0 (D1c), NOT the server's
      // has_conflicts:true.
      const foreignId = 'item-foreign';
      items.set(foreignId, {
        item_id: foreignId, content: 'foreign', memory_type: 'fluid_decision',
        metadata: { fluid_ns: 'someone.else', handle: 'X-1' },
      });
      queueConflicts([{ itemId: foreignId, existingFact: 'foreign', confidence: 0.9 }]);
      const result = await provider.challenge(a.handle, { useLlm: false });
      assert.equal(result.hasConflicts, false, 'a fully-filtered result is not "true with no conflicts"');
      assert.deepEqual(result.conflicts, []);
      assert.equal(result.confidence, 1.0, 'confidence derived from the retained (empty) set');
    });
  });

  test('D1c: with one retained + one filtered conflict, confidence reflects ONLY the retained', async () => {
    await withProvider(async ({ provider, items, queueConflicts }) => {
      const { a, b } = await seedContradiction(provider);
      // A foreign fluid_decision (dropped by D1a) with a LOW confidence, and the
      // real same-kind conflict B with a distinct confidence. If aggregates came
      // from the raw set, the mean — and thus `confidence` — would differ.
      const foreignId = 'item-foreign';
      items.set(foreignId, {
        item_id: foreignId, content: 'foreign', memory_type: 'fluid_decision',
        metadata: { fluid_ns: 'someone.else', handle: 'X-1' },
      });
      queueConflicts([
        { handle: b.handle, existingFact: 'kept', confidence: 0.6 },
        { itemId: foreignId, existingFact: 'dropped', confidence: 0.2 },
      ]);
      const result = await provider.challenge(a.handle, { useLlm: false });
      assert.deepEqual(result.conflicts.map((c) => c.handle), [b.handle]);
      // Formula over the RETAINED set {0.6}: 1 - (0.6 * 0.5) = 0.7. The raw-set
      // mean {0.6,0.2}=0.4 would give 0.8 — so this pins retained-only.
      assert.equal(result.confidence, 0.7);
    });
  });

  test('empty/sparse corpus: no conflicts', async () => {
    await withProvider(async ({ provider, queueConflicts }) => {
      const a = await provider.createRecord({ kind: 'decision', title: 'a lone decision' });
      queueConflicts([]);
      const result = await provider.challenge(a.handle, { useLlm: false });
      assert.equal(result.hasConflicts, false);
      assert.deepEqual(result.conflicts, []);
      assert.equal(result.confidence, 1.0);
    });
  });

  test('every non-challengeable kind (thread, question, cluster) throws FluidKindUnsupported', async () => {
    await withProvider(async ({ provider }) => {
      for (const kind of ['thread', 'question', 'cluster']) {
        const rec = await provider.createRecord({ kind, title: `a ${kind}` });
        await assert.rejects(
          () => provider.challenge(rec.handle, { useLlm: false }), FluidKindUnsupported,
          `${kind} must be refused`,
        );
      }
    });
  });

  test('an unknown handle throws FluidRecordNotFound', async () => {
    await withProvider(async ({ provider }) => {
      await assert.rejects(() => provider.challenge('DECISION-999', { useLlm: false }), FluidRecordNotFound);
    });
  });

  // ── consumer: challengeIdea (FOH-3 D2) ──────────────────────────────────────
  test('challengeIdea resolves a decision kind-agnostically and case-insensitively', async () => {
    await withProvider(async ({ provider, queueConflicts }) => {
      const { a, b } = await seedContradiction(provider);
      queueConflicts([{ handle: b.handle, existingFact: 'contradiction', confidence: 0.8 }]);
      // lowercase id must resolve the same record (parity with the other ops).
      const result = await challengeIdea({ provider }, a.handle.toLowerCase(), { useLlm: false });
      assert.equal(result.hasConflicts, true);
      assert.deepEqual(result.conflicts.map((c) => c.handle), [b.handle]);
    });
  });

  test('challengeIdea maps an unknown id to IdeaboxNotFound', async () => {
    await withProvider(async ({ provider }) => {
      await assert.rejects(() => challengeIdea({ provider }, 'DECISION-999'), IdeaboxNotFound);
    });
  });
});

describe('SmartMemoryFluidProvider — conviction (FOH-4)', () => {
  // A ctx whose ideaboxPath does not exist: the migration gate is a clean
  // no-op, which is what lets consumer tests run against the raw provider.
  const ctxFor = (provider) => ({ provider, ideaboxPath: join(tmpdir(), 'no-such-ideabox.md') });

  async function seedPair(provider) {
    const a = await provider.createRecord({ kind: 'decision', title: 'Postgres is the datastore' });
    const b = await provider.createRecord({ kind: 'decision', title: 'Postgres is not the datastore' });
    return { a, b };
  }

  test('base provider refuses conviction AND resolveConflict with FluidCapabilityUnavailable', async () => {
    const floor = new LocalFluidProvider();
    await floor.init(mkdtempSync(join(tmpdir(), 'fluid-conviction-')), {});
    await assert.rejects(() => floor.conviction('IDEA-1'), /FluidCapabilityUnavailable|capability/i);
    await assert.rejects(
      () => floor.resolveConflict('IDEA-1', 'IDEA-2', { strategy: 'accept_new' }),
      /FluidCapabilityUnavailable|capability/i,
      'the base seam must refuse resolveConflict typed, not TypeError',
    );
  });

  test('read on a never-resolved record: honest 1.0, empty history, ONE wire call — no getItem', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a } = await seedPair(provider);
      seen.length = 0;
      const result = await provider.conviction(a.handle);
      assert.deepEqual(result, {
        handle: a.handle, confidence: 1.0, challenged: false,
        challengeCount: 0, lastChallengedAt: null, history: [],
      });
      const wire = seen.filter((s) => s.path.startsWith('/memory/') && !s.path.includes('/list'));
      assert.deepEqual(wire.map((s) => s.path.includes('confidence-history')), [true],
        'exactly one confidence-history call and NO getItem in the read path');
    });
  });

  test('golden loop: challenge → resolve accept_new → conviction reflects the decay', async () => {
    await withProvider(async ({ provider, queueConflicts, seen }) => {
      const { a, b } = await seedPair(provider);
      queueConflicts([{ handle: b.handle, existingFact: 'Postgres is not the datastore', confidence: 0.9 }]);
      const challenge = await challengeIdea(ctxFor(provider), a.handle, { useLlm: false });
      assert.equal(challenge.conflicts[0].handle, b.handle);

      seen.length = 0;
      const resolved = await resolveIdeaChallenge(ctxFor(provider), a.handle, {
        against: challenge.conflicts[0].handle, strategy: 'accept_new',
      });

      assert.equal(resolved.handle, b.handle);
      assert.equal(resolved.confidence, 0.5);
      assert.equal(resolved.challenged, true);
      assert.equal(resolved.challengeCount, 1);
      assert.ok(resolved.lastChallengedAt, 'lastChallengedAt derives from the newest event');
      assert.equal(resolved.history.length, 1);
      assert.equal(resolved.history[0].newConfidence, 0.5);
      assert.equal(resolved.history[0].oldConfidence, 1.0);

      // Wire contract: the flags flip, and new_fact is A's RENDERED content —
      // never caller text.
      const sent = seen.find((s) => s.path === '/memory/reasoning/resolve');
      assert.equal(sent.body.auto_resolve, false);
      assert.equal(sent.body.use_llm, false);
      assert.equal(sent.body.use_wikipedia, false);
      assert.equal(sent.body.strategy, 'accept_new');
      assert.ok(sent.body.new_fact.includes('Postgres is the datastore'),
        'new_fact is derived from the SOURCE record content');

      // The lease brackets the mutation: acquire before /resolve, release after.
      const order = seen.map((s) => s.path);
      const lockIdx = order.findIndex((p) => p.includes('/memory/locks/'));
      const resolveIdx = order.indexOf('/memory/reasoning/resolve');
      assert.ok(lockIdx !== -1 && lockIdx < resolveIdx, 'workspace lease acquired before the mutation');

      // And the read path agrees afterwards.
      const conviction = await convictionOf(ctxFor(provider), b.handle);
      assert.equal(conviction.confidence, 0.5);
      assert.equal(conviction.challengeCount, 1);
    });
  });

  test('a second intentional resolve decays again: 0.5 → 0.0, and the floor case still succeeds', async () => {
    await withProvider(async ({ provider, queueConflicts }) => {
      const { a, b } = await seedPair(provider);
      const first = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(first.confidence, 0.5);
      const second = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(second.confidence, 0.0, 'cumulative decay');
      // 0.0 floor: expected = max(0, 0-0.5) = 0 — count advances, confidence
      // stays, and the exact-value postcondition still recognizes success.
      const third = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(third.confidence, 0.0);
      assert.equal(third.challengeCount, 3);
    });
  });

  test('strategy gate: everything except accept_new is refused BEFORE any wire call', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a, b } = await seedPair(provider);
      seen.length = 0;
      for (const strategy of ['keep_existing', 'keep_both', 'defer', 'merge', 'nonsense', undefined]) {
        await assert.rejects(
          () => provider.resolveConflict(a.handle, b.handle, { strategy }),
          FluidInvalidStrategy, `${strategy} must be refused`,
        );
      }
      assert.equal(seen.filter((s) => s.path === '/memory/reasoning/resolve').length, 0,
        'no /resolve call was made for any refused strategy');
    });
  });

  test('provider-seam authorization: kind mismatch, self-target, unknown handles — all pre-mutation', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a, b } = await seedPair(provider);
      const idea = await provider.createRecord({ kind: 'idea', title: 'an idea, not a decision' });
      const thread = await provider.createRecord({ kind: 'thread', title: 'not challengeable' });

      seen.length = 0;
      await assert.rejects(
        () => provider.resolveConflict(a.handle, idea.handle, { strategy: 'accept_new' }),
        FluidKindUnsupported, 'cross-kind target refused',
      );
      await assert.rejects(
        () => provider.resolveConflict(thread.handle, b.handle, { strategy: 'accept_new' }),
        FluidKindUnsupported, 'non-challengeable source refused',
      );
      await assert.rejects(
        () => provider.resolveConflict(a.handle, a.handle, { strategy: 'accept_new' }),
        /FluidInvalidTarget|self-target/, 'self-decay refused',
      );
      await assert.rejects(
        () => provider.resolveConflict(a.handle, 'DECISION-999', { strategy: 'accept_new' }),
        FluidRecordNotFound,
      );
      await assert.rejects(
        () => provider.resolveConflict('DECISION-999', b.handle, { strategy: 'accept_new' }),
        FluidRecordNotFound,
      );
      assert.equal(seen.filter((s) => s.path === '/memory/reasoning/resolve').length, 0,
        'no /resolve call for any refused pairing');
    });
  });

  test('a corrupt record blob refuses typed, not TypeError', async () => {
    await withProvider(async ({ provider, items, seen }) => {
      const { a } = await seedPair(provider);
      const corruptId = 'item-corrupt';
      items.set(corruptId, {
        item_id: corruptId, content: 'x', memory_type: 'fluid_decision', confidence: 1.0,
        metadata: { fluid_ns: 'compose.fluid.v1', handle: 'DECISION-77', fluid_record_json: '{not json' },
      });
      seen.length = 0;
      await assert.rejects(
        () => provider.resolveConflict(a.handle, 'DECISION-77', { strategy: 'accept_new' }),
        FluidRecordNotFound, 'corrupt target blob → typed refusal',
      );
      assert.equal(seen.filter((s) => s.path === '/memory/reasoning/resolve').length, 0);
    });
  });

  test('clean 200 that persisted nothing → FluidResolutionNoOp (the ONLY retryable failure)', async () => {
    await withProvider(async ({ provider, items }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'no-op';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionNoOp,
      );
      // Nothing moved.
      const bItem = [...items.values()].find((i) => i.metadata?.handle === b.handle && i.metadata?.fluid_ns === 'compose.fluid.v1');
      assert.equal(bItem.confidence, 1.0);
    });
  });

  test('count advanced but by someone else (unattributed) → FluidResolutionConflict, never our success', async () => {
    await withProvider(async ({ provider }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'unattributed';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionConflict,
        'numerically identical foreign decay must not be mistaken for ours',
      );
    });
  });

  test('two decays interleaved (count jump) → FluidResolutionConflict', async () => {
    await withProvider(async ({ provider }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'count-jump';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionConflict,
      );
    });
  });

  test('malformed 2xx (proxy error page) hiding a REAL mutation → reconciled success, never NoOp', async () => {
    await withProvider(async ({ provider }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      // The origin decay succeeds; a proxy replaces the response with HTML.
      // The provider must treat the 200-that-isn't-JSON as ambiguous, poll,
      // positively recognize OUR landed decay, and return success.
      server.__resolveMode = 'malformed-mutate';
      const result = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(result.confidence, 0.5, 'reconciliation poll recognized the landed decay as success');
      assert.equal(result.challengeCount, 1);
    });
  });

  test('malformed 2xx with NO mutation → Indeterminate (a broken proxy is never a retryable no-op)', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'malformed';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionIndeterminate,
      );
      assert.equal(seen.filter((s) => s.path === '/memory/reasoning/resolve').length, 1, 'no retry');
    });
  });

  test('gateway 502 with NO mutation → FluidResolutionIndeterminate, never NoOp/retry', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'gateway-502';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionIndeterminate,
        'a 5xx does not prove the origin handler stopped — unchanged reads are NOT a retryable no-op',
      );
      assert.equal(seen.filter((s) => s.path === '/memory/reasoning/resolve').length, 1,
        'the provider NEVER retries /resolve on an ambiguous outcome');
    });
  });

  test('timeout, mutation lands late → the poll positively confirms it and returns success', async () => {
    await withProvider(async ({ provider }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'mutate-late';
      server.__resolveLateMs = 120; // lands after the 60ms abort, before the poll window ends
      const result = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new', timeoutMs: 60 });
      assert.equal(result.confidence, 0.5,
        'a verified-landed mutation is a success even though its HTTP response died');
      assert.equal(result.challengeCount, 1);
    });
  });

  test('timeout, mutation never observed → FluidResolutionIndeterminate and NO /resolve retry', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'mutate-late';
      server.__resolveLateMs = 60_000; // never lands within the poll window
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new', timeoutMs: 60 }),
        FluidResolutionIndeterminate,
      );
      assert.equal(seen.filter((s) => s.path === '/memory/reasoning/resolve').length, 1,
        'an unchanged read after an abort is "not yet", never "safe to retry"');
    });
  });

  test('attribution truncation is code-point exact: an astral char at the 200 boundary still lands', async () => {
    await withProvider(async ({ provider }) => {
      // 199 ascii chars + an emoji straddling the boundary: Python [:200] keeps
      // the whole emoji (1 code point); JS slice(0,200) would cut it in half.
      const title = `${'x'.repeat(199)}😀 and more text past the boundary`;
      const a = await provider.createRecord({ kind: 'decision', title });
      const b = await provider.createRecord({ kind: 'decision', title: 'contradicts the long one' });
      const result = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(result.confidence, 0.5,
        'code-point truncation matches the server; a UTF-16 slice would misclassify this landed decay');
    });
  });

  // ── consumers: convictionOf / resolveIdeaChallenge ────────────────────────
  test('consumers run the migration gate and map not-found; against is required', async () => {
    await withProvider(async ({ provider }) => {
      const { a } = await seedPair(provider);
      await assert.rejects(() => convictionOf(ctxFor(provider), 'DECISION-999'), IdeaboxNotFound);
      await assert.rejects(
        () => resolveIdeaChallenge(ctxFor(provider), a.handle, { strategy: 'accept_new' }),
        /against is required/,
      );
      // Case-insensitive resolve, like every other op.
      const result = await convictionOf(ctxFor(provider), a.handle.toLowerCase());
      assert.equal(result.confidence, 1.0);
    });
  });

  test('consumer golden: migrate-then-operate on a markdown-only project — read AND resolve', async () => {
    await withProvider(async ({ provider }) => {
      // A markdown ideabox that has never been migrated: BOTH consumers must
      // migrate first and then answer, not report not-found. The resolve half
      // is the one that mutates, so its gate coverage is the load-bearing one.
      const dir = mkdtempSync(join(tmpdir(), 'foh4-md-'));
      const ideaboxPath = join(dir, 'ideabox.md');
      writeFileSync(ideaboxPath, [
        '# Ideabox', '',
        '## Ideas', '',
        '#### IDEA-1 — ship the feature now',
        '**Status:** NEW | **Priority:** P1 | **Tags:** test',
        '**Idea:** ship the feature now', '',
        '#### IDEA-2 — never ship the feature',
        '**Status:** NEW | **Priority:** P1 | **Tags:** test',
        '**Idea:** never ship the feature', '',
      ].join('\n'));
      const ctx = { provider, ideaboxPath };
      // RESOLVE FIRST, on the never-migrated project: this is the assertion
      // that the mutating consumer gates for itself. (Reading first would
      // migrate as a side effect and prove nothing about the resolve path.)
      const resolved = await resolveIdeaChallenge(ctx, 'IDEA-1', { against: 'IDEA-2', strategy: 'accept_new' });
      assert.equal(resolved.confidence, 0.5, 'migrate-then-RESOLVE: the mutating consumer gates for itself');
      assert.equal(resolved.handle, 'IDEA-2');
      const read = await convictionOf(ctx, 'IDEA-2');
      assert.equal(read.confidence, 0.5, 'the read consumer sees the resolved state');
    });
  });

  test('legacy bridge: a pre-fix item whose metadata.confidence is lower reads and decays from the LOWER value', async () => {
    await withProvider(async ({ provider, items }) => {
      const { a, b } = await seedPair(provider);
      // A record decayed under the OLD metadata-only path: field still 1.0,
      // metadata carrying the real 0.4. The real service's _effective_confidence
      // honours the lower value — reading 1.0 would resurrect a dead belief.
      const bItem = [...items.values()].find((i) => i.metadata?.handle === b.handle && i.metadata?.fluid_ns === 'compose.fluid.v1');
      bItem.metadata.confidence = 0.4;
      const read = await provider.conviction(b.handle);
      assert.equal(read.confidence, 0.4, 'the legacy metadata value wins when lower');
      const resolved = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(resolved.confidence, 0, 'decay computes from 0.4 → max(0, 0.4-0.5) = 0, not from the stale field');
    });
  });

  test('partial write (the stale-runtime shape: count moves, confidence does not) → Indeterminate, never success', async () => {
    await withProvider(async ({ provider }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'partial-write';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionIndeterminate,
        'the exact-confidence clause is the guard that catches a pre-fix runtime',
      );
    });
  });

  test('authoritative 404 from /resolve → typed not-found, NO reconciliation poll', async () => {
    await withProvider(async ({ provider, seen }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = '404';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidRecordNotFound,
        'a real 4xx is a pre-mutation rejection, surfaced typed',
      );
      const historyReads = seen.filter((s) => s.path.includes('confidence-history')).length;
      assert.equal(historyReads, 1, 'only the pre-read — an authoritative rejection is never reconciled');
    });
  });

  test('reconciliation reads that FAIL are failed attempts, and the window exhausts to Indeterminate', async () => {
    await withProvider(async ({ provider }) => {
      const { a, b } = await seedPair(provider);
      const server = servers[servers.length - 1];
      server.__resolveMode = 'gateway-502';
      server.__historyFailAfter = 1; // pre-read succeeds; every poll read 500s
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionIndeterminate,
        'a failing reconciliation read never surfaces as its own error and never becomes a retry',
      );
    });
  });

  test('the strategy allowlist is genuinely immutable (a frozen Set would still accept .add)', () => {
    assert.throws(() => { CONVICTION_STRATEGIES.push('defer'); }, TypeError);
    assert.deepEqual([...CONVICTION_STRATEGIES], ['accept_new']);
  });
});

describe('SmartMemoryFluidProvider — contradiction (FOH-5)', () => {
  const srv = () => servers[servers.length - 1];
  const idOf = (items, handle) => [...items.values()].find(
    (i) => i.metadata?.handle === handle && i.metadata?.fluid_ns === 'compose.fluid.v1',
  )?.item_id;
  const contradicts = (edges, src, tgt) => edges.filter(
    (e) => e.edge_type === 'CONTRADICTS' && e.source_id === src && e.target_id === tgt,
  );

  async function seedPair(provider) {
    const a = await provider.createRecord({ kind: 'decision', title: 'Postgres is the datastore' });
    const b = await provider.createRecord({ kind: 'decision', title: 'Postgres is not the datastore' });
    return { a, b };
  }

  test('base provider refuses contradictions with FluidCapabilityUnavailable', async () => {
    const floor = new LocalFluidProvider();
    await floor.init(mkdtempSync(join(tmpdir(), 'fluid-contra-')), {});
    await assert.rejects(() => floor.contradictions('IDEA-1'), /FluidCapabilityUnavailable|capability/i);
  });

  test('the smartmemory provider now declares CONTRADICTION', async () => {
    await withProvider(async ({ provider }) => {
      assert.ok(provider.capabilities().has(CAP.CONTRADICTION), 'CAP.CONTRADICTION is declared');
    });
  });

  test('golden loop: a landed resolve writes a CONTRADICTS edge, and contradictions(target) resolves it back', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const aId = idOf(items, a.handle);
      const bId = idOf(items, b.handle);

      const res = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(res.confidence, 0.5);
      assert.equal(contradicts(edges, aId, bId).length, 1, 'one CONTRADICTS edge source -> target');

      const hits = await provider.contradictions(b.handle);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].handle, a.handle);
      assert.equal(hits[0].kind, 'decision');
      assert.equal(hits[0].record.handle, a.handle, 'the record agrees with getRecord(handle)');
      assert.ok(hits[0].record.title.includes('Postgres is the datastore'));

      // The source itself has no INCOMING contradictions.
      assert.deepEqual(await provider.contradictions(a.handle), []);
    });
  });

  test('the RECONCILIATION landed-exit also links, not only the clean path (review H2)', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const aId = idOf(items, a.handle);
      const bId = idOf(items, b.handle);
      // 200 + HTML but the mutation lands: the provider confirms via the poll.
      srv().__resolveMode = 'malformed-mutate';
      const res = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(res.confidence, 0.5, 'landed via the reconciliation poll');
      assert.equal(contradicts(edges, aId, bId).length, 1, 'a reconciled landed resolve is ALSO linked');
      assert.equal((await provider.contradictions(b.handle)).length, 1);
    });
  });

  test('no edge on a no-op, and none on an indeterminate outcome', async () => {
    await withProvider(async ({ provider, edges }) => {
      const { a, b } = await seedPair(provider);
      srv().__resolveMode = 'no-op';
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionNoOp,
      );
      assert.equal(edges.length, 0, 'a no-op writes no contradiction edge');
    });
    await withProvider(async ({ provider, edges }) => {
      const { a, b } = await seedPair(provider);
      srv().__resolveMode = 'gateway-502';
      srv().__historyFailAfter = 1;
      await assert.rejects(
        () => provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' }),
        FluidResolutionIndeterminate,
      );
      assert.equal(edges.length, 0, 'an indeterminate outcome writes no edge');
    });
  });

  test('idempotency: a second landed resolve does not add a second edge (review M5)', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const aId = idOf(items, a.handle);
      const bId = idOf(items, b.handle);
      await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(contradicts(edges, aId, bId).length, 1, 'MERGE semantics: one edge, not two');
      assert.equal((await provider.contradictions(b.handle)).length, 1);
    });
  });

  test('a deceptive 200 with edge_created:false is a FAILED write: resolve still succeeds, no edge, contradictions under-reports (review H1)', async () => {
    await withProvider(async ({ provider, edges }) => {
      const { a, b } = await seedPair(provider);
      srv().__edgeMode = 'not-created';
      const res = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(res.confidence, 0.5, 'the decay still succeeded — the link is best-effort');
      assert.equal(edges.length, 0, 'edge_created:false stored no edge');
      assert.deepEqual(await provider.contradictions(b.handle), [],
        'contradictions() is a lower bound: it under-reports the pair whose link was abandoned');
    });
  });

  test('a hard edge-write failure never fails the resolution (best-effort epilogue)', async () => {
    await withProvider(async ({ provider, edges }) => {
      const { a, b } = await seedPair(provider);
      srv().__edgeMode = 'fail';
      const res = await provider.resolveConflict(a.handle, b.handle, { strategy: 'accept_new' });
      assert.equal(res.confidence, 0.5, 'the resolution outcome is returned despite the link failing');
      assert.equal(edges.length, 0);
    });
  });

  test('canonical-handle rule: a CONTRADICTS edge from a LATER duplicate of the source yields no hit (review M4)', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const canonical = [...items.values()].find(
        (i) => i.metadata?.handle === a.handle && i.metadata?.fluid_ns === 'compose.fluid.v1',
      );
      const bId = idOf(items, b.handle);
      // A pre-SVC-ALLOC-1 workspace can hold a duplicate handle: forge a LATER one.
      const dupId = 'item-dup-later';
      items.set(dupId, {
        item_id: dupId,
        content: canonical.content,
        memory_type: canonical.memory_type,
        confidence: 1.0,
        metadata: { ...canonical.metadata, created_at: '2026-12-31T23:59:59Z' },
      });
      edges.push({ source_id: dupId, target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      assert.deepEqual(await provider.contradictions(b.handle), [],
        'the later duplicate is not the canonical item for its handle, so it is skipped');

      // The canonical item's own edge DOES produce exactly one hit.
      edges.push({ source_id: canonical.item_id, target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      const hits = await provider.contradictions(b.handle);
      assert.equal(hits.length, 1, 'canonical edge yields one hit; the duplicate stays skipped');
      assert.equal(hits[0].record.handle, a.handle);
    });
  });

  test('failure semantics: per-neighbour 404 and non-fluid neighbours are skipped (review M6)', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const aId = idOf(items, a.handle);
      const bId = idOf(items, b.handle);
      edges.push({ source_id: aId, target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      // A non-fluid item linked in — _fromItem rejects it, silently skipped.
      items.set('plain-1', { item_id: 'plain-1', content: 'not ours', memory_type: 'semantic', metadata: {} });
      edges.push({ source_id: 'plain-1', target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      // A ghost neighbour whose item is gone (deletion race) — injected, since a
      // dangling edge is dropped by the route's own hydration.
      srv().__extraNeighbors = [
        { item_id: 'ghost-9', content: 'x', memory_type: 'fluid_idea', link_type: 'CONTRADICTS', direction: 'incoming' },
      ];
      const hits = await provider.contradictions(b.handle);
      assert.equal(hits.length, 1, 'only the real fluid contradiction survives');
      assert.equal(hits[0].handle, a.handle);
    });
  });

  test('a parseable-but-schema-invalid neighbour blob is skipped, not emitted and not crash-inducing (post-impl review)', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const aId = idOf(items, a.handle);
      const bId = idOf(items, b.handle);
      edges.push({ source_id: aId, target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      // A namespaced fluid item whose blob parses but fails the record schema.
      // (a) missing kind/title → would be a malformed hit; (b) a handleless {}
      // blob would send undefined into _resolveOne and throw on the paired filter.
      items.set('bad-partial', {
        item_id: 'bad-partial', content: 'x', memory_type: 'fluid_idea',
        metadata: { fluid_ns: 'compose.fluid.v1', handle: 'IDEA-X', fluid_record_json: JSON.stringify({ handle: 'IDEA-X' }) },
      });
      items.set('bad-empty', {
        item_id: 'bad-empty', content: 'x', memory_type: 'fluid_idea',
        metadata: { fluid_ns: 'compose.fluid.v1', handle: 'IDEA-Y', fluid_record_json: '{}' },
      });
      edges.push({ source_id: 'bad-partial', target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      edges.push({ source_id: 'bad-empty', target_id: bId, edge_type: 'CONTRADICTS', properties: {} });

      const hits = await provider.contradictions(b.handle);
      assert.equal(hits.length, 1, 'only the schema-valid contradiction survives; invalid blobs are skipped, not thrown');
      assert.equal(hits[0].handle, a.handle);
    });
  });

  test('failure semantics: any OTHER neighbour fetch failure fails the whole read — no silent partial (review M6)', async () => {
    await withProvider(async ({ provider, items, edges }) => {
      const { a, b } = await seedPair(provider);
      const aId = idOf(items, a.handle);
      const bId = idOf(items, b.handle);
      edges.push({ source_id: aId, target_id: bId, edge_type: 'CONTRADICTS', properties: {} });
      srv().__getFail = new Set([aId]); // getItem(source) → 500
      await assert.rejects(
        () => provider.contradictions(b.handle),
        /HTTP 500/,
        'a non-404 fetch failure must throw, not return an apparently-complete partial',
      );
    });
  });

  test('the target-deletion race (resolve then vanish) maps to FluidRecordNotFound (review M7)', async () => {
    await withProvider(async ({ provider, items }) => {
      const { b } = await seedPair(provider);
      const bId = idOf(items, b.handle);
      srv().__neighbors404 = new Set([bId]); // resolves via /list, 404s on /neighbors
      await assert.rejects(() => provider.contradictions(b.handle), FluidRecordNotFound);
    });
  });

  test('unknown handle rejects; a record with no contradictions is an empty list', async () => {
    await withProvider(async ({ provider }) => {
      const { b } = await seedPair(provider);
      await assert.rejects(() => provider.contradictions('DECISION-999'), FluidRecordNotFound);
      assert.deepEqual(await provider.contradictions(b.handle), []);
    });
  });
});
