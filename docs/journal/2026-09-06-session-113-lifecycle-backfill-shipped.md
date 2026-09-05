---
date: 2026-09-06
session_number: 113
slug: lifecycle-backfill-shipped
summary: "COMP-LIFECYCLE-BACKFILL shipped: evidence-backed completion of never-walked lifecycles, crash-safe via write-ahead intent + checksum-guarded recovery, three stratum releases, four blueprint gates, real-CLI golden flows"
feature_code: COMP-LIFECYCLE-BACKFILL
closing_line: "Four gate rounds, three stratum releases and one lock released a line too early: the feature is exactly as crash-safe as the last review made it."
---

# Session 113 — COMP-LIFECYCLE-BACKFILL

**Date:** 2026-09-06
**Feature:** `COMP-LIFECYCLE-BACKFILL`

## What happened

The morning ask was small: reconcile three stale roadmap rows. Doing that through the completion gate exposed that every guarded completion had been failing since the stratum 0.4.0 upgrade (`resolved_by` strict enum; the suite's fake guard client never saw it) — fixed in `d459846`, the first real completion since the upgrade. Then `/compose build COMP-LIFECYCLE-BACKFILL`: a feature that lets a lifecycle that was never walked be completed with evidence rather than an override token.

The design revision needed three stratum releases in one day (0.4.2 `guard policy` + `guard apply-upgrade`, 0.4.3 `guard digest`, 0.4.4 `expected_policy_checksum`) because the recovery story could not be made honest without them: a backfill that crashes between persisting its intent and completing its writes has to be resumable without ever moving the guard under a policy it did not verify against.

The blueprint went through four Codex gate rounds on gpt-6-astra: 18 → 13 → 8 → 2 findings, every one confirmed against code. Round three's two worst findings were an idempotency key forwarded under the wrong spelling (silently dropped by the transport's destructuring) and a pre-transition crash window in which a policy change would have let recovery apply the transition under the NEW policy and then refuse forever. Round four caught that the fold for the second of those had left the schema and payload table still saying "omit the checksum on replay".

Implementation ran as three slices. S1 (graph, transport, descriptors) went to Codex terra; its review found the new `compose guard descriptors` dispatch had shadowed the canon-guard CLI and that no test touched the real stratum CLI. S2 (valid-time merge, evidence resolver, the backfill intent inside the completion gate, golden flows) went to Opus; the astra review found the write sequence was returned unawaited so the dir lock released mid-write, the default projector's result was overwritten by finalization, and a projection failure still finalized — all confirmed with in-memory probes and fixed. S3 (route, MCP tool, readers, UI) went back to Codex terra; the sandbox cannot bind a server, so the route suite had never actually executed until the controller ran it: a missing import, and a server leak because describe-level `beforeEach` also fires for nested subtests.

## What we built

- `lib/lifecycle-modes.js`, `server/lifecycle-guard.js`: `complete_backfilled` as a distinct terminal in all four modes; legacy-policy projection so `ensureGuard` tolerates the 35 pre-existing registrations; lazy signed upgrade; raw-transport error-shape helpers; async evidence runner.
- `server/stratum-client.js`: `guardPolicy`, `guardApplyUpgrade`, `guardDigest`, `expected_policy_checksum`.
- `lib/guard-descriptors.js` + `compose guard descriptors`: `.compose/guard-upgrades.json`, operator-signed with `ssh-keygen -Y sign`.
- `server/lifecycle-phase-history.js`: `insertBackfilledPhases` — valid-time merge, `operation_id` dedup, adoption boundary, tie and containment refusals.
- `lib/backfill-evidence.js`: commit/path evidence with realpath containment and firmlink strip.
- `lib/completion-gate.js` `intent:'backfill'`: write-ahead intent carrying the full write context, idempotent + checksum-guarded transition, read-only ledger verification on recovery, pending→finalized only on zero failures.
- `server/vision-routes.js` backfill route, MCP `backfill_completion`, readers/decision events carrying origin/recorded_at/confidence only when present, obs contract 0.2.7, UI label/badge/muted dot.
- `contracts/lifecycle-backfill.schema.json`; `server/schema-validator.js` gains Ajv `$data`.
- Tests: golden flows against the REAL stratum CLI from an isolated copy with a temp HOME and an in-test sshsig signer; refusal harness R1–R26b; contract tests through the production validator.
- Compose commits `82ef056`, `80a9592`, `04dc99b`; stratum v0.4.2–v0.4.4.

## What we learned

1. **A wrapper that collapses states is a bug waiting for a caller that needs them.** `guardedTransition` maps `replayed` to `applied:true`; the backfill gate must tell them apart, so it uses the raw transport. Design the return shape for the most demanding caller.
2. **A fix is not done until every place that described the old behaviour is updated.** Round three fixed the recovery algorithm; the schema description and payload table still said the opposite, and round four caught it. Prose that contradicts code is a defect.
3. **Sandboxed test claims are not test results.** Codex reported 'expected EPERM' on the route suite; unsandboxed, three tests threw on a missing import and the file hung on a leaked server. Every sandboxed run gets re-run by the controller before it counts.
4. **describe-level `beforeEach` fires for nested subtests.** A test with `t.test` children opens N+1 contexts; close every one, not the last.
5. **`return promise` inside `try/finally` releases the lock at the first suspension.** `return await` is not a style choice when the finally holds a lock.
6. **Ajv `$data` is off by default.** A `const: {$data: ...}` schema silently rejects every document until the production validator enables it; the test that 'proved' it was using its own Ajv.
7. **Fake producers hide the real seam, again.** The morning's completion-gate failure, S1's descriptor enumeration and S2's contract test all passed with a fake in place. Each slice now has at least one test through the real producer.

## Open threads

- [ ] Operator steps before any legacy-resource backfill: ed25519 key, enrol the public key in stratum's trust root (release + install), `compose guard descriptors`, sign, commit json + sig. Until then a backfill on a registered feature refuses `upgrade_descriptor_unavailable`.
- [ ] Flow A steps 6/7/8 (mid-operation policy-change variants) are not built; §5.9c is exercised via 7b and replay only.
- [ ] The gate does not validate the persisted intent against the schema at runtime (design call, not made).
- [ ] Compose test suites register guards into the real `~/.stratum/guards` (32 fixture ids). Run them with HOME at a temp dir.
- [ ] `guardedTransition` verbatim `status` passthrough (§5.8 nicety).

---

*Four gate rounds, three stratum releases and one lock released a line too early: the feature is exactly as crash-safe as the last review made it.*
