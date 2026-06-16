# COMP-TEST-BOOTSTRAP-4 — Residual (status: PARTIAL)

Filed 2026-06-16 during the roadmap stale-row sweep. The row was reconciled
PLANNED → PARTIAL: part of the gate integration shipped, a specific deliverable did not.

## Shipped (Wave 3, `03ebfff`)
- `coverage_check` child flow runs the detected/scaffolded test command before ship
  (`lib/build.js` ~1602, 2324); `buildSignals.test_coverage` captures its output.
- Docs-only diffs skip coverage gracefully (`isDocsOnlyDiff`).
- Completion attestation carries `tests_pass` (`lib/completion-writer.js`).

## Residual (NOT shipped — the actual gate deliverable)
1. **Test-phase `ensure` requiring `test_count >= 1` and `test_pass_rate == 100%`.**
   No such ensure vocabulary exists. The blocker is upstream: there is no per-framework
   parser that extracts a structured `{ test_count, pass_rate }` from test output
   (vitest / jest / pytest / go test all emit different summaries). That extractor is
   the real work; the ensure wiring is trivial once the signal exists.
2. **Review-lens flag for auto-generated tests** — when bootstrap *generated* the tests,
   a lens should surface "auto-generated tests — verify assertions match intent" for human
   review. Needs a new lens in `lib/review-lenses.js` + activation tied to a
   "tests were scaffolded this build" signal.

## Why this is its own ticket, not a quick fix
Cross-framework test-result parsing is a design problem (format drift, partial runs,
flaky-retry semantics). Reliable `test_count`/`pass_rate` extraction should be specced
before wiring it as a hard gate, or the gate will misfire on frameworks it can't parse.

## Suggested next step
Scope a small design: a `parseTestSummary(framework, stdout)` contract returning
`{ test_count, pass_rate, parsed: bool }` with `parsed:false` degrading to the current
`tests_pass` attestation (never a false block). Then add the `ensure` + the review lens.
