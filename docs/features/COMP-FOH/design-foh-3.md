# COMP-FOH / FOH-3 — CHALLENGE: contradiction detection over the fluid corpus

**Status:** DESIGN (gate pending) · **Epic:** COMP-FOH · **Date:** 2026-08-09 · **Slice:** FOH-3
**Owner directive:** `/compose build FOH` → "Scope + build CHALLENGE (FOH-3)"

## Related Documents

- Parent design: [design.md](design.md) — the challenge rung (rung 4) is mapped there to SmartMemory's `challenge_assertion` facade.
- Architecture: [architecture.md](architecture.md) §Sequencing — CHALLENGE named as deferred-past-FOH-2, "needs a real consumer or SmartMemory ontology work." Explorer confirms the SmartMemory surface is READY; this doc resolves the consumer question.
- Precedent: [blueprint-foh-2.md](blueprint-foh-2.md) — FOH-2 (recall) is the exact pattern this slice mirrors.
- Wire contract: SmartMemory `smart-memory-service/.../routes/reasoning.py:34-139`; JS SDK reference `smart-memory-sdk-js/src/api/ReasoningAPI.js:28-34`.
- Ledger: [foh-3-progress.md](foh-3-progress.md).

## Problem

The fluid provider can store front-of-house records (ideas, decisions, threads, questions, clusters) and recall them by meaning (FOH-1, FOH-2). It cannot yet do the thing that makes a colleague a *colleague* rather than a filing cabinet: **push back**. When you float "we should build X," nothing checks whether X contradicts a decision you already made, an idea you already killed, or a position already on record. That is Discovery-Loop rung 4 (adversary/challenge), and today the capability is declared in the seam enum but every provider inherits the base refusal (`lib/fluid/provider.js:464`).

## Goal

Ship `CAP.CHALLENGE` on `SmartMemoryFluidProvider`: given a stored record, surface what in the fluid corpus contradicts it, with a confidence score and a suggested resolution — by wiring SmartMemory's already-shipped `POST /memory/reasoning/challenge` endpoint. Same character of work as FOH-2: one client wrapper + one provider method + one capability line.

### Non-goals (disclosed boundaries)

- **Not a from-scratch fact-checker.** SmartMemory's `challenge` detects contradictions **against already-stored memory in scope**. It does not verify a claim against the world. External grounding is a *different* endpoint (`/reasoning/resolve`) and a later slice.
- **Not proof trees.** Structured argument (`/reasoning/proof`) is out of scope.
- **No value against an empty corpus.** With little stored, challenge returns `has_conflicts=false` for everything. This is correct, not a bug — there is nothing to contradict yet.
- **Not CONVICTION/CALIBRATION/CONTRADICTION.** Those stay undeclared and inherit refusal.

This contradiction-against-our-own-memory reading is exactly what rung 4 wants ("does this new idea contradict what we already decided?") and matches design.md's own mapping. We proceed on it and disclose the boundary in code.

## What SmartMemory gives us (READY, verified)

`SmartMemory.challenge_assertion(assertion, memory_type="semantic", use_llm=true)` ships all the way out:
facade (`smart_memory.py:3060`) → secure wrapper (`secure_smart_memory.py:1517`) → HTTP `POST /memory/reasoning/challenge` (`reasoning.py:85`) → published SDK `client.reasoning.challenge` (`ReasoningAPI.js:28`). **No SmartMemory-side work is required.**

- **Request:** `{assertion: string, memory_type="semantic", use_llm=true}`. Scope (`user_only`) comes from the auth/workspace context, exactly like Compose's scoped `searchItems` — so the wrapper goes through the **scoped** client (default `scoped:true`), not the unscoped `search()`.
- **Response:** `{new_assertion, has_conflicts, conflicts[], related_facts_count, overall_confidence}`.
- **Each conflict:** `{existing_item_id, existing_fact, new_fact, conflict_type, confidence, explanation, suggested_resolution}` where `conflict_type ∈ {direct_contradiction, temporal_conflict, numeric_mismatch, entity_confusion, partial_overlap}` and `suggested_resolution ∈ {keep_existing, accept_new, keep_both, merge, defer}`.
- The only Compose gap: `lib/smartmemory-client.js` doesn't expose a `challenge` wrapper — the same gap FOH-2 filled for `searchItems`. It's a ~6-line mirror of `searchItems` (`:413-419`).

### Feasibility crux resolved — `memory_type` is an EXACT type filter (Codex verify, run 310cecc9)

The challenge default `memory_type="semantic"` would have been a **silent no-op** against our corpus. Proven mechanism:
- `sm.search`'s `memory_type` is an exact **post-retrieval equality filter** on the item's stored type — `[item for item in results if item.memory_type == memory_type]` (`smart-memory-core/.../pipeline/stages/search.py:123-155`, `:204-223`). Candidates are generated **untyped**, then filtered. It is not an index router.
- Our records keep their `fluid_<kind>` type verbatim through ingest (`crud.py:486`, `classify.py:101`, `store.py:79`). So `"semantic"` matches **zero** fluid records.
- Recall (FOH-2) works only because it sends `memory_type=None` (no filter) — `request_models.py:57`, `crud.py:1506`. Challenge's HTTP field is a **non-optional `str` defaulting to `"semantic"`** (`reasoning.py:34`), so it can never send `None`.
- **Fix (Compose-side):** send the record's exact wire type, e.g. `memory_type="fluid_decision"`. That matches. **There is no wildcard** that matches all `fluid_*` kinds in one call, and one call covers one kind.
- **Underfill bound (disclosed, not fixable Compose-side):** the exact-type filter runs after an untyped candidate window (`top_k*2` server-side, sized by the challenger's `max_related_facts`, not a request param). If the workspace holds many non-matching items, the matching same-kind records may not enter the window, so a real contradiction can be missed. Same shape as recall's over-fetch bound; asserted so a future change is deliberate.

## Design decisions

### D1 — `ChallengeResult` is part of the seam (not whichever provider gets there first)

Mirror how `RecallHit` is locked in `provider.js`. The seam shape:

```
ChallengeResult = {
  assertion: string,        // the text that was challenged
  hasConflicts: boolean,    // DERIVED from retained conflicts (see D1c), NOT the server's pre-filter value
  confidence: number,       // DERIVED from retained conflicts (see D1c)
  conflicts: Conflict[],    // best-first, sorted by confidence desc
}
Conflict = {
  handle: string,           // the FLUID record the conflict is against (see D1a)
  existingText: string,     // existing_fact
  conflictType: string,     // passthrough enum
  confidence: number,       // 0..1
  explanation: string,
  suggestedResolution: string,  // passthrough enum
}
```

**D1a — surface only fluid-corpus conflicts.** SmartMemory's conflicts carry a raw `existing_item_id`, and its search spans *all* memory in scope (fluid records AND, if present, kitchen exhaust or other items in a shared workspace). Recall's hard rule governs here: *"a shared workspace holds items that are not ours at all, and they must never reach a caller"* (`smartmemory-provider.js:1088`). So challenge applies the same discipline — resolve each conflict's `existing_item_id` (fetch the item, check `metadata.fluid_ns === RECORD_NS`), keep only fluid conflicts, and rewrite `existing_item_id → metadata.handle`. Non-fluid conflicts are dropped, not returned with a null handle: leaking a foreign item's text is the exact thing recall forbids. Cost is one `getItem` per conflict; conflicts are small-N (the LLM cascade returns a handful, not hundreds).

**D1b — exclude self.** The challenged record's own text is in the corpus, so it can come back as a "related fact." Drop any conflict whose resolved handle equals the challenged handle — a record does not contradict itself, and reporting it would be noise.

**D1c — aggregates are derived from the RETAINED conflicts, not the server's.** SmartMemory computes `has_conflicts` and `overall_confidence` over its *pre-filter* conflict set (`challenger.py:232`). After D1a/D1b drop foreign and self conflicts, those server aggregates are stale: they could report `has_conflicts:true` with an empty retained list, or a confidence shaped by conflicts the caller never sees. So the provider **recomputes** both from what survives filtering: `hasConflicts = conflicts.length > 0`; `confidence` via SmartMemory's own formula over the retained set (`max(0, 1 - (mean(retained.confidence) * 0.5))`, `challenger.py:256-262`), and `1.0` when the retained set is empty. The result never disagrees with itself.

### D2 — consumer: minimal `challengeIdea(ctx, id)` op  ⟵ LOCKED (owner, 2026-08-09)

FOH-2 shipped `recall()` with **zero callers** anywhere in the repo — a seam built ahead of any consumer. We do NOT repeat that here. Add a thin `challengeIdea(ctx, id)` operation in `lib/fluid/ideabox-ops.js` (parallel to `addDiscussion`, `:464`) that:
1. resolves the record **kind-agnostically** via `provider.getRecord(String(id ?? '').toUpperCase())` — NOT the idea-only `findIdea` (`:166`, which does `listRecords({kind: IDEA})` and would make a decision handle unresolvable, contradicting decision-first scope). The `.toUpperCase()` normalization is required: `getRecord` rejects lowercase handles (`HANDLE_RE`, `record-shape.js:53`), while `findIdea` normalizes case — passing raw `id` would drop that behavior, so a lowercase `idea-3`/`decision-3` must still resolve. Unknown id ⇒ `IdeaboxNotFound`, as the other ops do.
2. requires `provider.has(CAP.CHALLENGE)` (else a clean capability-unavailable path).
3. calls `provider.challenge(handle)` and returns the `ChallengeResult`. The provider enforces `CHALLENGEABLE_KINDS` (D3a): a `thread`/`question`/`cluster` id resolves fine but `challenge()` throws `FluidKindUnsupported`.

~15 lines; wires the rung to the ideabox surface the pilot already uses and gives the review loop something real to exercise end-to-end.
- Naming follows the existing `*Idea` convention of `ideabox-ops.js`. It operates on the two **challengeable** kinds (decision, idea), resolved kind-agnostically; same-kind scoping then follows the resolved record's kind.
- **Deferred regardless:** a CLI subcommand / MCP tool / UI affordance — that's a surface slice, not this one.

### D3 — input model: challenge a stored record against its OWN kind (forced by the exact-type filter)

Keep the base signature `challenge(handle, opts)`. Flow: `getRecord(handle)` → `_renderContent(record)` (title + body + discussion, the same projection recall indexes) → `client.challenge(text, { memoryType: wireTypeFor(record.kind) })` → filter/map conflicts (D1a/D1b).

**Same-kind scoping is not a preference — it is what the wire allows.** Because `memory_type` is an exact filter with no wildcard (see Feasibility crux), the only way to get *any* fluid hits in one call is to send one fluid kind. So v1 challenges a record against **other records of its own kind**: a decision vs. other decisions, an idea vs. other ideas. This is the most meaningful case (decisions contradicting decisions is the canonical adversary check).

**D3a — challengeable kinds are `{decision, idea}`, and other kinds are refused.** The explicit endpoint runs `AssertionChallenger.challenge()` **directly** (`reasoning.py:107`); it does NOT invoke the ingest-time `should_challenge` gate (`smart_memory.py:1768`). So there is no built-in safety that makes challenging a `thread`/`question`/`cluster` return nothing — the detection cascade runs regardless and could emit spurious conflicts on non-assertional text. Therefore the provider defines `CHALLENGEABLE_KINDS = {decision, idea}` and `challenge(handle)` throws the seam's existing `FluidKindUnsupported` (`provider.js:206`) for any other kind — the same typed error the write path already uses for unsupported kinds (no new error type). Decisions and ideas are assertion-shaped; the rest are not, and are out of scope for v1 rather than fed to the cascade on a false safety assumption.

- **Deferred: cross-kind challenge** (a decision contradicting an idea). Reachable only by fanning out one call per fluid kind and unioning conflicts — N× the LLM cost and N× the underfill bound. Not v1. The seam signature does not change when it arrives; only the provider's internal fan-out does.
- A missing/unknown handle throws the same not-found the other by-handle ops throw.
- **`opts.useLlm`** is exposed (default matches SmartMemory's `true`).
- **`opts.timeoutMs` — challenge needs its own deadline.** The client's default timeout is 3s (`smartmemory-client.js:85`), and it spans the body read. With `useLlm:true` the endpoint runs an LLM cascade over up to ~10 related facts sequentially (`challenger.py:220`), which routinely exceeds 3s — the wrapper would abort a valid challenge. So the challenge path takes a **challenge-appropriate per-call timeout** (default ~30s), overriding the client default for this call only, so other calls keep their tight hang-detection. The client today only accepts `timeoutMs` at construction (`smartmemory-client.js:85`); the blueprint must thread a per-call `timeoutMs` into `fetchWithContract` for the challenge method (a small, additive client change) rather than bump the whole client — the fluid provider's CRUD/recall calls should keep the 3s hang-detection.

## Capability declaration

```
capabilities() {
  return new Set([STORAGE_CAP.RECORDS, STORAGE_CAP.EVENTS, STORAGE_CAP.LINKS, CAP.RECALL, CAP.CHALLENGE]);
}
```

Per PROVIDER-SEAM, declaring `CAP.CHALLENGE` and implementing `challenge()` move together in one commit — never a declared-but-unimplemented capability.

## Disclosed bounds (to encode in code comments + assert in tests)

1. **Contradiction-vs-stored-memory only** — not world fact-check, not proof (see Non-goals).
2. **Same-kind scoped** — a record is challenged only against others of its own kind (D3), forced by the exact-type filter; cross-kind is deferred.
3. **Challengeable kinds `{decision, idea}`** — other kinds are refused (D3a). The endpoint runs the cascade directly with no `should_challenge` gate, so non-assertional kinds are not fed to it on a false safety assumption.
4. **Fluid-corpus scoped** — conflicts against non-fluid items are dropped (D1a); self excluded (D1b); aggregates recomputed from what remains (D1c).
5. **Candidate-window underfill** — the exact-type filter runs after an untyped candidate window, so a contradiction outside that window is missed (Feasibility crux). Disclosed, not fixable Compose-side.
6. **Corpus-dependent** — sparse workspace ⇒ `hasConflicts:false`; asserted so a future change is deliberate.
7. **LLM-cascade nondeterminism** — with `useLlm:true` conflict text/confidence vary run-to-run, so it is NOT used for the deterministic assertion. The golden flow runs with `useLlm:false` against a fixture the heuristic detector catches (see Test plan); LLM option-forwarding is verified separately without asserting on LLM output.

## Test plan (golden flow + edges)

- **Golden (same-kind, deterministic):** store two **decisions** whose text is a heuristic-detectable negation pair — e.g. `"Postgres is the datastore"` and `"Postgres is not the datastore"` (matches the `("is not","is")` pattern with shared non-stopword tokens, `heuristic.py:13`). `challenge(handleA, {useLlm:false})` → sends `memory_type="fluid_decision"` → `hasConflicts:true`, a conflict whose `handle` is the other decision's fluid handle, self excluded. Deterministic because the heuristic detector, not the LLM, decides.
- **Aggregate consistency (D1c):** a fixture where the only server-side conflicts are foreign/self ⇒ retained `conflicts:[]` AND `hasConflicts:false` AND `confidence:1.0` (asserts the aggregates are recomputed from the retained set, not passed through from the server). A second case with one retained + one filtered conflict asserts `confidence` reflects only the retained one.
- **Same-kind scoping:** a contradicting **idea** in the workspace is NOT surfaced when challenging a decision (proves the exact-type filter is wired, D3).
- **Challengeable-kind gate (D3a):** `challenge()` of a `thread`/`question`/`cluster` handle throws `FluidKindUnsupported`; `challengeIdea` of an unknown id throws `IdeaboxNotFound`.
- **Case-insensitive id:** `challengeIdea('decision-3')` (lowercase) resolves the same record as `'DECISION-3'` (normalization parity with the other ops).
- **Namespace filter:** a non-fluid item that would conflict is dropped from results (D1a).
- **Empty/sparse:** `challenge` of a lone decision ⇒ `hasConflicts:false`, `conflicts:[]`.
- **Capability gate:** floor/local provider without CHALLENGE throws `FluidCapabilityUnavailable`; SmartMemory provider `has(CAP.CHALLENGE) === true`.
- **Client wrapper:** `challenge` posts to `/memory/reasoning/challenge` through the scoped client with the exact `memory_type` and the per-call `timeoutMs`; `requireShape` guards on `has_conflicts`/`conflicts`. LLM option-forwarding asserted by inspecting the request body (`use_llm`), not the response.
- **Not-found:** unknown handle throws.

## Files (blueprint will ground each)

- `lib/smartmemory-client.js` (existing) — add `challenge(assertion, {memoryType, useLlm, timeoutMs})` wrapper (mirror `searchItems` :413-419, scoped), expose at `:467-472`; thread a per-call `timeoutMs` into `fetchWithContract` for this method (small additive change — see D3 timeout note).
- `lib/fluid/provider.js` (existing) — lock `ChallengeResult`/`Conflict` JSDoc shape above `challenge()` (`:463`), as `RecallHit` is locked above `recall()`.
- `lib/fluid/smartmemory-provider.js` (existing) — implement `challenge(handle)` (same-kind, `CHALLENGEABLE_KINDS={decision,idea}` gate, D1a/D1b/D1c filtering + derived aggregates), add `CAP.CHALLENGE` to `capabilities()` (`:216`).
- `lib/fluid/ideabox-ops.js` (existing, if D2 accepted) — `challengeIdea(ctx, id)`.
- `test/**` — new suite mirroring the FOH-2 recall suite, real backend.

## Gate decisions (owner, 2026-08-09) — APPROVED

- **Scope:** same-kind, decision-first v1. Cross-kind fan-out deferred. (Forced by the exact-type wire filter.)
- **Consumer:** ship the `challengeIdea(ctx, id)` op (D2). Not provider-only.
- **Reading:** contradiction-detection against stored same-kind memory (not world fact-checking — that's `/reasoning/resolve`, a later slice).

→ Proceed to Codex design-gate review, then Phase 4 (blueprint).
