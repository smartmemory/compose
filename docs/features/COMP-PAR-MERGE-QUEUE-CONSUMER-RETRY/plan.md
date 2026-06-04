# COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY — Implementation Plan

**Status:** PLAN (Phase 6) · **Blueprint:** [blueprint.md](blueprint.md) (Codex CLEAN). TDD per task — test first, watch fail, implement, watch pass.

## Task order (dependency-aware)

### T1 — Bounce formatter (W1, independent) `(existing) lib/step-prompt.js`, `lib/build.js`
- [ ] Test: `formatBounceForPrompt(gate_failed bounce)` → string contains the command, `exit`, files, excerpt; `merge_conflict` → conflict wording; null/garbage → `''`.
- [ ] Impl: export `formatBounceForPrompt` in `step-prompt.js` (port `parallel_exec.py:154-185`).
- [ ] Update the stale note `step-prompt.js:165-169` (consumer injection now exists).

### T2 — Opt-in wiring (W5, independent) `(existing) lib/build.js`, `(existing) pipelines/build.stratum.yaml`
- [ ] Test: `capabilities.preMergeGate` absent ⇒ `startFresh` `planInputs` has **no** `pre_merge_gate` key (deep-equal vs baseline); `true` ⇒ key present = `resolvePreMergeGate(...)`.
- [ ] Impl: import `resolvePreMergeGate` from `./gsd.js`; resolve once in `runBuild` gated on `composeConfig.capabilities.preMergeGate`; thread optional `preMergeGate` param through `startFresh` (5 sites), fold into `planInputs` only when defined.
- [ ] YAML: add `pre_merge_gate` to `workflow.input` + `flows.build.input`; add `pre_merge_verify: "$.input.pre_merge_gate"` to the `execute` step.

### T3 — Anchor + entry-snapshot helpers (W2, independent) `(existing) lib/build.js`
- [ ] Test: `buildAnchorCommit(base, [diffA], label)` → a commit whose tree = HEAD + diffA, real index/worktree untouched. Entry-snapshot capture leaves real index unchanged; restore re-materializes an untracked file.
- [ ] Impl: `buildAnchorCommit` (temp-index `read-tree`→`apply --cached`→`write-tree`→`commit-tree`); `captureEntrySnapshot` (temp-index commit-tree, captures untracked); `restoreToSnapshot` (`checkout -- .` + `clean -fd` + `checkout $snap -- .` + `reset -q`).

### T4 — Retry loop in executeParallelDispatch (W3, depends T1+T3) `(existing) lib/build.js`
- [ ] Test (drive via stubbed `stratum.parallelDone` returning `ensure_failed` once then `complete`): subset re-run = failed-only; round-N worktree off anchor sees prior good diff; base restored between rounds; single `build_step_done`; depth cap → tagged terminal.
- [ ] Impl: refactor body into per-round closure + bounded loop (entry snapshot, goodDiffs/goodResults accumulate, subset = failed taskResults, anchor seeding, apply-before-parallelDone, restore-between-rounds, terminal emit, `_parallelRetriesExhausted` on cap).

### T5 — Mis-route guard (W4, depends T4) `(existing) lib/build.js`
- [ ] Test: cap-exhausted parallel envelope at `build.js:1640` (runBuild) and `:2784` (executeChildFlow) → terminal exit, never single-agent `stepDone`; child flow no double-handle.
- [ ] Impl: `if (response._parallelRetriesExhausted) { build_error; status='killed'/terminal; continue }` at both branches.

### T6 — Coverage + golden integration (W6, depends T1-T5) `(new) test/*.test.js`
- [ ] Full test-plan table from blueprint; the gate-round vs conflict-round + byte-identical (no-gate clean round = baseline `parallelDone`/event/base-diff) + untracked-preservation cases.

## Gates
- TDD each task; full `node --test` suite green; Codex impl-review loop → CLEAN; coverage sweep → TESTS PASSING.
- E2E: no UI — golden flow is the stubbed-stratum integration test in T4/T6.
