---
date: 2026-08-09
session_number: 105
slug: foh-3-challenge
summary: "FOH-3 — CHALLENGE: same-kind contradiction detection, and the exact-type filter that would have made it a silent no-op"
feature_code: COMP-FOH
closing_line: A green endpoint is not a reachable endpoint — the cheapest probe was the one that saved the slice.
---

# Session 105 — COMP-FOH

**Date:** 2026-08-09
**Feature:** `COMP-FOH`

## What happened

The ask was `/compose build FOH`. The entry scan turned up the real state: the Front-of-House epic's only two scoped slices — storage (FOH-1) and recall (FOH-2) — were already shipped, and every remaining capability was deferred-by-design. So there was nothing to "resume"; the honest move was to put the fork to the owner, who chose to scope and build the next rung: CHALLENGE (adversarial push-back).

The design looked like FOH-2 all over again — SmartMemory ships `POST /memory/reasoning/challenge` end-to-end, so nominally pure Compose wiring. But a self-adversary pass asked the one question that mattered: does the endpoint actually SEE our records? A Codex feasibility probe proved it would not. SmartMemory's `memory_type` is an exact equality filter (no wildcard), applied after an untyped candidate window; our records store as `fluid_<kind>`; and challenge's HTTP field defaults to `"semantic"` and can't send null. Default challenge against our corpus = zero hits, forever, silently. Recall only works because it sends no type filter at all.

That reshaped the slice: send the record's exact wire type, which forces SAME-KIND scoping (a decision vs. other decisions) for v1. Cross-kind fan-out — one call per kind, N× cost — was deferred. From there it was the FOH-2 pattern with sharper edges: three Codex design rounds (8 findings, all fixed before code — including a 3s client timeout that would have aborted every LLM challenge, and filtered results whose conflict count could disagree with the conflict list), TDD against the wire-contract stub, an implementation review that came back CLEAN, and a coverage pass. Shipped to main as e114e53.

## What we built

- `lib/fluid/smartmemory-provider.js` — `challenge(handle, opts)` implementing `CAP.CHALLENGE`: exact-type send, fluid-namespace + self filtering, and aggregates (`hasConflicts`/`confidence`) recomputed from the RETAINED conflict set rather than SmartMemory's pre-filter values. `CHALLENGEABLE_KINDS={decision,idea}` gate (the endpoint runs its detector with no `should_challenge` guard, so non-assertional kinds are refused, not fed to it).
- `lib/smartmemory-client.js` — `challenge()` wrapper + per-call `timeoutMs` threaded through `fetchWithContract` (30s challenge deadline vs the 3s default), using `BaseAPI.post`'s option-passthrough that `getRequestOptions` preserves.
- `lib/fluid/provider.js` — `CHALLENGEABLE_KINDS` + `ChallengeResult`/`Conflict` seam shapes.
- `lib/fluid/ideabox-ops.js` — `challengeIdea` consumer (kind-agnostic, case-insensitive), so the capability is callable end-to-end rather than shipped seam-only like recall.
- `test/helpers/smartmemory-stub.js` + two suites — a `/memory/reasoning/challenge` stub route modeling the exact-type filter, and 12 tests (golden same-kind, exact-type scoping, namespace/self filtering, D1c retained-only aggregates, per-call timeout override, malformed guard, kind gate, consumer). 247 pass / 0 fail across affected suites.
- Feature docs: `design-foh-3.md`, `blueprint-foh-3.md`, `report-foh-3.md`, `foh-3-progress.md`.

## What we learned

1. **A green endpoint is not a reachable endpoint.** The single highest-leverage step in the whole slice was a pre-design probe asking whether the wire could actually see our data. It could not, by default — and nothing downstream (tests, types, a passing build) would have revealed it, because a no-op challenge returns a perfectly valid "no conflicts." This is the same dead-path-under-a-green-suite class the recall work hit; it is worth making a standing first question for any "just wire the existing endpoint" slice.
2. **Constraints from the wire beat preferences in the design.** Same-kind scoping wasn't a taste call — the exact-type filter with no wildcard forced it. Naming that in the design ("not a preference — what the wire allows") kept a reviewer from re-litigating it and kept v1 honestly small.
3. **Filtering downstream of a service invalidates its aggregates.** Because the provider drops non-fluid and self conflicts, SmartMemory's `has_conflicts`/`overall_confidence` became lies the moment we filtered. Recomputing from the retained set is the only self-consistent contract — a result must never claim conflicts it then shows none of. Codex caught the first version passing them through.
4. **Review rounds compound.** Round 1 fixed the substance; round 2 found the contradictions the round-1 fixes introduced (a referenced error type that didn't exist, a consumer that couldn't resolve the kind it was scoped to); round 3 caught a lost case-normalization. Convergence (4→3→1, severity dropping) was the signal it was safe to stop.

## Open threads

- [ ] Cross-kind challenge (a decision contradicting an idea) — deferred fan-out; the seam signature doesn't change when it arrives, only the provider's internal loop.
- [ ] The candidate-window underfill bound is disclosed but not fixable Compose-side; if it bites in practice, it needs a SmartMemory-side change (widen the challenge candidate window or expose top_k).
- [ ] `challengeIdea` has no CLI/MCP/UI surface yet — it's callable but not exposed. A surface slice would make the rung visible to users.
- [ ] Epic COMP-FOH stays IN_PROGRESS: CONVICTION, CALIBRATION, CONTRADICTION, and the portfolio rollup remain deferred.

---

*A green endpoint is not a reachable endpoint — the cheapest probe was the one that saved the slice.*
