# COMP-TEST-BOOTSTRAP-4 — Design (completing the PARTIAL residual)

**Status:** design (Phase 1). Supersedes the "next step" sketch in `residual.md`.
**Depends on:** COMP-TEST-BOOTSTRAP-3 (shipped).

## Goal

Finish the two unshipped deliverables of the test-bootstrap gate:

1. A real **test-count / pass-rate signal** extracted from test output, used to gate ship
   (`test_count >= 1` and `pass_rate == 100%`), degrading safely when output can't be parsed.
2. A **review lens** that fires when bootstrap *generated* the tests this build, surfacing
   "auto-generated tests — verify assertions match intent" for human review.

## What's already shipped (Wave 3, `03ebfff`)

- `coverage_check` child flow runs the detected/scaffolded test command before ship
  (`lib/build.js:1605` scaffold gate; `lib/build.js:1653` `executeChildFlow` dispatch).
- `buildSignals.test_coverage = childResult.output` (`lib/build.js:1686`) — but the object
  carries only `{ passing, failures }` (consumed by `scoreTestCoverage`, `lib/health-score.js:42`).
- Completion attestation carries `tests_pass` (`lib/completion-writer.js:330`).

## Verified ground truth (from code, 2026-06-17)

| Claim in residual.md | Reality |
|---|---|
| `coverage_check` at `build.js` ~1602 | ✅ scaffold gate at `:1602–1646`; test command runs **inside the LLM agent step**, not in-process. |
| `~2324` is coverage | ⚠️ `:2322–2327` is the **ship-path** warm-up run (`detectTestFramework` → `execSync(... \|\| true)`), a separate invocation. |
| no `test_count`/`pass_rate` ensure vocab | ✅ confirmed — grep is zero; `_ENSURE_BUILTINS` has no metric helpers; `TestResult` is `{passing, summary, failures}`. |
| `isDocsOnlyDiff` skips coverage | ⚠️ only flavors a `qa_scope` stream event (`:1585–1594`); does **not** gate the flow. |
| raw test output is retained | ❌ retained **nowhere** — ship-path `execSync` output at `:2326` is captured then discarded (`\|\| true`, never assigned); agent path keeps only `{passing, failures}`. |
| `tests_pass` derived from a signal | ❌ **hardcoded `true`** at both `build.js:2300` and `:2511`. |

**Key consequence:** the residual's framing ("ensure wiring is trivial once the signal exists")
is wrong about *where* the wiring goes. The signal can only be produced where raw output lives —
the in-process ship-path run. A Stratum `ensure` runs in Python on the agent-reported result and
cannot see it; `result.pass_rate == 100` would raise `AttributeError` and **fail every build on a
framework the parser can't read**. So the gate belongs at the in-process attestation layer, not as
a Stratum ensure.

## Approaches considered

### A. Stratum `ensure` (residual's literal wording) — REJECTED
Add `test_count`/`pass_rate` to the `TestResult`/`CoverageResult` contracts + ensure expressions.
- Requires the LLM agent to compute and report counts (it won't) **or** cross-process routing of the
  in-process parse into the agent step result.
- Missing fields → `AttributeError` → hard-fails unparseable frameworks. Exactly the misfire
  `residual.md` warned against.
- Touches two divergent `stratum-mcp/executor.py` copies (vendored vs canonical) — ownership risk.

### B. In-process attestation gate (RECOMMENDED)
Parse the already-captured-but-discarded ship-path output and derive the real signal there.
- `parseTestSummary(framework, stdout) -> { test_count, pass_rate, parsed }` — pure, framework-keyed.
- At `build.js:2326`: stop discarding the output; parse it; store `buildSignals.test_summary`.
- Derive `tests_pass` from the parse instead of hardcoding `true`:
  - `parsed && test_count >= 1 && pass_rate === 100` → `true`
  - `parsed && (test_count < 1 || pass_rate < 100)` → `false` (the gate fires)
  - `!parsed` → keep current behavior (`true`) — **degrade, never false-block** on unparseable output.
- Delivers the residual's behavioral intent (block ship on real test failure / zero tests) where the
  signal actually exists, with safe degradation. No executor changes, no contract risk.

## Decision: take Approach B.

## Deliverables & slices

### Slice 1 — `parseTestSummary` (the real work)
- New pure fn, co-located with `detectTestFramework` in `lib/test-bootstrap.js`.
- Per-framework parsers keyed off the framework `detectTestFramework` already returns: vitest, jest,
  mocha, pytest, go test, cargo test. Each extracts `{ test_count, pass_rate }` from its summary line.
- Unknown framework or unmatched output → `{ test_count: 0, pass_rate: 0, parsed: false }`.
- TDD: table-driven unit tests over real captured summary samples per framework (pure logic — exactly
  the case where a unit test replaces many integration tests).

### Slice 2 — wire the signal + gate (`lib/build.js`)
- Capture the `execSync` output at `:2326` (today discarded).
- `const summary = parseTestSummary(testFramework?.framework, output)`.
- `buildSignals.test_summary = summary`.
- Replace the two hardcoded `tests_pass: true` (`:2300`, `:2511`) with a derived value per the rule above.
- Emit the parsed counts on the existing `qa_scope`/build stream so they're observable.

### Slice 3 — generated-tests review lens (`lib/review-lenses.js`)
- Persist a build-level signal where scaffolding happens (`build.js:1623`): `buildSignals.tests_scaffolded = true`.
- Add a `generated-tests` lens to `LENS_DEFINITIONS` (full `{id, lens_name, lens_focus, confidence_gate,
  exclusions, reasoning_template}` shape), focus = "auto-generated tests — verify assertions match intent."
- Extend `triageLenses(fileList, signals)` with an optional `signals` arg; push `generated-tests` when
  `signals?.tests_scaffolded`. Update callers to pass the signal (default `{}` keeps current behavior).

## Non-goals / explicitly deferred
- Stratum-level `ensure` enforcement (Approach A) — superseded by in-process gate; not needed.
- Coverage-percentage (line/branch) gating — only test count + pass rate here.
- Parser coverage beyond the six frameworks `detectTestFramework` knows.

## Risks
- Deriving `tests_pass` from the warm-up run is a behavioral change — a build whose suite genuinely
  fails (and is parseable) will now attest `tests_pass:false`. That is the intended gate, but the
  `!parsed` degrade path is the safety valve and must be covered by tests.
- Framework summary formats drift across versions — parsers must be lenient and fail to `parsed:false`
  rather than mis-count.
