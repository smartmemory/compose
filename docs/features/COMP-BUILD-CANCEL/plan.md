# COMP-BUILD-CANCEL — Implementation Plan

Related: [blueprint.md](blueprint.md) (verified 2026-09-10, 51 corrections, 3 Codex rounds) ·
[decisions.md](decisions.md) · [parent design](../COMP-FABLE-ASTRA/design.md) §D1/§D5 ·
Codex rounds [1](codex-round1.md) [2](codex-round2.md) [3](codex-round3.md) · [progress.md](progress.md)

The blueprint owns per-slice files, acceptance criteria, tests and CHANGELOG lines. This plan only fixes
the order, the routing and the gates. Nothing here is released until every slice has landed; the
0.5.0 compose release is a separate step after Phase 10.

## Order (one commit per slice, CHANGELOG line in the same commit)

| # | Slice | Why here | Model |
|---|---|---|---|
| 1 | S01 version train + surface guard | tiny, unblocks the fixtures | sonnet |
| 2 | S02 client: `flow`, unconditional cancellationId, `flowCancel()` | S03/S04/S06 depend on it | sonnet |
| 3 | S03-1 only: `lib/build-cancel.js` handle (`createBuildCancel`, states, registry, `pendingTeardown`) + its unit test | S06 needs the handle | sonnet |
| 4 | S06 signal teardown | must precede tagging (blueprint §2 ordering constraint, C21) | opus |
| 5 | S03 rest: tagging at the four sites, buildSignal chain, preflight signal, dispatch-ledger field | after S06 | opus |
| 6 | S04 abortBuild rewrite (in-process registry, identity claim, single terminal owner, driver SIGTERM, CLI exit codes) | | opus |
| 7 | S05 driver detection, no-merge-after-cancel, MergeAfterCancelError, restoreMergeBaseline reason, cancelled resume branch | | opus |
| 8 | S07 goldens against the real stratum server (fake codex on PATH; child-build abort) | last, proves the whole | opus |

Sonnet only where the blueprint enumerates files, symbols and a pass/fail test (S01, S02, S03-1). Everything
touching build.js control flow, processes or locks goes to opus. Never Fable.

## Gates

- After each slice: the slice's own tests + the pre-existing tests the blueprint names for that slice.
  The implementer's suite claim is re-run locally before the commit.
- After slices 1-5 and again after 6-8: Codex implementation review (gpt-5.6-sol/high) of the diff since the
  previous review; opus fixer; round 2 on the fixes only; ~3 rounds max.
- Once, at the end: full `npm test` (see reference: two test trees; `--test-timeout=90000`), then E2E per
  Phase 7 step 2 only for the HTTP abort route (a golden covers the CLI).
- Completion via `record_completion` with the full sha, then `roadmap generate`.

## Acceptance (feature-level, on top of the blueprint's per-slice criteria)

- [ ] `compose build --abort` on a running fake-codex build: agents' process groups gone, flow `cancelled`,
      driver exits, active-build `aborted` with the driver pid preserved, no merge transaction journaled.
- [ ] `compose build --abort` while the run lock is held: reports `run_lock_held` + holderPid, writes nothing.
- [ ] Ctrl-C on a running build: one bounded teardown, exit 130, flow `cancelled`.
- [ ] `test/version-sync.test.js` green at compose 0.5.0 / stratum ^0.5.0.
