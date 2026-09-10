# Compose abort / cancel / consumer-dispatch exploration

Read-only trace, 2026-09-10. Target: wire `stratum_flow_cancel` (new in
`@smartmemory/stratum` 0.5.0) and flow-tag every consumer agent run.

All paths absolute. Line numbers are as of this trace.

---

## 1. `/Users/ruze/reg/my/forge/compose/lib/stratum-mcp-client.js` — agent-run and cancellation surface

### `buildAgentRunRequest` (line 160)

Keys emitted today are exactly: `agent`, `prompt`, `cwd`, `model`, `sandboxMode`,
`allowedTools`, `disallowedTools`, `thinking`, `effort`, `cancellationId`
(lines 160-183). **There is no `flow` key.**

```js
export function buildAgentRunRequest(agentType, prompt, opts = {}) {
  const provider = String(agentType ?? 'claude').split(':', 1)[0] || 'claude';
  return {
    agent: provider,
    prompt,
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.modelID ? { model: opts.modelID } : {}),
    ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.disallowedTools !== undefined ? { disallowedTools: opts.disallowedTools } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.cancellationId !== undefined ? { cancellationId: opts.cancellationId } : {}),
  };
}
```

### `cancellationId` generation (line 272)

```js
const cancellationId = opts.cancellationId ?? (signal ? randomUUID() : undefined);
```

A `cancellationId` is generated **only when an AbortSignal is passed**. Every
consumer dispatch does pass one (`lib/result-normalizer.js:583`), so consumer
runs always carry one today. Paths without a signal carry none.

### The `#agentFields` version guard (lines 277-290)

Field cache declared at line 190 (`#agentFields = null`), reset on `connect`
(line 471) and `close` (line 486). The guard lists tools once per connection,
caches the `stratum_agent_run` schema property names, and refuses any request key
the server does not advertise:

```js
    if (this.#connected) {
      if (!this.#agentFields) {
        const listed = await abortable(this.#client.listTools(undefined, { signal }), signal);
        const tool = listed.tools.find(entry => entry.name === 'stratum_agent_run');
        this.#agentFields = new Set(Object.keys(tool?.inputSchema?.properties ?? {}));
      }
      const missing = Object.keys(request).filter(key => !this.#agentFields.has(key));
      if (missing.length) {
        const installed = this.#client.getServerVersion()?.version ?? 'unknown';
        throw new StratumError('UNSUPPORTED_AGENT_OPTIONS',
          `Installed Stratum ${installed} does not support ${missing.join(', ')} required by this call; ` +
          'required execution surface: 17 (@smartmemory/stratum >=0.4.0).', '');
      }
    }
```

The `surface: 17` and `>=0.4.0` strings are hardcoded in that one template
literal. **There is no surface-version constant anywhere else in `lib/`** — the
only other mention is a comment at `/Users/ruze/reg/my/forge/compose/lib/completion-gate.js:405`
("Stratum >= 0.4.0 validates resolved_by strictly").

### How the client learns the server version

Solely from `this.#client.getServerVersion()?.version` at line 285 — an MCP
handshake value, read at the moment of failure, never persisted anywhere.

### Abort → server cancellation (lines 291-320)

Teardown budget at line 291:

```js
const teardownMs = opts.cancellationTimeoutMs ?? Number(process.env.COMPOSE_CANCEL_TIMEOUT_MS ?? 15000);
```

The signal's `abort` event runs `cancel()`, which calls `cancelAgentRun(cancellationId)`
under `cancellationDeadline`, then awaits the original RPC:

```js
    const cancel = () => {
      cancellation ??= (async () => {
        let ack;
        try {
          ack = await cancellationDeadline(this.cancelAgentRun(cancellationId), teardownMs, 'Cancellation acknowledgement');
        } catch (error) {
          if (error?.code === 'CANCELLATION_TEARDOWN_TIMEOUT') throw error;
          throw new StratumError('CANCELLATION_UNCONFIRMED', `Foreground cancellation could not be acknowledged: ${error.message}`, '');
        }
        if (!['cancelled', 'already_cancelled', 'already_complete', 'already_error', 'not_found'].includes(ack?.status)) {
          throw new StratumError('CANCELLATION_UNCONFIRMED',
            `Stratum did not confirm foreground termination (${ack?.status ?? 'missing status'})`, '');
        }
        const settled = await cancellationDeadline(outcome, teardownMs, 'Original agent RPC after cancellation acknowledgement');
        const error = new Error('Agent execution cancelled after termination was acknowledged');
        error.name = 'AbortError';
        for (const key of ['usage', 'telemetry', 'split', 'usdSource']) {
          if ((settled.error ?? settled.value)?.[key] !== undefined) error[key] = (settled.error ?? settled.value)[key];
        }
        throw error;
      })();
      cancellation.catch(rejectAbort);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
```

Helpers: `abortable` (line ~898) and `cancellationDeadline` (line ~908, emits
`CANCELLATION_TEARDOWN_TIMEOUT`).

### `cancelAgentRun` (line 878)

```js
  async cancelAgentRun(runId) {
    return this.#callTool('stratum_cancel_agent_run', { runId });
  }
```

The parameter is named `runId` but is passed the **cancellationId**. That is the
tool's wire shape and is pinned by tests (see section 6).

### `#callTool` (line 517)

Requires `#connected` unless `NODE_ENV=test` and `_testClient` is injected
(lines 518-523). Progress subscription options at 526-534
(`onprogress`, `resetTimeoutOnProgress`, `timeout: 600_000`,
`maxTotalTimeout: 24h`). Error enrichment from `error.data` at 536-548 (preserves
the numeric JSON-RPC code as `error.rpcCode`). Prefers `structuredContent`, falls
back to text JSON (550-585). Unwraps the Stratum error envelope at 587-596.

### Does anything call `stratum_flow_cancel` yet?

**No.** Full list of tools this client calls:

| Tool | Line |
|---|---|
| `stratum_agent_run` | 293 |
| `stratum_cancel_agent_run` | 879 |
| `stratum_plan` | 616 |
| `stratum_resume` | 640 |
| `stratum_step_done` | 652 |
| `stratum_usage_report` | 663 |
| `stratum_gate_resolve` | 696 |
| `stratum_audit` | 710 |
| `stratum_validate` | 719 |
| `stratum_commit` | 729 |
| `stratum_revert` | 742 |

A generic feature-detect helper already exists: `hasTool(name)` at line 490
(caches `#toolNames`, treats a listing failure as absent).

Public dispatch wrappers: `agentRun` (line 770, `subscribeProgress: true`),
`runAgentText` (line 792, no progress), both funnelling through
`#dispatchAgentRun` (line 241) → `#invokeAgentRun` (line 270).

---

## 2. `/Users/ruze/reg/my/forge/compose/lib/build.js` — the consumer dispatch loop

### Per-item entry point: `runConsumerIssuance` (line 747)

```js
export async function runConsumerIssuance({
  descriptor,
  flowId,
  stratum,
  artifacts,
  audit,
  localSpec,
  context,
  progress,
  streamWriter,
  perItemTimeoutMs = null,
  stuckDetector = null,
  profile = null,
}) {
```

The flow id parameter is named **`flowId`** at this site.

### What it knows about the item

- `descriptor.id` — scoped issuance id
- `descriptor.step` — the FANOUT step id (profiles are keyed off this)
- `descriptor.itemIndex` — item index within the fanout
- `descriptor.stage`, `descriptor.generation`, `descriptor.dispatchToken`
- `descriptor.policy?.isolation`, `descriptor.policy?.pre_merge`
- `flowId` (parameter)
- Lane envelope built at line 911: `buildLaneEnvelope(descriptor, flowId, {...})`
- Parallel step number at line 907: ``const parallelStepNum = `∥${descriptor.itemIndex}`;``

### The agent invocation (lines 933-957)

It is **not** a direct `stratum.agentRun` — it goes through `runAndNormalize`:

```js
    mainResult = await runAndNormalize(null, prompt, dispatch, {
      progress,
      streamWriter,
      maxDurationMs,
      stratum,
      lane,
      cwd: recovery.worktree,
      sandboxMode: descriptor.policy?.isolation === 'worktree' ? 'workspace-write' : 'read-only',
      onAgentEvent,
      profile,
      reviewMode: reviewOpts.reviewMode,
      confidenceGate: reviewOpts.confidenceGate,
      lens: reviewOpts.lens,
      telemetry: {
        site: context.gsd ? 'gsd' : 'consumer',
        project_cwd: context.projectCwd ?? context.cwd,
        build_id: context.build_id,
        feature_code: context.featureCode,
        step_id: descriptor.id,
        ...(typeof descriptor.attempt === 'number' ? { attempt: descriptor.attempt } : {}),
      },
      // Local Claude owns its SDK process group for review fanout and drains
      // graceful teardown before timeout/interrupt returns, as MCP does.
      localExecution: descriptor.policy?.isolation === 'none',
    });
```

### Isolation modes

- `isolation: 'worktree'` → `sandboxMode: 'workspace-write'`, agent runs in
  `recovery.worktree`, merged via the artifacts journal.
- `isolation: 'none'` → `sandboxMode: 'read-only'` AND `localExecution: true`,
  which routes to the in-process local Claude SDK (section 4). Line 1035 notes
  an `isolation: none` item does not merge, so it has no pre-merge step.

### The pump (inside `runBuild`, lines 3170-3332)

State at 3182-3188: `consumerSeenTokens`, `consumerPending`, `consumerInFlight`
(Map keyed by `dispatchToken`), `consumerCompleted`, `consumerConcurrency`,
`consumerFatalError`, `consumerWake`.

`runConsumerDescriptor` (line 3198) derives the flow id and calls the issuance:

```js
    const runConsumerDescriptor = async (descriptor, sourceResponse) => {
      const flowId = sourceResponse.runId ?? sourceResponse.flow_id;
      const artifacts = artifactsForRun(flowId);
      const audit = await stratum.audit(flowId);
      await visionWriter.updateItemPhase(itemId, descriptor.id);
      updateActiveBuildStep(dataDir, descriptor.id, {
        stepNum: sourceResponse.step_number,
        totalSteps: sourceResponse.total_steps,
      });
      return runConsumerIssuance({
        descriptor,
        flowId,
        stratum,
        artifacts,
        audit,
        localSpec,
        context,
        progress,
        streamWriter,
        profile: resolveStepProfile(effectiveProfiles, descriptor.step)
          ?? resolveStepProfile(effectiveProfiles, descriptor.id),
      });
    };
```

- `launchPendingConsumers` (line 3226) — concurrency-bounded launcher; in-flight
  map set at 3243.
- `enqueueConsumerReady` (line 3247) — dedupes by `dispatchToken` (3256, 3267),
  binds run revision (3266).
- `drainConsumerFatal` (line 3275) — clears pending, awaits in-flight, rethrows.
- `mergeConsumerReady` (line 3285) — the wait loop.
- `drainConsumersThenRethrow` (line 3325) — pump-level fatal boundary,
  `Promise.allSettled` over in-flight (3329).

The second caller of `runConsumerIssuance` is GSD:
`/Users/ruze/reg/my/forge/compose/lib/gsd.js:510` (imported at `lib/gsd.js:29`).

### Where captured patches / diffs are merged after an item returns

1. Pre-merge gate, worktree isolation only (lines 1035-1044):

```js
  if (!localFailure && finalStage && descriptor.policy?.isolation !== 'none'
    && Array.isArray(descriptor.policy?.pre_merge)) {
    const gateFailure = runPreMergeGateLocal(
      recovery.worktree,
      descriptor.policy.pre_merge,
      context.cwd,
      STEP_TIMEOUT_MS[descriptor.id] ?? DEFAULT_TIMEOUT_MS,
    );
    if (gateFailure) localFailure = `pre_merge failed: ${JSON.stringify(gateFailure)}`;
  }
```

2. Envelope construction (1045-1059), including engine usage.
3. Hook `afterAgentMutationBeforePrepared` (1061-1067).
4. `artifacts.prepareIssuance(descriptor, envelope, { finalStage })` at line 1068 —
   `preparedEntry.diff` is the cumulative worktree diff computed by the journal at
   final stage (comment 1071-1075), `null` otherwise.
5. `reportConsumerStepDone` (helper at line 690) and `artifacts.reconcileAudit(await stratum.audit(flowId), ...)`
   at line 1110.

Supporting helpers: `runPreMergeGateLocal` (line 641), `isFinalConsumerStage`
(line 596), `resolveConsumerConcurrency` (line 1135), `deriveConsumerReviewOptions`
(line 566), `buildLaneEnvelope` (line 541).

---

## 3. Cancellation handling, signal handler, `abortBuild`, `active-build.json`

### Control-failure branch (lines 958-973)

`UserInterruptError` and the two cancellation codes abort the whole pump rather
than failing one item:

```js
  } catch (error) {
    const failedUsage = failureUsageFields(error);
    // Control failures do not settle the item, so record known dispatch usage
    // before aborting the pump. Never retry work with uncertain termination.
    if (error instanceof UserInterruptError || ['INJECTED_CONSUMER_CRASH', 'CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(error?.code)) {
      if (failedUsage.usage && typeof context?.onUsage === 'function') {
        try {
          await context.onUsage(usagePayload(failedUsage.usage, failedUsage.usages), {
            dispatchId: error.dispatchId, stepId: descriptor.step ?? descriptor.id, source: 'consumer',
          });
        } catch (usageError) {
          console.warn(`[consumer] Could not record cancelled usage: ${usageError?.message ?? usageError}`);
        }
      }
      throw error;
    }
```

Sibling branches: `AgentAbortedError` → `ConsumerStuckError` (976-988),
`AgentTimeoutError` → per-item failed envelope (989-998), any other agent error →
`artifacts.restoreToPreStageWitness(descriptor)` + per-item failure (999-1017).

The same predicate is exported for the policy-revision path at lines 5847-5850:

```js
/** Optional revision failures keep the draft; only user control or uncertain teardown stops the build. */
export function policyRevisionMustStop(error) {
  return error instanceof UserInterruptError
    || ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(error?.code);
}
```

### SIGINT / SIGTERM handler (lines 2975-2981)

Far smaller than assumed. It sets a status variable and closes the stream. Nothing
else.

```js
    // SIGINT/SIGTERM: mark build as killed
    signalHandler = () => {
      buildStatus = 'killed';
      streamWriter.close('killed');
    };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);
```

Declared at line 2279 (`let signalHandler = null;`). Removed at lines 4966-4968
and again at 4982-4984 in the shutdown paths.

It does **NOT**: kill the vision item, write `active-build.json`, emit actuals,
cancel any agent, cancel the flow, or exit the process.

`lib/build.js` has no other signal registration. The only other signal work in the
repo is the GSD watchdog (`/Users/ruze/reg/my/forge/compose/lib/gsd-supervisor.js:129-138`)
and the process-group teardown helper
(`/Users/ruze/reg/my/forge/compose/lib/process-termination.js:184-190`).

### `abortBuild` (lines 5799-5844)

```js
export async function abortBuild(dataDir, featureCode, cwd, opts = {}) {
  const active = readActiveBuild(dataDir);
  if (!active) {
    console.log('No active build to abort.');
    return;
  }

  if (featureCode && active.featureCode !== featureCode) {
    console.log(`Active build is for ${active.featureCode}, not ${featureCode}.`);
    return;
  }

  console.log(`Aborting build for ${active.featureCode}...`);

  // Probe the persisted TS run before abandoning the local build. Foreground TS
  // runs advance only through this client, so closing it prevents more dispatch.
  const stratum = opts.stratum ?? new StratumMcpClient();
  const connection = resolveStratumMcpConnection(cwd);
  try {
    await stratum.connect(connection);
    const audit = await stratum.audit(active.flowId);
    if (isTerminalFlow(audit.status)) {
      console.log(`Flow already ${audit.status}.`);
    }
  } catch {
    // A missing/unreadable run does not prevent local cleanup.
  } finally {
    await stratum.close();
  }

  // Update vision state
  const visionWriter = new VisionWriter(dataDir);
  const item = await visionWriter.findFeatureItem(active.featureCode);
  const itemId = item?.id;
  if (itemId) {
    await visionWriter.updateItemStatus(itemId, 'killed');
  }

  // Write terminal state (file retained per STRAT-COMP-4 contract)
  writeActiveBuild(dataDir, { ...active, status: 'aborted', completedAt: new Date().toISOString() });
  const accumulator = readBuildAccumulator(cwd, active.featureCode);
  if (accumulator) {
    emitBuildActuals(cwd, accumulator, 'aborted');
  }
  console.log('Build aborted.');
}
```

Facts that matter for the blueprint:

- It **does** have the flow id: `active.flowId`.
- It issues **no cancel of any kind** — no `stratum_cancel_agent_run`, no flow cancel.
- The only engine call is `stratum.audit(active.flowId)`, inside a bare
  `catch {}` that swallows **every** error class (5823-5824). There is no
  selective tolerance today, so "the error codes it tolerates" is: all of them.
- It opens a **fresh** MCP connection via `resolveStratumMcpConnection(cwd)`
  (line 5816) — a different server process from the one the running build uses.
- It returns `undefined`.

Callers:
- `runBuild` early branch, `/Users/ruze/reg/my/forge/compose/lib/build.js:2249-2254`:

```js
  // Handle --abort early (featureCode may be null). C2: pass the project root so
  // the engine is resolved from this project's capabilities, not process.cwd().
  if (opts.abort) {
    await abortBuild(dataDir, featureCode, cwd);
    return;
  }
```

- HTTP route: `/Users/ruze/reg/my/forge/compose/server/build-routes.js:151`
  (`const result = await abortBuild(getDataDir(), featureCode, getTargetRoot());`),
  wired at `server/build-routes.js:18` and `:37`.
- CLI flags: `--abort` parsed at `/Users/ruze/reg/my/forge/compose/bin/compose.js:2672`
  (build), `:2886` (fix), `:3005` (plan). Plan-mode guard at `bin/compose.js:3063-3068`.

### `active-build.json` shape (lines 1455-1477)

```js
function activeBuildPath(dataDir) {
  return join(dataDir, 'active-build.json');
}

function readActiveBuild(dataDir) {
  const p = activeBuildPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeActiveBuild(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  // Always stamp PID so concurrent processes can detect each other
  state.pid = process.pid;
  const target = activeBuildPath(dataDir);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}
```

`writeActiveBuild` always stamps `state.pid = process.pid` and writes atomically
(tmp + rename).

The record is created in `startFresh` at lines 5570-5588 and **does store the flow
id** as `flowId`. There is no separate `runId` key; `flowId` IS the run id.

```js
  writeActiveBuild(dataDir, {
    featureCode,
    flowId: response.runId,
    pipeline: flowName,
    mode,
    pid: process.pid,
    currentStepId: response.ready?.[0]?.id,
    specPath: `pipelines/${templateName}.stratum.yaml`,
    stepNum: 1,
    totalSteps: null,
    retries: 0,
    violations: [],
    status: 'running',
    startedAt: new Date().toISOString(),
    implementerAgent,
    reviewerAgent,
  });
```

Mutators: `updateActiveBuildStep` (line 5593), `syncStepHistory` (line 5611),
`deleteActiveBuild` (line 1998), `persistHealthGateDowngrade` (line 1874).

Identity-guarded downgrade pattern that any new writer should copy
(lines 2939-2950):

```js
        try {
          const cur = readActiveBuild(dataDir);
          const sameFlow = !cur?.flowId || !response?.runId || cur.flowId === response.runId;
          const sameFeature = !cur?.featureCode || cur.featureCode === featureCode;
          if (cur && sameFlow && sameFeature) {
            writeActiveBuild(dataDir, { ...cur, status: 'aborted', completedAt: new Date().toISOString() });
          }
        } catch { /* best-effort cleanup */ }
```

---

## 4. `/Users/ruze/reg/my/forge/compose/lib/result-normalizer.js` — the in-process (isolation:none) agent

### The switch (line 424)

```js
  // Both local SDK and MCP executions own a cancellable handle. The MCP
  // client translates this signal to an acknowledged foreground cancellation.
  const useLocalClaude = opts.localExecution === true && cfg.provider === 'claude';
```

### The single cancellation handle (lines 433-434)

```js
  const abortController = new AbortController();
  const stopRun = () => abortController.abort();
```

`stopRun` is also invoked by the stuck detector at line 543.

### Both dispatch branches (lines 552-587)

```js
      if (useLocalClaude) {
        // Test seam: an installed factory shim exposes an SDK-shaped query adapter
        // so the goldens drive the local path without spawning a real claude.
        // Gated on NODE_ENV=test so production always uses the real SDK.
        const localQuery = opts.localQuery
          ?? (process.env.NODE_ENV === 'test' && stratum ? stratum._localQuery : undefined);
        runResult = await runLocalClaudeAgent(actualPrompt, {
          cwd:             opts.cwd ?? undefined,
          model:           cfg.modelID ?? undefined,
          allowedTools:    cfg.allowedTools ?? undefined,
          disallowedTools: cfg.disallowedTools ?? undefined,
          thinking:        cfg.thinking ?? undefined,
          effort:          cfg.effort ?? undefined,
          abortController,
          onToolUse:       localOnToolUse,
          ...(laneStamp.lane && streamWriter ? {
            onAssistantText: (text) => {
              streamWriter.write({ type: 'assistant', content: text, ...laneStamp });
            },
          } : {}),
          telemetry:       primaryTelemetry,
          ...(localQuery ? { query: localQuery } : {}),
        });
      } else {
        runResult = await stratum.agentRun(agentType, actualPrompt, {
          ...executionOptions,
          signal: abortController.signal,
          correlationId,
          telemetry:        primaryTelemetry,
        });
      }
```

A second MCP dispatch site (review repair) is at lines 747-749, with the same
`signal: abortController.signal`.

### `executionOptions` — the object a `flow` tag would ride on (lines 367-377)

```js
  const executionOptions = {
    modelID: cfg.modelID ?? undefined,
    ...(cfg.provider === 'claude' ? {
      allowedTools: cfg.allowedTools ?? undefined,
      disallowedTools: cfg.disallowedTools ?? undefined,
      thinking: cfg.thinking ?? undefined,
    } : {}),
    effort: cfg.effort ?? undefined,
    sandboxMode,
    cwd: opts.cwd ?? undefined,
  };
```

Correlation id, which already embeds the flow id, at line 400:

```js
  const correlationId = `${stepDispatch.flow_id ?? 'noflow'}:${stepId}:${randomUUID()}`;
```

So `stepDispatch.flow_id` is available inside `runAndNormalize` today.

### The local process handle

`runLocalClaudeAgent` lives at `/Users/ruze/reg/my/forge/compose/lib/local-claude-connector.js:126`
(imported at `lib/result-normalizer.js:16`). Under a controller on non-Windows it
installs a custom spawn hook giving the child its own process group and wraps it
in `processTermination`:

```js
  const platform = opts.platform ?? process.platform;
  const ownProcessGroup = Boolean(controller) && platform !== 'win32';
  const children = [];
  let stderr = '';
  const terminate = () => { for (const child of children) void child.terminate(); };
  controller?.signal.addEventListener('abort', terminate, { once: true });
```

```js
    ...(ownProcessGroup ? { spawnClaudeCodeProcess: (options) => {
      controller.signal.throwIfAborted();
      const child = spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const termination = processTermination(child, true, opts.cancellationGraceMs);
      children.push(termination);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
      const sdkAbort = () => { void termination.terminate(); };
      options.signal.addEventListener('abort', sdkAbort, { once: true });
      void termination.close.then(() => options.signal.removeEventListener('abort', sdkAbort));
      if (options.signal.aborted) sdkAbort();
      return { stdin: child.stdin, stdout: child.stdout, pid: child.pid,
        get killed() { return child.killed; }, get exitCode() { return child.exitCode; },
        kill: () => { void termination.terminate(); return true; },
        on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) };
    } } : {}),
    ...(opts.abortController ? { abortController: opts.abortController } : {}),
```

Final drain at `lib/local-claude-connector.js:337-342`.

**Relation to the MCP client: none.** These agents are spawned by the compose
process itself via the local Claude SDK. They never pass through
`stratum_agent_run`, so Stratum's server never sees them and cannot register or
kill them. The ONLY thing that can kill them is the compose-side
`AbortController` at `lib/result-normalizer.js:433`.

---

## 5. How a Stratum flow is started (foreground, compose-driven)

There is **no `lib/stratum-cli.js`**.

Compose builds run as **foreground consumer-dispatch flows: compose itself calls
`stratum_plan` / `stratum_step_done`.**

- `startFresh` at `/Users/ruze/reg/my/forge/compose/lib/build.js:5538` calls
  `stratum.plan(specYaml, flowName, planInputs, { workspaceRoot })` at line 5568.
- The run id is obtained as `response.runId` and persisted immediately as
  `flowId` in `active-build.json` (line 5572).
- Resume path: `stratum.resume` via `lib/build.js:2811-2819`, with
  `const flowId = response.runId ?? resumeFlowId;` at line 2849.
- It is re-stamped into the build context at line 3022 (`flowId: response.runId`)
  and into the stream at line 2971.
- The step loop runs at `lib/build.js:3334+` (`while (!isTerminalFlow(response.status))`),
  driving `stratum_step_done` itself.

**No call to `stratum_flow_run_bg`, `stratum_flow_poll`, `stratum_flow_bg_poll`,
or `stratum_flow_cancel_bg` exists anywhere in `lib/`.**

Connection resolution — every client spawns its own server subprocess:

`/Users/ruze/reg/my/forge/compose/lib/stratum-engine.js:248`

```js
export function resolveStratumMcpConnection(cwd, deps = {}) {
  resolveStratumEngine(cwd);
  return {
    command: (deps.env ?? process.env).COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [resolveStratumBin('mcp', cwd, deps)],
    ...(cwd ? { cwd } : {}),
  };
}
```

Used at `lib/build.js:2593` (the build's own connection) and `lib/build.js:5816`
(abortBuild's separate connection).

---

## 6. Existing tests covering abort / cancel

| File | What it pins |
|---|---|
| `/Users/ruze/reg/my/forge/compose/test/abort-build-engine.test.js` | `abortBuild` resolves the engine from the PROJECT ROOT that `dataDir` represents, not `process.cwd()`; a Python pin must fail before `connect`. Fake stratum exposes only `connect`/`audit`/`close` (lines 28-34). |
| `/Users/ruze/reg/my/forge/compose/test/review-fixes-runtime.test.js` | The version guard, plus the full cancellation matrix (late-usage, old surface, probe-hang, crash, not-found, ack-hang). |
| `/Users/ruze/reg/my/forge/compose/test/execution-runtime.test.js:158-184` | Second version-guard test against an "old server" advertising a reduced schema. |
| `/Users/ruze/reg/my/forge/compose/test/review-repair-control.test.js:110-140` | `stratum_cancel_agent_run` receives the cancellationId as `runId`; unknown status / transport error → `CANCELLATION_UNCONFIRMED`, hung agent → `CANCELLATION_TEARDOWN_TIMEOUT`. |
| `/Users/ruze/reg/my/forge/compose/test/stratum-mcp-client-parallel.test.js:331-343` | The `{runId}` wire shape; forbids python-era `correlation_id`. |
| `/Users/ruze/reg/my/forge/compose/test/build-routes.test.js:221-235` | `POST /api/build/abort` threads `(dataDir, featureCode, projectRoot)`. |
| `/Users/ruze/reg/my/forge/compose/test/integration/agent-run-streaming.test.js:76` | Stub server handles `stratum_cancel_agent_run`. |
| `/Users/ruze/reg/my/forge/compose/test/usage-receipts.test.js:238-263` | `listTools` is cached exactly once per connection. |

### The version-guard test hardcodes the tool schema fields

`/Users/ruze/reg/my/forge/compose/test/review-fixes-runtime.test.js:22-27` — the
fixture server advertises the field list literally:

```js
const server=new Server({name:'fixture-stratum',version:mode==='old'?'0.3.4':'0.4.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=> {
  if(mode==='probe-hang') return new Promise(()=>{});
  const fields=mode==='old'?['agent','prompt','cwd']:['agent','prompt','cwd','model','effort','sandboxMode','cancellationId','allowedTools','disallowedTools','thinking'];
  return {tools:[{name:'stratum_agent_run',inputSchema:{type:'object',properties:Object.fromEntries(fields.map(k=>[k,{}]))}}]};
});
```

Note the "modern" branch of that list does **not** contain `flow`.

The assertion, `test/review-fixes-runtime.test.js:68-77`:

```js
test('old surface accepts a basic call and names installed versus required surface only for requested controls', async t => {
  const {client, root} = await fixture(t, 'old');
  assert.equal((await client.agentRun('codex', 'basic', {cwd:root})).text, 'done');
  await assert.rejects(client.agentRun('claude', 'restricted', {cwd:root,allowedTools:[]}), error => {
    assert.equal(error.code, 'UNSUPPORTED_AGENT_OPTIONS');
    assert.match(error.message, /Installed Stratum 0.3.4.*allowedTools.*surface: 17.*0.4.0/);
    return true;
  });
  assert.equal((await readFile(join(root,'calls'),'utf8')).trim().split('\n').length, 1);
});
```

The second fixture, `/Users/ruze/reg/my/forge/compose/test/execution-runtime.test.js:161-166`:

```js
const server = new Server({name:'old-stratum',version:'0.3.3'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{
  name:'stratum_agent_run',inputSchema:{type:'object',properties:{
    agent:{type:'string'},prompt:{type:'string'},cwd:{type:'string'},model:{type:'string'},sandboxMode:{type:'string'}
  }}
}]}));
```

Both are load-bearing edit sites: once `buildAgentRunRequest` emits a `flow` key,
`flow` becomes a *requested* key and these fixtures start rejecting calls that
previously passed.

No test anywhere greps for `signalHandler` (it is not exported and not covered).

---

## 7. Versions and module resolution

| Site | Value |
|---|---|
| `/Users/ruze/reg/my/forge/compose/package.json` `version` | `0.4.2` |
| `/Users/ruze/reg/my/forge/compose/package.json` dep `@smartmemory/stratum` (line 91) | `^0.4.5` |
| `/Users/ruze/reg/my/forge/compose/compose-mcp/package.json` `version` (line 3) | `0.4.2` |
| `/Users/ruze/reg/my/forge/compose/compose-mcp/server.json` `version` (line 6) | `0.4.2` |
| `/Users/ruze/reg/my/forge/compose/compose-mcp/server.json` `packages[0].version` (line 11) | `0.4.2` |
| Resolved `@smartmemory/stratum` version on disk | **`0.5.0`** |

`ls -la node_modules/@smartmemory/`:

```
drwxr-xr-x    5 ruze  staff    160 Aug  6 08:20 sdk-js
lrwxr-xr-x@   1 ruze  staff     35 Sep  5 14:56 stratum -> /Users/ruze/reg/my/forge/stratum/ts
```

The stratum entry is a **symlink to the sibling checkout** (the documented local
dev setup); `sdk-js` is a real installed directory. So the declared range
`^0.4.5` and the resolved version `0.5.0` already disagree on disk.

There is also an `overrides` block pinning stratum's zod
(`/Users/ruze/reg/my/forge/compose/package.json:130-136`):

```json
  "overrides": {
    "zod": "^4.0.0",
    "@smartmemory/stratum": {
      "zod": "3.25.76"
    }
  }
```

### `/Users/ruze/reg/my/forge/compose/test/version-sync.test.js`

Four assertions:

1. `compose-mcp` `package.json` version **equals** compose's exactly (line 32).
2. `server.json` top-level and `packages[0].version` agree with its `package.json` (line 40).
3. `compose-mcp` depends on `^<compose version>` exactly (line 47).
4. **compose and the stratum dep share a MINOR** (lines 54-63):

```js
test('VERSION-SYNC: compose and stratum share a minor', () => {
  const range = composePkg.dependencies['@smartmemory/stratum']
  assert.equal(typeof range, 'string', 'compose must declare a @smartmemory/stratum dependency')
  const pinned = range.replace(/^[\^~>=<\s]+/, '')
  assert.equal(
    minorOf(pinned, 'the stratum dependency'), minorOf(composePkg.version, 'compose'),
    `compose ${composePkg.version} and stratum ${pinned} must share a minor — compose calls stratum's `
    + 'MCP surface directly, and a surface change lands as a stratum minor (.claude/rules/versioning.md)',
  )
})
```

Consequence: bumping the stratum dep to `^0.5.0` forces compose AND compose-mcp
to `0.5.x` in the same change — four version strings plus the dep range plus
compose-mcp's `^@smartmemory/compose` range.

---

## Reference: what Stratum 0.5.0 actually offers

`stratum_flow_cancel` is dispatched at
`/Users/ruze/reg/my/forge/stratum/ts/src/mcp/server.ts:282`. Request contract is
`{ runId: string }`; response envelopes (`cancelled` / `completed` / `failed` /
`budget_exhausted` / ...) all carry:

```json
{
  "runId": "string",
  "flowSettled": "boolean",
  "acknowledged": "boolean",
  "reason?": "string",
  "ledger": { "spent": "object", "budget?": "object" },
  "agents": {
    "signalled": "number", "reaped": "number", "gone": "number",
    "unreachable": "number", "alreadySettled": "number",
    "unresolved": "number", "unsettled": "number", "unreaped": "number"
  }
}
```

(from `/Users/ruze/reg/my/forge/stratum/ts/dist/contracts/mcp-surface.json`; the
surface version in that file is **19**, not 17.)

The `stratum_agent_run` request contract in the same file now includes the flow tag:

```json
{
 "agent": "string", "prompt": "string", "cwd": "string",
 "model?": "string", "sandboxMode?": "string", "background?": "boolean",
 "allowedTools?": {"$array": "string"}, "disallowedTools?": {"$array": "string"},
 "thinking?": "object", "effort?": "string", "cancellationId?": "string",
 "flow?": { "runId": "string", "stepId?": "string", "itemIndex?": "number" }
}
```

`inputSchema` published on `ListTools` is derived from that same contract
(`stratum/ts/src/mcp/server.ts:547`, `jsonSchema(definition.request)`), so
compose's `#agentFields` guard will see `flow` on 0.5.0 and not on 0.4.x.

Server-side rules that constrain the blueprint:

- `stratum/ts/src/mcp/server.ts:182-186` — `flow` **requires** `cancellationId`:
  `"flow requires a cancellationId: without a process group there is nothing to cancel"`.
- `stratum/ts/src/mcp/server.ts:200-222` — only a request carrying `flow` gets a
  foreground-registry record (`createForegroundRun`) and populates `foregroundFlows`.
- `stratum/ts/src/mcp/server.ts:326` — `ownProcessGroup: true` only when
  `cancellationId !== undefined`.
- `stratum/ts/src/mcp/server.ts:227-230` — `engine.admitFlowAgent(flow.runId)`
  refuses to spawn a new agent against an already-cancelled flow.
- `stratum/ts/src/mcp/server.ts:292-296` — `abortLocal` iterates only THIS
  server's in-memory `foreground` map, filtered by `foregroundFlows.get(id) === flowRunId`.
- `stratum/ts/src/engine/flow_cancel.ts:116-210` — settle first, then
  `signalFlowAgents` → `abortLocal` → `reapFlowAgents`, one shared deadline;
  `acknowledged` requires `unsettled === 0 && unresolved === 0 && unreachable === 0 && unreaped === 0`.
- `stratum/ts/src/engine/engine.ts:1115-1125` — `claimDriverLease` throws
  `CANCELLATION_UNCONFIRMED` / `reason: "engine_dispatch_active"` / `holderPid`
  when another live process holds the driver lease.
- `stratum/ts/src/mcp/server.ts:476-486` — those two codes surface as a
  `flow_cancel_unacknowledged` registry error carrying `code`, `runId`, status and
  agent summary.

---

## Surprises

Things that contradict "compose can simply call `stratum_flow_cancel` with the
active build's runId".

1. **`abortBuild` runs in a different process from the build, talking to a
   different engine instance.** It opens a brand-new Stratum MCP server
   (`lib/build.js:5815-5818`). `stratum_flow_cancel`'s `abortLocal` tears down
   only controllers held in THAT server's own `foreground` map
   (`stratum/ts/src/mcp/server.ts:292-296`). A fresh server holds none.
   Cross-process teardown works only through the on-disk foreground registry.

2. **Compose agent runs are not in that registry.** Stratum writes a registry
   entry only when the request carries `flow`
   (`stratum/ts/src/mcp/server.ts:200-222`), and sets `ownProcessGroup: true`
   only when `cancellationId` is present (line 326). Compose sends neither today.
   Calling `stratum_flow_cancel` with the active build's `flowId` right now would
   settle the flow record and return an all-zero `agents` summary while every
   agent keeps running. **Flow-tagging is a prerequisite, not an enhancement.**

3. **`flow` requires `cancellationId`, and compose only mints one when a signal is
   passed.** `stratum/ts/src/mcp/server.ts:182-186` throws otherwise. Compose
   mints one only under `opts.signal` (`lib/stratum-mcp-client.js:272`). Consumer
   dispatch always passes a signal, but `runAgentText` (gate askAgent) and any
   other signal-less path do not. Either start minting unconditionally or do not
   set `flow` on those paths.

4. **`isolation: none` agents are invisible to Stratum entirely.** They are
   spawned by the compose process via the local Claude SDK
   (`lib/local-claude-connector.js:156-174`), never through `stratum_agent_run`.
   No flow tag can reach them and `stratum_flow_cancel` will never kill them. They
   need the compose-side `AbortController` (`lib/result-normalizer.js:433`), which
   today has no route from `abortBuild` — it is function-local to a single
   `runAndNormalize` call.

5. **A live driver lease can refuse the cancel outright.** `engine.flowCancel`
   calls `claimDriverLease`, which throws `CANCELLATION_UNCONFIRMED` with
   `reason: "engine_dispatch_active"` and a `holderPid`
   (`stratum/ts/src/engine/engine.ts:1115-1125`, called at 1180). The lease is
   written by `prepareLease` on background flow start and on **resume**
   (`engine.ts:625, 704, 1036`). A compose build that resumed holds one through
   its own server process, so an out-of-process abort can be refused outright.

6. **The version guard fires on the new key, and its message is wrong for the new
   floor.** Adding `flow` to the request makes any server below 0.5.0 reject the
   call with text naming `surface: 17` and `>=0.4.0`
   (`lib/stratum-mcp-client.js:286-288`). The installed contract is surface **19**.
   The string and BOTH fixture schemas
   (`test/review-fixes-runtime.test.js:25`, `test/execution-runtime.test.js:163`)
   must move together, or previously-passing calls start failing in tests.

7. **The signal handler does almost nothing.** `lib/build.js:2976-2979` sets
   `buildStatus = 'killed'` and closes the stream. Ctrl-C on a running build
   leaves `active-build.json` untouched, kills no agent, and cancels no flow.
   There is no existing teardown sequence to extend — any SIGINT-driven flow
   cancel is new code, not a modification. It is also untested.

8. **`abortBuild` swallows every engine error indiscriminately.** The
   `try { connect; audit } catch {}` at `lib/build.js:5817-5827` has no code
   filter at all. A flow-cancel added inside that block would silently discard
   `CANCELLATION_UNCONFIRMED` / `CANCELLATION_TEARDOWN_TIMEOUT` /
   `flow_cancel_unacknowledged` and still print "Build aborted."

9. **`stratum_flow_cancel` returns a rich ack that compose has nowhere to put.**
   Five status envelopes, each with `flowSettled`, `acknowledged`, `reason`,
   `ledger`, and an eight-field `agents` summary. `abortBuild` returns
   `undefined` today and prints two console lines; the HTTP route at
   `server/build-routes.js:151` forwards whatever it returns.

10. **The in-process build and the aborting process both write
    `active-build.json` last-writer-wins.** The identity-guarded downgrade pattern
    exists at `lib/build.js:2939-2950` but `abortBuild` does not use it — it does
    a plain `writeActiveBuild(dataDir, { ...active, status: 'aborted' })` at line
    5838, which also re-stamps `pid` to the ABORTING process's pid (line 1472),
    destroying the record of which process was driving the build.
