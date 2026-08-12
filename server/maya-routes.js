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
  teardownIdentity as defaultTeardownIdentity,
  saveIdentity as defaultSaveIdentity,
  clearIdentity as defaultClearIdentity,
  fetchVerifiedWorkspace as defaultFetchVerifiedWorkspace,
  validateWorkspaceIsolation,
  workspaceClaimOf,
  MayaIdentityError,
  MayaWorkspaceCollisionError,
} from '../lib/maya-identity.js';
import { ideaboxContext } from '../lib/fluid/ideabox-ops.js';
import { composeColleagueContext } from '../lib/colleague/context.js';
import { writebackReply } from '../lib/colleague/writeback.js';

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
// Origin note: the colleague CREATES no records (scope fence), so provenance
// origin never fires on these paths — write-back attribution rides
// `author:'maya'` plus the embedded msg marker. `ui:ideabox` is the cockpit
// door these contexts genuinely come through; a colleague-specific origin
// joins the contract enum only when the panel gains a record-creating op.
async function defaultComposeContext(root, { focusId }) {
  const ctx = await ideaboxContext(root, { origin: 'ui:ideabox' });
  return composeColleagueContext(ctx, { focusId });
}

/** The real write-back (S4): reconcile-then-append through the shared ops
 *  module. Returns an OUTCOME, never throws (lib/colleague/writeback.js). */
async function defaultPerformWriteback(root, args) {
  const ctx = await ideaboxContext(root, { origin: 'ui:ideabox' });
  return writebackReply(ctx, args);
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
  teardownIdentity = defaultTeardownIdentity,
  saveIdentity = defaultSaveIdentity,
  clearIdentity = defaultClearIdentity,
  fetchVerifiedWorkspace = defaultFetchVerifiedWorkspace,
  composeContext = defaultComposeContext,
  performWriteback = defaultPerformWriteback,
} = {}) {
  /**
   * Resolve the per-request project scope. Null ONLY when the feature is not
   * installed (no `maya` block at all) — a block whose `baseUrl` is missing or
   * malformed is `misconfigured: true`, a FUNNEL, not a hidden button: the
   * presence of the block is the feature switch, and hiding a broken config
   * would violate funnel-not-hide (Codex r1 P2).
   */
  function scopeOf(req) {
    const root = req.workspace?.root;
    if (!root) return null;
    let cfg;
    try { cfg = getMayaConfig(root); } catch { cfg = null; }
    if (!cfg) return null;
    if (typeof cfg.baseUrl !== 'string' || !cfg.baseUrl) {
      return { root, cfg, mode: cfg.auth?.mode ?? 'provision', misconfigured: true };
    }
    return { root, cfg, mode: cfg.auth?.mode ?? 'provision', misconfigured: false };
  }

  /** Shared pre-flight for both transports. Nothing upstream-facing starts
   *  until every funnel, isolation check, and context build has passed. */
  async function prepareMessage(req) {
    const scope = scopeOf(req);
    if (!scope) return { errorBody: { ok: false, error: { kind: 'not-installed' } } };
    if (scope.misconfigured) {
      return {
        errorBody: {
          ok: false,
          error: { kind: 'misconfigured', message: 'the maya block has no baseUrl' },
        },
      };
    }
    const { root, cfg, mode } = scope;

    const text = String(req.body?.text ?? '').trim();
    if (!text) {
      return {
        errorBody: { ok: false, error: { kind: 'invalid', message: 'text is required' } },
      };
    }
    const focusId = req.body?.focusId ? String(req.body.focusId) : null;

    try {
      if (!hasSmartmemoryFluidProvider(root)) {
        return { errorBody: { ok: false, error: { kind: 'connect-smartmemory' } } };
      }

      // Identity BEFORE any upstream traffic: a stored fluid-workspace token
      // must be refused before provisioning side effects or a chat turn.
      let stored = loadIdentity(root);
      // A LEGACY static identity (stored before paste-time verification
      // existed) carries no workspace claim, which would make the isolation
      // check vacuous — verify-and-migrate it on first use, failing closed
      // into the auth funnel when it cannot be verified (Codex r2 P1).
      if (stored?.mode === 'static' && !workspaceClaimOf(stored)) {
        const team = await fetchVerifiedWorkspace({
          smBaseUrl: getSmartmemoryConfig(root)?.baseUrl, token: stored.access_token,
        });
        const candidate = { ...stored, team_id: team };
        // Validate BEFORE persisting: writing a colliding claim first would
        // pin the refusal to a stale verification — a colliding token is
        // refused each turn against a FRESH upstream answer instead.
        validateWorkspaceIsolation(candidate, getFluidWorkspaceId(root));
        saveIdentity(root, candidate);
        stored = candidate;
      }
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
        return {
          errorBody: {
            ok: false,
            error: { kind: 'context', message: `findings composition failed: ${shortReason(e)}` },
          },
        };
      }

      const client = createClient({
        baseUrl: cfg.baseUrl,
        getToken: () => loadIdentity(root)?.access_token ?? identity.access_token,
      });
      return {
        root,
        text,
        focusId,
        context,
        client,
        writebackEnabled: !!(focusId && req.body?.writeback !== false),
      };
    } catch (err) {
      return { errorBody: { ok: false, error: errorEnvelope(err) } };
    }
  }

  async function completeWriteback({ root, focusId, reply, enabled }) {
    if (!enabled) return null;
    try {
      return await performWriteback(root, {
        focusId, messageId: reply.message_id, text: reply.response,
      });
    } catch (e) {
      return { outcome: 'failed', focusId, reason: shortReason(e) };
    }
  }

  app.get('/api/maya/status', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.json({ enabled: false });
      const { root, cfg, mode } = scope;

      if (scope.misconfigured) {
        return res.json({
          enabled: true, state: 'misconfigured',
          error: 'the maya block in .compose/compose.json has no baseUrl',
        });
      }

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

      // Static mode with no pasted token cannot chat — reporting 'ready' would
      // promise a conversation the first turn immediately refuses (Codex r1
      // P2). The auth funnel (paste action) is the honest state.
      if (mode === 'static' && !identity) {
        return res.json({
          enabled: true, state: 'auth',
          auth: { mode, identity: false },
          error: 'static token mode with no token stored — paste one',
        });
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
    const prepared = await prepareMessage(req);
    if (prepared.errorBody) return res.json(prepared.errorBody);
    const { root, text, focusId, context, client, writebackEnabled } = prepared;

    if (req.query?.stream !== '1') {
      try {
        const reply = await client.chat({ message: text, channelContext: context.blocks });

        // Write-back (S4): the chat result is AUTHORITATIVE — her reply renders
        // whatever happens here, and a write-back failure is an outcome field,
        // never a failed turn (resending the chat would double-charge her
        // session with the same turn). Toggleable per request, default on.
        const writeback = await completeWriteback({
          root, focusId, reply, enabled: writebackEnabled,
        });

        return res.json({
          ok: true,
          reply: reply.response,
          message_id: reply.message_id,
          memory_available: reply.memory_available ?? null,
          writeback,
          context: {
            sent: context.blocks.map((b) => b.author),
            omissions: context.omissions,
            // The composed blocks themselves — the panel's findings accordion
            // renders these (design §4); authors carry the provenance labels.
            blocks: context.blocks,
          },
        });
      } catch (err) {
        return res.json({ ok: false, error: errorEnvelope(err) });
      }
    }

    // Downstream cancellation is deliberately NOT connected to the upstream
    // controller. Maya's final and the durable write-back still complete.
    let closed = false;
    let upstreamOpened = false;
    res.on('close', () => { closed = true; });
    const writable = () => !closed && !res.writableEnded && !res.destroyed;
    const openStream = () => {
      upstreamOpened = true;
      if (!writable() || res.headersSent) return;
      try {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        // Upstream Maya sends this too — without it the documented nginx
        // reverse-proxy deployment buffers the SSE body until res.end(),
        // collapsing S5 back into a one-shot response (Codex r1 P2).
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      } catch {
        closed = true;
      }
    };
    const writeEvent = (event, payload) => {
      if (!writable()) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        closed = true;
      }
    };
    const endStream = () => {
      if (!writable()) return;
      try { res.end(); } catch { closed = true; }
    };

    try {
      const reply = await client.chatStream({
        message: text,
        channelContext: context.blocks,
        onToken: (token) => {
          openStream();
          writeEvent('token', { text: token });
        },
      });
      openStream();
      writeEvent('final', {
        ok: true,
        reply: reply.response,
        message_id: reply.message_id,
        memory_available: reply.memory_available ?? null,
        context: {
          sent: context.blocks.map((b) => b.author),
          omissions: context.omissions,
          blocks: context.blocks,
        },
      });

      const writeback = await completeWriteback({
        root, focusId, reply, enabled: writebackEnabled,
      });
      if (writebackEnabled) writeEvent('writeback', writeback);
      return endStream();
    } catch (err) {
      if (upstreamOpened || err?.streamStarted) {
        openStream();
        writeEvent('error', errorEnvelope(err));
        return endStream();
      }
      return res.json({ ok: false, error: errorEnvelope(err) });
    }
  });

  /**
   * The auth funnel's two EXPLICIT recovery actions (design §2). Both are
   * continuity-costing, so neither ever happens implicitly — this endpoint
   * only exists for the user pressing the button.
   */
  app.post('/api/maya/identity', async (req, res) => {
    const scope = scopeOf(req);
    if (!scope) return res.json({ ok: false, error: { kind: 'not-installed' } });
    const { root } = scope;
    const action = req.body?.action;

    const { mode } = scope;

    try {
      if (action === 'reprovision') {
        // Provision-mode only: in static mode clearing the store just re-enters
        // the auth funnel (the next turn refuses to provision), so offering it
        // would be a dead-end action (Codex r1 P2).
        if (mode === 'static') {
          return res.json({
            ok: false,
            error: { kind: 'invalid', message: 're-provision applies to provision mode — paste a token instead' },
          });
        }
        // Best-effort upstream teardown; the local clear is the real action —
        // the next turn lazily provisions a fresh identity (fresh thread).
        try {
          await teardownIdentity(root, { smBaseUrl: getSmartmemoryConfig(root)?.baseUrl });
        } catch {
          clearIdentity(root);
        }
        return res.json({ ok: true });
      }

      if (action === 'static') {
        const token = String(req.body?.token ?? '').trim();
        if (!token) {
          return res.json({ ok: false, error: { kind: 'invalid', message: 'token is required' } });
        }
        // Cheap offline pre-check: a JWT that self-declares the fluid
        // workspace is refused without a network round-trip.
        validateWorkspaceIsolation({ mode: 'static', access_token: token }, getFluidWorkspaceId(root));
        // Authoritative check — FAILS CLOSED. Real tokens carry no workspace
        // claims in the JWT (VERIFY-1), so the pre-check alone is vacuous; the
        // verified workspace comes from the service's own user record, and a
        // token that cannot be verified is not stored (Codex r1 P1).
        const verifiedTeam = await fetchVerifiedWorkspace({
          smBaseUrl: getSmartmemoryConfig(root)?.baseUrl, token,
        });
        const candidate = { mode: 'static', access_token: token, team_id: verifiedTeam };
        validateWorkspaceIsolation(candidate, getFluidWorkspaceId(root));
        saveIdentity(root, candidate);
        return res.json({ ok: true });
      }

      return res.json({ ok: false, error: { kind: 'invalid', message: `unknown action: ${action}` } });
    } catch (err) {
      return res.json({ ok: false, error: errorEnvelope(err) });
    }
  });

  /**
   * Retry a failed write-back — APPEND-ONLY, never the chat turn. Runs the
   * same reconcile-then-append as the message path: if the original append
   * actually landed (a 'failed' outcome does not prove it didn't), the
   * `message_id` marker dedups this into a no-op.
   */
  app.post('/api/maya/writeback-retry', async (req, res) => {
    const scope = scopeOf(req);
    if (!scope) return res.json({ ok: false, error: { kind: 'not-installed' } });

    const focusId = String(req.body?.focusId ?? '').trim();
    const messageId = String(req.body?.message_id ?? '').trim();
    const text = String(req.body?.text ?? '');
    if (!focusId || !messageId || !text.trim()) {
      return res.json({
        ok: false,
        error: { kind: 'invalid', message: 'focusId, message_id and text are required' },
      });
    }

    try {
      const writeback = await performWriteback(scope.root, { focusId, messageId, text });
      return res.json({ ok: true, writeback });
    } catch (e) {
      return res.json({ ok: true, writeback: { outcome: 'failed', focusId, reason: shortReason(e) } });
    }
  });
}
