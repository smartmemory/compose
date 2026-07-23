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
import { KNOWN_VERSIONS } from './build-stream-schema.js';
import { runLocalClaudeAgent } from './local-claude-connector.js';

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

/**
 * Build a nested JSON Schema from a consumer descriptor's contract CLOSURE
 * (`{ root, contracts }`), resolving the engine's type grammar so the agent-facing
 * schema — and thus the ENGINE's strict validation — see the same shapes:
 *   - `X?`          optional field (omitted from `required`)
 *   - `X[]`         typed array (recursively; nests as `X[][]`)
 *   - `(a|b)[]`     enum array
 *   - `a|b`         enum
 *   - `Name`        named record reference, resolved against the closure
 *   - primitives / `object` / `array` as before
 *
 * The flat `outputFieldsToJsonSchema` only mapped primitives, so a named record
 * (`Artifact`) or typed array (`Artifact[]`) degraded to `{}`, leaving the agent
 * blind to nested fields the engine still requires. Returns null for a malformed
 * closure so callers can fall back to the flat schema.
 */
export function contractClosureToJsonSchema(closure) {
  if (!closure || typeof closure !== 'object') return null;
  const { root, contracts } = closure;
  if (typeof root !== 'string' || !contracts || typeof contracts !== 'object') return null;
  if (!Object.hasOwn(contracts, root)) return null;

  function typeToSchema(typeStr, seen) {
    let raw = String(typeStr);
    let optional = false;
    if (raw.endsWith('?')) { optional = true; raw = raw.slice(0, -1); }

    const enumArray = /^\(([^()]+)\)\[\]$/.exec(raw);
    if (enumArray) {
      return { optional, schema: { type: 'array', items: { enum: enumArray[1].split('|') } } };
    }
    if (raw.endsWith('[]')) {
      return { optional, schema: { type: 'array', items: typeToSchema(raw.slice(0, -2), seen).schema } };
    }
    const lower = raw.toLowerCase();
    if (TYPE_MAP[lower]) return { optional, schema: { ...TYPE_MAP[lower] } };
    if (Object.hasOwn(contracts, raw)) return { optional, schema: buildRecord(raw, seen) };
    if (raw.includes('|')) return { optional, schema: { enum: raw.split('|') } };
    return { optional, schema: {} }; // unknown → unconstrained
  }

  function buildRecord(name, seen) {
    if (seen.has(name)) return { type: 'object' }; // cycle guard (engine forbids recursion)
    const fields = contracts[name];
    if (!fields || typeof fields !== 'object') return { type: 'object' };
    const nextSeen = new Set(seen).add(name);
    const properties = {};
    const required = [];
    for (const [field, typeStr] of Object.entries(fields)) {
      const { schema, optional } = typeToSchema(typeStr, nextSeen);
      properties[field] = schema;
      if (!optional) required.push(field);
    }
    return { type: 'object', required, properties };
  }

  return buildRecord(root, new Set());
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
 * D3: raised when an `onAgentEvent` observer asks to stop an in-flight agent run
 * (e.g. the GSD stuck detector tripped mid-execution). Carries the observer's
 * reason so the caller can render a diagnostic and halt.
 */
export class AgentAbortedError extends Error {
  constructor(stepId, reason) {
    super(`Agent run on step "${stepId}" aborted by observer`);
    this.name = 'AgentAbortedError';
    this.stepId = stepId;
    this.reason = reason;
  }
}

function copyDispatchId(source, target) {
  try {
    if (!source || !target || typeof source.dispatchId !== 'string') return target;
    Object.defineProperty(target, 'dispatchId', {
      configurable: true,
      enumerable: false,
      value: source.dispatchId,
    });
  } catch {
    // Error replacement must preserve the original control flow even if a
    // third-party target is unexpectedly frozen.
  }
  return target;
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
  // D6: the engine ships only the bare provider literal (stepDispatch.agent), so
  // the full profile string (with tool restrictions + model tier) is supplied
  // compose-side via opts.profile, keyed off the compose-owned sidecar. It
  // overrides the bare literal for capability resolution; the provider is
  // unchanged. Absent → bare literal (no restrictions), preserving old behavior.
  const cfg = resolveAgentConfig(opts.profile || agentType);
  const callerTelemetry = opts.telemetry && typeof opts.telemetry === 'object'
    ? opts.telemetry
    : {};
  const primaryTelemetry = {};
  for (const field of ['project_cwd', 'site', 'build_id', 'feature_code']) {
    if (callerTelemetry[field] !== undefined) primaryTelemetry[field] = callerTelemetry[field];
  }
  primaryTelemetry.step_id = stepId;
  if (typeof stepDispatch.attempt === 'number' && Number.isFinite(stepDispatch.attempt)) {
    primaryTelemetry.attempt = stepDispatch.attempt;
  }
  primaryTelemetry.effort_intended = cfg.effort ?? null;
  // A read-only profile (no Edit/Write/Bash) also maps to a read-only sandbox so
  // the restriction binds at the engine's connector, not just at this invocation.
  const readOnlyProfile = Array.isArray(cfg.disallowedTools)
    && ['Edit', 'Write'].every((tool) => cfg.disallowedTools.includes(tool));
  const sandboxMode = readOnlyProfile ? 'read-only' : undefined;

  const outputFields = stepDispatch.output_fields;
  const hasSchema = outputFields && typeof outputFields === 'object' && Object.keys(outputFields).length > 0;
  let actualPrompt = prompt;
  let schema = null;
  // Consumer-fanout dispatch carries the full contract CLOSURE so nested named
  // records and typed arrays reach the agent (and match the engine's strict
  // validation). Fall back to the flat field→primitive schema otherwise.
  const closureSchema = contractClosureToJsonSchema(stepDispatch.output_contract_closure);
  // A valid but EMPTY root contract ({}) yields zero fields, so `hasSchema` is
  // false while a real (empty-object) closure schema exists. Structured
  // extraction must be gated on "a contract is declared", not "the root has
  // fields" — otherwise the agent's `{}` is discarded and the item wedges.
  const hasStructuredOutput = Boolean(closureSchema) || hasSchema;
  if (closureSchema) {
    schema = closureSchema;
    actualPrompt = injectSchema(prompt, schema);
  } else if (hasSchema) {
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
  // D3: an onAgentEvent observer (e.g. the GSD stuck detector) may ask to stop
  // the run mid-stream by returning a truthy reason from a tool event.
  let abortReason = null;

  // V2/V3: CONTROLLED claude executions (consumer items, review fanout) run via
  // the compose-LOCAL connector — the only seam that can enforce claude tool
  // restrictions AND be interrupted (the sync engine agent_run can do neither;
  // its background mode is codex+read-only-only). Abort replaces cancelAgentRun
  // as the stop mechanism, and the connector streams real tool events so the
  // stuck detector / timeout actually stop a runaway agent.
  const useLocalClaude = opts.localExecution === true && cfg.provider === 'claude';
  const abortController = useLocalClaude ? new AbortController() : null;
  const stopRun = () => {
    if (abortController) {
      try { abortController.abort(); } catch { /* already aborted */ }
    } else {
      stratum.cancelAgentRun(correlationId).catch(() => {});
    }
  };

  // Subscribe BEFORE calling agentRun — events fire during the call.
  const unsub = stratum.onEvent(correlationId, subStepId, (env) => {
    // Accept every KNOWN_VERSIONS envelope (producer emits 0.2.6). Hard-pinning
    // '0.2.5' silently dropped all live agent-run narration. (Events are already
    // validated by the client before dispatch; this is a version-set guard.)
    if (!env || !KNOWN_VERSIONS.has(env.schema_version)) return;
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
    // D3: let an observer inspect every processed envelope and request a stop
    // (returns a truthy reason). Cancel the in-flight run once; the post-run
    // guard rethrows as AgentAbortedError.
    if (opts.onAgentEvent) {
      const stop = opts.onAgentEvent(env);
      if (stop && !abortReason) {
        abortReason = stop;
        stopRun();
      }
    }
  });

  if (maxDurationMs) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      stopRun();
    }, maxDurationMs);
  }

  let onInterrupt = null;
  if (progress?.on) {
    onInterrupt = () => {
      userInterruptAction = progress.consumeAction?.() ?? 'skip';
      stopRun();
    };
    progress.on('interrupt', onInterrupt);
  }

  // V2/V3: on the local path the connector's tool_use events (not engine
  // progress notifications) drive narration + the stuck detector. This bridge
  // mirrors the engine onEvent handler's tool handling and lets the observer
  // abort a spinning run.
  const localOnToolUse = ({ tool, input }) => {
    if (onToolUse) onToolUse({ tool, input, timestamp: Date.now() });
    if (streamWriter) streamWriter.write({ type: 'tool_use', tool, input: input ?? {} });
    if (progress) progress.toolUse(tool, input?.command ?? input?.pattern ?? input?.file_path ?? '');
    if (opts.onAgentEvent && !abortReason) {
      const env = { schema_version: '0.2.6', kind: 'tool_use_summary', metadata: { tool, input: input ?? {}, summary: '', output: '' } };
      const stop = opts.onAgentEvent(env);
      if (stop) { abortReason = stop; stopRun(); }
    }
  };

  let runResult;
  let primaryDispatchId = null;
  let repairDispatchId = null;
  try {
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
        abortController,
        onToolUse:       localOnToolUse,
        telemetry:       primaryTelemetry,
        ...(localQuery ? { query: localQuery } : {}),
      });
    } else {
      runResult = await stratum.agentRun(agentType, actualPrompt, {
        modelID:          cfg.modelID ?? undefined,
        allowedTools:     cfg.allowedTools ?? undefined,
        disallowedTools:  cfg.disallowedTools ?? undefined,
        thinking:         cfg.thinking ?? undefined,
        effort:           cfg.effort ?? undefined,
        sandboxMode,
        cwd:              opts.cwd ?? undefined,
        correlationId,
        telemetry:        primaryTelemetry,
      });
    }
    primaryDispatchId = typeof runResult?.dispatchId === 'string'
      ? runResult.dispatchId
      : null;
  } catch (err) {
    // F3/G3: preserve any billable usage the failed run reported (the local
    // connector attaches it on a non-success result / usage-bearing rejection) so
    // the consumer failure envelope can still debit the engine/GSD ledgers. G3:
    // the timeout/abort throws happen here too — attach the usage to THOSE errors
    // (not only the generic AgentError) so timeout/stuck attempts are billed.
    const errUsage = (err && typeof err === 'object' && err.usage) ? err.usage : null;
    if (timedOut) {
      const e = new AgentTimeoutError(stepId, Date.now() - startTime);
      if (errUsage) e.usage = errUsage;
      throw copyDispatchId(err, e);
    }
    if (userInterruptAction) {
      throw copyDispatchId(err, new UserInterruptError(stepId, userInterruptAction));
    }
    if (abortReason) {
      const e = new AgentAbortedError(stepId, abortReason);
      if (errUsage) e.usage = errUsage;
      throw copyDispatchId(err, e);
    }
    const agentError = new AgentError(err?.message ?? 'Agent run failed');
    if (errUsage) agentError.usage = errUsage;
    throw copyDispatchId(err, agentError);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (onInterrupt && progress?.removeListener) progress.removeListener('interrupt', onInterrupt);
    unsub();
  }

  // H2: when the underlying run RESOLVES late (rather than rejecting) after a
  // timeout/abort fired, its billable usage is on runResult.usage. Copy it onto
  // the thrown error — the same single channel the rejection path (G3) uses — so
  // the consumer timeout envelope / stuck-ledger accounting still bill the attempt.
  // Throwing here means usageTotals is never returned, so this is the ONLY channel
  // (no double count).
  const lateUsage = (runResult && typeof runResult === 'object' && runResult.usage && typeof runResult.usage === 'object')
    ? runResult.usage
    : null;
  if (timedOut) {
    const e = new AgentTimeoutError(stepId, Date.now() - startTime);
    if (lateUsage) e.usage = lateUsage;
    throw copyDispatchId(runResult, e);
  }
  if (userInterruptAction) {
    throw copyDispatchId(runResult, new UserInterruptError(stepId, userInterruptAction));
  }
  if (abortReason) {
    const e = new AgentAbortedError(stepId, abortReason);
    if (lateUsage) e.usage = lateUsage;
    throw copyDispatchId(runResult, e);
  }

  // D2(b): the TS agent_run path returns a synchronous `complete` envelope with
  // aggregate usage ({usd?, tokens, ms}) and streams NO step_usage progress
  // events — without folding it in, budget accounting debits nothing on the TS
  // route. The python / factory-shim path streams step_usage events (usageTotals
  // already populated), so adopt runResult.usage only when the event stream
  // contributed nothing (avoids double counting).
  const runUsage = runResult && typeof runResult === 'object' ? runResult.usage : null;
  const usageFromEvents = usageTotals.input_tokens || usageTotals.output_tokens || usageTotals.cost_usd;
  if (runUsage && typeof runUsage === 'object' && !usageFromEvents) {
    if (typeof runUsage.tokens === 'number') usageTotals.output_tokens += runUsage.tokens;
    if (typeof runUsage.usd === 'number') usageTotals.cost_usd += runUsage.usd;
    if (typeof runUsage.ms === 'number') usageTotals.duration_ms = (usageTotals.duration_ms ?? 0) + runUsage.ms;
    if (!usageTotals.model && runResult.telemetry?.model) usageTotals.model = runResult.telemetry.model;
  }

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
          try {
            const repairResult = await stratum.agentRun(reviewAgentType, repairPrompt, {
              modelID: cfg.modelID ?? undefined,
              cwd: opts.cwd ?? undefined,
              telemetry: { ...primaryTelemetry, site: 'review-repair' },
            });
            repairDispatchId = typeof repairResult?.dispatchId === 'string'
              ? repairResult.dispatchId
              : null;
            return repairResult?.text ?? '';
          } catch (error) {
            repairDispatchId = typeof error?.dispatchId === 'string'
              ? error.dispatchId
              : null;
            throw error;
          }
        }
      : undefined;
    const reviewResult = await normalizeReviewResult(text, {
      agentType: reviewAgentType,
      modelId: reviewModelId,
      confidenceGate: opts.confidenceGate ?? 7,
      lens: opts.lens ?? 'general',
      repairFn,
    });
    return {
      text,
      result: reviewResult,
      usage: usageTotals,
      dispatchIds: { primary: primaryDispatchId, repair: repairDispatchId },
    };
  }

  if (!hasStructuredOutput) {
    return {
      text,
      result: null,
      usage: usageTotals,
      dispatchIds: { primary: primaryDispatchId, repair: repairDispatchId },
    };
  }

  const result = extractJson(text);
  if (result === null) {
    if (progress) {
      progress.warn('Could not extract JSON from agent output, using fallback');
    } else {
      process.stderr.write('    ⚠ Could not extract JSON from agent output, using fallback\n');
    }
    const summary = text.slice(0, 200).replace(/\n/g, ' ').trim();
    const normalizationFailure = summary || 'Could not extract structured output';
    return {
      text,
      result: { summary: normalizationFailure },
      usage: usageTotals,
      normalizationFailure,
      dispatchIds: { primary: primaryDispatchId, repair: repairDispatchId },
    };
  }

  return {
    text,
    result,
    usage: usageTotals,
    dispatchIds: { primary: primaryDispatchId, repair: repairDispatchId },
  };
}
