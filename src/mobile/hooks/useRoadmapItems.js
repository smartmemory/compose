/**
 * useRoadmapItems — mobile roadmap data hook.
 *
 * Responsibilities:
 *   - Initial GET /api/vision/items hydration
 *   - Subscribe to /ws/vision via createReconnectingWS for live updates
 *   - Optimistic PATCH /api/vision/items/:id with rollback on error
 *
 * The WS message protocol mirrors the desktop store: messages are JSON with a
 * `type`. We listen specifically for item-level events (`itemUpdated`,
 * `itemCreated`, `itemDeleted`, and full `state` snapshots) and refetch on
 * anything we don't recognize but that suggests vision changed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';
import { createReconnectingWS } from '../../lib/wsReconnect.js';

function visionWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/vision`;
}

export function useRoadmapItems() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refetch = useCallback(async () => {
    try {
      const res = await wsFetch('/api/vision/items');
      const data = await res.json();
      const next = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      setItems(next);
      setError(null);
    } catch (err) {
      setError(err?.message || 'Failed to load items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    refetch();
    const handle = createReconnectingWS({
      url: visionWsUrl(),
      onOpen: () => { if (!disposed) setConnected(true); },
      onClose: () => { if (!disposed) setConnected(false); },
      onMessage: (ev) => {
        if (disposed) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        const t = msg.type;
        if (t === 'itemUpdated' && msg.item?.id) {
          setItems((prev) => {
            const idx = prev.findIndex((it) => it.id === msg.item.id);
            if (idx === -1) return [...prev, msg.item];
            const next = prev.slice();
            next[idx] = { ...next[idx], ...msg.item };
            return next;
          });
        } else if (t === 'itemCreated' && msg.item?.id) {
          setItems((prev) => prev.some((it) => it.id === msg.item.id) ? prev : [...prev, msg.item]);
        } else if (t === 'itemDeleted' && msg.id) {
          setItems((prev) => prev.filter((it) => it.id !== msg.id));
        } else if (t === 'state' && Array.isArray(msg.items)) {
          setItems(msg.items);
        } else if (t === 'visionUpdated' || t === 'roadmapUpdated') {
          refetch();
        }
      },
    });
    return () => {
      disposed = true;
      try { handle.close(); } catch { /* ignore */ }
    };
  }, [refetch]);

  /**
   * Apply an optimistic patch locally, then PATCH the server.
   * On server error, roll back to the previous snapshot.
   * Returns { ok: true, item } on success or { ok: false, error } on failure.
   */
  const applyOptimisticEdit = useCallback(async (id, patch) => {
    if (!id || !patch || typeof patch !== 'object') {
      return { ok: false, error: 'invalid patch' };
    }
    const prev = itemsRef.current;
    const beforeItem = prev.find((it) => it.id === id);
    if (!beforeItem) return { ok: false, error: 'item not found' };
    const optimistic = prev.map((it) => it.id === id ? { ...it, ...patch } : it);
    setItems(optimistic);
    try {
      const res = await wsFetch(`/api/vision/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // rollback
        setItems(prev);
        return { ok: false, error: data?.error || `HTTP ${res.status}` };
      }
      // Merge server response if it returned the canonical item
      const serverItem = data?.item || data?.updated || null;
      if (serverItem && serverItem.id === id) {
        setItems((cur) => cur.map((it) => it.id === id ? { ...it, ...serverItem } : it));
      }
      return { ok: true, item: serverItem || optimistic.find((it) => it.id === id) };
    } catch (err) {
      setItems(prev);
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  return { items, loading, error, connected, refetch, applyOptimisticEdit };
}
