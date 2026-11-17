# COMP-SETUP-PREFLIGHT-1: fix round 2, code changed by a review fixer must pass the tests again before ship

hard: build-pipeline ordering where a wrong fix either brings back paid-reviews-before-tests or ships untested code
Model: opus. Repo: `/Users/ruze/reg/my/forge/compose`.
cloud-no: the owner's Mac only.

## Owner words (verbatim, 2026-11-17, to s1-chat)
"agree all" (C1 and C3 build now, `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md`). Everything else here is by s1-chat, not owner-set.

## Current state (s1-chat read 2026-11-17 16:45 SGT; step 1 re-confirms with the review's probe)
- Local `main` is `76e9235b` (not pushed). Review `docs/features/COMP-SETUP-PREFLIGHT-1/review-fix-round-1.md`, `VERDICT: FINDINGS HIGH=0 MEDIUM=1 LOW=4`. Read MEDIUM-1 whole (lines 17-56): after the reorder, `coverage` runs before the reviews, the two review fixers (`lib/build.js:5293-5303`) still change code after it, and ship (`lib/build.js:7397-7414`, completion at `6853-6869`) runs the tests with a 120 s timeout and, in a project without the guard, counts an unreadable result as a pass. 47 of 52 projects on this machine have no guard.
- This is the second and last fix round. If the fix does not converge, stop and write the alternatives in half a page.

## Cases (frozen; done when these pass in a throwaway project through the real bundled pipelines with dispatch faked)
1. Tests fail before any review: no paid review is dispatched (round 1's result, must still hold).
2. Tests pass, a review fixer changes code and breaks a test: the build does not complete; the tests run again after the last review fix and the build refuses on the red.
3. Tests pass, reviews change nothing: the tests are not run a second time for nothing (or the second run is a no-op skip with a logged reason).
4. Tests pass, a review fixer changes code, tests still pass: build completes.
5. A build that had a review fix and whose ship-time test run times out or cannot be parsed: not complete, in guarded and unguarded projects alike, with a message naming the cause.
6. Both `build` and `build-quick`. Project-local pipeline copies: unchanged behaviour plus the existing WARNING.

## Do
Reproduce first. Tests first (the feature's own test files plus the files you touch, only those). Fix at the producer; no second mechanism where an existing step can be reused. Correct the pipeline comment that claims ship re-tests review changes. CHANGELOG line. LOW-4 (a covers entry of `"."` refused without suggesting `**`): fix the message only, it is one line. LOW-1, LOW-2, LOW-3: do not fix; add them to the deferred list in your report. Branch `comp-verify-fix-2` in a `.worktrees/` checkout off local `main`; if every case and test passes, merge into local `main` (`--no-ff`), not pushed.

## Rules
No push. No full suite. No restart of any running Compose process. No sudo. Never dump an environment or print a token. No `--no-verify`, no `git stash`, no `pkill`. No subagents. Small tool output. No foreground command over 15 minutes. Never-read paths: the sealed list in `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/claude/rules/files-and-docs.md` ("Sealed list"), nothing more.

## Report
`/Users/ruze/reg/my/forge/compose/docs/features/COMP-SETUP-PREFLIGHT-1/report-fix-round-2.md`: plain-words TLDR first, before and after output per case. Last line, exactly:
`FIX-2 reproduced=<yes|no> cases=<pass>/6 redesign_needed=<yes|no> tests=<pass>/<total> merged_to_main=<yes|no> main=<sha> pushed=no`
