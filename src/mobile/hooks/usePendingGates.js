/**
 * usePendingGates — fetches GET /api/vision/gates, refreshes on /ws/vision
 * `gateCreated`/`gateResolved` notifications. Returns the pending gates list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

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

export function usePendingGates() {
  const [gates, setGates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const data = await apiJSON('/api/vision/gates');
      if (!aliveRef.current) return;
      setGates(Array.isArray(data?.gates) ? data.gates : []);
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

  useEffect(() => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return undefined;
    let ws = null;
    let stopped = false;
    let reconnectTimer = null;

    function connect() {
      if (stopped) return;
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws/vision`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;
          if (msg.type === 'gateCreated' || msg.type === 'gateResolved' || msg.type === 'gateUpdated') {
            refetch();
          }
        } catch { /* */ }
      };
      ws.onclose = () => { if (!stopped) scheduleReconnect(); };
      ws.onerror = () => { try { ws.close(); } catch { /* */ } };
    }

    function scheduleReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { if (ws) { ws.onclose = null; ws.close(); } } catch { /* */ }
    };
  }, [refetch]);

  // Mutation: resolve via outcome enum approve|revise|kill
  const resolve = useCallback(async (id, { outcome, reason, summary } = {}) => {
    if (!['approve', 'revise', 'kill'].includes(outcome)) {
      throw new Error(`outcome must be approve|revise|kill (got ${outcome})`);
    }
    // Server-side body: { outcome, comment, resolvedBy }. We map the UI's
    // "reason" + optional "summary" into the comment field.
    const commentParts = [];
    if (reason) commentParts.push(reason);
    if (summary) commentParts.push(summary);
    const comment = commentParts.join(' — ') || undefined;
    const body = { outcome };
    if (comment) body.comment = comment;
    const data = await apiJSON(`/api/vision/gates/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    refetch();
    return data;
  }, [refetch]);

  return { gates, loading, error, refetch, resolve };
}
