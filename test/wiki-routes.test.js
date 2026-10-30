/**
 * COMPOSE-WIKI-TAB-1: /api/wiki proxy, one table. A fake wiki on a loopback ephemeral port records every
 * request it gets; each row says what the browser asks, what it gets back and how many calls reach the wiki.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { attachWikiRoutes, OWNER_TOKEN_HEADER } from '../server/wiki-routes.js';

const TOKEN = `wt-test-${randomBytes(12).toString('hex')}`; // a throwaway value, never a real wiki key
const ENV_NAME = 'WIKI_TAB_TEST_TOKEN';

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

// What GET /feeds/upcoming_calls answers (a row's `setup` sets it; the loop resets it): 'absent' is the real wiki's answer for a feed it does not
// wire (smart-memory-wiki wiki/spine/api/app.py `feed`: 404 not_found "unknown feed").
let feedMode = 'absent';

async function fakeWiki(calls) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { calls.push({ method: req.method, path: req.path, url: req.url, headers: req.headers, body: req.body }); next(); });
  app.get('/identity', (_req, res) => res.json({ principal: 'owner', workspaces: ['wiki-eng', 'wiki-gtm', 'wiki-private'] }));
  app.post('/query/feature_hub', (req, res) => (req.body.filters.feature_id === 'REDIRECT'
    ? res.redirect(303, '/signin')
    : res.json({ items: [], total: 0, next_cursor: null, generated_at: 't', feature: null })));
  app.post('/query/decisions', (req, res) => {
    if (req.body.page?.cursor === 'REDIRECT') return res.redirect(303, '/signin');
    return req.body.filters.feature_id === undefined
      ? res.json({ items: [], total: 0, next_cursor: null, generated_at: 't' })
      : res.status(400).json({ code: 'bad_filter', message: 'no such feature' });
  });
  app.post('/query/sources', (req, res) => {
    if (req.body.page?.cursor === 'REDIRECT') return res.redirect(303, '/signin');
    return Object.keys(req.body.filters).length === 0
      ? res.json({ items: [], total: 0, next_cursor: null, generated_at: 't' })
      : res.status(400).json({ code: 'bad_filter', message: 'no filters expected' });
  });
  app.post('/query/docs_by_area', (req, res) => {
    if (req.body.page?.cursor === 'REDIRECT') return res.redirect(303, '/signin');
    return typeof req.body.filters.area === 'string' && Object.keys(req.body.filters).length === 1
      ? res.json({ items: [], total: 0, next_cursor: null, generated_at: 't' })
      : res.status(400).json({ code: 'bad_filter', message: 'area required' });
  });
  app.post('/query/ledger', (req, res) => {
    if (req.body.page?.cursor === 'REDIRECT') return res.redirect(303, '/signin');
    return typeof req.body.filters.from === 'string' && typeof req.body.filters.to === 'string' && Object.keys(req.body.filters).length === 2
      ? res.json({ items: [], total: 0, next_cursor: null, generated_at: 't' })
      : res.status(400).json({ code: 'bad_filter', message: 'from and to required' });
  });
  app.get('/feeds/upcoming_calls', (_req, res) => {
    if (feedMode === 'redirect') return res.redirect(303, '/signin');
    if (feedMode === 'other404') return res.status(404).json({ code: 'not_found', message: 'something else is missing', retryable: false });
    if (feedMode === 'absent') return res.status(404).json({ code: 'not_found', message: 'unknown feed', retryable: false });
    return res.json({ data: { items: [{ entry_id: 'c1', parent_doc_id: 'd1', kind: 'ledger', ts: '2026-10-20T15:00:00Z', text: 'Call', refs: [] }] }, errors: [], partial: false, generated_at: 't', freshness_s: 0 });
  });
  app.post('/query/search', (_req, res) => res.json({ groups: [], generated_at: 't' }));
  app.post('/query/graph', (req, res) => (req.body.page?.cursor === 'REDIRECT'
    ? res.redirect(303, '/signin')
    : req.body.page?.cursor === 'NOT_MODIFIED' ? res.status(304).end() : res.json({ items: [], edges: [], total: 0, revision: 'r1' })));
  app.get('/note', (req, res) => (req.query.id === 'MISSING'
    ? res.status(404).json({ code: 'not_found', message: 'no such note' })
    : res.json({ workspace: req.query.workspace, note: { id: req.query.id, text: 'hello' }, generated_at: 't' })));
  app.use((_req, res) => res.status(418).json({ code: 'reached_the_wiki' }));
  return listen(app);
}

const fh = { workspace: 'wiki-eng', featureId: 'COMPOSE-WIKI-TAB-1' };
// cfg: 'ok' = enabled, tokenEnv set, the fake wiki's base URL. upstream: [method, path, exact body] the wiki must get.
const ROWS = [
  // name, cfg, token, method, path, body, host, status, code, wiki calls, upstream, check
  ['identity: allowed, workspaces cut to wiki-eng', 'ok', true, 'GET', '/identity', null, null, 200, null, 1, ['GET', '/identity', {}],
    (b) => assert.deepEqual(b.workspaces, ['wiki-eng'])],
  ['feature_hub: allowed, envelope built here', 'ok', true, 'POST', '/query/feature_hub', { ...fh, extra: 'dropped' }, null, 200, null, 1,
    ['POST', '/query/feature_hub', { query: 'feature_hub', workspace: 'wiki-eng', filters: { feature_id: 'COMPOSE-WIKI-TAB-1' }, page: { size: 200 } }]],
  ['decisions: the wiki\'s error envelope passes through', 'ok', true, 'POST', '/query/decisions', fh, null, 400, 'bad_filter', 1,
    ['POST', '/query/decisions', { query: 'decisions', workspace: 'wiki-eng', filters: { feature_id: 'COMPOSE-WIKI-TAB-1' }, page: { size: 50 } }]],
  ['search: allowed', 'ok', true, 'POST', '/query/search', { workspace: 'wiki-eng', q: 'recall' }, null, 200, null, 1,
    ['POST', '/query/search', { query: 'search', workspace: 'wiki-eng', filters: { q: 'recall' }, page: {} }]],
  ['decisions_page: allowed, no cursor, page built here', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', extra: 'dropped', filters: { feature_id: 'X' }, query: 'ideas' }, null, 200, null, 1,
    ['POST', '/query/decisions', { query: 'decisions', workspace: 'wiki-eng', filters: {}, page: { size: 50 } }]],
  ['decisions_page: cursor and size pass, nothing else', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', cursor: 'abc.DEF_123', size: 20, sort: 'x' }, null, 200, null, 1,
    ['POST', '/query/decisions', { query: 'decisions', workspace: 'wiki-eng', filters: {}, page: { size: 20, cursor: 'abc.DEF_123' } }]],
  ['decisions_page: cursor at the cap passes', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', cursor: 'c'.repeat(512) }, null, 200, null, 1,
    ['POST', '/query/decisions', { query: 'decisions', workspace: 'wiki-eng', filters: {}, page: { size: 50, cursor: 'c'.repeat(512) } }]],
  ['decisions_page: oversize cursor', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', cursor: 'c'.repeat(513) }, null, 400, 'bad_request', 0],
  ['decisions_page: empty cursor', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', cursor: '' }, null, 400, 'bad_request', 0],
  ['decisions_page: object cursor', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', cursor: { $ne: 1 } }, null, 400, 'bad_request', 0],
  ['decisions_page: size 0', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', size: 0 }, null, 400, 'bad_request', 0],
  ['decisions_page: size 51', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', size: 51 }, null, 400, 'bad_request', 0],
  ['decisions_page: size 1.5', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', size: 1.5 }, null, 400, 'bad_request', 0],
  ['decisions_page: size as a string', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', size: '20' }, null, 400, 'bad_request', 0],
  ['decisions_page: wiki-private', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-private' }, null, 403, 'workspace_refused', 0],
  ['decisions_page: no workspace', 'ok', true, 'POST', '/query/decisions_page', {}, null, 403, 'workspace_refused', 0],
  ['decisions_page: missing token', 'ok', false, 'POST', '/query/decisions_page', { workspace: 'wiki-eng' }, null, 503, 'token_missing', 0],
  ['decisions_page: wiki redirect not followed', 'ok', true, 'POST', '/query/decisions_page', { workspace: 'wiki-eng', cursor: 'REDIRECT' }, null, 502, 'bad_response', 1],
  ['sources_page: allowed, no cursor, page built here', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', extra: 'dropped', filters: { status: ['ok'] }, query: 'ideas', sort: [['source_id', 'desc']] }, null, 200, null, 1,
    ['POST', '/query/sources', { query: 'sources', workspace: 'wiki-eng', filters: {}, page: { size: 50 } }]],
  ['sources_page: cursor and size pass, nothing else', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', cursor: 'abc.DEF_123', size: 20, sort: 'x' }, null, 200, null, 1,
    ['POST', '/query/sources', { query: 'sources', workspace: 'wiki-eng', filters: {}, page: { size: 20, cursor: 'abc.DEF_123' } }]],
  ['sources_page: cursor at the cap passes', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', cursor: 'c'.repeat(512) }, null, 200, null, 1,
    ['POST', '/query/sources', { query: 'sources', workspace: 'wiki-eng', filters: {}, page: { size: 50, cursor: 'c'.repeat(512) } }]],
  ['sources_page: oversize cursor', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', cursor: 'c'.repeat(513) }, null, 400, 'bad_request', 0],
  ['sources_page: empty cursor', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', cursor: '' }, null, 400, 'bad_request', 0],
  ['sources_page: object cursor', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', cursor: { $ne: 1 } }, null, 400, 'bad_request', 0],
  ['sources_page: size 0', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', size: 0 }, null, 400, 'bad_request', 0],
  ['sources_page: size 51', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', size: 51 }, null, 400, 'bad_request', 0],
  ['sources_page: size 1.5', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', size: 1.5 }, null, 400, 'bad_request', 0],
  ['sources_page: size as a string', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', size: '20' }, null, 400, 'bad_request', 0],
  ['sources_page: wiki-private', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-private' }, null, 403, 'workspace_refused', 0],
  ['sources_page: no workspace', 'ok', true, 'POST', '/query/sources_page', {}, null, 403, 'workspace_refused', 0],
  ['sources_page: missing token', 'ok', false, 'POST', '/query/sources_page', { workspace: 'wiki-eng' }, null, 503, 'token_missing', 0],
  ['sources_page: wiki redirect not followed', 'ok', true, 'POST', '/query/sources_page', { workspace: 'wiki-eng', cursor: 'REDIRECT' }, null, 502, 'bad_response', 1],
  ['docs_by_area: allowed, area filter and page built here', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', extra: 'dropped', filters: { status: ['x'] }, query: 'ideas' }, null, 200, null, 1,
    ['POST', '/query/docs_by_area', { query: 'docs_by_area', workspace: 'wiki-eng', filters: { area: 'search' }, page: { size: 50 } }]],
  ['docs_by_area: cursor and size pass with the area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'a.b:c@d/e-f_1', cursor: 'abc.DEF_123', size: 20 }, null, 200, null, 1,
    ['POST', '/query/docs_by_area', { query: 'docs_by_area', workspace: 'wiki-eng', filters: { area: 'a.b:c@d/e-f_1' }, page: { size: 20, cursor: 'abc.DEF_123' } }]],
  ['docs_by_area: area at the cap passes', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'a'.repeat(200) }, null, 200, null, 1,
    ['POST', '/query/docs_by_area', { query: 'docs_by_area', workspace: 'wiki-eng', filters: { area: 'a'.repeat(200) }, page: { size: 50 } }]],
  ['docs_by_area: oversize area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'a'.repeat(201) }, null, 400, 'bad_request', 0],
  ['docs_by_area: no area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng' }, null, 400, 'bad_request', 0],
  ['docs_by_area: empty area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: '' }, null, 400, 'bad_request', 0],
  ['docs_by_area: blank area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: '   ' }, null, 400, 'bad_request', 0],
  ['docs_by_area: area with a space', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'core engine' }, null, 400, 'bad_request', 0],
  ['docs_by_area: area with &', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'ops&process' }, null, 400, 'bad_request', 0],
  ['docs_by_area: area with a newline', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'core\nx' }, null, 400, 'bad_request', 0],
  ['docs_by_area: area with non-ASCII letters', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'cör' }, null, 400, 'bad_request', 0],
  ['docs_by_area: array area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: ['search'] }, null, 400, 'bad_request', 0],
  ['docs_by_area: object area', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: { $ne: 1 } }, null, 400, 'bad_request', 0],
  ['docs_by_area: oversize cursor', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', cursor: 'c'.repeat(513) }, null, 400, 'bad_request', 0],
  ['docs_by_area: empty cursor', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', cursor: '' }, null, 400, 'bad_request', 0],
  ['docs_by_area: object cursor', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', cursor: { $ne: 1 } }, null, 400, 'bad_request', 0],
  ['docs_by_area: size 0', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', size: 0 }, null, 400, 'bad_request', 0],
  ['docs_by_area: size 51', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', size: 51 }, null, 400, 'bad_request', 0],
  ['docs_by_area: size as a string', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', size: '20' }, null, 400, 'bad_request', 0],
  ['docs_by_area: wiki-private', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-private', area: 'search' }, null, 403, 'workspace_refused', 0],
  ['docs_by_area: no workspace', 'ok', true, 'POST', '/query/docs_by_area', { area: 'search' }, null, 403, 'workspace_refused', 0],
  ['docs_by_area: missing token', 'ok', false, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search' }, null, 503, 'token_missing', 0],
  ['docs_by_area: wiki redirect not followed', 'ok', true, 'POST', '/query/docs_by_area', { workspace: 'wiki-eng', area: 'search', cursor: 'REDIRECT' }, null, 502, 'bad_response', 1],
  // ledger: the window is built here (dates expanded, sort fixed), never forwarded
  ['ledger: allowed, instants kept, sort and extras dropped', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-09-16T12:00:00Z', to: '2026-10-17T12:00:00Z', sort: [['ts', 'asc']], filters: { kind: 'x' }, query: 'ideas' }, null, 200, null, 1,
    ['POST', '/query/ledger', { query: 'ledger', workspace: 'wiki-eng', filters: { from: '2026-09-16T12:00:00Z', to: '2026-10-17T12:00:00Z' }, sort: [['ts', 'desc']], page: { size: 50 } }]],
  ['ledger: dates become midnight UTC', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-09-16', to: '2026-10-17' }, null, 200, null, 1,
    ['POST', '/query/ledger', { query: 'ledger', workspace: 'wiki-eng', filters: { from: '2026-09-16T00:00:00Z', to: '2026-10-17T00:00:00Z' }, sort: [['ts', 'desc']], page: { size: 50 } }]],
  ['ledger: offset and fraction pass, cursor and size too', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-09-16T12:00:00.123456+02:00', to: '2026-10-01T00:00:00-05:30', cursor: 'abc.DEF_123', size: 20 }, null, 200, null, 1,
    ['POST', '/query/ledger', { query: 'ledger', workspace: 'wiki-eng', filters: { from: '2026-09-16T12:00:00.123456+02:00', to: '2026-10-01T00:00:00-05:30' }, sort: [['ts', 'desc']], page: { size: 20, cursor: 'abc.DEF_123' } }]],
  ['ledger: from equals to passes', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-10-01' }, null, 200, null, 1,
    ['POST', '/query/ledger', { query: 'ledger', workspace: 'wiki-eng', filters: { from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, sort: [['ts', 'desc']], page: { size: 50 } }]],
  ['ledger: a 366 day span passes', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2025-10-01', to: '2026-10-02' }, null, 200, null, 1,
    ['POST', '/query/ledger', { query: 'ledger', workspace: 'wiki-eng', filters: { from: '2025-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }, sort: [['ts', 'desc']], page: { size: 50 } }]],
  ['ledger: a 367 day span', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2025-10-01', to: '2026-10-03' }, null, 400, 'bad_request', 0],
  ['ledger: a span of years', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '1970-01-01', to: '2026-10-03' }, null, 400, 'bad_request', 0],
  ['ledger: from after to', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-02', to: '2026-10-01' }, null, 400, 'bad_request', 0],
  ['ledger: from after to by instant', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01T00:00:01Z', to: '2026-10-01T00:00:00Z' }, null, 400, 'bad_request', 0],
  ['ledger: no from', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', to: '2026-10-01' }, null, 400, 'bad_request', 0],
  ['ledger: no to', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01' }, null, 400, 'bad_request', 0],
  ['ledger: slashes', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026/10/01', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: month 13', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-13-01', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: February 30', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-02-30' }, null, 400, 'bad_request', 0],
  ['ledger: a word', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: 'yesterday', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: an instant with no offset', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01T00:00:00', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: hour 24', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01T24:00:00Z', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: offset hour 24', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01T00:00:00+24:00', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: seven fraction digits', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01T00:00:00.1234567Z', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: trailing text after a date', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01\nx', to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: oversize date', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01'.padEnd(5000, '0'), to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: number date', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: 20261001, to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: array date', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: ['2026-10-01'], to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: object date', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: { $gt: '' }, to: '2026-10-02' }, null, 400, 'bad_request', 0],
  ['ledger: oversize cursor', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-10-02', cursor: 'c'.repeat(513) }, null, 400, 'bad_request', 0],
  ['ledger: size 51', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-10-02', size: 51 }, null, 400, 'bad_request', 0],
  ['ledger: size as a string', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-10-02', size: '20' }, null, 400, 'bad_request', 0],
  ['ledger: wiki-private', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-private', from: '2026-10-01', to: '2026-10-02' }, null, 403, 'workspace_refused', 0],
  ['ledger: no workspace', 'ok', true, 'POST', '/query/ledger', { from: '2026-10-01', to: '2026-10-02' }, null, 403, 'workspace_refused', 0],
  ['ledger: missing token', 'ok', false, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-10-02' }, null, 503, 'token_missing', 0],
  ['ledger: wiki redirect not followed', 'ok', true, 'POST', '/query/ledger', { workspace: 'wiki-eng', from: '2026-10-01', to: '2026-10-02', cursor: 'REDIRECT' }, null, 502, 'bad_response', 1],
  // upcoming_calls: the one fixed feed; an absent feed is null
  ['feed upcoming_calls: allowed, workspace from config, no body', 'ok', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng&revoked=1&extra=x', null, null, 200, null, 1,
    ['GET', '/feeds/upcoming_calls', {}],
    (b, _base, calls) => { assert.equal(calls[0].url, '/feeds/upcoming_calls?workspace=wiki-eng'); assert.equal(b.data.items.length, 1); }, () => { feedMode = 'present'; }],
  ['feed upcoming_calls: absent on the wiki (404 not_found) -> null', 'ok', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng', null, null, 200, null, 1,
    ['GET', '/feeds/upcoming_calls', {}], (b) => assert.equal(b, null)],
  ['feed upcoming_calls: another 404 is not mistaken for absent', 'ok', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng', null, null, 404, 'not_found', 1,
    null, (b) => assert.equal(b.message, 'something else is missing'), () => { feedMode = 'other404'; }],
  ['feed upcoming_calls: wiki redirect not followed', 'ok', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng', null, null, 502, 'bad_response', 1,
    null, null, () => { feedMode = 'redirect'; }],
  ['feed upcoming_calls: wiki-private', 'ok', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-private', null, null, 403, 'workspace_refused', 0],
  ['feed upcoming_calls: no workspace', 'ok', true, 'GET', '/feeds/upcoming_calls', null, null, 403, 'workspace_refused', 0],
  ['feed upcoming_calls: workspace given twice', 'ok', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng&workspace=wiki-private', null, null, 403, 'workspace_refused', 0],
  ['feed upcoming_calls: missing token', 'ok', false, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng', null, null, 503, 'token_missing', 0],
  ['feed upcoming_calls: config off', 'off', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng', null, null, 503, 'wiki_disabled', 0],
  ['feed upcoming_calls: wiki down', 'down', true, 'GET', '/feeds/upcoming_calls?workspace=wiki-eng', null, null, 502, 'wiki_unreachable', 0],
  ['feed upcoming_calls: foreign Host (the prefix guard covers it)', 'ok', true, 'POST', '/feeds/upcoming_calls', { workspace: 'wiki-eng' }, 'evil.example:4001', 403, 'host_refused', 0],
  ['feed upcoming_calls: POST is not proxied', 'ok', true, 'POST', '/feeds/upcoming_calls', { workspace: 'wiki-eng' }, null, 404, 'not_proxied', 0],
  ['feed: another name (taxonomy_rules) never reaches the wiki', 'ok', true, 'GET', '/feeds/taxonomy_rules?workspace=wiki-eng', null, null, 404, 'not_proxied', 0],
  ['feed: a name that begins like it', 'ok', true, 'GET', '/feeds/upcoming_calls_x?workspace=wiki-eng', null, null, 404, 'not_proxied', 0],
  ['feed: a path below it', 'ok', true, 'GET', '/feeds/upcoming_calls/extra?workspace=wiki-eng', null, null, 404, 'not_proxied', 0],
  ['feed: an escaped path out of it', 'ok', true, 'GET', '/feeds/upcoming_calls%2F..%2Fidentity?workspace=wiki-eng', null, null, 404, 'not_proxied', 0],
  ['feed: the bare /feeds path', 'ok', true, 'GET', '/feeds?workspace=wiki-eng', null, null, 404, 'not_proxied', 0],
  // graph: one-shot or paged, the body built here; note: one GET with a checked id
  ['graph all:true: one-shot body built here, extras dropped', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: true, root: 'd1', filters: { kind: 'x' }, page: { size: 5 }, query: 'ideas' }, null, 200, null, 1,
    ['POST', '/query/graph', { query: 'graph', workspace: 'wiki-eng', filters: {}, page: { all: true } }],
    (_b, _base, calls) => { assert.equal(calls[0].headers['if-none-match'], undefined); assert.equal(calls[0].headers.etag, undefined); }],
  ['graph all:"yes"', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: 'yes' }, null, 400, 'bad_request', 0],
  ['graph all:false', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: false }, null, 400, 'bad_request', 0],
  ['graph all:null', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: null }, null, 400, 'bad_request', 0],
  ['graph all with cursor', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: true, cursor: 'c1' }, null, 400, 'bad_request', 0],
  ['graph all with size', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: true, size: 10 }, null, 400, 'bad_request', 0],
  ['graph paged: no cursor, size 200 default, nothing else forwarded', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', root: 'd1', filters: { kind: 'x' }, page: { all: true } }, null, 200, null, 1,
    ['POST', '/query/graph', { query: 'graph', workspace: 'wiki-eng', filters: {}, page: { size: 200 } }]],
  ['graph paged: cursor and size 1 pass', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: 'abc.DEF_123', size: 1 }, null, 200, null, 1,
    ['POST', '/query/graph', { query: 'graph', workspace: 'wiki-eng', filters: {}, page: { size: 1, cursor: 'abc.DEF_123' } }]],
  ['graph paged: size 200 passes', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', size: 200 }, null, 200, null, 1,
    ['POST', '/query/graph', { query: 'graph', workspace: 'wiki-eng', filters: {}, page: { size: 200 } }]],
  ['graph paged: cursor at the cap passes', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: 'c'.repeat(512) }, null, 200, null, 1,
    ['POST', '/query/graph', { query: 'graph', workspace: 'wiki-eng', filters: {}, page: { size: 200, cursor: 'c'.repeat(512) } }]],
  ['graph paged: oversize cursor', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: 'c'.repeat(513) }, null, 400, 'bad_request', 0],
  ['graph paged: empty cursor', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: '' }, null, 400, 'bad_request', 0],
  ['graph paged: object cursor', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: { $ne: 1 } }, null, 400, 'bad_request', 0],
  ['graph paged: size 0', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', size: 0 }, null, 400, 'bad_request', 0],
  ['graph paged: size 201', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', size: 201 }, null, 400, 'bad_request', 0],
  ['graph paged: size 1.5', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', size: 1.5 }, null, 400, 'bad_request', 0],
  ['graph paged: size as a string', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', size: '20' }, null, 400, 'bad_request', 0],
  ['graph: wiki-private', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-private', all: true }, null, 403, 'workspace_refused', 0],
  ['graph: no workspace', 'ok', true, 'POST', '/query/graph', { all: true }, null, 403, 'workspace_refused', 0],
  ['graph: missing token', 'ok', false, 'POST', '/query/graph', { workspace: 'wiki-eng', all: true }, null, 503, 'token_missing', 0],
  ['graph: config off', 'off', true, 'POST', '/query/graph', { workspace: 'wiki-eng', all: true }, null, 503, 'wiki_disabled', 0],
  ['graph: wiki redirect not followed', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: 'REDIRECT' }, null, 502, 'bad_response', 1],
  ['graph: an upstream 304 is still a 502 (the 3xx rule is unchanged)', 'ok', true, 'POST', '/query/graph', { workspace: 'wiki-eng', cursor: 'NOT_MODIFIED' }, null, 502, 'bad_response', 1],
  ['graph: GET is not proxied', 'ok', true, 'GET', '/query/graph', null, null, 404, 'not_proxied', 0],
  ['note: allowed, upstream path built with URLSearchParams', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=docs%2Ffeatures%2FX-1%2Fdesign.md&extra=dropped&page=1', null, null, 200, null, 1,
    ['GET', '/note', {}],
    (b, _base, calls) => { assert.equal(calls[0].url, '/note?workspace=wiki-eng&id=docs%2Ffeatures%2FX-1%2Fdesign.md'); assert.equal(b.note.text, 'hello'); }],
  ['note: id at 512 characters passes', 'ok', true, 'GET', `/note?workspace=wiki-eng&id=${'a'.repeat(512)}`, null, null, 200, null, 1,
    ['GET', '/note', {}]],
  ['note: id with every allowed character passes', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a.b:c%40d%2Fe-f_1', null, null, 200, null, 1,
    ['GET', '/note', {}], (_b, _base, calls) => assert.equal(calls[0].url, '/note?workspace=wiki-eng&id=a.b%3Ac%40d%2Fe-f_1')],
  ['note: the wiki\'s own 404 passes through', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=MISSING', null, null, 404, 'not_found', 1],
  ['note: id missing', 'ok', true, 'GET', '/note?workspace=wiki-eng', null, null, 400, 'bad_request', 0],
  ['note: id empty', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=', null, null, 400, 'bad_request', 0],
  ['note: id twice (array)', 'ok', true, 'GET', '/note?workspace=wiki-eng&id[]=a&id[]=b', null, null, 400, 'bad_request', 0],
  ['note: id as an object', 'ok', true, 'GET', '/note?workspace=wiki-eng&id[a]=b', null, null, 400, 'bad_request', 0],
  ['note: id repeated', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a&id=b', null, null, 400, 'bad_request', 0],
  ['note: id of 513 characters', 'ok', true, 'GET', `/note?workspace=wiki-eng&id=${'a'.repeat(513)}`, null, null, 400, 'bad_request', 0],
  ['note: id with <', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a%3Cb', null, null, 400, 'bad_request', 0],
  ['note: id with a space', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a%20b', null, null, 400, 'bad_request', 0],
  ['note: id with a newline', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a%0Ab', null, null, 400, 'bad_request', 0],
  ['note: id with & or =', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a%26workspace%3Dwiki-private', null, null, 400, 'bad_request', 0],
  ['note: id with non-ASCII', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=c%C3%B6r', null, null, 400, 'bad_request', 0],
  ['note: id ../../etc', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=..%2F..%2Fetc', null, null, 400, 'bad_request', 0],
  ['note: id ..', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=..', null, null, 400, 'bad_request', 0],
  ['note: id a/../b', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a%2F..%2Fb', null, null, 400, 'bad_request', 0],
  ['note: a dotted id that is no traversal passes (a..b)', 'ok', true, 'GET', '/note?workspace=wiki-eng&id=a..b', null, null, 200, null, 1, ['GET', '/note', {}]],
  ['note: workspace wiki-private', 'ok', true, 'GET', '/note?workspace=wiki-private&id=d1', null, null, 403, 'workspace_refused', 0],
  ['note: no workspace', 'ok', true, 'GET', '/note?id=d1', null, null, 403, 'workspace_refused', 0],
  ['note: workspace given twice', 'ok', true, 'GET', '/note?workspace=wiki-eng&workspace=wiki-private&id=d1', null, null, 403, 'workspace_refused', 0],
  ['note: missing token', 'ok', false, 'GET', '/note?workspace=wiki-eng&id=d1', null, null, 503, 'token_missing', 0],
  ['note: config off', 'off', true, 'GET', '/note?workspace=wiki-eng&id=d1', null, null, 503, 'wiki_disabled', 0],
  ['note: wiki down', 'down', true, 'GET', '/note?workspace=wiki-eng&id=d1', null, null, 502, 'wiki_unreachable', 0],
  ['note: POST is not proxied', 'ok', true, 'POST', '/note', { workspace: 'wiki-eng', id: 'd1' }, null, 404, 'not_proxied', 0],
  ['note: a path below it is not proxied', 'ok', true, 'GET', '/note/d1?workspace=wiki-eng', null, null, 404, 'not_proxied', 0],
  ['unlisted query (notes_tree)', 'ok', true, 'POST', '/query/notes_tree', { workspace: 'wiki-eng' }, null, 404, 'not_proxied', 0],
  ['unlisted GET (/pages/home)', 'ok', true, 'GET', '/pages/home', null, null, 404, 'not_proxied', 0],
  ['/commands', 'ok', true, 'POST', '/commands', { command: 'apply' }, null, 404, 'not_proxied', 0],
  ['GET of a query path', 'ok', true, 'GET', '/query/search', null, null, 404, 'not_proxied', 0],
  ['wiki-private target', 'ok', true, 'POST', '/query/feature_hub', { ...fh, workspace: 'wiki-private' }, null, 403, 'workspace_refused', 0],
  ['no workspace', 'ok', true, 'POST', '/query/search', { q: 'recall' }, null, 403, 'workspace_refused', 0],
  ['config names wiki-private', 'private', true, 'POST', '/query/feature_hub', { ...fh, workspace: 'wiki-private' }, null, 403, 'workspace_refused', 0],
  ['config names wiki-private: identity', 'private', true, 'GET', '/identity', null, null, 403, 'workspace_refused', 0],
  ['config names wiki-private: available', 'private', true, 'GET', '/available', null, null, 200, 'workspace_refused', 0,
    null, (b) => assert.equal(b.available, false)],
  ['missing token', 'ok', false, 'POST', '/query/feature_hub', fh, null, 503, 'token_missing', 0],
  ['config off', 'off', true, 'GET', '/identity', null, null, 503, 'wiki_disabled', 0],
  ['base URL not 127.0.0.1', 'remote-url', true, 'POST', '/query/search', { workspace: 'wiki-eng', q: 'x' }, null, 503, 'config_invalid', 0],
  ['tokenEnv not an env name', 'bad-env', true, 'GET', '/identity', null, null, 503, 'config_invalid', 0],
  ['tokenEnv named VITE_* (browser-inlined prefix)', 'vite-env', true, 'GET', '/identity', null, null, 503, 'config_invalid', 0],
  ['empty search', 'ok', true, 'POST', '/query/search', { workspace: 'wiki-eng', q: '' }, null, 400, 'bad_request', 0],
  ['foreign Host (DNS rebinding)', 'ok', true, 'POST', '/query/search', { workspace: 'wiki-eng', q: 'x' }, 'evil.example:4001', 403, 'host_refused', 0],
  ['wiki redirects (session gone): not followed', 'ok', true, 'POST', '/query/feature_hub', { ...fh, featureId: 'REDIRECT' }, null, 502, 'bad_response', 1],
  ['wiki down', 'down', true, 'GET', '/identity', null, null, 502, 'wiki_unreachable', 0],
  ['available: frame base, no token', 'ok', true, 'GET', '/available', null, null, 200, null, 0, null,
    (b, base) => assert.deepEqual(b, { available: true, workspace: 'wiki-eng', frameBase: base })],
];

describe('attachWikiRoutes', () => {
  it('mounts nothing in remote mode', () => {
    assert.equal(attachWikiRoutes(express(), { remote: true }), false);
  });

  it('proxies only the DataClient calls, wiki-eng only, token from the named env var', async () => {
    const calls = [];
    const wiki = await fakeWiki(calls);
    const wikiBase = `http://127.0.0.1:${wiki.address().port}`;
    const configs = {
      ok: { enabled: true, tokenEnv: ENV_NAME, baseUrl: wikiBase },
      private: { enabled: true, tokenEnv: ENV_NAME, baseUrl: wikiBase, workspace: 'wiki-private' },
      off: { enabled: false, tokenEnv: ENV_NAME, baseUrl: wikiBase },
      'remote-url': { enabled: true, tokenEnv: ENV_NAME, baseUrl: 'http://wiki.example:8791' },
      'vite-env': { enabled: true, tokenEnv: 'VITE_WIKI_OWNER_TOKEN', baseUrl: wikiBase },
      'bad-env': { enabled: true, tokenEnv: 'x; echo', baseUrl: wikiBase },
      down: { enabled: true, tokenEnv: ENV_NAME, baseUrl: 'http://127.0.0.1:1' },
    };
    let cfg;
    const env = {};
    const app = express();
    app.use(express.json());
    attachWikiRoutes(app, { getConfig: () => cfg, env });
    const compose = await listen(app);
    const base = `http://127.0.0.1:${compose.address().port}`;
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      for (const [name, c, token, method, path, body, host, status, code, wikiCalls, up, check, setup] of ROWS) {
        cfg = configs[c];
        feedMode = 'absent';
        setup?.();
        if (token) env[ENV_NAME] = TOKEN; else delete env[ENV_NAME];
        calls.length = 0;
        const headers = { cookie: 'compose=secret-cookie', authorization: 'Bearer browser', ...(body ? { 'content-type': 'application/json' } : {}) };
        // fetch() will not let a caller set Host, so the rebinding row goes through http.request.
        const res = host ? await rawPost(`${base}/api/wiki${path}`, host, body) : await fetch(`${base}/api/wiki${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = typeof res.text === 'function' ? await res.text() : res.text;
        assert.equal(res.status, status, `${name}: status (${text})`);
        const json = JSON.parse(text);
        if (code) assert.equal(json.code, code, `${name}: code`);
        assert.equal(calls.length, wikiCalls, `${name}: calls that reached the wiki`);
        assert.ok(!text.includes(TOKEN), `${name}: token in the answer`);
        if (up) {
          const [m, p, b] = up;
          assert.deepEqual([calls[0].method, calls[0].path, calls[0].body ?? {}], [m, p, b], `${name}: upstream request`);
        }
        for (const call of calls) {
          assert.equal(call.headers[OWNER_TOKEN_HEADER], TOKEN, `${name}: owner token header`);
          assert.equal(call.headers.cookie, undefined, `${name}: browser cookie forwarded`);
          assert.equal(call.headers.authorization, undefined, `${name}: browser authorization forwarded`);
        }
        check?.(json, wikiBase, calls);
      }
      assert.ok(warned.length > 0 && warned.every((w) => !w.includes(TOKEN)), 'warnings logged, none carrying the token');
    } finally {
      console.warn = warn;
      compose.close();
      wiki.close();
    }
  });
});

async function rawPost(url, host, body) {
  const { request } = await import('node:http');
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
