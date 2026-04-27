/**
 * Result Normalizer — bridges connector text streams to structured step results
 * for the headless build runner.
 *
 * Converts flat Stratum output_fields to JSON Schema, runs a connector,
 * accumulates text, and extracts structured JSON from the response.
 */

import { randomUUID } from 'node:crypto';
import { injectSchema } from './inject-schema.js';
import { CliProgress } from './cli-progress.js';
import { calculateCost } from './model-pricing.js';
import { resolveAgentConfig } from './agent-string.js';
import { normalizeReviewResult } from './review-normalize.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class ResultParseError extends Error {
  /**
   * @param {string} message
   * @param {string} rawText  The raw connector output that could not be parsed
   */
  constructor(message, rawText) {
    super(message);
    this.name = 'ResultParseError';
    this.rawText = rawText;
  }
}

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
}

export class UserInterruptError extends Error {
  /** @param {string} stepId @param {'skip'|'retry'} action */
  constructor(stepId, action) {
    super(`User requested ${action} for step "${stepId}"`);
    this.name = 'UserInterruptError';
    this.stepId = stepId;
    this.action = action;
  }
}

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

/** Map from Stratum flat type names to JSON Schema property descriptors. */
const TYPE_MAP = {
  string:  { type: 'string' },
  boolean: { type: 'boolean' },
  integer: { type: 'integer' },
  number:  { type: 'number' },
  array:   { type: 'array' },
  object:  { type: 'object' },
};

/**
 * Convert Stratum's flat output_fields type map to a JSON Schema object.
 *
 * @param {Record<string, string>} outputFields  e.g. { "clean": "boolean", "findings": "array" }
 * @returns {object} A JSON Schema object with type, required, and properties.
 */
export function outputFieldsToJsonSchema(outputFields) {
  const properties = {};
  const required = Object.keys(outputFields);

  for (const [key, typeStr] of Object.entries(outputFields)) {
    const lower = typeStr.toLowerCase();
    properties[key] = TYPE_MAP[lower] ?? {}; // any/unknown → unconstrained
  }

  return {
    type: 'object',
    required,
    properties,
  };
}

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON object from text using multiple strategies.
 *
 * @param {string} text
 * @returns {object|null} Parsed JSON or null if all strategies fail.
 */
function extractJson(text) {
  // Strategy A: full text is valid JSON
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Strategy B: fenced ```json ... ``` block
  const fenceMatch = text.match(/```json\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* continue */ }
  }

  // Strategy C: first balanced { ... } substring
  const startIdx = text.indexOf('{');
  if (startIdx !== -1) {
    let depth = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(startIdx, i + 1));
        } catch { /* continue */ }
        break;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a connector and normalize its output to a structured result.
 *
 * @param {object} connector         Object with a run(prompt, opts) async generator method.
 * @param {string} prompt            The prompt to send to the connector.
 * @param {object} stepDispatch      Step dispatch descriptor.
 * @param {Record<string, string>} [stepDispatch.output_fields]  Expected output fields.
 * @param {object} [opts]
 * @param {CliProgress} [opts.progress]  CLI progress renderer.
 * @returns {Promise<{ text: string, result: object|null }>}
 */
export class AgentTimeoutError extends Error {
  constructor(stepId, durationMs) {
    super(`Agent timed out on step "${stepId}" after ${Math.round(durationMs / 1000)}s`);
    this.name = 'AgentTimeoutError';
    this.stepId = stepId;
    this.durationMs = durationMs;
  }
}

/**
 * STRAT-DEDUP-AGENTRUN-V3: `runAndNormalize` is now a thin wrapper around the
 * Python connector tier exposed through `stratum_agent_run`. Events arrive as
 * BuildStreamEvent envelopes via MCP progress notifications; we subscribe with
 * `stratum.onEvent(correlationId, '_agent_run', handler)` and translate the
 * envelopes back into the legacy stream-writer shape so downstream consumers
 * (build-stream-writer, cockpit) keep working unchanged.
 *
 * The first `connector` arg is intentionally ignored — kept only so the 18
 * call-sites do not all need to be edited in a single sweep. New required opt:
 * `opts.stratum` — the StratumMcpClient instance.
 */
export async function runAndNormalize(_connectorIgnored, prompt, stepDispatch, opts = {}) {
  const progress = opts.progress;
  const streamWriter = opts.streamWriter;
  const onToolUse = opts.onToolUse ?? null;
  const maxDurationMs = opts.maxDurationMs ?? null;
  const stratum = opts.stratum;

  if (!stratum || typeof stratum.agentRun !== 'function') {
    throw new AgentError(
      'runAndNormalize requires opts.stratum (a connected StratumMcpClient). ' +
      'Pass stratum: stratumClient at the call-site.'
    );
  }

  const stepId = stepDispatch.step_id ?? 'unknown';
  const agentType = stepDispatch.agent ?? 'claude';
  const cfg = resolveAgentConfig(agentType);

  const outputFields = stepDispatch.output_fields;
  const hasSchema = outputFields && typeof outputFields === 'object' && Object.keys(outputFields).length > 0;
  let actualPrompt = prompt;
  let schema = null;
  if (hasSchema) {
    schema = outputFieldsToJsonSchema(outputFields);
    actualPrompt = injectSchema(prompt, schema);
  }

  const correlationId = `${stepDispatch.flow_id ?? 'noflow'}:${stepId}:${randomUUID()}`;
  const subStepId = '_agent_run';
  const startTime = Date.now();

  const textParts = [];
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    model: null,
  };

  let timedOut = false;
  let userInterruptAction = null;
  let timeoutHandle = null;

  // Subscribe BEFORE calling agentRun — events fire during the call.
  const unsub = stratum.onEvent(correlationId, subStepId, (env) => {
    if (!env || env.schema_version !== '0.2.5') return;
    const m = env.metadata ?? {};
    switch (env.kind) {
      case 'agent_relay':
        if (m.role === 'assistant' && typeof m.text === 'string' && m.text.length > 0) {
          textParts.push(m.text);
          if (streamWriter) streamWriter.write({ type: 'assistant', content: m.text });
        }
        break;
      case 'tool_use_summary': {
        const tool = m.tool;
        if (tool) {
          if (streamWriter) {
            streamWriter.write({ type: 'tool_use', tool, input: m.input ?? {} });
          }
          if (onToolUse) onToolUse({ tool, input: m.input ?? {}, timestamp: Date.now() });
          if (progress) {
            const detail = m.input?.command ?? m.input?.pattern ?? m.input?.query ?? m.input?.file_path ?? '';
            progress.toolUse(tool, detail);
          }
        }
        if (m.summary) {
          if (streamWriter) {
            streamWriter.write({ type: 'tool_use_summary', summary: m.summary, output: m.output ?? '' });
          }
          if (progress) progress.toolSummary(m.summary);
        }
        break;
      }
      case 'step_usage': {
        const inTok  = m.input_tokens ?? 0;
        const outTok = m.output_tokens ?? 0;
        const ccit   = m.cache_creation_input_tokens ?? 0;
        const crit   = m.cache_read_input_tokens ?? 0;
        usageTotals.input_tokens               += inTok;
        usageTotals.output_tokens              += outTok;
        usageTotals.cache_creation_input_tokens += ccit;
        usageTotals.cache_read_input_tokens     += crit;
        if (m.model) usageTotals.model = m.model;
        const stepCost = m.cost_usd != null
          ? m.cost_usd
          : calculateCost(m.model, inTok, outTok, ccit, crit);
        usageTotals.cost_usd += stepCost;
        if (streamWriter) {
          streamWriter.write({
            type: 'usage',
            input_tokens: inTok,
            output_tokens: outTok,
            cache_creation_input_tokens: ccit,
            cache_read_input_tokens: crit,
            cost_usd: stepCost,
            model: m.model ?? null,
          });
        }
        break;
      }
      default:
        break;
    }
  });

  if (maxDurationMs) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      stratum.cancelAgentRun(correlationId).catch(() => {});
    }, maxDurationMs);
  }

  let onInterrupt = null;
  if (progress?.on) {
    onInterrupt = () => {
      userInterruptAction = progress.consumeAction?.() ?? 'skip';
      stratum.cancelAgentRun(correlationId).catch(() => {});
    };
    progress.on('interrupt', onInterrupt);
  }

  let runResult;
  try {
    runResult = await stratum.agentRun(agentType, actualPrompt, {
      modelID:          cfg.modelID ?? undefined,
      allowedTools:     cfg.allowedTools ?? undefined,
      disallowedTools:  cfg.disallowedTools ?? undefined,
      thinking:         cfg.thinking ?? undefined,
      effort:           cfg.effort ?? undefined,
      cwd:              opts.cwd ?? undefined,
      correlationId,
    });
  } catch (err) {
    if (timedOut) throw new AgentTimeoutError(stepId, Date.now() - startTime);
    if (userInterruptAction) throw new UserInterruptError(stepId, userInterruptAction);
    throw new AgentError(err?.message ?? 'Agent run failed');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (onInterrupt && progress?.removeListener) progress.removeListener('interrupt', onInterrupt);
    unsub();
  }

  if (timedOut) throw new AgentTimeoutError(stepId, Date.now() - startTime);
  if (userInterruptAction) throw new UserInterruptError(stepId, userInterruptAction);

  const text = (runResult && typeof runResult.text === 'string' && runResult.text.length > 0)
    ? runResult.text
    : textParts.join('');

  if (progress) {
    progress.debug(`normalizer: textParts=${textParts.length}, text length=${text.length}`);
    if (text.length > 0) progress.debug(`text preview: ${text.slice(0, 300)}`);
  } else if (process.env.COMPOSE_DEBUG) {
    process.stderr.write(`  [normalizer] textParts=${textParts.length}, text length=${text.length}\n`);
  }

  // review_mode hook — MUST be before the !hasSchema early return (MF-3 in blueprint).
  // Parallel lens steps often have empty output_fields (hasSchema=false), but review
  // normalization must still run. The Stratum server validates the post-normalize result
  // via `ensure` expressions after stratum_step_done — not against raw text.
  if (opts.reviewMode === true) {
    const reviewAgentType = agentType; // already resolved from stepDispatch.agent at line 178
    const reviewModelId = usageTotals.model ?? cfg.modelID ?? null;
    const repairFn = stratum
      ? async (repairPrompt) => {
          const repairResult = await stratum.agentRun(reviewAgentType, repairPrompt, {
            modelID: cfg.modelID ?? undefined,
            cwd: opts.cwd ?? undefined,
          });
          return repairResult?.text ?? '';
        }
      : undefined;
    const reviewResult = await normalizeReviewResult(text, {
      agentType: reviewAgentType,
      modelId: reviewModelId,
      confidenceGate: opts.confidenceGate ?? 7,
      lens: opts.lens ?? 'general',
      repairFn,
    });
    return { text, result: reviewResult, usage: usageTotals };
  }

  if (!hasSchema) {
    return { text, result: null, usage: usageTotals };
  }

  const result = extractJson(text);
  if (result === null) {
    if (progress) {
      progress.warn('Could not extract JSON from agent output, using fallback');
    } else {
      process.stderr.write('    ⚠ Could not extract JSON from agent output, using fallback\n');
    }
    const summary = text.slice(0, 200).replace(/\n/g, ' ').trim();
    return { text, result: { summary: summary || 'Step complete' }, usage: usageTotals };
  }

  return { text, result, usage: usageTotals };
}
