/**
 * loopback-guard.js — the one Host/Origin check for the local cockpit API (COMP-LOOPBACK-HOST-GUARD-1).
 *
 * A server bound to 127.0.0.1 still answers whatever Host a browser sends. A hostile page that rebinds its DNS name to
 * 127.0.0.1 is then SAME-ORIGIN with the API, so CORS never applies and it can read and write everything the API serves.
 * Refusing any Host that is not a loopback name (and any Origin that is not a loopback origin) closes that.
 *
 * Local mode only: remote mode is reached on purpose by a non-loopback Host and is covered by the auth gate instead.
 */

export const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
export const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

/** True for a loopback Host header (any port). */
export const isLoopbackHost = (host) => LOOPBACK_HOST_RE.test(host ?? '');

/** True when the request names a loopback Host and carries either no Origin or a loopback one. */
export function isLoopbackRequest(req) {
  const origin = req.headers.origin;
  return isLoopbackHost(req.headers.host) && (origin === undefined || LOOPBACK_ORIGIN_RE.test(origin));
}

/** `allowedHosts` for the sibling handlers: they call `.includes(host)` on it, so a predicate stands in for a port-bound list. */
export const loopbackAllowedHosts = { includes: isLoopbackHost };

/**
 * Express middleware: 403 `{error:{code:"HOST"}}` for a non-loopback Host or Origin.
 * `{ origin: false }` checks the Host only: the agent server (4002) is also reached by the remote-mode proxy, which strips
 * the Host but forwards the browser's (non-loopback) Origin.
 */
export function loopbackGuard({ origin = true } = {}) {
  return (req, res, next) => {
    if (origin ? isLoopbackRequest(req) : isLoopbackHost(req.headers.host)) return next();
    return res.status(403).json({ error: { code: 'HOST', message: 'host not allowed' } });
  };
}

/** For a manual `upgrade` handler: false (after writing a 403 and destroying the socket) when the request is not loopback. */
export function guardUpgrade(req, socket) {
  if (isLoopbackRequest(req)) return true;
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  socket.destroy();
  return false;
}
