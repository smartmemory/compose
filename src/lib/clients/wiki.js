/**
 * wiki.js — Compose's DataClient for `@wiki/components` (COMPOSE-WIKI-TAB-1).
 *
 * The contract is `smart-memory-wiki/ui/packages/wiki-components/src/data-client.d.ts` (`identity`,
 * `featureHub`, `decisions`, `search`). Every call goes to Compose's own `/api/wiki/*` proxy
 * (server/wiki-routes.js), which holds the wiki token and builds the wiki's query envelope; the browser
 * never talks to the wiki for data. A refusal rejects with an Error carrying the answer's `code`, as the
 * contract asks, so the screens can show it.
 */
import { wsFetch } from '../wsFetch.js';

const BASE = '/api/wiki';

async function call(path, body) {
  const res = await wsFetch(`${BASE}${path}`, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => undefined);
  if (res.ok && json !== undefined) return json;
  const err = new Error(json?.message ?? `${path}: HTTP ${res.status}`);
  err.code = typeof json?.code === 'string' ? json.code : 'bad_response';
  err.status = res.status;
  throw err;
}

export function createWikiDataClient() {
  return {
    identity: () => call('/identity'),
    featureHub: ({ workspace, featureId }) => call('/query/feature_hub', { workspace, featureId }),
    decisions: ({ workspace, featureId }) => call('/query/decisions', { workspace, featureId }),
    search: ({ workspace, q }) => call('/query/search', { workspace, q }),
  };
}
