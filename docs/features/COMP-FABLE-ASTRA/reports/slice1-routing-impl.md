# COMP-FABLE-ASTRA slice 1 — implementation report

Implemented against `e79cc2d`; no git commit. Slice 1 only.

## Files changed

- `server/model-tiers.js`: Claude 5 routes, explicit Fable coordinator, Codex coordinator unavailable; prior Codex routes/efforts retained.
- `lib/agent-string.js`: derive tiers from the model table; reject unavailable provider/tier pairs.
- `lib/model-pricing.js`, `lib/experiment-pricing.js`: new rates, old receipt rates preserved.
- `lib/build.js`: fail-closed sidecar loading, pure aggregate preflight, runtime validation before fresh flow creation, resolved-map stream event.
- `test/model-tiers.test.js`, `test/agent-string.test.js`, `test/model-pricing.test.js`, `test/experiment-model-ab.test.js`, `test/profile-preflight.test.js`, `test/ts-cutover-build-golden.test.js`, `test/usage-receipts.test.js`: routing, pricing, bundled compatibility, real build boundary and dispatch assertions.
- `CHANGELOG.md`, `docs/pipelines.md`, `docs/features/COMP-FABLE-ASTRA/design.md`: release note, operator rules, source-review corrections.
- This report and [full failure appendix](slice1-routing-full-failures.json).

## Decisions and verified execution path

- Stale non-metadata sidecar keys **fail**. All 14 bundled specs and all six sidecars in `pipelines/` and `presets/` pass; `templates/` has no matching specs/sidecars. No shipped preset needs a warning exception.
- Metadata keys beginning `_` are ignored. Every flow and fanout agent stage is covered; multi-stage event entries use `stepId/stageIndex`.
- A missing sidecar returns `{}`; malformed JSON and non-object JSON throw with its path. Invalid profiles aggregate into one error naming all failing steps.
- No tier plus `modelID: null` retains the connector default. An explicit unavailable tier fails, including Codex coordinator.
- Static preflight is at `lib/build.js:2650`, immediately after sidecar/spec loading.
- Runtime profiles previously merged after flow creation; they now merge and preflight at `lib/build.js:2925-2932`, before either `startFresh` call (`:3054`, `:3089`). Restored resume roles recheck at `:2944` before dispatch.
- The actual flow-start call is `stratum.plan(...)` at `lib/build.js:5941`, inside `startFresh` (`:5911`). Static and runtime failure goldens record zero plan/resume/agent calls.
- The stream still opens after plan/resume to preserve active-run ownership. Its single `profile_preflight` event is at `lib/build.js:3240`, before step dispatch.
- The TS-engine golden reads that event at first dispatch and verifies the actual agent options carry Fable, adaptive thinking and high effort. Inference is stubbed; build, resolver, event writer and TS flow execution are real.
- The requested test grep found tier-table expectations only in `test/model-tiers.test.js`; old pricing/receipt fixtures and settings-store/agent-workspace interactive defaults remain unchanged and out of scope.

## Validation

- Targeted gate: **156 passed, 0 failed, 0 cancelled, 0 skipped**, exit **0** (`/tmp/s1.log`).
- Command: `node --test --test-timeout=90000 test/model-tiers.test.js test/agent-string.test.js test/model-pricing.test.js test/profile-preflight.test.js test/ts-cutover-build-golden.test.js test/experiment-model-ab.test.js test/usage-receipts.test.js`.
- Full command, run once: `RESEND_API_KEY= STRIPE_API_KEY= npm test > /tmp/s1-full.log 2>&1; echo $?`.
- Full Node result: **6,640 tests; 5,725 passed, 454 failed, 453 cancelled, 8 skipped**, exit **1**; 923,613 ms. UI/tracker suites were not reached because `npm test` chains them after a successful Node run.
- One slice-related fixture failed: `test/usage-receipts.test.js:529` supplied a `fix` profile without a declared `fix` step. Added the skipped step to that fixture; all 30 receipt tests now pass in the final 156-test gate. The full suite was not repeated, as requested.
- All **907** failed/cancelled leaf tests, exact location, diagnostic, cause assessment and full-log line is in the linked JSON appendix. Unknown causes are explicitly marked; suite rollup failures are excluded.
- Isolated watcher diagnosis: `test/build-stream-bridge.test.js`: **15 passed, 16 failed**, exit **1** (`/tmp/s1-stream-recheck.log`); reproduces outside the full run and imports none of the changed routing modules.
- `git diff --check` passed. No dependencies or interactive model defaults were edited.

## Limits and host rerun needs

- Sandbox listener failures (`listen EPERM`) cancel HTTP hooks and their dependent tests; the appendix identifies every affected test/file.
- Sandbox process-identity restrictions (`ps` unavailable) block guard registration in `test/lifecycle-backfill.test.js`; home-directory restrictions affect Stratum state, npm logs and hook read-cache tests.
- `test/review-fixes-runtime.test.js:213` fails on `spawnSync ps EPERM`; `pipeline-specwatch` and `ideabox-projection-watch` report `EMFILE` from watch setup.
- Watcher/event assertions fail in unchanged code; sandbox/timing is suspected, not established. Other unresolved diagnostics remain explicit in the appendix.
- The mandated full command internally launches `npm install` from `test/package-start.test.js:163` into an isolated temporary installation. This conflicts with the brief's prohibition; discovered while the run stalled. No standalone install was requested by this implementation. An attempt to stop the identified child was denied by the sandbox (`PermissionError: Operation not permitted`); the test timed out at 900,000 ms. After the suite exited, a cwd scan found no remaining packaging-install process.
- No live model/API run was performed; model identifiers and prices implement the supplied contract.
