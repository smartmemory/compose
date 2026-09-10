# S1a Dispatch 2 correctness review r1

Verdict: **4 HIGH, 1 MEDIUM, 0 LOW**.

Reviewed the working tree against `20883d5ad6e9dd48a757da21bf771c7291d479f6`, including the additional edits to `lib/consumer-fanout.js` and `lib/routing-ledger.js`. No production/test/fixture files were edited or regenerated. All probes used disposable workspaces; loader instrumentation changed test modules in memory only.

## Numbered findings

1. **HIGH — A fresh Build selected after probing a terminal old flow inherits the old routing mode and bypasses unsupported-option refusal.**
   - Locations: `lib/build.js:3773`, `lib/build.js:3778`, `lib/build.js:3951`, `lib/build.js:4019`, `lib/build.js:4055`.
   - `recordedRunId` determines `routeOptions` before `decideBuildStart` knows whether this is actually a resume. When the old active row says running/failed but its engine flow is terminal, the runner correctly chooses fresh, then passes the already-selected old mode into `startFresh`. It never evaluates the new invocation's routing options.
   - Reproduction through public `runBuild`: complete the ordinary off fixture, leave its active-build row `status:running` with a dead pid (the crash-before-terminal-bookkeeping case), then invoke `route_mode:shadow` without `fresh:true`. The runner prints “No resumable build found. Starting fresh”, makes a second plan/model call, and produces **no routing journal**. Repeating with `route_mode:active` also makes that second model call instead of raising `ROUTING_SLICE_UNAVAILABLE`. The same branch skips trials/exploration/feedback validation. Logs: `/tmp/s1a-terminal.log`, `/tmp/s1a-active.log`; loaders: `/tmp/s1a-terminal-loader.mjs`, `/tmp/s1a-active-loader.mjs`.
   - Fix: separate recorded-resume validation from fresh configuration. Once the verdict becomes fresh, resolve and validate current mode/roles/runtime overrides again, refresh preflight, and use those values at both fresh call sites. Add a public-runner terminal-old-flow test that asserts zero new plan/model calls for unsupported options and a new shadow start for a valid shadow request.

2. **HIGH — The “routing transport never enters prompts” invariant is not enforced for valid custom participating specs.**
   - Locations: `lib/build.js:927`, `lib/build.js:929`, `lib/build.js:940`, `lib/gsd.js:651`; declaration-only validation at `lib/routing-ledger.js:164`.
   - The runner appends the complete start to flow input and forwards interpolated `step.do` unchanged. It checks transport declarations but does not reject transport references in model-facing expressions.
   - Real-engine reproduction: copy the bundled GSD spec to a disposable local pipeline and append `Routing debug: ${input.routing_root} ${input.routing_start}` to `decompose_gsd.do`. Shadow planning succeeds; the first `agentRun` prompt contains the root and serialized start, including routing policy/metadata. The run makes four calls; the first prompt is 12,661 characters. No refusal occurs. Log: `/tmp/s1a-input-probe2.log`; probe: `/tmp/s1a-extra-probes.mjs`, test `PROBE whole input interpolation leaks routing`.
   - This is a custom-spec boundary failure; the bundled prompts themselves did not leak transport in the independent trace comparison below. Bare `${input}` was rejected by the engine, but explicit declared transport references were accepted.
   - Fix: validate model-facing interpolation and subflow/input forwarding before requesting a participating plan; reject references that expose reserved routing transport. Preserve ordinary prompt bytes. Add a real-engine negative test proving refusal before plan/model dispatch.

3. **HIGH — Existing multi-stage consumer waves break when an otherwise valid run participates in shadow.**
   - Locations: `lib/build.js:1302`, `lib/build.js:1307`, `lib/build.js:1397`–`1411`; `lib/consumer-fanout.js:817`. An additional start-construction failure is at `lib/routing-ledger.js:182`–`188`, reached from `lib/build.js:927`.
   - Admission intentionally excludes multi-stage fanouts from routing, but legacy `tier_from`/`_consumer` waves still create dispatch bindings. A participating journal unconditionally requires every such binding to have a routing link. This contradicts §6's requirement to preserve multi-stage validation/dispatch while deferring those observations.
   - Real public GSD/TS-engine reproduction: add a second identical Claude stage to bundled execute and use `{_consumer:{execute:{}}}`. Off reaches the merge gate with **7 calls**; shadow makes the decompose call, then raises `ROUTING_BINDING_MISSING: Participating dispatch requires a routing link` before any worker. Log: `/tmp/s1a-multistage-consumer2.log`; probe: `/tmp/s1a-multistage-consumer.mjs`.
   - With `{execute:{default:'claude',tier_from:'item.tier'}}`, off likewise makes 7 calls, but shadow fails even earlier with `ROUTING_SCHEMA_INVALID` and zero calls: preflight stores fanout-level provenance while start creation reads nonexistent `execute/0` and `execute/1` provenance. Log: `/tmp/s1a-extra-probes.log`.
   - Fix: consistently distinguish supported routed steps from deferred multi-stage steps in start construction and journal binding validation. Preserve legacy bindings for explicitly deferred steps without weakening missing-link detection for participating single-stage steps. Test both configurations through both runners, including a mixed ordinary/single-stage/multi-stage run.

4. **HIGH — Public Build `fresh:true` silently recreates a lost participating journal through the old-wave cleanup path.**
   - Locations: `lib/build.js:3959`–`3962`, `lib/consumer-fanout.js:515`–`519`; the new existence/witness guard at `lib/build.js:874` is bypassed.
   - `opts.fresh` skips `resumeRouting`, then the fresh verdict constructs `ConsumerFanoutArtifacts` merely to inspect the previous wave. That constructor creates a journal when absent; no routing binding is supplied, so the replacement is an empty **legacy** journal despite the persisted routing initialization witness.
   - Public-runner probe: complete the ordinary shadow fixture, delete its external journal, then call `runBuild` with `fresh:true, route_mode:off`. The old journal path is recreated with `routing` absent. A subsequent planning/recovery refusal occurs before another model call, but the evidence path has already been repopulated incorrectly. Log `/tmp/s1a-fresh-loss.log`; loader `/tmp/s1a-fresh-loss-loader.mjs`. This is distinct from the shared fresh-helper loss test, which correctly refuses without construction.
   - Fix: make old-wave inspection read-only and check recorded participation plus the external initialization witness before any constructor can create storage. A missing initialized journal must remain missing and raise the named evidence-loss refusal. Add a public `fresh:true` test asserting zero model calls **and no recreated journal**, including an ordinary-only previous run.

5. **MEDIUM — The frozen-oracle tests bypass the prompt/dispatch producers and overstate their coverage.**
   - Locations: `test/build-model-route.test.js:106`, `:124`, `:280`–`304`; `test/gsd-model-route.test.js:117`–`129`.
   - The dispatch-oracle test feeds `call.prompt` from the frozen expected trace into `runAndNormalize`, derives step/provider/tier/count from that same trace, and compares only provider, that supplied prompt, and six option fields. It does not run the Build prompt producer, scheduler, admission or fresh/resume selection. A prompt-production or call-count regression can pass unchanged.
   - The test named “all three frozen off oracles…” loads only the carry and bundled Build fixtures; it checks the carry digest and one bundled `startFresh` input. The earlier “off matches frozen bundled/carry…” test checks `captured:true`, a hardcoded bundled digest and synthetic input keys, not both runtime traces. The GSD oracle assertion checks only the first/fresh input; its off/shadow comparison filters options and substitutes cwd strings.
   - Fix: drive the existing real golden producers with controlled nondeterministic inputs, compare the complete captured serializable arguments and ordered calls, and explicitly distinguish raw-byte equality from normalized equivalence. Keep the frozen files unchanged. Full golden wiring is assigned to Dispatch 3, but these Dispatch 2 tests must not be presented as that evidence.

## Requested checks and independent evidence

### 1. Off identity

I independently instrumented the existing current-runner golden producers, using `/tmp/s1a-review-trace.mjs`, rather than invoking the expected-prompt replay test as an oracle.

| Current producer | Independent result against frozen fixture |
|---|---|
| Bundled Build, explicit off | Profile digest exactly `310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205`; exact fresh input; 5 calls in the same order. |
| Two-wave carry, default off | Profile digest exactly `247791ff900ad8b6e0bbcba7408591d1a74adbdce1ab9c8833ab6621589cc1cd`; exact fresh input; 12 calls in the same order. |
| Bundled GSD default, old stuck/resume golden | Both captured fresh and continuation input envelopes have identical JSON bytes to the two frozen input events. The GSD fixture contains **no model-call events and no profile digest**, so it cannot certify either. |

**Literal “every model-call argument byte-identical”: no.** Raw Build calls differ in freshly allocated cwd/worktree paths, flow/correlation/build UUIDs, and prompts containing those paths; bundled review/assess prompts also include live TAP durations. These are observed nondeterministic fixture values, not evidence of a routing-induced model change. After substituting only corresponding cwd/workspace strings, UUIDs and TAP durations, the **entire serialized call objects**, without dropping option keys, match the frozen traces for both Build cases. All model/effort/thinking/tool/sandbox values match without normalization. Functions/signals are not represented by the frozen recorder.

Raw traces: `/tmp/s1a-bundled-off.jsonl`, `/tmp/s1a-carry-off.jsonl`, `/tmp/s1a-gsd-off-rerun.jsonl`; field-difference report: `/tmp/s1a-comparison.txt`. The current files were not used to regenerate the expected fixtures.

### 2. Shadow

The real bundled Build producer was run again with shadow. It made the same 5 calls, with identical complete serializable arguments after the same narrowly stated substitutions. Prompt comparisons for plan/execute/verify need only path substitution; review/assess additionally need their live verification durations controlled. No routing root/start/policy entered bundled prompts, and the ordinary `## Inputs` remained `undefined`. The implementation does not add `descriptor.inputs`; `lib/step-prompt.js:104` would serialize it if present. Universal prevention is missing as finding 2 demonstrates.

The shipped one-step synthetic Build comparison at `test/build-model-route.test.js:152` compares provider/prompt/modelID/effort/allowedTools/disallowedTools/sandboxMode/cwd, not every option. The real GSD off/shadow comparison omits telemetry, cwd options, thinking and other unlisted fields; it is not an all-argument oracle.

### 3. Refusal timing and recorded roles

| Case | Current runtime ordering / test strength |
|---|---|
| Missing/drifted start root or run binding on Build resume | `resumeRouting` runs before resume RPC/pump. Independent **public Build** corruption probes all refused with zero model calls: missing root `ROUTING_ROOT_MISSING`, malformed root/binding `ROUTING_SCHEMA_INVALID`, missing binding `ROUTING_BINDING_MISSING`. Logs `/tmp/s1a-refusal-{0,1,2,3}.log`. |
| Shipped root/binding/journal corruption tests (`test/build-model-route.test.js:82`) | Call `resumeRouting` directly and count helper RPCs. They cannot catch a regression that moves a model call ahead of this helper in `runBuild`; the helper fixture has no model dispatcher. |
| Recorded roles win over new flags | Public `runBuild` test at `test/build-model-route.test.js:248` passes: recorded critical Codex survives `route_mode:off` and invalid new role flags; one plan total and the expected Astra call. |
| Active/trials/exploration/feedback | Fresh routing options reject before plan/dispatch on the ordinary fresh path. Tests at `test/build-model-route.test.js:120` call only `routingOptionsFor`; no public dispatch counter. Finding 1 demonstrates a real fresh branch where active is accepted and dispatched. |
| Customized GSD ordinary profile (Q1) | `lib/gsd.js:165` refuses before plan; public test at `test/gsd-model-route.test.js:185` asserts both zero plans and zero model calls. This test would fail for a late refusal. Resume applies the same baseline check before its new plan. |

### 4. Admission and source binding

Route-only single-stage waves enter whole-wave admission in both public runners (`lib/build.js:4499`, `lib/gsd.js:564`). Legacy Git HEAD/base acquisition and waveAdmissions are inside the `legacy` branch (`lib/build.js:1399`). New no-tier/no-_consumer tests pass, including sixth-item refusal before workers. The unborn-HEAD/isolation:none helper case passes without task ids, ownership, worktrees or a legacy admission.

`admittedRoute` keys the map by admission/scoped step/stage/logical task, checks retained baseline/root and an existing map value, then returns the map's resolution (`lib/build.js:1037`). Admission consumes it before dispatch bindings (`:1290`); consumer launch checks it again (`:1571`). In S1a the retained admitted/would/baseline values agree. Tests check stage 0 and stored links; they do not negatively corrupt the in-memory map.

The real GSD merge-error test (`test/gsd-model-route.test.js:131`) passes: production merge handling revises execute to epoch 1, decompose remains epoch 0, the source token/output and logical wave persist, and worker call count rises from 4 to 7. Replaced source token/output and stale epoch/index/generation refuse in `admitConsumerWave` before dispatch. The negative test at `:194` calls that helper directly; it does not prove public scheduling order against a future late-check regression. Existing tested single-stage tier/_consumer waves pass; multi-stage compatibility fails as finding 3.

### 5. GSD continuation and producers

The three-run test is **not a synthetic filtered graph passed directly to the ledger**. It runs public `runGsd` and the real TS engine three times; the real decompose validator/enricher produces the first graph, and `loadResumeTaskGraph` plus `planWithRouting` produce subsequent plans. It checks durable continuation intent inside the plan interception, before the RPC, and old→new run bindings, cumulative `[A,B]`, dependency removal, C indices 2→1→0, retained admission/allocation and distinct linked issuances.

Its boundary is material: `test/gsd-model-route.test.js:76` manually writes schema-valid blackboard results and pause/dead-pid state files. It does **not** exercise the actual halt/crash writers or worker-produced TaskResult files. All three workers have settled before each artificial merge stop; the fixture then chooses which completion results exist.

Production `verifiedCompletedTaskIds` is genuinely derived from validating **blackboard ∪ result files** (`lib/gsd.js:1625`), including conflict rejection, before filtering (`:1357`). It is not inferred from remaining graph ids. `createContinuationIntent` checks those ids against settled issuance evidence and the retained completion chain (`lib/routing-ledger.js:491` onwards). Unknown/conflicting completion, description drift and lost settlement tests call public GSD and assert unchanged plan/model counts; those late-refusal regressions would be caught. Lost-plan zero/multiple/unreadable matching cases run through the shared fresh helper with synthetic engine snapshots, not a real interrupted GSD RPC.

### 6. Storage

Snapshot/exclusion paths pass; journal-loss handling has the public fresh-path exception in finding 4. The fresh start installs the anchored local Git exclude before writing (`lib/routing-ledger.js:90`); consumer artifacts honor an external artifact root in both runners. I additionally called production `snapshotWorkingTree` and inspected its Git tree: no `.compose/routing` paths (`/tmp/s1a-storage.log`). The shipped storage test also verifies status, add -A, clean -fd and committed-tree exclusion/preservation. Real bundled shadow wave/ship passes its checkpoint/tree checks.

The initialization witness is checked before journal construction (`lib/build.js:874`). Lost participating journal tests refuse before calls, and a separate fresh-helper probe with a deleted initialized journal also refused instead of recreating it. However, neither covers the earlier public `fresh:true` constructor, which recreated the deleted journal in my additional probe (finding 4). No unconditional storage mutation was observed for the clean off fixtures. These checks do not claim protection against explicitly force-adding reserved files after initialization.

### 7. Non-participating callers, exports and controller test edit

The current non-participating single-stage Build/carry and GSD goldens pass, as do profile regression tests and Dispatch 1 tests. New `routingJournalPath` (`lib/consumer-fanout.js:290`) delegates to the existing canonical location; `pendingRoutingPlans` and `readRoutingRunBinding` (`lib/routing-ledger.js:541`, `:555`) expose existing immutable readers/discovery. Their addition does not alter an existing signature. `runOneStep` is newly exported by GSD for testing. The newly reached Dispatch 1 multi-stage provenance assumption is covered by finding 3.

The controller-applied legacy-shape derivation at `test/pipeline-profiles.test.js:94` is **faithful for the shipped preset**. I independently reconstructed its value and deep-compared it with `git show 20883d5:presets/team-fable-astra.profiles.json`: equal. It removes only `_routing` and the two `route` fields, unwraps the route-only plan object to its old string, retains execute's legacy object, and independently pins the original digest.

### 8. Fake-producer inventory

- `frozen bundled and carry dispatch oracles match current static connector options and unchanged prompt bytes`: expected prompts/provider/tier/order are replayed directly; bypasses the production Build producers (finding 5).
- `all three frozen off oracles retain exact input envelopes and both Build profile digests`: a fake plan receiver observes real `startFresh`, but no engine/dispatch or GSD producer runs; only two fixture files are read.
- `off matches frozen bundled/carry profile digests and Build feature envelope without storage`: synthetic ordinary fixture and input-key check; not two real frozen traces.
- `public Build ordinary shadow preserves exact prompt/model/effort/tool/sandbox bytes and call count`: real Build runner, **synthetic plan/ready/state producer**, single ordinary step rather than bundled Build.
- `routing-only whole-wave Build ...` and `GSD routing-only no-tier/no-consumer ...`: real runners/admission, synthetic wave source. They temporarily remove the source accepted token during plan and restore it on first audit (`test/build-wave-routing.test.js:171`, `test/gsd-wave-routing.test.js:61`); they do not pin real source production.
- `real GSD three-run continuation ...`: real resume/plan/enrichment/engine, seeded completion and pause/crash producers as described above. `bundled GSD merge error ...` invokes real `runOneStep` but injects `ConsumerMergeDecisionError`, not an actual conflicting-diff producer.
- Fresh ordinary/retry/epoch/root/lost-ack/scoped-child tests use hand-written engine snapshots. They exercise the shared routing helpers, not the real engine transitions their snapshots represent.

## Execution record

- Targeted request files: `node --test --test-timeout=300000 test/build-model-route.test.js test/gsd-model-route.test.js test/build-wave-routing.test.js test/gsd-wave-routing.test.js test/pipeline-profiles.test.js` — **99/99 passed**, `/tmp/s1a-d2-review-tests.log`.
- Dispatch 1 regressions: `test/routing-ledger.test.js test/routing-journal.test.js test/model-router.test.js` — **37/37 passed**, `/tmp/s1a-d1-regression.log`.
- Individual real golden cases: bundled Build off and shadow **1/1 each**; carry “two carried waves” **1/1**; GSD “same-file edit loop|skips completed T01” **2/2** with `STRATUM_STATE_ROOT=/tmp/s1a-gsd-state`.
- The initial old GSD golden attempt failed with sandbox EPERM under `~/.stratum/ts/flows`; redirecting only its state root resolved it. No GUI launch, full suite, paid model run or fixture regeneration occurred.
- Public resume-corruption probes **4/4** rejected before model calls; adversarial branch/multi-stage/interpolation/journal-loss probes produced findings 1–4. These results are independent of the implementer's reported 165/165 host run. `git diff --check` passed.
