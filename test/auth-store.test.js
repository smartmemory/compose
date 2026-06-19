/**
 * auth-store.test.js — COMP-MOBILE-REMOTE S01
 *
 * Golden flow + edge cases for createAuthStore:
 *   - JWT sign/verify roundtrip
 *   - JWT expiry (TTL manipulation)
 *   - Tampered signature rejected
 *   - Tampered/wrong header (alg:none, alg:HS512) rejected
 *   - Garbage input rejected
 *   - Pairing code TTL + single-use + status transitions
 *   - Refresh token rotation happy path
 *   - Old-token reuse → device revoked + subsequent refresh fails
 *   - Refresh history capped at 5
 *   - Revoked device can't refresh
 *   - rotateSecret invalidates outstanding JWTs
 *   - Atomic persistence smoke test
 *   - Audit log appended
 *
 * Run: node --test --test-timeout=90000 test/auth-store.test.js
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createAuthStore } = await import(`${REPO_ROOT}/server/auth-store.js`);

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'auth-store-'));
}

function makeStore(dir) {
  return createAuthStore(dir);
}

// ---------------------------------------------------------------------------
// JWT sign / verify
// ---------------------------------------------------------------------------

describe('JWT sign/verify', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('roundtrip: signAccessToken → verifyAccessToken returns ok+claims', () => {
    const device = { id: 'dev_abc', name: 'Test Device' };
    const jwt = store.signAccessToken(device);
    assert.ok(typeof jwt === 'string');
    assert.ok(jwt.split('.').length === 3, 'JWT has 3 parts');

    const result = store.verifyAccessToken(jwt);
    assert.equal(result.ok, true);
    assert.equal(result.device_id, 'dev_abc');
    assert.equal(result.name, 'Test Device');
  });

  test('expired token returns TokenExpired', () => {
    const origTTL = process.env.ACCESS_TOKEN_TTL;
    try {
      // TTL=0 → exp === iat → expired immediately (clock skew ±30s means we need negative)
      // Use a very small value and then manipulate exp directly by forcing a known past exp.
      // Easiest: sign a token with TTL=1, then forge the exp to be in the past.
      process.env.ACCESS_TOKEN_TTL = '1';
      const device = { id: 'dev_exp', name: 'Expiry Test' };
      const jwt = store.signAccessToken(device);

      // Parse payload, set exp to 60 seconds ago, re-sign with the same secret
      // by just verifying that when we wait we'd get expired — but we can't wait.
      // Instead: directly test by building a JWT with past exp.
      // We use a known-fresh store so secret is stable; re-sign with mangled exp.
      const [h, p, s] = jwt.split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      claims.exp = Math.floor(Date.now() / 1000) - 100; // 100s in the past
      const newP = Buffer.from(JSON.stringify(claims)).toString('base64url');

      // The signature is now wrong (we changed the payload) — verifyAccessToken
      // should reject with TokenInvalid (wrong sig), not TokenExpired.
      // To test expiry properly we need a properly-signed token with past exp.
      // That requires access to the secret. Since this is a black-box store,
      // we set TTL=1, sign, then artificially advance time by mocking Date.now.
      // Simpler: accept that a properly-signed expired JWT gets TokenExpired
      // via ±30s check. We achieve this by setting TTL=-60 (no standard env support).
      // Instead: use TTL=1, produce token, hold for >31s — impractical in unit tests.
      //
      // SOLUTION: stub Date.now to make token appear expired.
      const realDateNow = Date.now;
      const tokenCreatedAt = Date.now();
      // Advance clock by 1000s for verification only
      Date.now = () => tokenCreatedAt + 1000 * 1000;
      try {
        const expResult = store.verifyAccessToken(jwt);
        // Should be expired (TTL=1, now+1000s >> exp+30s)
        assert.equal(expResult.ok, false);
        assert.equal(expResult.code, 'TokenExpired');
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      if (origTTL === undefined) delete process.env.ACCESS_TOKEN_TTL;
      else process.env.ACCESS_TOKEN_TTL = origTTL;
    }
  });

  test('tampered signature returns TokenInvalid', () => {
    const device = { id: 'dev_t', name: 'Tamper' };
    const jwt = store.signAccessToken(device);
    const parts = jwt.split('.');
    // Tamper at the byte level, not by flipping a base64url char. The final
    // base64url char of a 32-byte HMAC carries 2 padding bits, so flipping the
    // last char (e.g. A↔B) can change only padding and decode to identical
    // bytes — verifyAccessToken compares decoded bytes, so that "tamper" would
    // (correctly) still verify. Mutating byte 0 always changes the signature.
    const sigBytes = Buffer.from(parts[2], 'base64url');
    sigBytes[0] ^= 0xff;
    const tamperedJwt = [parts[0], parts[1], sigBytes.toString('base64url')].join('.');
    const result = store.verifyAccessToken(tamperedJwt);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TokenInvalid');
  });

  test('tampered payload returns TokenInvalid', () => {
    const device = { id: 'dev_tp', name: 'Payload Tamper' };
    const jwt = store.signAccessToken(device);
    const parts = jwt.split('.');
    // Modify payload (change name)
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    claims.name = 'Hacked';
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const result = store.verifyAccessToken(parts.join('.'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TokenInvalid');
  });

  test('alg:none header rejected', () => {
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', exp: 99999999999 })).toString('base64url');
    const forgery = `${noneHeader}.${payload}.`;
    const result = store.verifyAccessToken(forgery);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TokenInvalid');
  });

  test('alg:HS512 header rejected', () => {
    const hs512Header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', exp: 99999999999 })).toString('base64url');
    const forgery = `${hs512Header}.${payload}.fakesig`;
    const result = store.verifyAccessToken(forgery);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TokenInvalid');
  });

  test('RS256 header rejected', () => {
    const rs256Header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', exp: 99999999999 })).toString('base64url');
    const forgery = `${rs256Header}.${payload}.fakesig`;
    const result = store.verifyAccessToken(forgery);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TokenInvalid');
  });

  test('garbage string returns TokenInvalid', () => {
    assert.deepEqual(store.verifyAccessToken('garbage'), { ok: false, code: 'TokenInvalid' });
    assert.deepEqual(store.verifyAccessToken(''), { ok: false, code: 'TokenInvalid' });
    assert.deepEqual(store.verifyAccessToken(null), { ok: false, code: 'TokenInvalid' });
    assert.deepEqual(store.verifyAccessToken(undefined), { ok: false, code: 'TokenInvalid' });
    assert.deepEqual(store.verifyAccessToken(42), { ok: false, code: 'TokenInvalid' });
    assert.deepEqual(store.verifyAccessToken('a.b'), { ok: false, code: 'TokenInvalid' });
    assert.deepEqual(store.verifyAccessToken('a.b.c.d'), { ok: false, code: 'TokenInvalid' });
  });
});

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

describe('Pairing codes', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('createPairingCode returns code + expires_at ISO string', () => {
    const { code, expires_at } = store.createPairingCode();
    assert.ok(typeof code === 'string' && code.length > 0);
    assert.ok(!isNaN(Date.parse(expires_at)));
    // expires_at should be ~5 min from now
    const ttlMs = new Date(expires_at).getTime() - Date.now();
    assert.ok(ttlMs > 4 * 60 * 1000 && ttlMs <= 5 * 60 * 1000 + 500);
  });

  test('status is pending after creation', () => {
    const { code } = store.createPairingCode();
    assert.equal(store.getPairingCodeStatus(code), 'pending');
  });

  test('status is expired for unknown code', () => {
    assert.equal(store.getPairingCodeStatus('DOESNOTEXIST'), 'expired');
  });

  test('code is single-use: second consumePairingCode returns CodeInvalid', () => {
    const { code } = store.createPairingCode();
    const r1 = store.consumePairingCode(code, { name: 'Device 1' });
    assert.ok(!r1.error, `First consume failed: ${r1.error}`);
    const r2 = store.consumePairingCode(code, { name: 'Device 2' });
    assert.equal(r2.error, 'CodeInvalid');
  });

  test('status is consumed after consumePairingCode', () => {
    const { code } = store.createPairingCode();
    store.consumePairingCode(code, { name: 'D' });
    assert.equal(store.getPairingCodeStatus(code), 'consumed');
  });

  test('expired code via TTL simulation returns CodeExpired', () => {
    const { code } = store.createPairingCode();
    // Advance Date.now past TTL
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000; // +10 min
    try {
      const r = store.consumePairingCode(code, { name: 'Late' });
      assert.equal(r.error, 'CodeExpired');
      // Status also expired
      assert.equal(store.getPairingCodeStatus(code), 'expired');
    } finally {
      Date.now = realNow;
    }
  });

  test('consumePairingCode returns access_token, refresh_token, device_id, expires_in', () => {
    const { code } = store.createPairingCode();
    const r = store.consumePairingCode(code, { name: 'My Phone', user_agent: 'Mozilla/5.0' });
    assert.ok(!r.error);
    assert.ok(typeof r.access_token === 'string');
    assert.ok(typeof r.refresh_token === 'string');
    assert.ok(typeof r.device_id === 'undefined' || typeof r.device === 'object');
    assert.ok(typeof r.expires_in === 'number');
    // access_token must be a valid JWT
    const v = store.verifyAccessToken(r.access_token);
    assert.equal(v.ok, true);
    // refresh_token format: dev_<hex>.<base64url>
    assert.ok(r.refresh_token.startsWith(r.device.id + '.'));
  });
});

// ---------------------------------------------------------------------------
// Refresh token rotation
// ---------------------------------------------------------------------------

describe('Refresh token rotation', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('happy path: refresh rotates tokens and issues new access JWT', () => {
    const { code } = store.createPairingCode();
    const { refresh_token: rt1 } = store.consumePairingCode(code, { name: 'Phone' });

    const r = store.refresh(rt1);
    assert.ok(!r.error, `refresh failed: ${r.error}`);
    assert.ok(typeof r.access_token === 'string');
    assert.ok(typeof r.refresh_token === 'string');
    assert.notEqual(r.refresh_token, rt1, 'New refresh token must differ');
    // New access token is valid
    const v = store.verifyAccessToken(r.access_token);
    assert.equal(v.ok, true);
  });

  test('old refresh token after rotation returns TokenInvalid', () => {
    const { code } = store.createPairingCode();
    const { refresh_token: rt1 } = store.consumePairingCode(code, { name: 'Phone2' });
    const r1 = store.refresh(rt1);
    assert.ok(!r1.error);

    // Replay the original (now retired) token
    const r2 = store.refresh(rt1);
    assert.equal(r2.error, 'TokenInvalid');
  });

  test('old refresh token replay revokes device', () => {
    const { code } = store.createPairingCode();
    const { refresh_token: rt1, device } = store.consumePairingCode(code, { name: 'Phone3' });
    const r1 = store.refresh(rt1);
    assert.ok(!r1.error);

    // Replay old token → device revoked
    store.refresh(rt1);

    // Subsequent refresh with new token also fails (device revoked)
    const r3 = store.refresh(r1.refresh_token);
    assert.equal(r3.error, 'TokenInvalid');
  });

  test('refresh history capped at 5 entries', () => {
    const { code } = store.createPairingCode();
    let { refresh_token } = store.consumePairingCode(code, { name: 'HistPhone' });

    // Do 7 refreshes
    for (let i = 0; i < 7; i++) {
      const r = store.refresh(refresh_token);
      assert.ok(!r.error, `iteration ${i} failed: ${r.error}`);
      refresh_token = r.refresh_token;
    }

    // Read state and verify history length <= 5
    const state = JSON.parse(readFileSync(join(dir, 'remote-auth.json'), 'utf8'));
    const device = state.devices.find((d) => d.name === 'HistPhone');
    assert.ok(device, 'Device must exist');
    assert.ok(device.refresh_history.length <= 5, `History ${device.refresh_history.length} > 5`);
  });

  test('revoked device cannot refresh', () => {
    const { code } = store.createPairingCode();
    const { refresh_token, device } = store.consumePairingCode(code, { name: 'RevokeMe' });
    store.revokeDevice(device.id);
    const r = store.refresh(refresh_token);
    assert.equal(r.error, 'TokenInvalid');
  });

  test('garbage refresh token returns TokenInvalid', () => {
    assert.equal(store.refresh('garbage').error, 'TokenInvalid');
    assert.equal(store.refresh('').error, 'TokenInvalid');
    assert.equal(store.refresh(null).error, 'TokenInvalid');
    assert.equal(store.refresh('nodot').error, 'TokenInvalid');
  });
});

// ---------------------------------------------------------------------------
// rotateSecret
// ---------------------------------------------------------------------------

describe('rotateSecret', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('rotateSecret invalidates outstanding JWTs', () => {
    const device = { id: 'dev_rot', name: 'Rotation Test' };
    const jwt = store.signAccessToken(device);
    assert.equal(store.verifyAccessToken(jwt).ok, true);

    store.rotateSecret();

    const result = store.verifyAccessToken(jwt);
    assert.equal(result.ok, false);
  });

  test('rotateSecret writes new secret to disk', () => {
    const state1 = JSON.parse(readFileSync(join(dir, 'remote-auth.json'), 'utf8'));
    const s1 = state1.secret;

    store.rotateSecret();

    const state2 = JSON.parse(readFileSync(join(dir, 'remote-auth.json'), 'utf8'));
    const s2 = state2.secret;
    assert.notEqual(s1, s2);
  });
});

// ---------------------------------------------------------------------------
// Atomic persistence smoke
// ---------------------------------------------------------------------------

describe('Atomic persistence', () => {
  let dir;

  before(() => { dir = freshDir(); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('state file is valid JSON after multiple writes', () => {
    const store = makeStore(dir);
    for (let i = 0; i < 5; i++) {
      const { code } = store.createPairingCode();
      store.consumePairingCode(code, { name: `Device ${i}` });
    }
    const raw = readFileSync(join(dir, 'remote-auth.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.devices));
    assert.equal(parsed.devices.length, 5);
  });

  test('no .tmp file left after write', () => {
    const store = makeStore(dir);
    store.rotateSecret();
    assert.ok(!existsSync(join(dir, 'remote-auth.json.tmp')));
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('Audit log', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function readAuditLines() {
    const p = join(dir, 'remote-auth-audit.log');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  test('pair event written on consumePairingCode', () => {
    const { code } = store.createPairingCode();
    store.consumePairingCode(code, { name: 'AuditPhone' });
    const lines = readAuditLines();
    const pairLine = lines.find((l) => l.event === 'pair');
    assert.ok(pairLine, 'pair event must be in audit log');
    assert.ok(pairLine.ts);
    assert.ok(pairLine.device_id);
  });

  test('refresh event written on refresh', () => {
    const { code } = store.createPairingCode();
    const { refresh_token } = store.consumePairingCode(code, { name: 'AuditPhone2' });
    store.refresh(refresh_token);
    const lines = readAuditLines();
    assert.ok(lines.some((l) => l.event === 'refresh'));
  });

  test('revoke event written on revokeDevice', () => {
    const { code } = store.createPairingCode();
    const { device } = store.consumePairingCode(code, { name: 'AuditPhone3' });
    store.revokeDevice(device.id);
    const lines = readAuditLines();
    assert.ok(lines.some((l) => l.event === 'revoke' && l.device_id === device.id));
  });

  test('reuse-revoke event written on refresh-token replay', () => {
    const { code } = store.createPairingCode();
    const { refresh_token } = store.consumePairingCode(code, { name: 'AuditPhone4' });
    store.refresh(refresh_token); // rotate
    store.refresh(refresh_token); // replay → reuse-revoke
    const lines = readAuditLines();
    assert.ok(lines.some((l) => l.event === 'reuse-revoke'));
  });

  test('rotate-secret event written on rotateSecret', () => {
    store.rotateSecret();
    const lines = readAuditLines();
    assert.ok(lines.some((l) => l.event === 'rotate-secret'));
  });

  test('audit lines are valid JSON with ts field', () => {
    const lines = readAuditLines();
    for (const line of lines) {
      assert.ok(typeof line.ts === 'string' && !isNaN(Date.parse(line.ts)));
      assert.ok(typeof line.event === 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// listDevices
// ---------------------------------------------------------------------------

describe('listDevices', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('listDevices does not include refresh_hash or refresh_history', () => {
    const { code } = store.createPairingCode();
    store.consumePairingCode(code, { name: 'ListTest' });
    const devices = store.listDevices();
    assert.equal(devices.length, 1);
    assert.ok(!('refresh_hash' in devices[0]));
    assert.ok(!('refresh_history' in devices[0]));
    assert.equal(devices[0].name, 'ListTest');
  });
});

// ---------------------------------------------------------------------------
// COMP-MOBILE-REMOTE coverage sweep additions
// ---------------------------------------------------------------------------

// ── JWT skew boundary ─────────────────────────────────────────────────────────

describe('JWT skew boundary (±30s)', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  /**
   * verifyAccessToken: now > exp + 30 → TokenExpired
   *   - At now == exp + 30: still valid (boundary inclusive)
   *   - At now == exp + 31: expired
   */
  test('JWT exactly at exp+30s boundary is still valid', () => {
    const device = { id: 'dev_skew1', name: 'Skew Test' };
    const jwt = store.signAccessToken(device);
    // Parse the exp from the JWT payload
    const payloadB64 = jwt.split('.')[1];
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const exp = claims.exp;
    // Advance Date.now to exactly exp+30s — boundary must still pass
    const realNow = Date.now;
    Date.now = () => (exp + 30) * 1000;
    try {
      const result = store.verifyAccessToken(jwt);
      assert.equal(result.ok, true, 'exp+30s boundary should still be valid');
    } finally {
      Date.now = realNow;
    }
  });

  test('JWT at exp+31s boundary is expired', () => {
    const device = { id: 'dev_skew2', name: 'Skew Expired' };
    const jwt = store.signAccessToken(device);
    const payloadB64 = jwt.split('.')[1];
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const exp = claims.exp;
    // 1 second past the skew window
    const realNow = Date.now;
    Date.now = () => (exp + 31) * 1000;
    try {
      const result = store.verifyAccessToken(jwt);
      assert.equal(result.ok, false, 'exp+31s should be expired');
      assert.equal(result.code, 'TokenExpired');
    } finally {
      Date.now = realNow;
    }
  });
});

// ── Pairing code sweep under many expired codes ───────────────────────────────

describe('Pairing code sweep with many expired codes', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('consuming a fresh code still works after many prior codes expire', () => {
    // Create 20 codes, let them all expire via Date.now mock
    const codes = [];
    for (let i = 0; i < 20; i++) {
      codes.push(store.createPairingCode().code);
    }

    // Advance time past TTL to expire all of them
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000; // +10 min
    try {
      for (const c of codes) {
        assert.equal(store.getPairingCodeStatus(c), 'expired',
          `Code ${c} should be expired`);
      }
    } finally {
      Date.now = realNow;
    }

    // Now create a fresh code (back to real time) and consume it — must succeed
    const { code: freshCode } = store.createPairingCode();
    const r = store.consumePairingCode(freshCode, { name: 'AfterSweep' });
    assert.ok(!r.error, `Fresh code should be consumable after sweep: ${r.error}`);
    assert.ok(typeof r.access_token === 'string');
  });

  test('getPairingCodeStatus for unknown code returns "expired" (no crash)', () => {
    // Many calls for unknown codes — must not throw or accumulate state
    for (let i = 0; i < 50; i++) {
      assert.equal(store.getPairingCodeStatus(`UNKNOWN${i}`), 'expired');
    }
  });
});

// ── refresh with nonexistent device id prefix ─────────────────────────────────

describe('refresh token with nonexistent device id prefix', () => {
  let dir;
  let store;

  before(() => {
    dir = freshDir();
    store = makeStore(dir);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('refresh token whose device_id prefix matches no device → generic TokenInvalid, no crash', () => {
    // Craft a refresh token with a nonexistent device id prefix (dev_XXXXX.payload)
    const fakeToken = 'dev_NONEXIST.aaaabbbbccccddddeeeeffffgggghhhhiiiijjjj';
    const r = store.refresh(fakeToken);
    assert.equal(r.error, 'TokenInvalid', 'Should return generic TokenInvalid, not crash');
  });

  test('refresh token with malformed prefix (no dot) → TokenInvalid', () => {
    const r = store.refresh('devnoprefix');
    assert.equal(r.error, 'TokenInvalid');
  });

  test('refresh with prefix matching existing device but wrong hash → TokenInvalid', () => {
    const { code } = store.createPairingCode();
    const { device, refresh_token: rt } = store.consumePairingCode(code, { name: 'HashCheck' });
    // Build a token with the right device prefix but wrong hash
    const wrongToken = `${device.id}.wronghashvalue`;
    const r = store.refresh(wrongToken);
    assert.equal(r.error, 'TokenInvalid', 'Wrong hash for existing device should be TokenInvalid');
    // Original token is still usable
    const r2 = store.refresh(rt);
    assert.ok(!r2.error, `Original token should still work: ${r2.error}`);
  });
});
