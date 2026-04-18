/**
 * CodexConnector — spawns the official `codex exec --json` CLI for each prompt.
 *
 * Replaces the previous opencode-backed implementation. Uses the OpenAI Codex
 * CLI (`codex`, installed via `npm i -g @openai/codex` or `brew install codex`)
 * which streams structured JSONL events to stdout.
 *
 * Auth: run `codex login` once (ChatGPT OAuth), or set OPENAI_API_KEY.
 *
 * Model IDs use the form `<model>` or `<model>/<effort>` where effort is one
 * of `minimal|low|medium|high|xhigh`. The effort suffix is split off and
 * passed as `-c model_reasoning_effort=<effort>`.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentConnector, injectSchema } from './agent-connector.js';

// ---------------------------------------------------------------------------
// Supported Codex model IDs (model + optional /effort suffix)
// ---------------------------------------------------------------------------

export const CODEX_MODEL_IDS = new Set([
  'gpt-5.4',
  'gpt-5.4/low',
  'gpt-5.4/medium',
  'gpt-5.4/high',
  'gpt-5.4/xhigh',
  'gpt-5.2-codex',
  'gpt-5.2-codex/low',
  'gpt-5.2-codex/medium',
  'gpt-5.2-codex/high',
  'gpt-5.2-codex/xhigh',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-max/low',
  'gpt-5.1-codex-max/medium',
  'gpt-5.1-codex-max/high',
  'gpt-5.1-codex-max/xhigh',
  'gpt-5.1-codex',
  'gpt-5.1-codex/low',
  'gpt-5.1-codex/medium',
  'gpt-5.1-codex/high',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-mini/medium',
  'gpt-5.1-codex-mini/high',
]);

const DEFAULT_MODEL_ID = process.env.CODEX_MODEL || 'gpt-5.4';
const AGENT_NAME = 'codex';

// ---------------------------------------------------------------------------
// CodexConnector
// ---------------------------------------------------------------------------

export class CodexConnector extends AgentConnector {
  _defaultModelID;
  _cwd;
  #proc = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.modelID] — Codex model ID; must be in CODEX_MODEL_IDS
   * @param {string} [opts.cwd]     — default working directory
   * @throws {Error} if modelID is not a recognized Codex model
   */
  constructor({ modelID = DEFAULT_MODEL_ID, cwd = process.cwd() } = {}) {
    super();
    _assertCodexModel(modelID);
    this._defaultModelID = modelID;
    this._cwd = cwd;
  }

  // ── Runtime ────────────────────────────────────────────────────────────────

  async *run(prompt, { schema, modelID, cwd } = {}) {
    if (this.#proc) {
      throw new Error(`${AGENT_NAME}: run() already active. Call interrupt() first.`);
    }

    const resolvedModelID = modelID ?? this._defaultModelID;
    _assertCodexModel(resolvedModelID);
    const resolvedCwd = cwd ?? this._cwd;
    const actualPrompt = schema ? injectSchema(prompt, schema) : prompt;

    const [baseModel, effort] = resolvedModelID.split('/');

    yield {
      type: 'system', subtype: 'init',
      agent: AGENT_NAME, model: resolvedModelID,
    };

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '-m', baseModel,
      '-C', resolvedCwd,
    ];
    if (effort) {
      args.push('-c', `model_reasoning_effort="${effort}"`);
    }
    args.push('-'); // read prompt from stdin

    const proc = spawn('codex', args, {
      cwd: resolvedCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.#proc = proc;

    // Write prompt via stdin to avoid argv length and quoting issues
    proc.stdin.end(actualPrompt);

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    const textParts = [];
    const stderrChunks = [];

    // Stream stderr — surface auth/rate-limit errors immediately
    proc.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
      const text = chunk.toString();
      const lower = text.toLowerCase();
      if (lower.includes('rate limit') || lower.includes('rate_limit') ||
          lower.includes('quota') || lower.includes('insufficient_quota') ||
          lower.includes('unauthorized') || lower.includes('401') ||
          lower.includes('403') || lower.includes('authentication') ||
          lower.includes('not logged in') || lower.includes('login required') ||
          lower.includes('billing') || lower.includes('exceeded')) {
        process.stderr.write(`\n⚠ ${AGENT_NAME}: ${text.trim()}\n`);
        process.stderr.write(`  → Check login: codex login status\n`);
        process.stderr.write(`  → Re-auth:    codex login\n\n`);
      }
    });

    // Stall detection — warn if no stdout events for 120s
    let lastEventAt = Date.now();
    const stallTimer = setInterval(() => {
      const silent = Math.round((Date.now() - lastEventAt) / 1000);
      if (silent >= 120) {
        process.stderr.write(`\n⚠ ${AGENT_NAME}: no response for ${silent}s — may be stalled or rate-limited\n`);
        process.stderr.write(`  → Press s to skip, or Ctrl+C to abort\n\n`);
      }
    }, 30_000);

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        lastEventAt = Date.now();

        let event;
        try { event = JSON.parse(line); } catch { continue; }

        // codex exec --json event shapes:
        //   { type: 'thread.started', thread_id }
        //   { type: 'turn.started' }
        //   { type: 'item.started'   | 'item.updated' | 'item.completed', item: {...} }
        //   { type: 'turn.completed', usage: { input_tokens, cached_input_tokens, output_tokens } }
        //   { type: 'error', message }
        const t = event.type;

        if (t === 'item.completed' && event.item) {
          const item = event.item;
          if (item.type === 'agent_message' && item.text) {
            textParts.push(item.text);
            yield { type: 'assistant', content: item.text };
          } else if (item.type === 'command_execution') {
            const cmd = item.command ?? item.input?.command ?? '';
            yield { type: 'tool_use', tool: 'bash', input: { command: cmd } };
            const out = item.aggregated_output ?? item.output ?? '';
            if (out) {
              const short = out.length > 80 ? out.slice(0, 77) + '...' : out;
              yield { type: 'tool_use_summary', summary: short, output: String(out).slice(0, 2048) };
            }
          } else if (item.type === 'file_change') {
            yield { type: 'tool_use', tool: 'edit', input: { path: item.path ?? '' } };
          } else if (item.type === 'reasoning' && item.text) {
            // Surface reasoning as assistant content for visibility
            yield { type: 'assistant', content: item.text };
          }
        } else if (t === 'turn.completed' && event.usage) {
          const u = event.usage;
          yield {
            type: 'usage',
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: u.cached_input_tokens ?? 0,
            cost_usd: 0,
            model: resolvedModelID,
          };
        } else if (t === 'error') {
          yield { type: 'error', message: event.message || 'codex error' };
        }
      }

      const exitCode = await new Promise(resolve => proc.on('close', resolve));

      if (exitCode !== 0 && textParts.length === 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        yield { type: 'error', message: stderr || `codex exited with code ${exitCode}` };
      } else {
        const fullText = textParts.join('');
        if (fullText) yield { type: 'result', content: fullText };
        yield { type: 'system', subtype: 'complete', agent: AGENT_NAME };
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        yield { type: 'error', message: err.message || String(err) };
      }
    } finally {
      clearInterval(stallTimer);
      this.#proc = null;
    }
  }

  interrupt() {
    if (this.#proc) {
      try { this.#proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.#proc = null;
    }
  }

  get isRunning() {
    return this.#proc !== null;
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function _assertCodexModel(modelID) {
  if (!CODEX_MODEL_IDS.has(modelID)) {
    throw new Error(
      `CodexConnector: '${modelID}' is not a supported Codex model.\n` +
      `Supported models: ${[...CODEX_MODEL_IDS].join(', ')}`
    );
  }
}
