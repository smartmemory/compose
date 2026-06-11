/**
 * security.js — Shared guards for sensitive local endpoints.
 *
 * Usage:
 * 1) In normal dev flow, server/supervisor.js auto-generates COMPOSE_API_TOKEN.
 * 2) If running servers directly, set COMPOSE_API_TOKEN in the environment.
 * 3) Send header: x-compose-token: <COMPOSE_API_TOKEN>
 *
 * S02 (COMP-MOBILE-REMOTE): adds configureAuthStore() shim so that build-routes,
 * vision-routes, and vision-server can swap their import from requireSensitiveToken
 * to requireSensitiveOrPaired without changing call-site syntax.
 *
 * When no store is configured, requireSensitiveOrPaired behaves byte-identically
 * to requireSensitiveToken (503 when env unset, 401 on mismatch).
 */

import { requireSensitiveOrPaired as _makeComposite } from './auth-middleware.js';

let _store = null;

/**
 * Configure the module-level auth store.
 * Called from server/index.js when the store is created (both modes).
 * When not called (tests, direct runs without pairing), _store stays null
 * and requireSensitiveOrPaired delegates only to the sensitive-token path.
 *
 * @param {object|null} store  Auth store from createAuthStore, or null to clear
 */
export function configureAuthStore(store) {
  _store = store;
}

/**
 * Original single-path guard — kept for back-compat.
 * Call sites that already import this continue to work unchanged.
 */
export function requireSensitiveToken(req, res, next) {
  const expected = process.env.COMPOSE_API_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'Sensitive endpoint disabled: missing COMPOSE_API_TOKEN (run via supervisor or set it manually)',
    });
  }

  const provided = req.get('x-compose-token');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * Composite guard: accepts EITHER the sensitive token OR a valid pairing JWT.
 *
 * When _store is null (no pairing configured) the JWT branch is never reached
 * and behavior is byte-identical to requireSensitiveToken.
 *
 * Exported so build-routes.js / vision-routes.js can import it directly.
 */
export function requireSensitiveOrPaired(req, res, next) {
  if (_store) {
    // Delegate to auth-middleware's factory with the configured store
    return _makeComposite(_store)(req, res, next);
  }
  // No store — fall back to legacy sensitive-token behavior
  return requireSensitiveToken(req, res, next);
}
