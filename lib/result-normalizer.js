/**
 * Result Normalizer — bridges connector text streams to structured step results
 * for the headless build runner.
 *
 * Converts flat Stratum output_fields to JSON Schema, runs a connector,
 * accumulates text, and extracts structured JSON from the response.
 */

import { routingCallOptions, routingIntegrityError } from './routing-runtime.js';
import { randomUUID } from 'node:crypto';
import { injectSchema } from './inject-schema.js';
import { CliProgress } from './cli-progress.js';
import { resolveAgentConfig } from './agent-string.js';
import { normalizeReviewResult } from './review-normalize.js';
import { KNOWN_VERSIONS } from './build-stream-schema.js';
import { runLocalClaudeAgent } from './local-claude-connector.js';
import { confirmCancellation } from './build-cancel.js';

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

const BARE_PIPE_ENUM = /^[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)+$/;

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
    properties[key] = BARE_PIPE_ENUM.test(typeStr)
      ? { type: 'string', enum: typeStr.split('|') }
      : (TYPE_MAP[lower] ?? {}); // any/unknown → unconstrained
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
    if (raw.includes('|')) return { optional, schema: { type: 'string', enum: raw.split('|') } };
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
/**
 * Sum two usage records into one, for a step whose work took more than one
 * agent call (e.g. a COMP-POLICY-CHECK revision replacing the primary draft).
 * Token/cost fields add; `model` keeps the later run's value when it has one.
 * Either side may be null.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {object|null}
 */
export function mergeUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cost_usd: (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
    model: b.model ?? a.model ?? null,
  };
}

function hasReportedUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return [
    usage.tokens, usage.input_tokens, usage.output_tokens,
    usage.cache_read, usage.cache_read_input_tokens,
    usage.cache_creation, usage.cache_creation_input_tokens,
    usage.cost_usd, usage.usd, usage.ms, usage.duration_ms,
  ].some((value) => typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

function usageRecordFromRaw(usage, telemetry, dispatchId, fallback = {}, split = null) {
  if (!hasReportedUsage(usage)) return null;
  // STRAT-USAGE-SPLIT: prefer the connector-reported split over reconstruction
  // (the reconstruction cannot tell input from output; it filed the aggregate
  // as output on every record before surface 16).
  const input = split?.input ?? usage.input_tokens ?? 0;
  const output = split?.output
    ?? usage.output_tokens
    ?? (typeof usage.tokens === 'number' ? Math.max(0, usage.tokens - input) : 0);
  const record = {
    dispatch_id: dispatchId ?? randomUUID(),
    model: telemetry?.model ?? usage.model ?? fallback.model ?? 'unknown',
    ...(telemetry?.effort ?? fallback.effort
      ? { effort: telemetry?.effort ?? fallback.effort }
      : {}),
    duration_ms: telemetry?.durationMs ?? usage.duration_ms ?? usage.ms ?? fallback.duration_ms ?? 0,
    input_tokens: input,
    output_tokens: output,
    ...(typeof (split?.cacheRead ?? usage.cache_read ?? usage.cache_read_input_tokens) === 'number'
      ? { cache_read: split?.cacheRead ?? usage.cache_read ?? usage.cache_read_input_tokens }
      : {}),
    ...(typeof (split?.cacheCreation ?? usage.cache_creation ?? usage.cache_creation_input_tokens) === 'number'
      ? { cache_creation: split?.cacheCreation ?? usage.cache_creation ?? usage.cache_creation_input_tokens }
      : {}),
  };
  const cost = usage.cost_usd ?? usage.usd;
  const usdSource = ['reported', 'estimated'].includes(usage.usd_source)
    ? usage.usd_source
    : (['reported', 'estimated'].includes(fallback.usd_source) ? fallback.usd_source : null);
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && usdSource) {
    record.cost_usd = cost;
    record.usd_source = usdSource;
  }
  return record;
}

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
  // COMP-AGENT-LANES: when the caller (a parallel fanout item) supplies a lane
  // envelope, stamp it on every relayed stream write so the cockpit can route
  // this run's output to its worker lane. Absent the opt, writes stay
  // byte-identical (single-step runs unchanged).
  const laneStamp = (opts.lane && typeof opts.lane === 'object') ? { lane: opts.lane } : {};
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
  // Claude profiles bind through SDK tool filters. Codex has an OS sandbox;
  // write permission must be explicitly requested by the implementation caller.
  const sandboxMode = cfg.provider === 'codex'
    ? (opts.sandboxMode ?? 'read-only')
    : undefined;
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
  let primaryUsdSource = null;
  // COMP-COST-OWNER S3. Steps that moved tokens and stated no cost. Counted, never
  // priced: this consumer used to derive an amount here, which made an unknown cost
  // indistinguishable from an estimate and left the run total SHORT by that step.
  let usdUnknownSteps = 0;

  let timedOut = false;
  let userInterruptAction = null;
  let timeoutHandle = null;
  // D3: an onAgentEvent observer (e.g. the GSD stuck detector) may ask to stop
  // the run mid-stream by returning a truthy reason from a tool event.
  let abortReason = null;

  // Both local SDK and MCP executions own a cancellable handle. The MCP
  // client translates this signal to an acknowledged foreground cancellation.
  const useLocalClaude = opts.localExecution === true && cfg.provider === 'claude';
  const primaryFailure = (source, target) => {
    const record = usageRecordFromRaw(source?.usage, source?.telemetry, source?.dispatchId, {
      model: cfg.modelID, effort: cfg.effort, duration_ms: Date.now() - startTime,
      usd_source: source?.usdSource,
    }, source?.split);
    if (record) target.usages = [record];
    return copyDispatchId(source, target);
  };
  const abortController = new AbortController();
  const stopRun = () => abortController.abort();

  // COMP-BUILD-CANCEL S03-2 (D-F, C13): the build-level cancel handle. ONE hook covers
  // BOTH dispatch branches, because both hang off this single controller — the local SDK
  // agent (via opts.abortController) and the two MCP dispatches (via abortController
  // .signal). `executionOptions` is deliberately untouched: it is spread into the MCP
  // wire request, where an AbortSignal does not belong.
  const buildSignal = opts.buildSignal ?? null;
  if (buildSignal?.aborted) stopRun();
  else buildSignal?.addEventListener('abort', stopRun, { once: true });

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
          if (streamWriter) streamWriter.write({ type: 'assistant', content: m.text, ...laneStamp });
        }
        break;
      case 'tool_use_summary': {
        const tool = m.tool;
        if (tool) {
          if (streamWriter) {
            streamWriter.write({ type: 'tool_use', tool, input: m.input ?? {}, ...laneStamp });
          }
          if (onToolUse) onToolUse({ tool, input: m.input ?? {}, timestamp: Date.now() });
          if (progress) {
            const detail = m.input?.command ?? m.input?.pattern ?? m.input?.query ?? m.input?.file_path ?? '';
            progress.toolUse(tool, detail);
          }
        }
        if (m.summary) {
          if (streamWriter) {
            streamWriter.write({ type: 'tool_use_summary', summary: m.summary, output: m.output ?? '', ...laneStamp });
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
        // Provenance is STATED by the producer (`usd_source`), never inferred from whether
        // `cost_usd` happens to be present. That inference was the hazard: a producer that
        // sent an honest estimate had it silently relabelled as provider-reported spend,
        // so the only safe thing it could do was omit the cost entirely -- which this
        // consumer's own schema then rejected, dropping the event. Stating it removes both
        // problems at once and means the consumer no longer prices tokens on the happy
        // path, so the OpenAI/Anthropic cached-token dialect never enters the cost math.
        //
        // `estimated` is sticky across a run: one estimated step makes the whole total an
        // estimate, because a mixed sum cannot honestly be called reported.
        //
        // COMP-COST-OWNER S3: there is no longer a consumer-side fallback. When no cost is
        // stated the step is COUNTED as unknown and contributes nothing to the total -- the
        // accumulator's rule (lib/build.js:4432) and the receipt path's rule
        // (lib/build.js:2300-2306) applied one layer earlier. Pricing it here could only
        // ever have produced a 0 on a real producer path anyway: the fallback was reachable
        // only for a model stratum could not price, and compose's table held the identical
        // key set (evidence/s3-reachability-probes-2026-09-12.md).
        const hasCost = typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd);
        if (hasCost) {
          const stepSource = m.usd_source
            // No stated provenance on a stated amount: it is the producer's own report.
            ?? 'reported';
          primaryUsdSource = stepSource === 'estimated' || primaryUsdSource === 'estimated'
            ? 'estimated'
            : 'reported';
          usageTotals.cost_usd += m.cost_usd;
        } else if (inTok + outTok + ccit + crit > 0) {
          usdUnknownSteps += 1;   // tokens moved and nobody said what they cost
        }
        if (streamWriter) {
          streamWriter.write({
            type: 'usage',
            input_tokens: inTok,
            output_tokens: outTok,
            cache_creation_input_tokens: ccit,
            cache_read_input_tokens: crit,
            // Amount and provenance travel together or not at all (S2's writeUsage rule).
            ...(hasCost ? { cost_usd: m.cost_usd, usd_source: m.usd_source ?? 'reported' } : {}),
            model: m.model ?? null,
            ...laneStamp,
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
    if (streamWriter) streamWriter.write({ type: 'tool_use', tool, input: input ?? {}, ...laneStamp });
    if (progress) progress.toolUse(tool, input?.command ?? input?.pattern ?? input?.file_path ?? '');
    if (opts.onAgentEvent && !abortReason) {
      const env = { schema_version: '0.2.6', kind: 'tool_use_summary', metadata: { tool, input: input ?? {}, summary: '', output: '' } };
      const stop = opts.onAgentEvent(env);
      if (stop) { abortReason = stop; stopRun(); }
    }
  };

  // Keep the deadline and interrupt controls active through review repair.
  try {
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
        runResult = await runLocalClaudeAgent(actualPrompt, routingCallOptions({
          cwd:             opts.cwd ?? undefined,
          model:           cfg.modelID ?? undefined,
          allowedTools:    cfg.allowedTools ?? undefined,
          disallowedTools: cfg.disallowedTools ?? undefined,
          thinking:        cfg.thinking ?? undefined,
          effort:          cfg.effort ?? undefined,
          abortController,
          onToolUse:       localOnToolUse,
          // COMP-AGENT-LANES: only a lane-carrying run (parallel fanout item)
          // relays local assistant text to the stream — engine-path parity for
          // the lanes UI. Lane-less local runs keep their historical shape (no
          // assistant stream writes).
          ...(laneStamp.lane && streamWriter ? {
            onAssistantText: (text) => {
              streamWriter.write({ type: 'assistant', content: text, ...laneStamp });
            },
          } : {}),
          ...(opts.routingCalls ? { routingCalls: opts.routingCalls } : {}),
          telemetry:       primaryTelemetry,
          ...(localQuery ? { query: localQuery } : {}),
        }));
      } else {
        runResult = await stratum.agentRun(agentType, actualPrompt, routingCallOptions({
          ...executionOptions,
          ...(opts.routingCalls ? { routingCalls: opts.routingCalls } : {}),
          signal: abortController.signal,
          // S03-3: the tag is supplied by the CALL SITE, never inferred from
          // stepDispatch.flow_id — inference would silently tag sites the driver
          // does not mean to tag, and an explicit opts.flow keeps them greppable.
          ...(opts.flow ? { flow: opts.flow } : {}),
          correlationId,
          telemetry:        primaryTelemetry,
        }));
      }
      primaryDispatchId = typeof runResult?.dispatchId === 'string'
        ? runResult.dispatchId
        : null;
    } catch (err) {
      if (opts.routingCalls && routingIntegrityError(err)) throw primaryFailure(err, err);
      if (['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(err?.code)) throw primaryFailure(err, err);
      if (await confirmCancellation(err, {
        stratum, flowId: opts.flowId, buildCancel: opts.buildCancel, tagged: Boolean(opts.flow),
      })) throw primaryFailure(err, err);
      // F3/G3: preserve any billable usage the failed run reported (the local
      // connector attaches it on a non-success result / usage-bearing rejection) so
      // the consumer failure envelope can still debit the engine/GSD ledgers. G3:
      // the timeout/abort throws happen here too — attach the usage to THOSE errors
      // (not only the generic AgentError) so timeout/stuck attempts are billed.
      const errUsage = (err && typeof err === 'object' && err.usage)
        ? err.usage
        : null;
      if (timedOut) {
        const e = new AgentTimeoutError(stepId, Date.now() - startTime);
        if (errUsage) e.usage = errUsage;
        throw primaryFailure(err, e);
      }
      if (userInterruptAction) {
        const e = new UserInterruptError(stepId, userInterruptAction);
        if (errUsage) e.usage = errUsage;
        throw primaryFailure(err, e);
      }
      if (abortReason) {
        const e = new AgentAbortedError(stepId, abortReason);
        if (errUsage) e.usage = errUsage;
        throw primaryFailure(err, e);
      }
      const agentError = new AgentError(err?.message ?? 'Agent run failed');
      if (errUsage) agentError.usage = errUsage;
      throw primaryFailure(err, agentError);
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
      throw primaryFailure(runResult, e);
    }
    if (userInterruptAction) {
      const e = new UserInterruptError(stepId, userInterruptAction);
      if (lateUsage) e.usage = lateUsage;
      throw primaryFailure(runResult, e);
    }
    if (abortReason) {
      const e = new AgentAbortedError(stepId, abortReason);
      if (lateUsage) e.usage = lateUsage;
      throw primaryFailure(runResult, e);
    }

    // D2(b): the TS agent_run path returns a synchronous `complete` envelope with
    // aggregate usage ({usd?, tokens, ms}) and streams NO step_usage progress
    // events — without folding it in, budget accounting debits nothing on the TS
    // route. The python / factory-shim path streams step_usage events (usageTotals
    // already populated), so adopt runResult.usage only when the event stream
    // contributed nothing (avoids double counting).
    const runUsage = runResult && typeof runResult === 'object' ? runResult.usage : null;
    const runSplit = runResult && typeof runResult === 'object' && runResult.split && typeof runResult.split === 'object'
      ? runResult.split
      : null;
    const usageFromEvents = usageTotals.input_tokens || usageTotals.output_tokens || usageTotals.cost_usd;
    if (runUsage && typeof runUsage === 'object' && !usageFromEvents) {
      // STRAT-USAGE-SPLIT: the TS envelope now carries the true input/output
      // detail beside its Budget-shaped usage. Adopt it; only a split-less
      // (pre-surface-16) envelope falls back to the aggregate, which is filed
      // as output for continuity — mislabeled, but the legacy column it always
      // occupied. That path retires with surface 15.
      if (runSplit) {
        usageTotals.input_tokens += runSplit.input ?? 0;
        usageTotals.output_tokens += runSplit.output ?? 0;
        if (typeof runSplit.cacheRead === 'number') {
          usageTotals.cache_read_input_tokens = (usageTotals.cache_read_input_tokens ?? 0) + runSplit.cacheRead;
        }
        if (typeof runSplit.cacheCreation === 'number') {
          usageTotals.cache_creation_input_tokens = (usageTotals.cache_creation_input_tokens ?? 0) + runSplit.cacheCreation;
        }
      } else if (typeof runUsage.tokens === 'number') {
        usageTotals.output_tokens += runUsage.tokens;
      }
      if (typeof runUsage.usd === 'number') usageTotals.cost_usd += runUsage.usd;
      if (typeof runUsage.ms === 'number') usageTotals.duration_ms = (usageTotals.duration_ms ?? 0) + runUsage.ms;
      if (!usageTotals.model && runResult.telemetry?.model) usageTotals.model = runResult.telemetry.model;
    }

    // The connector's final result is authoritative for cost: when the streamed
    // step_usage events carried no dollar value (stratum's codex event omits
    // cost_usd when the turn reports none; older servers hardcoded 0) but the
    // result reports one WITH provenance, adopt it instead of filing the call as
    // free/estimated. Found by the COMP-FABLE-ASTRA wave golden: every codex
    // worker reached the cost gate as costUnknown.
    //
    // S3 widened the guard from "the events totalled 0" to "the event total is not
    // trustworthy", which now includes a run whose events were PARTLY unpriced. Without
    // that, removing the consumer-side fallback would discard a figure the connector
    // actually knew and report the run as unknown instead.
    if (usageFromEvents && (!(usageTotals.cost_usd > 0) || usdUnknownSteps > 0)
      && typeof runUsage?.usd === 'number' && Number.isFinite(runUsage.usd) && runUsage.usd > 0
      && ['reported', 'estimated'].includes(runResult?.usdSource)) {
      usageTotals.cost_usd = runUsage.usd;
      primaryUsdSource = runResult.usdSource;
      usdUnknownSteps = 0;   // the connector's own total covers the whole run
    }

    const usages = [];
    const primaryFromEvents = usageFromEvents || primaryUsdSource !== null;
    if (primaryFromEvents) {
      const primary = {
        dispatch_id: primaryDispatchId ?? randomUUID(),
        model: usageTotals.model ?? runResult?.telemetry?.model ?? cfg.modelID ?? 'unknown',
        ...(runResult?.telemetry?.effort ?? cfg.effort
          ? { effort: runResult?.telemetry?.effort ?? cfg.effort }
          : {}),
        duration_ms: runResult?.telemetry?.durationMs ?? usageTotals.duration_ms ?? (Date.now() - startTime),
        input_tokens: usageTotals.input_tokens,
        output_tokens: usageTotals.output_tokens,
        ...(usageTotals.cache_read_input_tokens
          ? { cache_read: usageTotals.cache_read_input_tokens }
          : {}),
        ...(usageTotals.cache_creation_input_tokens
          ? { cache_creation: usageTotals.cache_creation_input_tokens }
          : {}),
        // A total missing one step's spend is not the total. It is omitted entirely, which
        // is the signal recordBuildUsage (lib/build.js:4445) counts and reportUsageReceipts
        // (lib/build.js:2300) refuses to give provenance to.
        ...(usdUnknownSteps === 0 && usageTotals.cost_usd > 0
          ? { cost_usd: usageTotals.cost_usd, usd_source: primaryUsdSource ?? 'estimated' }
          : { usd_source: primaryUsdSource ?? 'estimated' }),
      };
      usages.push(primary);
    } else {
      const primary = usageRecordFromRaw(runUsage, runResult?.telemetry, primaryDispatchId, {
        model: cfg.modelID,
        effort: cfg.effort,
        duration_ms: Date.now() - startTime,
        usd_source: runResult?.usdSource,
      }, runSplit);
      if (primary) usages.push(primary);
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
      // The repair dispatch is only CREDITED (dispatchIds.repair) when its output
      // actually replaced the primary parse — a failed or unparseable repair still
      // bills its usage but must not absorb the step's settlement.
      let repairUsed = false;
      let repairFailure = null;
      let repairResultForControl = null;
      const foldRepairUsage = (usage) => {
        if (!usage || typeof usage !== 'object') return;
        if (typeof usage.tokens === 'number') usageTotals.output_tokens += usage.tokens;
        if (typeof usage.usd === 'number') usageTotals.cost_usd += usage.usd;
      };
      const repairFn = stratum
        ? async (repairPrompt) => {
            try {
              const repairResult = await stratum.agentRun(reviewAgentType, repairPrompt, routingCallOptions({
                ...executionOptions,
                ...(opts.routingCalls ? { routingCalls: opts.routingCalls.child() } : {}),
                signal: abortController.signal,
                ...(opts.flow ? { flow: opts.flow } : {}),
                telemetry: { ...primaryTelemetry, site: 'review-repair' },
              }));
              repairResultForControl = repairResult;
              repairDispatchId = typeof repairResult?.dispatchId === 'string'
                ? repairResult.dispatchId
                : null;
              foldRepairUsage(repairResult?.usage);
              const record = usageRecordFromRaw(
                repairResult?.usage,
                repairResult?.telemetry,
                repairDispatchId,
                { model: cfg.modelID, effort: cfg.effort, usd_source: repairResult?.usdSource },
                repairResult?.split && typeof repairResult.split === 'object' ? repairResult.split : null,
              );
              if (record) usages.push(record);
              return repairResult?.text ?? '';
            } catch (error) {
              repairFailure = error;
              if (opts.routingCalls && (routingIntegrityError(error) || !opts.routingCalls.terminated())) throw error;
              if (!['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(error?.code)) {
                await confirmCancellation(error, {
                  stratum, flowId: opts.flowId, buildCancel: opts.buildCancel, tagged: Boolean(opts.flow),
                });
              }
              repairDispatchId = typeof error?.dispatchId === 'string'
                ? error.dispatchId
                : null;
              foldRepairUsage(error?.usage);
              const record = usageRecordFromRaw(
                error?.usage,
                error?.telemetry,
                repairDispatchId,
                { model: cfg.modelID, effort: cfg.effort, usd_source: error?.usdSource },
                error?.split,
              );
              if (record) usages.push(record);
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
        ...(opts.routingCalls ? { routingCalls: opts.routingCalls } : {}),
        onRepairUsed: () => { repairUsed = true; },
      });
      // The tolerant text parser can recover ordinary repair failures, but it
      // must never turn a cancelled or still-running repair into a clean review.
      if (repairFailure && (opts.buildCancel?.cancelled
        || ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(repairFailure.code))) {
        repairFailure.usages = usages;
        throw repairFailure;
      }
      const controlSource = repairFailure ?? repairResultForControl;
      const controlError = timedOut
        ? new AgentTimeoutError(stepId, Date.now() - startTime)
        : userInterruptAction
          ? new UserInterruptError(stepId, userInterruptAction)
          : abortReason ? new AgentAbortedError(stepId, abortReason) : null;
      if (controlError) {
        if (controlSource?.usage) controlError.usage = controlSource.usage;
        controlError.usages = usages;
        throw copyDispatchId(controlSource, controlError);
      }
      return {
        text,
        result: reviewResult,
        usage: usageTotals,
        usages,
        dispatchIds: { primary: primaryDispatchId, repair: repairUsed ? repairDispatchId : null },
      };
    }

    if (!hasStructuredOutput) {
      return {
        text,
        result: null,
        usage: usageTotals,
        usages,
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
        usages,
        normalizationFailure,
        dispatchIds: { primary: primaryDispatchId, repair: repairDispatchId },
      };
    }

    return {
      text,
      result,
      usage: usageTotals,
      usages,
      dispatchIds: { primary: primaryDispatchId, repair: repairDispatchId },
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (onInterrupt && progress?.removeListener) progress.removeListener('interrupt', onInterrupt);
    // Release the build-level listener, so a long build does not accumulate one per
    // dispatch across hundreds of runs.
    buildSignal?.removeEventListener('abort', stopRun);
    unsub();
  }
}
