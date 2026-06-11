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
import { withComposeToken } from '../../lib/compose-api.js';

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
  const pendingOpsRef = useRef(new Map()); // id → patch, for snapshot overlay
  const pendingCreatesRef = useRef(new Map()); // tmpId → optimistic item, in-flight creates
  const pendingDeletesRef = useRef(new Set()); // ids with in-flight deletes
  const tmpCounterRef = useRef(0);

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
        if ((t === 'visionState' || t === 'hydrate') && Array.isArray(msg.items)) {
          // Server snapshot: replace items wholesale, then re-apply ALL in-flight
          // optimistic ops (edits, creates, deletes) so the UI doesn't flicker
          // back to server state while a mutation is still settling.
          setItems(() => {
            const pendingPatches = pendingOpsRef.current;
            const pendingCreates = pendingCreatesRef.current;
            const pendingDeletes = pendingDeletesRef.current;
            let next = msg.items;
            if (pendingPatches.size > 0) {
              next = next.map(item => {
                const patch = pendingPatches.get(item.id);
                return patch ? { ...item, ...patch } : item;
              });
            }
            if (pendingDeletes.size > 0) {
              next = next.filter(item => !pendingDeletes.has(item.id));
            }
            if (pendingCreates.size > 0) {
              const present = new Set(next.map(item => item.id));
              const missing = [...pendingCreates.values()].filter(it => !present.has(it.id));
              if (missing.length > 0) next = [...missing, ...next];
            }
            return next;
          });
        } else if (t === 'itemUpdated' && msg.item?.id) {
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

    // Register as pending so WS snapshots arriving mid-flight can overlay it
    pendingOpsRef.current.set(id, patch);

    const optimistic = prev.map((it) => it.id === id ? { ...it, ...patch } : it);
    setItems(optimistic);
    try {
      const res = await wsFetch(`/api/vision/items/${id}`, {
        method: 'PATCH',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // rollback and clear pending
        pendingOpsRef.current.delete(id);
        setItems(prev);
        return { ok: false, error: data?.error || `HTTP ${res.status}` };
      }
      // Settle: clear pending, merge server response if provided
      pendingOpsRef.current.delete(id);
      const serverItem = data?.item || data?.updated || null;
      if (serverItem && serverItem.id === id) {
        setItems((cur) => cur.map((it) => it.id === id ? { ...it, ...serverItem } : it));
      }
      return { ok: true, item: serverItem || optimistic.find((it) => it.id === id) };
    } catch (err) {
      pendingOpsRef.current.delete(id);
      setItems(prev);
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  /**
   * createItem(fields) — POST /api/vision/items with type:'feature' forced.
   * Optimistically prepends with a tmp-<counter> id, swaps to server id on 2xx,
   * removes on error.
   */
  const createItem = useCallback(async (fields) => {
    if (!fields || typeof fields !== 'object') return { ok: false, error: 'invalid fields' };
    const tmpId = `tmp-${++tmpCounterRef.current}`;
    const optimisticItem = { ...fields, type: 'feature', id: tmpId };
    pendingCreatesRef.current.set(tmpId, optimisticItem);
    setItems((prev) => [optimisticItem, ...prev]);
    try {
      const res = await wsFetch('/api/vision/items', {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...fields, type: 'feature' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        pendingCreatesRef.current.delete(tmpId);
        setItems((prev) => prev.filter((it) => it.id !== tmpId));
        return { ok: false, error: data?.error || `HTTP ${res.status}` };
      }
      // POST /api/vision/items returns the created item object directly
      // (vision-routes.js:91); tolerate a wrapped { item } shape too.
      const serverItem = data?.item || (data?.id ? data : null);
      pendingCreatesRef.current.delete(tmpId);
      setItems((prev) => {
        // If the WS snapshot already delivered the server item, just drop the tmp row.
        if (serverItem && prev.some((it) => it.id === serverItem.id)) {
          return prev.filter((it) => it.id !== tmpId);
        }
        return prev.map((it) => it.id === tmpId ? (serverItem ? { ...it, ...serverItem } : it) : it);
      });
      return { ok: true, item: serverItem };
    } catch (err) {
      pendingCreatesRef.current.delete(tmpId);
      setItems((prev) => prev.filter((it) => it.id !== tmpId));
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  /**
   * deleteItem(id) — optimistic removal, DELETE /api/vision/items/:id, rollback on error.
   */
  const deleteItem = useCallback(async (id) => {
    if (!id) return { ok: false, error: 'id required' };
    const prev = itemsRef.current;
    pendingDeletesRef.current.add(id);
    setItems((cur) => cur.filter((it) => it.id !== id));
    try {
      const res = await wsFetch(`/api/vision/items/${id}`, {
        method: 'DELETE',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        pendingDeletesRef.current.delete(id);
        setItems(prev);
        return { ok: false, error: data?.error || `HTTP ${res.status}` };
      }
      pendingDeletesRef.current.delete(id);
      return { ok: true };
    } catch (err) {
      pendingDeletesRef.current.delete(id);
      setItems(prev);
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  /**
   * addConnection({ fromId, toId, type }) — POST /api/vision/connections.
   * No optimistic item-state change; connections are sheet-local.
   */
  const addConnection = useCallback(async ({ fromId, toId, type }) => {
    try {
      const res = await wsFetch('/api/vision/connections', {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ fromId, toId, type }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
      return { ok: true, connection: data?.connection || data };
    } catch (err) {
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  /**
   * removeConnection(id) — DELETE /api/vision/connections/:id.
   */
  const removeConnection = useCallback(async (id) => {
    try {
      const res = await wsFetch(`/api/vision/connections/${id}`, {
        method: 'DELETE',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  /**
   * fetchItemDetail(id) — GET /api/vision/items/:id; returns { ok, item | error }.
   * Used by ItemDetailSheet for lazy connections load.
   */
  const fetchItemDetail = useCallback(async (id) => {
    try {
      const res = await wsFetch(`/api/vision/items/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
      return { ok: true, item: data };
    } catch (err) {
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  return { items, loading, error, connected, refetch, applyOptimisticEdit, createItem, deleteItem, addConnection, removeConnection, fetchItemDetail };
}
