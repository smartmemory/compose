/**
 * stratum.js — Compose's DataClient for `@smartmemory/stratum-ui` (COMPOSE-STRAT-TAB-1).
 *
 * Plain async methods over Compose's `/api/stratum-ui/*` mount (server/stratum-ui-routes.js),
 * sent through wsFetch so the workspace id and remote-mode token ride along. No `subscribe`:
 * the screens poll instead (EventSource cannot carry those headers). The contract is
 * `stratum/ui/src/data-client.ts` (CONTRACT_VERSION 1); `resolveGate` carries the gate's
 * `gateToken` because the CLI refuses a decision without it.
 *
 * COMP-SUBAPP-STRAT-AUTHOR-1: the builder's optional methods. `validateSpec` / `planFlow` go to the
 * package handler's engine routes (`POST /validate`, `/plan`; 501 without a built engine, which throws
 * so the builder shows validation as unavailable). `listSpecs` / `readSpec` / `saveSpec` go to Compose's
 * `/specs` (server/stratum-spec-routes.js); `saveSpec` never throws, a refusal comes back `ok: false`
 * with the server's own text.
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

async function postJson(path, payload) {
  return wsFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function engineCall(path, payload) {
  const res = await postJson(path, payload);
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(body?.error?.message ?? `${path}: HTTP ${res.status}`);
  return body;
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
    // COMP-UI-LINKS-1: the builder deep link (drawer "builder", flow name) opens a run's own spec (stratum STRAT-UI-LINKS-1 route, a read)
    async getRunSpec(runId) {
      const res = await wsFetch(`${BASE}/runs/${enc(runId)}/spec`, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`run ${runId} spec: HTTP ${res.status}`);
      return res.json();
    },
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
    validateSpec: (spec) => engineCall('/validate', { spec }),
    planFlow: (spec, input) => engineCall('/plan', { spec, input }),
    listSpecs: () => getJson('/specs'),
    async readSpec(name) {
      const res = await wsFetch(`${BASE}/specs/${enc(name)}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      const body = await res.json().catch(() => undefined);
      if (!res.ok) throw new Error(body?.message ?? `pipeline ${name}: HTTP ${res.status}`);
      return body;
    },
    async saveSpec(name, spec) {
      const res = await postJson(`/specs/${enc(name)}`, { spec });
      const body = await res.json().catch(() => undefined);
      return body && 'ok' in body
        ? body
        : { ok: false, code: `HTTP_${res.status}`, message: `save failed: HTTP ${res.status}` };
    },
  };
}
