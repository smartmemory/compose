/**
 * auth-middleware.js — COMP-MOBILE-REMOTE S01
 *
 * Express middleware for remote auth:
 *   - createRateLimiter      — fixed-window per-IP limiter (no deps)
 *   - requirePairingToken    — JWT-only gate, attaches req.device
 *   - requireSensitiveOrPaired — composite: sensitive token OR valid JWT
 *   - createAuthGate         — default-deny gate with allowlist
 *   - wsUpgradeTokenOk       — check ?token= on WS upgrade requests
 *
 * @module server/auth-middleware
 */

import { parse as parseUrl } from 'node:url';

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Create a fixed-window per-IP rate limiter.
 *
 * @param {{ windowMs?: number, max?: number }} [opts]
 * @param {number} [opts.windowMs=60000]  Window size in ms
 * @param {number} [opts.max=10]          Max requests per window per IP
 * @returns {function}  Express middleware
 */
export function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  /** ip → { count: number, windowStart: number } */
  const _windows = new Map();

  function _sweep() {
    const now = Date.now();
    for (const [ip, entry] of _windows) {
      if (now - entry.windowStart >= windowMs) _windows.delete(ip);
    }
  }

  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    // Opportunistic sweep (amortized)
    if (_windows.size > 500) _sweep();

    let entry = _windows.get(ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      _windows.set(ip, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests',
        code: 'RateLimited',
      });
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// requirePairingToken
// ---------------------------------------------------------------------------

/**
 * Middleware: require a valid pairing JWT.
 *
 * Reads from:
 *   1. Authorization: Bearer <jwt>
 *   2. x-compose-token: <jwt>  (back-compat)
 *
 * On success: attaches req.device = { id, name }, calls next().
 * On failure: 401 { error, code: 'TokenExpired'|'TokenInvalid' }
 *
 * @param {object} store  Auth store from createAuthStore
 * @returns {function}
 */
export function requirePairingToken(store) {
  return function pairingTokenMiddleware(req, res, next) {
    const jwt = _extractBearer(req);
    if (!jwt) {
      return res.status(401).json({ error: 'Unauthorized', code: 'TokenInvalid' });
    }
    const result = store.verifyAccessToken(jwt);
    if (!result.ok) {
      return res.status(401).json({ error: 'Unauthorized', code: result.code });
    }
    req.device = { id: result.device_id, name: result.name };
    next();
  };
}

// ---------------------------------------------------------------------------
// requireSensitiveOrPaired
// ---------------------------------------------------------------------------

/**
 * Composite middleware factory: accepts EITHER the sensitive token OR a valid JWT.
 *
 * Behavior mirrors requireSensitiveToken exactly when no JWT is presented:
 *   - 503 when COMPOSE_API_TOKEN is unset (existing tests depend on this)
 *   - 401 when token mismatch
 *
 * @param {object} store  Auth store from createAuthStore
 * @returns {function}    Express middleware
 */
export function requireSensitiveOrPaired(store) {
  return function sensitiveOrPairedMiddleware(req, res, next) {
    const expected = process.env.COMPOSE_API_TOKEN;

    // Check if a JWT is presented first
    const jwt = _extractBearer(req);
    if (jwt) {
      const result = store.verifyAccessToken(jwt);
      if (result.ok) {
        req.device = { id: result.device_id, name: result.name };
        return next();
      }
      // JWT presented but invalid/expired — fall through to sensitive token check
      // but only if no env token (503 parity): when no env token, the sensitive
      // check would have returned 503, so we preserve that.
    }

    // Exact sensitive-token check — mirrors security.js requireSensitiveToken
    if (!expected) {
      return res.status(503).json({
        error:
          'Sensitive endpoint disabled: missing COMPOSE_API_TOKEN (run via supervisor or set it manually)',
      });
    }

    const provided = req.get('x-compose-token');
    if (provided && provided === expected) {
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
  };
}

// ---------------------------------------------------------------------------
// createAuthGate
// ---------------------------------------------------------------------------

/**
 * Create the default-deny auth gate for remote mode.
 *
 * Mounted ONLY when COMPOSE_REMOTE_AUTH=enabled. When off, this is never called.
 *
 * Allowlist entries can be:
 *   - Exact strings: '/api/health'
 *   - Prefix strings ending with '/': '/assets/'
 *   - Plain prefix strings (no trailing slash): '/m' matches '/m', '/m/', '/m/pair'
 *
 * Token sources accepted:
 *   - x-compose-token header (sensitive token)
 *   - Authorization: Bearer <jwt>
 *   - x-compose-token: <jwt> (back-compat)
 *   - ?token=<jwt or sensitive> query param ONLY for:
 *       - GET requests with Accept: text/event-stream
 *       - The SSE proxy path /api/agent/proxy/stream
 *
 * @param {{ store: object, allowlist: string[] }} opts
 * @returns {function}  Express middleware
 */
export function createAuthGate({ store, allowlist = [], streamPaths = [] }) {
  const _exactPaths = new Set();
  const _prefixes = [];

  for (const entry of allowlist) {
    if (entry.endsWith('/')) {
      _prefixes.push(entry.slice(0, -1)); // strip trailing slash for comparison
    } else {
      _exactPaths.add(entry);
      // Also register as prefix for sub-paths (e.g. '/m' covers '/m/pair')
      _prefixes.push(entry);
    }
  }

  function _allowed(path) {
    if (_exactPaths.has(path)) return true;
    return _prefixes.some(
      (p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'),
    );
  }

  return function authGate(req, res, next) {
    const path = req.path || '/';

    // 1. Allowlist check
    if (_allowed(path)) return next();

    // 2. Sensitive token check
    const expected = process.env.COMPOSE_API_TOKEN;
    const sensitiveHeader = req.get('x-compose-token');
    if (expected && sensitiveHeader === expected) return next();

    // 3. JWT check (Authorization: Bearer or x-compose-token back-compat)
    const jwt = _extractBearer(req);
    if (jwt) {
      const result = store.verifyAccessToken(jwt);
      if (result.ok) {
        req.device = { id: result.device_id, name: result.name };
        return next();
      }
      // JWT present but invalid — return its specific error code
      return res.status(401).json({ error: 'Unauthorized', code: result.code });
    }

    // 4. Query-param token — ONLY on the explicit stream-path allowlist.
    // Never keyed on the Accept header: a spoofed `Accept: text/event-stream`
    // must not let arbitrary GETs authenticate via URL (credentials would
    // leak into URLs/logs that the header-only contract keeps out of band).
    const isStreamPath = req.method === 'GET' && streamPaths.includes(path);

    if (isStreamPath) {
      const queryToken = _extractQueryToken(req);
      if (queryToken) {
        // Accept sensitive token or JWT
        if (expected && queryToken === expected) return next();
        const result = store.verifyAccessToken(queryToken);
        if (result.ok) {
          req.device = { id: result.device_id, name: result.name };
          return next();
        }
        return res.status(401).json({ error: 'Unauthorized', code: result.code });
      }
    }

    // 5. Default deny
    return res.status(401).json({ error: 'Unauthorized', code: 'TokenInvalid' });
  };
}

// ---------------------------------------------------------------------------
// wsUpgradeTokenOk
// ---------------------------------------------------------------------------

/**
 * Check if a WS upgrade request carries a valid token in its query string.
 *
 * Accepts `?token=<sensitive token>` or `?token=<valid JWT>`.
 * Called from the server's manual upgrade handler (server/index.js:143-156).
 * Token value is never logged.
 *
 * @param {object} store  Auth store
 * @param {object} req    Node http.IncomingMessage
 * @returns {boolean}
 */
export function wsUpgradeTokenOk(store, req) {
  const queryToken = _extractQueryTokenFromUrl(req.url || '');
  if (!queryToken) return false;

  const expected = process.env.COMPOSE_API_TOKEN;
  if (expected && queryToken === expected) return true;

  const result = store.verifyAccessToken(queryToken);
  return result.ok === true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract JWT from Authorization: Bearer <jwt> or x-compose-token header.
 * Returns null if not present or not in Bearer format.
 */
function _extractBearer(req) {
  const auth = req.get('authorization') || req.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim() || null;
  }
  // Back-compat: x-compose-token may carry a JWT (not the sensitive key)
  // We let the caller decide what to do with it; return it here only if
  // it does NOT look like the sensitive token (no env check here — store.verify handles it).
  // Actually the design says x-compose-token back-compat for pairingToken — return it.
  // requirePairingToken reads it; the gate handles the sensitive-token check separately.
  const xt = req.get('x-compose-token') || '';
  if (xt && xt !== (process.env.COMPOSE_API_TOKEN || '')) {
    return xt;
  }
  return null;
}

/**
 * Extract ?token= from a parsed req (Express req has req.query).
 */
function _extractQueryToken(req) {
  return (req.query && req.query.token) || _extractQueryTokenFromUrl(req.url || '');
}

/**
 * Extract ?token= from a raw URL string (used for WS upgrade requests which
 * are plain IncomingMessage, not Express req).
 */
function _extractQueryTokenFromUrl(url) {
  try {
    const parsed = parseUrl(url, true);
    return parsed.query?.token || null;
  } catch {
    return null;
  }
}
