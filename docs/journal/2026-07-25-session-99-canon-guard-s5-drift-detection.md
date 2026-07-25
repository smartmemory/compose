---
date: 2026-07-25
session_number: 99
slug: canon-guard-s5-drift-detection
summary: COMP-CANON-GUARD S5 shipped judgment canon drift detection in seven tasks — and three separate reviews each caught a gate that passed its own tests while guarding nothing.
feature_code: COMP-CANON-GUARD
closing_line: A gate you have not watched fail is not a gate — it is a green light you have not questioned yet.
---

# Session 99 — COMP-CANON-GUARD

**Date:** 2026-07-25
**Feature:** `COMP-CANON-GUARD`

## What happened

S4 gave the judgment canon a write-time hook: raw edits to `docs/judgment/**` from Claude's own tools get denied. S5 was the backstop for everything that hook cannot see — a Codex dispatch, a stray `sed`, a Bash redirect. Detection, not prevention, and we agreed up front to say so in every string we print.

Seven tasks, each authored by Codex and reviewed by Codex, with the controller running every gate and committing. Task 0 mapped which code paths make records durable. Tasks 1-3 built a sha256 record manifest and stamped it at every durability boundary. Task 4 put a CLI on top. Task 5 wired it into ship. Task 6 wired it into pre-push and taught `hooks status` to notice that an installed hook predates the feature.

The interesting part is not the feature. It is that the same failure recurred three times in three costumes, and each time it looked like success.

The first was the manifest's location. We put the baseline inside `docs/judgment/`, the tree it attests. Three separate review findings across three tasks kept circling the same root cause before we named it: a baseline stored inside the tree it certifies dies with that tree, and its absence reads as a clean GREEN. We moved it out to `.compose/judgment-attest.json`, where deleting the canon is still loudly RED.

The second was the tests. Two of them passed with the code they tested deleted. We made mutation testing standard after that — break it, watch the test fail, restore it. Then a mutation aimed at a branch the test never ran gave us a false all-clear, so we learned to verify the aim too. Then the Task 4 review found a TOCTOU hole inside something we had already mutation-certified: the branch logic was right, but the verifier releases its lock before returning, so the repair ran on a stale verdict. Mutation proves the branch, not the concurrency around it.

The third arrived at the very end, and it was the sharpest. Task 6's tests asserted that the pre-push gate sits outside the docs-only fast path — by reading the template's source text. Codex mutation-tested our tests and won: all three stayed green when the hook ignored the verifier's exit code, when the abort was deleted, and when the guard was wrapped so docs-only pushes skipped it entirely. We had tested the text, not the gate. We replaced them with tests that run the real installed hook against a real drifted canon.

Then the whole-branch review found the one that mattered most. The ship gate verified the working tree and then committed the index. We stopped arguing about severity and ran a probe: stage a forged record, restore the working-tree copy, and `guard verify` prints "drift detection passed" while the commit carries the forgery. A false GREEN, in the feature whose entire purpose is preventing false GREENs. The same review also caught two documents still instructing future readers to do things the shipped code refuses.

## What we built

- `lib/judgment-attest.js` (new) — sha256 record manifest: `recordFileSet`, `computeRecordHashes`, `readManifest`/`writeManifest`, `initManifestExclusive`, `stampRecord`, `removeRecord`, `syncManifest`, `verifyRecords`.
- `lib/judgment-verify.js` (new) — `verifyJudgmentCanon(cwd)`, three tiers (tree, projection, record) under the judgment lock.
- `lib/judgment-writer.js` — `syncManifest` at all three record-durability orchestrators.
- `bin/compose.js` — `compose guard verify [--fix]` and `compose guard init`.
- `lib/build.js` — the ship gate, plus the staged-vs-worktree divergence check the whole-branch review forced.
- `bin/git-hooks/pre-push.template` — the drift gate, placed outside the docs-only skip, with a baked `HOOK_VERSION`.
- `lib/hooks-status.js` — version comparison; a missing marker reports stale, which is every hook installed before this.
- `bin/judgment-import.js` — trust-on-first-use baseline after promotion.
- `docs/features/COMP-CANON-GUARD/s5-mutation-topology.md` (new) — the STAMP_SITES / NO_STAMP_SITES map.
- Tests across `test/judgment*.test.js`, `test/canon-guard-cli.test.js`, `test/build-ship-fields.test.js`, `test/pre-push-hook.test.js`, `test/hooks-status.test.js`. Suite 5078 to 5090.

## What we learned

1. **A baseline stored inside the tree it attests is not a baseline.** It dies with the tree, and its absence reads as clean. Three findings across three tasks shared this one root cause; we only stopped rediscovering it once we named it as a rule.
2. **"The test passes" and "the test discriminates" are different claims.** The only way to earn the second is to break the thing and watch the test fail. This cost us three separate incidents before it stuck.
3. **Mutation testing has its own failure mode: aim.** A mutation landing in a branch the test never exercises produces a confident false all-clear. Verify that the mutation lands in the path the test actually runs.
4. **Mutation proves the branch, not the concurrency around it.** The Task 4 TOCTOU survived a certification we had already declared complete.
5. **A test that reads a gate's source text tests the text.** Lexical placement assertions are worth keeping as fast documentation, but they can never be the discriminating test — Codex proved ours green against three separate behavioral mutants.
6. **Verify the tree you are committing, not the one you happen to be standing in.** Working tree and index are different objects, and `git commit` ships the index.
7. **Probe, do not argue.** Every severity dispute this slice was settled in minutes by building the state and watching what happened.
8. **A per-task review sees the task.** Only the whole-branch pass caught a Task 0 discovery that had corrected the plan but never propagated back into the design it came from. A document that contradicts the code is a regression waiting for the next session that trusts it.
9. **Placement can be the whole feature.** Judgment canon lives under `docs/judgment/**`, so a canon-only push is exactly the docs-only push that skips the test gate. Inside that branch, the gate would have missed precisely the pushes it exists to catch.
10. **Shipping a template does not roll it out.** The version check immediately reported this repo's own installed hook as stale — the rollout had silently not happened, and nothing would have told us.

## Open threads

- [ ] S6 (hash chain over the manifest) — deferred, still unbuilt.
- [ ] The `canon_override_grant` token protocol — deferred.
- [ ] Hook-registering ROADMAP row and feature.json entry — deferred, which is why COMP-CANON-GUARD stays IN_PROGRESS.
- [ ] Cross-repo ship (`agentCwd !== cwd`) does not verify the target repository's own canon. Accepted residual, documented in the design; verifying it would hard-fail any target carrying `docs/judgment/**` without a baseline, and we had no cross-repo build to test against.
- [ ] `git push --no-verify` bypasses the pre-push gate. Accepted, stated, not closed.
- [ ] Commit boundary slip: `9a2c6e0` carries Task 3's production code, so `2e884a9` holds only its tests and docs. Disclosed, owner chose to leave it rather than rewrite history.
- [ ] Known suite flakes, not regressions: build-stream-smoke retry, transient stratum-mcp PARSE_ERROR in lifecycle-guard-e2e.

---

*A gate you have not watched fail is not a gate — it is a green light you have not questioned yet.*
