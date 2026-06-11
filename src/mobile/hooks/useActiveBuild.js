/**
 * useActiveBuild — fetches GET /api/build/state, refreshes on /ws/vision
 * `buildState` notifications, and exposes startBuild / abortBuild mutations
 * that hit the sensitive endpoints with x-compose-token.
 *
 * Returns { active, loading, error, startBuild, abortBuild, refetch }.
 *   active      — the most recent active-build.json contents (or null)
 *   startBuild  — ({ featureCode, mode, description }) => Promise<result>
 *   abortBuild  — ({ featureCode }) => Promise<result>
 *
 * Concurrency note (mirrors blueprint M5): runBuild allows different-feature
 * builds to run concurrently; active-build.json is last-writer-wins, so this
 * surfaces "the most recent active build" by design.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';
import { withComposeToken } from '../../lib/compose-api.js';
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';

async function apiJSON(url, opts = {}) {
  const res = await wsFetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function useActiveBuild() {
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const data = await apiJSON('/api/build/state');
      if (!aliveRef.current) return;
      setActive(data?.state ?? null);
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

  // WS subscription — server broadcasts { type: 'buildState', ...state } when
  // active-build.json changes (server/index.js → fileWatcher.onBuildStateChanged).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return undefined;
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;
          if (msg.type === 'buildState') {
            // Refetch authoritative state (broadcast may be partial).
            refetch();
          }
        } catch { /* */ }
      },
    });
    return () => {
      try { handle.close(); } catch { /* */ }
    };
  }, [refetch]);

  const startBuild = useCallback(async ({ featureCode, mode = 'feature', description = '' } = {}) => {
    if (!featureCode) throw new Error('featureCode required');
    const data = await apiJSON('/api/build/start', {
      method: 'POST',
      headers: withComposeToken({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ featureCode, mode, description }),
    });
    refetch();
    return data;
  }, [refetch]);

  const abortBuild = useCallback(async ({ featureCode } = {}) => {
    if (!featureCode) throw new Error('featureCode required');
    const data = await apiJSON('/api/build/abort', {
      method: 'POST',
      headers: withComposeToken({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ featureCode }),
    });
    refetch();
    return data;
  }, [refetch]);

  return { active, loading, error, refetch, startBuild, abortBuild };
}
