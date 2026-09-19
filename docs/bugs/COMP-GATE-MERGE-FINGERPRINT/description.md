# COMP-GATE-MERGE-FINGERPRINT: same-failure kill switch requires byte-identical failure text, so an LLM-regenerated conflict on the same file(s) is never recognized as "repeated" until the unrelated 20-round reentry cap eventually saves it

## Context — ruled out first (read-dont-recall)

Before proposing this, checked whether the real gap is missing file-ownership
enforcement (the natural first guess for "two lanes collide on the same file").
It is not — that protection already exists, twice over:

- **Decompose-time, deterministic:** `filesOwnedConflict` (`lib/build.js:2551`)
  rejects a decompose result whose tasks declare overlapping `files_owned`,
  with robust path normalization (`normalizeOwnedPath`, `lib/build.js:2578`,
  collapses `./`, `../`, backslashes, trailing spelling differences). Wired
  into the main engine's step-result handling at `lib/build.js:5668-5672`
  ("D5"), not just the GSD subsystem — any step returning `{tasks}` gets
  checked, and a violation becomes a retryable failure envelope so the
  decompose agent redoes the split disjointly.
- **Runtime, per-lane:** `checkOwnership` / `#failOwnership`
  (`lib/consumer-fanout.js:1440-1448`) verifies each lane's actual diff
  against its declared `files_owned` allowlist and fails that individual
  issuance (`OWNERSHIP_EVIDENCE_MISMATCH` etc.) if it touches an undeclared
  path — so even a lane that ignores its own contract gets caught before its
  diff reaches the merge.

So this brief is **not** "add ownership checking." It targets a different,
narrower gap: the mechanism meant to stop a *legitimately single-owned* file
from being retried forever when its own regenerated content simply never
merges cleanly.

## Steps to reproduce (code-level, not independently run end-to-end)

1. A decompose result gives one task exclusive `files_owned` of a generated
   file (e.g. `src/ds/tokens.json`) — passes both ownership checks above,
   no conflict.
2. `execute_merge` fails to apply that task's diff via 3-way merge
   (`applyDiffToIndex`, `lib/consumer-fanout.js:215-221`, runs
   `git apply --cached --3way --binary -`). Git's own conflict output names
   the file (`git apply --3way` stderr identifies exactly which path failed
   to merge/apply).
3. That error is wrapped: `MERGE_APPLY_FAILED: consumer merge apply failed and
   baseline was restored: ${error.message}` (`lib/consumer-fanout.js:1797-1798`),
   then turned into a flat string `${error.code}: ${error.message}`
   (`repairFor`, `lib/build.js` ~6015-6019) and handed to
   `decideMergeRepairOutcome` (`lib/build.js:7782`).
4. `decideMergeRepairOutcome`'s repeat test is exact string equality:
   `previousFailure !== undefined && previousFailure === failure`
   (`lib/build.js:7784`).
5. `execute_merge`'s `on_revise: execute` (`pipelines/build.stratum.yaml`)
   re-dispatches the task graph unchanged. The SAME task regenerates its
   implementation from scratch (a fresh LLM pass), producing a diff with
   different literal content than the previous round even though it targets
   the same file. Git's `--3way` error text for the new attempt therefore
   differs from the previous round's — different hunk context, possibly a
   different line/offset in the message — even though the underlying
   situation (this task's file will not converge) is identical.
6. `repeated` evaluates `false` every round. `decideMergeRepairOutcome` keeps
   returning `revise`. The kill switch built specifically to catch "the
   fan-out reproduces the same conflict" (its own comment, `lib/build.js:7770`)
   never fires — only the unrelated `MAX_GATE_REENTRIES = 20` hard cap
   (`lib/build.js:7766`, `assertGateReentryWithinCap`) eventually stops it,
   after paying for up to 20 full rounds instead of 2-3.

## Expected behavior

A conflict that reproduces on the *same file(s)*, from the *same task*,
round after round should be recognized as non-convergent within a couple of
rounds — the kill switch's own stated purpose — not only once the blunt
20-round cap trips. Two consecutive rounds failing on the same file for the
same reason is a strong non-convergence signal even when the exact diff/patch
bytes differ.

## Actual behavior

`decideMergeRepairOutcome` only recognizes a repeat when the *entire*
`${code}: ${message}` string is byte-identical, which an LLM-regenerated
diff essentially never produces twice. In practice this collapses the
two-tier guard (fast same-failure kill, slow 20-round backstop) into just the
slow tier for exactly the failure shape it exists to catch fast — which is
also the shape reported in the external `WEB-DS` build that motivated this
(`COMP-GATE-REENTRY-RESUME`): the same 4 generated files conflicting every
round of 61 generations.

## Suggested fix shape

Derive a stable fingerprint instead of comparing the raw message:
extract the conflicting file path(s) from the git failure (they're already
present in `git apply --3way`'s stderr — `checkOwnership`'s findings
already carry a `files` array in the same file, e.g. `lib/consumer-fanout.js:1456`,
which is the same shape this could reuse) plus the error `code`, and compare
*that* tuple across rounds instead of the full string. A repeat on the same
file set + code within N rounds (N as low as 2) triggers `kill` well before
the 20-round backstop, turning a $170+ non-convergent build into a $10-20
one that fails fast with an actionable message instead of a slow, expensive
one.

## Environment / Notes

- Not independently reproduced end-to-end in this repo — grounded entirely in
  reading the cited code paths on `main`, plus the external `WEB-DS` report
  (61 identical-file rounds) that this explains but was not run against this
  codebase's test suite. Treat the causal link between this code path and
  that specific external build as plausible and well-grounded, not measured.
- Companion to `COMP-GATE-REENTRY-RESUME` (same day, same underlying
  incident): that brief makes the 20-round backstop survive `--resume`;
  this one makes the smarter, cheaper guard actually fire before the backstop
  is needed. Fixing this one is the higher-leverage change — it's the
  difference between failing fast and failing slow-but-bounded.
- Test-worthy: extend a fixture like `test/gate-round-reentry.test.js` with
  two consecutive `MERGE_APPLY_FAILED` failures on the same file but with
  different message bodies (simulating two different LLM regenerations of
  the same conflicting patch) and assert `decideMergeRepairOutcome` (or its
  fingerprint-aware successor) still recognizes the repeat.
