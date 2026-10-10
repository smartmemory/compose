/**
 * gate-jev.js — COMP-GATE-JEV-1: ask Jev for the gate's approve/revise default.
 *
 * `jevGateDefault(summary)` returns 'approve' | 'revise' | null. Null means "no
 * opinion" (flag off, key missing, error, timeout, unexpected answer) and the
 * caller falls back to the keyword regex. It never throws and never waits more
 * than the budget (1500 ms, reconnect included).
 *
 * On by default: used whenever JEV_API_KEY is non-empty, unless COMPOSE_GATE_JEV=0.
 * No key: silent keyword default (COMPOSE_GATE_JEV=1 with no key warns once). The
 * key is read by name, sent only in the Authorization header, and never logged.
 *
 * Transport: one kept-alive HTTPS connection per proxy setting, created lazily
 * and reused across gates. Node's built-in fetch ignores HTTPS_PROXY and the
 * direct route to api.typesafe.ai is refused on some networks (HTTP 451), so the
 * default transport tunnels through HTTPS_PROXY with CONNECT (no new dependency).
 * Sockets are unref'd so an idle connection never keeps `compose build` alive.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const JEV_HOST = 'api.typesafe.ai';
const JEV_PORT = 443;
const JEV_PATH = '/v1/systemone';
export const JEV_BUDGET_MS = 1500;

// Byte-identical to scratch/2026-10-11-gate-jev-retime/question.txt and retime.py.
const QUESTION = "This is the summary of a finished lifecycle step, shown at a review gate. Should the default answer be APPROVE (the step reports its work done, nothing blocking) or REVISE (it reports a defect, failure, missing artifact or unresolved blocker in the step's own work)?";
const QUESTIONS = {
  gate: {
    type: 'choice',
    instructions: QUESTION,
    criteria: {
      APPROVE: 'The step reports its work done, nothing blocking.',
      REVISE: "The step reports a defect, failure, missing artifact or unresolved blocker in the step's own work.",
    },
  },
};

/** Python `json.dumps(obj, ensure_ascii=False)` of `{"step_summary": s}` (": " separator). */
function stateJson(summary) {
  return `{"step_summary": ${JSON.stringify(summary)}}`;
}

/** Request body, same shape as the spike (`ensure_ascii=False`: non-ASCII stays literal). */
export function buildJevBody(summary) {
  return JSON.stringify({
    state: stateJson(summary),
    model: 'jev-latest',
    questions: QUESTIONS,
  });
}

export function jevGateEnabled(env = process.env) {
  return env.COMPOSE_GATE_JEV !== '0' && Boolean(env.JEV_API_KEY);
}

// ---------------------------------------------------------------------------
// Proxy resolution
// ---------------------------------------------------------------------------

/** True when NO_PROXY/no_proxy says `host` must be reached directly. */
export function noProxyMatches(env, host) {
  const raw = env.NO_PROXY ?? env.no_proxy ?? '';
  for (let entry of raw.split(',')) {
    entry = entry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    entry = entry.replace(/:\d+$/, '');
    if (entry.startsWith('*.')) entry = entry.slice(1);
    if (host === entry) return true;
    if (entry.startsWith('.') ? host.endsWith(entry) : host.endsWith('.' + entry)) return true;
  }
  return false;
}

/** Returns {host, port} of the CONNECT proxy to use for `host`, or null for direct. */
export function proxyFor(env, host = JEV_HOST) {
  const raw = env.HTTPS_PROXY ?? env.https_proxy;
  if (!raw || noProxyMatches(env, host.toLowerCase())) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kept-alive transport
// ---------------------------------------------------------------------------

class JevError extends Error {
  constructor(kind, detail) {
    super(detail ? `${kind} (${detail})` : kind);
    this.kind = kind;
  }
}

/**
 * Agent whose sockets are TLS sessions to the Jev host, tunnelled through an
 * HTTP proxy with CONNECT when `proxy` is set. `tlsWrap` is injectable for tests.
 */
function makeAgent({ proxy, tlsWrap, track }) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const wrap = tlsWrap ?? ((socket) => tls.connect({ socket, servername: JEV_HOST }));
  agent.createConnection = (_options, cb) => {
    const finish = (err, sock) => {
      if (!err) { sock.unref?.(); track(sock); }
      cb(err, sock);
    };
    if (!proxy) {
      const s = tls.connect({ host: JEV_HOST, port: JEV_PORT, servername: JEV_HOST });
      s.unref();
      track(s);
      return s;
    }
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${JEV_HOST}:${JEV_PORT}` });
    // ClientRequest has no unref() on Node 22: unref its socket the moment it exists.
    req.once('socket', (s) => { s.unref(); track(s); });
    track(req);
    req.once('connect', (res, socket) => {
      socket.unref();
      track(socket);
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(new JevError('proxy', `CONNECT ${res.statusCode}`));
      }
      const secure = wrap(socket);
      secure.once('error', () => {});
      finish(null, secure);
    });
    req.once('error', (err) => finish(new JevError('error', err.code)));
    req.end();
  };
  return agent;
}

const transports = new Map();

/**
 * Build a transport: `(body, {key, signal}) => Promise<parsedJson>`. One agent is
 * kept per proxy setting; a socket that dies mid-request is replaced once.
 */
export function createJevTransport({ proxy = null, tlsWrap, hostOverride } = {}) {
  let agent = null;
  // Every CONNECT request and socket the agent creates, so the budget can destroy
  // them (a stalled proxy otherwise holds the request and the process open).
  const live = new Set();
  const track = (h) => {
    live.add(h);
    h.once?.('close', () => live.delete(h));
  };
  const destroyLive = () => { for (const h of live) h.destroy(); live.clear(); };
  const getAgent = () => (agent ??= makeAgent({ proxy, tlsWrap, track }));

  function once(body, { key, signal }) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        agent: getAgent(),
        method: 'POST',
        host: hostOverride ?? JEV_HOST,
        path: JEV_PATH,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        signal,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (err) => reject(new JevError('error', err.code)));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode > 299) {
            return reject(new JevError('http', String(res.statusCode)));
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new JevError('malformed'));
          }
        });
      });
      req.once('error', (err) => {
        reject(err instanceof JevError ? err : new JevError(err.name === 'AbortError' ? 'timeout' : 'error', err.code));
      });
      req.end(body);
    });
  }

  async function transport(body, opts) {
    const onAbort = () => destroyLive();
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await once(body, opts);
    } catch (err) {
      // Dead or refused connection: drop the pool and reconnect once, only
      // while the shared budget (opts.signal) is still alive.
      if (err.kind !== 'error' || opts.signal?.aborted) throw err;
      agent?.destroy();
      agent = null;
      return await once(body, opts);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  transport.close = () => { agent?.destroy(); agent = null; destroyLive(); };
  return transport;
}

function defaultTransport(env) {
  const proxy = proxyFor(env);
  const k = proxy ? `${proxy.host}:${proxy.port}` : 'direct';
  if (!transports.has(k)) transports.set(k, createJevTransport({ proxy }));
  return transports.get(k);
}

/** Drop every cached connection (tests, shutdown). */
export function closeJevTransports() {
  for (const t of transports.values()) t.close();
  transports.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const warned = new Set();
export function resetJevWarnings() { warned.clear(); }

function warnOnce(kind, warn) {
  if (warned.has(kind)) return;
  warned.add(kind);
  warn(`WARNING: gate-jev ${kind}; using the keyword default\n`);
}

/**
 * @param {string} summary
 * @param {{env?: object, timeoutMs?: number, transport?: Function, warn?: Function}} [opts]
 * @returns {Promise<'approve'|'revise'|null>}
 */
export async function jevGateDefault(summary, { env = process.env, timeoutMs = JEV_BUDGET_MS, transport, warn } = {}) {
  if (!summary) return null;
  const emit = warn ?? ((m) => process.stderr.write(m));
  if (!jevGateEnabled(env)) {
    // Explicitly asked for (=1) but no key: say so once. Unset or =0: silent.
    if (env.COMPOSE_GATE_JEV === '1') warnOnce('no-key', emit);
    return null;
  }
  const ctl = new AbortController();
  let timer;
  try {
    const send = transport ?? defaultTransport(env);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new JevError('timeout')); }, timeoutMs);
    });
    const call = Promise.resolve().then(() => send(buildJevBody(summary), { key: env.JEV_API_KEY, signal: ctl.signal }));
    call.catch(() => {}); // a late rejection after the timeout must not go unhandled
    const json = await Promise.race([call, timeout]);
    const choice = json?.answers?.gate?.choice;
    const label = typeof choice === 'string' ? choice.toUpperCase() : '';
    if (label === 'APPROVE' || label === 'REVISE') return label.toLowerCase();
    warnOnce('unexpected', emit);
    return null;
  } catch (err) {
    warnOnce(err instanceof JevError ? err.kind : 'error', emit);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
