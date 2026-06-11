/**
 * useLiveAgents — fetches GET /api/agents/tree, refreshes on /ws/vision
 * activity. Returns the spawned-agents list for the current session.
 *
 * Spawned agents are background subagents tracked by the registry; the
 * interactive session has its own surface (see useInteractiveSession).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';

async function apiJSON(url, opts = {}) {
  const res = await wsFetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function useLiveAgents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const data = await apiJSON('/api/agents/tree');
      if (!aliveRef.current) return;
      setAgents(Array.isArray(data?.agents) ? data.agents : []);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refetch();
    return () => { aliveRef.current = false; };
  }, [refetch]);

  // WS subscription — agent-related events broadcast on /ws/vision
  useEffect(() => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return undefined;
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;
          // Refetch on agent-tree-affecting events
          if (
            msg.type === 'agentSpawned' ||
            msg.type === 'agentStopped' ||
            msg.type === 'agentStatusChanged' ||
            msg.type === 'agentTreeUpdated'
          ) {
            refetch();
          }
        } catch { /* */ }
      },
    });
    return () => {
      try { handle.close(); } catch { /* */ }
    };
  }, [refetch]);

  return { agents, loading, error, refetch };
}
