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

export function createCadenceDataClient() {
  return {
    getBelt: () => getJson('/belt'),
    getSeats: () => getJson('/seats'),
    getChains: () => getJson('/chains'),
    getAttention: () => getJson('/attention'),
    getReview: () => getJson('/review'), // cadence be74428 (CADENCE-UI-REVIEW-GATE-1): attention screen's review strip
    getDiary(query = {}) {
      const params = new URLSearchParams();
      if (query.family) params.set('family', query.family);
      if (query.limit != null) params.set('limit', String(query.limit));
      const qs = params.toString();
      return getJson(`/diary${qs ? `?${qs}` : ''}`);
    },
  };
}
