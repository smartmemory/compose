/**
 * wiki.js — Compose's DataClient for `@wiki/components` (COMPOSE-WIKI-TAB-1).
 *
 * The contract is `smart-memory-wiki/ui/packages/wiki-components/src/data-client.d.ts` (`identity`,
 * `featureHub`, `decisions`, `decisionsPage`, `sourcesPage`, `docsByArea`, `ledger`, `upcomingCalls`, `search`, `graphAll`, `graphPage`, `note`). Every call goes to Compose's own `/api/wiki/*` proxy
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
    decisionsPage: ({ workspace, cursor, size }) => call('/query/decisions_page', { workspace, ...(cursor ? { cursor } : {}), ...(size ? { size } : {}) }),
    sourcesPage: ({ workspace, cursor, size }) => call('/query/sources_page', { workspace, ...(cursor ? { cursor } : {}), ...(size ? { size } : {}) }),
    docsByArea: ({ workspace, area, cursor, size }) => call('/query/docs_by_area', { workspace, area, ...(cursor ? { cursor } : {}), ...(size ? { size } : {}) }),
    ledger: ({ workspace, from, to, cursor, size }) => call('/query/ledger', { workspace, from, to, ...(cursor ? { cursor } : {}), ...(size ? { size } : {}) }),
    // The proxy answers null for a feed the wiki does not serve; a served feed is the wiki's data_envelope.
    upcomingCalls: async ({ workspace }) => {
      const envelope = await call(`/feeds/upcoming_calls?workspace=${encodeURIComponent(workspace)}`);
      return envelope === null ? null : { items: envelope.data?.items ?? [], errors: envelope.errors ?? [] };
    },
    search: ({ workspace, q }) => call('/query/search', { workspace, q }),
    // The graph: `graphAll` is the one-shot answer, `graphPage` the cursor-paged fallback (the graph falls back on `code === 'invalid_request'`).
    graphAll: ({ workspace }) => call('/query/graph', { workspace, all: true }),
    graphPage: ({ workspace, cursor, size }) => call('/query/graph', { workspace, ...(cursor ? { cursor } : {}), ...(size ? { size } : {}) }),
    // One note with its text, for the graph's doc pane; the query string is built, never concatenated.
    note: ({ workspace, id }) => call(`/note?${new URLSearchParams({ workspace, id })}`),
  };
}
