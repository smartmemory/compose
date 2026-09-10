# S1a Dispatch 2 correctness review r2

Verdict: **1 HIGH, 0 MEDIUM, 0 LOW**.

Reviewed the uncommitted fix run against `20883d5`, the r1 adjudication, and implementation report “Fix run r1”. Only this report was written in the repository; probes/loaders and the HEAD archive are disposable `/tmp` artifacts. No full suite, source/test edits, commits, or fixture regeneration. All executions used disposable `STRATUM_STATE_ROOT` values.

| R1 finding | Result | Re-probe evidence |
|---|---|---|
| 1. Terminal old flow inherits routing configuration | **FIXED-WITH-NEW-ISSUE** | Public Build terminal-flow/dead-pid tests: active/trials/exploration/feedback refuse with zero additional plans/calls; shadow creates a second plan/call and a new routing journal; both fresh branches restore current roles. New fresh **off** override regression below. |
| 2. Routing transport enters prompts | **FIXED** | Copied bundled GSD spec with `${input.routing_start}` in `decompose_gsd.do` refuses `ROUTING_TRANSPORT_EXPOSED` before plan/model (0/0); public Build prompt and shared child-forwarding negatives also pass. |
| 3. Deferred multi-stage waves break shadow | **FIXED** | Real-engine public GSD and Build, each under `_consumer.execute:{}` and `execute.tier_from`: off=shadow=7 ordered calls; all four mixed cases make 10 calls with 3 linked and 6 deferred bindings. |
| 4. Fresh cleanup recreates a lost journal | **FIXED** | Public `fresh:true, route_mode:off` after deleting ordinary-only or consumer shadow evidence refuses `ROUTING_BINDING_MISSING`, adds zero plans/calls, and leaves the old journal absent; historical off ordinary cleanup remains non-creating. |
| 5. Frozen-oracle names overclaim producer coverage | **FIXED** | Names at `test/build-model-route.test.js:106`, `:124`, `:280` and `test/gsd-model-route.test.js:133` now identify digest/input, replayed-prompt/selected-option, and path-normalized comparisons; implementation report `:81` explicitly lists Dispatch 3 oracle work. |

## New finding

### HIGH — Explicit bare role flags change fresh off-mode model selection

- **Locations:** `lib/build.js:3846`, `lib/build.js:3849`, `lib/build.js:3867`, `lib/build.js:3870`.
- Fresh configuration records bare provider strings as runtime overrides in every routing mode, then merges those overrides into the actual dispatch profiles. Previously `resolvePlanSpecValues` recorded only strings carrying a tier/template (`lib/stratum-mcp-client.js:94`); a bare role flag left the sidecar profile intact.
- **Public-runner reproduction, same disposable fixture against current code and archived HEAD:** ordinary step `agent: '$.input.implementer_agent'`, sidecar `{work:'claude::critical'}`, invocation `{mode:'feature', route_mode:'off', implementer:'claude', reviewer:'codex'}`. Both make one successful call. HEAD dispatches `{provider:'claude', modelID:'claude-opus-5', effort:'xhigh'}`; current dispatches `{provider:'claude'}` with **modelID and effort absent**. This silently changes the connector request while routing is off.
- This fixture runs public `runBuild` with a controlled one-step engine/model boundary; it does not feed expected prompts/options into dispatch. The same script runs against both revisions. Evidence: `/tmp/s1a-r2-bare.mjs`, `/tmp/s1a-r2-bare-current.log`, `/tmp/s1a-r2-bare-head.log`; archive location: `/tmp/s1a-r2-head-root`.
- **Fix:** preserve historical off-mode profile merging: bare role strings must not replace sidecar defaults. Keep explicit-supply provenance separate from effective dispatch overrides, and make participating shared-plan preflight agree with the preserved baseline. Add a public fresh off test with a tiered sidecar plus a same-provider bare flag; the fixed-agent bundled fixtures cannot detect this regression.

## Off identity re-check

The real existing golden producers were rerun through `/tmp/s1a-review-trace.mjs`, instrumenting connector arguments in memory without using frozen prompts as producer inputs.

| Producer | Current result against unchanged frozen fixture |
|---|---|
| Bundled Build, explicit off | Exact fresh input; 5 calls in the same order; profile digest `310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205` unchanged. |
| Two-wave carry, default off | Exact fresh input; 12 calls in the same order; profile digest `247791ff900ad8b6e0bbcba7408591d1a74adbdce1ab9c8833ab6621589cc1cd` unchanged. |

For both producers, the **complete serialized ordered call objects** match after substituting corresponding cwd/workspace strings, UUIDs and TAP `duration_ms` values. No option keys were dropped. Raw cross-run byte equality is not claimed; functions/signals are not represented by the frozen recorder. The passing bundled/carry checks do not certify role-based explicit overrides, which fail above.

Bundled Build shadow also makes 5 calls and matches the entire off call list after those same substitutions. Bundled GSD's public off/shadow test makes 4 calls with equal complete prompt strings after cwd substitution; the fresh input matches its frozen input-only fixture. The interpolation validator scans without rewriting, and the bundled authored prompts have no changed bytes. Neither the validator nor transport fields alter these bundled prompts. This round does not claim a new GSD continuation-input oracle run.

A disposable public historical **off** resume probe starts with `codex::critical`, interrupts before dispatch, then resumes with fresh flags `implementer:'codex', reviewer:'claude'`: one plan total, one Astra call, recorded critical role retained. Thus the fresh-only override exclusion works for this historical resume case; it does not repair the fresh off regression. The shipped participating-resume test also preserves recorded roles over invalid new flags.

Trace/comparison evidence: `/tmp/s1a-r2-{bundled-off,carry-off,bundled-shadow}.jsonl`, `/tmp/s1a-r2-compare.mjs`, `/tmp/s1a-r2-comparison.log`; historical probe: `/tmp/s1a-r2-historical-loader.mjs`, `/tmp/s1a-r2-historical-same-provider.log`.

## Deferred identity and test-producer audit

- Independently augmented all four seven-call real-engine cases in memory: reopen `ConsumerFanoutArtifacts` without a routing context, compare all persisted dispatch bindings, then change execute from two stages to one and call `resumeRouting`. Every case refuses `ROUTING_ROOT_DRIFT` with plan/call counts still `[1,7]`; reopening the unchanged journal succeeds. Evidence: `/tmp/s1a-r2-reload-loader.mjs`, `/tmp/s1a-r2-reload.log` (4/4).
- `lib/consumer-fanout.js:449` validates deferred identity against the sealed start on writes and reload; a token already indexed to a routed issuance cannot acquire a deferred exemption. Existing missing-link/forged-deferred tests pass. No new missing-link exemption was observed for participating single-stage steps.
- The terminal/fresh-loss ordinary fixtures use synthetic engine state and model responses, but drive real public fresh/resume selection and assert counters outside the runner. Their scope is lifecycle wiring, not golden prompt production. The copied GSD and multi-stage tests use the real TS engine, deterministic inference, and a controlled final merge stop; they exercise actual plan/admission/dispatch producers before that stop.
- The renamed frozen-prompt replay remains a replay test; it is no longer presented as a producer oracle. No new concealed fake-producer oracle was found in the fix tests.
- **Dispatch 3 claims explicitly deferred by the report:** full real bundled/carry ordered serialized-call comparisons, controlled path/UUID/TAP nondeterminism, shadow through those same producers, and both real fresh/continuation GSD input envelopes. Its GSD fixture has no call events or profile digest. The independent checks above do not replace that permanent harness work.

## Validation

- Five individual files passed **108/108**: `build-model-route`, `gsd-model-route`, `routing-journal`, `routing-ledger`, `build-wave-routing`; log `/tmp/s1a-r2-targeted.log`.
- Added disposable reload probes **4/4**, historical same-provider off-resume probe **1/1**, and individual bundled off, carry off, bundled shadow golden producer runs **1/1 each**.
- `git diff --check` passes; frozen fixtures, helper files and integration files remain unchanged against HEAD.
