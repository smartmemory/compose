# COMP-MODEL-ROUTE S1b — dispatch 2 implementation

Date: 2026-09-11. Working tree implementation on `main`, building on dispatch 1 (`ecea9db`). No repository commit or staging performed. The pre-existing untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json` was left alone.

Runtime observation now connects the dispatch-1 journal, receipt and ledger primitives to Build and GSD. The connector boundary alone creates call intents. Normalization, repair, `runAgentText` and auxiliary producers pass immutable bindings. Final verification counts and host limitations are recorded below; this report does not certify dispatch 3 or live-provider completion.

## Dispatch-2 acceptance map

The numbers match the ten checkboxes at `blueprint-slice1b.md:172`. The source blueprint remains unchanged; the compatibility qualification in item 8 is explicit.

| # | Implementation and touched anchors | Producer test receipts |
|---|---|---|
| 1 | `lib/routing-runtime.js:75` binds supported calls or null-issuance unsupported observations. `lib/build.js:1782` binds each consumer stage; `lib/build.js:4797` covers ordinary/retry work. Normalization children retain parent intent. Probe, QA, scoped fixer, policy revision, review fixer and both escalation stages pass bindings. Recovery ingests persisted engine receipts and creates explicit coverage gaps (`lib/routing-runtime.js:207`). | `test/routing-calls.test.js:26`, `:122`, `:143`; `test/build-model-route-outcomes.test.js:137`, `:147`, `:160`, `:226`, `:281`. The engine-fanout test launches two actual fake-CLI workers and resumes the public runner after their completion. |
| 2 | MCP wrapper id is minted before observation at `lib/stratum-mcp-client.js:274`; local wrapper at `lib/local-claude-connector.js:216`. Both record success/error. MCP prelaunch abort retains not-executed identity. Internal observer is stripped from transport. Local raw effort is null (`lib/routing-runtime.js:46`); fallback ids and engine tokens cannot create paid joins. | `test/routing-calls.test.js:26`, `:36`, `:43`, `:56`, `:122`. |
| 3 | Immutable per-descriptor binding survives concurrent primary/repair ordering and reload. Receipt ownership is original-run ownership, independent of connector arrival (`lib/routing-runtime.js:119`, `:159`, `:207`). | `test/routing-calls.test.js:77`: prescribed wrapper UUIDs independent of journal; B returns before A, A repair returns before B repair; independent costs A=1, B=2, A-repair=3, B-repair=4 imply parent-inclusive costs 4 and 6. Assertions use original descriptors, then reopen and deliver. |
| 4 | `lib/build.js:1177` requires exact route-metadata acknowledgement before launch. `lib/routing-runtime.js:59` constructs raw per-call receipts, and `:75` atomically records resolution plus spool before delivery. `lib/build.js:2255` selects that spool regardless of ceiling. GSD uses the same connector observation (`lib/gsd.js:665`), preserving sibling provenance and split. Original owners are recovered before continuation and final materialization. | `test/build-model-route-outcomes.test.js:10`, `:22`, `:174`, `:213`; `test/gsd-model-route-outcomes.test.js:4`, `:26`, `:67`; `test/usage-receipts.test.js:1121`; `test/gsd-model-route.test.js:296`. Dispatch-1 atomic crash tests also rerun in `test/routing-journal.test.js`. |
| 5 | Participating integrity errors escape primary, repair, tolerant review, usage, retry, probe and terminal catches. Relevant anchors: `lib/result-normalizer.js:609`, `:804`, `:832`; `lib/review-normalize.js:161`; `lib/stratum-mcp-client.js:914`; `lib/build.js:1821`. A billable resolution failure leaves an unresolved intent and prevents silent rerun. Unconfirmed repair/consumer transport loss also cannot settle synthetic fallback or retry output. | `test/routing-calls.test.js:61`, `:170`, `:197`; `test/build-model-route-outcomes.test.js:174`, `:271`; `test/usage-receipts.test.js:1121`. |
| 6 | Capture occurs at the top of both real gate closures, before merge preparation and RPC (`lib/build.js:5533`, `lib/gsd.js:756`). `lib/routing-gates.js:33` retains reset closure, ordinary input, original item/source bindings, skipped/null issuance and historical snapshots. `lib/output-gate.js:86` records partition/ownership ambiguity and lineage without enforcement; later capture binds unique full-task digest proposals. Original approve and final merge-adjusted revise/kill are both retained (`lib/routing-gates.js:121`). | `test/build-model-route-outcomes.test.js:45`, `:59`, `:79`, `:102`, `:117`, `:126`; `test/gsd-model-route-outcomes.test.js:57`. Real carry tests cover retained A, old repaired B, new B index 0, and added C without rejecting retained A/B. |
| 7 | Failure settlement at `lib/routing-runtime.js:271` requires the acknowledged original envelope plus matching persisted failed attempt/token removal. Lost acknowledgement replays only a retained envelope while the original token is live; otherwise it refuses. Cancellation at `:189` uses cancelled run audit plus all bound call termination refs, never `stepDone` acknowledgement. `lib/build-cancel.js:195` performs evidence finalization after bounded drain, sharing the local teardown allowance. GSD has a reachable participating cancelled exit and finally recovery. | `test/build-model-route-outcomes.test.js:27`, `:38`, `:190`, `:257`; `test/gsd-model-route-outcomes.test.js:14`, `:20`, `:32`, `:46`; `test/build-cancel-unit.test.js:154`, `:164`, `:173`; dispatch-1 cancellation-precedence tables in `test/routing-outcome.test.js`. |
| 8 | All ten existing no-journal adapter call sites use `test/helpers/routing-adapter-check.js:7`: invoke the same real producer arguments with participation and poisoned inference, require `ROUTING_BINDING_MISSING` with zero calls, then invoke the original off adapter. Real-journal success is exercised separately by both runtime suites. All five hardening sites guard the artifact AND journal, after participation validation: Build `:810`, `:1438`, `:1444`, `:1453`, `:1460`; GSD `:780`, `:809`, `:810`. `publishConsumerCheckpoint → recoverCheckpoint → replicateCheckpoints → capturedWavePaths` was inspected. | `test/build-emission.test.js:279`, `test/gsd-dispatch-instrumentation.test.js:82`, `test/review-fixes-runtime.test.js:137`, `test/ts-cutover-e3-round3.test.js:77`, `test/ts-cutover-e3-round4.test.js:71`, `test/ts-cutover-e3-round5.test.js:238`, `test/usage-receipts.test.js:707`, `:780`, `:1091`, `test/integration/agent-lanes-pipeline.test.js:82`. **Host qualification remains:** the integration watcher test fails identically at unchanged HEAD, and one process-inspection test cannot run in this sandbox. See per-file results. |
| 9 | `lib/routing-gates.js:155` distinguishes durable token-response, independently validated persisted carry/reset token witness, ordinal, and unconfirmed. A prepared token/merge transaction alone cannot acknowledge. Plain merge approval captures integration but grants no downstream acceptance. | `test/build-model-route-outcomes.test.js:45`, `:68`, `:94`, `:247`. Lost response without carry remains ordinal; actual carry token, next round, retained decision task digest and reset epochs can prove the consumed request. |
| 10 | Shared recovery at `lib/routing-runtime.js:207` reloads original owners, joins already-started late completion writes, ingests engine evidence, flushes exact spool bytes and materializes incomplete rows. It makes no model call. Build plan/resume (`lib/build.js:960`, `:1017`), gate, hold/error/finalizers (`:6442`, `:6481`) and cancellation callback (`:4157`) participate. GSD installs/reconciles before dispatch and recovers on pause, terminal and finally paths (`lib/gsd.js:339`, `:489`). | `test/build-model-route-outcomes.test.js:174`, `:247`, `:257`, `:281`; `test/gsd-model-route-outcomes.test.js:14`, `:20`, `:32`, `:46`; `test/gsd-model-route.test.js:115`, `:296`; `test/routing-calls.test.js:177`. Pending cancelled receipts remain locally owned and incomplete. |

## Integration details and authoritative-document corrections

- Added `lib/routing-runtime.js` and `lib/routing-gates.js` as shared adapters over the dispatch-1 APIs. No schema, Stratum sibling, preset, routing selection, floor, report-product or durability-policy implementation changed.
- Engine receipts are read in their **persisted `ReceiptRecord.amount` shape**, with sequence/id evidence; known Compose spool entries are cross-checked and are not duplicated as unsupported engine calls. The real engine stores fanout physical fields under `detail.item.{itemIndex,stage,generation}`, so ingestion reads that nested producer shape. Actual fake-CLI fanout emits `legacy:<seq>` receipt ids but `usdSource:'reported'` when provider price is supplied. Engine synthesis uses `usdSource:'legacy'` only for unlabelled USD (`../stratum/ts/src/engine/engine.ts:2753`, `../stratum/ts/src/engine/receipts.ts:38`). A legacy id is never a connector identity. The report does not assume all engine receipts have legacy price provenance.
- Actual engine `usageReport` returns `status:'ok'` with `receipt.seq`; the adapter translates its successful/duplicate result to the dispatch-1 delivery contract (`lib/routing-runtime.js:24`). Raw known cost without usable provenance stays locally pending/incomplete if the engine rejects it; missing facts are not made into zero.
- The dispatch-1 schema has no dedicated full-decision evidence record. Gate decision, original review, source states, round and merge projection are retained in a referenced `epoch-binding.graph`, with a graph digest; `gate-disposition.findingsRef` links them. Observation-only pre-seal captures use `capture_` identities, excluded from `sealRoutingEpochs` safety-seal lookup (`lib/build.js:1201`). Capturing an unissued/skipped allocation cannot make continuation safe.
- The blueprint's pre-reset top-of-closure ruling and connector-only intent ownership were followed. Normalization repair remains MCP even behind a local SDK primary. Local executed tier stays null; Q3 remains open for S3. GSD sidecar dispatch remains unchanged.
- Internal observer options are non-enumerable (`lib/routing-runtime.js:310`) and removed at the connector boundary. Existing off/shadow option traces retain their serialized identity while producers can read the binding.
- Engine work can still be running when the public Build runner pauses. Recovery at that return records coverage; public resume after real engine completion ingests paid receipts. The engine-fanout producer test verifies one Compose primary call and two engine worker launches across pause/resume; no new polling policy or engine behavior was introduced.

## Verification

Tests were invoked per file so results cannot hide an omitted file. Each command used a disposable state root, empty payment/email keys, direct file redirection and explicit exit status; no test was piped to `tail`.

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d2-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY=   node --test --test-timeout=300000 test/<file>.test.js   > /tmp/d2-final-verification/<file>.test.js.log 2>&1
route_status=$?
echo "$route_status" > /tmp/d2-final-verification/<file>.test.js.log.exit
echo "$route_status"
```

The command template above was instantiated separately for every required file below. Their individual TAP result records total **218/218 passed**, with exit 0 for each file. Earlier compatibility runs used the same environment and node flags with logs in `/tmp/d2-verification/`. No full-suite result is asserted.

| Required file | Passed / executed | Exit |
|---|---:|---:|
| `test/routing-calls.test.js` | 18/18 | 0 |
| `test/build-model-route-outcomes.test.js` | 28/28 | 0 |
| `test/gsd-model-route-outcomes.test.js` | 8/8 | 0 |
| `test/routing-join.test.js` | 11/11 | 0 |
| `test/routing-outcome.test.js` | 19/19 | 0 |
| `test/routing-ledger-materialize.test.js` | 10/10 | 0 |
| `test/routing-ledger.test.js` | 19/19 | 0 |
| `test/routing-journal.test.js` | 16/16 | 0 |
| `test/routing-evidence-validation.test.js` | 10/10 | 0 |
| `test/usage-receipts.test.js` | 32/32 | 0 |
| `test/model-router.test.js` | 7/7 | 0 |
| `test/pipeline-profiles.test.js` | 40/40 | 0 |

| Additional compatibility file | Passed / executed | Qualification |
|---|---:|---|
| `test/build-model-route.test.js` | 41/41 | Existing ordinary/consumer/off/shadow routing regressions. |
| `test/gsd-model-route.test.js` | 20/20 | Real-engine bundled GSD, continuation, off/shadow connector projections and original-owner late delivery. |
| `test/build-emission.test.js` | 16/16 | Original adapter plus missing-journal refusal. |
| `test/gsd-dispatch-instrumentation.test.js` | 2/2 | Original adapter plus missing-journal refusal. |
| `test/review-fixes-runtime.test.js` | 15/15 selected | `--test-skip-pattern='a refused group signal'`; the initial unrestricted file was 15/16 because the omitted test's `spawnSync ps` is denied with EPERM. |
| `test/ts-cutover-e3-round3.test.js` | 12/12 | Original adapter plus missing-journal refusal. |
| `test/ts-cutover-e3-round4.test.js` | 8/8 | Original adapter plus missing-journal refusal. |
| `test/ts-cutover-e3-round5.test.js` | 10/10 | Original adapter plus missing-journal refusal. |
| `test/round3-execution.test.js` | 7/7 | Additional no-artifacts producer population. |
| `test/build-cancel-detect.test.js` | 41/41 | Existing cancellation/no-artifacts behavior. |
| `test/build-cancel-unit.test.js` | 18/18 | Includes evidence after drain, refusal escape and bounded timeout. |
| `test/stratum-flow-cancel-client.test.js` | 16/16 | Connector cancellation contract. |
| `test/integration/agent-lanes-pipeline.test.js` | 0/1 | Lane reducer receives 0 lanes, expected 2. Missing-journal refusal executes before that assertion. The unchanged HEAD archive reproduces 0/1 with the same assertion; log `/tmp/d2-verification/HEAD-agent-lanes-pipeline.log`. Host watcher delivery remains unverified. |

No GUI, network provider, port binding, dependency installation or sibling edit was used. No process-inspection workaround was attempted after the sandbox denial. Existing server on :4001 was untouched. Temporary Git commits made by existing/new test fixtures are confined to disposable test workspaces, not this repository.

`git diff --check` and syntax checks were run. The frozen fixture bytes were compared directly with `git show HEAD:<path>`: **3/3 unchanged**. SHA-256 values:

| Frozen fixture | SHA-256 |
|---|---|
| `model-route-off-bundled-build-v0.5.1.json` | `dcb7be4001879664d347a12abec6106a458329f7e61ca320ba211e9c7e77bf3a` |
| `model-route-off-carry-v0.5.1.json` | `f806519cb4d86317e4565e0eb9e8280c21e1129ff0c569ae033006f70e9d679c` |
| `model-route-off-gsd-input-v0.5.1.json` | `1fa3aae48bb0d0d928e8b6554d6e499f40dfcf32566737f2e5630a3f194b8ae2` |

## Dispatch 3 and host work deliberately outstanding

Dispatch 3 owns the exhaustive frozen Build/carry and GSD continuation golden runs, complete/excluded spend qualification across its full producer matrix, documentation in README/team-presets/CHANGELOG/progress, and separately authorized real-provider shadow completion evidence. Existing bundled GSD regression tests ran here; the longer dispatch-3 golden command and full `npm test` did not. Host verification must revisit the process-inspection exclusion and the baseline watcher failure. Controlled inference with a real engine does not satisfy the live-fire requirement. No live-provider result is claimed, and the parent feature remains incomplete pending later slices.

## Review round 1 disposition

Verified the six findings against the current producer paths before changing their implementation. The pre-change 15-file baseline was rerun with a disposable state root per process: **297/297 passed**, with every file counted separately (`/tmp/d2-review-baseline/`). No finding was dismissed wholesale. Finding 4 contains one inaccurate supporting claim, distinguished below.

1. **Unresolved policy revision — confirmed and fixed.** The ordinary transport-error catch retained the original successful draft even though the connector journal recorded the revision's termination as uncertain. The new public-runner test `policy revision transport disconnect cannot settle or approve its parent and resume refuses reissue` failed before the fix with `Missing expected rejection` (`/tmp/d2-red-policy.log`): the approving gate was reachable. The catch in `lib/build.js` now checks `routingCallsTerminated` over the original issuance and its inclusive child calls before retaining a draft. The regression checks resolved plus unresolved calls, unknown/excluded parent, no stepDone or settlement, and an actual public Build resume refusal without another call.

2. **Second repair lineage — confirmed and fixed.** The original capture correctly retained historical B0, but the next ownership check treated B0 and B1 as concurrent owners of `b.txt`. The new `two real carry repairs retain A and bind B0 to B1 to B2 with repair depth two` test failed with A `unknown` instead of `accepted` (`/tmp/d2-red-build.log`). `prepareRoutingGate` now excludes predecessors retired by completed lineage with valid partition/ownership evidence and token acknowledgement when selecting current owners; immutable snapshots still retain them. Capture also stops rebinding an already completed proposal in subsequent rounds. The runtime fixture can now perform two repairs, including an identical replacement task payload in successive rounds. The test checks A accepted, B0/B1 repaired, B2 accepted, both predecessor references, and depth 2.

3. **Contradictory normalized receipt fields — confirmed and fixed.** `reportObservedUsage` previously checked only USD and aggregate tokens. Six independently changed fields passed through a real normalizer result without refusal in the pre-fix test (`/tmp/d2-red-usage.log`). Forwarding now also checks known duration, model, effort and provenance against the original resolution, and input/output/cache split against the original canonical spool. Missing raw evidence remains unknown; normalization defaults do not create new raw facts. `real normalizer forwarding refuses contradictory …` covers eight independent alterations (including a total-preserving split change), with both returned-usage and actual MCP-progress/streamed-usage normalizer branches. It forwards `runAndNormalize(...).usages`, never a receipt read out of the journal. Unchanged output succeeds, changed output refuses before delivery, and the canonical amount/split remain unchanged.

4. **Fallback identity coverage — confirmed gap; one supporting claim corrected.** The new normalizer and `runAgentText` tests delete the returned connector ID after the real boundary records its call, then let each real downstream producer generate its own fallback UUID. They forward that result and a `legacy:17` substitution against the same supported issuance and verify neither ID enters the spool or paid join; the original connector ID alone owns the call and cost. A mutation that admits unmatched forwarded identities makes both tests fail (`/tmp/d2-mutant-fallback.log`). However, the existing reserved-ID test was **already a supported-join rejection**, not just unsupported classification: `test/routing-join.test.js`, test `receipt detail is a separate closed schema; missing ids remain null, local effort stays null`, obtains `i = f.issue()` and calls `beginCall(f, i, { callSite: callId, callId })` for `legacy:1`, the issuance token, and a reserved Compose ID. `beginCall` uses `f.observer(i)`, which binds `issuanceId: i.id`. That existing evidence was retained, alongside the new production-forwarding challenge.

5. **Signal teardown and GSD reissue coverage — confirmed and closed.** Deleting the actual `runBuild` signal handler's `finalizeEvidence` callback leaves the old 18 cancellation tests green and makes the new public signal test fail (mutation logs `/tmp/d2-mutant-signal-{old,new}.log`, exits 0 and 1). The new test starts a real paid primary call, leaves its delivery pending, suspends the real policy-revision call, emits SIGINT through the installed production handler, and observes persisted state at the exit boundary while `drained` is still unresolved. It requires unknown/excluded parent evidence, an unconfirmed child, original-run receipt ownership and pending paid bytes, no stepDone/settlement, and a rejected resume with no new call. Removing the callback cannot be masked by the suspended runner's later catch/finally. The existing GSD `blocks reissue` test now retries the original engine-issued descriptor through `runOneStep` using its unchanged production routing context. It verifies that cancellation revoked the token and requires `ROUTING_BINDING_DRIFT` at the dispatch boundary. It also invokes `resumeRouting`, the reconciliation entry used by GSD continuation, requires `ROUTING_ISSUANCE_UNCERTAIN`, and rechecks call/report counts. No production teardown change was needed.

6. **Three adapter populations — confirmed and closed.** All ten literal adapter sites still use `checkedConsumerAdapter`. It now runs missing-journal refusal, the original nonparticipating scenario, and an isolated participating replay of that scenario's provider stimuli. The replay uses `planWithRouting`, a real Stratum engine-issued descriptor, the real `ConsumerFanoutArtifacts` journal, real consumer/normalizer/local-or-MCP connectors, and actual receipt delivery/recovery. It copies provider messages and operator events, not journal records, bindings, acknowledgements or outcomes. Each replay verifies the same transport and primary/repair count, durable inclusive ownership and receipts, preserved successful normalized output or failure/control exit, and receipt-only spend reporting. Timeout cases wait for the real abort in the same provider stage, with a larger wall-clock allowance for journal I/O. Replays serialize their temporary environment changes. Disabling the local connector's intent producer leaves the original two-population round-3 file at 12/12 but makes the three-population file fail 2 tests (`/tmp/d2-mutant-adapter-{old,new}.log`).

**Additional oracle repairs.** The public Build intent/resolution fault tests now inject ordinary persistence errors and require the production wrapper to classify them. The paid-receipt fault writes independently corrupted bytes through the real spool before the original producer retries its canonical payload; the real spool raises `CONSUMER_EVIDENCE_MISMATCH`. The `runAgentText` integrity test likewise changes real normalized cost and calls the actual forwarding sink instead of throwing its asserted refusal itself. The old journal-read-and-refeed receipt oracle was replaced by the producer tests in item 3.

### Review verification commands and per-file counts

The per-file baseline used the first 15 paths in the table below. Final verification additionally covers every adapter file. Each invocation gets its own disposable `STRATUM_STATE_ROOT`; no test output is piped to `tail`. `/tmp/d2-review-run.py` executes each listed file as a separate process, redirects stdout/stderr directly to `/tmp/d2-review-final/<file>.log`, writes the numeric subprocess exit code to `<file>.log.exit`, and prints that code with that file's TAP counts. Its command is equivalent to:

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d2-review-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  node --test --test-timeout=300000 test/<file>.test.js \
  > /tmp/d2-review-final/<file>.log 2>&1
route_status=$?
echo "$route_status" > /tmp/d2-review-final/<file>.log.exit
echo "$route_status"
```

For `review-fixes-runtime.test.js`, the command additionally uses `--test-skip-pattern='a refused group signal'` because that test executes the prohibited `ps` command. Counts below are for the 15 selected tests in that file; no result is claimed for the excluded test. Mutation checks use the same environment/redirection, `--test-timeout=60000`, and the test-name selectors described above. All temporary production mutations were restored in `finally` blocks.

| File | Baseline passed / executed | Review passed / executed | Exit |
|---|---:|---:|---:|
| `test/routing-calls.test.js` | 18/18 | 20/20 | 0 |
| `test/build-model-route-outcomes.test.js` | 28/28 | 30/30 | 0 |
| `test/gsd-model-route-outcomes.test.js` | 8/8 | 8/8 | 0 |
| `test/routing-join.test.js` | 11/11 | 11/11 | 0 |
| `test/routing-outcome.test.js` | 19/19 | 19/19 | 0 |
| `test/routing-ledger-materialize.test.js` | 10/10 | 10/10 | 0 |
| `test/routing-ledger.test.js` | 19/19 | 19/19 | 0 |
| `test/routing-journal.test.js` | 16/16 | 16/16 | 0 |
| `test/routing-evidence-validation.test.js` | 10/10 | 10/10 | 0 |
| `test/usage-receipts.test.js` | 32/32 | 47/47 | 0 |
| `test/model-router.test.js` | 7/7 | 7/7 | 0 |
| `test/pipeline-profiles.test.js` | 40/40 | 40/40 | 0 |
| `test/build-model-route.test.js` | 41/41 | 41/41 | 0 |
| `test/gsd-model-route.test.js` | 20/20 | 20/20 | 0 |
| `test/build-cancel-unit.test.js` | 18/18 | 19/19 | 0 |
| `test/build-emission.test.js` | — | 16/16 | 0 |
| `test/gsd-dispatch-instrumentation.test.js` | — | 2/2 | 0 |
| `test/review-fixes-runtime.test.js` | — | 15/15 | 0 |
| `test/ts-cutover-e3-round3.test.js` | — | 12/12 | 0 |
| `test/ts-cutover-e3-round4.test.js` | — | 8/8 | 0 |
| `test/ts-cutover-e3-round5.test.js` | — | 10/10 | 0 |
| `test/integration/agent-lanes-pipeline.test.js` | — | 1/1 | 0 |

Final result: **381/381 passed across 22 files**. The original 15-file population grew from 297 to **317 tests**, all passing. The previously reported lane-watcher failure did not reproduce in this review run: the integration file passed with all three adapter populations.

Frozen off-mode fixtures were compared byte-for-byte against HEAD: all three remain unchanged, with the same SHA-256 values recorded above. `git diff --check` passed. No staging or commit was performed. The unrelated COMP-ROADMAP work and `COMP-GUARD-CLAIM-1/audit.json` were left untouched. The running server, dependency symlink and Stratum home state were not changed. These results do not claim full-suite or live-provider verification.

## Review round 2 disposition

Both regressions were independently reproduced before production edits. Only `lib/routing-runtime.js` and `lib/routing-gates.js` changed in this round, together with their producer tests, test helpers and this appended report. Findings 1, 4, 5 and 6, including the partial rejection of 4, remain intact.

### A — unchanged Codex output rejected: confirmed and fixed

The supplied public Build reproduction was rerun against this checkout using the real Stratum `CodexConnector`, controlling only SDK events. `/tmp/r2-local-A-red.log` records **1 test, 0 pass, 1 fail**: one successful $0.20 call, zero `stepDone` calls, unknown/excluded parent, and `ROUTING_CALL_EVIDENCE_CONFLICT` on the unchanged event model. After the fix the same reproduction passes unchanged (**1/1**, `/tmp/r2-local-A-green.log`). The connector emits `gpt-5.4/high` in `step_usage` and `{model:'gpt-5.4', effort:'high'}` in telemetry.

`lib/routing-runtime.js:158` now interprets the Codex model/effort grammar on both sides before comparison. It compares the base model and both explicit and embedded effort; changing the suffix cannot hide behind an unchanged explicit effort. This follows the producer's first-slash grammar (`../stratum/ts/src/connectors/base.ts:73`), without hardcoding model names or effort values. Other providers' model strings remain opaque. Canonical connector receipts and the normalizer's output are not rewritten.

The unchanged-input and corruption cases at `test/usage-receipts.test.js:1118` now use `test/helpers/real-codex-tool.js`, which invokes the real connector and wraps its events in MCP progress envelopes. The test supplies SDK messages, not connector telemetry, usage, split, duration or provenance. It forwards the real `runAndNormalize(...).usages` before independently altering a field. Existing cost, total-token, duration, model, effort, provenance, total-preserving split and cache assertions remain; embedded-effort corruption is added. Before the fix this strengthened population was **18 tests, 9 pass, 9 fail**, with all nine streamed cases failing on unchanged output (`/tmp/r2-usage-red.log`). With the fix it is **18/18** (`/tmp/r2-usage-green.log`).

The public Build regression at `test/build-model-route-outcomes.test.js:347` additionally requires a successful engine step, one `stepDone`, a settled issuance and exactly one $0.20 paid-call reference. It never supplies settlement or routing records.

**Producer shape census.** The other new comparisons were checked against their actual producers, rather than inferred from the normalized shape:

| Producer | Model / effort | Duration | Price provenance | Token split |
|---|---|---|---|---|
| Stratum Codex SDK and exec | `step_usage.metadata.model` combines model/effort; returned and error telemetry separate them through `modelIdentity`. | Connector elapsed milliseconds are shared by `usage.ms` and `telemetry.durationMs`; normalization emits `duration_ms`. | SDK/JSONL `total_cost_usd` or `cost_usd` becomes event `cost_usd` and, for positive reported cost, returned `usage.usd` plus sibling `usdSource:'reported'`. | Events use `input_tokens`, `output_tokens`, `cache_read_input_tokens`; return/error uses `split.input/output/cacheRead`. Cached input is separate detail, not added again to the total. |
| Stratum Claude MCP | Event model is the requested model; telemetry model is the SDK-resolved model. No combined effort grammar or model-alias equivalence is introduced here. | SDK `duration_ms` becomes both `usage.ms` and `telemetry.durationMs`. | Event `cost_usd`; positive returned cost has sibling `usdSource:'reported'`. | Event snake-case token/cache fields map to returned `split.input/output/cacheRead/cacheCreation`; success omits zero caches, errors may retain them. |
| Compose local Claude SDK | Returned usage/telemetry use the resolved model; routing captures provider model evidence and leaves executed effort unknown. | SDK `duration_ms` is captured directly; returned usage exposes both `duration_ms` and `ms`, with `telemetry.durationMs`. | Routing captures SDK `total_cost_usd` as reported; normalization labels local price as reported. | Returned usage exposes input/output and their aggregate; routing's local capture supplies the input/output split. Local capture does not assert cache detail. |

Sources: `../stratum/ts/src/connectors/codex.ts:250`, `:416`, `:458`, `:578`; `../stratum/ts/src/connectors/claude.ts:131`, `:170`, `:200`; `lib/local-claude-connector.js:237`, `:289`; `lib/result-normalizer.js:289`, `:481`, `:716`; `lib/stratum-mcp-client.js:857`, `:1008`. SDK and exec Codex share the event and result-shaping functions; execution tests in this round use the SDK seam, not a live provider or exec subprocess. Streamed and returned-only real Claude MCP output plus local SDK output are exercised at `test/usage-receipts.test.js:1150`, including refusal of altered duration, provenance, input/output and available cache fields. The existing duration/provenance/split mappings already handle these shapes, so those comparisons were retained unchanged. Absent raw facts remain unknown.

**Negative control:** load the exact pre-round-2 `routing-runtime.js` bytes while keeping the final tests and all other modules unchanged. `--test-name-pattern='unchanged real Codex' test/build-model-route-outcomes.test.js` gives **1 test, 0 pass, `# fail 1`**, exit 1 (`/tmp/r2-A-reverted.log`). Removing the added evidence comparisons instead gives **21 tests, 4 pass, `# fail 17`**, exit 1 (`/tmp/r2-corruption-control.log`), proving that the fix did not trade rejection of unchanged output for acceptance of corrupted output.

### B — partial replacement erased residual ownership: confirmed and fixed

The supplied two-carry-reset reproduction was rerun unchanged against this checkout. `/tmp/r2-local-B-red.log` records **1 test, 0 pass, `# fail 1`**: A0 owns `{a}`, B0 owns `{b,c}`, B1 assumes `{b}`, and a subsequent `{a,c}` repair incorrectly receives `ownershipCheck:'valid'` and sole A0 ancestry. The same reproduction passes unchanged with the fix (**1/1**, `/tmp/r2-local-B-green.log`).

**Retirement boundary:** a completed repair/reimplementation link must still have valid partition/ownership evidence and a token-based acknowledgement. For each such link, only the intersection of the predecessor's ownership and the actual successor's captured, admitted `fullItem.files_owned` is retired. A proposal alone does not retire files. Responsibility follows declared, admitted ownership, not the task name or merely which files happened to receive a diff. Ownership that no successor assumed remains visible. Paths use the same `normalizeOwnedPath` semantics as the ownership check; invalid ownership cannot retire evidence.

`lib/routing-gates.js:134` now projects residual ownership for the observer and drops an item only when all its previously owned files were assumed by acknowledged successors. Immutable snapshots retain the full original task. The existing multiple-owner refusal in `lib/output-gate.js:117` and the round-1 completed-link binding fix are unchanged.

The new public Build tests at `test/build-model-route-outcomes.test.js:362` run two real engine carry resets and real worktree writes. They control planner/reviewer/decision outputs, never ancestry, acknowledgements or ownership dispositions. They establish three boundaries:

- `{c}` still resolves to B0, with repair depth 1.
- `{a,c}` spans A0 and residual B0: ambiguous, no definite repair predecessor.
- `{b,c}` spans B1 and residual B0: ambiguous, no definite repair predecessor.

The existing same-file B0→B1→B2 test at `:334` still requires depth 2 and the original acceptance/repair outcomes. Every retained B0 snapshot is also checked for its unchanged `{b,c}` ownership. Together these and the public Codex test pass **5/5** (`/tmp/r2-build-green.log`). Before production changes, all four new public Build regressions failed (**4 tests, 0 pass, `# fail 4`**, `/tmp/r2-build-red.log`).

**Negative control:** load the exact pre-round-2 `routing-gates.js` bytes with final tests and the A fix retained. `--test-name-pattern='residual B0' test/build-model-route-outcomes.test.js` gives **3 tests, 0 pass, `# fail 3`**, exit 1 (`/tmp/r2-B-reverted.log`). Independently removing only the multiple-owner refusal from `output-gate.js` makes the `{a,c}` test fail (**1 test, 0 pass, `# fail 1`**, `/tmp/r2-multiple-owner-control.log`). This verifies both sides of the boundary rather than making ancestry tests pass by weakening ambiguity checks.

### Round 2 commands and per-file results

Every test process writes directly to its own file and has a disposable state root and empty payment/email keys. No test output was piped to `tail`. Full-file verification uses `/tmp/r2-verify.py` (the prior per-file runner with usage-receipts run separately); it redirects each Node process's stdout/stderr to its named log, records its numeric status in `.log.exit`, and prints each file's TAP totals. The equivalent per-file command is:

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/r2-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  node --test --test-timeout=300000 test/<file>.test.js \
  > /tmp/r2-final/<file>.log 2>&1
route_status=$?
echo "$route_status" > /tmp/r2-final/<file>.log.exit
echo "$route_status"
rg '^# (tests|pass|fail)' /tmp/r2-final/<file>.log
```

`review-fixes-runtime.test.js` additionally uses `--test-skip-pattern='a refused group signal'`, retaining the earlier sandbox exclusion for its prohibited `ps` invocation. Counts cover only the 15 selected tests. The integration log basename replaces `/` with `-`.

For `build-model-route-outcomes.test.js`, the final full-file command uses `--test-timeout=900000` (the repository's normal test budget). The first attempt with 300000ms recorded 28 passed, 1 failed and 1 cancelled before reaching the new final cases (`/tmp/r2-build-full-first.log`). The failure exposed a test-helper extension that indexed past its repair rounds during an existing merge reset. The helper's original default behavior was restored; only explicitly requested partial-ownership scenarios use the new file lists. No assertion was removed or relaxed. The Build file and the GSD outcome file were rerun after this correction.

| File | Node `# tests` | `# pass` | `# fail` | Exit |
|---|---:|---:|---:|---:|
| `test/routing-calls.test.js` | 20 | 20 | 0 | 0 |
| `test/build-model-route-outcomes.test.js` | 34 | 34 | 0 | 0 |
| `test/gsd-model-route-outcomes.test.js` | 8 | 8 | 0 | 0 |
| `test/routing-join.test.js` | 11 | 11 | 0 | 0 |
| `test/routing-outcome.test.js` | 19 | 19 | 0 | 0 |
| `test/routing-ledger-materialize.test.js` | 10 | 10 | 0 | 0 |
| `test/routing-ledger.test.js` | 19 | 19 | 0 | 0 |
| `test/routing-journal.test.js` | 16 | 16 | 0 | 0 |
| `test/routing-evidence-validation.test.js` | 10 | 10 | 0 | 0 |
| `test/usage-receipts.test.js` | 52 | 52 | 0 | 0 |
| `test/model-router.test.js` | 7 | 7 | 0 | 0 |
| `test/pipeline-profiles.test.js` | 40 | 40 | 0 | 0 |
| `test/build-model-route.test.js` | 41 | 41 | 0 | 0 |
| `test/gsd-model-route.test.js` | 20 | 20 | 0 | 0 |
| `test/build-cancel-unit.test.js` | 19 | 19 | 0 | 0 |
| `test/build-emission.test.js` | 16 | 16 | 0 | 0 |
| `test/gsd-dispatch-instrumentation.test.js` | 2 | 2 | 0 | 0 |
| `test/review-fixes-runtime.test.js` | 15 | 15 | 0 | 0 |
| `test/ts-cutover-e3-round3.test.js` | 12 | 12 | 0 | 0 |
| `test/ts-cutover-e3-round4.test.js` | 8 | 8 | 0 | 0 |
| `test/ts-cutover-e3-round5.test.js` | 10 | 10 | 0 | 0 |
| `test/integration/agent-lanes-pipeline.test.js` | 1 | 1 | 0 | 0 |

Final result: **390/390 passed across 22 files**, with zero failed or cancelled tests in those final runs. The pre-existing sandbox exclusion described above remains.

Negative controls use a process-local Node load hook, `/tmp/r2-revert-loader.mjs`, to substitute the specified module's saved bytes at its original URL. All other modules and the final tests remain unchanged; no working-tree mutation or Git operation is used to revert modules. The command template is:

```sh
R2_REVERT_FILE=lib/<module>.js R2_REVERT_SOURCE=/tmp/<saved-source>.js \
  STRATUM_STATE_ROOT=$(mktemp -d /tmp/r2-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  node --import /tmp/r2-revert-loader.mjs --test --test-timeout=300000 \
  --test-name-pattern='<selector>' test/<file>.test.js > /tmp/<control>.log 2>&1
route_status=$?
echo "$route_status"
rg '^# (tests|pass|fail)' /tmp/<control>.log
```

For A, `<saved-source>` is `r2-before/routing-runtime`, selector `unchanged real Codex`, file `build-model-route-outcomes`, log `r2-A-reverted`. For B it is `r2-before/routing-gates`, selector `residual B0`, same test file, log `r2-B-reverted`. The corruption control uses `r2-no-extra-comparisons`, selector `real normalizer forwarding|real Claude .* forwarding`, file `usage-receipts`, log `r2-corruption-control`. The independent multiple-owner control uses `r2-no-multiple-owner`, selector `residual B0 ownership for a.txt`, file `build-model-route-outcomes`, log `r2-multiple-owner-control`.

**Ten-file baseline preserved.** `/tmp/r2-host-controls.py` runs the same command per row below, loading `git show HEAD:lib/<module>.js` bytes from `/tmp/r2-host-controls/<module>.js`. Every row has exit 1 and a nonzero Node `# fail` tally; no exit-code-only claim is used. Final positive runs cover each named test file.

| Reverted production file | Test file | Selector | Tests / pass / fail |
|---|---|---|---:|
| `lib/bug-escalation.js` | `test/routing-calls.test.js` | `real escalation-` | 2 / 0 / 2 |
| `lib/build-cancel.js` | `test/build-cancel-unit.test.js` | `teardown finalizes routing evidence` | 1 / 0 / 1 |
| `lib/build.js` | `test/build-model-route-outcomes.test.js` | `policy revision transport disconnect` | 1 / 0 / 1 |
| `lib/codex-preflight.js` | `test/routing-calls.test.js` | `real codex-preflight producer` | 1 / 0 / 1 |
| `lib/gsd.js` | `test/gsd-model-route-outcomes.test.js` | `ordinary-only no-ceiling GSD` | 1 / 0 / 1 |
| `lib/local-claude-connector.js` | `test/routing-calls.test.js` | `local SDK raw presence` | 2 / 0 / 2 |
| `lib/output-gate.js` | `test/build-model-route-outcomes.test.js` | `two real carry repairs retain A` | 1 / 0 / 1 |
| `lib/result-normalizer.js` | `test/routing-calls.test.js` | `full normalizer repair` | 2 / 0 / 2 |
| `lib/review-normalize.js` | `test/routing-calls.test.js` | `full normalizer repair` | 2 / 0 / 2 |
| `lib/stratum-mcp-client.js` | `test/routing-calls.test.js` | `real MCP boundary owns` | 1 / 0 / 1 |

The whole-file `output-gate.js` reversion removes the required `observeRoutingDecision` export, so its tally is a test-file import failure. The additional executable multiple-owner mutation described above verifies the relevant behavioral assertion separately, also with `# fail 1`.

Syntax checks and `git diff --check` passed. All three `test/fixtures/model-route-off-*.json` files remain byte-identical to HEAD with the hashes already recorded above; none was edited or regenerated. No staging, repository commit, sibling edit, GUI launch or live provider call was performed. The excluded COMP-ROADMAP files and `COMP-GUARD-CLAIM-1/audit.json` were not edited. These are per-file regression results, not a full `npm test` or live-provider qualification.

## Full-suite regression

The first child in `test/integration/gsd-route-continuation-golden.test.js` reproduced the reported failure: **10 tests, 9 pass, 1 fail, 0 cancelled** (`/tmp/gsd-stuck-before.log`). The real detector's repeated `Edit` events produced `AgentAbortedError` with `reason.stuck:true`; the new `routingCalls && !routingCalls.terminated()` guard in `runConsumerIssuance` threw it before the existing `ConsumerStuckError` conversion. GSD catches the latter to write `.compose/gsd/<feature>/stuck.json` and return `status:'stuck'`. This was the unconfirmed-termination escape added with dispatch 2, not the routing-integrity predicate misclassifying the abort. The supplied round-2 bisect was not repeated.

The fix in `lib/build.js` exempts only `error instanceof AgentAbortedError && error.reason?.stuck === true` from that termination guard. It retains the earlier uncertainty event, cancellation precedence, usage accounting and existing stuck handler; it does not settle, synthesize a failure envelope or retry the issuance. The routing-integrity check executes **before** this exception. `routingIntegrityError` recognizes `ROUTING_*` and `CONSUMER_EVIDENCE_MISMATCH`; persistence failures are branded `ROUTING_PERSISTENCE_FAILED` by the existing write boundary. Even an integrity error that also has the `AgentAbortedError` prototype and `reason.stuck:true` is rethrown first. Neither an error name/message nor a stuck-shaped reason can override that code check. All primary, repair, tolerant-review, usage, retry, probe and terminal integrity escapes remain unchanged.

The existing golden test is the regression test; no test or frozen fixture was changed. It drives `runGsd`, the real engine and stuck detector with controlled inference events, then checks exit 0, B's stuck diagnostic, B's unsettled issuance and resume refusal before any additional plan/model call. Its focused fixed run reports **1 test, 1 pass, 0 fail, 0 cancelled** (`/tmp/gsd-stuck-fixed-focused.log`).

Commands (all test output is redirected directly to files; Node TAP tallies, not exit status alone, determine the result):

```sh
RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 \
  test/integration/gsd-route-continuation-golden.test.js > /tmp/gsd-stuck-before.log 2>&1
echo $?

STRATUM_STATE_ROOT=$(mktemp -d /tmp/gsd-stuck-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  node --test --test-timeout=900000 test/<file>.test.js \
  > /tmp/gsd-stuck-verification/<file>.log 2>&1
route_status=$?
echo "$route_status"
rg '^# (tests|pass|fail|cancelled)' /tmp/gsd-stuck-verification/<file>.log
```

`/tmp/gsd-stuck-verification/run.py` instantiates the second command separately for every file below, with two independent processes at most. Integration log names replace `/` with `-`.

| File | `# tests` | `# pass` | `# fail` | `# cancelled` | Exit |
|---|---:|---:|---:|---:|---:|
| `test/routing-calls.test.js` | 20 | 20 | 0 | 0 | 0 |
| `test/build-model-route-outcomes.test.js` | 34 | 34 | 0 | 0 | 0 |
| `test/gsd-model-route-outcomes.test.js` | 8 | 8 | 0 | 0 | 0 |
| `test/usage-receipts.test.js` | 52 | 52 | 0 | 0 | 0 |
| `test/routing-join.test.js` | 11 | 11 | 0 | 0 | 0 |
| `test/routing-outcome.test.js` | 19 | 19 | 0 | 0 | 0 |
| `test/routing-ledger.test.js` | 19 | 19 | 0 | 0 | 0 |
| `test/routing-journal.test.js` | 16 | 16 | 0 | 0 | 0 |
| `test/build-model-route.test.js` | 41 | 41 | 0 | 0 | 0 |
| `test/gsd-model-route.test.js` | 20 | 20 | 0 | 0 | 0 |
| `test/build-cancel-unit.test.js` | 19 | 19 | 0 | 0 | 0 |
| `test/integration/gsd-route-continuation-golden.test.js` | 10 | 10 | 0 | 0 | 0 |

The specified eleven files total **259/259 passed**; including the full continuation golden file gives **269/269 passed**, with zero failures or cancellations.

Negative controls use `scripts/negative-control.sh`. The script now reads historical bytes with `git show` instead of `git checkout`, avoiding index writes; it also accepts a test-name selector and prints each Node exit status plus tests/pass/fail/cancelled tallies. Every selected baseline was GREEN before its reversion, and `/tmp/gsd-stuck-verification/controls.py` verified byte-for-byte restoration after every invocation. These mutations ran sequentially after the positive test processes finished.

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/gsd-control-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  bash scripts/negative-control.sh --ref ecea9db --timeout 900000 \
  --test-name-pattern='<selector>' --prod lib/<module>.js -- \
  --test test/<file>.test.js > /tmp/gsd-stuck-verification/control-<module>.log 2>&1
echo $?
```

Each row below uses that command with the listed module, test and selector. All ten verdicts are **RED**, with Node exit 1 and zero cancelled tests; the script itself exits 0 because the negative control succeeded.

| Reverted production file | Test file | Selector | Reverted tests / pass / fail / cancelled |
|---|---|---|---:|
| `lib/bug-escalation.js` | `test/routing-calls.test.js` | `real escalation-` | 2 / 0 / 2 / 0 |
| `lib/build-cancel.js` | `test/build-cancel-unit.test.js` | `teardown finalizes routing evidence` | 1 / 0 / 1 / 0 |
| `lib/build.js` | `test/build-model-route-outcomes.test.js` | `policy revision transport disconnect` | 1 / 0 / 1 / 0 |
| `lib/codex-preflight.js` | `test/routing-calls.test.js` | `real codex-preflight producer` | 1 / 0 / 1 / 0 |
| `lib/gsd.js` | `test/gsd-model-route-outcomes.test.js` | `ordinary-only no-ceiling GSD` | 1 / 0 / 1 / 0 |
| `lib/local-claude-connector.js` | `test/routing-calls.test.js` | `local SDK raw presence` | 2 / 0 / 2 / 0 |
| `lib/output-gate.js` | `test/build-model-route-outcomes.test.js` | `two real carry repairs retain A` | 1 / 0 / 1 / 0 |
| `lib/result-normalizer.js` | `test/routing-calls.test.js` | `full normalizer repair` | 2 / 0 / 2 / 0 |
| `lib/review-normalize.js` | `test/routing-calls.test.js` | `full normalizer repair` | 2 / 0 / 2 / 0 |
| `lib/stratum-mcp-client.js` | `test/routing-calls.test.js` | `real MCP boundary owns` | 1 / 0 / 1 / 0 |

The `output-gate.js` whole-file revert removes the imported `observeRoutingDecision` export, so its RED tally is an import failure, not independent behavioral proof of ownership rejection. The executable multiple-owner mutation below supplies that separate proof.

**Negative control for this fix:** the same script, with `--ref 975ff50 --prod lib/build.js --test-name-pattern='GSD real stuck detector leaves uncertain B' --test test/integration/gsd-route-continuation-golden.test.js`, records baseline **1 test / 1 pass / 0 fail / 0 cancelled**, then reverted **1 test / 0 pass / `# fail 1` / 0 cancelled** (`/tmp/gsd-stuck-verification/control-stuck-fix.log`). The historical Build file differs from the fixed file only by this fix. No test supplies an abort, stuck artifact or expected routing state; the existing event-driven producer creates them.

The two required check-removal controls were also rerun. The saved mutation sources were compared with current production: the first removes only the added evidence comparisons, the second only the multiple-owner refusal. The existing process-local load hook substitutes those bytes at the original module URL without changing working-tree files:

```sh
R2_REVERT_FILE=lib/routing-runtime.js R2_REVERT_SOURCE=/tmp/r2-no-extra-comparisons.js \
  STRATUM_STATE_ROOT=$(mktemp -d /tmp/stuck-evidence-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  node --import /tmp/r2-revert-loader.mjs --test --test-timeout=900000 \
  --test-name-pattern='real normalizer forwarding|real Claude .* forwarding' \
  test/usage-receipts.test.js > /tmp/gsd-stuck-verification/no-evidence-comparisons.log 2>&1
echo $?
rg '^# (tests|pass|fail|cancelled)' /tmp/gsd-stuck-verification/no-evidence-comparisons.log

R2_REVERT_FILE=lib/output-gate.js R2_REVERT_SOURCE=/tmp/r2-no-multiple-owner.js \
  STRATUM_STATE_ROOT=$(mktemp -d /tmp/stuck-owner-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= \
  node --import /tmp/r2-revert-loader.mjs --test --test-timeout=900000 \
  --test-name-pattern='residual B0 ownership for a.txt' \
  test/build-model-route-outcomes.test.js > /tmp/gsd-stuck-verification/no-multiple-owner.log 2>&1
echo $?
rg '^# (tests|pass|fail|cancelled)' /tmp/gsd-stuck-verification/no-multiple-owner.log
```

| Mutation | Test file | Tests | Pass | Fail | Cancelled | Exit |
|---|---|---:|---:|---:|---:|---:|
| Remove added evidence comparisons | `test/usage-receipts.test.js` | 21 | 4 | **17** | 0 | 1 |
| Remove multiple-owner refusal | `test/build-model-route-outcomes.test.js` | 1 | 0 | **1** | 0 | 1 |

Final checks: `git diff --check`, `node --check lib/build.js`, and `bash -n scripts/negative-control.sh` passed. All three frozen `test/fixtures/model-route-off-*.json` files remain byte-identical to HEAD. No tests were edited. Nothing was staged, committed or pushed. The separately owned branch-lineage failure was neither run nor modified; COMP-ROADMAP files and the existing untracked audit file were left alone. No port binding, process inspection, GUI launch or dependency installation was performed. This verifies the requested regression scope; it does not claim a new full-suite run.
