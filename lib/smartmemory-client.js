/**
 * smartmemory-client.js — COMP-SMARTMEMORY-INGEST S02, extended by COMP-FOH S01,
 * rebuilt onto `@smartmemory/sdk-js` by COMP-FLUID-SEAM-GUARANTEES.
 *
 * Compose's POLICY over SmartMemory's wire contract. The transport underneath —
 * base-URL joining, `Authorization`, `X-Workspace-Id`, request serialization,
 * FastAPI error-detail extraction, the 401 path — belongs to the published SDK
 * and is no longer duplicated here. What remains is the part that is genuinely
 * Compose's opinion and would have to be re-stated at every call site otherwise:
 *
 *   - `use_pipeline: false` by default, inverting the route's own default
 *   - `channel_weights: {}` on every scoped search
 *   - a miss is `null` on read, and an exception on write
 *   - a 2xx we cannot trust is a failure, not a success
 *   - the API key is resolved at CALL time, so an unset key never reaches the wire
 *
 * WHY NOT `client.memories.*`
 * --------------------------
 * The SDK's `MemoryAPI` models the same routes but not the same contract, and
 * three of the differences are load-bearing here rather than cosmetic:
 *
 *   1. `get`/`update`/`delete` interpolate the item id RAW. An id containing `/`
 *      forges a path. This module URL-encodes it (asserted in the tests).
 *   2. `search()` omits `channel_weights`, which hands recall behaviour to the
 *      API key's stored agent profile — see `searchItems` below.
 *   3. `delete()` has no `cleanup_orphans`, and `create()` sends `profile_name`
 *      this caller never sets.
 *
 * So the memory routes are issued through the SDK's `BaseAPI` transport with
 * Compose's own bodies. `sequences` and `locks` ARE used wholesale: those two
 * match exactly, and re-implementing an allocator or a lease client is precisely
 * the duplication this rebuild exists to delete.
 *
 * Two families, deliberately kept apart:
 *   - `health`/`ingest`/`search` — the pipeline surface, shipped and in use.
 *     These send NO `X-Workspace-Id`, so they address the key's default scope.
 *   - `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem`/`searchItems`
 *     plus the sequence and lease primitives — the scoped surface, which always
 *     sends `X-Workspace-Id` when one is configured.
 *
 * That split is why two SDK clients are built rather than one: the header is
 * attached by the SDK's auth core for every request it issues, so "scoped" and
 * "unscoped" cannot be the same client. Sharing one would silently move the
 * pipeline surface into the configured workspace.
 *
 * Everything here speaks HTTP and nothing else. Domain mapping — what a record
 * is, how it is identified, how it serializes — belongs to the caller.
 */

import { APIError, SmartMemoryClient } from '@smartmemory/sdk-js/core';

/**
 * Thrown on non-2xx from any call, OR on a 2xx whose body doesn't match the
 * expected shape (non-JSON, or missing the field the caller depends on —
 * `status` for ingest, `results` for search, `id` for createItem). The latter
 * case sets `kind: 'malformed-response'` so callers can tell "the service said
 * no" from "the service said something we can't trust" if they want to, while
 * both still surface as one failure type upstream (sync: `failed`; emitter:
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

/** Marker carried on an `APIError.detail` so a malformed 2xx detected down in
 *  the fetch layer survives `BaseAPI`'s error handling and can be re-typed with
 *  its `kind` intact. `BaseAPI` rethrows an `APIError` unchanged and only wraps
 *  OTHER throwables, so raising one is the supported way to pass a verdict up. */
const MALFORMED = 'malformed-response';

/**
 * Build a client bound to a resolved config. The API key is read from
 * process.env[cfg.apiKeyEnv] at call time (missing ⇒ treated as unreachable).
 * @param {{ baseUrl: string, apiKeyEnv?: string, timeoutMs?: number, workspaceId?: string }} cfg
 *   `workspaceId`, when set, is sent as `X-Workspace-Id` on the scoped methods.
 * @returns {object} the client surface documented per-method below
 */
export function createSmartmemoryClient(cfg) {
  const baseUrl = cfg.baseUrl;
  const timeoutMs = cfg.timeoutMs ?? 3000;

  /**
   * The one piece of transport Compose still owns, because the SDK has no
   * opinion on either half:
   *
   *   - a deadline, so a hung service cannot pin a CLI open. The timer spans the
   *     body read as well as the response headers; the old hand-rolled client
   *     cleared it early and could therefore hang forever on a stalled body.
   *   - the "a 2xx must be JSON" rule. An upstream proxy answering 200 with an
   *     HTML error page is the case this exists for: without the check it
   *     reaches `BaseAPI` as a parse failure indistinguishable from a network
   *     error, and a caller cannot tell a dead proxy from a dead socket.
   *
   * Returns a Response-SHAPED object rather than the real one because the body
   * has already been consumed here. `BaseAPI` reads `.ok`, `.status`,
   * `.headers.get()`, `.json()` and `.text()`; all five are provided.
   */
  async function fetchWithContract(url, init = {}) {
    // A per-call `timeoutMs` (passed as the SDK post's 3rd options arg, which
    // `getRequestOptions` preserves) overrides the client default for ONE call.
    // Stripped before `fetch` so it is never sent as a bogus request-init field.
    // Every existing caller omits it, so the 3s default is unchanged for them.
    const { timeoutMs: callTimeoutMs, ...fetchInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeoutMs ?? timeoutMs);
    let res;
    let text;
    try {
      res = await fetch(url, { ...fetchInit, signal: controller.signal });
      text = res.status === 204 ? '' : await res.text();
    } finally {
      clearTimeout(timer);
    }

    let parsed = null;
    let parseFailed = false;
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    // 204 is exempt: it has no body by definition and BaseAPI returns null for
    // it without ever asking for one.
    if (res.ok && res.status !== 204 && parseFailed) {
      throw new APIError(
        `a 2xx (HTTP ${res.status}) carried a non-JSON body`,
        res.status,
        { composeKind: MALFORMED },
      );
    }

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      json: async () => {
        if (parseFailed) throw new SyntaxError('non-JSON body');
        return parsed;
      },
      text: async () => text,
    };
  }

  // The SDK client is rebuilt whenever the resolved key changes, which is what
  // keeps "the key is read at call time" true without paying for a fresh client
  // on every request. `storage: 'memory'` is required off-browser — the default
  // reaches for localStorage.
  let cache = null;

  function buildClient(apiKey, workspaceId) {
    const client = new SmartMemoryClient({
      apiBaseUrl: baseUrl,
      apiKey,
      storage: 'memory',
      fetchFn: fetchWithContract,
    });
    if (workspaceId) client.setTeamId(workspaceId);
    return client;
  }

  /** @param {boolean} scoped send `X-Workspace-Id` (when one is configured) */
  function sdk(scoped) {
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    if (!key) {
      throw new SmartmemoryHttpError('smartmemory: missing api key', 0);
    }
    if (!cache || cache.key !== key) {
      cache = {
        key,
        scoped: buildClient(key, cfg.workspaceId),
        unscoped: buildClient(key, null),
      };
    }
    return scoped ? cache.scoped : cache.unscoped;
  }

  /**
   * One request, with this module's three-way failure convention preserved:
   * network failure → status 0, non-2xx → that status, 2xx we can't parse →
   * `malformed-response`.
   *
   * @param {string} op operation name, for the error message
   * @param {(api: object) => Promise<any>} send issues the call against a `BaseAPI`
   * @param {{scoped?: boolean, nullOn404?: boolean}} [opts]
   * @returns {Promise<object|null>} parsed body, or null for a tolerated 404
   */
  async function request(op, send, { scoped = true, nullOn404 = false } = {}) {
    // Throws BEFORE any fetch when the key is missing.
    const client = sdk(scoped);
    try {
      return await send(client._api);
    } catch (err) {
      // A miss is an answer, not a failure — but only where the caller said so.
      // Blanket-tolerating 404 would turn "that item is gone" into a successful
      // no-op on update and delete.
      if (nullOn404 && err?.status === 404) return null;
      throw asHttpError(op, err);
    }
  }

  function asHttpError(op, err) {
    if (err instanceof SmartmemoryHttpError) return err;
    if (err?.detail?.composeKind === MALFORMED) {
      return new SmartmemoryHttpError(
        `smartmemory: ${op} returned a 2xx (HTTP ${err.status}) with a non-JSON body`,
        err.status, MALFORMED,
      );
    }
    const status = typeof err?.status === 'number' ? err.status : 0;
    if (status === 0) {
      return new SmartmemoryHttpError(
        `smartmemory: ${op} request failed: ${err?.message ?? 'unknown error'}`, 0,
      );
    }
    return new SmartmemoryHttpError(`smartmemory: ${op} failed (HTTP ${status})`, status);
  }

  /** Reject a 2xx that is valid JSON but missing what the caller will read.
   *  Same reasoning as the non-JSON check above: a response we cannot trust
   *  must not be indistinguishable from one we can. */
  function requireShape(raw, op, ok, expected) {
    if (!ok) {
      throw new SmartmemoryHttpError(
        `smartmemory: ${op} returned a 2xx body missing ${expected}`,
        200, MALFORMED,
      );
    }
    return raw;
  }

  /** Liveness only. Deliberately NOT routed through the SDK: `/health` is
   *  unauthenticated, sits outside the API contract, and must answer rather than
   *  throw — including when no API key is configured at all. */
  async function health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ingest one item through the full extraction pipeline.
   *
   * `?mode=sync` is explicit even though the route defaults to it: the caller
   * depends on the returned `status` reflecting a completed write, and
   * `mode=async` documents that it skips dedupe entirely. The body is exactly
   * `{content, context}` — the SDK's `memories.ingest()` adds `extractor_name`
   * and `profile_name`, which would change what the server does.
   */
  async function ingest(content, ctx) {
    const raw = await request(
      'ingest',
      (api) => api.post('/memory/ingest?mode=sync', { content, context: ctx }),
      { scoped: false },
    );
    requireShape(raw, 'ingest', typeof raw?.status === 'string', 'a "status" field');
    const unchanged = raw.status === 'unchanged' || raw.unchanged === true;
    return { status: raw.status, unchanged, raw };
  }

  /** Unscoped search over the key's default scope. See `searchItems` for the
   *  workspace-scoped form; the two are NOT interchangeable. */
  async function search(query, opts = {}) {
    const raw = await request(
      'search',
      (api) => api.post('/memory/search', { query, ...opts }),
      { scoped: false },
    );
    return requireShape(raw, 'search', Array.isArray(raw?.results), 'a "results" array');
  }

  // ── typed-record CRUD (COMP-FOH S01) ──────────────────────────────────────
  //
  // Six thin wrappers over the generic MemoryItem CRUD routes, so a storage
  // provider can address items individually instead of going through `ingest`.
  // They are DELIBERATELY dumb: they know the wire contract and nothing else.
  // No handles, no record shapes, no kinds — that mapping belongs to the caller
  // (lib/fluid/smartmemory-provider.js), and keeping it out of here is what lets
  // these methods serve a non-fluid caller later.

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
    const raw = await request('createItem', (api) => api.post('/memory/add', {
      content,
      memory_type: memoryType,
      metadata: metadata ?? {},
      use_pipeline: usePipeline,
    }));
    return requireShape(raw, 'createItem', typeof raw?.id === 'string', 'an "id" string');
  }

  /** Fetch one item by item_id. **Returns `null` when it does not exist** —
   *  a lookup that misses is an ordinary answer, and making callers catch an
   *  exception for it would push try/catch into every read path. Every other
   *  failure still throws. */
  async function getItem(itemId) {
    const raw = await request(
      'getItem',
      (api) => api.get(`/memory/${encodeURIComponent(itemId)}`),
      { nullOn404: true },
    );
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
    const raw = await request('listItems', (api) => api.get(`/memory/list${query ? `?${query}` : ''}`));
    return requireShape(raw, 'listItems', Array.isArray(raw?.items), 'an "items" array');
  }

  /**
   * Update one item.
   *
   * Only `content`, `metadata` and `writeMode` are exposed. The route's other
   * surface, `properties`, bypasses the metadata merge and hands over the full
   * node property dict, which is the mass-assignment path the server's protected
   * fields exist to guard — not something to expose from a general-purpose
   * client.
   *
   * Two server behaviours the caller must already know about (COMP-FOH C7,
   * C14b): the metadata merge is a **one-level spread**, so a top-level key you
   * omit survives and one you send is replaced whole; and **this surface cannot
   * clear** — `crud.py:1052` hard-merges metadata with no escape hatch, so a
   * value you try to blank leaves the previous one in place behind a 200.
   *
   * Corrected 2026-08-05 (verified against live FalkorDB): that second point
   * used to be filed as "PATCH cannot clear a property", which was too broad.
   * Clearing DOES work — via the advanced `properties` surface with
   * `write_mode: "replace"`, which issues a real `REMOVE` before `SET`. It is
   * merge-only-ness of the CONVENIENCE surface that bites here, not a missing
   * capability. That escape hatch is deliberately not offered from this client
   * (see above): `properties` is the mass-assignment path. Callers needing to
   * clear should reshape what they send, not reach for it.
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
    return request('updateItem', (api) => api.patch(`/memory/${encodeURIComponent(itemId)}`, body));
  }

  /**
   * Workspace-scoped semantic search.
   *
   * Separate from `search()` above, which is NOT interchangeable with it:
   * `search()` sends no `X-Workspace-Id`, so it queries the key's default scope.
   * A caller that stores into a configured workspace and reads back through
   * `search()` would silently query somewhere else — the whole point of this
   * method is that it goes through the scoped client like every other scoped call.
   *
   * **`channel_weights: {}` is sent on every request and is not optional.**
   * Omitting the field makes the service fall back to the API key's stored
   * agent recall-profile weights, and a zero weight there disables that
   * retrieval channel outright. Recall behaviour would then depend on a
   * per-key profile Compose does not manage and cannot see — and would change
   * under it without warning. The empty dict is the service's documented way to
   * say "use channel defaults, ignore the profile". This is also why the SDK's
   * `memories.search()` is not used here: it does not send the field.
   *
   * @param {string} query free text
   * @param {{topK?: number, memoryType?: string}} [opts]
   * @returns {Promise<{results: object[]}>} raw service response
   */
  async function searchItems(query, { topK, memoryType } = {}) {
    const body = { query, channel_weights: {} };
    if (topK !== undefined) body.top_k = topK;
    if (memoryType !== undefined) body.memory_type = memoryType;
    const raw = await request('searchItems', (api) => api.post('/memory/search', body));
    return requireShape(raw, 'searchItems', Array.isArray(raw?.results), 'a "results" array');
  }

  /**
   * Contradiction detection over stored memory of ONE type (COMP-FOH FOH-3).
   *
   * Scoped, so it runs against the configured workspace like `searchItems`. Two
   * details are load-bearing:
   *   - `memoryType` is the EXACT stored type to search — the service applies it
   *     as an equality filter (`search.py:123`), not a prefix or wildcard, so the
   *     caller sends one concrete `fluid_<kind>`. `"semantic"` (the route default)
   *     would match nothing of ours.
   *   - `timeoutMs` overrides the client's 3s default for this call only. With
   *     `useLlm` on, the service runs an LLM cascade over up to ~10 related facts
   *     and routinely exceeds 3s (`challenger.py:220`). Passing it as the post's
   *     options arg is how the deadline reaches `fetchWithContract` per-call.
   *
   * @param {string} assertion the text to challenge
   * @param {{memoryType?: string, useLlm?: boolean, timeoutMs?: number}} [opts]
   * @returns {Promise<object>} raw ChallengeResponse (has_conflicts, conflicts[], …)
   */
  async function challenge(assertion, { memoryType, useLlm = true, timeoutMs } = {}) {
    const raw = await request('challenge', (api) => api.post(
      '/memory/reasoning/challenge',
      { assertion, memory_type: memoryType, use_llm: useLlm },
      timeoutMs === undefined ? undefined : { timeoutMs },
    ));
    return requireShape(
      raw, 'challenge',
      typeof raw?.has_conflicts === 'boolean' && Array.isArray(raw?.conflicts),
      'a "has_conflicts" boolean and "conflicts" array',
    );
  }

  /**
   * A record's confidence + decay history in ONE envelope (COMP-FOH FOH-4).
   *
   * The shape check is deliberately COMPLETE: the provider classifies a
   * destructive write's outcome from this envelope, so a shaped-but-partial
   * 2xx (say, `history` present but `challenge_count` missing) must be refused
   * here rather than allowed to misclassify a decay as landed or lost.
   *
   * @param {string} itemId
   * @returns {Promise<object>} `{item_id, current_confidence, challenge_count,
   *   history, history_count}` — `current_confidence` reads the first-class
   *   field (CONFIDENCE-DECAY-FIELD-1), authoritative post-decay.
   */
  async function confidenceHistory(itemId) {
    const raw = await request(
      'confidenceHistory',
      (api) => api.get(`/memory/reasoning/confidence-history/${encodeURIComponent(itemId)}`),
    );
    return requireShape(
      raw, 'confidenceHistory',
      typeof raw?.item_id === 'string'
        && Number.isFinite(raw?.current_confidence)
        && Number.isInteger(raw?.challenge_count)
        && Array.isArray(raw?.history)
        && Number.isInteger(raw?.history_count),
      'the full envelope (item_id, current_confidence, challenge_count, history, history_count)',
    );
  }

  /**
   * Apply an explicit resolution to a contradiction (COMP-FOH FOH-4).
   *
   * Three flags are sent `false` EXPLICITLY because the route defaults ALL of
   * them to true (`reasoning.py:65-68`): `auto_resolve` (the Wikipedia→LLM
   * cascade), `use_wikipedia`, `use_llm`. v1 is deterministic or nothing.
   *
   * The response is returned raw but is NOT the source of truth for the decay:
   * the server ignores `apply_decay`'s success and its `confidence` field is
   * ambiguous, so the provider re-reads `confidenceHistory` to verify. The 8s
   * default timeout covers the deterministic path's get + decay + update round
   * trips — generous, because an abort here creates an ambiguous outcome the
   * provider then has to reconcile.
   *
   * @param {{existingItemId: string, newFact: string, strategy: string, timeoutMs?: number}} args
   * @returns {Promise<object>} raw ResolveResponse (auto_resolved, resolution, …)
   */
  async function resolveConflict({ existingItemId, newFact, strategy, timeoutMs }) {
    const raw = await request('resolveConflict', (api) => api.post(
      '/memory/reasoning/resolve',
      {
        existing_item_id: existingItemId,
        new_fact: newFact,
        auto_resolve: false,
        strategy,
        use_llm: false,
        use_wikipedia: false,
      },
      { timeoutMs: timeoutMs ?? 8000 },
    ));
    return requireShape(
      raw, 'resolveConflict',
      Array.isArray(raw?.actions_taken),
      'an "actions_taken" array',
    );
  }

  /** Delete one item. Requires the `delete:memories` scope, which the route
   *  derives from the HTTP method — a key without it fails only here, long
   *  after setup looked like it worked (COMP-FOH C8). */
  async function deleteItem(itemId, { cleanupOrphans = false } = {}) {
    const query = cleanupOrphans ? '?cleanup_orphans=true' : '';
    return request(
      'deleteItem',
      (api) => api.delete(`/memory/${encodeURIComponent(itemId)}${query}`),
    );
  }

  // ── coordination primitives (SVC-ALLOC-1, SVC-LEASE-1) ────────────────────
  //
  // Straight delegation to the SDK's own clients. Nothing is re-modelled here:
  // both carry a failure convention this module has no business second-guessing
  // (an allocator has no benign failure; a lease distinguishes "someone else
  // holds it" from "the coordinator did not answer"), and flattening either into
  // SmartmemoryHttpError would erase exactly the distinction the caller needs.
  // These therefore throw `APIError`, not `SmartmemoryHttpError`.

  /** Consume the next number in a workspace-scoped monotonic sequence. The
   *  caller owns the inclusive range [first, value]; unused numbers are LOST. */
  async function allocateSequence(name, { floor, count } = {}) {
    return sdk(true).sequences.allocate(name, { floor, count });
  }

  /** Read a sequence counter without consuming, or null if never allocated. */
  async function peekSequence(name) {
    return sdk(true).sequences.peek(name);
  }

  /** Acquire a lease, or null when a live holder definitively owns it. */
  async function acquireLock(key, { ttlSeconds } = {}) {
    return sdk(true).locks.acquire(key, { ttlSeconds });
  }

  /** Renew a lease, or null when this token definitively no longer owns it. */
  async function renewLock(key, token, { ttlSeconds } = {}) {
    return sdk(true).locks.renew(key, token, { ttlSeconds });
  }

  /** Release a lease. False when this token definitively no longer owns it. */
  async function releaseLock(key, token) {
    return sdk(true).locks.release(key, token);
  }

  return {
    health, ingest, search,
    createItem, getItem, listItems, updateItem, deleteItem, searchItems, challenge,
    confidenceHistory, resolveConflict,
    allocateSequence, peekSequence,
    acquireLock, renewLock, releaseLock,
  };
}
