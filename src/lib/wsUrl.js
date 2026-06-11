/**
 * wsUrl.js — COMP-MOBILE-REMOTE S05.
 *
 * Shared URL builders for WebSocket and SSE connections — the single place for
 * WS/SSE credential transport (the auth gate accepts ?token= on SSE-accept GETs
 * and WS upgrades only; header auth everywhere else).
 *
 * Token appended ONLY when:
 *   - paired mode AND an access JWT is in storage  → access JWT, or
 *   - cockpit mode AND remote mode flag set AND a sensitive token is set
 *     → sensitive token.
 * Otherwise the builders return today's exact URLs — with no mode/token set
 * the output is byte-identical to the inline construction they replace
 * (remote-off compatibility guarantee).
 *
 * Desktop never sets remote mode in v1 — localhost works without tokens since
 * the gate is unmounted there. MobileApp/PairPage set it true when paired.
 * Use the builders in function form (() => visionWsUrl()) so a reconnect
 * computes a fresh URL (picks up refreshed tokens).
 */

import { getAuthMode } from './wsFetch.js';
import { ACCESS_KEY, getSensitiveToken } from './compose-api.js';

let _remoteMode = false;

export function setRemoteMode(flag) {
  _remoteMode = !!flag;
}

export function isRemoteMode() {
  return _remoteMode;
}

function currentToken() {
  if (getAuthMode() === 'mobile-paired') {
    // Paired: raw read of the stored access JWT — fresh per URL computation.
    try {
      const tok = localStorage.getItem(ACCESS_KEY);
      if (tok) return tok;
    } catch { /* no storage — fall through tokenless */ }
    return null;
  }
  if (_remoteMode) {
    const tok = getSensitiveToken();
    if (tok) return tok;
  }
  return null;
}

function withToken(url) {
  const tok = currentToken();
  return tok ? `${url}?token=${encodeURIComponent(tok)}` : url;
}

function wsBase(path) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

/** ws(s)://host/ws/vision — ?token= appended only in remote modes. */
export function visionWsUrl() {
  return withToken(wsBase('/ws/vision'));
}

/** ws(s)://host/ws/files — ?token= appended only in remote modes. */
export function filesWsUrl() {
  return withToken(wsBase('/ws/files'));
}

/**
 * streamUrl(path) — relative SSE path, optionally with ?token= as the FIRST
 * query param. Callers appending their own params must use '&' when the
 * result already contains '?'.
 */
export function streamUrl(path) {
  return withToken(path);
}
