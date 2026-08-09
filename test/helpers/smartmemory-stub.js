/**
 * test/helpers/smartmemory-stub.js — a raw node:http stub of SmartMemory's CRUD
 * routes, shared by every suite that exercises the SmartMemory fluid provider.
 *
 * Extracted from `test/fluid-smartmemory-provider.test.js` (COMP-FOH FOH-1 S02)
 * when the conformance suite needed the same wire contract
 * (COMP-FLUID-SEAM-GUARANTEES). Extracted rather than copied on purpose: THE
 * STUB IS THE WIRE CONTRACT, and a second copy would be a second opinion about
 * what the server does — drifting silently the first time either is corrected.
 *
 * It deliberately reproduces two server behaviours that broke earlier revisions
 * of the provider, so a regression to them fails a test:
 *   - it stamps its own `metadata.created_at` on every add
 *   - its PATCH metadata merge is a ONE-LEVEL spread, not a deep merge
 *
 * No express, no mocking library.
 */

import http from 'node:http';

import { SmartMemoryFluidProvider } from '../../lib/fluid/smartmemory-provider.js';

/** Servers opened by `withProvider`, closed by the importing suite's `after`. */
export const servers = [];

export function makeServer() {
  const items = new Map();
  const seen = [];
  let nextId = 1;
  let clock = 0;
  // SVC-ALLOC-1 counters and the SVC-LEASE-1 lease, modelled because the
  // provider's two correctness claims now rest on them: distinct handles under
  // concurrent creates, and no lost update. A stub without them would let the
  // conformance suite's concurrency cases pass against nothing.
  const sequences = new Map();
  const locks = new Map();
  let nextToken = 1;

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

      // Recall (FOH-2). `hits` is set per-test so ranking and filtering are
      // testable without a real embedding model. The stub echoes whatever the
      // test queued, in order — the provider must not reorder survivors.
      if (path === '/memory/search' && req.method === 'POST') {
        return json(200, { results: server.__hits ?? [] });
      }

      // Challenge (FOH-3). Models SmartMemory's contradiction endpoint AND its
      // load-bearing behaviour: `memory_type` is an EXACT filter (search.py:123),
      // so a queued conflict only survives when the item it references is stored
      // under the requested type. `has_conflicts`/`overall_confidence` are the
      // server's PRE-filter aggregates (challenger.py:232-262) — the provider is
      // expected to IGNORE them and recompute after its own fluid_ns/self filter.
      if (path === '/memory/reasoning/challenge' && req.method === 'POST') {
        const wantType = parsed?.memory_type;
        const kept = (server.__conflicts ?? []).filter((c) => {
          const it = items.get(c.existing_item_id);
          return it && it.memory_type === wantType; // the exact-type filter
        });
        const overall = kept.length
          ? Math.max(0, 1 - (kept.reduce((s, c) => s + (c.confidence ?? 0), 0) / kept.length) * 0.5)
          : 1.0;
        return json(200, {
          new_assertion: parsed?.assertion ?? '',
          has_conflicts: kept.length > 0,
          conflicts: kept,
          related_facts_count: kept.length,
          overall_confidence: overall,
        });
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

      // ── SVC-ALLOC-1: monotonic sequences ─────────────────────────────────
      //
      // `$max` then `$inc`, in that order and as two statements — the same shape
      // as sequence.py, whose module docstring records that Mongo rejects both
      // on one path. Atomic here for free: Node runs this handler to completion
      // before touching the next request, which is exactly the property the real
      // allocator buys with `findOneAndUpdate`.
      const seqNext = path.match(/^\/memory\/sequences\/([^/]+)\/next$/);
      if (seqNext && req.method === 'POST') {
        const name = decodeURIComponent(seqNext[1]);
        let value = sequences.get(name) ?? 0;
        if (typeof parsed?.floor === 'number') value = Math.max(value, parsed.floor);
        const count = parsed?.count ?? 1;
        const first = value + 1;
        value += count;
        sequences.set(name, value);
        return json(200, { name, value, first, count });
      }
      const seqPeek = path.match(/^\/memory\/sequences\/([^/]+)$/);
      if (seqPeek && req.method === 'GET') {
        const name = decodeURIComponent(seqPeek[1]);
        if (!sequences.has(name)) {
          return json(404, { detail: { reason: 'sequence_not_found', name } });
        }
        return json(200, { name, value: sequences.get(name) });
      }

      // ── SVC-LEASE-1: scoped renewable leases ─────────────────────────────
      //
      // The 409 bodies are `{detail: {reason}}` on purpose: the SDK's LockAPI
      // treats ONLY a recognised reason as control flow and raises on anything
      // else, so a stub answering a bare 409 would make contention look like a
      // coordinator failure.
      const lockRenew = path.match(/^\/memory\/locks\/([^/]+)\/renew$/);
      const lockKeyM = path.match(/^\/memory\/locks\/([^/]+)$/);
      const leaseToken = req.headers['x-lease-token'];
      const held = (key) => {
        const lock = locks.get(key);
        if (lock && lock.expiresAt <= Date.now()) { locks.delete(key); return null; }
        return lock ?? null;
      };
      if (lockRenew && req.method === 'POST') {
        const key = decodeURIComponent(lockRenew[1]);
        const lock = held(key);
        if (!lock || lock.token !== leaseToken) {
          return json(409, { detail: { reason: 'not_owner' } });
        }
        const ttl = (parsed?.ttl_seconds ?? 30) * 1000;
        lock.expiresAt = Date.now() + ttl;
        return json(200, {
          key, token: lock.token,
          expires_at: new Date(lock.expiresAt).toISOString(), ttl_remaining_ms: ttl,
        });
      }
      if (lockKeyM && req.method === 'POST') {
        const key = decodeURIComponent(lockKeyM[1]);
        if (held(key)) return json(409, { detail: { reason: 'lock_held' } });
        const ttl = (parsed?.ttl_seconds ?? 30) * 1000;
        const token = `lease-${nextToken += 1}`;
        locks.set(key, { token, expiresAt: Date.now() + ttl });
        return json(200, {
          key, token,
          expires_at: new Date(Date.now() + ttl).toISOString(), ttl_remaining_ms: ttl,
        });
      }
      if (lockKeyM && req.method === 'DELETE') {
        const key = decodeURIComponent(lockKeyM[1]);
        const lock = held(key);
        if (!lock || lock.token !== leaseToken) {
          return json(409, { detail: { reason: 'not_owner' } });
        }
        locks.delete(key);
        return json(200, { key, released: true });
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

export async function withProvider(fn, { workspaceId = 'ws-test' } = {}) {
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
    // Queue search hits for a recall test: takes the live items for the given
    // handles, so a hit's payload is whatever the store actually holds.
    const queueHits = (specs) => {
      server.__hits = specs.map(({ handle, score, item }) => {
        const found = item ?? [...items.values()].find(
          (i) => i.metadata?.handle === handle && i.metadata?.fluid_ns === 'compose.fluid.v1',
        );
        return { ...found, score };
      });
    };
    // Queue conflicts for a challenge test. Each spec references a stored item by
    // `handle` (resolved to its item_id) so the stub's exact-type filter and the
    // provider's item_id→handle mapping both run against real stored items.
    const queueConflicts = (specs) => {
      server.__conflicts = specs.map(({ handle, itemId, ...rest }) => {
        // Resolve to the RECORD item, not the event item — both share a handle.
        const id = itemId ?? [...items.values()].find(
          (i) => i.metadata?.handle === handle && i.metadata?.fluid_ns === 'compose.fluid.v1',
        )?.item_id;
        return {
          existing_item_id: id,
          existing_fact: rest.existingFact ?? '',
          new_fact: rest.newFact ?? '',
          conflict_type: rest.conflictType ?? 'direct_contradiction',
          confidence: rest.confidence ?? 0.8,
          explanation: rest.explanation ?? '',
          suggested_resolution: rest.suggestedResolution ?? 'keep_existing',
        };
      });
    };
    await fn({ provider, items, seen, queueHits, queueConflicts });
  } finally {
    delete process.env.SM_FLUID_KEY;
    server.close();
  }
}
