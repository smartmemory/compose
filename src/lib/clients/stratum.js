/**
 * stratum.js — Compose's DataClient for `@smartmemory/stratum-ui` (COMPOSE-STRAT-TAB-1).
 *
 * Plain async methods over Compose's `/api/stratum-ui/*` mount (server/stratum-ui-routes.js),
 * sent through wsFetch so the workspace id and remote-mode token ride along. No `subscribe`:
 * the screens poll instead (EventSource cannot carry those headers). The contract is
 * `stratum/ui/src/data-client.ts` (CONTRACT_VERSION 1); `resolveGate` carries the gate's
 * `gateToken` because the CLI refuses a decision without it.
 */
import { wsFetch } from '../wsFetch.js';

const BASE = '/api/stratum-ui';
const enc = encodeURIComponent;

async function getJson(path) {
  const res = await wsFetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error?.message ?? `${path}: HTTP ${res.status}`);
  }
  return res.json();
}

export function createStratumDataClient() {
  return {
    listRuns: () => getJson('/runs'),
    async getRun(runId) {
      const res = await wsFetch(`${BASE}/runs/${enc(runId)}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`run ${runId}: HTTP ${res.status}`);
      return res.json();
    },
    listGates: () => getJson('/gates'),
    async resolveGate({ runId, stepId, action, note, gateToken }) {
      const res = await wsFetch(`${BASE}/gates/${enc(runId)}/${enc(stepId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ gateToken, note }),
      });
      const body = await res.json().catch(() => undefined);
      return body && 'ok' in body
        ? body
        : { ok: false, kind: 'error', code: `HTTP_${res.status}`, message: 'unexpected response' };
    },
  };
}
