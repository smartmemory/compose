# COMP-FOH / FOH-4 — CONVICTION: belief-strength read + the challenge→resolve loop

**Status:** DESIGN GATE PASSED (2026-08-10) — SmartMemory blocker fixed and verified; design revised across three Codex gate rounds (r2→r4, sol/high). Ready for Phase 4-5 blueprint. · **Epic:** COMP-FOH · **Date:** 2026-08-09 (revised 2026-08-10) · **Slice:** FOH-4
**Owner directive:** `/compose build FOH` → owner picked CONVICTION, then chose the **meaningful (mutating) v1b** over read-only after the feasibility probe falsified the "clean read-mirror" premise. Design gate r1 FAILED on a SmartMemory-side blocker; owner chose **Option C — fix SmartMemory first, then build conviction.**

> **Provenance — the resolved blocker (do not re-litigate).** Design gate r1 (2026-08-09) failed on a confirmed SmartMemory bug: `apply_decay` + the `/confidence-history` route + `get_low_confidence_items` read/wrote `metadata["confidence"]`, but post-CORE-PROPS-1 `confidence` is a first-class `MemoryItem` field popped from metadata on load and excluded from the metadata merge on save (memory_item.py:74,347,371,416). Decay never persisted to the authoritative field and `current_confidence` always read 1.0. Confirmed by two independent traces (Claude + Codex 520546e9c84a) and an empirical repro (which also surfaced a SQLite datetime-JSON-serialization failure making `apply_decay` return False). **Fixed 2026-08-10:** `smart-memory-core@2841909` (`apply_decay` reads/sets the first-class field via `_effective_confidence`; SQLite datetime codec; both-backends parity test) + `smart-memory-service@3c79ddc` (`/confidence-history`, `/conflicts`, `/low-confidence` read the field via `_item_confidence`). Parity test green; round-trip verified. Both commits are on `main` and pushed but **unreleased** (see Rollout).

## Related Documents

- Parent design: [design.md](design.md) — the conviction rung (rung 5) is mapped there to SmartMemory's "decay/strength conviction."
- Architecture: [architecture.md](architecture.md) §Sequencing — CONVICTION named as deferred-past-FOH-2, "needs a real consumer or SmartMemory ontology work." Probe confirms the SmartMemory surface is READY; this doc resolves the consumer AND the write-loop question.
- Precedent: [design-foh-3.md](design-foh-3.md) / [blueprint-foh-3.md](blueprint-foh-3.md) — FOH-3 (challenge) is the pattern this slice extends; conviction is the effect FOH-3's detection was always missing.
- Wire contract: SmartMemory `smart-memory-service/memory_service/api/routes/reasoning.py` — `GET /memory/reasoning/confidence-history/{item_id}` (:311), `POST /memory/reasoning/resolve` (:142); decay mechanism `smart-memory-core/smartmemory/reasoning/confidence.py` (`apply_decay`), `challenger.py:377` (ACCEPT_NEW → decay_factor 0.5).
- Ledger: [foh-4-progress.md](foh-4-progress.md) — full feasibility verdict (a/READY) and the falsified-premise disclosure.

## Problem

FOH-3 gave the colleague the ability to *notice* a contradiction ("this new idea contradicts a decision you already made"). It cannot yet do anything about it, and it has no notion of **how strongly a record is still believed**. Every stored record sits at confidence 1.0 forever. So a decision that has been contradicted three times looks identical to one nobody has ever questioned. That is Discovery-Loop rung 5 (conviction): belief-strength that reflects what challenge has surfaced. Today `conviction()` is declared in the seam enum but every provider inherits the base refusal (`lib/fluid/provider.js:500`).

## Goal

Ship `CAP.CONVICTION` on `SmartMemoryFluidProvider` as a **two-part capability**:

1. **Read** — `conviction(handle)` surfaces a record's current confidence and its decay history.
2. **Write (gated)** — `resolveConflict(sourceHandle, targetHandle, { strategy })` applies an *explicitly chosen* resolution to a contradiction, decaying the **target** record's confidence via SmartMemory's `POST /resolve`. The provider derives the contradicting fact from the **source** record itself (no caller-supplied free text) and enforces the same-kind / non-self / namespace invariants at the seam. No auto-resolution in v1 — the caller always names the strategy.

Together these close the loop FOH-3 opened: **challenge detects → owner resolves → conviction reflects it.** Same character of wiring as FOH-2/FOH-3 (client wrappers + provider methods + a consumer), with one deliberate escalation: this is the first fluid slice that **mutates stored memory**.

### Why read-only was rejected (the falsified premise, disclosed)

The feasibility probe proved that a record's confidence **only moves via the resolve path** (`apply_decay` is invoked from `resolve_conflict`/`auto_resolve`, never from the detection-only `challenge()` — `challenger.py:329`). Compose runs no resolve path today, so a read-only `conviction(handle)` would return a flat **1.0 with empty history for every record** — the exact "green endpoint, dead capability" failure FOH-3's own report named as its lesson. Shipping the read without the write would knowingly repeat it. Owner chose v1b to avoid that.

### Non-goals (disclosed boundaries)

- **No auto-resolution.** `POST /resolve` supports an auto cascade (Wikipedia → LLM → grounding → recency). v1 always sends `auto_resolve:false` + `use_llm:false` + `use_wikipedia:false` — deterministic, no LLM, no 30s timeout. The cascade is a later slice and a bigger autonomy commitment.
- **Conviction only goes DOWN in v1.** SmartMemory's `reinforce`/`strengthen` path is decision-subsystem-only (`DecisionManager.reinforce`, requires a typed `Decision` + `evidence_id`); it does not operate on generic `fluid_<kind>` items. A 0.5 decay is near-irreversible from Compose's side (there is no un-decay for a fluid item). This is disclosed in code and gated behind an explicit caller choice.
- **No "stale beliefs" surface.** `GET /low-confidence` re-introduces the FOH-3 exact-type trap (`sm.search("", memory_type="semantic")`, `confidence.py:96` → zero fluid hits) and needs per-kind fan-out. Deferred.
- **No time-based decay.** The confidence field does not decay with age in SmartMemory; conviction moves only on resolution.

## What SmartMemory gives us (READY, verified post-fix 2026-08-10 — see ledger for full evidence)

- Every stored item carries `confidence: float = 1.0` on the base `MemoryItem` (`models/memory_item.py:74`), now the canonical value (post CONFIDENCE-DECAY-FIELD-1 the reasoning layer reads and writes the field, not popped metadata). Our `fluid_<kind>` records already have it.
- **Read:** `GET /memory/reasoning/confidence-history/{item_id}` (`reasoning.py:328`) returns **one envelope**: `{item_id, current_confidence, challenge_count, history, history_count}`. `current_confidence` is field-read via `_item_confidence` (`reasoning.py:26,350`) — authoritative post-decay. `history` is the capped-20 event list, each `{timestamp, old_confidence, new_confidence, decay_factor, reason, conflicting_fact?}`. **Item-id addressed — no `memory_type` filter, reaches any fluid record by handle.** This single call supplies confidence + challenge_count + history for the read path (no separate `getItem` needed — see D1/D3).
- **Write:** `POST /memory/reasoning/resolve` (`reasoning.py:159`), `ResolveRequest{existing_item_id, new_fact, auto_resolve, strategy?, use_wikipedia, use_llm}`. **Item-id addressed** (`smart_memory.get(existing_item_id)` then builds the Conflict from `existing_item.content` + `new_fact` — no re-detection, no `memory_type` trap on the write path). With `auto_resolve:false` + explicit `strategy`, applies that strategy deterministically. `ACCEPT_NEW` → `apply_decay(existing_item_id, decay_factor=0.5)` → `item.confidence -= 0.5` (floor 0.0), persisted to the first-class field + one history event. Scoped via `create_secure_smart_memory(scope)` — workspace-bound like challenge.
- **Caveat that survives the fix (drives D4):** the core fix did NOT touch `challenger.py` — `resolve_conflict` still ignores `apply_decay`'s boolean return (`challenger.py:376`), and `ResolveResponse.confidence` (`reasoning.py:217`, `result.get("confidence", 0.0)`) is not a reliable post-decay value. So Compose must NOT trust the resolve response as the effect; it must re-read `/confidence-history` and assert the decay landed (D4).
- Both endpoints are Compose-side reachable and the decay now persists to the canonical field → the loop is deliverable.

## Design decisions

### D1 — `ConvictionResult` is part of the seam (mirror `RecallHit`/`ChallengeResult`)

Locked in `provider.js` alongside the existing result typedefs:

```
ConvictionResult = {
  handle: string,            // the record whose conviction this is
  confidence: number,        // current belief-strength 0..1 (1.0 if never touched)
  challenged: boolean,       // has it ever been decayed by a resolution?
  challengeCount: number,    // metadata.challenge_count (0 if never)
  lastChallengedAt: string|null,  // ISO, or null
  history: ConvictionEvent[] // best-effort, newest-last, capped 20 (server-side)
}
ConvictionEvent = {
  timestamp: string, oldConfidence: number, newConfidence: number,
  decayFactor: number, reason: string, conflictingFact?: string
}
```

**All fields assemble from a single `/confidence-history` call** (verified post-fix, `reasoning.py:348`): `confidence` ← `current_confidence`; `challengeCount` ← `challenge_count`; `history` ← `history`. Derived, not separately fetched: `challenged = challengeCount > 0`; `lastChallengedAt =` the newest history event's `timestamp` (or `null` when history is empty) — exact because `apply_decay` stamps `last_challenged_at` and the decay event with the same `now` (`confidence.py:60,92`) and the server keeps the newest 20. **No `getItem` in the read path.** camelCase at the seam, snake_case on the wire (consistent with the rest of the provider).

### D2 — Two new `lib/smartmemory-client.js` wrappers (mirror `challenge`, SCOPED)

- `confidenceHistory(itemId)` → `GET /memory/reasoning/confidence-history/{item_id}`. Scoped client, default 3s timeout is fine (no LLM). Returns the full envelope `{item_id, current_confidence, challenge_count, history, history_count}`.
- `resolveConflict({ existingItemId, newFact, strategy })` → `POST /memory/reasoning/resolve` with body `{ existing_item_id, new_fact, auto_resolve: false, strategy, use_llm: false, use_wikipedia: false }`. This is the thin HTTP wrapper — `existingItemId` is the target item id and `newFact` is the source-derived text the **provider** computes (D4), not caller free text. Scoped. Returns `ResolveResponse{auto_resolved, resolution, confidence, method, evidence, actions_taken}` — but see D4: the response is NOT trusted as the post-decay value; the provider re-reads `/confidence-history` for the authoritative number.

Timeout: the read wrapper's default 3s is fine (no LLM). For `resolveConflict`, the deterministic path still does a server-side `get` + conflict-build + `apply_decay` + `update`; give it a modest explicit timeout (e.g. 8s) so a slow-but-successful mutation doesn't trip the reconciliation branch in D4 unnecessarily. Neither runs the LLM cascade in v1.

### D3 — `conviction(handle)` (read), gated behind `CAP.CONVICTION`

Resolve `handle` → the stored record's `item_id` (kind-agnostic, like FOH-3's `getRecord`); call `confidenceHistory(item_id)` **once**; assemble `ConvictionResult` entirely from that envelope (D1). No separate `getItem`. Handle not found → `FluidRecordNotFound`. A never-resolved record honestly returns `{confidence: 1.0, challenged: false, challengeCount: 0, lastChallengedAt: null, history: []}` — that is correct, not a bug (nothing has moved it yet).

### D4 — `resolveConflict(sourceHandle, targetHandle, { strategy })` (write), gated behind `CAP.CONVICTION`

This is the belief-strength mover, and it is near-irreversible, so the seam — not the consumer — owns every safety invariant. Semantics, pinned:

- In a challenge, you challenge record **X (source)**; each returned conflict is an **existing** record **E (target)** that contradicts X.
- Resolving in X's favor = `strategy: 'accept_new'`, `sourceHandle = X`, `targetHandle = E`. This decays **E** (the contradicted target) by 0.5. The contradicting fact sent to `/resolve` is **derived by the provider from X's stored content via `_renderContent`** (exactly how `challenge` builds its assertion, `smartmemory-provider.js:1184`) — there is no caller-supplied `newFact`.

**All authorization invariants live in the provider (finding #2).** `/resolve` does no re-detection — it fabricates a direct conflict from whatever id + text it is handed (`reasoning.py:180`), so the seam is the only trustworthy gate. `resolveConflict` resolves BOTH handles to real records **via the read-only resolver `_resolveOne` (`smartmemory-provider.js:491`), NOT `_resolveForWrite` (:512)** — the write resolver can reassign duplicate handles and append events as a side effect, which must never run before authorization passes (any duplicate-repair belongs after the invariants hold). It then enforces, before any mutation: (a) both exist (else `FluidRecordNotFound`); (b) both are the **same challengeable kind** (mirrors `challenge`'s kind gate, `smartmemory-provider.js:1157-1161`); (c) `sourceHandle !== targetHandle` (no self-decay); (d) namespace parity (both in `RECORD_NS`). A direct provider caller cannot bypass these by going under the consumer. **Deliberately deferred (disclosed):** the provider does NOT prove that X was ever actually challenged against E — there is no durable challenge record to reference, and re-detection is LLM-based (`challenge` defaults `useLlm:true`, `provider.js:1187`) so deterministic re-detection would false-refuse. The residual risk is a caller pairing two real same-kind records that were never genuinely in conflict; it is workspace-internal, bounded (one 0.5 decay), and history-logged. Provider-issued challenge tokens / persisted challenge records are a later slice.

**Mutation runs inside the workspace lease (finding #5, corrected).** `_withLease(op, fn)` acquires a single fixed workspace lease (`LEASE_KEY = 'compose.fluid.mutate'`, `smartmemory-provider.js:205,691`); its first argument is an operation **label**, not an item id. The whole write sequence — pre-read → resolve → re-read → postcondition — runs inside `_withLease('resolveConflict', fn)`. The guarantee this buys is precise: it **serializes Compose-side fluid mutations within the workspace**, so no two Compose resolves interleave. It does NOT serialize direct (non-Compose) `/resolve` callers — which is exactly why the postcondition has a "someone else moved it" branch below.

**Verify by re-read — never trust the `/resolve` response (findings #1, #4).** `resolve_conflict` ignores `apply_decay`'s boolean return and `ResolveResponse.confidence` is ambiguous, so the effect is judged only by re-reading `/confidence-history` and matching SmartMemory's deterministic contract. Classification is **two-level**: first the *transport* outcome (did we even get a clean answer?), then the *value* match. Getting this order wrong is the round-2 defect: aborting the HTTP wait does NOT stop SmartMemory's synchronous handler (`reasoning.py:159`) — it may mutate *after* we abort — so an unchanged immediate re-read can mean "hasn't landed *yet*," and calling that "safe to retry" can still double-decay.

**Level 1 — transport outcome.** The rule is not "did we get *an* HTTP status" but "did we get a response that *proves the origin `/resolve` handler ran to completion*." The client's error taxonomy (`smartmemory-client.js:207-222`) has exactly four shapes, partitioned as:
- **Authoritative — success:** the SDK call returns a parsed `ResolveResponse` body (the client enforces "a 2xx must be valid, shaped JSON", `:130,227`). The handler ran → go to Level 2.
- **Authoritative — application rejection (`status` 400–499, no `malformed` kind):** a real 4xx means the request was rejected *before* any decay (the `get`/validation failed ahead of the mutation). No decay happened; surface the definite error (e.g. 404 → `FluidRecordNotFound`); nothing to reconcile.
- **Ambiguous — origin outcome unknowable:** any of `status === 0` (timeout/abort/socket — the client collapses all transport failures here, so there is no timeout-specific type to branch on), `kind === 'malformed-response'` (an untrusted 2xx, e.g. a proxy's 200 HTML error page — `:94,209`), OR `status >= 500` (gateway/server 502/503/504 or an origin 500 that may have thrown *after* `apply_decay` mutated). In every one of these the decay may have landed, may be about to land, or never will. Do a **bounded, read-only reconciliation poll** of `/confidence-history` (a few attempts over a short window); if a re-read positively matches the Level-2 *landed* shape, return success. If the window elapses without a positive match, return `FluidResolutionIndeterminate` — **explicitly NOT retryable** (a retry could double-decay if the original mutation lands afterward). Never auto-retry an ambiguous outcome. The load-bearing correction (round 3): a non-zero HTTP status is NOT proof the origin handler finished — only a validated application response is.

**Level 2 — value match after a clean response (or a positive poll hit).** With `pre`/`post` the confidence-history reads bracketing the resolve, the newest `post` history event `ev`, and `expected = max(0, pre.current_confidence − 0.5)`, the outcomes are exhaustive and each is typed:

- **Landed (success)** — ALL of: `post.challenge_count === pre.challenge_count + 1`; `|post.current_confidence − expected| < 1e-9` (epsilon, not `===` — the value round-trips Python→JSON→JS and a legacy non-power-of-two confidence must not false-alarm a destructive-write check); `|ev.oldConfidence − pre.current_confidence| < 1e-9` and `|ev.newConfidence − expected| < 1e-9` and `ev.decayFactor === 0.5`; **and causal attribution** — `ev.reason === 'manual_resolution:accept_new'` and `ev.conflictingFact` equals our source-derived text truncated **by Unicode code point**, i.e. `Array.from(newFact).slice(0,200).join('')`, NOT `newFact.slice(0,200)` (the server stamps `conflicting_fact[:200]` via Python, which slices code points; JS `String.slice` cuts UTF-16 code units, so an astral char like an emoji near the 200 boundary would make a genuinely-landed irreversible decay mis-classify as `Indeterminate` — `challenger.py:381` → `confidence.py:73`). Attribution is what distinguishes *our* decay from a concurrent non-Compose `accept_new` that produced numerically identical values. → return the updated `ConvictionResult`.
- **Clean no-op (retryable)** — `post.challenge_count === pre.challenge_count` AND confidence and history are byte-for-byte unchanged. Because the response was clean, the handler is *done* and did nothing → `FluidResolutionNoOp`; safe to retry. (This is the ONLY retryable non-success outcome — it is safe precisely because we got a clean response, unlike the Level-1 ambiguous case.)
- **External interference** — `post.challenge_count > pre.challenge_count + 1`, OR count advanced by exactly 1 but attribution is not ours (someone else's `accept_new` landed our target; ours therefore did not) → `FluidResolutionConflict`. Never auto-retry; the caller re-reads and re-decides.
- **Invariant violation / indeterminate** — anything else: count advanced but confidence or event mismatched (partial or corrupt write); count unchanged but confidence/history changed; count regression; malformed/NaN values; or the reconciliation read itself failed → `FluidResolutionIndeterminate`. Implies partial mutation or an incompatible runtime, NOT a retryable no-op. No retry.

The exact-confidence clause (not a mere "count advanced") is load-bearing twice over: it catches the 0.0-floor case correctly (count advances, confidence legitimately stays 0.0, `expected = max(0, 0−0.5) = 0` matches → success), and it is the guard that makes the #4 unreleased-runtime defer safe — a **pre-fix** SmartMemory still advanced metadata `challenge_count` on a partial write (repro, `foh-4-progress.md:73`) but left confidence at 1.0, so it lands in *invalidate/indeterminate*, not success, where a count-only check would have passed a broken runtime.

Steps (all inside `_withLease('resolveConflict', …)`): read-only-resolve `sourceHandle` + `targetHandle` → item ids (`_resolveOne`); enforce invariants (a)–(d); validate `strategy` against the v1 allowlist (D5); derive `newFact = _renderContent(source)`; **pre-read** `confidenceHistory(target_id)`; call `client.resolveConflict`; classify by Level 1 then Level 2 (with a bounded reconciliation poll on ambiguous transport); return the updated `ConvictionResult` for `targetHandle` only on the *landed* outcome. No default strategy — a missing/unknown strategy is refused, never silently deferred.

### D5 — v1 strategy allowlist: `accept_new` ONLY (finding #5)

`CONVICTION_STRATEGIES = ['accept_new']` in v1. `accept_new` is the only strategy that produces an **observable effect at the seam** (decays existing 0.5, one history event). The others were dead paths from Compose's vantage and are refused in v1:
- `keep_existing` — "reject the new assertion, no decay." Expressible by simply **not calling** `resolveConflict`; it moves nothing conviction can read. Excluded.
- `keep_both` / `defer` — write server-side markers (`has_conflict` / `needs_review`) that **nothing in Compose reads**. Shipping them would repeat the exact "green endpoint, dead capability" failure v1b exists to avoid. Excluded.
- `merge` — server action is "requires manual review," no deterministic effect. Excluded.

Passing any strategy other than `accept_new` is refused (`FluidInvalidStrategy`). Deferring the fuller taxonomy keeps v1 narrow and honest (ship-narrow-first); a resolution-envelope seam surfacing the other outcomes has no consumer today and is a later slice if one appears. The `strategy` parameter is retained (not defaulted) so the gate stays explicit and the allowlist can widen later without a signature change.

### D6 — Capability declaration moves with the methods

Add `CAP.CONVICTION` to `capabilities()` in `smartmemory-provider.js` in the same commit that implements `conviction()` + `resolveConflict()` — never declare ahead of implementation (PROVIDER-SEAM). CALIBRATION/CONTRADICTION stay undeclared.

**The base `FluidProvider` must gain a `resolveConflict` refusal stub (finding #4, P2).** Today the base declares only `conviction()` (`provider.js:500`); a non-SmartMemory provider that lacks `CAP.CONVICTION` would throw a raw `TypeError` on `resolveConflict` instead of the seam's capability refusal. Add `async resolveConflict(_source, _target, _opts) { this.require(CAP.CONVICTION); return NI('resolveConflict'); }` alongside `conviction()`, so every provider refuses uniformly with `FluidCapabilityUnavailable` (this is also what the seam-refusal test asserts).

### D7 — Consumers in `lib/fluid/ideabox-ops.js` (not seam-only)

Mirror FOH-3's `challengeIdea` (kind-agnostic `getRecord`, `String(id).toUpperCase()` normalization). **Both consumers open with the mandatory ideabox preamble `ensureIdeaboxMigrated` + `gate(ctx)` (finding #6, `ideabox-ops.js:21,144`)** — every ideabox op runs it, and omitting it returns not-found instead of migrate-then-resolve on markdown-only projects. The write consumer needs it doubly (it mutates).

Now that every authorization invariant lives in the provider seam (D4, finding #2), the consumers are thin: preamble → normalize ids → call the provider → map errors. They no longer carry their own kind/self checks (the provider is the single source of truth, so a direct provider caller can't bypass them).

- `convictionOf(ctx, id)` — preamble, then read an idea/decision's conviction. Maps `FluidRecordNotFound → IdeaboxNotFound`.
- `resolveIdeaChallenge(ctx, id, { against, strategy })` — preamble, normalize both ids, then call `provider.resolveConflict(sourceHandle=id, targetHandle=against, { strategy })`. `id` is the challenged record X (the provider derives the contradicting fact from X's stored content); `against` is the target record E (a conflict handle from a prior `challengeIdea`) that gets decayed. Maps `FluidRecordNotFound → IdeaboxNotFound`; surfaces `FluidInvalidStrategy` / `FluidResolutionNoOp` / `FluidResolutionConflict` to the caller. `against` is required (no default) — a missing target is a caller error, refused at the consumer before the provider call.

The v1 trust boundary is disclosed in the JSDoc: the caller passes an `against`/target handle it obtained from a real `challengeIdea(id)` result. The provider guarantees the target is a real same-kind non-self record, but not that it was genuinely challenged (see D4's deferred challenge-binding).

### D8 — Mutation safety & autonomy dial (the load-bearing owner concern)

- **Gated, never automatic.** The strategy is always caller-supplied; there is no auto-resolve and no default. This is the gate end of the gate/flag/skip dial.
- **Near-irreversible, disclosed.** A 0.5 drop cannot be undone Compose-side (no fluid reinforce path). Documented in the method JSDoc and surfaced to the consumer.
- **Idempotency caveat, disclosed + partly guarded.** Two *intentional* `accept_new` calls decay twice (1.0 → 0.5 → 0.0); v1 does not dedupe deliberate re-resolution — that is the caller's responsibility. What v1 DOES guard is the dangerous case: an *accidental* retry after a network timeout. Because a timed-out resolve returns `FluidResolutionIndeterminate` (D4, finding #3) — never a "safe to retry" verdict, since aborting the wait does not stop the server's synchronous mutation — one intended resolution cannot silently become two. Full cross-caller idempotency (a server-side operation ID covering non-Compose callers, which would let an indeterminate outcome be safely retried) is deferred to a SmartMemory enhancement.

## Test plan (golden + edges)

Stubs model the **post-fix** contract exactly: `/confidence-history` returns `{item_id, current_confidence, challenge_count, history, history_count}` with `current_confidence` moving on decay (field semantics), and `/resolve` `accept_new` applies a 0.5 decay + one history event + advances `challenge_count`.

- **Golden loop:** store two contradicting same-kind decisions A and B; `challengeIdea(A)` returns a conflict pointing at B; `resolveIdeaChallenge(A, {against: B, strategy: 'accept_new'})`; `convictionOf(B)` → `confidence: 0.5`, `challenged: true`, `challengeCount: 1`, `lastChallengedAt` non-null, one history event with `newConfidence: 0.5`. (Assert `/resolve` received `new_fact` = A's rendered content, not caller text.)
- Read on never-resolved record → `{confidence: 1.0, challenged: false, challengeCount: 0, lastChallengedAt: null, history: []}`.
- **Strategy gate (#5):** any strategy other than `accept_new` (`keep_existing`/`keep_both`/`defer`/`merge`/unknown) and missing strategy → refused with `FluidInvalidStrategy`, no `/resolve` call made.
- **Provider-seam authorization (#2) — tested at the PROVIDER, not just the consumer** (a direct provider caller must not bypass): missing/not-found source or target → `FluidRecordNotFound`; source and target of different kinds → refused; `sourceHandle === targetHandle` (self-decay) → refused; cross-namespace target → refused; all before any `/resolve` call.
- **Exact-value postcondition (#1/#4):** stub `/resolve` returning a CLEAN 200 but (a) not advancing `challenge_count` and leaving state unchanged → `FluidResolutionNoOp` (retryable); (b) advancing count but leaving confidence at the pre-value (stale/partial-write shape) → `FluidResolutionIndeterminate`, NOT success (exact-confidence clause fires). Floor case: target at `confidence: 0.0` re-resolved advances count, expected `max(0,0−0.5)=0` matches → SUCCEEDS.
- **Causal attribution (#2 r2):** clean 200, count `pre+1`, confidence matches, but the newest event's `conflictingFact`/`reason` are NOT ours (a concurrent non-Compose `accept_new` with identical numbers) → `FluidResolutionConflict`, never mistaken for our success. Count jumps by 2 → `FluidResolutionConflict`.
- **Ambiguous transport (#3 r2):** `client.resolveConflict` fails with `status:0` (timeout/abort). (i) Bounded reconciliation poll then sees a landed+attributed decay → success. (ii) Poll window elapses with count still `pre` → `FluidResolutionIndeterminate`, and the test asserts **no retry** is issued (aborting the wait does not stop the server's mutation, so an unchanged read is NOT "safe to retry").
- **Untrusted response never becomes a retryable no-op (#1 r3):** each of a `status:200 kind:'malformed-response'` (proxy 200 HTML page) and a `502`/`504` gateway error, paired with a server that DID mutate afterward → provider reconciles to success (or `Indeterminate`), and the test asserts it is **never** `FluidResolutionNoOp`. A `404`/`422` application error → authoritative failure with no reconciliation poll and no decay.
- **Attribution truncation is code-point exact (#2 r3):** a `newFact` with an astral character (emoji) straddling the 200th code point → the provider's `Array.from(...).slice(0,200)` comparison matches the server's `[:200]` and the landed decay is recognized as success (a UTF-16 `slice` would false-fail it to `Indeterminate`).
- **Lease (#5):** the pre-read→resolve→re-read sequence runs inside `_withLease('resolveConflict', …)` (spy that the workspace lease brackets the `/resolve` call).
- **Migrate/gate preamble (#6):** `convictionOf`/`resolveIdeaChallenge` on a markdown-only project migrate then operate (assert `ensureIdeaboxMigrated`/`gate` ran), not a bare not-found.
- `conviction`/`resolveConflict` on a provider without `CAP.CONVICTION` → `FluidCapabilityUnavailable` (seam refusal test — exercises the new base `resolveConflict` stub, D6/#4, so a non-SmartMemory provider refuses cleanly rather than `TypeError`).
- Handle not found (read and write) → `FluidRecordNotFound` / `IdeaboxNotFound`.
- Wire-contract flip: `resolveConflict` sends `auto_resolve:false`/`use_llm:false`/`use_wikipedia:false` (request-body inspection); a second intentional resolve decays again (0.5→0.0) and the exact-value postcondition passes both times.

## Rollout

Compose-side wiring: new client wrappers, two provider methods, one capability line, two consumers, plus a stub `/resolve` + `/confidence-history` route in the test harness modeling the exact post-fix `apply_decay` behavior.

**Hard dependency (finding #4):** this slice depends on the landed SmartMemory fix — `smart-memory-core@2841909` + `smart-memory-service@3c79ddc` — for decay to persist to the canonical field. **Both are on `main` and pushed but UNRELEASED** (the core fix sits on top of the 1.4.64 release commit; the service synced 1.4.64 *before* its own fix). A compatible SmartMemory build is a **hard ship prerequisite**, documented at the capability. Two safety layers back the two paths:

- **Write path is self-protecting.** Against a stale (pre-fix) runtime, the D4 exact-value postcondition fails loud: a pre-fix service advances metadata `challenge_count` on a partial write but leaves `current_confidence` at 1.0, so the confidence clause fires and the resolve is reported failed rather than silently corrupting belief-strength. (This is why the #1 tightening — exact value, not count-only — is load-bearing for the #4 defer.)
- **Read path degrades quietly.** `conviction()` against a stale runtime just reports 1.0 — wrong but non-destructive. The documented ship prerequisite covers it; a fuller guard (provider-init version negotiation that refuses `CAP.CONVICTION` against an incompatible runtime) is noted as a follow-up, not built in v1.

**Phase-7 gate:** confirm the smart-memory-service instance Compose talks to in E2E/live-fire runs source-at-`main`. If a service restart is needed to pick up `main`, ASK the owner first (no-kill-ports rule); do not restart silently.

Epic COMP-FOH stays IN_PROGRESS (CALIBRATION/CONTRADICTION/portfolio deferred).

## Blueprint entry-gates (Phase 4-5)

Verified live post-fix 2026-08-10 — carried as facts, re-confirm cheaply if the wire drifts:

1. **VERIFIED — read path is one call.** `/confidence-history` returns `{item_id, current_confidence (field-read via `_item_confidence`), challenge_count, history, history_count}` (`reasoning.py:348`). No `getItem` needed for the read; `challenged`/`lastChallengedAt` are derived (D1).
2. **Verify in blueprint** — provider handle→item_id resolution: authorization uses the **read-only** `_resolveOne` (`smartmemory-provider.js:491`), NOT `_resolveForWrite` (`:512`, which can reassign duplicate handles + append events and must not run pre-authorization). `_withLease(op, fn)` takes an **operation label** (`:691`), not an item id — the resolved `target_id` is used only for the confidence-history reads and the `/resolve` body, not for the lease key.
3. **VERIFIED — envelope + event keys** as in (1); event keys `{timestamp, old_confidence, new_confidence, decay_factor, reason, conflicting_fact?}` (`confidence.py:65-73`).
4. **VERIFIED — do NOT trust `ResolveResponse.confidence`.** `challenger.py` unchanged by the fix; `resolve_conflict` ignores `apply_decay`'s return and the response confidence is ambiguous (`reasoning.py:217`). Authoritative post-decay value comes from the D4 re-read of `/confidence-history` (drives the #4 postcondition).
5. **Verify in blueprint** — error classes: reuse `FluidRecordNotFound`/`IdeaboxNotFound`; add the write-outcome types if no existing class fits — `FluidInvalidStrategy` (#5), `FluidResolutionNoOp` (clean-response no-op, retryable), `FluidResolutionConflict` (external interference — count jumped, or an unattributable decay), and `FluidResolutionIndeterminate` (ambiguous transport / partial or corrupt write / incompatible runtime — **not retryable**). The design's hard requirement is that these four write outcomes are *distinguishable to the caller* and that only `FluidResolutionNoOp` is documented as safe to retry; exact class-vs-`reason`-field factoring is a blueprint naming call. Confirm against `provider.js` error classes before inventing.
