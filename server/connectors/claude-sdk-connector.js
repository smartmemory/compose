/**
 * ClaudeSDKConnector — wraps @anthropic-ai/claude-agent-sdk query().
 *
 * All Anthropic model execution goes through this connector.
 * Yields the same typed message envelope as the other connectors.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentConnector, injectSchema } from './agent-connector.js';

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

export class ClaudeSDKConnector extends AgentConnector {
  // ── Discovery ──────────────────────────────────────────────────────────────
  // No overrides — inherits stubs from AgentConnector. See agent-connector.js.

  #model;
  #cwd;
  #query = null;

  #allowedTools;
  #disallowedTools;
  #thinking;
  #effort;

  /**
   * @param {object} [opts]
   * @param {string}   [opts.model]            — default model (env CLAUDE_MODEL or claude-sonnet-4-6)
   * @param {string}   [opts.cwd]              — default working directory
   * @param {string[]} [opts.allowedTools]     — restrict to these tools (overrides preset)
   * @param {string[]} [opts.disallowedTools]  — deny these tools (used alongside allowedTools or preset)
   * @param {object|null} [opts.thinking]      — Claude thinking config, e.g. { type: 'adaptive' } or { type: 'disabled' }
   * @param {string|null} [opts.effort]        — effort level: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
   */
  constructor({ model = DEFAULT_MODEL, cwd = process.cwd(), allowedTools, disallowedTools, thinking, effort } = {}) {
    super();
    this.#model = model;
    this.#cwd = cwd;
    this.#allowedTools = allowedTools ?? null;
    this.#disallowedTools = disallowedTools ?? null;
    this.#thinking = thinking ?? null;
    this.#effort = effort ?? null;
  }

  // ── Runtime ────────────────────────────────────────────────────────────────

  async *run(prompt, { schema, modelID, cwd, thinking, effort } = {}) {
    if (this.#query) {
      throw new Error('ClaudeSDKConnector: run() already active. Call interrupt() first.');
    }

    const actualPrompt = schema ? injectSchema(prompt, schema) : prompt;

    // Strip CLAUDECODE env var to allow spawning inside a Claude Code session
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    // Build tools config: prefer explicit allow/deny lists if provided,
    // otherwise fall back to the default claude_code preset (backward compat).
    let toolsConfig;
    if (this.#allowedTools !== null) {
      toolsConfig = { type: 'allowed', allowedTools: this.#allowedTools };
      if (this.#disallowedTools !== null) {
        toolsConfig.disallowedTools = this.#disallowedTools;
      }
    } else if (this.#disallowedTools !== null) {
      toolsConfig = { type: 'preset', preset: 'claude_code', disallowedTools: this.#disallowedTools };
    } else {
      toolsConfig = { type: 'preset', preset: 'claude_code' };
    }

    // Resolve thinking/effort: per-run override beats constructor default.
    const resolvedThinking = thinking !== undefined ? thinking : this.#thinking;
    const resolvedEffort   = effort   !== undefined ? effort   : this.#effort;

    const sdkOptions = {
      cwd: cwd ?? this.#cwd,
      model: modelID ?? this.#model,
      permissionMode: 'acceptEdits',
      tools: toolsConfig,
      env: cleanEnv,
    };
    if (resolvedThinking !== null && resolvedThinking !== undefined) {
      sdkOptions.thinking = resolvedThinking;
    }
    if (resolvedEffort !== null && resolvedEffort !== undefined) {
      sdkOptions.effort = resolvedEffort;
    }

    const q = query({
      prompt: actualPrompt,
      options: sdkOptions,
    });
    this.#query = q;

    yield { type: 'system', subtype: 'init', agent: 'claude', model: modelID ?? this.#model };

    const activeModel = modelID ?? this.#model;
    try {
      for await (const msg of q) {
        if (process.env.COMPOSE_DEBUG) {
          process.stderr.write(`  [sdk] ${msg?.type ?? typeof msg}\n`);
        }
        for (const event of _normalizeAll(msg)) {
          // Inject model into usage events extracted from result messages
          if (event.type === 'usage' && event._from_result) {
            const { _from_result: _, ...usageEvent } = event;
            yield { ...usageEvent, model: activeModel };
          } else {
            yield event;
          }
        }
      }
      yield { type: 'system', subtype: 'complete', agent: 'claude' };
    } catch (err) {
      if (err?.name !== 'AbortError') {
        yield { type: 'error', message: err.message || String(err) };
      }
    } finally {
      this.#query = null;
    }
  }

  interrupt() {
    if (this.#query) {
      try { this.#query.interrupt(); } catch { /* already done */ }
      this.#query = null;
    }
  }

  get isRunning() {
    return this.#query !== null;
  }
}

// ---------------------------------------------------------------------------
// Normalize Claude SDK message → shared envelope
// ---------------------------------------------------------------------------

/**
 * Normalize an SDK message into one or more envelope events.
 * Returns an array because a single assistant message can contain
 * multiple content blocks (text + tool_use).
 */
function _normalizeAll(msg) {
  if (!msg || typeof msg !== 'object') {
    return [{ type: 'assistant', content: String(msg) }];
  }
  if (msg.type === 'system' || msg.type === 'error') return [msg];

  // SDK assistant message — extract content blocks from msg.message
  if (msg.type === 'assistant' && msg.message?.content) {
    const events = [];
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        events.push({ type: 'assistant', content: block.text });
      } else if (block.type === 'tool_use') {
        events.push({ type: 'tool_use', tool: block.name, input: block.input ?? {} });
      }
    }
    return events.length > 0 ? events : [msg];
  }

  // SDK result message — contains the final aggregated text and usage metadata
  if (msg.type === 'result' && msg.result) {
    const events = [{ type: 'result', content: msg.result }];
    // Extract usage from msg.usage or msg.message.usage
    const usage = msg.usage ?? msg.message?.usage;
    if (usage) {
      events.push({
        type: 'usage',
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        // model is injected by the run() loop via _modelForUsage tag on the event
        _from_result: true,
      });
    }
    return events;
  }

  if (msg.type === 'tool_use') {
    return [{ type: 'tool_use', tool: msg.name ?? msg.tool, input: msg.input ?? {} }];
  }
  if (msg.type === 'tool_use_summary') {
    const output = (msg.result ?? msg.output ?? '');
    return [{ type: 'tool_use_summary', summary: msg.summary, output: output ? output.slice(0, 2048) : undefined }];
  }
  if (msg.type === 'tool_progress') {
    return [{ type: 'tool_progress', tool: msg.tool_name, elapsed: msg.elapsed_time_seconds }];
  }
  // Delta or text content
  if (msg.delta?.text) return [{ type: 'assistant', content: msg.delta.text }];
  if (msg.content && typeof msg.content === 'string') return [{ type: 'assistant', content: msg.content }];
  // Pass through unknown message types as-is
  return [msg];
}
