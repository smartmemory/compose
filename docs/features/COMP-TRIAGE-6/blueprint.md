# COMP-TRIAGE-6 Implementation Blueprint

Status: implementation-ready  
Binding source: `docs/features/COMP-TRIAGE-6/design.md`  
Scope: gate-closed design only; no redesign

## 1. Fixed implementation contracts

### 1.1 Ledger

- Store one append-only JSON object per line at `.compose/data/dispatch-ledger.jsonl`.
- Every row has `v: 1`, `kind`, `ts`, and monotonic process-local `_seq`.
- The writer rejects unknown kinds, missing required fields, unknown top-level fields, invalid enums, and wrong primitive types. Connector-owned capture catches writer failures so telemetry can never change dispatch behavior.
- The reader skips malformed JSON, invalid known rows, and unknown future kinds. It accepts extra fields on otherwise valid rows for forward-compatible reads.
- The four closed event shapes are:

| Kind | Required payload fields | Optional payload fields |
|---|---|---|
| `dispatch` | `dispatch_id`, `site`, `agent`, `outcome` | `build_id`, `feature_code`, `step_id`, `attempt`, `model`, `effort_intended`, `effort_executed`, `tokens_in`, `tokens_out`, `tokens_total`, `usd`, `duration_ms`, `note` |
| `settlement` | `dispatch_id`, `accepted` | `build_id`, `step_id`, `failure_class` |
| `triage-estimate` | `build_id`, `feature_code`, `tier`, `lane`, `profile`, `estimate_source` | `confidence` |
| `build-actuals` | `build_id`, `feature_code`, `terminal_status`, `files_changed_count`, `files_source`, `review_iterations`, `escalations`, `tokens_total`, `usd` | `test_count`, `pass_rate` |

- Closed enums are:
  - `site`: `build-step | consumer | review | review-repair | gsd | gate-qa | escalation | preflight | judge | design-chat | import | validation | new-project | unattributed`;
  - `outcome`: `ok | error | blocked`;
  - `failure_class`: `ownership | vocabulary | normalization | agent | ensure-retry`;
  - estimate `lane`: `trivial | standard | complex`;
  - `estimate_source`: `fresh | cached | escalated`;
  - `terminal_status`: `complete | failed | aborted`;
  - `files_source`: `ship | accumulated`.
- `profile` is a non-array object; `confidence` is `high | medium | low | null`; `accepted` is boolean. `note`, when supplied, is a caller-controlled short diagnostic string and must not contain prompt/response/tool/file/environment payloads.
- Absent numeric telemetry and unresolved model/effort values are explicit `null`, not zero or guessed strings.
- `_seq` is allocated by a per-ledger-path in-process counter. On first append for a path, seed it from the greatest valid `_seq` already present; increment before the synchronous append. Do not rotate or rewrite the JSONL file.

### 1.2 Dispatch ownership and carrier

- The connector that executes the model call owns the one-and-only `dispatch` row.
- `StratumMcpClient.agentRun()` and `runLocalClaudeAgent()` attach `dispatchId` as a non-enumerable property to successful object results and thrown error objects.
- `StratumMcpClient.runAgentText()` keeps its current primitive-string API. Its shared internal dispatch helper records the event, but the wrapper unwraps to text and exposes no carrier.
- `result-normalizer` returns `dispatchIds: { primary, repair }`; each value is a UUID string or `null`.
- No prompt text, response text, tool input, file contents, or environment values enter ledger rows.

### 1.3 Build identity and actuals

- Persist one accumulator per feature at `.compose/data/build-accumulator/<feature-code>.json`.
- The accumulator schema is:

```json
{
  "v": 1,
  "build_id": "uuid",
  "feature_code": "COMP-X",
  "last_terminal": null,
  "review_iterations": 0,
  "escalations": 0,
  "files_changed": [],
  "ship_files_changed": null,
  "test_count": null,
  "pass_rate": null,
  "tokens_total": 0,
  "usd": 0
}
```

- Create a new accumulator when none exists, `--fresh` is used, or the prior terminal state was `complete`/`aborted`. Reuse a failed accumulator on ordinary resume. Reject a corrupt or identity-mismatched accumulator rather than silently splitting build identity.
- Emit `triage-estimate` once, immediately after a new accumulator is created and triage is available. Bug/plan/skip-triage flows may have actuals without an estimate.
- Emit exactly one `build-actuals` row for every terminal attempt. `complete` and `aborted` clear the sidecar after a successful append; `failed` keeps it and marks `last_terminal: "failed"` for resume.
- `files_changed_count` uses authoritative ship output when present; otherwise use the deduplicated context union. Record the choice as `files_source: "ship"` or `"accumulated"`.

## 2. Per-file work plan

### `lib/dispatch-ledger.js` (new)

Create the single ledger boundary.

1. Export constants for the ledger relative path and all closed enums.
2. Export `appendEvent(projectCwd, event)`:
   - resolve `<projectCwd>/.compose/data/dispatch-ledger.jsonl`;
   - validate only the caller-supplied `kind` and payload;
   - stamp `v`, ISO `ts`, and `_seq`;
   - `mkdirSync(..., { recursive: true })` and `appendFileSync(..., JSON.stringify(row) + "\n")`.
3. Export `readEvents(projectCwd, { kind, since, feature } = {})`:
   - return `[]` for a missing file;
   - parse line by line;
   - skip malformed, unknown-kind, or invalid rows;
   - accept additional fields on read;
   - apply `kind`, normalized `since`, and direct `feature_code` filters;
   - apply the same `since` normalization pattern used by `normalizeSince()` in `lib/feature-events.js:111-127`.
4. Export small pure validators only as needed by tests. Do not expose a general arbitrary-event append API.

Implementation precedent: synchronous directory creation/append and tolerant line reading in `lib/feature-events.js:29-31`, `lib/feature-events.js:45-71`, and `lib/feature-events.js:85-105`.

### `lib/dispatch-metrics.js` (new)

Create a pure reader/aggregator; it must never mutate the ledger.

1. Export `collectDispatchMetrics(projectCwd, { since, feature } = {})`.
2. Read the `since`-filtered full ledger before applying `feature`; settlement rows have no `feature_code` and must be joined to dispatch rows by `dispatch_id`.
3. Select the highest-`_seq` settlement for each dispatch. Keep completion (`outcome === "ok"`) separate from acceptance (`settlement.accepted === true`).
4. Bucket model/effort as:
   - known executed effort: `(model, effort_executed)`;
   - unknown executed effort: `(model, null, effort_intended)`, so intended-low and intended-high are not merged;
   - unknown model remains `null`; do not invent `"unknown"` in JSON.
5. Compute medians from non-null samples only, using the repository's upper-middle convention at `bin/compose.js:3848-3855`.
6. Compute retry rate as count of dispatches with numeric `attempt > 1` divided by dispatches with numeric attempts. Label it exactly `known undercount: child flows`.
7. Build ACRR by pairing each estimate with the highest-`_seq` actual for the same `build_id`. Earlier `failed` or `aborted` actual rows remain attrition counters. Only authoritative `complete` rows are eligible. Keep `estimate_source: "escalated"` as its own cohort.
8. Realized lane uses the design's first-match rule:
   - `complex` if escalations ≥ 1, review iterations ≥ 3, or files changed ≥ 6;
   - else `trivial` if files changed ≤ 2, review iterations ≤ 1, and escalations = 0;
   - else `standard`.
9. Return stable JSON with these top-level keys in this order:
   - `v`, `filters`, `coverage`, `model_effort`, `sites`, `acrr`, `known_limitations`.
   - Each model/site row carries sample counts beside nullable medians, separate completion and acceptance objects, retry numerator/denominator/rate, and `usd_total`.
   - `acrr` carries `eligible`, `escalated`, `attrition_count`, `failed_attempts`, `aborted_attempts`, `pending_count`, `unpaired_count`, and paired `rows`.
10. Export `renderDispatchMetrics(report)` with four sections: `Model × executed effort`, `Sites`, `ACRR`, `Known limitations`. A GSD acceptance value is rendered exactly `n/a (not instrumented)`.

The JSON property contract is:

```text
{
  v,
  filters: { since, feature },
  coverage: { dispatch_count, unattributed_count, null_usage_count },
  model_effort: [{
    model, effort_executed, effort_intended_when_unknown, dispatch_count,
    token_sample_count, null_usage_count, median_tokens,
    duration_sample_count, median_duration_ms,
    completion: { ok, total, rate },
    acceptance: { accepted, settled, rate, note },
    retry: { retries, eligible, rate, note },
    usd_total
  }],
  sites: [{
    site, dispatch_count, token_sample_count, null_usage_count, median_tokens,
    duration_sample_count, median_duration_ms,
    completion: { ok, total, rate },
    acceptance: { accepted, settled, rate, note },
    retry: { retries, eligible, rate, note },
    usd_total
  }],
  acrr: {
    eligible: { matched, total, rate },
    escalated: { matched, total, rate },
    attrition_count, failed_attempts, aborted_attempts, pending_count, unpaired_count,
    rows: [{
      build_id, feature_code, estimate_source, confidence, estimated_lane,
      terminal_status, realized_lane, matched, files_changed_count, files_source,
      review_iterations, escalations
    }]
  },
  known_limitations: { retry_rate, gsd_acceptance }
}
```

All unavailable rates/medians are `null`. Human rendering turns a null model into `(model: unknown)`; JSON keeps it null.

Use the tolerant JSONL/aggregation separation in `lib/experiment-metrics.js:28-53`, `lib/experiment-metrics.js:93-145`, and `lib/experiment-metrics.js:189-264` as the repository pattern.

### `lib/stratum-mcp-client.js`

Current seams: `buildAgentRunRequest()` at `lib/stratum-mcp-client.js:114-132`, class declaration at `lib/stratum-mcp-client.js:143`, `#callTool()` at `lib/stratum-mcp-client.js:302-370`, `agentRun()` at `lib/stratum-mcp-client.js:510-521`, and `runAgentText()` at `lib/stratum-mcp-client.js:533-538`.

1. Import `randomUUID` from `node:crypto` and `appendEvent`.
2. Add one private shared helper, used by both public methods, that:
   - mints the UUID before calling `#callTool`;
   - passes the current request unchanged to `buildAgentRunRequest`;
   - executes `agent_run` once;
   - derives a dispatch row from `opts.telemetry`, response telemetry/usage, elapsed wall time, and outcome;
   - appends through a private fail-open recorder;
   - attaches the non-enumerable carrier to object success/error values.
3. Keep correlation/progress behavior in `agentRun()` unchanged; replace only its direct `#callTool` ownership with the helper.
4. Make `runAgentText()` call the same helper and then return `result?.text ?? ""`; do not return an object.
5. Use `opts.telemetry.project_cwd ?? process.cwd()` as ledger root. Default absent site to `unattributed`.
6. Set `effort_intended` from explicit telemetry first, then `opts.effort`; set `effort_executed` only from returned telemetry. Do not infer execution from the request.
7. Normalize usage without guessing:
   - Stratum `{ tokens, usd, ms }` → `tokens_total`, `usd`, `duration_ms`; `tokens_in`/`tokens_out` remain null;
   - any source-missing value remains null.
8. Map returned blocked/budget-exhausted envelopes to `blocked`, normal returned completion to `ok`, and thrown failures to `error` unless the existing error/envelope explicitly identifies a blocked outcome.
9. The capture `try/catch` must surround only telemetry construction/append. Re-throw the original dispatch error unchanged after attaching the carrier.

Do not alter the wire request: `buildAgentRunRequest()` currently omits unsupported `effort`, and the installed contract exposes telemetry on the response at `node_modules/@smartmemory/stratum/dist/contracts/mcp-surface.json:151-164`.

### `lib/local-claude-connector.js`

The entire owner is `runLocalClaudeAgent()` at `lib/local-claude-connector.js:48-149`; SDK options are assembled at `lib/local-claude-connector.js:53-76`, usage is attached to failures at `lib/local-claude-connector.js:101-125`, and successful telemetry is returned at `lib/local-claude-connector.js:135-148`.

1. Add `telemetry` to the options destructuring without passing it into the SDK.
2. Mint `dispatchId` immediately before the SDK query starts and start elapsed timing there.
3. On success, append exactly one `dispatch` event and attach the non-enumerable carrier to the existing result object.
4. On any throw/non-success path, preserve the existing `usage` attachment, append one event, attach the carrier to the original error, and rethrow it.
5. Record `model` from returned telemetry/usage only. Map local `{ input_tokens, output_tokens, cost_usd, duration_ms }` to `tokens_in`, `tokens_out`, `usd`, and `duration_ms`, and sum numeric token components into `tokens_total`. Track whether the SDK actually supplied usage for capture purposes so an unreported value is null even though the connector's existing public usage object remains backward-compatible.
6. Record `effort_intended` from caller context and leave `effort_executed: null`; the current local result has model and usage but no executed-effort field.
7. Make capture fail-open exactly as in the Stratum connector.

### `lib/result-normalizer.js`

Dispatch/wrapper seams are the local call at `lib/result-normalizer.js:440-449`, Stratum call at `lib/result-normalizer.js:451-460`, error replacement at `lib/result-normalizer.js:462-482`, late timeout/abort replacement at `lib/result-normalizer.js:495-507`, review repair at `lib/result-normalizer.js:540-558`, and all return branches at `lib/result-normalizer.js:559-583`.

1. Accept `opts.telemetry` and derive a per-primary context:
   - preserve caller `project_cwd`, `site`, `build_id`, and `feature_code`;
   - overlay `step_id` from the dispatch, numeric `attempt` when present, and intended effort from the resolved agent config.
2. Pass that context to both connector paths without changing their current `cwd` execution root.
3. Add `copyDispatchId(source, target)` that defines the same non-enumerable property.
4. Use it whenever an underlying error is replaced by `AgentTimeoutError`, `UserInterruptError`, `AgentAbortedError`, or `AgentError`; do the same for late-result timeout/abort wrappers.
5. Capture `primaryDispatchId` from `runResult.dispatchId`.
6. In the review `repairFn`, pass the same build/feature context with `site: "review-repair"` and capture the repair result's `dispatchId` in a closure before returning its text.
7. Add `dispatchIds: { primary: primaryDispatchId ?? null, repair: repairDispatchId ?? null }` to every normalized return, including unstructured and normalization-failure branches.
8. Preserve the existing result/usage/error contracts and the repair callback's string return.

### `lib/build.js`

This file owns build identity, estimates, actuals, settlements, and most dispatch context.

#### A. Ledger and accumulator helpers

1. Add ledger imports at the existing import block `lib/build.js:11-77`.
2. Add helpers beside the active-build persistence helpers:
   - the active-build atomic pattern is `lib/build.js:1194-1216`;
   - implement `buildAccumulatorPath`, strict `readBuildAccumulator`, atomic `writeBuildAccumulator` using `<path>.tmp` + `renameSync`, `clearBuildAccumulator`, `createBuildAccumulator`, `updateBuildAccumulator`, `emitTriageEstimate`, `emitBuildActuals`, and `settleDispatches`.
3. `settleDispatches` accepts `{ dispatchIds, accepted, failureClass, isEnsureRetry, gsd }`:
   - return immediately for GSD;
   - write primary settlement if present;
   - if a repair ID exists, settle primary as rejected/`normalization` and repair with the final acceptance result;
   - for failed agent/error envelopes use existing failure classification;
   - for a `previousFailure` reissue settle rejected with `ensure-retry`;
   - never invent a settlement for ship/recovery work that has no dispatch ID.

#### B. Build initialization and finalization

1. In `runBuild()` (`lib/build.js:1612`), move accumulator selection before triage and before any post-start exit. Replace the fresh UUID initialization at `lib/build.js:1663-1684` with the selected accumulator's `build_id`, including `COMPOSE_BUILD_ID`.
2. Preserve the current early CLI abort at `lib/build.js:1630-1639`; it occurs before a build attempt starts and therefore emits no actuals.
3. At the triage branches `lib/build.js:1733-1768`:
   - retain a local `triageEstimate`;
   - cached feature → ledger `estimate_source: "cached"`;
   - fresh `applyFrontTriage` → `"fresh"`;
   - `_escalated` feature → `"escalated"`;
   - copy persisted `triageConfidence`, or `null` for legacy cached features.
4. Immediately after a new accumulator and resolved triage, emit the one estimate row. Never re-emit it when reusing a failed accumulator.
5. Widen the existing outer `try/catch/finally`, which currently begins only after initialization and state setup at `lib/build.js:1907-1959`, so the missing lifecycle-spec throw at `lib/build.js:1774-1778`, preflight failures, flow-start failures, and all later failures share finalization.
6. Declare resources used by `finally` (`stratum`, progress/stream/signal handles, status and accumulator state) before the widened `try`; keep cleanup guards null-safe.
7. Seed `buildCostTotals` and all counters from the accumulator instead of only from a running active-build row at `lib/build.js:1931-1957`.
8. Finalize only after terminal mapping at `lib/build.js:3414-3479` and health downgrade handling at `lib/build.js:3530-3558`:
   - `buildStatus === "complete"` → `terminal_status: "complete"`;
   - gate-killed and signal-aborted paths → `"aborted"`;
   - every other thrown or terminal failure → `"failed"`.
9. Put actual emission/sidecar retention or clearing in the widened `finally` before connector shutdown at `lib/build.js:3693-3707`. Guard it with an attempt-started flag and an attempt-finalized flag so nested terminalization cannot double-append.

#### C. Accumulator mutation seams

1. At the execution context `lib/build.js:2236-2258`, retain `cwd: agentCwd` and existing `build_id`, then add:
   - `projectCwd: cwd`;
   - `recordBuildUsage(usage)`, which folds tokens/USD and atomically persists;
   - `recordFilesChanged(paths, { authoritativeShip = false } = {})`, which updates either the accumulated union or `ship_files_changed`;
   - `recordEscalation()`, which increments once and persists;
   - `settleDispatches(args)`, bound to the project/build context.
   GSD does not supply these build callbacks, so shared helpers remain no-ops there.
2. Increment `review_iterations` once when a dirty review gate takes the revise path at `lib/build.js:3244-3258`, not once per lens.
3. Increment `escalations` only when `executeShipStep()` receives `action === "escalate"` at `lib/build.js:3901-3915`.
4. Persist the deduplicated context union whenever ordinary or consumer changes are merged at `lib/build.js:2779-2795` and `lib/build.js:3107-3117`.
5. Save authoritative ship files and ship test metrics in both ship paths:
   - intercepted ship reporting at `lib/build.js:2498-2604`;
   - ordinary `executeShipStep` return handling at `lib/build.js:2779-2819`;
   - authoritative committed-file production at `lib/build.js:4078-4087`;
   - test-metric extraction helper at `lib/build.js:3810-3812`.
6. Fold normalized step usage into accumulator totals at `lib/build.js:2943-2950` by calling `context.recordBuildUsage(stepUsage)` in the same branch that updates `buildCostTotals`.
7. In build mode, set `context.onUsage = context.recordBuildUsage`; `runConsumerIssuance` already invokes it at `lib/build.js:867-872`. GSD continues to supply its own `recordTsAgentUsage` callback.
8. Do not reconstruct accumulator totals by rereading dispatch rows; the sidecar is authoritative for build actuals.

#### D. Settlement seams

1. Ordinary steps: preserve `mainResult.dispatchIds` through synthetic timeout/interrupt results at `lib/build.js:2674-2704`; after the successful `stepDone` at `lib/build.js:2850-2863`, emit settlement using the engine envelope:
   - synthetic results copy `err.dispatchId` into `{ primary, repair: null }` and carry an internal settlement class when they submit failure; timeout/connector failures use `agent`, structured-output failure uses `normalization`, and user skip/retry follows the actual submitted-envelope/engine-response pair;
   - output accepted → `accepted: true`;
   - ownership/vocabulary/normalization failures → `accepted: false` with the corresponding existing class;
   - reissued step with `previousFailure` → `accepted: false`, `failure_class: "ensure-retry"`;
   - other agent failure → `failure_class: "agent"`.
2. Consumer steps: retain `mainResult.dispatchIds` from the call at `lib/build.js:799-822`; caught errors at `lib/build.js:823-865` synthesize `{ dispatchIds: { primary: error.dispatchId ?? null, repair: null }, settlementFailureClass: "agent" }`; settle only after the successful report/`stepDone` path at `lib/build.js:873-942`.
3. Do not settle GSD fanout. `runConsumerIssuance` must branch on `context.gsd`.

#### E. Dispatch context seams

Pass a telemetry object without changing execution `cwd`.

| Call site | Verified seam | `site` |
|---|---|---|
| Consumer build/GSD fanout | `lib/build.js:799-822` | `context.gsd ? "gsd" : "consumer"` |
| Ensure-retry fixer | `lib/build.js:2613-2633` | `review-repair` |
| Ordinary build/review | `lib/build.js:2649-2685` | `isReviewMain ? "review" : "build-step"` |
| Review-gate fixer | `lib/build.js:3237-3252` | `review-repair` |
| Gate question/answer | `lib/build.js:1382-1396` | `gate-qa` |
| Codex preflight caller | `lib/build.js:2135-2141` | callee receives project/build/feature context |

Every context carries `project_cwd: cwd`, `build_id`, `feature_code`, and the available `step_id`/`attempt`. Gate QA uses `context.projectCwd` as ledger root and `context.cwd` as execution root.

#### F. Explicit abort

At `abortBuild()` (`lib/build.js:4380-4421`), after the current terminal active-build write:

1. Load the matching feature accumulator.
2. Emit one `build-actuals` row with `terminal_status: "aborted"`.
3. Clear the accumulator only after append succeeds.
4. If no matching accumulator exists, preserve current abort behavior and emit nothing.

### `lib/experiment-judge.js`

`judge()` is `lib/experiment-judge.js:120-144`; its direct `agentRun` is `lib/experiment-judge.js:126-134` and compatibility fallback is `lib/experiment-judge.js:135-138`.

1. Pass `telemetry: { site: "judge", project_cwd: cwd, ...available correlation }` to `agentRun`.
2. Pass the same context to `runAgentText` in the fallback.
3. Leave feature/build/step fields absent when this standalone workflow does not possess them; do not invent identifiers.

### `lib/codex-preflight.js`

`preflightCodexWorktreeProbe()` is `lib/codex-preflight.js:72-140`; its direct dispatch is `lib/codex-preflight.js:113`.

1. Extend its argument object with `projectCwd`, `buildId`, and `featureCode`.
2. Keep `cwd` as the detached worktree execution root.
3. Pass telemetry with `site: "preflight"` and the three supplied identifiers.
4. Update the build caller at `lib/build.js:2135-2141` to pass `projectCwd: cwd`, the accumulator build ID, and feature code.

### `lib/bug-escalation.js`

Tier-1 dispatch is in `tier1CodexReview()` at `lib/bug-escalation.js:101-134`; tier-2 dispatch is in `tier2FreshAgent()` at `lib/bug-escalation.js:252-305`, with the model call at `lib/bug-escalation.js:293`.

1. For both dispatches pass `site: "escalation"`.
2. Use `context.projectCwd ?? context.cwd` as `project_cwd`; keep the current worktree/cwd for execution.
3. Pass `context.build_id`, `context.featureCode`, current step ID, and attempt when available.
4. Add `projectCwd` to the build context before calls made through `maybeRunEscalation()` at `lib/build.js:211-278`.

### `lib/gsd.js`

1. At GSD fanout context construction `lib/gsd.js:500-529`, extend the object currently built at `lib/gsd.js:521` with `projectCwd: cwd` and keep `gsd: true`. `runConsumerIssuance` then emits `site: "gsd"` and suppresses settlement.
2. At the direct GSD `agentRun` call `lib/gsd.js:566-570`, pass telemetry with `site: "gsd"`, `project_cwd: cwd`, `feature_code`, current `step_id`, and available attempt.
3. Do not alter `recordTsAgentUsage()` at `lib/gsd.js:1414-1429`; it remains usage accounting, not a dispatch or context seam.

### `lib/triage.js`

No code change. `estimateScope()` already computes `confidence` and returns it at `lib/triage.js:243-289`. This file is the confidence source; persistence belongs to `applyFrontTriage` in `lib/lane-gate.js`.

### `lib/lane-gate.js`

`applyFrontTriage()` is at `lib/lane-gate.js:50-116`; it obtains `front` at `lib/lane-gate.js:55`, constructs persisted fields at `lib/lane-gate.js:85-92`, validates at `lib/lane-gate.js:94`, and returns at `lib/lane-gate.js:108-115`.

1. Add `triageConfidence: front.confidence` to `fields`.
2. Let the existing create/put spread persist it.
3. Return `confidence: front.confidence` alongside lane/tier.
4. Do not recompute confidence after refinement; the design binds confidence to the front estimate.

### `contracts/feature-json.schema.json`

The triage fields are currently adjacent at `contracts/feature-json.schema.json:32-47`.

1. Add optional `triageConfidence`.
2. Schema: `{ "type": "string", "enum": ["high", "medium", "low"] }`.
3. Keep the root's current permissive optional-field policy; do not add it to `required`.

### `lib/feature-writer.js`

The fixed-vocabulary constants are at `lib/feature-writer.js:60-70`, `validateFeatureFields()` is at `lib/feature-writer.js:73-110`, the `addRoadmapEntry` field contract is at `lib/feature-writer.js:149-169`, validation is called at `lib/feature-writer.js:179-183`, and the feature object is assembled at `lib/feature-writer.js:211-237`.

1. Add `TRIAGE_CONFIDENCES = new Set(["high", "medium", "low"])`.
2. Document and validate optional `triageConfidence` in `validateFeatureFields`.
3. Add it to `addRoadmapEntry` JSDoc and persist it beside lane/tier/source.
4. Keep field validation shared so raw build writes and roadmap creation reject the same invalid values.

### `bin/compose.js`

The argv root is `bin/compose.js:97`, command help is `bin/compose.js:117-150`, the workspace resolver is `bin/compose.js:61-87`, and the current command chain terminates at `bin/compose.js:3825-3828`.

1. Add help for `compose metrics [--since <duration|ISO>] [--feature <code>] [--json]`.
2. Add a `cmd === "metrics"` branch before the final unknown-command path.
3. Resolve the project root through the existing workspace resolver.
4. Parse only the three designed flags; reject missing flag values and unknown metrics flags with a non-zero exit.
5. Dynamically import `collectDispatchMetrics` and `renderDispatchMetrics`.
6. `--json` writes only `JSON.stringify(report, null, 2)` plus one newline. Human mode writes the renderer output.
7. Do not add an MCP surface.

### Explicit non-work

- Do not instrument GSD settlements; its acceptance column remains `n/a (not instrumented)`.
- Do not forward `effort` over the Stratum wire or into local-Claude SDK options.
- Do not backfill historical Stratum metadata.
- Do not feed measured curves into routing defaults.
- Do not add a metrics MCP tool.
- Do not expand this change into the design-chat/import/validation/new-project callers that are outside the named file scope. The connector owner still records those calls as `unattributed` until context is threaded in a later change.

## 3. Corrections table (binding) — design vs verified code

| Design statement/citation | Verified current code | Binding implementation correction |
|---|---|---|
| Names the client `StratumClient`. | The class is `StratumMcpClient` at `lib/stratum-mcp-client.js:143`; public dispatch methods are `lib/stratum-mcp-client.js:510-538`. | Refactor `StratumMcpClient`; do not introduce a second client class. |
| Places confidence persistence in `lib/triage.js`/`applyFrontTriage`. | `lib/triage.js:243-289` only computes confidence. `applyFrontTriage` is `lib/lane-gate.js:50-116`. | `lib/triage.js` is unchanged; persist through `lib/lane-gate.js`, schema, and `validateFeatureFields`. |
| Cites GSD fanout context at `lib/gsd.js:1414`. | `lib/gsd.js:1414-1429` is `recordTsAgentUsage`. Fanout context is `lib/gsd.js:500-529`, specifically line 521. | Thread GSD telemetry at line 521 and direct dispatch at `lib/gsd.js:566-570`; leave the recorder unchanged. |
| Cites `abortBuild` around `lib/build.js:3458`. | `lib/build.js:3458` begins the normal failed-terminal branch. `abortBuild` is `lib/build.js:4380-4421`. | Put explicit-abort actual emission in the exported `abortBuild` function. |
| Refers to repository `contracts/mcp-surface.json`. | That path is absent. The installed frozen response contract is `node_modules/@smartmemory/stratum/dist/contracts/mcp-surface.json:151-164`. | Preserve the installed wire contract; telemetry context is Compose-only and must not enter the request payload. |
| Says the non-enumerable carrier is attached to what `runAgentText()` returns. | `runAgentText()` returns a primitive string at `lib/stratum-mcp-client.js:533-538`. | Preserve the string API. The shared helper records the dispatch; only object returns/errors carry `dispatchId`. |
| `build-actuals` closed shape omits `files_source`, while the counter definition requires `ship \| accumulated` provenance. | The design's counter-source rule requires provenance for authoritative ship files versus the accumulated context union. | `files_source` is a required `build-actuals` field and part of the writer's closed allowlist. |
| Says to use the “same sync discipline as the stepHistory sidecar.” | Step history is projected through the atomic active-build writer at `lib/build.js:1194-1216` and synchronized at `lib/build.js:4221-4258`; there is no standalone step-history sidecar. | Copy the active-build temp-file + rename discipline for the new accumulator. |
| Treats the existing outer finalizer as covering early post-estimate exits. | The current `try` begins at `lib/build.js:1959`; missing spec can throw at `lib/build.js:1774-1778`. | Widen the try/finally to begin immediately after attempt/accumulator creation. |
| Uses ledger `estimate_source` values `fresh/cached/escalated`. | Persisted feature `estimateSource` validates `front/refined/escalated` at `lib/feature-writer.js:66-70`. | Keep the persisted vocabulary unchanged and map it only when emitting the ledger estimate. |
| Assumes `runAndNormalize`'s `cwd` is the ledger root. | Build execution uses `agentCwd` at `lib/build.js:2676-2685`; consumer execution may use a worktree at `lib/build.js:799-822`. | Thread separate `telemetry.project_cwd`; never derive the ledger root from execution `cwd`. |

## 4. Test plan mapped to acceptance criteria

Repository idiom: backend/CLI tests use `node:test` under `test/*.test.js`; `npm test` runs them with the suppress-drift import before the Vitest UI/tracker suites at `package.json:15-28`.

| Design AC | Test work | Mechanical assertions |
|---|---|---|
| 1. Exactly one event for every connector-owned dispatch, including judge and review repair | New `test/dispatch-capture.test.js`; extend Stratum fakes patterned after `test/stratum-mcp-client-parallel.test.js:184-221` and local connector coverage at `test/ts-cutover-e3-round3.test.js:221-273`. | `agentRun`, `runAgentText`, local success/failure, judge, and review repair each append exactly one event; object/error carriers are non-enumerable. Use temp project roots so tests never write the repository ledger. |
| 2. Intended and executed effort are recorded and never conflated | `test/dispatch-capture.test.js` and `test/dispatch-metrics.test.js`. | Intended-only, executed-only, both, and neither cases retain exact nullable fields; intended effort is never copied into executed effort. |
| 3. Error/blocked rows remain valid with null usage | `test/dispatch-capture.test.js`. | Blocked envelopes, MCP disconnects, parse/tool failures, and local failures append valid rows with null usage when none was reported; metrics count null-usage rows. |
| 4. Ledger root is the project, not the worktree | `test/dispatch-capture.test.js`. | Set execution `cwd` and `project_cwd` to different temp paths; assert the line exists only under the project root. |
| 5. Missing context becomes visible `unattributed` coverage | `test/dispatch-capture.test.js` and `test/dispatch-metrics.test.js`; extend `test/bug-escalation-tier1.test.js:57-88`, `test/bug-escalation-tier2.test.js:109-146`, `test/experiment-model-ab.test.js:601-655`, and preflight fakes at `test/codex-impl.test.js:196-224`. | Explicit call sites record their designed sites; a direct uncontextualized call records `unattributed`; the metrics coverage count includes it. |
| 6. Settlement only for dispatch-backed adjudication | `test/dispatch-build.test.js`; add review-repair cases to `test/dispatch-capture.test.js`. | Accepted ordinary step, ownership/vocabulary/normalization/agent failure, ensure reissue, consumer success/failure, and primary+repair pairs generate exact rows. Ship/recovery/replay and GSD generate none. |
| 7. Resume-stable build identity/counters and abort terminal | New `test/dispatch-build.test.js`, using the resume setup pattern at `test/build-integration.test.js:371-447`; extend `test/abort-build-engine.test.js:35-69`. | Failed attempt leaves the sidecar; resumed completion uses the same UUID and cumulative counters; highest-`_seq` complete actual is authoritative and prior failure is attrition; complete/abort clear the sidecar; abort emits its own actual. |
| 8. Confidence plus estimates on all resolution paths and actuals on all terminals | Extend `test/triage-front-golden.test.js:22-44`, `test/feature-fields.test.js:32-106`, `test/feature-fields.test.js:112-184`, and `test/feature-json-schema-external.test.js:21-35`; add build cases to `test/dispatch-build.test.js`. | Confidence persists/validates; fresh/cached/escalated each emit one estimate; complete, failed, health-downgraded, missing-spec, gate-killed, and explicit-abort paths emit one terminal actual; ship files win, else deduplicated accumulated files. |
| 9. Metrics human/JSON output is stable and complete | `test/dispatch-metrics.test.js` and new `test/metrics-cli.test.js`. | Assert model×executed-effort buckets, unknown model/effort rows, separate completion/acceptance, per-site/null-usage coverage, exact realized-lane rules, ACRR/attrition/escalated cohorts, filters, strict JSON, and GSD `n/a (not instrumented)`. |
| 10. Closed writer and tolerant reader | New `test/dispatch-ledger.test.js`. | Valid shapes append; unknown/missing/wrong fields reject; malformed/unknown rows skip; extra future fields read; filters and `_seq` behave deterministically. |
| 11. Capture failure never changes build behavior | `test/dispatch-capture.test.js`. | Inject an `EACCES`/throwing append seam for both connectors and assert the original success value or original dispatch error is preserved. |

Additional ledger unit coverage in `test/dispatch-ledger.test.js`:

- each valid closed row shape;
- writer rejection for unknown/missing/wrong fields and enums;
- monotonically increasing `_seq` across module use and an existing file;
- malformed/unknown rows skipped;
- extra future fields tolerated by the reader;
- missing file returns `[]`;
- ISO and duration `since` filtering.

Targeted command after the implementation phases:

```sh
node --import ./test/suppress-expected-drift.js --test --test-timeout=120000 \
  test/dispatch-ledger.test.js \
  test/dispatch-capture.test.js \
  test/dispatch-metrics.test.js \
  test/dispatch-build.test.js \
  test/metrics-cli.test.js \
  test/feature-fields.test.js \
  test/feature-json-schema-external.test.js \
  test/triage-front-golden.test.js \
  test/abort-build-engine.test.js
```

Final verification:

```sh
npm test
```

Also run `git diff --check` and inspect the final diff for prompt/response/tool/file/env data entering ledger construction.

## 5. Dependency-sorted implementation order

### Phase 1 — Ledger primitive and field contract

1. Add `lib/dispatch-ledger.js`.
2. Add `triageConfidence` to `contracts/feature-json.schema.json`, `lib/feature-writer.js`, and `lib/lane-gate.js`.
3. Add `test/dispatch-ledger.test.js` and extend feature/schema/triage tests.
4. Run the Phase 1 subset.

### Phase 2 — Connector ownership and context threading

1. Refactor `lib/stratum-mcp-client.js`.
2. Instrument `lib/local-claude-connector.js`.
3. Thread carrier/context through `lib/result-normalizer.js`.
4. Add explicit context in `lib/experiment-judge.js`, `lib/codex-preflight.js`, `lib/bug-escalation.js`, `lib/gsd.js`, and the corresponding `lib/build.js` call sites.
5. Add/extend capture and call-site tests; run the Phase 2 subset.

### Phase 3 — Build accumulator, estimates, settlements, and terminal actuals

1. Add accumulator persistence and build identity selection in `lib/build.js`.
2. Emit estimates and widen the outer finalization boundary.
3. Wire counter mutation and authoritative ship/test data.
4. Add ordinary/consumer settlement seams.
5. Extend `abortBuild`.
6. Add `test/dispatch-build.test.js` and abort/resume cases; run the Phase 3 subset.

### Phase 4 — Metrics and CLI

1. Add `lib/dispatch-metrics.js`.
2. Add the `metrics` branch to `bin/compose.js`.
3. Add metrics and CLI tests; run the Phase 4 subset.

### Phase 5 — Integrated verification

1. Run the targeted command above.
2. Run `npm test`.
3. Run `git diff --check`.
4. Audit connector owners for exactly one append per execution and audit the diff for prohibited payload content.
