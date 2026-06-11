/**
 * remote-utils.js — COMP-MOBILE-REMOTE S02
 *
 * Side-effect-free exports from the remote transport layer.
 * Split from server/index.js so tests can import these without
 * triggering the server startup code that runs at index.js module level.
 *
 * Exports:
 *   resolveComposeHost()  — env > config > '127.0.0.1'
 *   attachAgentProxy()    — /api/agent/proxy/* → 127.0.0.1:${agentPort}/api/agent/*
 *
 * server/index.js re-exports both symbols so callers can import from either path.
 *
 * @module server/remote-utils
 */

import http from 'node:http';
import { loadProjectConfig } from './project-root.js';

// ---------------------------------------------------------------------------
// resolveComposeHost
// ---------------------------------------------------------------------------

/**
 * Resolve the bind host for the API server.
 * Precedence: COMPOSE_HOST env > .compose/compose.json server.host > '127.0.0.1'
 *
 * @returns {string}
 */
export function resolveComposeHost() {
  if (process.env.COMPOSE_HOST) return process.env.COMPOSE_HOST;
  try {
    const cfg = loadProjectConfig();
    if (cfg && cfg.server && cfg.server.host) return cfg.server.host;
  } catch {
    // ignore — fall through to default
  }
  return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// attachAgentProxy
// ---------------------------------------------------------------------------

/**
 * Attach agent proxy routes to the Express app.
 * Routes: /api/agent/proxy/* → 127.0.0.1:${agentPort}/api/agent/*
 * - Injects x-compose-token server-side (strips any client-sent value)
 * - SSE pass-through (Content-Type: text/event-stream, no buffering)
 * - 502 on upstream connect failure
 *
 * @param {object} app
 * @param {{ agentPort: number }} opts
 */
export function attachAgentProxy(app, { agentPort }) {
  const PROXY_ROUTES = [
    { method: 'GET',  proxyPath: '/api/agent/proxy/stream',         upstreamPath: '/api/agent/stream'         },
    { method: 'POST', proxyPath: '/api/agent/proxy/session',        upstreamPath: '/api/agent/session'        },
    { method: 'POST', proxyPath: '/api/agent/proxy/message',        upstreamPath: '/api/agent/message'        },
    { method: 'POST', proxyPath: '/api/agent/proxy/interrupt',      upstreamPath: '/api/agent/interrupt'      },
    { method: 'GET',  proxyPath: '/api/agent/proxy/session/status', upstreamPath: '/api/agent/session/status' },
  ];

  for (const { method, proxyPath, upstreamPath } of PROXY_ROUTES) {
    const handler = (req, res) => {
      // Build upstream URL (include query string)
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

      // Pre-compute body for POST routes: Express's express.json() has already
      // consumed the raw stream and populated req.body. Re-serialize for forwarding.
      let bodyBuf = null;
      if (req.method !== 'GET' && req.body !== undefined) {
        bodyBuf = Buffer.from(JSON.stringify(req.body));
      }

      const headers = { ...req.headers };

      // Strip hop-by-hop headers
      delete headers['host'];
      delete headers['connection'];
      delete headers['transfer-encoding'];

      // Inject the server-side sensitive token; strip any client-sent credential
      delete headers['x-compose-token'];
      delete headers['authorization'];
      const apiToken = process.env.COMPOSE_API_TOKEN;
      if (apiToken) headers['x-compose-token'] = apiToken;

      // Set body headers for POST
      if (bodyBuf) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = bodyBuf.length;
      }

      const options = {
        hostname: '127.0.0.1',
        port: agentPort,
        path: upstreamPath + qs,
        method: req.method,
        headers,
      };

      const upstream = http.request(options, (upstreamRes) => {
        // Copy status + headers verbatim (including SSE headers)
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
      });

      upstream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Agent server unavailable' });
        }
      });

      // Abort upstream when the downstream response is closed by the client.
      // Listening on res 'close' (not req 'close') ensures we only destroy on
      // actual disconnection — not on the natural completion of a POST body send.
      // This is the correct pattern for SSE: the browser closes the EventSource
      // → res 'close' fires → upstream destroyed.
      res.on('close', () => upstream.destroy());

      if (bodyBuf) {
        upstream.write(bodyBuf);
      }
      upstream.end();
    };

    if (method === 'GET') {
      app.get(proxyPath, handler);
    } else {
      app.post(proxyPath, handler);
    }
  }
}
