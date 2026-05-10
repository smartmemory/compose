/**
 * useIdeas — mobile-only hook for the ideabox.
 *
 * Fetches GET /api/ideabox via wsFetch; subscribes to /ws/vision and re-fetches
 * on `ideaboxUpdated`. Mutations are optimistic and roll back on error. Errors
 * surface via a lightweight toast queue exposed by the hook.
 *
 * Priority is stored server-side as 'P0' | 'P1' | 'P2' | '—'. The UI label
 * "Untriaged" maps to the dash.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

export const UNTRIAGED = '—';

async function apiJSON(url, opts = {}) {
  const res = await wsFetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function useIdeas() {
  const [ideas, setIdeas] = useState([]);
  const [killed, setKilled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toasts, setToasts] = useState([]);

  const ideasRef = useRef(ideas);
  ideasRef.current = ideas;

  const pushToast = useCallback((kind, message) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts(ts => [...ts, { id, kind, message }]);
    setTimeout(() => {
      setToasts(ts => ts.filter(t => t.id !== id));
    }, 3500);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts(ts => ts.filter(t => t.id !== id));
  }, []);

  const refetch = useCallback(async () => {
    try {
      const data = await apiJSON('/api/ideabox');
      setIdeas(Array.isArray(data?.ideas) ? data.ideas : []);
      setKilled(Array.isArray(data?.killed) ? data.killed : []);
      setError(null);
    } catch (err) {
      setError(err.message);
      pushToast('error', `Failed to load ideas: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  // Initial fetch
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await refetch();
    })();
    return () => { alive = false; };
  }, [refetch]);

  // WS subscription to /ws/vision
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
          if (msg && msg.type === 'ideaboxUpdated') {
            refetch();
          }
        } catch { /* ignore */ }
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

  // ── Mutations (optimistic) ────────────────────────────────────────────────

  const createIdea = useCallback(async ({ title, description, source, tags, cluster }) => {
    if (!title || !title.trim()) {
      const err = new Error('title is required');
      pushToast('error', err.message);
      throw err;
    }
    const tempId = `tmp_${Date.now()}`;
    const optimistic = {
      id: tempId,
      num: 0,
      title: title.trim(),
      description: description || '',
      source: source || '',
      tags: Array.isArray(tags) ? tags : [],
      cluster: cluster || null,
      status: 'NEW',
      priority: UNTRIAGED,
      _pending: true,
    };
    setIdeas(prev => [optimistic, ...prev]);
    try {
      const created = await apiJSON('/api/ideabox/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description, source, tags, cluster }),
      });
      // Replace optimistic with real (and let WS refetch reconcile shortly)
      setIdeas(prev => prev.map(i => (i.id === tempId ? { ...created } : i)));
      pushToast('ok', 'Idea captured');
      return created;
    } catch (err) {
      setIdeas(prev => prev.filter(i => i.id !== tempId));
      pushToast('error', `Capture failed: ${err.message}`);
      throw err;
    }
  }, [pushToast]);

  const promote = useCallback(async (id, { featureCode } = {}) => {
    const before = ideasRef.current;
    // Optimistic: tag as PROMOTED locally; WS refetch will reconcile to canonical
    setIdeas(prev => prev.map(i => (i.id === id ? { ...i, _promoting: true } : i)));
    try {
      const result = await apiJSON(`/api/ideabox/ideas/${encodeURIComponent(id)}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureCode: featureCode || '' }),
      });
      pushToast('ok', `Promoted${result?.featureCode ? ` → ${result.featureCode}` : ''}`);
      // refetch to pick up canonical status string
      refetch();
      return result;
    } catch (err) {
      setIdeas(before);
      pushToast('error', `Promote failed: ${err.message}`);
      throw err;
    }
  }, [pushToast, refetch]);

  const kill = useCallback(async (id, { reason } = {}) => {
    const before = ideasRef.current;
    // Optimistic: remove from active list
    const target = before.find(i => i.id === id);
    setIdeas(prev => prev.filter(i => i.id !== id));
    if (target) setKilled(prev => [{ ...target, status: 'KILLED', reason: reason || '' }, ...prev]);
    try {
      const result = await apiJSON(`/api/ideabox/ideas/${encodeURIComponent(id)}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || '' }),
      });
      pushToast('ok', 'Idea killed');
      refetch();
      return result;
    } catch (err) {
      setIdeas(before);
      // Rollback killed list — drop the just-added entry
      setKilled(prev => prev.filter(i => i.id !== id || i.status !== 'KILLED'));
      pushToast('error', `Kill failed: ${err.message}`);
      throw err;
    }
  }, [pushToast, refetch]);

  const setPriority = useCallback(async (id, priority) => {
    const valid = ['P0', 'P1', 'P2', UNTRIAGED];
    if (!valid.includes(priority)) {
      const err = new Error(`Invalid priority: ${priority}`);
      pushToast('error', err.message);
      throw err;
    }
    const before = ideasRef.current;
    setIdeas(prev => prev.map(i => (i.id === id ? { ...i, priority } : i)));
    try {
      const updated = await apiJSON(`/api/ideabox/ideas/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      pushToast('ok', `Priority → ${priority === UNTRIAGED ? 'Untriaged' : priority}`);
      return updated;
    } catch (err) {
      setIdeas(before);
      pushToast('error', `Set priority failed: ${err.message}`);
      throw err;
    }
  }, [pushToast]);

  return {
    ideas,
    killed,
    loading,
    error,
    toasts,
    dismissToast,
    refetch,
    createIdea,
    promote,
    kill,
    setPriority,
  };
}
