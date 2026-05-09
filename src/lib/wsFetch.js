/**
 * wsFetch.js — workspace-aware fetch wrapper.
 *
 * COMP-WORKSPACE-HTTP T1:
 *   Wraps the global fetch() and injects the X-Compose-Workspace-Id header
 *   from a module-local id. Accepts both relative (/api/foo) and absolute
 *   (http://localhost:4001/api/foo) URLs — the URL is passed through to
 *   fetch unchanged; only the headers are augmented.
 *
 * The workspace id is set once at app boot by the WorkspaceProvider, after
 * it fetches GET /api/workspace.
 */

let _workspaceId = null;

export function setWorkspaceId(id) {
  _workspaceId = id ?? null;
}

export function getWorkspaceId() {
  return _workspaceId;
}

export function wsFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (_workspaceId) headers['X-Compose-Workspace-Id'] = _workspaceId;
  return fetch(url, { ...opts, headers });
}
