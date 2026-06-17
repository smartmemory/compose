# COMP-TEST-BOOTSTRAP-4-1: Post-coverage review of generated tests — Design

**Status:** DESIGN
**Date:** 2026-06-17
**Parent:** COMP-TEST-BOOTSTRAP-4 (surfaced_by) · Position 182

## Why

COMP-TEST-BOOTSTRAP-4 shipped the test-count/pass-rate gate but its second deliverable — a review
lens flagging auto-generated tests for human verification ("auto-generated tests — verify assertions
match intent") — is un-fireable in the current build lifecycle. Order is
`execute → review → codex_review → coverage → report → docs → ship` (each review `depends_on` the
prior). The agent *generates* the golden tests during `coverage`, **after** both review passes, so a
review lens has nothing to read in the same build. (Caught by Codex review during the parent's impl.)

## Problem

Generated tests can pass while asserting nothing meaningful (placeholder `assert True`, no act phase,
asserting only on mocks). Nothing in the pipeline ever reviews them: the review passes run before the
tests exist, and coverage only checks that they *pass*, not that they're *meaningful*.

## Goal

Add a review pass that reads the test files written during `coverage` and surfaces weak/placeholder
generated tests for human attention. Fire only when coverage actually produced test files. Degrade to
a no-op (zero cost) otherwise. Do not hard-block ship on subjective assertion-quality judgment (v1).

**Non-goals:** reordering the lifecycle; reviewing hand-written tests from `execute` (those already go
through the normal `review`/`codex_review` passes); coverage-percentage gating.

## Ground truth (verified 2026-06-17)

- `skip_if` is frozen at build start (`lib/build.js:749-776`) from the triage profile and the spec is
  hash-locked for tamper detection (`build.js:747`, `verifyPipelineIntegrity` `:1639/:1694`). **A new
  step cannot be `skip_if`-gated on a mid-build signal.** → use the synthetic-`stepDone` skip pattern
  (`build.js:1640-1645`) instead.
- `coverage_check` returns only `TestResult {passing, summary, failures}` (`build.stratum.yaml:43-46`);
  neither it nor `scaffoldTestFramework` surfaces generated test-file paths. → recover them via
  `git diff --name-only HEAD` + untracked, filtered to test-path patterns, at coverage-complete.
- `context.filesChanged` is only refreshed after `execute`/`docs` (`build.js:1271`), **not** coverage.
- Child-flow `inputs` are declarative `$.input`/`$.steps` refs — no runtime injection. The established
  way to pass a computed value into a child step is **intent-append** (`build.js:1627-1635`).
- The `generated-tests` lens definition was added then reverted in the parent (no home then); it now
  has a home here.

## Decision 1 — Gate on "test files in the post-coverage diff", NOT on "scaffold ran"

The parent framed this as "when bootstrap *generated* the tests." But scaffolding (`!detected &&
!hasTestDir`, `build.js:1612`) only happens for projects with zero tests — rare. The coverage agent
writes new golden tests **even when a framework already exists** (the common case). Gating on the
scaffold branch would miss almost all generated tests.

→ Gate on **the presence of changed/new test files in a fresh git diff taken at coverage-complete**
(patterns: `test/`, `tests/`, `__tests__/`, `*.test.*`, `*_test.go`, `spec/`, `tests/*.rs`). This is
always available, needs no new return field, and captures every build where coverage produced tests.

## Decision 2 — Advisory, not blocking (v1)

Two options for the new step's `ensure`:
- **Advisory (recommended):** the step always reports a clean `stepDone`; findings are surfaced to the
  human (and into the report) but never fail the build. Matches the parent's "flags them for human
  verification" wording and avoids a fix-loop on subjective "assertions match intent" judgments that
  would false-block legitimate builds.
- **Blocking:** `ensure: result.clean == True` + retries (like `review`/`codex_review`), forcing a
  regenerate-tests loop. Rejected for v1 — too aggressive for a quality-of-assertion heuristic.

## Approach

A new conditional `test_review` step after `coverage`, reviewing only the test files coverage touched.

### Slice 1 — `test_review` flow + step (build.stratum.yaml)
- New flow `test_review` modeled on `review_check` (`:79-97`): single review step, focused intent
  ("Review the generated test files listed below. Flag placeholder/tautological/mock-only tests where
  the assertion does not exercise the feature. Output ReviewResult."), `output: ReviewResult`. **No
  blocking `ensure`** (advisory).
- New step `- id: test_review` with `flow: test_review`, `depends_on: [coverage]`, inputs
  `{ task, blueprint }` (file list injected via intent, not inputs). Re-point `report.depends_on`
  from `[coverage]` to `[test_review]`.

### Slice 2 — dispatch handler + conditional skip + file injection (lib/build.js)
- Thread a `context`-level signal out of the coverage block so coverage-complete is detectable.
- Add an `if (childFlowName === 'test_review')` branch in the child-flow dispatch:
  1. Compute changed test files via a fresh git diff filtered to test-path patterns (reuse the
     `build.js:1273` git pattern).
  2. **None → synthetic clean `stepDone`** (skip), mirroring `build.js:1640-1645`.
  3. **Some → intent-append** the file list onto `response.child_step.intent` (mirror
     `build.js:1627-1635`) so the reviewer reads exactly those files with the generated-tests focus.
- Capture the resulting `ReviewResult` into `buildSignals.test_review` for the report (advisory).

### Slice 3 — reinstate the `generated-tests` lens focus (review-lenses.js)
- Re-add the `generated-tests` lens definition (reverted in the parent) as the source of the review
  focus/exclusions text, so the focused intent in Slice 1 has a single canonical home. (Used as the
  prompt source for the single-step flow; not wired into `triageLenses`.)

## Files

| File | Action | Purpose |
|------|--------|---------|
| `pipelines/build.stratum.yaml` | modify | new `test_review` flow + step; re-point `report.depends_on` |
| `lib/build.js` | modify | `test_review` dispatch branch: git-diff test files, synthetic-skip when none, intent-append file list; capture result into buildSignals |
| `lib/review-lenses.js` | modify | reinstate `generated-tests` lens definition (focus/exclusions source) |
| `lib/test-bootstrap.js` (or new helper) | modify | small `isTestFile(path)` predicate for the diff filter |
| `test/*.test.js` | new | unit-test the test-file filter + the skip/inject decision (pure parts) |

## Open Questions / risks
- The `test_review` review agent must read files from disk (the generated tests are uncommitted at
  this point but present in the working tree) — confirm the reviewer agent's cwd is `agentCwd`.
- Integration coverage: a full pipeline proof-run is heavy; lean on unit tests for the pure filter +
  skip-decision and assert the YAML wiring (step order, report re-point) via a structural test.
