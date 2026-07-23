/**
 * stratum-mcp-client.js — MCP protocol client for the Stratum TS engine.
 *
 * Spawns the configured TS MCP entrypoint and communicates via the MCP SDK
 * over stdio. This is for the build runner's plan/step_done
 * loop — distinct from server/stratum-client.js which uses CLI subcommands.
 *
 * Usage:
 *   const client = new StratumMcpClient();
 *   await client.connect();
 *   const dispatch = await client.plan(specPath, 'build', { featureCode: 'FEAT-1' });
 *   const ready = dispatch.ready[0];
 *   const next = await client.stepDone(dispatch.runId, ready.id, { output: result }, ready.dispatchToken);
 *   await client.close();
 */

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import YAML from 'yaml';
import { validateBuildStreamEvent } from './build-stream-schema.js';
import { appendEvent } from './dispatch-ledger.js';
import { resolveStratumMcpConnection } from './stratum-engine.js';

const RUNTIME_INPUT_REF = /^\$\.input\.([A-Za-z_][A-Za-z0-9_]*)$/;

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonemptyStringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isBlockedDispatch(value) {
  const candidates = [
    value?.status,
    value?.outcome,
    value?.code,
    value?.error?.status,
    value?.error?.code,
  ];
  return candidates.some((candidate) => {
    const normalized = typeof candidate === 'string' ? candidate.toLowerCase() : '';
    return normalized === 'blocked'
      || normalized === 'budget_exhausted'
      || normalized === 'budget-exhausted';
  });
}

function attachDispatchId(value, dispatchId) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  try {
    Object.defineProperty(value, 'dispatchId', {
      configurable: true,
      enumerable: false,
      value: dispatchId,
    });
  } catch {
    // A frozen third-party value cannot carry metadata. Dispatch behavior still
    // wins over observability.
  }
}

/**
 * Resolve producer-owned authoring values that TS v1 deliberately requires to
 * be literals. Compose knows these values at plan time, so mutate a cloned spec
 * object before it crosses the MCP boundary instead of templating raw YAML.
 *
 * Only schema fields with literal-only v1 types are resolved here. Prompt/data
 * expressions remain engine-owned and are transmitted unchanged.
 *
 * @param {object} spec parsed Stratum specification
 * @param {object} inputs plan input envelope
 * @returns {object} a resolved clone; `spec` is never mutated
 */
export function resolvePlanSpecValues(spec, inputs = {}, runtimeProfiles = null) {
  const resolved = structuredClone(spec);
  const literalAgent = (value) => {
    if (typeof value !== 'string') return null;
    const provider = value.split(':', 1)[0];
    return ['claude', 'codex'].includes(provider) ? provider : null;
  };
  const inputValue = (value) => {
    if (typeof value !== 'string') return { matched: false, value };
    const match = RUNTIME_INPUT_REF.exec(value);
    return match ? { matched: true, value: inputs[match[1]] } : { matched: false, value };
  };
  // V4: the engine accepts only the bare provider literal, so a runtime agent
  // that carried a tier/template (e.g. --implementer=claude::critical) loses it
  // at resolution. Record the FULL stripped string, keyed by the enclosing step
  // id, so the invocation can recover the tier/capability profile compose-side.
  const recordProfile = (stepId, fullValue, literal) => {
    if (runtimeProfiles && typeof fullValue === 'string' && fullValue !== literal) {
      runtimeProfiles[stepId] = fullValue;
    }
  };

  for (const [flowName, flow] of Object.entries(resolved?.flows ?? {})) {
    if (flowName === 'entry' || !flow || typeof flow !== 'object') continue;
    for (const step of flow.steps ?? []) {
      const agent = inputValue(step.agent);
      if (agent.matched) {
        const literal = literalAgent(agent.value);
        if (!literal) {
          throw new TypeError(`runtime agent for step ${step.id} must resolve to claude or codex`);
        }
        recordProfile(step.id, agent.value, literal);
        step.agent = literal;
      }

      const fanout = step.fanout;
      if (!fanout || typeof fanout !== 'object') continue;
      const preMerge = inputValue(fanout.pre_merge);
      if (preMerge.matched) {
        if (preMerge.value === undefined) delete fanout.pre_merge;
        else if (!Array.isArray(preMerge.value) || preMerge.value.some((item) => typeof item !== 'string')) {
          throw new TypeError(`runtime pre_merge for fanout ${step.id} must resolve to a string array`);
        } else fanout.pre_merge = [...preMerge.value];
      }
      for (const stage of fanout.steps ?? []) {
        const stageAgent = inputValue(stage.agent);
        if (!stageAgent.matched) continue;
        const literal = literalAgent(stageAgent.value);
        if (!literal) {
          throw new TypeError(`runtime agent for fanout ${step.id} must resolve to claude or codex`);
        }
        // Keyed by the FANOUT step id — the consumer invocation looks up by
        // descriptor.step, not the inner stage.
        recordProfile(step.id, stageAgent.value, literal);
        stage.agent = literal;
      }
    }
  }
  return resolved;
}

/**
 * V4: resolve a step's agent profile from the merged runtime + static maps,
 * tolerating SCOPED ready ids. Ordinary subflow steps arrive with a scoped id
 * (e.g. `coverage_check/run_tests`) while the sidecar keys are the bare step id
 * (`run_tests`), so fall back to the last path segment. Returns undefined when
 * no profile applies (bare provider literal).
 */
export function resolveStepProfile(profiles, stepId) {
  if (!profiles || typeof profiles !== 'object' || !stepId) return undefined;
  if (profiles[stepId]) return profiles[stepId];
  const bare = String(stepId).split('/').pop();
  if (bare && profiles[bare]) return profiles[bare];
  return undefined;
}

/**
 * Build the TS `stratum_agent_run` request from an agent string + compose-side
 * options. The engine surface (contracts/mcp-surface.json) accepts only
 * {agent, prompt, cwd, model?, sandboxMode?, background?} and rejects any other
 * key, so the python-era knobs (allowed_tools/thinking/effort/correlation_id)
 * are NOT sent — they are compose-side concerns applied at the invocation
 * (resolveAgentConfig). `agent` is normalized to the bare provider literal the
 * engine requires; `cwd` is required and defaults to the process cwd.
 */
export function buildAgentRunRequest(agentType, prompt, opts = {}) {
  const provider = String(agentType ?? 'claude').split(':', 1)[0] || 'claude';
  return {
    agent: provider,
    prompt,
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.modelID ? { model: opts.modelID } : {}),
    ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
  };
}

export class StratumError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'StratumError';
    this.code = code;
    this.detail = detail;
  }
}

export class StratumMcpClient {
  #client = null;
  #transport = null;
  #connected = false;
  // STRAT-PAR-STREAM: subscribers keyed by `${flowId}::${stepId}` → Set<handler>
  #eventSubs = new Map();

  #recordAgentDispatch(dispatchId, agentType, opts, resultOrError, outcome, elapsedMs) {
    try {
      const context = opts.telemetry && typeof opts.telemetry === 'object'
        ? opts.telemetry
        : {};
      const returnedTelemetry = resultOrError?.telemetry
        && typeof resultOrError.telemetry === 'object'
        ? resultOrError.telemetry
        : {};
      const usage = resultOrError?.usage && typeof resultOrError.usage === 'object'
        ? resultOrError.usage
        : {};
      const effortIntended = Object.hasOwn(context, 'effort_intended')
        ? nonemptyStringOrNull(context.effort_intended)
        : nonemptyStringOrNull(opts.effort);
      const event = {
        kind: 'dispatch',
        dispatch_id: dispatchId,
        site: nonemptyStringOrNull(context.site) ?? 'unattributed',
        agent: String(agentType ?? 'claude').split(':', 1)[0] || 'claude',
        outcome,
        model: nonemptyStringOrNull(returnedTelemetry.model)
          ?? nonemptyStringOrNull(usage.model),
        effort_intended: effortIntended,
        effort_executed: nonemptyStringOrNull(returnedTelemetry.effort),
        tokens_in: null,
        tokens_out: null,
        tokens_total: finiteOrNull(usage.tokens),
        usd: finiteOrNull(usage.usd),
        duration_ms: finiteOrNull(usage.ms)
          ?? finiteOrNull(returnedTelemetry.durationMs)
          ?? finiteOrNull(elapsedMs),
      };
      for (const [field, value] of [
        ['build_id', context.build_id],
        ['feature_code', context.feature_code],
        ['step_id', context.step_id],
      ]) {
        if (nonemptyStringOrNull(value) !== null) event[field] = value;
      }
      if (finiteOrNull(context.attempt) !== null) event.attempt = context.attempt;
      appendEvent(context.project_cwd ?? process.cwd(), event);
    } catch {
      // Dispatch capture is fail-open by contract.
    }
  }

  async #dispatchAgentRun(agentType, prompt, opts, callOpts) {
    const dispatchId = randomUUID();
    const startedAt = Date.now();
    try {
      const result = await this.#callTool(
        'stratum_agent_run',
        buildAgentRunRequest(agentType, prompt, opts),
        callOpts,
      );
      this.#recordAgentDispatch(
        dispatchId,
        agentType,
        opts,
        result,
        isBlockedDispatch(result) ? 'blocked' : 'ok',
        Date.now() - startedAt,
      );
      attachDispatchId(result, dispatchId);
      return result;
    } catch (error) {
      this.#recordAgentDispatch(
        dispatchId,
        agentType,
        opts,
        error,
        isBlockedDispatch(error) ? 'blocked' : 'error',
        Date.now() - startedAt,
      );
      attachDispatchId(error, dispatchId);
      throw error;
    }
  }

  /**
   * Subscribe to BuildStreamEvent push notifications scoped to a (flowId, stepId).
   * Handler receives a parsed BuildStreamEvent envelope. Returns an unsubscribe fn.
   *
   * Events arrive only while an agent tool call for that scope is in flight —
   * the underlying transport is MCP progress tied to an active request.
   *
   * @param {string} flowId
   * @param {string} stepId
   * @param {(event: object) => void} handler
   * @returns {() => void} unsubscribe
   */
  onEvent(flowId, stepId, handler) {
    const key = `${flowId}::${stepId}`;
    let set = this.#eventSubs.get(key);
    if (!set) {
      set = new Set();
      this.#eventSubs.set(key, set);
    }
    set.add(handler);
    return () => {
      const s = this.#eventSubs.get(key);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.#eventSubs.delete(key);
    };
  }

  /**
   * Internal: dispatch a parsed BuildStreamEvent to subscribers for its scope.
   * Errors in handlers are logged and swallowed — push delivery is best-effort.
   */
  #dispatchEvent(event) {
    if (!event || typeof event !== 'object') return;
    const { flow_id, step_id } = event;
    if (!flow_id || !step_id) return;
    const set = this.#eventSubs.get(`${flow_id}::${step_id}`);
    if (!set || set.size === 0) return;
    for (const h of set) {
      try { h(event); } catch (err) {
        console.error('[stratum-mcp-client] onEvent handler threw:', err);
      }
    }
  }

  /**
   * Build the onprogress callback for a tool call. Parses the
   * notification.message field as JSON and dispatches if it looks like a
   * BuildStreamEvent (schema_version + kind). Other progress payloads are
   * ignored.
   */
  #makeProgressHandler(callCorrelationId) {
    return (progress) => {
      const msg = progress?.message;
      if (typeof msg !== 'string' || msg.length === 0) return;
      let parsed;
      try { parsed = JSON.parse(msg); } catch { return; }
      // Discriminator: BuildStreamEvent has schema_version + kind + flow_id + step_id
      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.kind !== 'string') return;
      // The onprogress handler is bound to ONE tool call, so an envelope belongs
      // to this call iff its flow_id is either (a) ABSENT (undefined) — the TS
      // agent_run wire shape carries no correlation_id (see buildAgentRunRequest),
      // so stamp this call's id — or (b) already EQUAL to this call's correlation
      // id (python echo parity). V6/F7: any OTHER producer-set flow_id is a
      // misroute (one call's stream must never leak into another's subscriber) —
      // drop it. A present-but-falsy flow_id ('' / null / 0) is malformed, NOT
      // absent: it is dropped+warned, never laundered into a stamped valid event.
      if (callCorrelationId) {
        if (parsed.flow_id === undefined) {
          parsed.flow_id = callCorrelationId;
        } else if (parsed.flow_id !== callCorrelationId) {
          console.warn(
            `[stratum-mcp-client] dropping misrouted BuildStreamEvent:` +
            ` flow_id=${parsed.flow_id} does not match call ${callCorrelationId}`,
          );
          return;
        }
      }
      // STRAT-PAR-STREAM-CONSUMER-VALIDATE: validate envelope before forwarding.
      // On failure: warn and drop — never throw. Consumer must remain robust to
      // producer drift. Non-BuildStreamEvent payloads are silently ignored above.
      const validation = validateBuildStreamEvent(parsed);
      if (!validation.valid) {
        console.warn(
          `[stratum-mcp-client] dropping invalid BuildStreamEvent` +
          ` kind=${parsed.kind} schema_version=${parsed.schema_version}:`,
          validation.error
        );
        return;
      }
      this.#dispatchEvent(parsed);
    };
  }

  /**
   * Spawn the TS Stratum MCP server and establish a connection.
   * @param {object} [opts]
   * @param {string} [opts.command] - Override binary (for testing)
   * @param {string[]} [opts.args] - Override args
   * @param {string}   [opts.cwd]  - Working directory for the subprocess
   */
  async connect(opts = {}) {
    if (this.#connected) return;

    const defaults = resolveStratumMcpConnection(opts.cwd);
    const command = opts.command ?? defaults.command;
    const args = opts.args ?? defaults.args;

    const transportOpts = { command, args, stderr: 'pipe' };
    if (opts.cwd ?? defaults.cwd) transportOpts.cwd = opts.cwd ?? defaults.cwd;
    // Inherit the parent environment. Given no `env`, StdioClientTransport
    // supplies only the MCP SDK's 6-var default allowlist
    // (HOME/LOGNAME/PATH/SHELL/TERM/USER), which strips the auth context the
    // spawned Stratum TS MCP → claude agent needs. Once credentials moved
    // to the macOS keychain, that stripped env stopped authenticating and every
    // agent step failed with `403 forbidden / "Request not allowed"`. Pass the
    // full env through; the stratum connector scrubs SENSITIVE_ENV_VARS
    // (API keys, CLAUDECODE) before it spawns the agent.
    transportOpts.env = opts.env ?? { ...process.env };
    this.#transport = new StdioClientTransport(transportOpts);

    this.#client = new Client(
      { name: 'compose-build', version: '1.0.0' },
      { capabilities: {} }
    );

    await this.#client.connect(this.#transport);
    this.#connected = true;
  }

  /** Kill subprocess and clean up. */
  async close() {
    if (!this.#connected) return;
    try {
      await this.#client.close();
    } catch {
      // Ignore close errors — process may already be dead
    }
    this.#client = null;
    this.#transport = null;
    this.#connected = false;
  }

  /**
   * Call an MCP tool and return the parsed JSON result.
   * @param {string} toolName
   * @param {object} args
   * @param {object} [opts]
   * @param {boolean} [opts.subscribeProgress] - if true, attach onprogress to demux BuildStreamEvents
   * @returns {Promise<any>}
   */
  async #callTool(toolName, args, opts = {}) {
    // Allow test-injected client to bypass real connection requirement.
    // Gated on NODE_ENV=test so production code cannot accidentally redirect calls.
    const client = (process.env.NODE_ENV === 'test' && this._testClient) || null;
    if (!client && !this.#connected) {
      throw new Error('StratumMcpClient not connected. Call connect() first.');
    }

    const callArgs = { name: toolName, arguments: args };
    const requestOpts = {};
    if (opts.subscribeProgress) {
      // Long-running tool calls may stream events for many minutes.
      // Use generous timeouts and reset on each progress notification.
      requestOpts.onprogress = this.#makeProgressHandler(opts.correlationId);
      requestOpts.resetTimeoutOnProgress = true;
      requestOpts.timeout = 600_000; // 10 min per heartbeat
      requestOpts.maxTotalTimeout = 24 * 60 * 60 * 1000; // 24h hard cap
    }

    const result = await (client ?? this.#client).callTool(callArgs, undefined, requestOpts);

    // TS stratum returns the payload as native MCP structured content and also
    // mirrors it as JSON text. Prefer the native object, retaining text parsing
    // for servers that only provide the baseline MCP content array.
    const structuredContent = result.structuredContent;
    const hasStructuredContent = structuredContent
      && typeof structuredContent === 'object'
      && !Array.isArray(structuredContent);
    const textContent = result.content?.find(c => c.type === 'text');
    if (!hasStructuredContent && !textContent) {
      throw new StratumError('EMPTY_RESPONSE', `Tool ${toolName} returned no text content`, '');
    }

    // MCP isError flag indicates tool-level failure
    if (result.isError) {
      const message = textContent?.text ?? JSON.stringify(structuredContent);
      throw new StratumError('TOOL_ERROR', message, '');
    }

    let parsed = structuredContent;
    if (!hasStructuredContent) {
      try {
        parsed = JSON.parse(textContent.text);
      } catch {
        // Try to extract JSON from text that may have surrounding prose
        const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            throw new StratumError('PARSE_ERROR', `Tool ${toolName} returned invalid JSON`, textContent.text);
          }
        } else {
          throw new StratumError('PARSE_ERROR', `Tool ${toolName} returned invalid JSON`, textContent.text);
        }
      }
    }

    // Check for Stratum error envelope
    if (parsed.status === 'error' || parsed.error) {
      const err = parsed.error ?? parsed;
      throw new StratumError(
        err.code ?? 'STRATUM_ERROR',
        err.message ?? 'Stratum tool call failed',
        err.detail ?? ''
      );
    }

    return parsed;
  }

  /**
   * Start a flow. Returns the first step dispatch.
   * @param {string|object} spec - Parsed spec or inline YAML content
   * @param {string} flow - Flow name within the spec
   * @param {object} inputs - Flow input values
   * @returns {Promise<object>} Step dispatch response
   */
  async plan(spec, flow, inputs, opts = {}) {
    const parsedSpec = typeof spec === 'string' ? YAML.parse(spec) : spec;
    const resolvedSpec = resolvePlanSpecValues(parsedSpec, inputs);
    // D4: the engine jails file predicates (file_exists / file_contains in
    // ensures) to a workspace root and fails closed ("file function requires a
    // workspace root") without one. Pass the target repo so deterministic
    // artifact ensures on ordinary steps evaluate. Persisted on the run, so
    // resume needs no re-send.
    return this.#callTool('stratum_plan', {
      spec: resolvedSpec,
      input: inputs,
      ...(typeof opts.workspaceRoot === 'string' && opts.workspaceRoot.length > 0
        ? { workspaceRoot: opts.workspaceRoot }
        : {}),
    });
  }

  /**
   * Resume an in-progress flow. Returns the current step dispatch.
   * @param {string} flowId
   * @returns {Promise<object>} Step dispatch response (same format as plan/stepDone)
   */
  async resume(flowId) {
    return this.#callTool('stratum_resume', { runId: flowId });
  }

  /**
   * Report step completion. Returns next step dispatch or completion.
   * @param {string} flowId
   * @param {string} stepId
   * @param {object} result - Step result (must match output_contract)
   * @param {string} [dispatchToken] - Engine-issued ready-entry issuance token to echo
   * @returns {Promise<object>}
   */
  async stepDone(flowId, stepId, result, dispatchToken) {
    return this.#callTool('stratum_step_done', {
      runId: flowId,
      stepId,
      result,
      // Flag-day universal fencing: tokens are opaque and only non-empty strings
      // are transmitted. The strict TS schema rejects the retired epoch field.
      ...(typeof dispatchToken === 'string' && dispatchToken.length > 0 ? { dispatchToken } : {}),
    });
  }

  /**
   * Resolve a gate step.
   * @param {string} flowId
   * @param {string} stepId
   * @param {'approve'|'revise'|'kill'} outcome
   * @param {string} rationale
   * @param {'human'|'agent'|'system'} resolvedBy
   * @param {string} [gateToken] - Audit-discovered waiting-gate issuance token to echo
   * @returns {Promise<object>}
   */
  async gateResolve(flowId, stepId, outcome, rationale, resolvedBy = 'human', gateToken) {
    return this.#callTool('stratum_gate_resolve', {
      runId: flowId,
      stepId,
      decision: outcome,
      ...(typeof gateToken === 'string' && gateToken.length > 0 ? { gateToken } : {}),
    });
  }

  /**
   * Get the full execution trace.
   * @param {string} flowId
   * @returns {Promise<object>}
   */
  async audit(flowId) {
    return this.#callTool('stratum_audit', { runId: flowId });
  }

  /**
   * Validate a spec without executing.
   * @param {string} spec - Inline YAML spec content
   * @returns {Promise<{valid: boolean, errors?: string[]}>}
   */
  async validate(spec) {
    return this.#callTool('stratum_validate', { spec });
  }

  /**
   * Create a named checkpoint.
   * @param {string} flowId
   * @param {string} label
   * @returns {Promise<object>}
   */
  async commit(flowId, label) {
    return this.#callTool('stratum_commit', {
      flow_id: flowId,
      label,
    });
  }

  /**
   * Roll back to a checkpoint.
   * @param {string} flowId
   * @param {string} label
   * @returns {Promise<object>}
   */
  async revert(flowId, label) {
    return this.#callTool('stratum_revert', {
      flow_id: flowId,
      label,
    });
  }

  /**
   * Run an agent (claude/codex) via the Stratum connector tier and stream
   * BuildStreamEvent envelopes back via MCP progress notifications.
   * Subscribe via `onEvent(correlationId, '_agent_run', handler)` BEFORE calling.
   *
   * @param {string} agentType    'claude' | 'codex'
   * @param {string} prompt
   * @param {object} [opts]
   * @param {string}   [opts.correlationId]    Generated if absent.
   * @param {string}   [opts.modelID]          Override model.
   * @param {string[]} [opts.allowedTools]
   * @param {string[]} [opts.disallowedTools]
   * @param {object}   [opts.thinking]
   * @param {string}   [opts.effort]
   * @param {string}   [opts.cwd]
   * @returns {Promise<{text: string}>}
   *
   * NOTE: Schema injection is the caller's responsibility — `runAndNormalize`
   * runs `injectSchema(prompt, schema)` client-side. Forwarding `schema` to
   * the server would cause double-injection (producer also calls
   * inject_schema on its end). Schema is intentionally not forwarded here.
   */
  async agentRun(agentType, prompt, opts = {}) {
    const correlationId = opts.correlationId ?? randomUUID();
    // TS surface (contracts/mcp-surface.json → stratum_agent_run): the request
    // is {agent, prompt, cwd, model?, sandboxMode?, background?} and rejects any
    // undeclared key. The python-era tier accepted {type, allowed_tools, ...};
    // those knobs are resolved compose-side (resolveAgentConfig) and applied at
    // this seam — the engine's connector honors model + sandboxMode. `cwd` is
    // required, so default to the process cwd when the caller omits it.
    return this.#dispatchAgentRun(
      agentType,
      prompt,
      opts,
      { subscribeProgress: true, correlationId },
    );
  }

  /**
   * One-shot agent text call without progress streaming. Used for short Q&A
   * (gate askAgent path) where cockpit visibility is not needed.
   *
   * @param {string} agentType
   * @param {string} prompt
   * @param {object} [opts]
   * @param {string} [opts.cwd]
   * @returns {Promise<string>}
   */
  async runAgentText(agentType, prompt, opts = {}) {
    const result = await this.#dispatchAgentRun(
      agentType,
      prompt,
      opts,
      { subscribeProgress: false },
    );
    return result?.text ?? '';
  }

  /**
   * Cancel an in-flight agent run. V2: the TS surface
   * (contracts/mcp-surface.json → stratum_cancel_agent_run) takes {runId}, not
   * the python-era {correlation_id} the engine now rejects. Only BACKGROUND runs
   * carry a runId to cancel; a synchronous agent_run returns no handle, so this
   * is a no-op (not_found) there — synchronous controlled executions are
   * interrupted via the local connector's AbortController instead.
   *
   * @param {string} runId
   * @returns {Promise<object>}
   */
  async cancelAgentRun(runId) {
    return this.#callTool('stratum_cancel_agent_run', { runId });
  }
}
