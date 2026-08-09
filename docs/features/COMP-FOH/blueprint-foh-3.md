# COMP-FOH / FOH-3 — Blueprint: CHALLENGE wiring

**Status:** BLUEPRINT (verified) · **Design:** [design-foh-3.md](design-foh-3.md) · **Date:** 2026-08-09
**Scope:** same-kind decision-first contradiction detection + `challengeIdea` consumer. All refs verified live this session.

## Corrections Table (design assumption → verified reality)

| # | Design said | Reality (verified) | Resolution |
|---|---|---|---|
| C1 | "thread a per-call `timeoutMs` into `fetchWithContract`" (mechanism unspecified) | `BaseAPI.post(endpoint, data, options)` spreads `options` → `request()` → `auth.getRequestOptions({...options})` which returns `{...extra}` **preserving unknown keys** (`AuthCore.js:100-103`) → `fetchFn(url, config)`. So a `{timeoutMs}` passed as post's 3rd arg reaches `fetchWithContract`'s `init`. | `fetchWithContract` reads `init.timeoutMs ?? timeoutMs` and strips it before `fetch()`. `challenge` passes `{ timeoutMs }` via `api.post(path, body, { timeoutMs })`. Non-racy (per-call), additive, no SDK-path change. |
| C2 | `challengeIdea` "resolves via `provider.getRecord(...)` then calls `provider.challenge`" | `provider.challenge` already resolves via `getRecord` internally and throws `FluidRecordNotFound` on a miss (by-handle-op convention, `smartmemory-provider.js:887,940`). Resolving in BOTH is a double `getRecord`. | `challengeIdea` normalizes the id (`String(id).toUpperCase()`), **delegates** to `provider.challenge(handle, opts)`, and maps `FluidRecordNotFound → IdeaboxNotFound`. Same observable contract (kind-agnostic, case-insensitive, `IdeaboxNotFound` on miss), single resolve. |
| C3 | provider throws "a clear FluidError" for non-challengeable kinds | Seam has typed `FluidKindUnsupported(kind, providerName, supported[])` (`provider.js:206`); the base `require(cap)` throws `FluidCapabilityUnavailable` (`:317`). No `FluidError`. | Use `FluidKindUnsupported`. Capability enforced by `this.require(CAP.CHALLENGE)` inside `challenge()` — no redundant `has()` pre-check in the consumer; `require` fires first on a non-CHALLENGE provider. |
| C4 | `has(CAP.CHALLENGE)` guard in the consumer | `require()` inside `challenge()` already throws `FluidCapabilityUnavailable` before any work, and it fires before the `FluidRecordNotFound` path. | Consumer omits the pre-check; the capability-unavailable error propagates from `challenge()` unchanged. |

Nothing in the table blocks the slice; all four are mechanism refinements, not scope changes.

## Boundary Map

- **`challenge(assertion, opts)`** — kind `function` (new) — `lib/smartmemory-client.js`. Producer of the raw wire call to `POST /memory/reasoning/challenge`. Consumed by the provider only.
- **`SmartMemoryFluidProvider.challenge(handle, opts)`** — kind `function` (new) — `lib/fluid/smartmemory-provider.js`. Consumes the client method `from` client; produces the seam `ChallengeResult`. Declares `CAP.CHALLENGE`.
- **`ChallengeResult` / `Conflict`** — kind `type` (new JSDoc) — `lib/fluid/provider.js`. The seam shape; produced by the provider, consumed by `challengeIdea` and any future surface.
- **`challengeIdea(ctx, id, opts)`** — kind `function` (new) — `lib/fluid/ideabox-ops.js`. Consumes `provider.challenge` `from` the provider; the only consumer wired this slice.

Topology: client.challenge → provider.challenge → challengeIdea. No cross-slice producers; all one-directional.

## File Plan

### 1. `lib/smartmemory-client.js` (existing) — add `challenge` + per-call timeout

**1a. `fetchWithContract` per-call timeout** (`:103-105`, C1). Change the deadline source and strip the marker:
```js
async function fetchWithContract(url, init = {}) {
  const { timeoutMs: callTimeoutMs, ...fetchInit } = init;   // NEW: pull per-call override out
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), callTimeoutMs ?? timeoutMs);  // was: timeoutMs
  ...
  res = await fetch(url, { ...fetchInit, signal: controller.signal });   // was: { ...init, ... }
```
Every existing caller passes no `timeoutMs`, so `callTimeoutMs` is `undefined` and the 3s default is unchanged (identity for CRUD/recall/ingest/search).

**1b. `challenge` method** (mirror `searchItems`; scoped; expose in the return object at `:467`):
```js
/** Contradiction detection over stored memory of ONE type. Scoped. `memoryType`
 *  is the EXACT stored type to search (no wildcard). `timeoutMs` overrides the
 *  client default because the LLM cascade over ~10 facts blows a 3s deadline. */
async function challenge(assertion, { memoryType, useLlm = true, timeoutMs } = {}) {
  const raw = await request('challenge', (api) => api.post(
    '/memory/reasoning/challenge',
    { assertion, memory_type: memoryType, use_llm: useLlm },
    timeoutMs === undefined ? undefined : { timeoutMs },
  ));
  return requireShape(
    raw, 'challenge', typeof raw?.has_conflicts === 'boolean' && Array.isArray(raw?.conflicts),
    'a "has_conflicts" boolean and "conflicts" array',
  );
}
```
Wire contract: `reasoning.py:34-38` (req `{assertion, memory_type, use_llm}`), `:52-58` (resp `{new_assertion, has_conflicts, conflicts[], related_facts_count, overall_confidence}`), conflict fields `existing_item_id, existing_fact, new_fact, conflict_type, confidence, explanation, suggested_resolution` (`:41-49`). Default `scoped:true` sends `X-Workspace-Id` (route is `user_only`, `reasoning.py:26`).

### 2. `lib/fluid/provider.js` (existing) — lock the seam shape + `CHALLENGEABLE_KINDS`

Above `challenge()` (`:463`), replace the one-line JSDoc with the `ChallengeResult`/`Conflict` shape (as `RecallHit` is locked above `recall()`):
```
@typedef {{ handle: string, existingText: string, conflictType: string,
            confidence: number, explanation: string, suggestedResolution: string }} Conflict
@typedef {{ assertion: string, hasConflicts: boolean, confidence: number,
            conflicts: Conflict[] }} ChallengeResult   // aggregates DERIVED from retained conflicts
```
Export `CHALLENGEABLE_KINDS = Object.freeze(new Set([KIND.DECISION, KIND.IDEA]))` (near `CAP`). Kept in `provider.js` (the seam), not the provider impl, because it is a seam-level contract about which kinds `challenge()` accepts.

### 3. `lib/fluid/smartmemory-provider.js` (existing) — implement `challenge` + declare cap

**3a.** `capabilities()` (`:216`) → add `CAP.CHALLENGE`:
```js
return new Set([STORAGE_CAP.RECORDS, STORAGE_CAP.EVENTS, STORAGE_CAP.LINKS, CAP.RECALL, CAP.CHALLENGE]);
```
**3b.** Add a `CHALLENGE_TIMEOUT_MS = 30_000` const near the other tunables (`:170-195`).
**3c.** Implement `challenge` (after `recall`, ~:1135), using verified helpers `getRecord` (`:737`), `_renderContent` (`:355`), `wireTypeFor` (`:207`), `client.getItem` (`:314`), `RECORD_NS`:
```js
async challenge(handle, opts = {}) {
  this.require(CAP.CHALLENGE);                                   // provider.js:317
  const record = await this.getRecord(handle);
  if (!record) throw new FluidRecordNotFound(handle, this.name());
  if (!CHALLENGEABLE_KINDS.has(record.kind)) {
    throw new FluidKindUnsupported(record.kind, this.name(), [...CHALLENGEABLE_KINDS]);
  }
  const assertion = this._renderContent(record);
  const raw = await this.client.challenge(assertion, {
    memoryType: wireTypeFor(record.kind),                        // exact fluid_<kind> — the crux
    useLlm: opts.useLlm ?? true,
    timeoutMs: opts.timeoutMs ?? CHALLENGE_TIMEOUT_MS,
  });

  // D1a fluid-only + D1b self-exclude: map existing_item_id → fluid handle.
  const conflicts = [];
  for (const c of raw.conflicts ?? []) {
    const item = await this.client.getItem(String(c.existing_item_id ?? ''));
    const meta = item?.metadata ?? {};
    if (meta.fluid_ns !== RECORD_NS) continue;                   // not ours → drop
    const h = meta.handle;
    if (!h || h === record.handle) continue;                     // self → drop
    conflicts.push({
      handle: h,
      existingText: c.existing_fact ?? '',
      conflictType: c.conflict_type ?? '',
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      explanation: c.explanation ?? '',
      suggestedResolution: c.suggested_resolution ?? '',
    });
  }
  conflicts.sort((a, b) => b.confidence - a.confidence);         // best-first

  // D1c: aggregates from the RETAINED set, never the server's pre-filter values.
  const hasConflicts = conflicts.length > 0;
  const confidence = hasConflicts
    ? Math.max(0, 1 - (conflicts.reduce((s, c) => s + c.confidence, 0) / conflicts.length) * 0.5)
    : 1.0;                                                        // challenger.py:256-262 formula
  return { assertion, hasConflicts, confidence, conflicts };
}
```
Add imports: `CAP, CHALLENGEABLE_KINDS, FluidKindUnsupported` (FluidRecordNotFound already imported `:69`).

### 4. `lib/fluid/ideabox-ops.js` (existing) — `challengeIdea` consumer

Import add: `CAP, FluidRecordNotFound` from `./provider.js` (currently imports `{ FluidAmbiguousMatch, KIND }` `:47`). Then (near `addDiscussion` `:464`):
```js
/** Push-back: contradiction-detect a decision/idea against same-kind records.
 *  Kind-agnostic resolution, case-insensitive id, IdeaboxNotFound on miss. */
export async function challengeIdea(ctx, id, opts = {}) {
  const handle = String(id ?? '').toUpperCase();                 // getRecord rejects lowercase
  try {
    return await ctx.provider.challenge(handle, opts);           // require()/kind gate live inside
  } catch (e) {
    if (e instanceof FluidRecordNotFound) throw new IdeaboxNotFound(id);
    throw e;                                                     // FluidCapabilityUnavailable / FluidKindUnsupported propagate
  }
}
```
No projection write (challenge is read-only — unlike `addDiscussion`, nothing to re-render).

## Verification Table (Phase 5 — every ref read at the stated line this session)

| Ref | Claim | Verified |
|---|---|---|
| `smartmemory-client.js:85` | client timeout default `?? 3000`, spans body read | ✅ |
| `smartmemory-client.js:103-113` | `fetchWithContract` controller/timer uses closure `timeoutMs` | ✅ |
| `BaseAPI.js:26-36,80-86` | `post(ep,data,options)` → `request` → `getRequestOptions({...options})` → `fetchFn(url,config)` | ✅ |
| `AuthCore.js:100-103` | `getRequestOptions` returns `{...extra}`, preserves unknown keys | ✅ |
| `smartmemory-client.js:413-419` | `searchItems` shape to mirror (scoped `request` + `requireShape`) | ✅ |
| `reasoning.py:34-58` | req/resp schema; `memory_type` non-optional str="semantic"; `user_only` scope | ✅ |
| `search.py:123-155` | `memory_type` = exact post-retrieval equality filter | ✅ |
| `challenger.py:256-262` | confidence formula `max(0,1-(mean·0.5))` | ✅ |
| `provider.js:206,241,310,317` | `FluidKindUnsupported`, `FluidRecordNotFound`, `has`, `require` | ✅ |
| `smartmemory-provider.js:216,207,355,737,314(client)` | `capabilities`, `wireTypeFor`, `_renderContent`, `getRecord`, `client.getItem` | ✅ |
| `ideabox-ops.js:47,60,166,464` | imports, `IdeaboxNotFound`, `findIdea` (idea-only, superseded by delegation), `addDiscussion` sibling | ✅ |

Zero stale references. No Boundary Map violations (single-slice, one-directional topology).
