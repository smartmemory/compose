/**
 * ts-agent-harness.js — Test-only agent harness for TS runtime goldens.
 * Accepts an `agentFactory(agentType, opts)` returning an object with
 * an async-generator `run(prompt)` that yields `{type: 'assistant'|'tool_use'
 * |'tool_use_summary'|'usage'|'error'|'result', ...}` events.
 *
 * It dispatches test events through StratumMcpClient's TS onEvent pathway.
 */

import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { resolveStratumMcpConnection } from '../../lib/stratum-engine.js';

/**
 * Install fake `agentRun`, `runAgentText`, `cancelAgentRun` methods on a
 * StratumMcpClient instance backed by a test agent factory.
 *
 * @param {object} stratum         - StratumMcpClient (uses its #dispatchEvent path indirectly via internal subscribers).
 * @param {Function} factory       - `factory(agentType, opts)` returning {run(prompt), interrupt(), isRunning}
 * @param {string}   defaultCwd
 */
export function installAgentHarness(stratum, factory, defaultCwd) {
  // We dispatch via the public onEvent subscribers map. There's no public
  // emit method, so we synthesize the same JSON-string-via-progress path the
  // real client uses by directly invoking subscribed handlers.
  function emit(correlationId, kind, metadata, seq) {
    // Replicate the dispatch path: lookup `${flow}::${step}` subscribers and
    // hand them a parsed envelope. This mirrors `#dispatchEvent` (private)
    // but works against the public `onEvent` registry implicitly because we
    // only run inside a single tool-call lifecycle.
    const env = {
      schema_version: '0.2.5',
      flow_id: correlationId,
      step_id: '_agent_run',
      task_id: null,
      seq,
      ts: new Date().toISOString(),
      kind,
      metadata,
    };
    // Lean on the stratum client's existing #makeProgressHandler-style path:
    // re-encode and feed via a shadow handler is overkill — we instead reach
    // into the onEvent subscribers via a dispatch closure attached on first
    // install.
    if (!stratum._shimDispatch) {
      // Fallback: directly walk subscribers if dispatch closure not wired.
      // Here we expose a temporary dispatcher by hijacking onEvent's contract:
      // each subscribe call adds to a map; we mirror lookups via a private
      // tracker. The simpler approach is to wrap `onEvent` to also register
      // with our own map. Done at install time below.
    }
    stratum._shimDispatch(env);
  }

  // Wrap onEvent to keep a parallel registry we can dispatch into.
  if (!stratum._shimSubs) {
    const subs = new Map();
    stratum._shimSubs = subs;
    const realOnEvent = stratum.onEvent.bind(stratum);
    stratum.onEvent = (flowId, stepId, handler) => {
      const key = `${flowId}::${stepId}`;
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(handler);
      const realUnsub = realOnEvent(flowId, stepId, handler);
      return () => {
        const s = subs.get(key);
        if (s) { s.delete(handler); if (s.size === 0) subs.delete(key); }
        realUnsub();
      };
    };
    stratum._shimDispatch = (env) => {
      const set = subs.get(`${env.flow_id}::${env.step_id}`);
      if (!set) return;
      for (const h of set) {
        try { h(env); } catch (err) { console.error('[shim] handler threw:', err); }
      }
    };
  }

  stratum.agentRun = async (agentType, prompt, agentOpts = {}) => {
    const correlationId = agentOpts.correlationId ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const connector = factory(agentType, { cwd: agentOpts.cwd ?? defaultCwd });
    const parts = [];
    let seq = 0;
    let interruptHook = null;
    if (typeof connector.interrupt === 'function') {
      interruptHook = () => { try { connector.interrupt(); } catch { /* best-effort */ } };
    }
    // Hook for cancelAgentRun: stash the interrupt function under correlationId.
    if (!stratum._shimInterrupts) stratum._shimInterrupts = new Map();
    if (interruptHook) stratum._shimInterrupts.set(correlationId, interruptHook);
    try {
      for await (const ev of connector.run(prompt, {})) {
        if (ev.type === 'assistant' && ev.content) {
          parts.push(ev.content);
          stratum._shimDispatch({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run', task_id: null,
            seq: seq++, ts: new Date().toISOString(),
            kind: 'agent_relay',
            metadata: { role: 'assistant', text: ev.content },
          });
        } else if (ev.type === 'result' && ev.content && parts.length === 0) {
          parts.push(ev.content);
          stratum._shimDispatch({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run', task_id: null,
            seq: seq++, ts: new Date().toISOString(),
            kind: 'agent_relay',
            metadata: { role: 'assistant', text: ev.content },
          });
        } else if (ev.type === 'tool_use' && ev.tool) {
          stratum._shimDispatch({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run', task_id: null,
            seq: seq++, ts: new Date().toISOString(),
            kind: 'tool_use_summary',
            metadata: { tool: ev.tool, input: ev.input ?? {}, summary: '', output: '' },
          });
        } else if (ev.type === 'tool_use_summary') {
          stratum._shimDispatch({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run', task_id: null,
            seq: seq++, ts: new Date().toISOString(),
            kind: 'tool_use_summary',
            metadata: { tool: ev.tool ?? '', input: ev.input ?? {}, summary: ev.summary ?? '', output: ev.output ?? '' },
          });
        } else if (ev.type === 'usage') {
          stratum._shimDispatch({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run', task_id: null,
            seq: seq++, ts: new Date().toISOString(),
            kind: 'step_usage',
            metadata: {
              input_tokens: ev.input_tokens ?? 0,
              output_tokens: ev.output_tokens ?? 0,
              cache_creation_input_tokens: ev.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: ev.cache_read_input_tokens ?? 0,
              cost_usd: ev.cost_usd ?? null,
              model: ev.model ?? null,
            },
          });
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    } finally {
      stratum._shimInterrupts?.delete(correlationId);
    }
    return { text: parts.join(''), correlation_id: correlationId };
  };

  stratum.runAgentText = async (agentType, prompt, agentOpts = {}) => {
    const r = await stratum.agentRun(agentType, prompt, agentOpts);
    return r.text;
  };

  stratum.cancelAgentRun = async (correlationId) => {
    const hook = stratum._shimInterrupts?.get(correlationId);
    if (hook) hook();
    return { status: hook ? 'cancelled' : 'not_found', correlation_id: correlationId };
  };

  // V2/V3: CONTROLLED claude executions run via the compose-local connector,
  // which consumes an SDK-shaped message stream (query({prompt, options})).
  // Adapt the same legacy factory to that stream so the goldens drive the local
  // path (tool restrictions + abort) without spawning a real claude. Honors the
  // per-call cwd (the item worktree) and the abort signal.
  stratum._localQuery = ({ prompt, options }) => {
    const cwd = options?.cwd ?? defaultCwd;
    const signal = options?.abortController?.signal;
    const connector = factory('claude', { cwd });
    return (async function* sdkStream() {
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      for await (const ev of connector.run(prompt, {})) {
        if (signal?.aborted) throw new DOMException('local agent aborted', 'AbortError');
        if ((ev.type === 'assistant' || ev.type === 'result') && ev.content) {
          text += ev.content;
          yield { type: 'assistant', message: { content: [{ type: 'text', text: ev.content }] } };
        } else if (ev.type === 'tool_use' || ev.type === 'tool_use_summary') {
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: ev.tool, input: ev.input ?? {} }] } };
        } else if (ev.type === 'usage') {
          inputTokens += ev.input_tokens ?? 0;
          outputTokens += ev.output_tokens ?? 0;
          costUsd += ev.cost_usd ?? 0;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      yield {
        type: 'result', subtype: 'success', result: text,
        total_cost_usd: costUsd, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, duration_ms: 1,
      };
    })();
  };
}

/** Run build code with a live TS engine and a test-only agent implementation. */
export async function runBuildWithAgentFactory(runBuild, featureCode, options) {
  const { connectorFactory, ...runtimeOptions } = options;
  if (!connectorFactory) return runBuild(featureCode, runtimeOptions);
  const stratum = new StratumMcpClient();
  await stratum.connect(resolveStratumMcpConnection(runtimeOptions.cwd));
  installAgentHarness(stratum, connectorFactory, runtimeOptions.cwd);
  try {
    return await runBuild(featureCode, { ...runtimeOptions, stratum });
  } finally {
    await stratum.close();
  }
}
