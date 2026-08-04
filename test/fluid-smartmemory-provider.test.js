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
import http from 'node:http';

import { FluidConfigError, FluidRecordNotFound, CAP } from '../lib/fluid/provider.js';
import { SmartMemoryFluidProvider } from '../lib/fluid/smartmemory-provider.js';

const servers = [];
after(() => { for (const s of servers) s.close(); });

/**
 * A minimal but honest SmartMemory. Items live in a Map keyed by item_id.
 * `clock` makes the server-stamped created_at deterministic and orderable.
 */
function makeServer() {
  const items = new Map();
  const seen = [];
  let nextId = 1;
  let clock = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      const [path, query] = req.url.split('?');
      seen.push({ path, query, method: req.method, body: parsed, workspace: req.headers['x-workspace-id'] });

      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (path === '/memory/add' && req.method === 'POST') {
        const id = `item-${nextId += 1}`;
        clock += 1;
        items.set(id, {
          item_id: id,
          content: parsed.content,
          memory_type: parsed.memory_type,
          // The server stamps created_at itself, unconditionally, overwriting
          // anything the caller sent. This is what makes a flat record mapping
          // impossible to round-trip.
          metadata: { ...parsed.metadata, created_at: `2026-01-01T00:00:${String(clock).padStart(2, '0')}Z` },
        });
        return json(200, { id, status: 'created' }); // 200, not 201
      }

      if (path === '/memory/list' && req.method === 'GET') {
        const qs = new URLSearchParams(query || '');
        let all = [...items.values()];
        const k = qs.get('metadata_key');
        const v = qs.get('metadata_value');
        if (k) all = all.filter((it) => String(it.metadata?.[k]) === v);
        const offset = Number(qs.get('offset') ?? 0);
        const limit = Number(qs.get('limit') ?? 50);
        return json(200, { items: all.slice(offset, offset + limit), total: all.length, limit, offset });
      }

      const m = path.match(/^\/memory\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const item = items.get(id);
        if (!item) return json(404, { detail: 'not found' });
        if (req.method === 'GET') return json(200, item);
        if (req.method === 'DELETE') { items.delete(id); return json(200, { status: 'deleted', item_id: id }); }
        if (req.method === 'PATCH') {
          if (parsed.content !== undefined) item.content = parsed.content;
          if (parsed.metadata !== undefined) {
            // ONE-LEVEL spread, matching crud.py:1052 — NOT a deep merge, and
            // server-controlled keys are stripped from the caller's dict.
            const incoming = { ...parsed.metadata };
            delete incoming.created_at;
            delete incoming.memory_type;
            item.metadata = { ...item.metadata, ...incoming };
          }
          return json(200, { status: 'ok', item_id: id });
        }
      }
      return json(404, { detail: 'no route' });
    });
  });
  return { server, items, seen };
}

async function withProvider(fn, { workspaceId = 'ws-test' } = {}) {
  const { server, items, seen } = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  process.env.SM_FLUID_KEY = 'test-key';
  try {
    const provider = await new SmartMemoryFluidProvider().init('/tmp/does-not-matter', {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'SM_FLUID_KEY',
      workspaceId,
      timeoutMs: 5000,
    });
    await fn({ provider, items, seen });
  } finally {
    delete process.env.SM_FLUID_KEY;
    server.close();
  }
}

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
  test('declares storage capabilities only; semantic ones still throw', async () => {
    await withProvider(async ({ provider }) => {
      assert.ok(provider.has(CAP.RECORDS) && provider.has(CAP.EVENTS) && provider.has(CAP.LINKS));
      for (const cap of [CAP.RECALL, CAP.CHALLENGE, CAP.CONVICTION, CAP.CALIBRATION, CAP.CONTRADICTION]) {
        assert.equal(provider.has(cap), false, `${cap} must not be declared`);
      }
      await assert.rejects(() => provider.recall('anything'), /FluidCapabilityUnavailable|capability/i);
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
