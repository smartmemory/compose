/**
 * useAgentStream — React hook wrapping the pure agentStream.js consumer.
 *
 * Subscribes to /api/agent/stream and exposes the rolling event list (capped at
 * `max`). When `agentId` is provided, events are filtered to those whose payload
 * carries a matching agentId / agent_id / id field. The unfiltered consumer is
 * kept for AgentStream.jsx (desktop) which derives agent state from message
 * type + _source rather than agent id.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import { createAgentStream, defaultAgentStreamUrl } from '../lib/agentStream.js';

function payloadAgentId(p) {
  if (!p || typeof p !== 'object') return null;
  return p.agentId || p.agent_id || p.id || null;
}

export function useAgentStream({ url, agentId, max = 500, enabled = true } = {}) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const closedRef = useRef(null);

  const resolvedUrl = useMemo(() => url || defaultAgentStreamUrl(), [url]);

  useEffect(() => {
    if (!enabled || !resolvedUrl) return undefined;
    const handle = createAgentStream({
      url: resolvedUrl,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onEvent: (payload /*, name */) => {
        setEvents(prev => {
          const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
          next.push(payload);
          return next;
        });
      },
    });
    closedRef.current = handle;
    return () => {
      try { handle.close(); } catch { /* */ }
    };
  }, [resolvedUrl, enabled, max]);

  const filtered = useMemo(() => {
    if (!agentId) return events;
    return events.filter(e => {
      const id = payloadAgentId(e);
      return id === agentId;
    });
  }, [events, agentId]);

  return { events: filtered, allEvents: events, connected };
}
