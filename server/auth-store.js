/**
 * auth-store.js — COMP-MOBILE-REMOTE S01
 *
 * Device store for remote pairing auth:
 *   - Persistent state at <dataDir>/remote-auth.json (atomic temp+rename writes)
 *   - HS256 JWT sign/verify on node:crypto (no external dep, alg hardcoded)
 *   - Pairing codes: in-memory Map, 5-min TTL, single-use
 *   - Refresh token rotation + history ring (5) + reuse-revoke
 *   - rotateSecret, listDevices, revokeDevice, touchDevice
 *   - Audit log: JSONL appended to <dataDir>/remote-auth-audit.log
 *
 * @module server/auth-store
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE = 'remote-auth.json';
const AUDIT_FILE = 'remote-auth-audit.log';

/**
 * Fixed accepted JWT header base64url: base64url({"alg":"HS256","typ":"JWT"})
 * Any other header bytes are rejected — no algorithm negotiation.
 */
const FIXED_HEADER_B64 = Buffer.from(
  JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
).toString('base64url');

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_HISTORY_MAX = 5;
const TOUCH_THROTTLE_MS = 60_000; // once per 60s per device

/**
 * QR/typing-friendly alphabet: uppercase A-Z + digits 2-9.
 * Omits 0, 1, O, I to avoid visual confusion.
 * 32 characters → 5 bits of entropy per char; 9 bytes → 9 chars (~45 bits).
 */
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------------------
// Internal helpers (module-level, pure)
// ---------------------------------------------------------------------------

function toBase64url(buf) {
  return buf.toString('base64url');
}

function fromBase64url(str) {
  return Buffer.from(str, 'base64url');
}

/** SHA-256 of a Buffer, returned as hex string. */
function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Map 9 random bytes to a 9-char code from CODE_ALPHABET.
 * Each byte is taken modulo alphabet length.
 */
function bytesToCode(bytes) {
  let code = '';
  for (const b of bytes) {
    code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an auth store backed by <dataDir>.
 *
 * @param {string} dataDir  Directory for persistent files (e.g. .compose/data)
 * @returns {{ signAccessToken, verifyAccessToken, createPairingCode,
 *             getPairingCodeStatus, consumePairingCode, refresh,
 *             listDevices, revokeDevice, rotateSecret, touchDevice }}
 */
export function createAuthStore(dataDir) {
  /**
   * In-memory pairing codes.
   * code → { expires_ts: number, consumed: boolean }
   */
  const _pairingCodes = new Map();

  /** Per-device last-touch timestamps for write-storm throttle. */
  const _lastTouch = new Map();

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  function _statePath() {
    return join(dataDir, STATE_FILE);
  }

  function _auditPath() {
    return join(dataDir, AUDIT_FILE);
  }

  /**
   * Read state from disk.  Returns a default skeleton if the file is missing
   * or corrupted.
   */
  function _readState() {
    const p = _statePath();
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        // corrupted — fall through to default
      }
    }
    return { secret: null, devices: [] };
  }

  /**
   * Atomic write: write to <path>.tmp then rename into place.
   * Same pattern as lib/build.js writeActiveBuild.
   */
  function _persist(state) {
    mkdirSync(dataDir, { recursive: true });
    const target = _statePath();
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, target);
  }

  // -------------------------------------------------------------------------
  // Secret bootstrap
  // -------------------------------------------------------------------------

  /**
   * Ensure state has a secret; if not, generate and persist one.
   * Mutates state in place.
   */
  function _ensureSecret(state) {
    if (!state.secret) {
      state.secret = randomBytes(32).toString('hex');
      _persist(state);
    }
    return state.secret;
  }

  /** Read state and return the signing secret, generating if absent. */
  function _getSecret() {
    const state = _readState();
    return _ensureSecret(state);
  }

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  /**
   * Append a JSONL audit line.  Never throws.
   *
   * @param {string} event     - pair | refresh | revoke | reuse-revoke | rotate-secret
   * @param {string} [device_id]
   */
  function _audit(event, device_id) {
    try {
      mkdirSync(dataDir, { recursive: true });
      const record = { ts: new Date().toISOString(), event };
      if (device_id) record.device_id = device_id;
      appendFileSync(_auditPath(), JSON.stringify(record) + '\n');
    } catch {
      // best-effort — must not throw
    }
  }

  // -------------------------------------------------------------------------
  // JWT sign / verify
  // -------------------------------------------------------------------------

  /**
   * Sign an HS256 access JWT.
   *
   * Header is always {"alg":"HS256","typ":"JWT"}.
   * Claims: { sub: device.id, name: device.name, iat, exp }
   * TTL from ACCESS_TOKEN_TTL env (seconds), default 900 (15 min).
   *
   * @param {{ id: string, name: string }} device
   * @returns {string}
   */
  function signAccessToken(device) {
    const secret = _getSecret();
    const ttl = parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ttl;

    const header = FIXED_HEADER_B64;
    const payload = toBase64url(
      Buffer.from(JSON.stringify({ sub: device.id, name: device.name, iat, exp })),
    );
    const data = `${header}.${payload}`;
    const sig = toBase64url(createHmac('sha256', secret).update(data).digest());
    return `${data}.${sig}`;
  }

  /**
   * Verify an HS256 JWT.
   *
   * Steps:
   *  1. Must split into exactly 3 parts
   *  2. Header must be byte-identical to FIXED_HEADER_B64 (rejects alg:none etc.)
   *  3. HMAC-SHA256 signature validated with timingSafeEqual
   *  4. exp checked with ±30s clock skew
   *
   * @param {string} jwt
   * @returns {{ ok: true, device_id: string, name: string }
   *          |{ ok: false, code: 'TokenExpired'|'TokenInvalid' }}
   */
  function verifyAccessToken(jwt) {
    if (typeof jwt !== 'string') return { ok: false, code: 'TokenInvalid' };

    const parts = jwt.split('.');
    if (parts.length !== 3) return { ok: false, code: 'TokenInvalid' };

    const [headerB64, payloadB64, sigB64] = parts;

    // 1. Reject any header that is not exactly the fixed accepted one
    if (headerB64 !== FIXED_HEADER_B64) return { ok: false, code: 'TokenInvalid' };

    // 2. Verify signature
    let secret;
    try {
      secret = _getSecret();
    } catch {
      return { ok: false, code: 'TokenInvalid' };
    }

    const data = `${headerB64}.${payloadB64}`;
    const expected = createHmac('sha256', secret).update(data).digest();

    let provided;
    try {
      provided = fromBase64url(sigB64);
    } catch {
      return { ok: false, code: 'TokenInvalid' };
    }
    // timingSafeEqual requires equal-length buffers
    if (expected.length !== provided.length) return { ok: false, code: 'TokenInvalid' };
    if (!timingSafeEqual(expected, provided)) return { ok: false, code: 'TokenInvalid' };

    // 3. Decode payload
    let claims;
    try {
      claims = JSON.parse(fromBase64url(payloadB64).toString('utf8'));
    } catch {
      return { ok: false, code: 'TokenInvalid' };
    }

    // 4. Check expiry with ±30s skew
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || now > claims.exp + 30) {
      return { ok: false, code: 'TokenExpired' };
    }

    return { ok: true, device_id: claims.sub, name: claims.name };
  }

  // -------------------------------------------------------------------------
  // Pairing codes
  // -------------------------------------------------------------------------

  /** Sweep expired entries from the in-memory code Map. */
  function _sweepCodes() {
    const now = Date.now();
    for (const [code, entry] of _pairingCodes) {
      if (entry.expires_ts <= now) _pairingCodes.delete(code);
    }
  }

  /**
   * Generate a new single-use pairing code (5-min TTL).
   *
   * @returns {{ code: string, expires_at: string }}
   */
  function createPairingCode() {
    _sweepCodes();
    const bytes = randomBytes(9);
    const code = bytesToCode(bytes);
    const expires_ts = Date.now() + PAIRING_CODE_TTL_MS;
    _pairingCodes.set(code, { expires_ts, consumed: false });
    return { code, expires_at: new Date(expires_ts).toISOString() };
  }

  /**
   * Get the status of a pairing code.
   *
   * @param {string} code
   * @returns {'pending'|'consumed'|'expired'}
   */
  function getPairingCodeStatus(code) {
    const entry = _pairingCodes.get(code);
    if (!entry) return 'expired';
    // Check expiry before consumed so an expired-and-consumed code reports expired
    // (consistent with: if the code is past TTL, it can't be used regardless)
    if (entry.expires_ts <= Date.now()) {
      _pairingCodes.delete(code); // lazy cleanup
      return 'expired';
    }
    if (entry.consumed) return 'consumed';
    return 'pending';
  }

  /**
   * Consume a pairing code, create a device, and return tokens.
   *
   * @param {string} code
   * @param {{ name?: string, user_agent?: string }} opts
   * @returns {{ device, access_token, refresh_token, expires_in }
   *          |{ error: 'CodeInvalid'|'CodeExpired' }}
   */
  function consumePairingCode(code, { name = 'Unknown Device', user_agent = '' } = {}) {
    const entry = _pairingCodes.get(code);
    if (!entry) {
      // Could be a genuinely unknown code or one already swept.
      // Treat as invalid (no oracle about whether it ever existed).
      return { error: 'CodeInvalid' };
    }
    // Check expiry before the consumed flag so expiry wins
    if (entry.expires_ts <= Date.now()) {
      _pairingCodes.delete(code);
      return { error: 'CodeExpired' };
    }
    if (entry.consumed) return { error: 'CodeInvalid' };

    // Mark consumed before any async/persist so a race can't double-consume
    entry.consumed = true;

    const state = _readState();
    _ensureSecret(state);

    // Build device record
    const device = {
      id: 'dev_' + randomBytes(8).toString('hex'),
      name: String(name || 'Unknown Device'),
      user_agent: String(user_agent || '').slice(0, 512),
      paired_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      refresh_hash: null,
      refresh_history: [],
      revoked: false,
    };

    // Refresh token: <device_id>.<base64url(32 random bytes)>
    const randomPart = randomBytes(32);
    const randomB64 = toBase64url(randomPart);
    device.refresh_hash = sha256hex(randomPart);

    state.devices.push(device);
    _persist(state);
    _audit('pair', device.id);

    const access_token = signAccessToken(device);
    const ttl = parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10);

    return {
      device,
      access_token,
      refresh_token: `${device.id}.${randomB64}`,
      expires_in: ttl,
    };
  }

  // -------------------------------------------------------------------------
  // Refresh token rotation
  // -------------------------------------------------------------------------

  /**
   * Rotate a refresh token, issuing new access + refresh tokens.
   *
   * Format: "<device_id>.<base64url(32 random bytes)>"
   * Only sha256(random part) is stored server-side.
   *
   * Reuse detection: if the presented hash matches refresh_history,
   * the device is immediately revoked and { error: 'TokenInvalid' } returned.
   *
   * @param {string} refreshToken
   * @returns {{ access_token, refresh_token, expires_in }
   *          |{ error: 'TokenInvalid' }}
   */
  function refresh(refreshToken) {
    if (typeof refreshToken !== 'string') return { error: 'TokenInvalid' };

    const dotIdx = refreshToken.indexOf('.');
    if (dotIdx < 0) return { error: 'TokenInvalid' };

    const deviceId = refreshToken.slice(0, dotIdx);
    const randomB64 = refreshToken.slice(dotIdx + 1);

    let randomBuf;
    try {
      randomBuf = fromBase64url(randomB64);
    } catch {
      return { error: 'TokenInvalid' };
    }
    const presentedHash = sha256hex(randomBuf);

    const state = _readState();
    _ensureSecret(state);

    const device = state.devices.find((d) => d.id === deviceId);
    if (!device) return { error: 'TokenInvalid' };
    if (device.revoked) return { error: 'TokenInvalid' };

    // Check history first — reuse detection
    const inHistory = (device.refresh_history || []).some((h) => h.hash === presentedHash);
    if (inHistory) {
      device.revoked = true;
      _persist(state);
      _audit('reuse-revoke', device.id);
      return { error: 'TokenInvalid' };
    }

    // Check current hash
    if (device.refresh_hash !== presentedHash) {
      return { error: 'TokenInvalid' };
    }

    // Rotate: retire current into history (capped at REFRESH_HISTORY_MAX, newest first)
    const retiredEntry = { hash: device.refresh_hash, retired_at: new Date().toISOString() };
    device.refresh_history = [retiredEntry, ...(device.refresh_history || [])].slice(
      0,
      REFRESH_HISTORY_MAX,
    );

    // Issue new refresh token
    const newRandom = randomBytes(32);
    const newRandomB64 = toBase64url(newRandom);
    device.refresh_hash = sha256hex(newRandom);
    device.last_seen = new Date().toISOString();

    // Single atomic write for rotation + history
    _persist(state);
    _audit('refresh', device.id);

    const access_token = signAccessToken(device);
    const ttl = parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10);

    return {
      access_token,
      refresh_token: `${device.id}.${newRandomB64}`,
      expires_in: ttl,
    };
  }

  // -------------------------------------------------------------------------
  // Device management
  // -------------------------------------------------------------------------

  /**
   * List all devices without internal hash fields.
   *
   * @returns {object[]}
   */
  function listDevices() {
    const state = _readState();
    return (state.devices || []).map(
      // eslint-disable-next-line no-unused-vars
      ({ refresh_hash, refresh_history, ...rest }) => rest,
    );
  }

  /**
   * Revoke a device by id (sets revoked: true, persists, audits).
   *
   * @param {string} id
   * @returns {boolean}  true if found
   */
  function revokeDevice(id) {
    const state = _readState();
    const device = state.devices.find((d) => d.id === id);
    if (!device) return false;
    device.revoked = true;
    _persist(state);
    _audit('revoke', id);
    return true;
  }

  /**
   * Rotate the JWT signing secret.
   * All outstanding JWTs become invalid immediately.
   * Device records and refresh tokens are unchanged.
   */
  function rotateSecret() {
    const state = _readState();
    state.secret = randomBytes(32).toString('hex');
    _persist(state);
    _audit('rotate-secret');
  }

  /**
   * Update last_seen for a device, throttled to once per 60s.
   *
   * @param {string} id
   */
  function touchDevice(id) {
    const now = Date.now();
    const last = _lastTouch.get(id) || 0;
    if (now - last < TOUCH_THROTTLE_MS) return;
    _lastTouch.set(id, now);

    const state = _readState();
    const device = state.devices.find((d) => d.id === id);
    if (!device) return;
    device.last_seen = new Date().toISOString();
    _persist(state);
  }

  return {
    signAccessToken,
    verifyAccessToken,
    createPairingCode,
    getPairingCodeStatus,
    consumePairingCode,
    refresh,
    listDevices,
    revokeDevice,
    rotateSecret,
    touchDevice,
  };
}
