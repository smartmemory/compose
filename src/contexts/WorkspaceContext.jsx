/**
 * WorkspaceContext.jsx — React provider for the active workspace.
 *
 * COMP-WORKSPACE-HTTP T1:
 *   On mount, fetches GET /api/workspace, stores {id, root} in state, and
 *   calls setWorkspaceId(id) so subsequent wsFetch() calls carry the
 *   X-Compose-Workspace-Id header.
 *
 * Surfaced state:
 *   { loading, error, workspace }
 *
 *   - loading: true until the bootstrap request settles
 *   - error:   Error instance if the bootstrap request fails, else null
 *   - workspace: { id, root, source } from the server, else null
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { setWorkspaceId } from '../lib/wsFetch.js';

const WorkspaceContext = createContext({
  loading: true,
  error: null,
  workspace: null,
});

export function WorkspaceProvider({ children }) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    workspace: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspace')
      .then((r) => {
        if (!r.ok) throw new Error(`GET /api/workspace failed: ${r.status}`);
        return r.json();
      })
      .then((ws) => {
        if (cancelled) return;
        setWorkspaceId(ws?.id ?? null);
        setState({ loading: false, error: null, workspace: ws });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, error: err, workspace: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <WorkspaceContext.Provider value={state}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
