/**
 * maya-routes.js — COMP-FOH FOH-6 S1: the colleague relay.
 *
 * Routes:
 *   GET  /api/maya/status  — degrade-never-fail funnel probe (always a shaped
 *     200, the smartmemory-routes.js model). The panel keys its state machine
 *     off this: not-installed → connect-smartmemory → offline →
 *     workspace-collision → ready.
 *   POST /api/maya/message — one colleague turn: compose findings context →
 *     relay to Maya's POST /api/chat with the server-held token → (S4)
 *     write-back → `{ok, reply, message_id, writeback, context}`. Turn
 *     failures are shaped `{ok:false, error:{kind}}` 200s so the panel can
 *     render the matching funnel; transport-level errors stay HTTP errors.
 *
 * AUTH POSTURE (design §1, Codex r1 must-fix): these routes stay BEHIND the
 * remote-mode auth gate — NEVER add them to the allowlist in server/index.js.
 * Allowlisted paths bypass authentication entirely (auth-middleware.js:196);
 * an allowlisted /api/maya/message would publish an unauthenticated proxy
 * wielding the server-held Maya credential.
 *
 * OPS NOTE: a Maya deployment used by this relay must keep
 * MAYA_PROACTIVE_CHECK_INTERVAL_S=0 (the default). Non-zero turns Maya into a
 * proactive WRITER against the workspace of the last-seen JWT
 * (maya routes.py:3886-3956) — not wanted from a relay identity.
 */

import {
  getMayaConfig as defaultGetMayaConfig,
  getFluidWorkspaceId as defaultGetFluidWorkspaceId,
  hasSmartmemoryFluidProvider as defaultHasSmartmemoryFluidProvider,
} from '../lib/maya-config.js';
import { getSmartmemoryConfig as defaultGetSmartmemoryConfig } from '../lib/smartmemory-config.js';
import { createMayaClient as defaultCreateClient, MayaAuthError, MayaHttpError } from '../lib/maya-client.js';
import {
  loadIdentity as defaultLoadIdentity,
  ensureIdentity as defaultEnsureIdentity,
  validateWorkspaceIsolation,
  MayaIdentityError,
  MayaWorkspaceCollisionError,
} from '../lib/maya-identity.js';
import { ideaboxContext } from '../lib/fluid/ideabox-ops.js';
import { composeColleagueContext } from '../lib/colleague/context.js';

/**
 * The provider's declared semantic subset today (smartmemory-provider.js
 * declares CHALLENGE/CONVICTION/CONTRADICTION; CALIBRATION is blocked upstream,
 * "no subject"). Rendered "visibly unavailable, not faked" per COLLEAGUE-ALL-IN.
 * S2's context builder still checks provider.has(CAP.X) per turn — this static
 * map only feeds the panel's capability strip.
 */
const CAPABILITIES = Object.freeze({
  challenge: true, conviction: true, contradiction: true, calibration: false,
});

/** The real per-turn composer (S2): an ideabox ops context over the project's
 *  fluid provider, then the priority-ordered findings blocks. A fresh context
 *  per turn, deliberately — the provider holds paths, not state (the
 *  ideabox-routes.js reasoning). */
async function defaultComposeContext(root, { focusId }) {
  const ctx = await ideaboxContext(root, { origin: 'ui:colleague' });
  return composeColleagueContext(ctx, { focusId });
}

function shortReason(e) {
  return e?.message?.slice(0, 300) || 'unknown error';
}

/** Map a turn failure to the panel's funnel taxonomy. */
function errorEnvelope(err) {
  if (err instanceof MayaWorkspaceCollisionError) {
    return { kind: 'workspace-collision', message: shortReason(err) };
  }
  if (err instanceof MayaAuthError) {
    return {
      kind: 'auth',
      message: shortReason(err),
      // Both actions are continuity-costing and therefore EXPLICIT — the
      // relay never takes either on its own (design §2).
      actions: ['re-provision — starts a fresh conversation', 'paste a new token'],
    };
  }
  if (err instanceof MayaIdentityError) {
    return { kind: err.kind ?? 'auth', message: shortReason(err) };
  }
  if (err instanceof MayaHttpError) {
    if (err.status === 0) return { kind: 'offline', message: shortReason(err) };
    return { kind: 'upstream', message: shortReason(err), status: err.status };
  }
  return { kind: 'upstream', message: shortReason(err) };
}

/**
 * @param {import('express').Express} app
 * @param {object} [deps] — every reader/client injectable for tests
 */
export function attachMayaRoutes(app, {
  getMayaConfig = defaultGetMayaConfig,
  getFluidWorkspaceId = defaultGetFluidWorkspaceId,
  hasSmartmemoryFluidProvider = defaultHasSmartmemoryFluidProvider,
  getSmartmemoryConfig = defaultGetSmartmemoryConfig,
  createClient = defaultCreateClient,
  loadIdentity = defaultLoadIdentity,
  ensureIdentity = defaultEnsureIdentity,
  composeContext = defaultComposeContext,
} = {}) {
  /** Resolve the per-request project scope, or null when not installed. */
  function scopeOf(req) {
    const root = req.workspace?.root;
    if (!root) return null;
    let cfg;
    try { cfg = getMayaConfig(root); } catch { cfg = null; }
    if (!cfg || typeof cfg.baseUrl !== 'string' || !cfg.baseUrl) return null;
    return { root, cfg, mode: cfg.auth?.mode ?? 'provision' };
  }

  app.get('/api/maya/status', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.json({ enabled: false });
      const { root, cfg, mode } = scope;

      if (!hasSmartmemoryFluidProvider(root)) {
        // COLLEAGUE-ALL-IN: no degraded plain-chat mode — the colleague
        // hard-requires the SmartMemory provider (service stack; lite lacks
        // the capability surface).
        return res.json({ enabled: true, state: 'connect-smartmemory' });
      }

      const identity = loadIdentity(root);
      const client = createClient({
        baseUrl: cfg.baseUrl,
        getToken: () => identity?.access_token ?? '',
      });
      const alive = await client.health();
      if (!alive.ok) {
        return res.json({
          enabled: true, state: 'offline', baseUrl: cfg.baseUrl,
          hint: 'start the Maya stack (dev.sh — port 9005), then reopen the panel',
        });
      }

      try {
        validateWorkspaceIsolation(identity, getFluidWorkspaceId(root));
      } catch (err) {
        return res.json({ enabled: true, state: 'workspace-collision', error: shortReason(err) });
      }

      return res.json({
        enabled: true,
        state: 'ready',
        auth: { mode, identity: !!identity },
        capabilities: CAPABILITIES,
      });
    } catch (e) {
      // Degrade-never-fail: an unexpected reader failure is still a shaped 200.
      return res.json({ enabled: false, error: shortReason(e) });
    }
  });

  app.post('/api/maya/message', async (req, res) => {
    const scope = scopeOf(req);
    if (!scope) return res.json({ ok: false, error: { kind: 'not-installed' } });
    const { root, cfg, mode } = scope;

    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.json({ ok: false, error: { kind: 'invalid', message: 'text is required' } });
    const focusId = req.body?.focusId ? String(req.body.focusId) : null;

    try {
      if (!hasSmartmemoryFluidProvider(root)) {
        return res.json({ ok: false, error: { kind: 'connect-smartmemory' } });
      }

      // Identity BEFORE any upstream traffic: a stored fluid-workspace token
      // must be refused before provisioning side effects or a chat turn.
      const stored = loadIdentity(root);
      validateWorkspaceIsolation(stored, getFluidWorkspaceId(root));
      const identity = stored ?? await ensureIdentity(root, {
        smBaseUrl: getSmartmemoryConfig(root)?.baseUrl, mode,
      });
      // A lazily-provisioned identity gets the same refusal before first use.
      if (!stored) validateWorkspaceIsolation(identity, getFluidWorkspaceId(root));
      // Complete a pending NDA on a stored identity (crash between provision
      // and accept) — same identity, never a fresh one.
      if (stored && stored.mode === 'provision' && !stored.ndaAccepted) {
        await ensureIdentity(root, { smBaseUrl: getSmartmemoryConfig(root)?.baseUrl, mode });
      }

      // Context composition is load-bearing: a failure here is a funnel, never
      // a silent fall-through to plain chat (COLLEAGUE-ALL-IN).
      let context;
      try {
        context = await composeContext(root, { focusId });
      } catch (e) {
        return res.json({
          ok: false,
          error: { kind: 'context', message: `findings composition failed: ${shortReason(e)}` },
        });
      }

      const client = createClient({
        baseUrl: cfg.baseUrl,
        getToken: () => loadIdentity(root)?.access_token ?? identity.access_token,
      });
      const reply = await client.chat({ message: text, channelContext: context.blocks });

      return res.json({
        ok: true,
        reply: reply.response,
        message_id: reply.message_id,
        memory_available: reply.memory_available ?? null,
        // S4 fills this with the ok|landed-unrendered|failed outcome.
        writeback: null,
        context: {
          sent: context.blocks.map((b) => b.author),
          omissions: context.omissions,
        },
      });
    } catch (err) {
      return res.json({ ok: false, error: errorEnvelope(err) });
    }
  });
}
