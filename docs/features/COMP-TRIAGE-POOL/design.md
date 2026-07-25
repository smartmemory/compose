# COMP-TRIAGE-POOL: Same-Box Cross-Project Dispatch Pooling — Design


## Why

Per-project dispatch ledgers are sparse — the reason routing (6-3) is parked on data volume. Pooling all projects on the SAME BOX (same user, same trust domain, no network/phone-home) into a user-level rolled-up ledger (~/.compose/data) gives new/thin projects a warm baseline curve immediately, and densifies rare model×effort×tier cells across the fleet-on-a-machine.

Architecture (hierarchical / partial pooling, NOT flat pool): one physical user-level store with a retained `project` field on every row → two logical reads: machine baseline = pooled read (the prior), per-project curve = filtered read (the posterior). Router blends via shrinkage — under-sampled cell leans on the machine prior, well-sampled cell trusts local. This dissolves 6-3's hard threshold into a continuous weight. The build-time baked baseline demotes to the cold-start seed for a brand-new box (empty machine ledger → shipped default).

New risks this introduces vs per-project isolation (all strategic, none fatal): (1) cross-process append safety on the shared ledger — same advisory-lock class as the P1a/P1b PID-lock work; (2) cross-version schema tolerance — different projects on the box may be pinned to different compose versions writing the same store; the kind/connector registry is a head start; (3) store identity is per-USER (~/.compose), not machine-global, to stay correct on shared machines.

Explicit non-goal (separate future feature): cross-BOX / cross-user network pooling — that one reintroduces the privacy/consent/infra boundary same-box avoids.

**Status:** PARKED — `## Why` is the captured thinking; the sections below are unfilled scaffold, to be written when this is unparked.
**Date:** 2026-07-23

## Related Documents

- Parent: [COMP-TRIAGE-6](../COMP-TRIAGE-6/design.md) — dispatch scorekeeping
- Surfaced by: [COMP-TRIAGE-6-3](../COMP-TRIAGE-6-3/design.md) — routing integration, PARKED on per-project data volume (the sparsity this feature answers)

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->
