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
    await fn({ provider, items, seen, queueHits });
  } finally {
    delete process.env.SM_FLUID_KEY;
    server.close();
  }
}
