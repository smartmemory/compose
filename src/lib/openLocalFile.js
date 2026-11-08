/**
 * openLocalFile.js — COMP-INBOX-LOCAL-FILE-LINKS-1: the cockpit's call to open a home-dir path on the Mac.
 * `POST /api/fleet/open-path {path}` (server/fleet-routes.js `openLocalPath` re-checks everything). The `:<line>` suffix a
 * `localfile` token may carry is dropped: the opener takes no line. Resolves to the route's reply
 * (`{status: 'accepted', path}` or `{status: 'rejected', reason}`), never throws: a failed request is a rejected reply.
 */
import { wsFetch } from './wsFetch.js';
import { withComposeToken } from './compose-api.js';
import { localPathOf } from './entityParts.js';

export const OPEN_PATH_URL = '/api/fleet/open-path';

export async function openLocalFile(path, { fetcher = wsFetch } = {}) {
  try {
    const res = await fetcher(OPEN_PATH_URL, {
      method: 'POST',
      headers: withComposeToken({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: localPathOf(path) }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (data?.status === 'accepted' || data?.status === 'rejected') return data;
    return { status: 'rejected', reason: data?.error ?? `the open route failed (HTTP ${res.status})` };
  } catch (err) {
    return { status: 'rejected', reason: `the open request failed (${String(err?.message ?? err).slice(0, 120)})` };
  }
}
