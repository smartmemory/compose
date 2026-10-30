/**
 * wiki-routes.js — `/api/wiki/*`: the server side of the Wiki tab (COMPOSE-WIKI-TAB-1).
 *
 * The wiki's data calls are `POST /query/{name}` and the Mac wiki keeps every non-GET strictly
 * same-origin, so the browser cannot call it from Compose. This proxy makes exactly the calls of the
 * wiki DataClient contract (`smart-memory-wiki/ui/packages/wiki-components/src/data-client.d.ts`,
 * `DATA_CLIENT_CALLS`) and nothing else:
 *
 *   GET  /api/wiki/available           { available, workspace, frameBase } (no upstream call)
 *   GET  /api/wiki/identity            -> GET  /identity, workspaces cut to the one served workspace
 *   POST /api/wiki/query/feature_hub   -> POST /query/feature_hub  {workspace, featureId}
 *   POST /api/wiki/query/decisions     -> POST /query/decisions    {workspace, featureId}
 *   POST /api/wiki/query/decisions_page -> POST /query/decisions   {workspace, cursor?, size?} (all decisions, paged)
 *   POST /api/wiki/query/sources_page   -> POST /query/sources     {workspace, cursor?, size?} (all sources, paged)
 *   POST /api/wiki/query/search        -> POST /query/search       {workspace, q}
 *   anything else under /api/wiki      -> 404 not_proxied (`/commands` included), no upstream call
 *
 * The upstream body is built here from the checked fields, never forwarded. Rules:
 * - Workspace `wiki-eng` only. `wiki-private` (or any other) is refused whatever the config says.
 * - The owner token is read from the env var NAMED by config (`wiki.tokenEnv`) at call time and sent
 *   only as `x-wiki-owner-token` to a `http://127.0.0.1:<port>` base URL, with redirects not followed.
 *   It is never logged, echoed in an answer or sent to the browser.
 * - Loopback callers only: `Host` must be `127.0.0.1`/`localhost` (DNS rebinding), and an `Origin`, when
 *   present, a loopback origin.
 * Config: `.compose/compose.json` `wiki` block of the active project,
 * `{ "enabled": true, "tokenEnv": "<ENV NAME>", "baseUrl"?: "http://127.0.0.1:8791", "workspace"?: "wiki-eng" }`.
 * Skipped in remote mode: a paired phone must not reach a proxy that carries the owner token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTargetRoot } from './project-root.js';

const PREFIX = '/api/wiki';
export const WIKI_WORKSPACE = 'wiki-eng';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8791';
export const OWNER_TOKEN_HEADER = 'x-wiki-owner-token';
const DEFAULT_TIMEOUT_MS = 10_000;

// The contract's query calls: wiki query name -> the one filter it takes, its page, and the field's max length.
export const WIKI_QUERIES = {
  feature_hub: { field: 'featureId', filter: 'feature_id', page: { size: 200 }, max: 200 },
  decisions: { field: 'featureId', filter: 'feature_id', page: { size: 50 }, max: 200 },
  search: { field: 'q', filter: 'q', page: {}, max: 256 },
};

// The paged no-filter calls (COMPOSE-WIKI-DECISIONS-1): proxy key -> the wiki query it asks. The page is built from a
// checked `cursor` (opaque string, at most CURSOR_MAX characters, or absent) and `size` (integer 1 to `maxSize`, default
// `maxSize`); there is no filter and nothing else of the body is read.
export const CURSOR_MAX = 512;
export const WIKI_PAGED_QUERIES = {
  decisions_page: { query: 'decisions', maxSize: 50 },
  sources_page: { query: 'sources', maxSize: 50 },
};

/** The upstream `page` for a paged call, or `{error}` naming what is wrong. */
function pageOf(spec, { cursor, size }) {
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > CURSOR_MAX)) {
    return { error: `cursor must be 1 to ${CURSOR_MAX} characters` };
  }
  if (size != null && (!Number.isInteger(size) || size < 1 || size > spec.maxSize)) {
    return { error: `size must be an integer from 1 to ${spec.maxSize}` };
  }
  return { page: { size: size ?? spec.maxSize, ...(cursor != null ? { cursor } : {}) } };
}

const BASE_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const ENV_NAME_RE = /^(?!VITE_)[A-Z_][A-Z0-9_]{0,63}$/; // VITE_* is inlined into the browser bundle, so never a token name

/**
 * The environment a supervised child gets. The wiki token variable reaches only the API server, the one process that
 * runs the proxy: Vite (which exposes VITE_* to the browser) and the agent server (which spawns `claude -p`) never see it.
 */
export function wikiChildEnv(procName, env, tokenEnv) {
  const out = { ...env };
  if (procName !== 'api-server' && typeof tokenEnv === 'string') delete out[tokenEnv];
  return out;
}
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

/** The raw `wiki` block of `<root>/.compose/compose.json` ({} when missing or malformed). */
export function readWikiConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.compose', 'compose.json'), 'utf-8')).wiki ?? {};
  } catch {
    return {};
  }
}

/** Checks a raw `wiki` block: `{ok: true, baseUrl, tokenEnv, workspace, timeoutMs}` or `{ok: false, code}`. */
export function checkWikiConfig(raw) {
  if (!raw || raw.enabled !== true) return { ok: false, code: 'wiki_disabled' };
  const workspace = raw.workspace ?? WIKI_WORKSPACE;
  if (workspace !== WIKI_WORKSPACE) return { ok: false, code: 'workspace_refused' };
  const baseUrl = raw.baseUrl ?? DEFAULT_BASE_URL;
  const m = typeof baseUrl === 'string' ? BASE_URL_RE.exec(baseUrl) : null;
  if (!m || Number(m[1]) > 65535) return { ok: false, code: 'config_invalid' };
  if (typeof raw.tokenEnv !== 'string' || !ENV_NAME_RE.test(raw.tokenEnv)) return { ok: false, code: 'config_invalid' };
  const t = raw.timeoutMs;
  const timeoutMs = Number.isInteger(t) && t > 0 && t <= 60_000 ? t : DEFAULT_TIMEOUT_MS;
  return { ok: true, baseUrl, tokenEnv: raw.tokenEnv, workspace, timeoutMs };
}

const error = (status, code, message) => ({ status, body: { code, message } });
const send = (res, { status, body }) => res.status(status).json(body);
const refuse = (res, status, code, message) => send(res, error(status, code, message));

function localCaller(req) {
  const origin = req.headers.origin;
  return LOOPBACK_HOST_RE.test(req.headers.host ?? '') && (origin === undefined || LOOPBACK_ORIGIN_RE.test(origin));
}

/** Returns true when mounted, false when skipped (remote mode). */
export function attachWikiRoutes(app, {
  remote = false,
  getConfig = (req) => readWikiConfig(req.workspace?.root || getTargetRoot()),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (remote) return false;

  const config = (req) => {
    try { return checkWikiConfig(getConfig(req)); } catch { return { ok: false, code: 'config_invalid' }; }
  };

  // Sends one contract call upstream: `{status, body}`. `body` is null for GET. The token goes in one header and nowhere else.
  async function upstream(cfg, method, path, body) {
    const token = env[cfg.tokenEnv];
    if (!token) return error(503, 'token_missing', `the wiki token env var ${cfg.tokenEnv} is not set for the Compose server`);
    let answer;
    try {
      answer = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method,
        headers: { [OWNER_TOKEN_HEADER]: token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      console.warn(`[wiki] ${path}: the wiki is unreachable (${e?.name ?? 'error'})`);
      return error(502, 'wiki_unreachable', 'the wiki did not answer');
    }
    let json;
    try { json = JSON.parse(await answer.text()); } catch { json = undefined; }
    if (json === undefined || (answer.status >= 300 && answer.status < 400)) {
      console.warn(`[wiki] ${path}: HTTP ${answer.status} without a JSON answer`);
      return error(502, 'bad_response', `the wiki answered HTTP ${answer.status} without JSON`);
    }
    return { status: answer.status, body: json };
  }

  app.use(PREFIX, (req, res, next) => (localCaller(req) ? next() : refuse(res, 403, 'host_refused', 'loopback callers only')));

  app.get(`${PREFIX}/available`, (req, res) => {
    const cfg = config(req);
    res.json(cfg.ok ? { available: true, workspace: cfg.workspace, frameBase: cfg.baseUrl } : { available: false, code: cfg.code });
  });

  app.get(`${PREFIX}/identity`, async (req, res) => {
    const cfg = config(req);
    if (!cfg.ok) return refuse(res, cfg.code === 'workspace_refused' ? 403 : 503, cfg.code, 'the wiki tab is not configured');
    const r = await upstream(cfg, 'GET', '/identity', null);
    // Only the served workspace reaches the browser, whatever else the token's principal holds.
    if (r.status === 200 && Array.isArray(r.body?.workspaces)) r.body = { ...r.body, workspaces: r.body.workspaces.filter((w) => w === cfg.workspace) };
    return send(res, r);
  });

  app.post(`${PREFIX}/query/:name`, async (req, res, next) => {
    const paged = Object.hasOwn(WIKI_PAGED_QUERIES, req.params.name) ? WIKI_PAGED_QUERIES[req.params.name] : null;
    const spec = Object.hasOwn(WIKI_QUERIES, req.params.name) ? WIKI_QUERIES[req.params.name] : null;
    if (!spec && !paged) return next();
    const cfg = config(req);
    if (!cfg.ok) return refuse(res, cfg.code === 'workspace_refused' ? 403 : 503, cfg.code, 'the wiki tab is not configured');
    if (paged) {
      const { workspace, cursor, size } = req.body ?? {};
      if (workspace !== cfg.workspace) return refuse(res, 403, 'workspace_refused', `only ${cfg.workspace} is served here`);
      const p = pageOf(paged, { cursor, size });
      if (p.error) return refuse(res, 400, 'bad_request', p.error);
      return send(res, await upstream(cfg, 'POST', `/query/${paged.query}`, { query: paged.query, workspace: cfg.workspace, filters: {}, page: p.page }));
    }
    const { workspace, [spec.field]: value } = req.body ?? {};
    if (workspace !== cfg.workspace) return refuse(res, 403, 'workspace_refused', `only ${cfg.workspace} is served here`);
    if (typeof value !== 'string' || !value.trim() || value.length > spec.max) {
      return refuse(res, 400, 'bad_request', `${spec.field} must be 1 to ${spec.max} characters`);
    }
    const name = req.params.name;
    return send(res, await upstream(cfg, 'POST', `/query/${name}`, { query: name, workspace: cfg.workspace, filters: { [spec.filter]: value }, page: spec.page }));
  });

  // Everything else (other queries, /commands, /pages, any method) is not proxied and never reaches the wiki.
  app.use(PREFIX, (_req, res) => refuse(res, 404, 'not_proxied', 'not a wiki tab call'));
  return true;
}
