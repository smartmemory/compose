# COMP-BUILD-CANCEL progress ledger

Parent: COMP-FABLE-ASTRA (D5 compose half + D1 consumer tagging). Design: ../COMP-FABLE-ASTRA/design.md §D1, §D5.
Stratum side: STRAT-FLOW-CANCEL-FG (stratum @7bd4c08), STRAT-LOOP-CARRY (@c7478f0), released as @smartmemory/stratum 0.5.0 (2026-09-10, stratum release commit 6e4a68c, tag v0.5.0).

## Scope (locked 2026-09-10)
- Every consumer `stratum_agent_run` passes `flow:{runId,stepId,itemIndex}` + `cancellationId`; client version guard names surface 19 / stratum >=0.5.0.
- `compose build --abort` and SIGINT/SIGTERM handler call `stratum_flow_cancel` first, then existing vision-kill / active-build.json / actuals writes.
- Compose kills its own in-process isolation:none agents.
- No patch captured after a cancel is merged.
- compose + compose-mcp -> 0.5.0, `@smartmemory/stratum ^0.5.0` (versioning rule).
- OUT: preset `carry:` / `verify after: [execute_merge]` (preset does not exist yet; COMP-FABLE-ASTRA slice 4).

## Log
- 2026-09-10: feature registered (add_roadmap_entry, IN_PROGRESS, position 152). Phase 1 skipped (design exists). Phase 4 started: 2 opus compose-explorers dispatched (compose cancel paths; stratum 0.5.0 contract).
- 2026-09-10: explorer 1 (compose) -> explore-compose.md (974 lines). Stratum explorer 1 truncated + unresponsive; §1-2 saved to explore-stratum-s1s2.md; explorer explore-stratum-2 (opus) dispatched for §3-7.
- 2026-09-10: explore-stratum-2 -> explore-stratum.md (547). Fable adjudicated decisions.md (D-A..D-G). Next: opus drafter writes blueprint.md.
- 2026-09-10: explorer-1 stratum report recovered from scratchpad -> explore-stratum-full.md (842 lines); s1s2 stub removed.
- 2026-09-10: blueprint.md drafted (1070 lines, 17 corrections, boundary map clean). Fable accepted all 17; revision 1 sent: widen D-A to tag gate-time agents (C1 showed admission succeeds on a gate-paused run).
- 2026-09-10: revision 1 landed (1174 lines, C18-C21 added: tagging forces codex exec transport + detaches agents, so Ctrl-C's free group kill disappears -> S06 must land with/before S03). Sonnet verifier dispatched (Phase 5).
- 2026-09-10: RULING: implementation order S01, S02, S06 (signal teardown), S03 (tagging), S04, S05, S07 — S06 before S03 so Ctrl-C never loses the group kill (C21).
- 2026-09-10: Phase 5 verify: 148 citations, 0 stale, 1 off-by-8 fixed by hand (C13 :574→:566). Boundary map clean. Next: Codex gate.
- 2026-09-10: Codex gate round 1 started: stratum_agent_run runId 6971d8d7ed4f pid 21305 (gpt-5.6-sol/high).
- 2026-09-10: Codex r1: 9 must-fix + 3 should-fix, all accepted (12 partially) → codex-round1.md; revision 2 sent to drafter.
- 2026-09-10: revision 2 landed (1681 lines, C22-C33; drafter substituted restoreMergeBaseline for git apply -R on the post-cancel merge — accepted). Codex r2 runId 82fa56a04eba pid 28730; sonnet re-verify dispatched.
- 2026-09-10: Codex r2: 10 must-fix + 1 should-fix, all accepted → codex-round2.md. Round 3 = cap (split S05 if must-fix remain). Revision 3 sent.
- 2026-09-10: revision 3 landed (1973 lines, C34-C44). Verification r2: 1 off-by-8 fixed in r3. Codex r3 (cap) runId da0ee7b9e46d pid 41242.
- 2026-09-10: Codex r3: 6 must-fix + 1 should-fix (converging) → codex-round3.md. Revision 4 = final; no r4 review (budget). S05 not split.
- 2026-09-10: blueprint committed fc4e821; plan.md committed. Starting implementation: slice 1 (S01) on sonnet.
- 2026-09-10: S01 fedd91e, S02 a254a55, S03-1 16c1c0f committed (sonnet); verified locally 56/56. Opus dispatched for S06 then S03-rest.

## Deviations
- S06: `lib/build.js:2307` creates `buildCancel` (blueprint lists this under S03-5) — the S06 handler cannot exist without the handle, so it moves up with the slice that first needs it.
- S06: `lib/build.js:1469` adds `claimActiveBuild` (blueprint's Boundary Map lists it under S04) — S06-2 requires `writeTerminal` to go through the §3.7 claim, so the helper lands with its first caller.
- S06: `lib/build-cancel.js:100,119` export `withDeadline` and `cancelBudgets` (not in the S06 Boundary Map) — the outermost-finally join in `lib/build.js` needs the same primitive and the derived bound, and C46 requires the bound be computed in one place rather than restated.
- S06: `lib/build.js:5075` defers `stratum.close()` until a pending teardown settles — the blueprint's inner-finally duties do not mention the client, and closing it underneath the teardown's in-flight `flowCancel` would abandon the cancel.
- S06: `test/build-signal-teardown.test.js:250` child case asserts exit 130 + the `aborted` record only; the C21 process-group receipt needs a TAGGED dispatch and therefore lands with S03.
- S03: the handle is registered in `runBuild` right after the plan/resume block (lib/build.js:2963) rather than inside `startFresh`/the resume branch — `startFresh` is a module-level export with ten positional parameters and no access to the handle. The C36 requirement (registered before the Codex preflight at lib/build.js:2985) is met.
- S03: `runBuild` tracks `registeredFlowId` (lib/build.js:2309) because the outermost `finally` is outside the scope of `response`.
- S03: `test/build-flow-tag.test.js` captures requests at the client's `agentRun`/`runAgentText` seam, not through a recording `_testClient` — `_testClient` intercepts every tool call, including `stratum_plan`, so a real engine build cannot run behind one. The seam-to-wire link is pinned by test/stratum-flow-cancel-client.test.js (S02).
- S03: `test/review-fixes-runtime.test.js:29` fixture now advertises `flow` (named in the blueprint's File Plan) — a tagged consumer dispatch otherwise fails the client's surface probe before reaching the wire case under test.
- 2026-09-10: S06 6667a23, S03 9a9ebb2 (opus, in-flight when owner reaffirmed Codex-only). Verified 74/74 locally. From here ALL delegation → codex gpt-6-astra/high. Review r1 of 052345a..9a9ebb2: runId 6a32d19b0f76 pid 28091. S04 impl: runId 77be504216bf pid 28524 (workspace-write, no commit).
- 2026-09-10: impl review r1 (astra): 4 must-fix reproduced + 2 should-fix → impl-review1.md. Fix queued behind S04.
- 2026-09-10: S04 committed d0a07c1 (astra impl, 108/108 local). Review-1 fixer (astra) runId f218a5207a06 pid 33698.
- 2026-09-10: review-1 fixes committed e2ac599 (astra fixer; 128/128 local). Next: S05 (astra), then review r2 of the fixes + S04 + S05.
- 2026-09-10: S05 impl (astra) runId 4290f36f2bd0 pid 38274.
- 2026-09-10: S05 committed 7014c13 (astra; 142/142 + goldens 101/101 local). Next: review r2 (astra) of d0a07c1..HEAD, then S07.
- 2026-09-10: impl review r2 (astra) runId dc1d1c8577e8 pid 6001 on 9a9ebb2..7014c13.
- 2026-09-10: /flush written to compose/.claude/session-context.741c7076-cd41-4154-8ffb-5f4c3dcdef45.md while review r2 (dc1d1c8577e8) still running.
- 2026-09-10: impl review r2 (astra, 6.4 min, 2.1M tok): 4 must-fix, all reproduced by probes, all accepted → impl-review2.md. Fixer (astra) runId 5971b5704312 pid 15062. S07 waits on this.
- 2026-09-10: review-2 fixes (astra fixer, 12 min, 3.0M tok) → review2-fix-report.md; 10 new regressions red-before/green-after; 152/152 local (sandbox blocks `ps` for one test). Committed. Note: killOwnedBuildVision overrides VisionWriter's private _direct/_restUpdateItemStatus via a prototype receiver — works, but couples build.js to private names (nit, not re-reviewed; round 3 is the cap). Next: S07 goldens (astra).
- 2026-09-10: review-2 fixes committed 051ef4d. S07 goldens (astra) runId 6217e8b35a29 pid 92979.
- 2026-09-10: S07 (astra, 10.8 min, 3.3M tok) → s07-report.md, 7 deviations (all fixture/contract-shape, accepted). Host run exposed a STRATUM defect: tagged agent exiting <40ms fails REGISTRY_WRITE_FAILED (server.ts:340, darwin libproc race). Fixture given a 150ms lifetime; stratum fix = follow-up (0.5.1). Goldens 2/2 local.
