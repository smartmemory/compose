/**
 * local-claude-connector.js — V2/V3 (STRAT-TS-FANOUT-CONSUMER).
 *
 * The TS `stratum_agent_run` surface is a SYNCHRONOUS black box: it returns no
 * runId (no pre-completion cancel handle), streams no progress notifications,
 * and its `sandboxMode` binds only the codex connector. The engine's background
 * agent mode (surface 8) is codex-only AND read-only-only. So there is NO engine
 * seam that can, for a CLAUDE agent:
 *   - enforce tool restrictions (V3 — a read-only review fanout must not Edit/
 *     Write/Bash in the target workspace), or
 *   - be interrupted mid-run (V2 — per-item timeout / stuck / user interrupt).
 *
 * Compose owns consumer/review execution by design, and already depends on
 * `@anthropic-ai/claude-agent-sdk`, so CONTROLLED claude executions run here.
 * The connector enforces allowedTools/disallowedTools, aborts via an
 * AbortController, streams tool_use events (for the stuck detector + narration),
 * and reports usage. The SDK `query` is injectable for tests.
 */

import { routingIntegrityError } from './routing-runtime.js';
import { spawn } from 'node:child_process';
import { processTermination } from './process-termination.js';
import { randomUUID } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { appendEvent, resolveDispatchLedgerCwd } from './dispatch-ledger.js';

const SENSITIVE_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_API_KEY', 'CLAUDECODE'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonneg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function reportedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function reportedString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isBlockedDispatch(value) {
  const candidates = [value?.status, value?.outcome, value?.code, value?.subtype];
  return candidates.some((candidate) => {
    const normalized = typeof candidate === 'string' ? candidate.toLowerCase() : '';
    return normalized === 'blocked'
      || normalized === 'budget_exhausted'
      || normalized === 'budget-exhausted';
  });
}

function providerFailureClass(value) {
  const status = value?.status ?? value?.status_code ?? value?.statusCode
    ?? value?.error?.status ?? value?.error?.status_code;
  const code = [value?.code, value?.error?.code, value?.error?.type]
    .filter(candidate => typeof candidate === 'string')
    .join(' ')
    .toLowerCase();
  const text = [
    value?.message,
    value?.error?.message,
    ...(Array.isArray(value?.errors) ? value.errors : []),
  ].filter(candidate => typeof candidate === 'string').join(' ').toLowerCase();

  if (
    code.includes('context_length_exceeded')
    || code.includes('prompt_too_long')
    || /prompt (?:is )?too long/.test(text)
    || /maximum context length/.test(text)
    || /(?:prompt|input).*(?:exceeds|exceeded).*(?:context|token|limit)/.test(text)
  ) return 'prompt-too-long';

  if (
    Number(status) === 429
    || code.includes('rate_limit')
    || /\b429\b/.test(text)
    || /rate[ -]?limit(?:ed| exceeded)?/.test(text)
    || /too many requests/.test(text)
  ) return 'rate-limited';

  return 'other';
}

function providerRetryAfterMs(value) {
  for (const candidate of [
    value?.retry_after_ms,
    value?.retryAfterMs,
    value?.error?.retry_after_ms,
    value?.error?.retryAfterMs,
  ]) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
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
    // Capture metadata must never replace the SDK's original behavior.
  }
}

function recordDispatch(dispatchId, context, capture, outcome, elapsedMs, effortExecuted) {
  try {
    const usd = reportedNumber(capture.costUsd);
    const event = {
      kind: 'dispatch',
      dispatch_id: dispatchId,
      site: reportedString(context.site) ?? 'unattributed',
      agent: 'claude',
      outcome,
      model: reportedString(capture.model),
      effort_intended: reportedString(context.effort_intended),
      // Executed effort is only recorded once a model run is confirmed — the SDK
      // emitted a model identity (init or result). A transport/startup failure
      // before any model spoke leaves effort_executed null, so the executed-effort
      // curve is not polluted by tiers that were requested but never actually ran
      // (mirrors the codex route, whose effort_executed comes from run telemetry).
      effort_executed: capture.model ? reportedString(effortExecuted) : null,
      tokens_in: reportedNumber(capture.inputTokens),
      tokens_out: reportedNumber(capture.outputTokens),
      tokens_total: capture.inputTokens !== null || capture.outputTokens !== null
        ? (reportedNumber(capture.inputTokens) ?? 0) + (reportedNumber(capture.outputTokens) ?? 0)
        : null,
      usd,
      ...(usd !== null ? { usd_source: 'reported' } : {}),
      duration_ms: reportedNumber(capture.durationMs) ?? reportedNumber(elapsedMs),
    };
    for (const [field, value] of [
      ['build_id', context.build_id],
      ['feature_code', context.feature_code],
      ['step_id', context.step_id],
    ]) {
      if (reportedString(value) !== null) event[field] = value;
    }
    if (typeof context.attempt === 'number' && Number.isFinite(context.attempt)) {
      event.attempt = context.attempt;
    }
    appendEvent(resolveDispatchLedgerCwd(context.project_cwd), event);
  } catch {
    // Dispatch capture is fail-open by contract.
  }
}

/**
 * Run a controlled claude agent locally.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string}   [opts.cwd]
 * @param {string}   [opts.model]
 * @param {string[]} [opts.allowedTools]     enforced tool allowlist (read-only review)
 * @param {string[]} [opts.disallowedTools]
 * @param {object}   [opts.thinking]
 * @param {string}   [opts.effort]           reasoning-effort tier (low|medium|high|xhigh|max)
 * @param {AbortController} [opts.abortController]  abort → interrupt the run
 * @param {(ev:{tool:string,input:object})=>void} [opts.onToolUse]  per tool_use block
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {Function} [opts.query]            SDK `query` seam for tests
 * @param {object} [opts.telemetry]           Compose-only dispatch context
 * @returns {Promise<{text:string, usage:object, telemetry:object}>}
 */
export async function runLocalClaudeAgent(prompt, opts = {}) {
  const query = opts.query ?? sdkQuery;
  const controller = opts.abortController;
  controller?.signal.throwIfAborted();
  // C2: group cancellation needs POSIX process groups. Windows has none, so
  // instead of refusing the run (which killed EVERY local dispatch there,
  // cancellable or not) we skip the custom spawn hook and let the SDK's own
  // abortController tear the run down. That is weaker — the SDK kills only the
  // CLI leader, so grandchildren can outlive a cancel — but a non-cancel run
  // must never fail before spawn.
  const platform = opts.platform ?? process.platform;
  const ownProcessGroup = Boolean(controller) && platform !== 'win32';
  const children = [];
  let stderr = '';
  const terminate = () => { for (const child of children) void child.terminate(); };
  controller?.signal.addEventListener('abort', terminate, { once: true });
  const { telemetry } = opts;
  const telemetryContext = telemetry && typeof telemetry === 'object'
    ? telemetry
    : {};
  const env = { ...(opts.env ?? process.env) };
  for (const key of SENSITIVE_ENV_VARS) delete env[key];

  // Only forward a non-empty effort so routes without a configured tier keep the
  // SDK's default behavior; the applied value is what we record as effort_executed.
  const appliedEffort = reportedString(opts.effort);
  const sdkOptions = {
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? process.env.CLAUDE_MODEL ?? 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    // SDK 0.3 loads user/project/local settings when this is omitted. Compose
    // owns the controlled execution policy, so preserve the 0.2 isolation
    // behavior instead of allowing filesystem settings to add hooks, tools,
    // permissions, or environment overrides behind the connector's back.
    settingSources: [],
    env,
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
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    ...(appliedEffort !== null ? { effort: appliedEffort } : {}),
  };
  // A read-only profile passes an explicit allowlist; without one, the agent
  // gets the full claude_code preset (unrestricted).
  if (opts.allowedTools !== undefined) {
    // `allowedTools` only auto-allows-without-prompting; on its own the agent
    // still HAS every tool (minus the denylist) under permissionMode
    // 'acceptEdits'. To actually restrict AVAILABILITY (a read-only reviewer must
    // not be able to Edit/Write/Bash), the SDK requires `tools` set to the
    // specific tool names. Set both: `tools` binds availability, `allowedTools`
    // suppresses the prompt for those same tools.
    sdkOptions.tools = [...opts.allowedTools];
    sdkOptions.allowedTools = opts.allowedTools;
    if (opts.disallowedTools !== undefined) sdkOptions.disallowedTools = opts.disallowedTools;
  } else {
    sdkOptions.tools = { type: 'preset', preset: 'claude_code' };
    if (opts.disallowedTools !== undefined) sdkOptions.disallowedTools = opts.disallowedTools;
  }

  const startedAt = Date.now();
  let resolvedModel = sdkOptions.model;
  let finalText;
  let assistantText = '';
  let durationMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = null;
  const capture = {
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    durationMs: null,
  };
  let resultError = null;
  let resultFailureOutcome = null;
  const dispatchId = randomUUID();
  const dispatchStartedAt = Date.now();
  const intent = opts.routingCalls?.begin({ callId: dispatchId, transport: 'local-sdk', provider: 'claude', model: sdkOptions.model, effort: appliedEffort });

  try {
    for await (const raw of query({ prompt, options: sdkOptions })) {
      if (!isRecord(raw)) continue;
      if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.model === 'string') {
        resolvedModel = raw.model;
        capture.model = raw.model;
      }
      if (raw.type === 'assistant' && isRecord(raw.message) && Array.isArray(raw.message.content)) {
        for (const block of raw.message.content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
            // COMP-AGENT-LANES: optional live-relay seam, mirroring onToolUse.
            // Without a subscriber the text only accumulates (historical shape).
            if (typeof opts.onAssistantText === 'function') opts.onAssistantText(block.text);
          }
          if (block.type === 'tool_use' && typeof block.name === 'string' && typeof opts.onToolUse === 'function') {
            opts.onToolUse({ tool: block.name, input: isRecord(block.input) ? block.input : {} });
          }
        }
      }
      if (raw.type !== 'result') continue;
      durationMs = nonneg(raw.duration_ms);
      capture.durationMs = reportedNumber(raw.duration_ms);
      capture.costUsd = reportedNumber(raw.total_cost_usd);
      if (reportedString(raw.model) !== null) capture.model = raw.model;
      if (isRecord(raw.usage)) {
        capture.inputTokens = reportedNumber(raw.usage.input_tokens);
        capture.outputTokens = reportedNumber(raw.usage.output_tokens);
        capture.model = reportedString(raw.usage.model) ?? capture.model;
      }
      if (raw.subtype !== 'success') {
        // F3: a failed run still consumed billable tokens/cost. Capture them from
        // the error result (SDKResultError carries usage + total_cost_usd) and
        // attach to the thrown Error — same usage shape as the success return — so
        // the consumer failure path can debit the engine/GSD ledgers. Without this,
        // repeated failures evade budget exhaustion.
        const failCost = reportedNumber(raw.total_cost_usd);
        const failIn = isRecord(raw.usage) ? nonneg(raw.usage.input_tokens) : 0;
        const failOut = isRecord(raw.usage) ? nonneg(raw.usage.output_tokens) : 0;
        const errors = Array.isArray(raw.errors) ? raw.errors.filter((v) => typeof v === 'string') : [];
        const err = new Error(errors.join('; ') || `claude query failed: ${String(raw.subtype)}`);
        err.providerFailureClass = providerFailureClass(raw);
        const retryAfterMs = providerRetryAfterMs(raw);
        if (retryAfterMs !== null) err.providerRetryAfterMs = retryAfterMs;
        err.usage = {
          input_tokens: failIn,
          output_tokens: failOut,
          tokens: failIn + failOut,
          cost_usd: failCost,
          usd: failCost,
          ...(failCost !== null ? { usd_source: 'reported' } : {}),
          duration_ms: durationMs,
          ms: durationMs,
          model: resolvedModel,
        };
        err.costUsd = failCost;
        resultError = err;
        resultFailureOutcome = isBlockedDispatch(raw) ? 'blocked' : 'error';
        throw err;
      }
      if (typeof raw.result === 'string') finalText = raw.result;
      costUsd = reportedNumber(raw.total_cost_usd);
      if (isRecord(raw.usage)) {
        inputTokens = nonneg(raw.usage.input_tokens);
        outputTokens = nonneg(raw.usage.output_tokens);
      }
    }

    // H2: do NOT throwIfAborted() here. A run that RESOLVES after its
    // timeout/abort fired still reported billable usage, and the caller
    // (result-normalizer's late-resolve branch) is the single place that turns
    // that into AgentTimeoutError/AgentAbortedError/UserInterruptError with the
    // usage attached. Throwing a bare AbortError here loses the usage and the
    // attempt is never billed.
    const result = {
      text: finalText ?? assistantText,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens: inputTokens + outputTokens,
        cost_usd: costUsd,
        usd: costUsd,
        ...(costUsd !== null ? { usd_source: 'reported' } : {}),
        duration_ms: durationMs,
        ms: durationMs,
        model: resolvedModel,
      },
      telemetry: { durationMs, model: resolvedModel },
    };
    recordDispatch(
      dispatchId,
      telemetryContext,
      capture,
      'ok',
      Date.now() - dispatchStartedAt,
      appliedEffort,
    );
    attachDispatchId(result, dispatchId);
    if (intent) await opts.routingCalls.finish(intent, { value: result, localCapture: capture });
    return result;
  } catch (error) {
    if (intent && routingIntegrityError(error)) throw error;
    if (error !== resultError && error && typeof error === 'object') {
      if (typeof error.providerFailureClass !== 'string') {
        error.providerFailureClass = providerFailureClass(error);
      }
      const retryAfterMs = providerRetryAfterMs(error);
      if (!Number.isFinite(error.providerRetryAfterMs) && retryAfterMs !== null) {
        error.providerRetryAfterMs = retryAfterMs;
      }
      const errorUsage = isRecord(error.usage) ? error.usage : {};
      const errorTelemetry = isRecord(error.telemetry) ? error.telemetry : {};
      capture.model = reportedString(errorTelemetry.model)
        ?? reportedString(errorUsage.model)
        ?? capture.model;
      capture.inputTokens = reportedNumber(errorUsage.input_tokens) ?? capture.inputTokens;
      capture.outputTokens = reportedNumber(errorUsage.output_tokens) ?? capture.outputTokens;
      capture.costUsd = reportedNumber(errorUsage.cost_usd)
        ?? reportedNumber(errorUsage.usd)
        ?? capture.costUsd;
      capture.durationMs = reportedNumber(errorUsage.duration_ms)
        ?? reportedNumber(errorUsage.ms)
        ?? reportedNumber(errorTelemetry.durationMs)
        ?? capture.durationMs;
    }
    recordDispatch(
      dispatchId,
      telemetryContext,
      capture,
      resultFailureOutcome ?? (isBlockedDispatch(error) ? 'blocked' : 'error'),
      Date.now() - dispatchStartedAt,
      appliedEffort,
    );
    attachDispatchId(error, dispatchId);
    if (controller?.signal.aborted) { terminate(); await Promise.all(children.map(child => child.finish())); }
    if (intent) await opts.routingCalls.finish(intent, { value: error, failed: true, localCapture: capture,
      returned: !['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(error?.code) });
    if (stderr) { error.stderr = stderr; error.cause ??= new Error(stderr.trim()); }
    throw error;
  } finally {
    controller?.signal.removeEventListener('abort', terminate);
    if (controller?.signal.aborted) terminate();
    await Promise.all(children.map(child => child.finish()));
  }
}
