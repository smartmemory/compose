# S1a Dispatch 2 correctness review r3 — final gate

Verdict: **REVIEW CLEAN**. No residual correctness finding in the r2 HIGH fix.

Scope: Fix run r2 only, against archived `20883d5ad6e9dd48a757da21bf771c7291d479f6`; four requested checks below. Only this report was written in the repository. Probes, source archive and instrumentation are disposable `/tmp` artifacts; executions used disposable `STRATUM_STATE_ROOT`. No source/test/fixture edits or regeneration, full suite, or commits.

| Check | Result | Evidence |
|---|---|---|
| 1. Public role reproduction: HEAD identity, shadow, explicit fast | **PASS** | Unmodified r2 off probe succeeds on both revisions with `claude-opus-5`, effort `xhigh`; expanded public-runner probe preserves every serialized call argument against HEAD off under current off/shadow, while `claude::fast` selects `claude-haiku-4-5-20251001` with effort absent. |
| 2. Start schema and persisted-start replay production path | **PASS** | Both new shadow starts pass independent AJV validation against unchanged `contracts/routing-start.schema.json` and production digest validation; three existing persistence/recovery tests pass with observed production entry counts: `validateRoutingStart` 25, `readRoutingStart` 23, `recoverRoutingPlan` 4, `bindRoutingRun` 4. |
| 3. Bundled Build/carry off producer identity | **PASS** | Real producers match frozen fresh inputs and profile digests; bundled 5-call trace and carry rerun 12-call trace match complete ordered serialized calls using only the r1/r2 cwd/workspace, UUID and TAP-duration substitutions; initial carry ordering caveat below. |
| 4. Recorded-role resume and shared-plan preflight alignment | **PASS** | Public participating-resume test ignores invalid replacement roles/off mode and dispatches recorded `codex::critical` as Astra with one plan total; both terminal-to-fresh branches pass; bare/fast shadow probes confirm shared-plan winner, effective overrides and explicit-supply provenance agree with actual dispatch. |

The effective override guard is `lib/build.js:3851`; shared preflight passes the same overrides and separate origins at `lib/build.js:927`. `lib/routing-ledger.js:216` overlays only explicit-supply evidence onto verified provenance, retaining the effective profile. Bare supply records `{supplied:true, origin:'explicit', recordedRole:'claude', profile:null}`, preset source and critical winner; fast supply records a manual fast override. Start creation and persisted reads still call the production schema/digest validator (`lib/routing-ledger.js:243`, `:261`).

Producer caveat: the first carry run swapped concurrent `execute/1` and `execute/2` connector arrivals. Its exact ordered comparison failed; a second unmodified producer run matched all 12 ordered calls. No sorting or additional normalization was applied to obtain that match. Concurrent launches remain visible at `lib/build.js:4482`; this check does not establish deterministic cross-run scheduling. No role-fix correctness regression was found. Full permanent producer-oracle work remains Dispatch 3 scope.

Digest checks: bundled `310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205`; carry `247791ff900ad8b6e0bbcba7408591d1a74adbdce1ab9c8833ab6621589cc1cd`. Frozen fixtures, recorder/helpers and integration files remain unchanged against HEAD. JSON comparisons do not certify callback or AbortSignal identity.

Validation: `build-model-route.test.js` and `routing-ledger.test.js` passed **59/59**; instrumented existing replay subset **3/3**; bundled producer **1/1**, carry producer **1/1 on each of two runs**. The unchanged original r2 probe passed on both revisions; expanded role/mode probes passed **8/8**. `git diff --check` passed. The supplied host 186/186 result was not independently rerun.

Disposable evidence:
- Original reproduction: `/tmp/s1a-r3-exact-r2-{current,head}.log`; archive pointer `/tmp/s1a-r3-head-root`.
- Expanded reproduction/schema comparison: `/tmp/s1a-r3-role.mjs`, `/tmp/s1a-r3-check-role.mjs`, `/tmp/s1a-r3-role-comparison.log`.
- Replay production entries: `/tmp/s1a-r3-ledger-loader.mjs`, `/tmp/s1a-r3-ledger-path.jsonl`, `/tmp/s1a-r3-replay.log`; targeted tests `/tmp/s1a-r3-targeted.log`.
- Producer traces: `/tmp/s1a-r3-{bundled-off,carry-off,carry2-off}.jsonl`; initial comparison `/tmp/s1a-r3-comparison.log`, passing rerun `/tmp/s1a-r3-comparison-rerun.log`.
