/**
 * auth-routes.js — COMP-MOBILE-REMOTE S01
 *
 * Remote pairing and device management routes.
 * Attach with attachAuthRoutes(app, { store, broadcast, requireSensitive }).
 *
 * Routes:
 *   POST /api/auth/pair/init      — requires sensitive token
 *   GET  /api/auth/pair/status    — requires sensitive token
 *   POST /api/auth/pair/complete  — public, rate-limited 10/min
 *   POST /api/auth/refresh        — public, rate-limited 10/min
 *   GET  /api/auth/devices        — requires sensitive token
 *   DELETE /api/auth/devices/:id  — requires sensitive token
 *
 * @module server/auth-routes
 */

import { createRateLimiter } from './auth-middleware.js';

/**
 * Attach auth routes to an Express app.
 *
 * @param {object} app             Express application
 * @param {{ store: object,
 *            broadcast?: function,
 *            requireSensitive: function }} opts
 *   - store:           auth store from createAuthStore
 *   - broadcast:       optional function(msg) for WS broadcast (e.g. vision-server's broadcastMessage)
 *   - requireSensitive: middleware that enforces COMPOSE_API_TOKEN (requireSensitiveToken or composite)
 */
export function attachAuthRoutes(app, { store, broadcast = null, requireSensitive }) {
  const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

  // -------------------------------------------------------------------------
  // POST /api/auth/pair/init
  // -------------------------------------------------------------------------
  /**
   * Initiate a pairing session.
   * Returns { code, expires_at, pair_url: null }.
   * pair_url composition is the CLI/cockpit's responsibility — they know public_host.
   *
   * BP-gate finding #2: only CLI/cockpit poll status; both hold the sensitive token.
   * pair/init is NOT allowlisted.
   */
  app.post('/api/auth/pair/init', requireSensitive, (req, res) => {
    const { code, expires_at } = store.createPairingCode();
    res.json({ code, expires_at, pair_url: null });
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/pair/status?code=
  // -------------------------------------------------------------------------
  /**
   * Poll pairing code status (sensitive token required — not public).
   * Returns { status: 'pending'|'consumed'|'expired' }
   */
  app.get('/api/auth/pair/status', requireSensitive, (req, res) => {
    const code = req.query?.code;
    if (!code) {
      return res.status(400).json({ error: 'Missing code parameter' });
    }
    const status = store.getPairingCodeStatus(code);
    res.json({ status });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/pair/complete
  // -------------------------------------------------------------------------
  /**
   * Consume a pairing code and create a device.
   * PUBLIC (code is the auth), rate-limited.
   * Body: { code, device_name? }
   * Returns: { access_token, refresh_token, device_id, expires_in }
   * Broadcasts: { type: 'devicePaired', device_id, name, timestamp } on success.
   */
  app.post('/api/auth/pair/complete', publicLimiter, (req, res) => {
    const { code, device_name } = req.body || {};

    if (!code) {
      return res.status(400).json({ error: 'Missing code', code: 'CodeInvalid' });
    }

    const ua = req.get('user-agent') || '';
    const result = store.consumePairingCode(code, {
      name: device_name || ua.slice(0, 80) || 'Unknown Device',
      user_agent: ua,
    });

    if (result.error) {
      const status = result.error === 'CodeExpired' ? 400 : 400;
      return res.status(status).json({ error: result.error, code: result.error });
    }

    // Broadcast to cockpit watchers (null-safe)
    if (typeof broadcast === 'function') {
      try {
        broadcast({
          type: 'devicePaired',
          device_id: result.device.id,
          name: result.device.name,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // best-effort broadcast
      }
    }

    res.json({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      device_id: result.device.id,
      expires_in: result.expires_in,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/refresh
  // -------------------------------------------------------------------------
  /**
   * Rotate a refresh token and issue new tokens.
   * PUBLIC (refresh token is the auth), rate-limited.
   * Body: { refresh_token }
   * Returns: { access_token, refresh_token, expires_in }
   */
  app.post('/api/auth/refresh', publicLimiter, (req, res) => {
    const { refresh_token } = req.body || {};

    if (!refresh_token) {
      return res.status(401).json({ error: 'Missing refresh_token', code: 'TokenInvalid' });
    }

    const result = store.refresh(refresh_token);
    if (result.error) {
      return res.status(401).json({ error: result.error, code: 'TokenInvalid' });
    }

    res.json({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_in: result.expires_in,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/devices
  // -------------------------------------------------------------------------
  /**
   * List all paired devices (without hash fields).
   * Requires sensitive token.
   */
  app.get('/api/auth/devices', requireSensitive, (req, res) => {
    res.json({ devices: store.listDevices() });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/auth/devices/:id
  // -------------------------------------------------------------------------
  /**
   * Revoke a device.
   * Requires sensitive token.
   * Returns { ok: true } or 404.
   */
  app.delete('/api/auth/devices/:id', requireSensitive, (req, res) => {
    const found = store.revokeDevice(req.params.id);
    if (!found) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json({ ok: true });
  });
}
