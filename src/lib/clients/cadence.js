/**
 * cadence.js — Compose's DataClient for `@cadence/ui` (COMPOSE-CADENCE-TAB-1).
 *
 * Plain async methods over Compose's read-only `/api/cadence-ui/*` mount (server/cadence-ui-routes.js),
 * sent through wsFetch so the workspace id and remote-mode token ride along. The contract is
 * `cadence/ui/src/data-client.ts` (CONTRACT_VERSION 1): one GET per screen, the screens poll.
 */
import { wsFetch } from '../wsFetch.js';

const BASE = '/api/cadence-ui';

async function getJson(path) {
  const res = await wsFetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error?.message ?? `${path}: HTTP ${res.status}`);
  }
  return res.json();
}

/** A query object as `?k=v&...` from every defined key (a later key needs no edit here); an undefined, null or empty value is left out. */
function queryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function createCadenceDataClient() {
  return {
    getBelt: () => getJson('/belt'),
    getSeats: () => getJson('/seats'),
    getChains: () => getJson('/chains'),
    getAttention: () => getJson('/attention'),
    getOutage: () => getJson('/outage'), // COMP-COCKPIT-NOTIFY-CHIP-1: outage_watch's state, for the header chip
    getLive: () => getJson('/live'), // cadence 93222be4 (CADENCE-UI-LIVE-1): the Live pane's lane rows
    getReview: () => getJson('/review'), // cadence be74428 (CADENCE-UI-REVIEW-GATE-1): attention screen's review strip
    // COMP-UI-LINKS-1: the Fleet room is built from Cadence parts; these are the handler's existing read routes (vitals is cadence 6bdfc58)
    getSessions: () => getJson('/sessions'),
    getJobs: () => getJson('/jobs'),
    getGates: () => getJson('/gates'),
    getVitals: () => getJson('/vitals'),
    getDiary(query = {}) {
      return getJson(`/diary${queryString(query)}`);
    },
  };
}
