# Grounding report — G2 (failed-phase resume) + G3 (review prompt budget / provider retry)

> Read-only source reconnaissance for the COMP-HOST-PORTABILITY-1 remediation.
> Produced 2026-09-17 by Codex `gpt-5.6-sol` (effort high), Stratum run `a60bc4712aa1`.
> No files were changed and no commands were run: every claim below is from reading source.
> Claims marked UNCONFIRMED / NOT FOUND were not verifiable by reading and are not evidence.

---

## G2 seams

1. **Persisted cursor and phase history**

   Compose has two distinct state planes:

   - The executable cursor is the Stratum `PersistedRun`: run status, per-step status, attempts, outputs, fanout-item state, and events. It is saved as `<runId>.json` under the Stratum state root and loaded by run ID ([state.ts:306-342](/Users/ruze/reg/my/forge/stratum/ts/src/engine/state.ts:306), [engine.ts:410-414](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:410), [engine.ts:3537-3557](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:3537)).
   - Compose keeps a discovery/UI mirror in `.compose/data/active-build.json`. Its read and atomic write are at [lib/build.js:2537-2548](/Users/ruze/reg/my/forge/compose/lib/build.js:2537) and [lib/build.js:2577-2585](/Users/ruze/reg/my/forge/compose/lib/build.js:2577). A fresh run records `flowId`, `currentStepId`, and `status`; subsequent updates record the current step and summarized step history ([lib/build.js:7417-7435](/Users/ruze/reg/my/forge/compose/lib/build.js:7417), [lib/build.js:7440-7451](/Users/ruze/reg/my/forge/compose/lib/build.js:7440), [lib/build.js:7454-7495](/Users/ruze/reg/my/forge/compose/lib/build.js:7454)).
   - The MCP checkpoint layer’s `phaseHistory` is advisory lifecycle history, not the executable cursor. Reconciliation reads active-build state but only applies lifecycle-history mutations ([lib/checkpoint/reconciler.js:59-68](/Users/ruze/reg/my/forge/compose/lib/checkpoint/reconciler.js:59), [server/session-routes.js:121-174](/Users/ruze/reg/my/forge/compose/server/session-routes.js:121)).

2. **Effect of review failure**

   The state is not cleared. A failed consumer attempt is appended to the item’s attempts; after the default two attempts, the item becomes `failed` and is persisted ([engine.ts:2047-2083](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2047)). Once all items are terminal, `require: all` computes insufficient successes and forces the step’s failure path ([engine.ts:2133-2142](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2133)).

   The step becomes `failed`; with no `on_fail` route, `terminalFailure` sets `run.status = "failed"`, retains the failure, appends a failed event, and persists the entire run ([engine.ts:2487-2512](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2487), [engine.ts:3431-3437](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:3431)).

   Compose likewise preserves the existing active record—including its `flowId`—while changing its status to `failed` ([lib/build.js:3260-3281](/Users/ruze/reg/my/forge/compose/lib/build.js:3260), [lib/build.js:6370-6388](/Users/ruze/reg/my/forge/compose/lib/build.js:6370)). Therefore the cursor is intact but terminal.

3. **Why `--resume` says “Nothing to resume”**

   The CLI initially accepts an active record unless its local status is `complete`, `aborted`, or `killed`; local `failed` is not excluded there ([bin/compose.js:2892-2908](/Users/ruze/reg/my/forge/compose/bin/compose.js:2892)).

   `runBuild`, however, audits the stored Stratum flow. `isTerminalFlow()` explicitly includes `failed`, and that audit result sets `flowTerminal` ([lib/build.js:3194-3201](/Users/ruze/reg/my/forge/compose/lib/build.js:3194), [lib/build.js:4128-4177](/Users/ruze/reg/my/forge/compose/lib/build.js:4128)). The decisive predicate is:

   `if (!active || !flowId || flowTerminal) ... "Nothing to resume"` ([lib/build.js:2986-3013](/Users/ruze/reg/my/forge/compose/lib/build.js:2986)).

   Thus the state still exists; it is rejected because the authoritative Stratum run is terminally `failed`.

4. **Three resume entry points**

   - **Compose MCP resume:** dispatches to the session bind/reconcile endpoint ([server/compose-mcp.js:188-189](/Users/ruze/reg/my/forge/compose/server/compose-mcp.js:188), [server/compose-mcp-tools.js:458-485](/Users/ruze/reg/my/forge/compose/server/compose-mcp-tools.js:458)). That route reconciles environment/checkpoint state and updates `phaseHistory`; it does not invoke `runBuild` or `stratum.resume` ([server/session-routes.js:121-174](/Users/ruze/reg/my/forge/compose/server/session-routes.js:121)).
   - **CLI `--resume`:** discovers `flowId` through `active-build.json`, then asks `runBuild` to resume it ([bin/compose.js:2892-2924](/Users/ruze/reg/my/forge/compose/bin/compose.js:2892)). `runBuild` rejects it during the terminal-flow audit described above.
   - **Stratum-layer resume:** `stratum_resume` maps directly to `engine.resume()` ([server.ts:272-277](/Users/ruze/reg/my/forge/stratum/ts/src/mcp/server.ts:272)). It loads the run, emits/persists `resumed`, but if `run.status !== "running"` it simply returns the existing response without reopening any failed step ([engine.ts:1013-1055](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:1013)). This explains why the measured call completed without repairing recovery.
   - When Compose reaches a valid resume verdict, it calls `stratum.resume`; its ordinary `--resume` path again rejects a terminal response ([lib/build.js:4217-4259](/Users/ruze/reg/my/forge/compose/lib/build.js:4217)).

   Compose owns the `active-build.json` discovery pointer and summary. Stratum owns the executable cursor. The checkpoint/MCP resume surface owns neither.

5. **State required to preserve completed implementation**

   The completed implementation is already present in the merged workspace according to the audit ([host-b-lifecycle.md:143-147](/Users/ruze/reg/my/forge/compose/docs/features/COMP-HOST-PORTABILITY-1/audit/host-b-lifecycle.md:143)). The missing capability is reachability, not basic persistence.

   Recovery would need to:

   - Preserve the same Stratum `runId`, succeeded implementation-step outputs, events, and review-attempt history.
   - Transition the failed run back to `running`.
   - Reset only the exhausted review step/items to a resumable `pending`/`ready` issuance with fresh dispatch tokens.
   - Allow Compose to treat that explicitly reopened failed flow as resumable and retain the existing `active-build.flowId`.

   There is also an in-memory context gap: every `runBuild` invocation resets `stepHistory = []`, even though summarized steps remain in `active-build.json` ([lib/build.js:4469-4471](/Users/ruze/reg/my/forge/compose/lib/build.js:4469), [lib/build.js:7454-7495](/Users/ruze/reg/my/forge/compose/lib/build.js:7454)). Any resume design depending on prior Compose summaries must rehydrate them or rely solely on persisted Stratum outputs and the workspace.

6. **Resume-test conclusion**

   Resume is tested for non-terminal runs, clean interruptions, waiting gates, and checkpoint/environment reconciliation. No located test resumes a terminal `failed` Stratum run. The decision-helper test named “failed” explicitly supplies `flowTerminal: false`, so it does not cover G2 ([build-decide-start.test.js:26-31](/Users/ruze/reg/my/forge/compose/test/build-decide-start.test.js:26)).

## G2 adjudication check

The code and feature scopes support the prior adjudication: **G2 is not a regression of the behavior those completed features promised.**

`COMP-BUILD-RESUME` defines resumable as an active record whose “Stratum flow is non-terminal” ([design.md:42-44](/Users/ruze/reg/my/forge/compose/docs/features/COMP-BUILD-RESUME/design.md:42)). Its matrix explicitly maps a terminal flow plus `--resume` to an error ([design.md:48-53](/Users/ruze/reg/my/forge/compose/docs/features/COMP-BUILD-RESUME/design.md:48)), and its server-side edge case says a terminal flow errors rather than silently starting fresh ([design.md:108-113](/Users/ruze/reg/my/forge/compose/docs/features/COMP-BUILD-RESUME/design.md:108)).

The wording “failed/crashed builds leave clean, uniformly resumable state” at [design.md:30-35](/Users/ruze/reg/my/forge/compose/docs/features/COMP-BUILD-RESUME/design.md:30) is potentially misleading in isolation. Read with the explicit definition, it covers a locally failed Compose record whose Stratum flow remains non-terminal—not reopening a terminally failed Stratum execution.

`COMP-RESUME` scopes itself to “crash mid-step, killed/closed session, machine reboot, MCP server restart” and explicitly leaves Stratum-level behavior outside its v1 scope ([design.md:20-38](/Users/ruze/reg/my/forge/compose/docs/features/COMP-RESUME/design.md:20)). The audit’s successful post-gate CLI resume further demonstrates that ordinary non-terminal resume worked before the terminal review failure ([host-b-lifecycle.md:122-128](/Users/ruze/reg/my/forge/compose/docs/features/COMP-HOST-PORTABILITY-1/audit/host-b-lifecycle.md:122)).

## G3 seams

1. **Review-lens prompt assembly and growth**

   The build pipeline fans out over the entire triage task object. `${item}` is embedded in each lens instruction; the fanout uses concurrency 4 and `require: all` ([build.stratum.yaml:259-293](/Users/ruze/reg/my/forge/compose/pipelines/build.stratum.yaml:259)). Stratum resolves the item and JSON-serializes non-string interpolation values ([engine.ts:2884-2918](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2884), [engine.ts:2970-2990](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2970), [engine.ts:3666-3669](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:3666)).

   Compose then:

   - Builds the generic step prompt from the rendered intent, previous failure, inputs, contract fields, postconditions, project context, prior-step summaries, and changed-file names ([step-prompt.js:67-165](/Users/ruze/reg/my/forge/compose/lib/step-prompt.js:67)).
   - Concatenates every Markdown file under `docs/context/` without truncation ([step-prompt.js:17-48](/Users/ruze/reg/my/forge/compose/lib/step-prompt.js:17), [step-prompt.js:120-125](/Users/ruze/reg/my/forge/compose/lib/step-prompt.js:120)).
   - Prepends the review scaffold with lens focus, exclusions, confidence gate, severity/output instructions, and optional lens certification template ([lib/build.js:1700-1740](/Users/ruze/reg/my/forge/compose/lib/build.js:1700), [review-prompt.js:88-162](/Users/ruze/reg/my/forge/compose/lib/review-prompt.js:88), [cert-inject.js:24-37](/Users/ruze/reg/my/forge/compose/lib/cert-inject.js:24)).
   - Appends the output schema before dispatch ([inject-schema.js:11-20](/Users/ruze/reg/my/forge/compose/lib/inject-schema.js:11)).

   On the measured default build path, Compose does **not** inject changed source-file contents, a whole diff, or accumulated prior-lens output. It supplies changed-file names and prior-step summaries. Lens outputs are accumulated only later by `review_merge` ([build.stratum.yaml:303-309](/Users/ruze/reg/my/forge/compose/pipelines/build.stratum.yaml:303)). Full `docs/context/*.md` content and the full serialized triage item are direct unbounded growth sources.

2. **Size budget**

   No prompt-size budget, context cap, or truncation is applied anywhere in the traced review path. The completed `actualPrompt` is passed directly to the local Claude connector ([result-normalizer.js:595-622](/Users/ruze/reg/my/forge/compose/lib/result-normalizer.js:595)). The ambient-context loader and scaffold/schema concatenation likewise have no length checks.

3. **`require: all` propagation**

   `review_lenses` declares `require: all` at [build.stratum.yaml:278-293](/Users/ruze/reg/my/forge/compose/pipelines/build.stratum.yaml:278). Stratum counts succeeded items and requires that count to equal the fanout length; otherwise it forces the step’s failure path without redispatching the batch ([engine.ts:2133-2142](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2133)).

   Therefore one lens that remains failed after its per-item attempts is sufficient to fail the whole review phase.

4. **Provider-error retry behavior**

   The local connector maps every non-success provider result to a generic `Error`; its only special classification recognizes `blocked` or budget-exhausted results—not prompt-too-long or rate-limit responses ([local-claude-connector.js:46-53](/Users/ruze/reg/my/forge/compose/lib/local-claude-connector.js:46), [local-claude-connector.js:241-276](/Users/ruze/reg/my/forge/compose/lib/local-claude-connector.js:241)). The normalizer wraps the message in a generic `AgentError` ([result-normalizer.js:639-670](/Users/ruze/reg/my/forge/compose/lib/result-normalizer.js:639)), and the consumer adapter sends the same failure class to Stratum ([lib/build.js:1903-1919](/Users/ruze/reg/my/forge/compose/lib/build.js:1903)).

   Stratum retries solely by attempt count—default two attempts—and immediately prepares another issuance; there is no application-level backoff on this path ([engine.ts:2047-2083](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2047)). The retry keeps the same underlying prompt and adds a “Previous Attempt Failed” section ([step-prompt.js:87-100](/Users/ruze/reg/my/forge/compose/lib/step-prompt.js:87)).

   Consequently:

   - Prompt-too-long is retried with essentially the same, slightly larger prompt.
   - Rate limiting gets the same immediate retry policy, with no wait/backoff.
   - The code does not distinguish deterministic 400-style prompt rejection from transient 429-style throttling.

5. **Retry resumability**

   Attempts and item failures are persisted; exhaustion does not discard the run ([engine.ts:2047-2079](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2047)). But `require: all` turns the exhausted item into a terminal failed run, and `resumeLocked` refuses to reopen any run whose status is not `running` ([engine.ts:3431-3437](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:3431), [engine.ts:1026-1054](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:1026)). The retry state is durable but unreachable through current resume semantics.

6. **Cost and usage accounting**

   Failed provider responses retain reported tokens and `total_cost_usd` on the thrown error ([local-claude-connector.js:241-275](/Users/ruze/reg/my/forge/compose/lib/local-claude-connector.js:241)). The consumer failure path forwards that usage both to Stratum’s attempt envelope and Compose’s cumulative usage callback ([lib/build.js:1923-1964](/Users/ruze/reg/my/forge/compose/lib/build.js:1923)).

   Dispatch events are appended to `.compose/data/dispatch-ledger.jsonl` ([dispatch-ledger.js:14-24](/Users/ruze/reg/my/forge/compose/lib/dispatch-ledger.js:14), [dispatch-ledger.js:282-290](/Users/ruze/reg/my/forge/compose/lib/dispatch-ledger.js:282)); terminal build history records the build cost snapshot ([lib/build.js:6622-6641](/Users/ruze/reg/my/forge/compose/lib/build.js:6622)). The audit recorded 208,080 tokens and `$14.04413865`, so the amount was observable during the measured run ([host-b-lifecycle.md:126-128](/Users/ruze/reg/my/forge/compose/docs/features/COMP-HOST-PORTABILITY-1/audit/host-b-lifecycle.md:126)).

   The existing failure-usage callback/attempt-settlement seam is the natural place for both a pre-retry budget decision and cumulative ceiling enforcement.

7. **Tests**

   See the consolidated table below. No located test supplies a real provider prompt-limit response or rate-limit response.

## How G2 and G3 compound

The shared state is the Stratum persisted run referenced by `active-build.json.flowId`.

A provider rejection becomes a consumer failure envelope; attempt exhaustion marks a lens item failed; `require: all` marks the review step and run failed ([engine.ts:2047-2083](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2047), [engine.ts:2133-2142](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:2133), [engine.ts:3431-3437](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:3431)). Compose preserves that run ID while terminalizing its local mirror ([lib/build.js:3260-3281](/Users/ruze/reg/my/forge/compose/lib/build.js:3260)).

The next `--resume` audits the same persisted run, sees terminal `failed`, and rejects it before a reopening transition can occur ([lib/build.js:4128-4177](/Users/ruze/reg/my/forge/compose/lib/build.js:4128), [lib/build.js:3008-3012](/Users/ruze/reg/my/forge/compose/lib/build.js:3008)). G3 therefore creates durable retry evidence, but G2 makes that evidence operationally unreachable and forces a fresh lifecycle.

## Test coverage

| Test file | Test name | What it pins | Provider mocked? y/n |
|---|---|---|---|
| [test/build-decide-start.test.js:65-82](/Users/ruze/reg/my/forge/compose/test/build-decide-start.test.js:65) | `decideBuildStart: failed same mode with non-terminal flow + resume` | Local failed record resumes only when Stratum is explicitly non-terminal; not G2 | n |
| [test/ts-cutover-build-resume-golden.test.js:73-175](/Users/ruze/reg/my/forge/compose/test/ts-cutover-build-resume-golden.test.js:73) | `an interrupted build resumes the same run and completes its ready step` | Same-run resume after interruption; audit remains `running`/`ready` | y |
| [test/ts-cutover-review-gate-golden.test.js:276-321](/Users/ruze/reg/my/forge/compose/test/ts-cutover-review-gate-golden.test.js:276) | `a build interrupted at the waiting review_gate resumes and APPROVES...` | Waiting-gate resume, not terminal failed review | y |
| [test/integration/checkpoint-resume.integration.test.js:76-115](/Users/ruze/reg/my/forge/compose/test/integration/checkpoint-resume.integration.test.js:76) | `golden: write anchors across phases → narrative checkpoint → stop → reconcile resumes at nextStep` | Advisory environment/checkpoint reconciliation | n |
| [p4.test.ts:350-385](/Users/ruze/reg/my/forge/stratum/ts/tests/engine/p4.test.ts:350) | `resumes a persisted mid-fanout run without re-dispatching terminal items` | Mid-flight fanout crash recovery while run remains resumable | y |
| [test/ts-cutover-e3-round4.test.js:124-152](/Users/ruze/reg/my/forge/compose/test/ts-cutover-e3-round4.test.js:124) | `a review item prompt carries the scaffold...` | Review scaffold, gate, lens focus; no size-budget assertion | y |
| [p4.test.ts:733-742](/Users/ruze/reg/my/forge/stratum/ts/tests/engine/p4.test.ts:733) | `fails the step when require all is not met...` | One failed item propagates through `require: all` | y |
| [p4.test.ts:857-879](/Users/ruze/reg/my/forge/stratum/ts/tests/engine/p4.test.ts:857) | `retries contract and ensure failures item-locally...` | Attempt-count retry mechanics; bypasses provider errors | n |
| [test/ts-cutover-e3-round3.test.js:152-168](/Users/ruze/reg/my/forge/compose/test/ts-cutover-e3-round3.test.js:152) | `a failed local run reports usage...` | Mocked failed-provider usage reaches the failure envelope | y |
| [test/ts-cutover-e3-round3.test.js:251-272](/Users/ruze/reg/my/forge/compose/test/ts-cutover-e3-round3.test.js:251) | `attaches usage + costUsd...` | Mocked SDK error preserves billable usage | y |

Here, `n` means the test does not invoke a provider; it does not mean a real provider was exercised. Every provider-touching test above uses an injected connector, SDK query stub, or agent harness.

## Unconfirmed

- **UNCONFIRMED:** which specific assembled prompt section caused the provider limit. No final prompt-size measurement or per-section token accounting is present on this path.
- **UNCONFIRMED:** the provider’s exact HTTP status/code for the audit’s “Prompt is too long” and rate-limit messages. The retained audit records the messages, not the raw provider responses.
- **NOT FOUND:** any test that reopens and resumes a terminal `failed` Stratum run.
- **NOT FOUND:** any test using a real provider response for prompt-too-long, HTTP 429, error classification, or retry backoff.
- **NOT RUN:** no tests or lifecycle commands were executed; this was a read-only source/test inspection.

