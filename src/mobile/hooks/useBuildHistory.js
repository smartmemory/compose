/**
 * useBuildHistory — fetches GET /api/builds?limit=N.
 *
 * Refetch triggers:
 * - Mount (initial load)
 * - When isTerminalBuildStatus(active?.status) becomes true for a flowId not
 *   yet seen as terminal (tracks via a ref Map)
 * - If after a terminal-triggered refetch the active flowId is not present in
 *   the returned builds array, schedules exactly one retry after 2500ms
 *   (cleared on unmount)
 *
 * Corrective health-gate alert:
 * - When a history entry arrives whose status is 'failed' but the
 *   active-build terminal status we last observed for that flowId was
 *   'complete'/'completed', fires notify(`Build failed post-checks: <code>`, 'error', 0)
 * - Does NOT fire when the statuses agree
 *
 * Returns { builds, loading, error, refetch }
 *
 * COMP-MOBILE-1 S02
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';
import { isTerminalBuildStatus } from '../../lib/pipeline-steps.js';
import { notify } from '../../components/cockpit/NotificationBar.jsx';

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

// Set of terminal statuses that come from active-build.json (the "complete"
// side before the health gate may downgrade it to "failed" in history)
const ACTIVE_COMPLETE_STATUSES = new Set(['complete', 'completed']);

export function useBuildHistory({ active, limit = 20 } = {}) {
  const [builds, setBuilds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ref Map: flowId → terminal status we first saw on the active build object
  const seenTerminalRef = useRef(new Map());
  // ref Map: flowId → terminal status we last alerted for (corrective-alert dedup)
  const alertedRef = useRef(new Map());

  const aliveRef = useRef(true);
  const retryTimerRef = useRef(null);

  // Shared settle path: store the list AND run the corrective health-gate
  // alert check. Must run on every fetch that lands (initial, terminal-
  // triggered, and the 2.5s retry) — the downgrade row may only appear on
  // the retry.
  const processList = useCallback((list) => {
    setBuilds(list);
    setError(null);
    // Corrective health-gate alert check:
    // If active-build said "complete" but history says "failed" for same flowId
    for (const entry of list) {
      const fid = entry.flowId;
      if (!fid) continue;
      const activeTerminal = seenTerminalRef.current.get(fid);
      if (!activeTerminal) continue;
      // Only alert if active said complete but history says failed
      if (
        ACTIVE_COMPLETE_STATUSES.has(activeTerminal) &&
        entry.status === 'failed' &&
        alertedRef.current.get(fid) !== entry.status
      ) {
        alertedRef.current.set(fid, entry.status);
        try {
          notify(`Build failed post-checks: ${entry.featureCode}`, 'error', 0);
        } catch { /* notify may not exist in test env */ }
      }
    }
  }, []);

  const refetch = useCallback(async ({ pendingFlowId } = {}) => {
    try {
      const data = await apiJSON(`/api/builds?limit=${limit}`);
      if (!aliveRef.current) return;

      const list = Array.isArray(data?.builds) ? data.builds : [];
      processList(list);

      // Retry logic: if a terminal-triggered refetch didn't surface the flowId
      if (pendingFlowId) {
        const found = list.some(b => b.flowId === pendingFlowId);
        if (!found) {
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(async () => {
            if (!aliveRef.current) return;
            try {
              const d2 = await apiJSON(`/api/builds?limit=${limit}`);
              if (!aliveRef.current) return;
              const l2 = Array.isArray(d2?.builds) ? d2.builds : [];
              processList(l2);
            } catch (err2) {
              if (aliveRef.current) setError(err2.message);
            }
          }, 2500);
        }
      }
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [limit, processList]);

  // Mount fetch
  useEffect(() => {
    aliveRef.current = true;
    refetch();
    return () => {
      aliveRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [refetch]);

  // Terminal-transition watch: when active.status becomes terminal for a new flowId
  const prevActiveRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;

    const fid = active.flowId;
    if (!fid) return;

    const isNowTerminal = isTerminalBuildStatus(active.status);
    if (!isNowTerminal) return;

    // Only trigger once per flowId reaching terminal
    if (seenTerminalRef.current.has(fid)) return;

    // Record the terminal status we saw from the active-build
    seenTerminalRef.current.set(fid, active.status);

    // Refetch, passing pendingFlowId so we can schedule a retry if missing
    refetch({ pendingFlowId: fid });
  }, [active, refetch]);

  return { builds, loading, error, refetch };
}
