/**
 * maya-identity.js — COMP-FOH FOH-6 S1
 *
 * The colleague identity store: `data/maya-identity.json` (covered by
 * `.gitignore`'s blanket `data/` entry). One identity per project; it OWNS
 * Maya's single standing conversation (session per JWT identity,
 * session_registry.py:486-527), so nothing here re-provisions implicitly —
 * minting a fresh identity destroys the thread AND the colleague-workspace
 * memory, and is only ever an explicit user action (design §2).
 *
 * Provisioning uses smart-memory-service's sanctioned test surface, the same
 * path the FOH-4/5/6 live-fires used:
 *   POST /test/provision-user {email} → {user_id, tenant_id, team_id, access_token}
 *     (409 on a repeated email — probed live 2026-08-11; there is no
 *     token-refresh path on the test surface yet, upstream ask filed with the
 *     channel_context issue)
 *   POST /memory/beta/nda/accept {"version":"v1"}   (Bearer-authenticated)
 *   DELETE /test/provision-user {email, user_id, tenant_id}
 */

import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Provisioning/NDA failure. `kind` mirrors the relay's funnel taxonomy. */
export class MayaIdentityError extends Error {
  constructor(message, kind = 'auth') {
    super(message);
    this.name = 'MayaIdentityError';
    this.kind = kind;
  }
}

/** The colleague token's workspace claim equals the fluid workspace —
 *  accepting it would silently enable the deferred deep-binding behaviour
 *  (Maya's turn-ingestion writing into the fluid workspace). */
export class MayaWorkspaceCollisionError extends Error {
  constructor(claim) {
    super(
      `maya: the colleague token's workspace claim (${claim}) IS the fluid workspace — `
      + 'refusing. Shallow binding requires a dedicated colleague workspace; '
      + 'provision a separate identity or paste a token scoped elsewhere.',
    );
    this.name = 'MayaWorkspaceCollisionError';
    this.claim = claim;
  }
}

function identityPath(projectRoot) {
  return join(projectRoot, 'data', 'maya-identity.json');
}

/** @returns {object|null} the stored identity, or null when none exists */
export function loadIdentity(projectRoot) {
  const path = identityPath(projectRoot);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    // Enforce owner-only permissions on files created before the 0600 write
    // path existed (Codex r1 P2). Best-effort — a read-only checkout must not
    // break loading.
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Owner-only (0600) and ATOMIC: the file holds a bearer credential, so it must
 * never be group/world-readable, and a crash mid-write must never truncate it
 * — a truncated file loads as null and the next turn would silently provision
 * a fresh identity, destroying the standing conversation (Codex r1 P2).
 */
export function saveIdentity(projectRoot, identity) {
  mkdirSync(join(projectRoot, 'data'), { recursive: true });
  const path = identityPath(projectRoot);
  const tmp = `${path}.tmp.${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function clearIdentity(projectRoot) {
  rmSync(identityPath(projectRoot), { force: true });
}

async function requestJson(url, { body, token, timeoutMs = 30000, fetchFn = fetch, method = 'POST' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* tolerated; shape-checked below */ }
    return { status: res.status, body: parsed };
  } catch (err) {
    throw new MayaIdentityError(`maya: ${method} ${url} failed: ${err?.message ?? 'unknown'}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mint a fresh colleague identity. A RANDOM email per call — the provision
 * surface refuses repeats (409), and a colleague identity is never shared
 * across projects (documented-unsupported, design §2).
 *
 * Does NOT save: the caller decides persistence (ensureIdentity does both).
 */
export async function provisionIdentity({ smBaseUrl, fetchFn = fetch }) {
  const email = `maya-colleague-${randomBytes(6).toString('hex')}@compose.invalid`;
  const res = await requestJson(`${smBaseUrl}/test/provision-user`, { body: { email }, fetchFn });
  if (res.status !== 200 || typeof res.body?.access_token !== 'string') {
    throw new MayaIdentityError(
      `maya: provisioning failed (HTTP ${res.status})`
      + (res.body?.detail ? ` — ${String(res.body.detail).slice(0, 200)}` : ''),
    );
  }
  const { user_id, tenant_id, team_id, access_token } = res.body;
  return {
    mode: 'provision', email, user_id, tenant_id, team_id, access_token,
    ndaAccepted: false, provisionedAt: new Date().toISOString(),
  };
}

/** The oldest NDA version this client knows; the server names a newer one. */
const NDA_VERSION_FLOOR = 'v1';

/** Accept the beta NDA for a provisioned identity (403 `nda_required` gates
 *  every memory route until this runs — FOH-4 ledger prereq 3). */
export async function acceptNda({ smBaseUrl, token, fetchFn = fetch }) {
  const attempt = (version) => requestJson(`${smBaseUrl}/memory/beta/nda/accept`, {
    body: { version }, token, fetchFn,
  });
  let res = await attempt(NDA_VERSION_FLOOR);
  // The NDA version is upstream's to bump, not ours to track: a 409
  // `version_mismatch` names the version currently in force, and accepting the
  // one the server names is the only answer that survives the next bump.
  // FOH-7 live-fire (2026-09-06) found v1 hardcoded after upstream moved to v2 —
  // every provisioned colleague identity failed its first turn.
  const named = res.status === 409 && res.body?.detail?.code === 'version_mismatch'
    ? res.body.detail.current_version : null;
  if (typeof named === 'string' && named && named !== NDA_VERSION_FLOOR) {
    res = await attempt(named);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new MayaIdentityError(`maya: NDA accept failed (HTTP ${res.status})`);
  }
}

/** Tear down a provisioned identity (explicit user action only). */
export async function teardownIdentity(projectRoot, { smBaseUrl, fetchFn = fetch }) {
  const identity = loadIdentity(projectRoot);
  if (!identity) return { removed: false };
  if (identity.mode === 'provision' && identity.email) {
    await requestJson(`${smBaseUrl}/test/provision-user`, {
      method: 'DELETE', fetchFn,
      body: { email: identity.email, user_id: identity.user_id, tenant_id: identity.tenant_id },
    });
  }
  clearIdentity(projectRoot);
  return { removed: true };
}

/**
 * The identity's workspace claim, or null when none is derivable. Provisioned
 * identities carry `team_id` from the provision response (VERIFY-1: the JWT
 * payload itself carries NO workspace claims — Maya resolves the workspace
 * server-side from the verified user record). Static tokens fall back to
 * decoding the JWT body for the claims Maya's `_extract_team_id` reads.
 */
export function workspaceClaimOf(identity) {
  if (!identity) return null;
  if (typeof identity.team_id === 'string' && identity.team_id) return identity.team_id;
  const token = identity.access_token;
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.workspace_id ?? payload.current_workspace_id
      ?? payload.default_team_id ?? payload.team_id ?? null;
  } catch {
    return null;
  }
}

/**
 * The shallow-binding invariant (design §2, VERIFY-3): refuse a colleague
 * token whose workspace claim equals the fluid workspace. An underivable claim
 * is ALLOWED here for STORED identities — provisioned identities always carry
 * `team_id`, and static identities have their claim resolved and stored at
 * paste time by `fetchVerifiedWorkspace` (which fails CLOSED — see below), so
 * an underivable claim on a stored identity means only that this project has
 * no fluid workspace to collide with. Cross-project token reuse remains
 * documented-unsupported, not detected.
 */
export function validateWorkspaceIsolation(identity, fluidWorkspaceId) {
  if (!fluidWorkspaceId) return;
  const claim = workspaceClaimOf(identity);
  if (claim && claim === fluidWorkspaceId) throw new MayaWorkspaceCollisionError(claim);
}

/**
 * Resolve a token's VERIFIED workspace from smart-memory-service itself
 * (`GET /auth/me` → `default_team_id` — the same user-record field Maya's
 * `_extract_team_id` falls back to). Exists because the JWT-decode fallback is
 * vacuous in practice: real tokens carry NO workspace claims (VERIFY-1), so a
 * pasted static token could silently defeat the isolation check (Codex r1 P1).
 *
 * FAILS CLOSED: an unreachable service, a rejected token, or a user record
 * without a resolvable team all throw — the paste flow refuses to store a
 * token whose workspace it cannot verify.
 */
export async function fetchVerifiedWorkspace({ smBaseUrl, token, fetchFn = fetch }) {
  if (!smBaseUrl) {
    throw new MayaIdentityError('maya: cannot verify the token — smartmemory baseUrl is not configured');
  }
  const res = await requestJson(`${smBaseUrl}/auth/me`, { method: 'GET', token, fetchFn });
  if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
    throw new MayaIdentityError(
      `maya: could not verify the token against SmartMemory (HTTP ${res.status}) — not storing it`,
    );
  }
  const team = res.body.default_team_id;
  if (typeof team !== 'string' || !team) {
    throw new MayaIdentityError(
      'maya: the token verified but resolves no workspace (no default_team_id) — '
      + 'refusing to store a token whose isolation cannot be checked',
    );
  }
  return team;
}

/**
 * Per-project serialization for ensureIdentity. Two concurrent first turns
 * that both observe "no identity" would otherwise provision two competing
 * users, overwrite each other's files, and fork the standing conversation
 * (Codex r1 P2). The server is a single process, so an in-process promise
 * chain is the whole fix: every caller re-loads at the head of its own turn
 * in the chain and sees the winner's identity.
 */
const _ensureChain = new Map(); // projectRoot -> tail Promise

async function ensureIdentityUnserialized(projectRoot, { smBaseUrl, mode, fetchFn = fetch }) {
  let identity = loadIdentity(projectRoot);
  if (!identity) {
    if (mode !== 'provision') {
      throw new MayaIdentityError('maya: no token configured — paste one in the panel', 'auth');
    }
    if (!smBaseUrl) {
      throw new MayaIdentityError('maya: provisioning needs the smartmemory baseUrl', 'auth');
    }
    identity = await provisionIdentity({ smBaseUrl, fetchFn });
    saveIdentity(projectRoot, identity);
  }
  // A saved-but-unaccepted NDA (crash between provision and accept) is retried
  // on the SAME identity rather than minting a new one.
  if (identity.mode === 'provision' && !identity.ndaAccepted) {
    await acceptNda({ smBaseUrl, token: identity.access_token, fetchFn });
    identity.ndaAccepted = true;
    saveIdentity(projectRoot, identity);
  }
  return identity;
}

/**
 * The relay's per-turn identity resolution: load, lazily provision on FIRST
 * use (provision mode only — static mode with no pasted token is an auth
 * funnel), and complete a pending NDA. Never called on a 401 — that funnel is
 * explicit-action-only. Serialized per project (see `_ensureChain`).
 */
export async function ensureIdentity(projectRoot, opts) {
  const tail = _ensureChain.get(projectRoot) ?? Promise.resolve();
  const run = tail
    .catch(() => {}) // a predecessor's failure must not poison the chain
    .then(() => ensureIdentityUnserialized(projectRoot, opts));
  _ensureChain.set(projectRoot, run);
  try {
    return await run;
  } finally {
    if (_ensureChain.get(projectRoot) === run) _ensureChain.delete(projectRoot);
  }
}
