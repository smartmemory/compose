# COMP-FOH / FOH-3 (CHALLENGE) — progress ledger

**Started:** 2026-08-09 · **Owner directive:** `/compose build FOH` → "Scope + build CHALLENGE (FOH-3)"
**Lifecycle:** build mode, full lifecycle (design → blueprint → plan → implement → ship)

## State of the epic on entry
- FOH-1 (storage) + FOH-2 (recall) SHIPPED. Provider declares `{RECORDS, EVENTS, LINKS, RECALL}` (`lib/fluid/smartmemory-provider.js:217`).
- `CHALLENGE/CONVICTION/CALIBRATION/CONTRADICTION` defined in enum, undeclared, inherit base refusal (`lib/fluid/provider.js:463-473`).
- Architecture doc deferred all of these pending "SmartMemory-side ontology work not yet scoped, or a real consumer that doesn't exist yet" (`architecture.md:92`).
- Working tree clean at entry. No `report.md`; epic still IN_PROGRESS, lifecycle stale at `explore_design`.

## Load-bearing findings (Phase 1 exploration)
1. **Compose-side client has NO challenge method.** `lib/smartmemory-client.js` methods: health, ingest, search, createItem, getItem, listItems, updateItem, searchItems, deleteItem, allocateSequence, peekSequence, acquireLock, renewLock, releaseLock (`:235-467`). So FOH-3 is NOT the pure-provider-wiring FOH-2 was (FOH-2 reused existing `searchItems`).
2. **`recall()` has ZERO consumers repo-wide** (only a doc mention in `factory.js:13`). FOH-2 shipped the capability seam-ahead-of-consumer. → Design fork for FOH-3: mirror that (provider-only) vs. also add a consumer (`challengeIdea` in `ideabox-ops.js`, parallel to `addDiscussion` at `:464`).
3. **Base contract:** `challenge(handle, opts)` — challenges an already-STORED record by handle. Return shape is UNSPECIFIED in the seam today (unlike `RecallHit`, which is spec'd as "part of the seam"). → Design must define `ChallengeResult` at the seam level.

## Open gating question (explorer running: a61d13e0)
Does SmartMemory expose `challenge_assertion` over HTTP + does a JS client method exist?
- (a) READY → FOH-3 = pure Compose wiring (new client method + provider method).
- (b) PARTIAL (HTTP yes, JS client no) → add client method + provider method, Compose-side only.
- (c) FACADE-ONLY (Python core, no HTTP) → **FOH-3 blocked on SmartMemory-side work**; surface to owner.
- (d) ABSENT → re-scope.

## Explorer verdict (a61d13e0) — READY (a)
SmartMemory ships challenge end-to-end, NO SmartMemory-side work needed:
- Facade `SmartMemory.challenge_assertion(assertion, memory_type="semantic", ...)` (smart_memory.py:3060).
- HTTP: `POST /memory/reasoning/challenge`, req `{assertion, memory_type="semantic", use_llm=true}`, resp `{new_assertion, has_conflicts, conflicts[], related_facts_count, overall_confidence}` (service reasoning.py:34-139). Scope = `user_only`, workspace-bound like searchItems.
- Published SDK `client.reasoning.challenge` exists (ReasoningAPI.js:28) — but Compose bypasses SDK namespaces, so we add a wrapper to `lib/smartmemory-client.js` (mirror `searchItems` :413-419, SCOPED client). Same step FOH-2 took.
- Conflict shape: `{existing_item_id, existing_fact, new_fact, conflict_type, confidence, explanation, suggested_resolution}`. conflict_type ∈ {direct_contradiction, temporal_conflict, numeric_mismatch, entity_confusion, partial_overlap}.

## LOAD-BEARING SEMANTIC FACT (shapes the design)
SmartMemory `challenge` = **contradiction detection against ALREADY-STORED memory in scope**. It takes an assertion string, semantic-searches existing memory, returns what contradicts it + confidence. It is NOT a from-scratch fact-checker (that's `/reasoning/resolve`) and NOT proof trees (`/reasoning/proof`). Against an empty/sparse corpus it returns `has_conflicts=false` for everything.
→ This IS the right meaning for Discovery-Loop rung 4 ("does this new idea/decision contradict what we already decided/believe?"). Aligns with design.md's own mapping of the challenge rung to `challenge_assertion`. Proceed on this reading; disclose the boundary.

## FEASIBILITY VERDICT (Codex 310cecc9, sol/high, evidence chain) — (B) FIXABLE COMPOSE-SIDE
- `memory_type` is an EXACT post-retrieval equality filter (search.py:123-155), NOT an index router. Candidates untyped → filtered `item.memory_type == memory_type`.
- Fluid records keep `fluid_<kind>` type verbatim (store.py:79, classify.py:101). So challenge's default `"semantic"` = ZERO fluid hits (silent no-op avoided).
- Recall works only because it sends `memory_type=None` (crud.py:1506). Challenge field is non-optional `str="semantic"` — can't send None.
- FIX: send exact wire type `memory_type="fluid_decision"`. NO wildcard for all `fluid_*`; one call = one kind.
- Underfill bound: type filter runs after untyped candidate window (top_k*2, server-sized) → a same-kind contradiction outside the window is missed. Disclosed, not fixable Compose-side.
→ NOT blocked. Reshapes v1 to SAME-KIND scoping (decision vs decisions). Cross-kind = fan-out, deferred.

## Design decisions locked/recommended
- D1 ChallengeResult seam shape: define at seam level (like RecallHit). Surface only FLUID-corpus conflicts (map existing_item_id→fluid handle; consistent with recall's hard namespace-filter rule "items not ours must never reach a caller").
- D2 consumer: RECOMMEND minimal `challengeIdea(ctx, id)` op in ideabox-ops.js so it's not dead-on-arrival (recall shipped with zero callers). FOH-2 precedent = provider-only. → OWNER CALL at gate.
- D3 input model: keep base signature `challenge(handle)` — load record, render its text (title+body+discussion like recall), challenge against the rest, exclude self. Arbitrary-text challenge deferrable without breaking the shape.

## OWNER GATE DECISIONS (2026-08-09): same-kind decision-first v1 + ship challengeIdea consumer.

## Codex design-gate review r1 (ab49e0f5) — 4 findings, ALL valid, ALL fixed in design:
1. [P1] Client default timeout 3s (smartmemory-client.js:85) vs LLM cascade over ≤10 facts → challenge needs per-call ~30s timeoutMs (blueprint threads it into fetchWithContract). FIXED D3.
2. [P1] D1a/D1b drop conflicts but kept server's pre-filter has_conflicts/overall_confidence → could return hasConflicts:true with conflicts:[]. FIXED: D1c recomputes aggregates from RETAINED conflicts.
3. [P2] False safety claim: should_challenge does NOT gate the explicit endpoint (runs cascade directly, reasoning.py:107). FIXED: D3a CHALLENGEABLE_KINDS={decision,idea}, refuse others.
4. [P2] Golden test nondeterministic (LLM on). FIXED: useLlm:false + heuristic-detectable negation fixture ("X is..." / "X is not...", heuristic.py NEGATION_PATTERNS); LLM forwarding tested via request-body inspection.
## Codex r2 (ec53c694) — 3 findings (2 Med, 1 Low), ALL valid, ALL fixed:
1. [Med] D3a referenced non-existent `FluidError` → use existing `FluidKindUnsupported` (provider.js:206). FIXED.
2. [Med] D2 "any record kind" contradicted D3a + findIdea is IDEA-ONLY (listRecords{kind:IDEA}) → decisions unreachable. FIXED: challengeIdea resolves kind-agnostically via provider.getRecord(id) (verified kind-agnostic, smartmemory-provider.js:737), then challenge() enforces CHALLENGEABLE_KINDS.
3. [Low] D1c confidence recomputation untested → added confidence:1.0 assertion + retained-vs-filtered case. FIXED.
Converging (4→3, severity dropping).

## Codex r3 (ca436c74) — prior 3 resolved; 1 new trivial: raw id to getRecord loses case-normalization → challengeIdea uses `String(id).toUpperCase()` (findIdea parity). FIXED. DESIGN GATE CLEAN.

## Phase 1 COMPLETE (design-foh-3.md, owner-approved, Codex-clean).
## Phase 4-5 COMPLETE (blueprint-foh-3.md; every ref verified live; 4 corrections table entries; per-call timeout mechanism proven via BaseAPI.post→getRequestOptions key-preservation).
## Phase 7 Step 1 (TDD) COMPLETE — GREEN.
Code: client.challenge + fetchWithContract per-call timeoutMs; provider.js CHALLENGEABLE_KINDS + ChallengeResult JSDoc; smartmemory-provider challenge() + CAP.CHALLENGE + CHALLENGE_TIMEOUT_MS; ideabox-ops challengeIdea.
Tests: 9 challenge tests (golden same-kind, D1c aggregate-consistency, empty, kind-gate, not-found, consumer resolve/not-found, seam-contract flip) + stub /memory/reasoning/challenge route modeling the exact-type filter.
Regression: 363 pass / 0 fail across client+provider+conformance+ideabox+cutover+coordination suites.
Test-helper bug found+fixed: queueConflicts must resolve to RECORD item (fluid_ns=compose.fluid.v1), not the event item sharing the handle.
E2E: satisfied by stub-backed integration (no UI surface this slice).
## Phase 7 Steps 3-4 COMPLETE.
- Codex impl review (3c9b40ac): code CLEAN (no production bugs); 4 coverage gaps flagged.
- Coverage sweep: added per-call timeout override test (20ms default vs 60ms delay), malformed-response guard, D1c retained+filtered (confidence 0.7 pins retained-only), kind loop (thread/question/cluster). Golden-test comment made honest (stub=wire-contract, detection is SmartMemory's).
- Codex confirm (3625cc0c): REVIEW CLEAN.
Regression: 247 pass / 0 fail affected suites (12 new challenge tests).

## Phase 8-9 COMPLETE: report-foh-3.md written; CHANGELOG entry added.
## FOH-3 COMPLETE. Ready to ship (Phase 10). Epic COMP-FOH stays IN_PROGRESS (CONVICTION/CALIBRATION/CONTRADICTION/portfolio deferred).
Verified-live refs for blueprint: recall() smartmemory-provider.js:1076; client searchItems :413, timeout :85, request/fetchWithContract :103/:188; provider challenge stub :464, errors :176-241 (FluidKindUnsupported :206, FluidRecordNotFound :241); getRecord :737 (kind-agnostic); ideabox-ops findIdea :166 (IDEA-only), addDiscussion :464, IdeaboxNotFound; _renderContent :355, _toMetadata :365 (handle in meta), wireTypeFor :207; RECALLABLE_KINDS :154; capabilities() :216. Wire: reasoning.py:34-139; conflict shape models.py:34-75; confidence formula challenger.py:256-262.
