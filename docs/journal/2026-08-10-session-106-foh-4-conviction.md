---
date: 2026-08-10
session_number: 106
slug: foh-4-conviction
summary: "FOH-4 CONVICTION shipped @8a477bb: belief-strength read + gated challenge→resolve loop, hardened across five review rounds; SmartMemory decay fix verified upstream first"
feature_code: COMP-FOH
closing_line: The slice that finally moves a belief — shipped only after three reviewers proved how many ways moving one can go wrong.
---

# Session 106 — COMP-FOH

**Date:** 2026-08-10
**Feature:** `COMP-FOH`

## What happened

We resumed from a flush that said the SmartMemory confidence-decay blocker was still pending — and discovered a prior session had already fixed it in both repos (core@2841909, service@3c79ddc, CONFIDENCE-DECAY-FIELD-1). We verified the fix empirically (parity test green) rather than trusting the note, skipped the now-pointless GH issue, and reopened the BLOCKED FOH-4 design.

What followed was the most review-dense slice of the epic: three adversarial design-gate rounds (r2: 5 findings — weak postcondition, unauthorized destructive target, timeout-retry double-decay, dead-path strategies, wrong lease model; r3: the sharp one — aborting an HTTP wait does not stop the server's synchronous mutation, so 'unchanged means safe to retry' was still a double-decay hole, plus causal attribution so a foreign decay is never mistaken for ours; r4: a proxy's 200 HTML page and gateway 5xx are not proof the origin finished, and JS/Python Unicode truncation diverges at the 200-code-point boundary). The design gate closed at budget with all findings folded in.

The owner then set the bracket protocol: Codex reviews before AND after implementation. The blueprint pre-review caught 8 precision gaps (including a fabricated helper and a wrong gate call signature) before a line of code existed. Implementation was stub-first TDD; the post-impl review found 2 P1s the whole design process had missed — a torn read or at-cap-20 history rotation could classify as the one RETRYABLE outcome, and the test stub lacked the real service's legacy-confidence bridge — plus a genuinely mutable Object.freeze(Set) allowlist on a destructive write. All fixed, verified in a targeted round 2, full suite green, shipped.

## What we built

- `lib/fluid/smartmemory-provider.js` — `conviction(handle)` (one-call read, derived fields) and `resolveConflict(source, target, {strategy})`: seam-owned authorization (read-only resolution, same-kind/non-self/namespace before any wire call), source-derived fact text via `_renderContent`, workspace lease, and the exported pure `classifyResolution` — exact-value decay match (eps 1e-9) + causal attribution (reason + code-point-truncated fact) + torn-read-proof no-op (JSON-equal history). Bounded read-only reconciliation poll for ambiguous transport; never retries /resolve.
- `lib/fluid/provider.js` — ConvictionResult/ConvictionEvent seam shapes, CONVICTION_STRATEGIES (frozen ARRAY — a frozen Set's entries are still mutable), base resolveConflict refusal stub, five typed failures (InvalidStrategy, InvalidTarget, ResolutionNoOp — the only retryable — ResolutionConflict, ResolutionIndeterminate).
- `lib/smartmemory-client.js` — `confidenceHistory` (full-envelope shape check) + `resolveConflict` (all three cascade flags explicitly false; 8s timeout).
- `lib/fluid/ideabox-ops.js` — `convictionOf` + `resolveIdeaChallenge` consumers, gate-first, disclosed v1 trust boundary.
- `test/helpers/smartmemory-stub.js` — post-fix reasoning routes with the real service's `_effective_confidence` legacy bridge and seven failure knobs (no-op, malformed ± mutation, gateway-502, mutate-late, count-jump, unattributed, partial-write, 404, history-fail).
- 30 new tests across provider/client/consumer suites; CHANGELOG; design/blueprint/ledger/bug-report docs.

## What we learned

1. **Cancelling your wait does not cancel their work.** The server mutates synchronously before responding; an aborted request's decay can land after you looked. 'Unchanged re-read → safe to retry' was wrong twice (r3 design, then again as the torn-read P1 in code review). For destructive writes, the only retryable verdict is a clean response that provably did nothing.
2. **A non-zero HTTP status is not proof the origin handler ran.** Proxies answer 200 with HTML; gateways answer 502 while the origin keeps going. Only a validated application response is authoritative.
3. **Numbers alone cannot attribute an effect.** A foreign accept_new produces identical old/new/decay values; only the event's reason + our exact (code-point-truncated) fact text distinguishes our mutation from theirs.
4. **Object.freeze(new Set(...)) is a decorative lock.** Freeze covers properties, not Set entries — .add() still works. On an autonomy gate for a destructive write, use a frozen array.
5. **The stub IS the wire contract, so stub drift is a P1.** The stub missed the real service's legacy-confidence bridge; tests were green against a contract the server doesn't honor. Review the stub against the real routes, not just the code against the stub.
6. **Review brackets work.** Pre-impl review of the blueprint killed 8 defects at zero code cost (including a helper that didn't exist); post-impl review found what only code can show (torn reads, freeze semantics). Neither round substitutes for the other.
7. **Verify the flush, then act.** The resume note said 'nothing committed'; reality had the whole upstream fix landed and pushed. Ten minutes of verification saved a duplicate fix and a wrong GH issue.

## Open threads

- [ ] Live-fire against a real smart-memory-service: BLOCKED on the unreleased SM fix (core@2841909 + service@3c79ddc are main-only). Confirm the service runs source@main before E2E; ask the owner before restarting anything (no-kill-ports).
- [ ] SmartMemory enhancement to file when next in that repo: server-side idempotency/operation ID on /resolve (the only fix covering non-Compose callers), stamped into the history event and deduplicated server-side.
- [ ] Later slice: persisted challenge records / provider-issued challenge tokens, so `against` can be BOUND to a real prior challenge instead of trusted (v1 boundary, disclosed in JSDoc).
- [ ] Later slice: `/low-confidence` stale-beliefs surface (needs per-kind fan-out past the exact-type trap) and the auto-resolve cascade (a bigger autonomy commitment).
- [ ] CHALLENGEABLE_KINDS carries the same frozen-Set mutability trap (pre-existing, read-only gate, untouched this slice) — fold into the next fluid housekeeping pass.
- [ ] COMP-FOH epic remains IN_PROGRESS: CALIBRATION and CONTRADICTION stay undeclared.

---

*The slice that finally moves a belief — shipped only after three reviewers proved how many ways moving one can go wrong.*
