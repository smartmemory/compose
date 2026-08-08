---
date: 2026-08-08
session_number: 102
slug: judgment-precedent-trace
summary: "Slice A of precedent-trace shipped: judgment history became readable, and the delta got locked to the contract after four review rounds chasing the same completeness bug."
feature_code: COMP-JUDGMENT-PRECEDENT
closing_line: The store had been keeping a diary nobody could open; four review rounds later, the reader stops lying about what changed.
---

# Session 102 — COMP-JUDGMENT-PRECEDENT

**Date:** 2026-08-08
**Feature:** `COMP-JUDGMENT-PRECEDENT`

## What happened

We resumed mid-build on COMP-JUDGMENT-PRECEDENT slice A, three Codex review rounds deep, with four open findings. The judgment store had always persisted full causal history — revision chains, the `supersedes: <slug>#r<N>` reference, retraction tombstones — but the only reader returned latest-only, so a decision's precedent sat on disk unreadable. Slice A adds a read-only trace: a single-pass supersession index and a cycle-guarded ancestry walk.

The recurring failure across rounds 1-3 was ours: we kept patching the exact field a reviewer named instead of the whole category. Round 3 said so out loud. This session we did the schema-driven pass — enumerated every writer-legal field of the record contract and locked the delta's covered-field lists to the schema with a test, so a future schema addition fails the test until it's diffed. Round 4 came back with two P2s (down from four P1s — converging): a scope shortcut we'd *just* added bit us (a pinned ancestor that happened to be the latest revision inherited the wrong reverse refs), and claim deltas keyed by id collapsed schema-valid duplicate ids. Both fixed and TDD'd. Per the resume note's budget, we stopped at round 4 and asked rather than auto-running round 5; the user said ship.

Marking it COMPLETE hit the canon guard. set_feature_status refused (lifecycle-owned), force refused (needs an out-of-band token we can't mint), complete_feature refused (the ideabox-promoted feature has no lifecycle registration). record_completion — commit-bound, tests_pass — was the evidence-gated path the guard accepts, and it flipped the status cleanly once we brought the :4001 server up.

## What we built

- `lib/judgment/trace.js` (new) — `buildSupersessionIndex` (single-pass forward + reverse refs; reverse is an array of {ref, rev} so forks survive and each ref knows which revision it superseded) and `tracePosition` (cycle-guarded, revision-pinned, schema-complete delta). Exports `REVISION_DELTA_FIELDS`/`CLAIM_DELTA_FIELDS`.
- `test/judgment-trace.test.js` (new, 35 tests) — incl. a contract-locked field-list test, a production-driven split-point equivalence test, a real-binary CLI render test, fork/pinned/duplicate-id regressions.
- `derivePositionStatus` gains an optional prebuilt index (O(n^2)->O(n)); get_judgment_state and judgment-gen pass one.
- `compose judgment trace <slug> [--json]` CLI verb; `get_judgment_trace` MCP read tool (reviewer-allowed).
- CHANGELOG entry, plan acceptance boxes checked, feature.json COMPLETE with a commit-bound completion record, ROADMAP regenerated.

## What we learned

1. **Patch the class, not the instance.** Three rounds burned because each fix targeted the one field named. The fix that stuck was structural: enumerate the schema and lock the enumeration to the contract with a test. A reviewer naming field X is telling you the *category* is under-covered.
2. **A fix can open the door it just closed.** Our finding-3 fix introduced a second-direction scope bug (pinned-latest), which we caught in self-adversary before the gate and again in round 4. Reviewing fixes-of-fixes is not ceremony.
3. **Lossless means normalize before diffing.** `rejected_alternatives` defaults to [] in the schema, so omitted-vs-[] would have read as a spurious change until normalized. Self-found during the 'lossless' probe.
4. **The canon guard has no agent backdoor to COMPLETE.** Neither direct-set nor force works; the only agent-available path is a commit-bound `record_completion` with tests_pass, and it needs the :4001 server. Documented in memory so the next session skips the four-tool detour.

## Open threads

- [ ] COMP-CONFLICT-MERGE — design gated & corrected, not built (two real loss paths in roadmap-preservers.js). S/medium.
- [ ] COMP-PROV-LINEAGE — S/low, unblocked; first AC is read the PROV-O spec before schema work.
- [ ] IDEA-31 (valid-time / as_of question) — in ideabox, untriaged; the residual of the killed BITEMPORAL.
- [ ] Slice B (semantic precedent search) stays BLOCKED on SmartMemory recall.
- [ ] Ideabox-promoted features have no lifecycle registration, so complete_feature can't reach them — worth deciding whether promotion should register a lifecycle.

---

*The store had been keeping a diary nobody could open; four review rounds later, the reader stops lying about what changed.*
