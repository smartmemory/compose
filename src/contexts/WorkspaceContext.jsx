/**
 * WorkspaceContext.jsx — React provider for the active workspace.
 *
 * COMP-WORKSPACE-HTTP T1:
 *   On mount, fetches GET /api/workspace, stores {id, root} in state, and
 *   calls setWorkspaceId(id) so subsequent wsFetch() calls carry the
 *   X-Compose-Workspace-Id header.
 *
 *   Exposes refresh() so callers can re-fetch after a project switch
 *   (POST /api/project/switch) — the cached id would otherwise go stale.
 *
 * Surfaced state:
 *   { loading, error, workspace, refresh }
 *
 *   - loading: true until the bootstrap request settles
 *   - error:   Error instance if the bootstrap request fails, else null
 *   - workspace: { id, root, source } from the server, else null
 *   - refresh: () => Promise<void>; re-fetches /api/workspace and updates cache
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { setWorkspaceId } from '../lib/wsFetch.js';
import { setRemoteMode } from '../lib/wsUrl.js';

const WorkspaceContext = createContext({
  loading: true,
  error: null,
  workspace: null,
  refresh: async () => {},
});

export function WorkspaceProvider({ children }) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    workspace: null,
  });
  const cancelledRef = useRef(false);

  const fetchWorkspace = useCallback(async () => {
    try {
      const r = await fetch('/api/workspace');
      if (!r.ok) throw new Error(`GET /api/workspace failed: ${r.status}`);
      const ws = await r.json();
      if (cancelledRef.current) return;
      setWorkspaceId(ws?.id ?? null);
      setState({ loading: false, error: null, workspace: ws });
      // COMP-MOBILE-REMOTE: detect a remote-bound server so WS/SSE URL
      // builders switch to token-carrying form (desktop served via tunnel).
      // Best-effort — failures leave remote mode off (localhost default).
      try {
        const h = await fetch('/api/health');
        const hj = await h.json().catch(() => ({}));
        if (!cancelledRef.current && hj?.remote === true) setRemoteMode(true);
      } catch { /* gate off / older server — stay local */ }
    } catch (err) {
      if (cancelledRef.current) return;
      setState({ loading: false, error: err, workspace: null });
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchWorkspace();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchWorkspace]);

  return (
    <WorkspaceContext.Provider value={{ ...state, refresh: fetchWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
