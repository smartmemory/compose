import { wsFetch } from './wsFetch.js';
import { withComposeToken } from './compose-api.js';

/**
 * startBuild — shared build-dispatch helper (COMP-COCKPIT-7).
 *
 * Extracted from StartBuildPopover so the Past Builds retry button and the
 * popover share one POST /api/build/start path (wsFetch + withComposeToken).
 *
 * Throws an Error carrying the server `error` text; `err.status` holds the
 * HTTP status so callers can branch (e.g. 409 = build already active for
 * that feature — the conflict model is per-feature, see lib/build.js:916).
 *
 * @param {{ featureCode: string, mode?: string, description?: string }} args
 * @returns {Promise<Response>} the ok response
 */
export async function startBuild({ featureCode, mode = 'feature', description = '' }) {
  const res = await wsFetch('/api/build/start', {
    method: 'POST',
    headers: withComposeToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ featureCode, mode, description }),
  });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    const err = new Error((data && data.error) || `Failed to start build (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res;
}
