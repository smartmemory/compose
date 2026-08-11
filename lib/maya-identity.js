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

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
  try {
    const parsed = JSON.parse(readFileSync(identityPath(projectRoot), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveIdentity(projectRoot, identity) {
  mkdirSync(join(projectRoot, 'data'), { recursive: true });
  writeFileSync(identityPath(projectRoot), JSON.stringify(identity, null, 2) + '\n');
}

export function clearIdentity(projectRoot) {
  rmSync(identityPath(projectRoot), { force: true });
}

async function postJson(url, { body, token, timeoutMs = 30000, fetchFn = fetch, method = 'POST' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
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
  const res = await postJson(`${smBaseUrl}/test/provision-user`, { body: { email }, fetchFn });
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

/** Accept the beta NDA for a provisioned identity (403 `nda_required` gates
 *  every memory route until this runs — FOH-4 ledger prereq 3). */
export async function acceptNda({ smBaseUrl, token, fetchFn = fetch }) {
  const res = await postJson(`${smBaseUrl}/memory/beta/nda/accept`, {
    body: { version: 'v1' }, token, fetchFn,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new MayaIdentityError(`maya: NDA accept failed (HTTP ${res.status})`);
  }
}

/** Tear down a provisioned identity (explicit user action only). */
export async function teardownIdentity(projectRoot, { smBaseUrl, fetchFn = fetch }) {
  const identity = loadIdentity(projectRoot);
  if (!identity) return { removed: false };
  if (identity.mode === 'provision' && identity.email) {
    await postJson(`${smBaseUrl}/test/provision-user`, {
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
 * is ALLOWED — the check runs against this project's fluid workspace and
 * cannot see further; cross-project token reuse is documented-unsupported,
 * not detected.
 */
export function validateWorkspaceIsolation(identity, fluidWorkspaceId) {
  if (!fluidWorkspaceId) return;
  const claim = workspaceClaimOf(identity);
  if (claim && claim === fluidWorkspaceId) throw new MayaWorkspaceCollisionError(claim);
}

/**
 * The relay's per-turn identity resolution: load, lazily provision on FIRST
 * use (provision mode only — static mode with no pasted token is an auth
 * funnel), and complete a pending NDA. Never called on a 401 — that funnel is
 * explicit-action-only.
 */
export async function ensureIdentity(projectRoot, { smBaseUrl, mode, fetchFn = fetch }) {
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
