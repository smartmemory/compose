/**
 * smartmemory-client.js — COMP-SMARTMEMORY-INGEST S02, extended by COMP-FOH S01
 *
 * Raw HTTP client for the SmartMemory wire contract. Global `fetch` +
 * `AbortController` timeout. No SDK, no new dependency.
 *
 * Two families, deliberately kept apart:
 *   - `health`/`ingest`/`search` — the pipeline surface, shipped and in use.
 *   - `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem`/`searchItems` —
 *     typed-record CRUD plus workspace-scoped search over the generic MemoryItem
 *     routes, for callers that address items individually. These all send
 *     `X-Workspace-Id`; the pipeline surface above does not.
 *
 * Everything here speaks HTTP and nothing else. Domain mapping — what a record
 * is, how it is identified, how it serializes — belongs to the caller.
 */

/**
 * Thrown on non-2xx from ingest/search, OR on a 2xx whose body doesn't match
 * the expected shape (non-JSON, or missing the field the caller depends on —
 * `status` for ingest, `results` for search). The latter case sets
 * `kind: 'malformed-response'` so callers can tell "the service said no" from
 * "the service said something we can't trust" if they want to, while both
 * still surface as one failure type upstream (sync: `failed`; emitter:
 * counts toward the circuit breaker).
 */
export class SmartmemoryHttpError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = 'SmartmemoryHttpError';
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Build a client bound to a resolved config. The API key is read from
 * process.env[cfg.apiKeyEnv] at call time (missing ⇒ treated as unreachable).
 * @param {{ baseUrl: string, apiKeyEnv?: string, timeoutMs?: number, workspaceId?: string }} cfg
 *   `workspaceId`, when set, is sent as `X-Workspace-Id` on the CRUD methods.
 * @returns {{ health(): Promise<{ok:boolean,status?:number}>, ingest(content:string,ctx:object): Promise<{status:string,unchanged:boolean,raw:object}>, search(query:string,opts?:object): Promise<object>, createItem(input:object): Promise<object>, getItem(itemId:string): Promise<object|null>, listItems(opts?:object): Promise<object>, updateItem(itemId:string,patch:object): Promise<object>, deleteItem(itemId:string,opts?:object): Promise<object>, searchItems(query:string,opts?:object): Promise<object> }}
 */
export function createSmartmemoryClient(cfg) {
  const baseUrl = cfg.baseUrl;
  const timeoutMs = cfg.timeoutMs ?? 3000;

  async function withTimeout(fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  function authHeader() {
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    if (!key) {
      throw new SmartmemoryHttpError('smartmemory: missing api key', 0);
    }
    return `Bearer ${key}`;
  }

  async function health() {
    try {
      const res = await withTimeout((signal) => fetch(`${baseUrl}/health`, { signal }));
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    }
  }

  async function ingest(content, ctx) {
    const auth = authHeader(); // throws BEFORE any fetch when key is missing
    let res;
    try {
      res = await withTimeout((signal) => fetch(`${baseUrl}/memory/ingest?mode=sync`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth,
        },
        body: JSON.stringify({ content, context: ctx }),
      }));
    } catch (err) {
      throw new SmartmemoryHttpError(`smartmemory: ingest request failed: ${err.message}`, 0);
    }
    if (!res.ok) {
      throw new SmartmemoryHttpError(`smartmemory: ingest failed (HTTP ${res.status})`, res.status);
    }
    let raw;
    try {
      raw = await res.json();
    } catch {
      throw new SmartmemoryHttpError(
        `smartmemory: ingest returned a 2xx (HTTP ${res.status}) with a non-JSON body`,
        res.status, 'malformed-response',
      );
    }
    if (typeof raw?.status !== 'string') {
      throw new SmartmemoryHttpError(
        `smartmemory: ingest returned a 2xx (HTTP ${res.status}) body missing a "status" field`,
        res.status, 'malformed-response',
      );
    }
    const unchanged = raw.status === 'unchanged' || raw.unchanged === true;
    return { status: raw.status, unchanged, raw };
  }

  async function search(query, opts = {}) {
    const auth = authHeader();
    let res;
    try {
      res = await withTimeout((signal) => fetch(`${baseUrl}/memory/search`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth,
        },
        body: JSON.stringify({ query, ...opts }),
      }));
    } catch (err) {
      throw new SmartmemoryHttpError(`smartmemory: search request failed: ${err.message}`, 0);
    }
    if (!res.ok) {
      throw new SmartmemoryHttpError(`smartmemory: search failed (HTTP ${res.status})`, res.status);
    }
    let raw;
    try {
      raw = await res.json();
    } catch {
      throw new SmartmemoryHttpError(
        `smartmemory: search returned a 2xx (HTTP ${res.status}) with a non-JSON body`,
        res.status, 'malformed-response',
      );
    }
    if (!Array.isArray(raw?.results)) {
      throw new SmartmemoryHttpError(
        `smartmemory: search returned a 2xx (HTTP ${res.status}) body missing a "results" array`,
        res.status, 'malformed-response',
      );
    }
    return raw;
  }

  // ── typed-record CRUD (COMP-FOH S01) ──────────────────────────────────────
  //
  // Five thin wrappers over the generic MemoryItem CRUD routes, added so a
  // storage provider can address items individually instead of going through
  // `ingest`. They are DELIBERATELY dumb: they know the wire contract and
  // nothing else. No handles, no record shapes, no kinds — that mapping belongs
  // to the caller (lib/fluid/smartmemory-provider.js), and keeping it out of
  // here is what lets these methods serve a non-fluid caller later.
  //
  // Additive only. `health`/`ingest`/`search` above are untouched: both shipped
  // consumers (COMP-SMARTMEMORY-INGEST, COMP-SMARTMEMORY-RECALL) call them, so
  // the risk here is regression, not collision. That is also why the shared
  // `crudRequest` helper below is used by the five new methods only rather than
  // being retrofitted onto the original three.

  /** Auth + content-type + workspace scoping for a CRUD call.
   *
   *  `X-Workspace-Id` is sent when configured and omitted when not. The client
   *  does NOT validate its presence: a missing workspace id is a configuration
   *  error the caller must raise before it ever gets here (fluid does this in
   *  its factory, as FluidConfigError), and duplicating the check as a second,
   *  differently-worded failure would just make the real one harder to find. */
  function crudHeaders(hasBody) {
    const headers = { Authorization: authHeader() };
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (cfg.workspaceId) headers['X-Workspace-Id'] = cfg.workspaceId;
    return headers;
  }

  /**
   * One request, with this module's three-way failure convention preserved:
   * network failure → status 0, non-2xx → that status, 2xx we can't parse →
   * `malformed-response`.
   *
   * @param {string} op operation name, for the error message
   * @param {string} path path below baseUrl, query string included
   * @param {{method?: string, body?: object, nullOn404?: boolean}} opts
   * @returns {Promise<object|null>} parsed body, or null for a tolerated 404
   */
  async function crudRequest(op, path, { method = 'GET', body, nullOn404 = false } = {}) {
    const headers = crudHeaders(body !== undefined); // throws BEFORE any fetch when the key is missing
    let res;
    try {
      res = await withTimeout((signal) => fetch(`${baseUrl}${path}`, {
        method,
        signal,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    } catch (err) {
      throw new SmartmemoryHttpError(`smartmemory: ${op} request failed: ${err.message}`, 0);
    }
    // A miss is an answer, not a failure — but only where the caller said so.
    // Blanket-tolerating 404 would turn "that item is gone" into a successful
    // no-op on update and delete.
    if (nullOn404 && res.status === 404) return null;
    if (!res.ok) {
      throw new SmartmemoryHttpError(`smartmemory: ${op} failed (HTTP ${res.status})`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new SmartmemoryHttpError(
        `smartmemory: ${op} returned a 2xx (HTTP ${res.status}) with a non-JSON body`,
        res.status, 'malformed-response',
      );
    }
  }

  /** Reject a 2xx that is valid JSON but missing what the caller will read.
   *  Same reasoning as `ingest`'s `status` check: a response we cannot trust
   *  must not be indistinguishable from one we can. */
  function requireShape(raw, op, ok, expected) {
    if (!ok) {
      throw new SmartmemoryHttpError(
        `smartmemory: ${op} returned a 2xx body missing ${expected}`,
        200, 'malformed-response',
      );
    }
    return raw;
  }

  /**
   * Create one item. Returns the raw body; `id` is the new item_id.
   *
   * `usePipeline` defaults to **false**, which deliberately inverts the route's
   * own default of true. The ingestion pipeline extracts graph entities from
   * unstructured prose — correct for `ingest()`, wrong for a caller writing an
   * already-structured record, where it would invent entities from the payload.
   * A caller that wants the pipeline wants `ingest()` instead.
   *
   * Note the route answers **200, not 201** (COMP-FOH C9), so callers must not
   * assert on 201.
   */
  async function createItem({ content, memoryType, metadata, usePipeline = false }) {
    const raw = await crudRequest('createItem', '/memory/add', {
      method: 'POST',
      body: {
        content,
        memory_type: memoryType,
        metadata: metadata ?? {},
        use_pipeline: usePipeline,
      },
    });
    return requireShape(raw, 'createItem', typeof raw?.id === 'string', 'an "id" string');
  }

  /** Fetch one item by item_id. **Returns `null` when it does not exist** —
   *  a lookup that misses is an ordinary answer, and making callers catch an
   *  exception for it would push try/catch into every read path. Every other
   *  failure still throws. */
  async function getItem(itemId) {
    const raw = await crudRequest('getItem', `/memory/${encodeURIComponent(itemId)}`, { nullOn404: true });
    if (raw === null) return null;
    return requireShape(raw, 'getItem', raw && typeof raw === 'object', 'an object body');
  }

  /**
   * List items, one page at a time. **The route defaults to `limit=50`** and
   * this wrapper does not paginate for you — a caller enumerating everything
   * must loop on `offset` until a short page or `total` (COMP-FOH C5).
   *
   * `metadataKey`/`metadataValue` filter on a single exact match and must be
   * supplied together; the route 422s on half a pair, so that is refused here
   * with a message that names the problem instead.
   */
  async function listItems({ limit, offset, order, metadataKey, metadataValue } = {}) {
    if ((metadataKey === undefined) !== (metadataValue === undefined)) {
      throw new SmartmemoryHttpError(
        'smartmemory: listItems requires metadataKey and metadataValue together, or neither',
        0,
      );
    }
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    if (offset !== undefined) qs.set('offset', String(offset));
    if (order !== undefined) qs.set('order', order);
    if (metadataKey !== undefined) {
      qs.set('metadata_key', metadataKey);
      qs.set('metadata_value', metadataValue);
    }
    const query = qs.toString();
    const raw = await crudRequest('listItems', `/memory/list${query ? `?${query}` : ''}`);
    return requireShape(raw, 'listItems', Array.isArray(raw?.items), 'an "items" array');
  }

  /**
   * Update one item.
   *
   * Only `content` and `metadata` are exposed. The route's third surface,
   * `properties`, bypasses the metadata merge and hands over the full node
   * property dict, which is the mass-assignment path the server's protected
   * fields exist to guard — not something to expose from a general-purpose
   * client.
   *
   * Two server behaviours the caller must already know about (COMP-FOH C7,
   * C14b): the metadata merge is a **one-level spread**, so a top-level key you
   * omit survives and one you send is replaced whole; and a value sent as
   * `null` or `""` is **not cleared**, it is skipped, leaving the previous value
   * in place behind a 200 (smart-memory-core#3).
   */
  async function updateItem(itemId, { content, metadata, writeMode } = {}) {
    const body = {};
    if (content !== undefined) body.content = content;
    if (metadata !== undefined) body.metadata = metadata;
    if (writeMode !== undefined) body.write_mode = writeMode;
    if (Object.keys(body).length === 0) {
      throw new SmartmemoryHttpError(
        'smartmemory: updateItem needs at least one of content or metadata',
        0,
      );
    }
    return crudRequest('updateItem', `/memory/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body,
    });
  }

  /**
   * Workspace-scoped semantic search.
   *
   * Separate from `search()` above, which is NOT interchangeable with it:
   * `search()` sends no `X-Workspace-Id`, so it queries the key's default scope.
   * A caller that stores into a configured workspace and reads back through
   * `search()` would silently query somewhere else — the whole point of this
   * method is that it goes through `crudHeaders()` like every other scoped call.
   *
   * **`channel_weights: {}` is sent on every request and is not optional.**
   * Omitting the field makes the service fall back to the API key's stored
   * agent recall-profile weights, and a zero weight there disables that
   * retrieval channel outright. Recall behaviour would then depend on a
   * per-key profile Compose does not manage and cannot see — and would change
   * under it without warning. The empty dict is the service's documented way to
   * say "use channel defaults, ignore the profile".
   *
   * @param {string} query free text
   * @param {{topK?: number, memoryType?: string}} [opts]
   * @returns {Promise<{results: object[]}>} raw service response
   */
  async function searchItems(query, { topK, memoryType } = {}) {
    const body = { query, channel_weights: {} };
    if (topK !== undefined) body.top_k = topK;
    if (memoryType !== undefined) body.memory_type = memoryType;
    const raw = await crudRequest('searchItems', '/memory/search', { method: 'POST', body });
    return requireShape(raw, 'searchItems', Array.isArray(raw?.results), 'a "results" array');
  }

  /** Delete one item. Requires the `delete:memories` scope, which the route
   *  derives from the HTTP method — a key without it fails only here, long
   *  after setup looked like it worked (COMP-FOH C8). */
  async function deleteItem(itemId, { cleanupOrphans = false } = {}) {
    const query = cleanupOrphans ? '?cleanup_orphans=true' : '';
    return crudRequest('deleteItem', `/memory/${encodeURIComponent(itemId)}${query}`, {
      method: 'DELETE',
    });
  }

  return {
    health, ingest, search,
    createItem, getItem, listItems, updateItem, deleteItem, searchItems,
  };
}
