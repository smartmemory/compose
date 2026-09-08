---
date: 2026-09-08
session_number: 117
slug: the-rejection-that-had-already-run
summary: "A \"rejected\" tool call had already written to disk; Codex found a regression in a one-line fix, then two live packaging bugs (npm installs shipped half a feature and a compose start that crashed); canon_override_grant retired"
closing_line: Every confident sentence written today without a number behind it turned out to be wrong, and the tools that found that out were the ones we had been told to use.
---

# Session 117 — A "rejected" tool call had already written to disk; Codex found a regression in 

**Date:** 2026-09-08

## What happened

We resumed with one small, fully designed task queued: COMP-SEMVER-STRICT, a one-line change making `compareVersions` reject trailing junk instead of parsing `'3garbage'` as 3. It was implemented in the main loop, tested, mutation-checked, committed. Then the owner interrupted with three words, "maximize use of codex", and the day changed shape.

The first thing Codex did with the commit was find a regression in it. Making the components strict exposed the decomposition around them: `s.split('-')` left build metadata glued to the patch component, so `'1.2.3+build1'` (valid semver, ignored for precedence) went from ordering correctly by accident to returning `null`. The update nudge would go quiet on exactly the input it should read. Codex also found the CHANGELOG line claiming well-formed inputs were unaffected was false, and that a ticked acceptance box claiming `compose doctor` output was "byte-identical, verified by" a named test cited a test that checks only that the command runs and emits JSON. Every test written for the fix passed against the bug. The fix to the fix (strip `+build` first, split the prerelease at the first hyphen only) also repaired a sibling defect where `1.2.3-alpha-1` and `-alpha-2` compared equal.

While that ran, the interrupt itself turned out to be the day's most important finding. The interrupted call was `record_completion`. The harness reported it as "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)." It had already written two files. A subagent listing the working tree fifteen minutes later was how we noticed. Codex reconstructed the sequence from three independent logs to the millisecond: the owner's message was queued at 02:35:16.337; Claude Code dispatched the MCP call at 02:35:18.873, two and a half seconds later; stratum ledgered the transition, compose wrote feature.json; the harness emitted `user-rejected` at 02:35:19.665; ROADMAP.md was written after that. Mode was `bypassPermissions`, so no prompt was ever involved. The rejection text mentions `new_string`, an Edit parameter the tool does not have: boilerplate, not observation.

The owner then asked us to stop spending time on history, so the two commits were squashed into one and pushed. That squash made the phantom completion worse: stratum's guard is now `complete` on a commit that no longer exists, and refuses every further completion with `operator action required`. A recovery runbook exists (two signed policy migrations, one ordinary transition, one normal record-completion, two Touch ID taps, nothing erased) and is parked until the owner is at the keyboard. Separately, a stale August build record was aborted 47 minutes later and the abort path unconditionally marks its feature `killed` in local vision-state, which is where the `KILLED` warning in pre-push validate came from.

From the queue: was there a `stratum guard list` verb? Yes, `ts/src/cli/guard.ts:209`, present in the installed 0.4.6 dist compose actually spawns, CLI only, no MCP equivalent. Did `canon_override_grant` have a user? No. Schema-advertised, dispatchable, called by nothing; its only consumer the PreToolUse hook; its attestation baseline verified by nothing; its consumed-grants directory read by nothing. And one line in that audit was worth more than the audit: `.claude/hooks/**` was not in the published `files` list while `.claude/skills/**` was, so npm installs got the tool that mints grants and not the hook that redeems them, and `compose guard install` exited 1 telling the user to fix their checkout.

We pulled that thread. Codex built the real tarball instead of reading the manifest and found three missing runtime inputs, not one: the hook, and both vendored agent definitions that `compose setup` reads and skips silently when absent, vendored in the first place because COMP-AGENT-VENDOR-1 had found them referenced-but-never-installed. Then the thread after that: `compose start` resolved `node_modules/.bin/vite`, a devDependency. Codex packed the tree, installed it into a scratch project (480 production packages, no vite) and ran the installed binary: unhandled `spawn .../.bin/vite ENOENT`, exit 1, plus a second failure where the API child imported a browser module under unpublished `src/`. Every npm install of compose had a cockpit that could not start. The fix splits on install style: source checkouts keep Vite, packaged installs serve the shipped `dist/` through the API server.

The test for that fix broke twelve unrelated tests under full-suite load, and the mechanism was worth the bisection: it chose ports inside macOS's ephemeral range, and the real supervisor runs `lsof` on its configured ports and SIGKILLs whatever it finds as "stale". The spawned production `compose start` was killing other tests' servers.

Last, on the owner's "fix them": `canon_override_grant` was retired, keeping the hook. The dangerous part was the hook's fail-open catch around its dynamic import of the grant module. Delete the module and leave the import and the hook allows every write it used to block. Both were removed together, the real hook was probed for `deny` after removal, and the end-to-end test was mutation-checked by restoring the dangling import: hook allows, test reddens.

## What we built

**Shipped, all on `origin/main`:**

- `3704b54` fix(version-check): strict component parsing plus a corrected `<core>-<prerelease>+<build>` decomposition. `lib/version-check.js`, `test/version-check.test.js` (+10 tests, each mutation-named), CHANGELOG, design.md with overclaims corrected.
- `022aa80` fix(packaging): `.claude/hooks/**` and `.claude/agents/**` added to `files`; `compose guard install` refusal now actionable for both install styles. New `test/package-publish-contents.test.js` shells out to `npm pack --dry-run --json` and asserts against npm's resolved list. Dry-run tarball 427 to 430 files.
- `3f91e28` fix(start): `server/supervisor.js` splits on `.git` presence; `server/index.js` serves `dist/index.html` only in packaged mode; `server/design-routes.js` imports the parser from new `lib/decision-blocks.js` (the `src/` module re-exports it). New `test/package-start.test.js` does the real pack/install/start with PID-sharded ports below the ephemeral range, an `lsof` shim for the child, and stripped env. CI builds `dist/` before `npm test`.
- `3ad1cb0` feat(canon-guard)!: `canon_override_grant` removed with `lib/canon-override.js`, `lib/append-integrity.js`, four feature tests, and entries in eight surviving files. Hook is unconditional. MCP surface 52 to 51 tools; `test/judgment-writer-mcp.test.js` had pinned 52 in two places outside the enumerated scope. Decision record `docs/decisions/2026-09-08-canon-override-grant-retired.md`; COMP-CANON-OVERRIDE KILLED at origin; COMP-CANON-ATTEST no longer depends on a deleted tool.

**Written, not shipped:** the COMP-SEMVER-STRICT recovery runbook (scratchpad). Memories: `reference_rejected_tool_may_have_run`, `reference_manifest_vs_tarball`; `feedback_codex_max_directive` reaffirmed with today as the example; `project_comp_guard_one_tap` closed on the `guard list` question. A Claude Code bug report is queued locally for the owner to review with `/feedback`.

**Suite at close:** node 6425/6425, UI 624/624, tracker 100/100.

## What we learned

1. **"Rejected" is a statement about the harness, not about disk.** The interjection was queued 2.5 s before dispatch; the call went out anyway; the queued message was relabelled as a refusal of a call that had already succeeded. After any interrupted call that could mutate state, check the state. `git status` costs nothing; fifteen minutes of not looking cost a guard ledger entry against a dead commit and a four-step signed recovery.

2. **A review found in two minutes what a green suite could not.** Every test written for the semver fix passed against its own regression. The reviewer's first move was to run the new tests against the PARENT commit and count which ones actually detected the change (one of five). That is a cheaper and sharper question than "do the tests pass", and we should ask it of every test we add.

3. **The manifest is not the package; the source is not the install.** Three runtime inputs were missing from npm installs, and `compose start` crashed on all of them, and the suite was green throughout, because nothing exercised the tarball. The two tests that fixed this shell out to `npm pack` and `npm install` respectively. When the question is "what does a user get", the tarball is the only witness.

4. **Silence is the more expensive failure mode.** The missing hook failed loudly (exit 1) and is why anyone looked. The missing agent definitions were skipped silently by `compose setup` and would have stayed missing. The pattern from the `known flake` postmortems (sessions 99, 110, 115, 116) holds: loud failures get fixed, silent ones accumulate.

5. **A test must not hand production cleanup logic resources it has not reserved.** The supervisor's `lsof` and SIGKILL of "stale" listeners is reasonable in production and lethal inside a test suite. Any test that spawns the real product needs to know what that product does to its environment on startup.

6. **Reachable-but-unused is stronger evidence than unreachable.** The token removed yesterday could not be called through any schema, so its non-use proved little. `canon_override_grant` was advertised and dispatchable and still had zero callers. That is the fact that decided its retirement.

7. **Partial removal of a fail-open guard is worse than no removal.** The hook's catch-all around a dynamic import meant deleting the module alone would have turned a deny into an allow, silently. The mutation check for this (restore the dangling import, confirm the hook allows) is the test that matters; the count assertions are not.

8. **"One source line" is not an exemption from delegation.** The day's directive was issued while the main loop was doing a task that looked too small to hand off. The task was wrong, and the model that was supposed to be doing it found out in two minutes. The tell is a main-loop session running `node --test` itself.

## Open threads

- [ ] Run the COMP-SEMVER-STRICT recovery runbook (scratchpad `COMP-SEMVER-STRICT-recovery-runbook.md`): two signed migrations, one transition, one record-completion; owner at keyboard for two Touch ID taps. Falsifier: `feature.json` status COMPLETE bound to `3704b54`.
- [ ] The stale-build abort path marks a feature `killed` unconditionally (`lib/build.js:5829`). That produced a false KILLED in local vision-state today. Decide whether an aborted build should ever change a feature's status.
- [ ] `get_feature_lifecycle` matches only `id`/`slug`, not the feature code (`server/compose-mcp-tools.js:791`), so it reports "not found" for every feature addressed the way people address them.
- [ ] `package-lock.json` records stratum 0.3.3 while the real local dependency is a sibling symlink at 0.4.6.
- [ ] `record_completion` refuses at recovery when the guard is `complete` with no intent on record, and there is no supported reopen verb short of a signed policy migration. Consider whether a completion intent should be recorded before the guard transition, so a crashed or interrupted call can be resumed.
- [ ] The harness bug is drafted for `/feedback`; the owner has not sent it.
- [ ] Two dirty `COMP-GUARD-CLAIM-1` files remain from a prior session's flow; not ours to close.

---

*Every confident sentence written today without a number behind it turned out to be wrong, and the tools that found that out were the ones we had been told to use.*
