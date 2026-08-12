/**
 * Integration tests for server/maya-routes.js (FOH-6 S1) — real Express app on
 * an ephemeral port, real lib/maya-* modules, real config + identity files
 * under a mkdtemp project root, maya-stub + sm-stub as the upstreams. Only
 * `composeContext` is injected (its real implementation is S2).
 *
 * Covers, per design-foh-6.md:
 *   - /status funnel state machine (not-installed → connect-smartmemory →
 *     offline → workspace-collision → ready), degrade-never-fail
 *   - /message: lazy first-use provisioning (+ NDA), identity persistence and
 *     reuse, 401 → auth funnel with NO silent re-provision, offline funnel,
 *     workspace-collision refusal BEFORE any chat, context-loss funnel (never
 *     plain chat), static mode (pasted token, no provisioning)
 *   - auth posture: the maya routes are never on the remote-auth allowlist
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachMayaRoutes } = await import(`${ROOT}/server/maya-routes.js`);
const { loadIdentity, saveIdentity, validateWorkspaceIsolation, MayaWorkspaceCollisionError } =
  await import(`${ROOT}/lib/maya-identity.js`);
const { makeMayaServer, makeSmStub, servers } = await import(`${ROOT}/test/helpers/maya-stub.js`);

const FLUID_WS = 'team_fluid_ws';

function makeProjectRoot({ maya, smartmemory, fluid } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'foh6-'));
  mkdirSync(join(root, '.compose'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const cfg = { version: 2 };
  if (maya) cfg.maya = maya;
  if (smartmemory) cfg.smartmemory = smartmemory;
  if (fluid) cfg.fluid = fluid;
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify(cfg, null, 2));
  return root;
}

/** A fully-wired root: maya + smartmemory + fluid-on-smartmemory blocks. */
function wiredRoot({ mayaBase, smBase, mode = 'provision' }) {
  return makeProjectRoot({
    maya: { baseUrl: mayaBase, auth: { mode } },
    smartmemory: { baseUrl: smBase, apiKeyEnv: 'SM_FLUID_KEY', enabled: true },
    fluid: { provider: 'smartmemory', smartmemory: { workspaceId: FLUID_WS } },
  });
}

/** For tests targeting auth/transport concerns, not composition (the real
 *  builder has its own suite, test/colleague-context.test.js). */
const emptyContext = async () => ({ blocks: [], omissions: [] });

function startApp({ root, deps = {} }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (root) req.workspace = { root };
    next();
  });
  attachMayaRoutes(app, deps);
  return new Promise((res) => {
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      res({ httpServer, baseUrl: `http://127.0.0.1:${httpServer.address().port}` });
    });
  });
}

async function getStatus(baseUrl) {
  const r = await fetch(`${baseUrl}/api/maya/status`, { headers: { Connection: 'close' } });
  return { status: r.status, body: await r.json() };
}

async function postMessage(baseUrl, payload) {
  const r = await fetch(`${baseUrl}/api/maya/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

describe('maya routes', () => {
  const cleanups = [];
  after(() => {
    cleanups.forEach((fn) => fn());
    servers.forEach((s) => s.close());
  });
  function track(server) { cleanups.push(() => server.httpServer.close()); }

  // ── auth posture ─────────────────────────────────────────────────────────

  test('maya routes are NEVER on the remote-auth allowlist', () => {
    const src = readFileSync(join(ROOT, 'server', 'index.js'), 'utf-8');
    const allowlistMatch = src.match(/allowlist:\s*\[([^\]]*)\]/);
    assert.ok(allowlistMatch, 'allowlist block found in server/index.js');
    assert.ok(!allowlistMatch[1].includes('maya'),
      'allowlisted paths bypass auth entirely (auth-middleware.js:196) — '
      + 'a maya entry would publish an unauthenticated proxy over the server-held credential');
    const streamMatch = src.match(/streamPaths:\s*\[([^\]]*)\]/);
    assert.ok(!streamMatch?.[1]?.includes('maya'), 'no maya query-token stream path either');
  });

  // ── /status funnel state machine ─────────────────────────────────────────

  test('status: no workspace root → {enabled:false}', async () => {
    const srv = await startApp({ root: null });
    track(srv);
    const { status, body } = await getStatus(srv.baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false });
  });

  test('status: no maya config block → {enabled:false} (feature not installed)', async () => {
    const root = makeProjectRoot({});
    const srv = await startApp({ root });
    track(srv);
    assert.deepEqual((await getStatus(srv.baseUrl)).body, { enabled: false });
  });

  test('status: malformed compose.json → shaped {enabled:false}, never a throw', async () => {
    const root = makeProjectRoot({});
    writeFileSync(join(root, '.compose', 'compose.json'), '{not json');
    const srv = await startApp({ root });
    track(srv);
    const { status, body } = await getStatus(srv.baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false });
  });

  test('status: maya configured but fluid provider is the local floor → connect-smartmemory funnel', async () => {
    const root = makeProjectRoot({ maya: { baseUrl: 'http://127.0.0.1:1', auth: { mode: 'provision' } } });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await getStatus(srv.baseUrl);
    assert.equal(body.enabled, true);
    assert.equal(body.state, 'connect-smartmemory');
  });

  test('status: provider up, Maya unreachable → offline funnel', async () => {
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: 'http://127.0.0.1:1', smBase: sm.baseUrl });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await getStatus(srv.baseUrl);
    assert.equal(body.state, 'offline');
    assert.equal(body.baseUrl, 'http://127.0.0.1:1');
  });

  test('status: all up → ready, capabilities honest (calibration visibly unavailable)', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await getStatus(srv.baseUrl);
    assert.equal(body.state, 'ready');
    assert.deepEqual(body.auth, { mode: 'provision', identity: false });
    assert.deepEqual(body.capabilities, {
      challenge: true, conviction: true, contradiction: true, calibration: false,
    });
  });

  test('status: stored identity whose claim equals the fluid workspace → workspace-collision funnel', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    saveIdentity(root, {
      email: 'x@compose.invalid', user_id: 'u1', tenant_id: 't1',
      team_id: FLUID_WS, access_token: 'tok', ndaAccepted: true,
    });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await getStatus(srv.baseUrl);
    assert.equal(body.state, 'workspace-collision');
  });

  // ── /message ─────────────────────────────────────────────────────────────

  test('message: first use provisions (+NDA), persists identity, chats, reuses on second turn', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);

    const r1 = await postMessage(srv.baseUrl, { text: 'hello maya' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.reply, 'echo:hello maya');
    assert.match(r1.body.message_id, /^msg_/);
    assert.ok('writeback' in r1.body);

    // Provisioned exactly once, NDA accepted with the provisioned bearer.
    const provisions = sm.seen.filter((s) => s.path === '/test/provision-user' && s.method === 'POST');
    assert.equal(provisions.length, 1);
    const nda = sm.seen.find((s) => s.path === '/memory/beta/nda/accept');
    assert.equal(nda.authorization, 'Bearer token-1');
    assert.deepEqual(nda.body, { version: 'v1' });

    // Identity persisted with what provisioning returned.
    const identity = loadIdentity(root);
    assert.equal(identity.access_token, 'token-1');
    assert.equal(identity.team_id, 'team_colleague');
    assert.equal(identity.ndaAccepted, true);
    assert.ok(existsSync(join(root, 'data', 'maya-identity.json')));

    // Second turn: no second provision, same bearer on the chat.
    const r2 = await postMessage(srv.baseUrl, { text: 'again' });
    assert.equal(r2.body.ok, true);
    assert.equal(sm.seen.filter((s) => s.path === '/test/provision-user' && s.method === 'POST').length, 1);
    const chats = maya.seen.filter((s) => s.path === '/api/chat');
    assert.equal(chats.length, 2);
    assert.ok(chats.every((c) => c.authorization === 'Bearer token-1'));
  });

  test('message: composed context blocks travel as channel_context; omissions surface', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({
      root,
      deps: {
        composeContext: async () => ({
          blocks: [{ author: 'compose:idea IDEA-42', text: 'Redis streams' }],
          omissions: ['discussion omitted, over budget'],
        }),
      },
    });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42' });
    assert.equal(body.ok, true);
    assert.deepEqual(body.context, {
      sent: ['compose:idea IDEA-42'], omissions: ['discussion omitted, over budget'],
    });
    const chat = maya.seen.find((s) => s.path === '/api/chat');
    assert.deepEqual(chat.body.channel_context, [
      { author: 'compose:idea IDEA-42', text: 'Redis streams' },
    ]);
  });

  test('message: context builder failure → context funnel, chat NEVER sent (no plain-chat mode)', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({
      root,
      deps: { composeContext: async () => { throw new Error('provider exploded'); } },
    });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'context');
    assert.equal(maya.seen.filter((s) => s.path === '/api/chat').length, 0);
  });

  test('message: standing 401 → auth funnel, identity NOT silently re-provisioned', async () => {
    const maya = await makeMayaServer();
    maya.server.__401Always = true;
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'auth');
    // Exactly ONE provision (the lazy first-use one) — the 401 must not mint
    // a fresh identity; that would destroy the standing conversation.
    assert.equal(sm.seen.filter((s) => s.path === '/test/provision-user' && s.method === 'POST').length, 1);
    // And the stored identity survives untouched for the explicit-action funnel.
    assert.equal(loadIdentity(root).access_token, 'token-1');
  });

  test('message: crash between provision and NDA-accept retries the NDA on the SAME identity', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    // A saved identity whose NDA never completed (crash window).
    saveIdentity(root, {
      mode: 'provision', email: 'x@compose.invalid', user_id: 'u1', tenant_id: 't1',
      team_id: 'team_colleague', access_token: 'tok-crashed', ndaAccepted: false,
    });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, true);
    // NDA accepted with the EXISTING token; no fresh identity was minted.
    const nda = sm.seen.find((s) => s.path === '/memory/beta/nda/accept');
    assert.equal(nda.authorization, 'Bearer tok-crashed');
    assert.equal(sm.seen.filter((s) => s.path === '/test/provision-user' && s.method === 'POST').length, 0);
    assert.equal(loadIdentity(root).ndaAccepted, true);
  });

  test('message: local-floor fluid provider → connect-smartmemory refusal, zero upstream traffic', async () => {
    const maya = await makeMayaServer();
    const root = makeProjectRoot({ maya: { baseUrl: maya.baseUrl, auth: { mode: 'provision' } } });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'connect-smartmemory');
    assert.equal(maya.seen.filter((s) => s.path === '/api/chat').length, 0);
  });

  test('message: Maya unreachable → offline funnel', async () => {
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: 'http://127.0.0.1:1', smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'offline');
  });

  test('message: workspace collision refused BEFORE any provisioning-side effect or chat', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    saveIdentity(root, {
      email: 'x@compose.invalid', user_id: 'u1', tenant_id: 't1',
      team_id: FLUID_WS, access_token: 'tok', ndaAccepted: true,
    });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'workspace-collision');
    assert.equal(maya.seen.filter((s) => s.path === '/api/chat').length, 0);
  });

  test('message: static mode with no pasted token → auth funnel, zero provisioning', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl, mode: 'static' });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'auth');
    assert.equal(sm.seen.filter((s) => s.path === '/test/provision-user').length, 0);
  });

  test('message: static mode with a pasted token uses it verbatim, never provisions', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl, mode: 'static' });
    saveIdentity(root, { access_token: 'pasted-token', mode: 'static' });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(body.ok, true);
    const chat = maya.seen.find((s) => s.path === '/api/chat');
    assert.equal(chat.authorization, 'Bearer pasted-token');
    assert.equal(sm.seen.filter((s) => s.path === '/test/provision-user').length, 0);
  });

  test('message: empty text → invalid, no upstream traffic', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: '   ' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'invalid');
    assert.equal(maya.seen.filter((s) => s.path === '/api/chat').length, 0);
    assert.equal(sm.seen.length, 0);
  });

  // ── write-back wiring (S4) — the reconcile logic itself is golden-tested
  //    in test/colleague-writeback.test.js; these cover the route contract ──

  function writebackSpy(result = { outcome: 'ok', focusId: 'IDEA-42' }) {
    const calls = [];
    const fn = async (root, args) => {
      calls.push({ root, args });
      if (result instanceof Error) throw result;
      return result;
    };
    return { fn, calls };
  }

  async function wiredMessageApp({ writeback, context = emptyContext }) {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({
      root,
      deps: { composeContext: context, performWriteback: writeback },
    });
    track(srv);
    return { maya, sm, root, srv };
  }

  test('message with a focus: write-back runs with the reply + message_id; outcome rides the response', async () => {
    const { fn, calls } = writebackSpy({ outcome: 'ok', focusId: 'IDEA-42' });
    const { srv } = await wiredMessageApp({ writeback: fn });
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42' });
    assert.equal(body.ok, true);
    assert.deepEqual(body.writeback, { outcome: 'ok', focusId: 'IDEA-42' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, {
      focusId: 'IDEA-42', messageId: body.message_id, text: body.reply,
    });
  });

  test('message with writeback:false or without focus: no write-back attempt', async () => {
    const { fn, calls } = writebackSpy();
    const { srv } = await wiredMessageApp({ writeback: fn });
    const r1 = await postMessage(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42', writeback: false });
    assert.equal(r1.body.writeback, null);
    const r2 = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(r2.body.writeback, null);
    assert.equal(calls.length, 0);
  });

  test('write-back failure NEVER fails the turn: reply authoritative, outcome failed', async () => {
    const { fn } = writebackSpy(new Error('append blew up'));
    const { srv } = await wiredMessageApp({ writeback: fn });
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42' });
    assert.equal(body.ok, true);
    assert.equal(body.reply, 'echo:hi');
    assert.equal(body.writeback.outcome, 'failed');
    assert.match(body.writeback.reason, /append blew up/);
  });

  test('writeback-retry: append-only — runs the reconcile, never touches chat', async () => {
    const { fn, calls } = writebackSpy({ outcome: 'ok', focusId: 'IDEA-42', deduped: true });
    const { maya, srv } = await wiredMessageApp({ writeback: fn });
    const r = await fetch(`${srv.baseUrl}/api/maya/writeback-retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ focusId: 'IDEA-42', message_id: 'msg_7', text: 'her reply' }),
    });
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.writeback, { outcome: 'ok', focusId: 'IDEA-42', deduped: true });
    assert.deepEqual(calls[0].args, { focusId: 'IDEA-42', messageId: 'msg_7', text: 'her reply' });
    assert.equal(maya.seen.filter((s) => s.path === '/api/chat').length, 0);
  });

  test('writeback-retry: missing fields refused before any work', async () => {
    const { fn, calls } = writebackSpy();
    const { srv } = await wiredMessageApp({ writeback: fn });
    const r = await fetch(`${srv.baseUrl}/api/maya/writeback-retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ focusId: 'IDEA-42' }),
    });
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'invalid');
    assert.equal(calls.length, 0);
  });

  // ── /identity — the auth funnel's explicit actions (S3) ──────────────────

  test('identity reprovision: tears down upstream, clears the store; next turn provisions fresh', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);

    await postMessage(srv.baseUrl, { text: 'first' }); // provisions token-1
    const r = await fetch(`${srv.baseUrl}/api/maya/identity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ action: 'reprovision' }),
    });
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(loadIdentity(root), null);
    assert.ok(sm.seen.some((s) => s.path === '/test/provision-user' && s.method === 'DELETE'));

    // Next turn mints a FRESH identity — a new thread, chosen explicitly.
    const r2 = await postMessage(srv.baseUrl, { text: 'again' });
    assert.equal(r2.body.ok, true);
    assert.equal(loadIdentity(root).access_token, 'token-2');
  });

  test('identity static: stores a pasted token; a fluid-workspace token is refused and NOT stored', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);

    const post = async (body) => {
      const r = await fetch(`${srv.baseUrl}/api/maya/identity`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify(body),
      });
      return r.json();
    };

    // A JWT whose workspace claim IS the fluid workspace → refused, nothing stored.
    const claim = Buffer.from(JSON.stringify({ workspace_id: FLUID_WS })).toString('base64url');
    const bad = await post({ action: 'static', token: `h.${claim}.s` });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.kind, 'workspace-collision');
    assert.equal(loadIdentity(root), null);

    // An opaque token stores as a static identity.
    const good = await post({ action: 'static', token: 'pasted-opaque' });
    assert.equal(good.ok, true);
    assert.deepEqual(loadIdentity(root), { mode: 'static', access_token: 'pasted-opaque' });
  });

  // ── workspace-isolation validation (the VERIFY-3 refusal unit test) ──────

  test('validateWorkspaceIsolation: fluid-workspace token refused, distinct allowed', () => {
    const collide = { team_id: FLUID_WS, access_token: 'tok' };
    assert.throws(
      () => validateWorkspaceIsolation(collide, FLUID_WS),
      (err) => err instanceof MayaWorkspaceCollisionError,
    );
    assert.doesNotThrow(() => validateWorkspaceIsolation({ team_id: 'team_other' }, FLUID_WS));
    // No claim derivable (static token, opaque) → documented-unsupported, allowed.
    assert.doesNotThrow(() => validateWorkspaceIsolation({ access_token: 'opaque' }, FLUID_WS));
    // JWT workspace claim in the token body is honoured when present.
    const claim = Buffer.from(JSON.stringify({ workspace_id: FLUID_WS })).toString('base64url');
    assert.throws(
      () => validateWorkspaceIsolation({ access_token: `h.${claim}.s` }, FLUID_WS),
      (err) => err instanceof MayaWorkspaceCollisionError,
    );
  });
});
