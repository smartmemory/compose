# COMP-FOH / FOH-3 — Implementation Report

**Status:** COMPLETE · **Date:** 2026-08-09 · **Design:** [design-foh-3.md](design-foh-3.md) · **Blueprint:** [blueprint-foh-3.md](blueprint-foh-3.md) · **Ledger:** [foh-3-progress.md](foh-3-progress.md)

## Summary

Shipped `CAP.CHALLENGE` on `SmartMemoryFluidProvider`: same-kind contradiction detection over the fluid corpus (Discovery-Loop rung 4), plus a `challengeIdea` consumer. Pure Compose-side wiring of SmartMemory's existing `POST /memory/reasoning/challenge` endpoint.

## Delivered vs planned

| Planned | Delivered |
|---|---|
| `challenge(handle)` provider method, same-kind, `{decision, idea}` | ✅ `smartmemory-provider.js` |
| `client.challenge` wrapper + per-call timeout | ✅ `smartmemory-client.js` (+ `fetchWithContract` per-call `timeoutMs`) |
| `ChallengeResult`/`Conflict` seam shape + `CHALLENGEABLE_KINDS` | ✅ `provider.js` |
| `challengeIdea(ctx, id)` consumer | ✅ `ideabox-ops.js` |
| Golden + edge tests, real-wire stub | ✅ 12 new tests across 2 suites + stub route |

## Key decisions

- **Same-kind scoping is forced, not chosen.** SmartMemory's `memory_type` is an exact equality filter with no wildcard, so one call covers one kind. v1 challenges a record against its own kind; cross-kind fan-out deferred. (Feasibility verified before design gate — this was the difference between a shippable slice and a silent no-op.)
- **Aggregates recomputed from retained conflicts (D1c).** The provider drops non-fluid and self conflicts, so it never passes through SmartMemory's pre-filter `has_conflicts`/`overall_confidence` — which could otherwise claim conflicts the caller never sees.
- **Per-call timeout.** The 3s client default aborts an LLM challenge; challenge overrides to 30s per-call via the SDK's option-passthrough, without loosening CRUD/recall hang-detection.
- **Consumer shipped (not seam-only).** Unlike FOH-2's recall (zero callers), `challengeIdea` wires the capability end-to-end.

## Deviations from blueprint

- `challengeIdea` delegates resolution to `provider.challenge` (which resolves via `getRecord` internally) and maps `FluidRecordNotFound → IdeaboxNotFound`, rather than resolving separately first — avoids a double lookup, same observable contract (blueprint corrections C2).

## Test coverage

12 tests: golden same-kind flow, exact-type scoping (idea not surfaced for a decision), namespace + self filtering, D1c (fully-filtered → `hasConflicts:false`; retained+filtered → confidence from retained only), empty corpus, kind gate (thread/question/cluster), not-found, per-call timeout override, malformed-response guard, consumer resolve (case-insensitive) + not-found, seam-contract flip. Regression: 247 pass / 0 fail across affected suites.

## Review

Feasibility + design reviewed by Codex across 3 rounds (8 findings, all fixed pre-code, including two — a 3s timeout that would abort every LLM challenge, and filtered results whose conflict count could disagree with the list). Implementation reviewed to REVIEW CLEAN; a coverage pass added 4 tests (timeout, malformed, D1c retained+filtered, kind loop), confirmed CLEAN.

## Known limitations (disclosed in code + design)

- Contradiction-vs-stored-memory only (not world fact-check — that's `/reasoning/resolve`, a later slice).
- Same-kind only; cross-kind fan-out deferred.
- Candidate-window underfill: SmartMemory's exact-type filter runs after an untyped candidate window, so a contradiction outside it is missed (not fixable Compose-side).

## Lessons

- **A green endpoint is not a reachable endpoint.** The `memory_type` exact-filter would have shipped a capability that silently found nothing. The pre-design feasibility probe (does the wire actually see our data?) was the highest-leverage step in the slice — the same "dead path under a green suite" class the recall work also hit.
