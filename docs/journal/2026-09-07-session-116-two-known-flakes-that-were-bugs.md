---
date: 2026-09-07
session_number: 116
slug: two-known-flakes-that-were-bugs
summary: "Two \"known flakes\" carried for two months were both product defects, RESOLVED 12a357a (deaf build stream, 14/450 under load before, 0/450 after) and f7865d4 (timeout reported as a guard refusal, 6/200 before, 0/200 after); a diagnosis from 14be1a7 was overturned with 400k forks of evidence; a receipts gate now refuses a fact without its measurement; FOH-7 closes its last five untested criteria."
feature_code: COMP-FOH
closing_line: "\"Green in isolation\" is not a control. Isolation removes the condition."
---

# Session 116 — COMP-FOH

**Date:** 2026-09-07
**Feature:** `COMP-FOH`

## What happened

This chapter covers two sessions on one day, because the second finished what the first started.

The first session began as housekeeping: a Codex audit of `design-foh-7.md` had found three acceptance criteria that said "pinned by test" with no test behind them. We wrote six tests (`e7c47d0`), and for each one broke the guard it protected to watch it go red before trusting it. That mutation habit turned out to be the session's real tool.

Then the build-stream smoke test went red again. It had been written off as a `known flake` in three journal entries (sessions 99, 110, 115) over two months, and the standing advice was to re-run it. This time we refused to. We wrote a probe that ran the exact scenario 450 times while the full suite ran as load, and it failed 14 of 450, always with the same signature: the catch-up lines arrive and then nothing, ever. Not slow. Deaf. The cause was that `fs.watch` is not listening when it returns; libuv registers the FSEvents stream asynchronously, and the bridge armed the watcher, read once, and then had no other path to notice a file that grew. Under load the unarmed window widens to cover a build's opening events, and a cockpit stream that never starts is what a user would have seen, with no error anywhere. The fix (`12a357a`) makes the watcher an optimisation and a safety re-read the guarantee: 0 of 450 under the same load. Compose had three `fs.watch` users and two of the others had the same shape, so `7e40724` swept them, and arming both dispatchers in the CC session watcher exposed a second, real concurrency bug it had been hiding.

The same afternoon we reopened `14be1a7`. That commit had left a design question open about whether to keep signalling a process group after its leader is reaped, and its diagnosis said an EPERM on the group probe "names the recycled-pgid case outright". We did not argue; we measured. Three C programs, committed beside the decision record: 400,000 fork/exit cycles with a grandchild still alive and the pgid was never handed out; empty the group first and the pid came back at iteration 98,102. POSIX 4.13 says a pid is not reused while it is an active group id, and the machine agreed. So the recycled-pgid reading is the least likely explanation of that EPERM, not the confirmed one, and the control flow that keeps signalling the group was correct all along (`5457b06`, decision D-TERM-1).

By then the pattern was obvious. Five wrong facts in one sweep, all one habit in five wordings: `known flake`, `pinned by test`, `verified independently`, "suite green", a diagnosis called settled. A memory does not fire at the moment of the mistake, so we built a gate that does (`90d1502`): `bin/receipts-gate.js` runs on every push, docs-only included, over the added lines, and refuses a ticked test-coverage box with no test path in the item, a `flake` label with no measurement, and a commit message calling the suite green with no counts. It was calibrated against the incidents rather than against green: the whole day passed, all six historical offending commits fired, and three of its first drafts let offenders through and became fixtures. It bounced its own commit six times.

The second session picked up the open threads. FU-5, the `books` ideabox the parser refused, had already been resolved by the owner converting the file by hand (books `434c6bc`); all nine ideas parse. FOH-7's last two PARTIAL criteria got their tests, each reddened under mutation, and the controller re-ran one of the mutations independently rather than taking the report's word.

And the other half of session 99's open thread, the "transient stratum-mcp `PARSE_ERROR`" in the lifecycle guard end-to-end test, got the same treatment as the build stream. Under the full suite plus four concurrent probes it failed 6 of 200; in isolation 0 of 3. Every failure was one shape, and none of them was a parse error. Node's `execFile` never reports a timeout kill to its callback as `code: 'ETIMEDOUT'`; it reports `{ code: null, killed: true, signal: 'SIGTERM' }`. `server/stratum-client.js` matched only the string, so every real timeout fell through to the generic branch, the TIMEOUT arms of every runner were unreachable, and a guard transition that outran its 10 s budget came back to the lifecycle route as "transition refused by guard": an infrastructure timeout claiming the evidence had been evaluated and rejected. The `PARSE_ERROR` name was the same defect under an older refactor, where `code: null` had fallen into the exit-0 arm instead. Every existing timeout test had hand-built the `ETIMEDOUT` code Node does not produce, so the mock suite was green against a shape that never occurs. The fix classifies Node's own kill as a timeout, carries a bounded detail string instead of an empty one, raises the mutation budget to 30 s with the measurement in the comment, and pins the real error shape with a test that drives a real child past a real timeout: 0 of 200 under the same load.

## What we built

**First session (all on `origin/main`):**

- `e7c47d0` — six tests pinning FOH-7's three untested criteria (`test/maya-routes.test.js`, `test/ui/colleague-panel.test.jsx`), each shown red under mutation.
- `5457b06` — `lib/process-termination.js` keeps signalling the group after the leader is reaped; `docs/decisions/2026-09-07-group-signal-after-leader-reap.md` plus three C programs (`pgid_reuse.c`, `pgid_free.c`, `eperm_probe.c`) as the evidence; a pgid test in `test/review-fixes-runtime.test.js`.
- `12a357a` — `server/build-stream-bridge.js` safety re-read on a timer; regression test injects a watcher that never delivers.
- `7e40724` — `server/cc-session-watcher.js` polls alongside the watcher and serialises `_flush`; `lib/file-watcher.js` gets an error handler only, deliberately.
- `a8cbbb7` — the three `known flake` notes closed at their origins with sha and measurement.
- `90d1502` — `bin/receipts-gate.js`, `lib/receipts-gate.js`, `test/receipts-gate.test.js`, `.claude/rules/receipts.md`, wired into the pre-push hook.

**Second session (this commit set):**

- `server/stratum-client.js` — timeout classification on `killed`, not only `ETIMEDOUT`; an externally signalled child is named as such rather than relabelled a timeout; `_detail()` on TIMEOUT and PARSE_ERROR envelopes; `MUTATION_TIMEOUT_MS` 10 s to 30 s.
- `test/stratum-client-guard.test.js` — a real Node child outliving a real timeout, pinning `code === null`, `killed`, `signal`.
- `test/fluid-portfolio.test.js` — `unauthorized` (all three 403 sub-branches of `classify()`) and `misconfigured` (a member whose config exists but is malformed, so the `Promise.allSettled` rejection branch runs).
- `test/maya-routes.test.js` — absent `scope` and `scope: 'project'` produce a wire payload byte-identical to a direct `composeColleagueContext` + `toMayaContext` call on the same seeded root, through the real `defaultComposeContext`.
- `docs/features/COMP-FOH/design-foh-7.md` — all seventeen criteria now rest on a demonstrated test.
- `docs/bugs/COMP-IDEABOX-MIGRATE-DIALECT/followups.md` — FU-5 resolved.

## What we learned

1. **A recurring "known flake" is a defect report until a load probe disproves it.** Both of session 99's "known suite flakes, not regressions" were product defects. "Green in isolation" had been accepted as the control both times, and isolation removes the exact condition. The probe shape is cheap: run the scenario N×200 in-process while the full suite runs as load, 3 to 6 concurrent, print diagnostics on failure, then A/B the hypothesis under the same load.

2. **A test suite can be green against a shape the runtime never produces.** Every timeout test hand-built `err.code = 'ETIMEDOUT'`. Node's `execFile` callback never sets that. The mocks pinned the author's belief about the API, not the API. When the thing under test is a boundary with a runtime, at least one test has to let the runtime produce the input.

3. **Refactors rename symptoms without curing them.** `PARSE_ERROR` in July and `UNKNOWN` in September were one bug; the `_spawnResult` refactor moved which branch `code: null` fell into. A symptom that changes name across a refactor while the failure rate does not is a strong hint the cause was never touched.

4. **Measure the API before designing on it.** `fs.watch` is not armed when it returns. Nothing in the docs says so, three call sites assumed otherwise, and the build stream was permanently deaf under load. The correction is structural: a watcher is an optimisation and a poll is the guarantee, never the reverse.

5. **Retire a hypothesis with numbers, not with a better argument.** The recycled-pgid reading survived from `14be1a7` because it was plausible. 400,000 forks that never recycled a live group id ended it in an afternoon. Three C programs beside the decision record cost less than one more session re-litigating it.

6. **A wrong fact in a note is worse than no note.** It is confident, specific, and loaded into every later session's context, so it steers. Five of them were found in one sweep, and the worst sat on a live defect for two months. The receipts gate exists because the moment of the mistake is a push, and a push is where a check can fire; a memory never fires there.

7. **The gate catches claims of a kind that has a canonical receipt, and nothing else.** A ticked box, a `flake` label, a "suite green" message all have one. A diagnosis does not; `14be1a7` passes the gate. For conclusions the enforcement is still the person writing: no number, no fact.

8. **Mutation-check every new test, and re-run one of the reported mutations yourself.** Three receipts-gate drafts passed while letting offenders through. Today the controller re-ran the byte-identity mutation the agent reported and it held; the cost was one command.

9. **A timeout budget is a fail-closed refusal to the caller, so it must clear a loaded machine.** A guard transition costs 1.5 to 3.9 s idle; 10 s was under 3x headroom and a saturated machine took the callback 127 s to settle after SIGTERM. The number in the code now carries the measurement that chose it.

## Open threads

- [x] `server/vision-routes.js` returned HTTP 422 "transition refused by guard" for every guard error, including TIMEOUT, GUARD_UNREACHABLE and SPAWN, so the route still told a user that evidence was rejected when the guard was never reached. **RESOLVED 2026-09-07, same day:** the owner chose the split. Infrastructure errors are 503 "guard unavailable"; refusals stay 422. `test/lifecycle-guard-infra-status.test.js` (9 tests; 6 red under mutation of the split, the 3 refusal cases correctly unaffected).
- [x] Under saturation, `test/lifecycle-backfill.test.js` and `test/ts-cutover-consumer-fanout-golden.test.js` each failed 1 of 1 load runs and passed 83 of 83 in isolation. **PROBED AND RESOLVED 2026-09-07, same day** (5 of 42 under load for the fanout file, 0 of 67 isolated): neither suite has a defect. `--test-timeout` caps a file's TOTAL wall time, because it also applies to the implicit file-level test, so the 300 s ceiling killed two healthy files whose loaded wall time reached 301 s. Ceiling raised to 900 s; semantics pinned by `test/test-timeout-budget.test.js`. The kill emits no subtest message, which is exactly why both earlier sightings were unexplained.
- [ ] One run of `test/maya-routes.test.js` failed with `srv` undefined while a peer agent had a draft of the new byte-identity test live; 2 of 2 later runs passed. The shape can only come from a different version of the test, so it is attributed to the draft, and recorded here so a recurrence is not dismissed.
- [ ] D-TERM-1 did not measure a mixed group (members on more than one uid). The decision record says so.
- [ ] `lib/file-watcher.js` got an error handler only, on the reasoning that its consumers recover by refresh. If a user reports a stale file list that a refresh fixes, that reasoning is the first suspect.
- [ ] The receipts gate is bypassable with `--no-verify`, like every gate in that hook. Accepted residual.

---

*"Green in isolation" is not a control. Isolation removes the condition.*
