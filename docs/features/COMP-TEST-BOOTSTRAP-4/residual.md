# COMP-TEST-BOOTSTRAP-4 — Residual (status: RESOLVED 2026-06-17)

Filed 2026-06-16 during the roadmap stale-row sweep; resolved 2026-06-17. The gate
deliverable shipped; the review-lens deliverable was carved into a follow-up after a
review caught that it is architecturally un-fireable in the current lifecycle order.

## Shipped 2026-06-17 (this ticket → COMPLETE)
The "real work" the prior residual identified — a cross-framework test-result signal — plus
the gate it feeds:
- **`parseTestSummary(framework, stdout) → { test_count, pass_rate, parsed }`** in
  `lib/test-bootstrap.js`. Pure and total; parses vitest / jest / mocha / pytest / go-test /
  cargo-test, degrading to `parsed:false` on any framework/output it can't read.
- **`deriveTestsPass(summary)`** — the gate: `parsed && test_count >= 1 && pass_rate === 100`,
  degrading to `true` (never a false block) when unparsed.
- Wired into `executeShipStep` (`lib/build.js`): the ship-time test run's output (previously
  captured then discarded) is now parsed, and the completion attestation's `tests_pass` is the
  derived value instead of a hardcoded `true`.
- `go test` → `go test -v ./...` so the Go parser can count per-test verdicts.

## Deferred → COMP-TEST-BOOTSTRAP-4-1 (the review-lens deliverable)
The original deliverable 2 — a review lens that flags auto-generated tests for human
verification ("auto-generated tests — verify assertions match intent") — **cannot fire in the
current build lifecycle.** Order is `execute → review → codex_review → coverage → … → ship`
(coverage `depends_on: [codex_review]`). The agent *generates* the tests during `coverage`,
which runs after both review passes — so a review lens has nothing to read in the same build,
and any "tests scaffolded" signal is written too late to reach review triage. Enabling it
requires a lifecycle change (run a test-review pass after coverage, or reorder coverage before
review). Filed as COMP-TEST-BOOTSTRAP-4-1.

## Why the gate lives in-process, not as a Stratum ensure
The original residual's literal wording ("test-phase `ensure` requiring `test_count >= 1`")
was rejected: a Stratum ensure runs in Python on the agent-reported `TestResult {passing,
summary, failures}` and cannot see the in-process parse; `result.pass_rate == 100` would raise
`AttributeError` and misfire on every framework the parser can't read. The in-process
attestation gate delivers the same intent where the signal actually exists, degrading safely.
See `design.md`.
