/**
 * connector-factory-shim.js — Backward-compatibility adapter for tests that
 * pass a legacy `connectorFactory(agentType, opts)` returning an object with
 * an async-generator `run(prompt)` that yields `{type: 'assistant'|'tool_use'
 * |'tool_use_summary'|'usage'|'error'|'result', ...}` events.
 *
 * After STRAT-DEDUP-AGENTRUN-V3 the consumer pipeline calls
 * `stratum.agentRun(...)` and consumes BuildStreamEvent envelopes via
 * `stratum.onEvent(correlationId, '_agent_run', handler)`. This shim adapts
 * the legacy factory to dispatch envelopes through the StratumMcpClient's
 * onEvent pathway so existing tests continue to assert wire-level behavior.
 *
 * Used only when `opts.stratum` is NOT injected directly. Production paths
 * never instantiate this shim.
 */

/**
 * Install fake `agentRun`, `runAgentText`, `cancelAgentRun` methods on a
 * StratumMcpClient instance backed by a legacy connector factory.
 *
 * @param {object} stratum         - StratumMcpClient (uses its #dispatchEvent path indirectly via internal subscribers).
 * @param {Function} factory       - legacy `factory(agentType, opts)` returning {run(prompt), interrupt(), isRunning}
 * @param {string}   defaultCwd
 */
export function installFactoryShim(stratum, factory, defaultCwd) {
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
}
