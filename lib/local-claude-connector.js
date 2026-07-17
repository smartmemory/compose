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

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

const SENSITIVE_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_API_KEY', 'CLAUDECODE'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonneg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
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
 * @param {AbortController} [opts.abortController]  abort → interrupt the run
 * @param {(ev:{tool:string,input:object})=>void} [opts.onToolUse]  per tool_use block
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {Function} [opts.query]            SDK `query` seam for tests
 * @returns {Promise<{text:string, usage:object, telemetry:object}>}
 */
export async function runLocalClaudeAgent(prompt, opts = {}) {
  const query = opts.query ?? sdkQuery;
  const env = { ...(opts.env ?? process.env) };
  for (const key of SENSITIVE_ENV_VARS) delete env[key];

  const sdkOptions = {
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    permissionMode: 'acceptEdits',
    env,
    ...(opts.abortController ? { abortController: opts.abortController } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
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
  let costUsd = 0;

  for await (const raw of query({ prompt, options: sdkOptions })) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.model === 'string') {
      resolvedModel = raw.model;
    }
    if (raw.type === 'assistant' && isRecord(raw.message) && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') assistantText += block.text;
        if (block.type === 'tool_use' && typeof block.name === 'string' && typeof opts.onToolUse === 'function') {
          opts.onToolUse({ tool: block.name, input: isRecord(block.input) ? block.input : {} });
        }
      }
    }
    if (raw.type !== 'result') continue;
    durationMs = nonneg(raw.duration_ms);
    if (raw.subtype !== 'success') {
      // F3: a failed run still consumed billable tokens/cost. Capture them from
      // the error result (SDKResultError carries usage + total_cost_usd) and
      // attach to the thrown Error — same usage shape as the success return — so
      // the consumer failure path can debit the engine/GSD ledgers. Without this,
      // repeated failures evade budget exhaustion.
      const failCost = nonneg(raw.total_cost_usd);
      const failIn = isRecord(raw.usage) ? nonneg(raw.usage.input_tokens) : 0;
      const failOut = isRecord(raw.usage) ? nonneg(raw.usage.output_tokens) : 0;
      const errors = Array.isArray(raw.errors) ? raw.errors.filter((v) => typeof v === 'string') : [];
      const err = new Error(errors.join('; ') || `claude query failed: ${String(raw.subtype)}`);
      err.usage = {
        input_tokens: failIn,
        output_tokens: failOut,
        tokens: failIn + failOut,
        cost_usd: failCost,
        usd: failCost,
        duration_ms: durationMs,
        ms: durationMs,
        model: resolvedModel,
      };
      err.costUsd = failCost;
      throw err;
    }
    if (typeof raw.result === 'string') finalText = raw.result;
    costUsd = nonneg(raw.total_cost_usd);
    if (isRecord(raw.usage)) {
      inputTokens = nonneg(raw.usage.input_tokens);
      outputTokens = nonneg(raw.usage.output_tokens);
    }
  }

  return {
    text: finalText ?? assistantText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      tokens: inputTokens + outputTokens,
      cost_usd: costUsd,
      usd: costUsd,
      duration_ms: durationMs,
      ms: durationMs,
      model: resolvedModel,
    },
    telemetry: { durationMs, model: resolvedModel },
  };
}
