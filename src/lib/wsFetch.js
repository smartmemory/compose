/**
 * wsFetch.js — workspace-aware, auth-aware fetch wrapper.
 *
 * COMP-WORKSPACE-HTTP T1:
 *   Wraps the global fetch() and injects the X-Compose-Workspace-Id header
 *   from a module-local id. Accepts both relative (/api/foo) and absolute
 *   (http://localhost:4001/api/foo) URLs — the URL is passed through to
 *   fetch unchanged; only the headers are augmented.
 *
 * The workspace id is set once at app boot by the WorkspaceProvider, after
 * it fetches GET /api/workspace.
 *
 * COMP-MOBILE-REMOTE S05:
 *   Central auth abstraction. A module-level mode ('cockpit' | 'mobile-paired')
 *   decides credential transport:
 *     - cockpit (default): attach x-compose-token whenever a sensitive token is
 *       set (inert on localhost where no token exists).
 *     - mobile-paired: refresh the access JWT before the request and attach it
 *       as Authorization: Bearer.
 *   The 401 ladder is keyed on the remote gate's distinctive body codes
 *   (TokenExpired/TokenInvalid), NOT on the mode — the mode may have just been
 *   dropped to legacy by a failed refresh, but a gate 401 still means this
 *   server demands pairing. Localhost (gate unmounted) and plain
 *   requireSensitiveToken 401s carry no `code`, so legacy mode on a non-remote
 *   server can never hit that branch.
 */

import {
  getValidAccessToken,
  getSensitiveToken,
  refreshAccessToken,
  injectAuthModeCallback,
} from './compose-api.js';

let _workspaceId = null;
let _mode = 'cockpit'; // 'cockpit' | 'mobile-paired'

// Register our mode setter with compose-api so refreshAccessToken's failure
// path can drop us to legacy mode without a circular import.
injectAuthModeCallback((mode) => { _mode = mode; });

export function setWorkspaceId(id) {
  _workspaceId = id ?? null;
}

export function getWorkspaceId() {
  return _workspaceId;
}

export function setAuthMode(mode) {
  _mode = mode;
}

export function getAuthMode() {
  return _mode;
}

export async function wsFetch(url, opts = {}) {
  if (_mode === 'mobile-paired') {
    // Ensure access token is fresh BEFORE the request. Refresh failure does
    // NOT redirect here — refreshAccessToken() has already dropped us to
    // legacy mode; the request proceeds with the sensitive-token headers and
    // only a remote-gate 401 below triggers the /m/pair redirect.
    try { await getValidAccessToken(); } catch { /* now in legacy mode */ }
  }

  const headers = { ...(opts.headers || {}) };
  if (_workspaceId) headers['X-Compose-Workspace-Id'] = _workspaceId;
  const tok = getSensitiveToken();
  if (tok) {
    if (_mode === 'mobile-paired') {
      headers['Authorization'] = `Bearer ${tok}`; // mobile path (access JWT)
    } else {
      headers['x-compose-token'] = tok; // cockpit path
    }
  }

  let r = await fetch(url, { ...opts, headers });

  // Keyed off the remote gate's distinctive body codes, NOT _mode.
  if (r.status === 401) {
    const body = await r.clone().json().catch(() => ({}));
    if (body.code === 'TokenExpired') {
      try {
        await refreshAccessToken(); // re-enters 'mobile-paired' on success
      } catch {
        // Gate demanded a JWT and we can't mint one — re-pair is the only path.
        window.location.href = '/m/pair';
        throw new Error('NeedsPairing');
      }
      r = await fetch(url, { ...opts, headers: { ...headers, Authorization: `Bearer ${getSensitiveToken()}` } });
    }
    if (r.status === 401) {
      const again = await r.clone().json().catch(() => ({}));
      if (again.code === 'TokenExpired' || again.code === 'TokenInvalid') {
        window.location.href = '/m/pair';
        throw new Error('NeedsPairing');
      }
      // 401 without a gate code: legacy sensitive-token failure — surface normally
    }
  }

  return r;
}
