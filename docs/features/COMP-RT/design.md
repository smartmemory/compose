# COMP-RT: Runtime & Realtime (RT-1 → RT-3)

**Status:** APPROVED
**Date:** 2026-04-17
**Roadmap items:** 58, 59, 60 (RT-1, RT-2, RT-3)
**Out of scope:** RT-4 (session branching) — deferred to separate feature

## Related Documents

- Compose ROADMAP.md — items 58–60
- `compose/server/vision-server.js` — WebSocket broadcast, `scheduleBroadcast()` / `broadcastState()`
- `compose/server/agent-server.js` — SSE endpoint, `_sseClients` set, module-level script (no class)
- `compose/server/connectors/agent-connector.js` — duck-typed base class
- `compose/server/agent-registry.js` — subagent spawn tracker (unrelated to connector interfaces)

## Problem

Three independent runtime gaps degrade the Compose web UI under active agent sessions:

1. **UI thrash** — `vision-server.js` uses a 100ms `clearTimeout`/`setTimeout` debounce for `broadcastState()`. Under heavy agent activity, rapid state mutations cause multiple full-state broadcasts per 100ms window. Every `scheduleBroadcast()` call resets the timer, so bursts can delay delivery unpredictably.

2. **Blank-on-connect** — New browser tabs and reconnecting SSE clients receive no snapshot on connect. The WebSocket `connection` handler in `vision-server.js` already sends an inline `visionState` message, but SSE clients receive nothing until the next natural event fires.

3. **Monolithic connectors** — `AgentConnector` and all three implementations conflate vendor discovery (supported models, history loading) with stateful execution (streaming, interruption, schema injection). Adding a new vendor requires touching the execution path even when only discovery behavior differs.

## Design

### RT-1: Event Coalescing

**New file:** `compose/server/coalescing-buffer.js`

`CoalescingBuffer` owns a per-key accumulation map and a fixed-interval flush timer. Two accumulation modes selected per event key at registration time:

- **`latest-wins`** — keyed state events (e.g., `visionState`). New value for a key replaces the previous pending value. Only the most recent snapshot is flushed.
- **`append`** — ordered sequential events (e.g., `agentMessage`). All events accumulated in insertion order and flushed as an array.

```js
// flushFn receives a plain object: { [key]: value } for latest-wins, { [key]: value[] } for append
const buf = new CoalescingBuffer((flushed) => { /* dispatch below */ }, { intervalMs: 16 });
buf.register('visionState', 'latest-wins');
buf.register('agentMessage', 'append');
buf.put('visionState', stateObj);   // replaces previous
buf.put('agentMessage', msgObj);    // appends
buf.stop();                         // clears interval, no further flushes
```

`flushFn` is called every 16ms only when at least one key has pending data. The argument is a plain object mapping each pending key to its accumulated value or array. After each call the pending map is cleared.

**Note on timer resolution:** `setInterval(fn, 16)` on Node.js is subject to timer coalescing and OS scheduling jitter. The 16ms interval is a ceiling target, not a hard guarantee. Tests must not assert timing precision — only that flush occurs before the next interval.

**Integration in `vision-server.js`:**

`scheduleBroadcast()` is injected as a callback into 8+ route modules (`vision-routes.js`, `activity-routes.js`, `session-routes.js`, `pipeline-routes.js`, `feature-scan.js`, `stratum-sync.js`, etc.). To avoid a cascade of injection-site changes, **`scheduleBroadcast()` is kept** as a thin wrapper:

```js
scheduleBroadcast() {
  this._coalescingBuffer.put('visionState', this.store.getState());
}
```

Remove `_broadcastTimer` entirely (field declaration in constructor + the old `clearTimeout`/`setTimeout` body). Keep the method signature — zero changes to callers.

The `CoalescingBuffer` is constructed in the `VisionServer` constructor with a dispatch adapter as its `flushFn`:

```js
this._coalescingBuffer = new CoalescingBuffer((flushed) => {
  if (flushed.visionState) this.broadcastMessage({ type: 'visionState', ...flushed.visionState });
}, { intervalMs: 16 });
this._coalescingBuffer.register('visionState', 'latest-wins');
```

`buf.stop()` is called in `VisionServer.close()` alongside the existing cleanup of `_stratumSync`, `_healthMonitor`, and `_worktreeGC`.

Direct `broadcastMessage()` calls for non-state events (e.g., `sessionSummary`) are unaffected — they bypass the buffer and remain low-frequency.

**Integration in `agent-server.js`:**

`agent-server.js` is a module-level script (not a class). It gets its own `CoalescingBuffer` instance, separate from `VisionServer`'s buffer — these are two independent processes on different ports; no shared buffer object is possible or required.

```js
const _agentBuffer = new CoalescingBuffer((flushed) => {
  if (flushed.agentMessage) {
    for (const msg of flushed.agentMessage) broadcast(msg);
  }
}, { intervalMs: 16 });
_agentBuffer.register('agentMessage', 'append');
```

Inside `_consumeStream`, replace direct `broadcast(msg)` calls with `_agentBuffer.put('agentMessage', msg)`. The SSE format is unchanged — individual messages are sent sequentially inside the flush adapter.

The buffer is cleared and the interval stopped when the session ends (in the `finally` block of `_consumeStream`, after the stream loop). The buffer is also cleared in `_killCurrentSession()` to handle forced termination before natural completion.

---

### RT-2: Client Hydration

**WebSocket hydration — `getVisionSnapshot()` added to `VisionServer`:**

The existing `connection` handler sends two messages on every connect: an inline `visionState` send followed by a `settingsState` send. Only the `visionState` send is replaced; the `settingsState` send immediately after it is preserved unchanged.

```js
// Before:
ws.send(JSON.stringify({ type: 'visionState', ...this.store.getState(), sessions: [...] }));
ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));

// After:
this.getVisionSnapshot(ws);  // replaces the visionState send only
ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));
```

```js
getVisionSnapshot(ws) {
  try {
    const snapshot = { type: 'hydrate', ...this.store.getState(),
                       sessions: this.sessionManager?.getRecentSessions?.() || [] };
    ws.send(JSON.stringify(snapshot));
  } catch (err) {
    console.error('[vision] Hydrate error:', err.message);
    // don't drop the connection
  }
}
```

The `type: 'hydrate'` sentinel lets the frontend distinguish initial load from incremental updates. `useVisionStore.js` handles `hydrate` identically to `visionState`. **Implementation checklist items:** (1) grep frontend source for `type.*visionState` raw message pattern-matches (outside of `useVisionStore.js`) and confirm they also handle `hydrate`; (2) `store.getState()` must not include a top-level `type` or `sessions` key — the spread would silently overwrite them. Assert this constraint in the state schema or add a runtime guard.

**SSE hydration — `_recentMessages` ring buffer added to `agent-server.js`:**

`agent-server.js` is a module-level script; the buffer and snapshot function are module-level:

```js
const _recentMessages = [];        // ring buffer, max 50 entries
const HYDRATE_LIMIT = 50;

function _trackMessage(msg) {
  _recentMessages.push(msg);
  if (_recentMessages.length > HYDRATE_LIMIT) _recentMessages.shift();
}

function getAgentSnapshot() {
  return _recentMessages.length > 0 ? [..._recentMessages] : null;
}
```

Every message is tracked by calling `_trackMessage(msg)` **inside the flush adapter** (not inside `broadcast()`, to avoid double-tracking if `broadcast()` is called from other paths).

**`_agentBuffer` lifecycle:** `_agentBuffer` is a module-level singleton. Its interval runs for the full process lifetime — `buf.stop()` is only called in the process `shutdown()` handler, not per session. Only the ring buffer is cleared per session.

**Ring buffer clear points:** `_recentMessages.length = 0` is called **only in `_killCurrentSession()`** — which fires on force-interrupt (`DELETE /api/agent/session`) and at the top of `POST /api/agent/session` to clear stale prior-session context before a new session begins. The ring is **not** cleared on natural session end, so a client reloading the tab after a turn completes can still hydrate with recent message history.

**SSE connect ordering:**

The existing connect handler sends `system/connected` immediately after `_sseClients.add(res)` when a session is active. The hydrate event is sent **before** `system/connected`:

```js
_sseClients.add(res);
const snapshot = getAgentSnapshot();
if (snapshot) {
  res.write(`event: hydrate\ndata: ${JSON.stringify(snapshot)}\n\n`);
}
// existing system/connected send follows
if (_session?.id) {
  res.write(`data: ${JSON.stringify({ type: 'system', subtype: 'connected', ... })}\n\n`);
}
```

This order means: client receives the message history first, then the connection confirmation. The frontend handler in `AgentStream.jsx` pre-populates the message list on `event: hydrate` before entering streaming mode.

**Out of scope:** `BuildStreamBridge` messages flow through a separate broadcast path and are not included in `_recentMessages`. Clients connecting mid-build will not receive build event history. Build state hydration via the existing `/api/build/state` endpoint is unaffected.

**Frontend (additive, non-breaking):**

- `useVisionStore.js`: handle `message.type === 'hydrate'` identically to `visionState`.
- `AgentStream.jsx`: handle `event: hydrate` by pre-populating the message list.

No new endpoints. No protocol changes.

---

### RT-3: Connector Trait Split

**Naming note:** `AgentRegistry` already exists (`server/agent-registry.js`) as a subagent spawn tracker. The new connector interface names are `ConnectorDiscovery` and `ConnectorRuntime`.

**Two new interface files (documentation contracts only — not base classes):**

`compose/server/connectors/connector-discovery.js`:
```js
/**
 * @interface ConnectorDiscovery
 * Stateless vendor capability contract. Implementations must not hold execution state.
 *
 * All three concrete connectors (ClaudeSDKConnector, CodexConnector, OpencodeConnector)
 * implement this interface. Verified by connector-shape.test.js.
 */
export const ConnectorDiscoveryInterface = {
  /** @returns {string[]} */
  listModels() {},
  /** @param {string} modelId @returns {boolean} */
  supportsModel(_modelId) {},
  /** @param {string} sessionId @returns {Promise<object[]>} */
  loadHistory(_sessionId) {},
};
```

`compose/server/connectors/connector-runtime.js`:
```js
/**
 * @interface ConnectorRuntime
 * Stateful execution contract.
 */
export const ConnectorRuntimeInterface = {
  /** @yields typed message envelopes — see agent-connector.js for envelope spec */
  async *run(_prompt, _opts) {},
  interrupt() {},
  get isRunning() { return false; },
};
```

These files are reference documentation. No class is extended. `AgentConnector` continues to be the duck-typed base class and is annotated with JSDoc `@implements {ConnectorDiscovery}` and `@implements {ConnectorRuntime}` tags but does not extend either interface file.

**`AgentConnector` changes (`agent-connector.js`):**
- Add JSDoc `@implements` tags.
- Add stub implementations of the three discovery methods directly on the base class (so concrete connectors inherit working stubs and only override if needed):
  ```js
  listModels() { return []; }
  supportsModel(_modelId) { return false; }
  async loadHistory(_sessionId) { return []; }
  ```
- Organize the file into two clearly delimited sections: `// ── Discovery ──` and `// ── Runtime ──`.

**Concrete connectors** (`claude-sdk-connector.js`, `codex-connector.js`, `opencode-connector.js`):
- Inherit the discovery stubs from `AgentConnector` — no new methods required unless the connector has real discovery capability.
- Add the `// ── Discovery ──` / `// ── Runtime ──` section comments for consistency.
- `CodexConnector` extends `OpencodeConnector` which extends `AgentConnector` — the inheritance chain is preserved unchanged; no MRO conflicts since neither interface file is in the chain.

**`agent-server.js` call sites:** unchanged.

---

### Testing

**RT-1 — `CoalescingBuffer` unit tests** (`compose/test/coalescing-buffer.test.js`):
- `latest-wins` mode: multiple puts → flush delivers only the last value
- `append` mode: multiple puts → flush delivers array of all values in order
- Empty flush: no pending data → `flushFn` not called
- `stop()`: interval cleared, no further flushes after stop
- Mixed keys: each key respects its own mode independently
- **Flush-rate guarantee:** put 100 items synchronously in `latest-wins` mode; advance fake timer by one interval; assert `flushFn` called exactly once with the final value (use `jest.useFakeTimers()` or equivalent)

**RT-2 — Hydration integration tests** (`compose/test/hydration.test.js`):

These tests spin up a test server instance (matching the pattern in existing integration tests) rather than mocking the transport.

- WS connect mid-session: first received message has `type: 'hydrate'` with current state
- WS connect with no active session: `hydrate` message still sent with empty session fields
- SSE connect mid-session: first event has `event: hydrate` containing last ≤50 messages, followed by `system/connected`
- SSE connect with no active session: no `event: hydrate` emitted; verify by asserting the first event is `system/connected` or no event within 50ms
- Buffer cap: push 60 messages, connect new SSE client, assert hydrate payload contains exactly 50 (most recent)
- Force-kill during session: assert `_recentMessages` is empty after `_killCurrentSession()`

**RT-3 — Connector shape test** (`compose/test/connector-shape.test.js`):

Shape-only test — verifies interface conformance, not behavior. Behavior is covered by per-connector integration tests.

- For each concrete connector class: instantiate with minimal constructor args, assert it has `listModels`, `supportsModel`, `loadHistory`, `run`, `interrupt`, `isRunning`
- Assert `run` is an async generator (call it, check `Symbol.asyncIterator` on the result)
- Assert `isRunning` is a getter returning boolean
- Assert `listModels()` returns an array
- Assert `loadHistory()` returns a Promise

---

## Sequencing

RT-1 → RT-2 → RT-3. RT-1 (`CoalescingBuffer`) is a standalone utility. RT-2 (hydration) builds on RT-1's buffer being in place for `_agentBuffer`. RT-3 (connector split) is independent but done last to keep connector files stable during RT-1/RT-2 test writing.

## Non-Goals

- Session branching (RT-4) — separate feature
- SSE → WebSocket migration
- Frontend hydration loading states / skeleton screens
- Real `loadHistory` implementations (stubs satisfy interface compliance; deferred until a consumer needs it)
- `BuildStreamBridge` message hydration — explicitly out of scope; requires a separate design
