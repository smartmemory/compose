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

async function fakeWiki(calls) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { calls.push({ method: req.method, path: req.path, headers: req.headers, body: req.body }); next(); });
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
  app.post('/query/search', (_req, res) => res.json({ groups: [], generated_at: 't' }));
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
      for (const [name, c, token, method, path, body, host, status, code, wikiCalls, up, check] of ROWS) {
        cfg = configs[c];
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
        check?.(json, wikiBase);
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
