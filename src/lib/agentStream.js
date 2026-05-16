/**
 * agentStream.js — pure SSE consumer for the global /api/agent/stream endpoint.
 *
 * No React, no DOM beyond `EventSource`. Subscribers receive parsed JSON event
 * payloads via `onEvent(data, eventName)`. Reconnects with exponential backoff.
 *
 * The agent stream is *global* — the server multiplexes events from spawned
 * agents and the interactive session into a single SSE feed. Consumers that
 * only want one agent's events should filter by `agentId`/`agent_id` in the
 * payload themselves (see `useAgentStream` for an example).
 */

const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

/**
 * @param {object} opts
 * @param {string} opts.url                    — full SSE URL (e.g. http://host:4002/api/agent/stream)
 * @param {(payload:any, eventName:string) => void} [opts.onEvent]
 * @param {() => void}                              [opts.onOpen]
 * @param {() => void}                              [opts.onClose]
 * @param {(err:Error) => void}                     [opts.onError]
 * @param {(info:{attempt:number, maxRetries:number, nextBackoffMs:number}) => void} [opts.onRetry] — called on each retry attempt so UIs can show progress
 * @param {(info:{elapsedMs:number}) => void}        [opts.onStall] — called when no data arrives within stallTimeoutMs
 * @param {string[]}                                [opts.namedEvents] extra named SSE events to subscribe to (e.g. 'hydrate')
 * @param {number}                                  [opts.maxBackoffMs]
 * @param {number}                                  [opts.maxRetries] — max consecutive reconnect attempts before giving up (default 5)
 * @param {number}                                  [opts.stallTimeoutMs] — ms with no data before onStall fires (default 30000)
 * @returns {{ close: () => void }}
 */
export function createAgentStream({
  url,
  onEvent,
  onOpen,
  onClose,
  onError,
  onRetry,
  onStall,
  namedEvents = ['hydrate'],
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
}) {
  if (!url) throw new Error('createAgentStream: url is required');
  if (typeof EventSource === 'undefined') {
    // SSR / non-browser — return a no-op handle so tests don't blow up.
    return { close() {} };
  }

  let es = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;
  let stallTimer = null;
  let stalled = false;

  function resetStallTimer() {
    stalled = false;
    if (stallTimer) clearTimeout(stallTimer);
    if (stopped) return;
    stallTimer = setTimeout(() => {
      stalled = true;
      onStall?.({ elapsedMs: stallTimeoutMs });
    }, stallTimeoutMs);
  }

  function clearStallTimer() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    stalled = false;
  }

  function dispatch(eventName, raw) {
    // Any incoming data resets the stall timer
    resetStallTimer();
    if (!onEvent) return;
    try {
      const payload = JSON.parse(raw);
      onEvent(payload, eventName);
    } catch {
      // ignore parse errors so a malformed event can't kill the stream
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;

    // If we've exhausted retries, report final error and stop
    if (attempt >= maxRetries) {
      const err = new Error(`agent-stream: failed after ${maxRetries} retries`);
      onError?.(err);
      onClose?.();
      clearStallTimer();
      return;
    }

    const backoff = Math.min(maxBackoffMs, 1000 * Math.pow(2, attempt));
    attempt += 1;

    // Notify UI of retry attempt immediately
    onRetry?.({ attempt, maxRetries, nextBackoffMs: backoff });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
  }

  function connect() {
    if (stopped) return;
    try {
      es = new EventSource(url);
    } catch (err) {
      onError?.(err);
      scheduleReconnect();
      return;
    }

    es.onopen = () => {
      attempt = 0;
      stalled = false;
      resetStallTimer();
      onOpen?.();
    };

    es.onmessage = (ev) => dispatch('message', ev.data);
    for (const name of namedEvents) {
      es.addEventListener(name, (ev) => dispatch(name, ev.data));
    }

    es.onerror = (ev) => {
      // Surface the error to the UI immediately — don't swallow it during retries
      onError?.(ev instanceof Error ? ev : new Error('agent-stream error'));
      try { es?.close(); } catch { /* */ }
      es = null;
      onClose?.();
      scheduleReconnect();
    };
  }

  connect();

  return {
    close() {
      stopped = true;
      clearStallTimer();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try { es?.close(); } catch { /* */ }
      es = null;
    },
  };
}

/**
 * Default URL builder for the agent stream — assumes the agent-server runs on
 * AGENT_PORT (default 4002) on the same hostname as the page.
 */
export function defaultAgentStreamUrl() {
  if (typeof window === 'undefined' || !window.location) return '';
  const port = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AGENT_PORT) || '4002';
  return `${window.location.protocol}//${window.location.hostname}:${port}/api/agent/stream`;
}
