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
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachMayaRoutes } = await import(`${ROOT}/server/maya-routes.js`);
const { loadIdentity, saveIdentity, clearIdentity, validateWorkspaceIsolation, MayaWorkspaceCollisionError } =
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

async function readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const events = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = '';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      events.push({ event, data: JSON.parse(data.join('\n')) });
    }
    if (done) break;
  }
  return events;
}

async function postStream(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/maya/message?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(payload),
  });
  return { res, events: await readSse(res) };
}

function disconnectAfterFirstToken(baseUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let sawToken = false;
    let received = '';
    const req = request(`${baseUrl}/api/maya/message?stream=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      },
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        received += chunk;
        if (!sawToken && received.includes('event: token')) {
          sawToken = true;
          response.destroy();
          resolve();
        }
      });
      response.on('end', () => {
        if (!sawToken) reject(new Error('stream ended before the first token'));
      });
      response.on('error', (err) => {
        if (sawToken) resolve();
        else reject(err);
      });
    });
    req.on('error', (err) => {
      if (sawToken) resolve();
      else reject(err);
    });
    req.end(body);
  });
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

  test('message: NDA accept follows the version the server names (upstream bumped v1 → v2)', async () => {
    // FOH-7 live-fire, 2026-09-06: upstream moved the beta NDA to v2 and every
    // freshly provisioned colleague identity failed its first turn with
    // "NDA accept failed (HTTP 409)". The client must accept the version the
    // 409 names, not the one it was written against.
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    sm.server.__ndaVersion = 'v2';
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);

    const r1 = await postMessage(srv.baseUrl, { text: 'hello maya' });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.ok, true);

    const ndas = sm.seen.filter((s) => s.path === '/memory/beta/nda/accept');
    assert.deepEqual(ndas.map((n) => n.body.version), ['v1', 'v2']);
    assert.equal(loadIdentity(root).ndaAccepted, true);
  });

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
      sent: ['compose:idea IDEA-42'],
      omissions: ['discussion omitted, over budget'],
      blocks: [{ author: 'compose:idea IDEA-42', text: 'Redis streams' }],
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

  test('identity static: paste verifies the token upstream and FAILS CLOSED', async () => {
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

    // A JWT whose workspace claim IS the fluid workspace → refused offline,
    // before any network verification.
    const claim = Buffer.from(JSON.stringify({ workspace_id: FLUID_WS })).toString('base64url');
    const bad = await post({ action: 'static', token: `h.${claim}.s` });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.kind, 'workspace-collision');
    assert.equal(loadIdentity(root), null);
    assert.equal(sm.seen.filter((s) => s.path === '/auth/me').length, 0);

    // Real tokens carry NO workspace claims (VERIFY-1) — the authoritative
    // check resolves the workspace from the service's own user record. A
    // token whose VERIFIED workspace is the fluid workspace is refused.
    sm.server.__meTeamId = FLUID_WS;
    const collide = await post({ action: 'static', token: 'opaque-fluid-scoped' });
    assert.equal(collide.ok, false);
    assert.equal(collide.error.kind, 'workspace-collision');
    assert.equal(loadIdentity(root), null);

    // Verification unavailable → FAIL CLOSED: not stored.
    sm.server.__meTeamId = undefined;
    sm.server.__meFail = true;
    const unverifiable = await post({ action: 'static', token: 'opaque-unverifiable' });
    assert.equal(unverifiable.ok, false);
    assert.equal(loadIdentity(root), null);

    // A verifiable, distinct-workspace token stores WITH its verified claim,
    // so every later isolation check has a real claim to test.
    sm.server.__meFail = false;
    const good = await post({ action: 'static', token: 'pasted-opaque' });
    assert.equal(good.ok, true);
    assert.deepEqual(loadIdentity(root), {
      mode: 'static', access_token: 'pasted-opaque', team_id: 'team_colleague',
    });
    const me = sm.seen.filter((s) => s.path === '/auth/me');
    assert.ok(me.length >= 1);
    assert.equal(me.at(-1).authorization, 'Bearer pasted-opaque');
  });

  test('LEGACY claimless static identity: verified-and-migrated on first use, failing closed', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl, mode: 'static' });
    // A pre-verification identity: static, no team_id, no JWT claims.
    saveIdentity(root, { mode: 'static', access_token: 'legacy-opaque' });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);

    // Verified workspace IS the fluid workspace → refused, never chats.
    sm.server.__meTeamId = FLUID_WS;
    const bad = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error.kind, 'workspace-collision');
    assert.equal(maya.seen.filter((s) => s.path === '/api/chat').length, 0);

    // Distinct workspace → migrated in place (claim stored) and the turn runs.
    sm.server.__meTeamId = 'team_elsewhere';
    const ok = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(ok.body.ok, true);
    assert.equal(loadIdentity(root).team_id, 'team_elsewhere');
    // Migration is once: the next turn consults /auth/me no further.
    const meCallsBefore = sm.seen.filter((s) => s.path === '/auth/me').length;
    await postMessage(srv.baseUrl, { text: 'again' });
    assert.equal(sm.seen.filter((s) => s.path === '/auth/me').length, meCallsBefore);

    // Unverifiable → auth funnel, not a chat with an unchecked token.
    clearIdentity(root);
    saveIdentity(root, { mode: 'static', access_token: 'legacy-2' });
    sm.server.__meFail = true;
    const closed = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(closed.body.ok, false);
    assert.equal(closed.body.error.kind, 'auth');
  });

  test('identity reprovision in static mode → refused (dead-end action, not offered)', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl, mode: 'static' });
    saveIdentity(root, { mode: 'static', access_token: 'tok', team_id: 'team_other' });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const r = await fetch(`${srv.baseUrl}/api/maya/identity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ action: 'reprovision' }),
    });
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'invalid');
    // The stored identity survives.
    assert.equal(loadIdentity(root).access_token, 'tok');
  });

  test('status: static mode with no stored token → auth funnel, not ready', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl, mode: 'static' });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await getStatus(srv.baseUrl);
    assert.equal(body.state, 'auth');
    assert.deepEqual(body.auth, { mode: 'static', identity: false });
  });

  test('maya block present but no baseUrl → misconfigured FUNNEL, never hidden', async () => {
    const root = makeProjectRoot({ maya: { auth: { mode: 'provision' } } });
    const srv = await startApp({ root });
    track(srv);
    const { body } = await getStatus(srv.baseUrl);
    assert.equal(body.enabled, true);
    assert.equal(body.state, 'misconfigured');
    const msg = await postMessage(srv.baseUrl, { text: 'hi' });
    assert.equal(msg.body.ok, false);
    assert.equal(msg.body.error.kind, 'misconfigured');
  });

  test('concurrent first turns provision exactly ONE identity (single-flight)', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({ root, deps: { composeContext: emptyContext } });
    track(srv);
    const [r1, r2] = await Promise.all([
      postMessage(srv.baseUrl, { text: 'first' }),
      postMessage(srv.baseUrl, { text: 'second' }),
    ]);
    assert.equal(r1.body.ok, true);
    assert.equal(r2.body.ok, true);
    assert.equal(sm.seen.filter((s) => s.path === '/test/provision-user' && s.method === 'POST').length, 1);
    // Both turns chatted with the ONE provisioned token.
    const chats = maya.seen.filter((s) => s.path === '/api/chat');
    assert.ok(chats.every((c) => c.authorization === 'Bearer token-1'));
  });

  test('message response carries the composed findings blocks for the accordion', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    const srv = await startApp({
      root,
      deps: {
        composeContext: async () => ({
          blocks: [{ author: 'compose:contradiction', text: 'IDEA-7 contradicts' }],
          omissions: [],
        }),
      },
    });
    track(srv);
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42' });
    assert.deepEqual(body.context.blocks, [{ author: 'compose:contradiction', text: 'IDEA-7 contradicts' }]);
  });

  // ── /message?stream=1 (S5) ──────────────────────────────────────────────

  test('stream message: tokens, final context, then successful write-back, then clean end', async () => {
    const { fn, calls } = writebackSpy({ outcome: 'ok', focusId: 'IDEA-42' });
    const context = async () => ({
      blocks: [{ author: 'compose:idea IDEA-42', text: 'Redis streams' }],
      omissions: ['discussion omitted, over budget'],
    });
    const { srv } = await wiredMessageApp({ writeback: fn, context });
    const { res, events } = await postStream(srv.baseUrl, {
      text: 'stream this', focusId: 'IDEA-42',
    });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    // Without this, a reverse proxy (nginx) buffers the SSE body whole and
    // S5 collapses back into a one-shot response (Codex r1 P2).
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.deepEqual(events.map((event) => event.event), [
      'token', 'token', 'final', 'writeback',
    ]);

    const final = events.find((event) => event.event === 'final').data;
    assert.equal(events.filter((event) => event.event === 'token')
      .map((event) => event.data.text).join(''), final.reply);
    assert.deepEqual(final.context, {
      sent: ['compose:idea IDEA-42'],
      omissions: ['discussion omitted, over budget'],
      blocks: [{ author: 'compose:idea IDEA-42', text: 'Redis streams' }],
    });
    assert.ok(!('writeback' in final));
    assert.deepEqual(events.at(-1).data, { outcome: 'ok', focusId: 'IDEA-42' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, {
      focusId: 'IDEA-42', messageId: final.message_id, text: final.reply,
    });
  });

  test('stream message: no focus emits final without a write-back event', async () => {
    const { fn, calls } = writebackSpy();
    const { srv } = await wiredMessageApp({ writeback: fn });
    const { events } = await postStream(srv.baseUrl, { text: 'hi' });
    assert.deepEqual(events.map((event) => event.event), ['token', 'token', 'final']);
    assert.equal(calls.length, 0);
  });

  test('stream message: pre-flight failure stays the existing JSON envelope', async () => {
    const root = makeProjectRoot({});
    const srv = await startApp({ root });
    track(srv);
    const res = await fetch(`${srv.baseUrl}/api/maya/message?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await res.json(), { ok: false, error: { kind: 'not-installed' } });
  });

  test('stream message: upstream error event becomes one terminal relay error event', async () => {
    const { fn } = writebackSpy();
    const { maya, srv } = await wiredMessageApp({ writeback: fn });
    maya.server.__streamErrorEvent = true;
    const { res, events } = await postStream(srv.baseUrl, { text: 'hi' });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(events.filter((event) => event.event === 'error').length, 1);
    assert.deepEqual(events.at(-1), {
      event: 'error',
      data: { kind: 'upstream', message: 'boom', status: 500 },
    });
    assert.equal(events.some((event) => event.event === 'final'), false);
  });

  test('stream message: write-back failure follows final and still ends cleanly', async () => {
    const { fn } = writebackSpy(new Error('append blew up'));
    const { srv } = await wiredMessageApp({ writeback: fn });
    const { events } = await postStream(srv.baseUrl, {
      text: 'hi', focusId: 'IDEA-42',
    });
    assert.deepEqual(events.slice(-2).map((event) => event.event), ['final', 'writeback']);
    assert.equal(events.at(-1).data.outcome, 'failed');
    assert.equal(events.at(-1).data.focusId, 'IDEA-42');
    assert.match(events.at(-1).data.reason, /append blew up/);
  });

  test('stream message: downstream disconnect detaches; final still drives write-back', async () => {
    let writebackArgs;
    let writebackDone;
    const completed = new Promise((resolve) => { writebackDone = resolve; });
    const performWriteback = async (_root, args) => {
      writebackArgs = args;
      writebackDone();
      return { outcome: 'ok', focusId: args.focusId };
    };
    const { maya, srv } = await wiredMessageApp({ writeback: performWriteback });
    maya.server.__streamSplitFrames = true;

    await disconnectAfterFirstToken(srv.baseUrl, { text: 'hi', focusId: 'IDEA-42' });
    await Promise.race([
      completed,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('write-back did not complete after detach')), 1000).unref();
      }),
    ]);
    assert.equal(writebackArgs.focusId, 'IDEA-42');
    assert.match(writebackArgs.messageId, /^msg_/);
    assert.equal(writebackArgs.text, 'echo:hi');
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

// ---------------------------------------------------------------------------
// FOH-7 S3 — portfolio scope on the turn
// ---------------------------------------------------------------------------

describe('FOH-7 S3 — scope on a colleague turn', () => {
  // Own cleanup. The suite above closes `servers` in ITS `after`, which runs
  // before this sibling suite creates any — so the stubs made here would be left
  // listening and keep the whole test FILE alive until the runner's timeout
  // kills it. Close both the app servers and the stubs this suite added.
  const cleanups = [];
  const stubsFrom = servers.length;
  after(() => {
    for (const close of cleanups.reverse()) close();
    for (const stub of servers.slice(stubsFrom)) stub.close();
  });

  /** Add a portfolio to an already-wired root, listing itself as required. */
  function declarePortfolio(root, extra = []) {
    const cfgPath = join(root, '.compose', 'compose.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.fluid = { ...cfg.fluid, portfolio: { members: [{ id: 'self', root: '.' }, ...extra] } };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return root;
  }

  async function wired(deps = {}, { portfolio = false } = {}) {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl });
    if (portfolio) declarePortfolio(root);
    const srv = await startApp({ root, deps: { composeContext: emptyContext, ...deps } });
    cleanups.push(() => srv.httpServer.close());
    return { srv, root };
  }

  // THE FORWARDING SEAM. `attachMayaRoutes` injects fourteen dependencies, which
  // makes this route easy to test and equally easy to test while its production
  // wiring is dead: every other assertion here could pass against a stub composer
  // while `defaultComposeContext` (server/maya-routes.js:70-73) drops `scope` on
  // the floor. So this asserts what the composer RECEIVES, which is the thing
  // that actually breaks.
  test('forwards focusId, scope AND text to the composer', async () => {
    let received = null;
    const { srv } = await wired({
      composeContext: async (_root, args) => { received = args; return { blocks: [], omissions: [] }; },
    }, { portfolio: true });
    await postMessage(srv.baseUrl, { text: 'what did we decide', scope: 'portfolio' });
    assert.ok(received, 'the composer was called');
    // 'portfolio', not 'project': with 'project' this test stays green even if
    // the production wrapper drops portfolio scope entirely, which is the exact
    // thing it exists to catch.
    assert.equal(received.scope, 'portfolio', 'scope reaches the composer');
    assert.equal(received.text, 'what did we decide', 'and so does the turn text');
    assert.ok('focusId' in received, 'focusId still forwarded');
  });

  test('an absent scope stays absent — no defaulting', async () => {
    let received = null;
    const { srv } = await wired({
      composeContext: async (_root, args) => { received = args; return { blocks: [], omissions: [] }; },
    });
    await postMessage(srv.baseUrl, { text: 'hello' });
    assert.equal(received.scope, undefined, 'today\'s behaviour is preserved exactly');
  });

  // THE PROJECTION, read from what production SENDS — not rebuilt by the test.
  // The first version of this test constructed the flat projection itself and
  // asserted on its own construction, so it passed while the route handed Maya
  // the raw blocks with a nested `source` it cannot accept. A projection test
  // that does not observe the client call proves nothing.
  test('sends Maya flat {author,text} with the source surviving in the prose', async () => {
    let sentContext = null;
    const { srv } = await wired({
      createClient: () => ({
        chat: async ({ channelContext }) => {
          sentContext = channelContext;
          return { success: true, response: 'ok', message_id: 'm1' };
        },
      }),
      composeContext: async () => ({
        blocks: [
          { author: 'compose:portfolio', text: 'From alpha (/r/alpha) — IDEA-1', source: { id: 'alpha', root: '/r/alpha' } },
          { author: 'compose:portfolio', text: 'From beta (/r/beta) — IDEA-1', source: { id: 'beta', root: '/r/beta' } },
        ],
        omissions: [],
      }),
    });
    await postMessage(srv.baseUrl, { text: 'q' });

    assert.ok(sentContext, 'the client was called');
    for (const block of sentContext) {
      assert.deepEqual(Object.keys(block).sort(), ['author', 'text'], 'Maya accepts only these two keys');
    }
    // Asserting only "no nested source" would pass if source were simply
    // dropped. The property is that the identity SURVIVED.
    assert.notEqual(sentContext[0].text, sentContext[1].text, 'two products stay distinguishable');
    assert.ok(sentContext.some((b) => b.text.includes('alpha')));
    assert.ok(sentContext.some((b) => b.text.includes('beta')));
  });

  test('the panel still receives the structured source', async () => {
    const { srv } = await wired({
      createClient: () => ({ chat: async () => ({ success: true, response: 'ok', message_id: 'm1' }) }),
      composeContext: async () => ({
        blocks: [{ author: 'compose:portfolio', text: 'From alpha', source: { id: 'alpha', root: '/r/alpha' } }],
        omissions: [],
      }),
    });
    const { body } = await postMessage(srv.baseUrl, { text: 'q' });
    assert.deepEqual(body.context.blocks[0].source, { id: 'alpha', root: '/r/alpha' });
  });

  test('SSE preserves both projections too, not JSON alone', async () => {
    let sentContext = null;
    const { srv } = await wired({
      createClient: () => ({
        chatStream: async ({ channelContext, onToken }) => {
          sentContext = channelContext;
          onToken?.('ok');
          return { success: true, response: 'ok', message_id: 'm1' };
        },
      }),
      composeContext: async () => ({
        blocks: [
          { author: 'compose:portfolio', text: 'From alpha (/r/alpha) — IDEA-1', source: { id: 'alpha', root: '/r/alpha' } },
          { author: 'compose:portfolio', text: 'From beta (/r/beta) — IDEA-1', source: { id: 'beta', root: '/r/beta' } },
        ],
        omissions: [],
      }),
    });

    const res = await fetch(`${srv.baseUrl}/api/maya/message?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ text: 'q' }),
    });
    const events = await readSse(res);

    assert.ok(sentContext, 'the streaming client was called');
    for (const block of sentContext) {
      assert.deepEqual(Object.keys(block).sort(), ['author', 'text'], 'flat for Maya on the SSE path too');
    }
    assert.ok(sentContext.some((b) => b.text.includes('alpha')));
    assert.ok(sentContext.some((b) => b.text.includes('beta')));

    const final = events.find((e) => e.event === 'final');
    assert.deepEqual(
      final.data.context.blocks[0].source, { id: 'alpha', root: '/r/alpha' },
      'and the panel still gets structured source over SSE',
    );
  });

  test('refuses an unrecognised scope rather than answering for one product', async () => {
    const { srv } = await wired();
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', scope: 'portoflio' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'invalid', 'a typo must not silently become a project answer');
  });

  test('refuses portfolio scope combined with a focused idea', async () => {
    const { srv } = await wired();
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', scope: 'portfolio', focusId: 'IDEA-1' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'invalid');
  });

  test('refuses portfolio scope when no portfolio is declared, as misconfigured', async () => {
    const { srv } = await wired();
    const { body } = await postMessage(srv.baseUrl, { text: 'hi', scope: 'portfolio' });
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'misconfigured', 'never a silent downgrade to one product');
  });

  // -------------------------------------------------------------------------
  // FOH-7 acceptance: the local declaring root funnels, and nothing writes.
  // Both were listed as "pinned by test" with no test (design-foh-7.md audit,
  // 2026-09-07).
  // -------------------------------------------------------------------------

  // The funnel and the portfolio branch share one pre-flight, and the portfolio
  // check runs FIRST — so a declaring root on the local floor is exactly the
  // case where a widened portfolio branch could answer a turn the funnel exists
  // to refuse. COLLEAGUE-ALL-IN: the colleague never runs degraded, and having
  // SmartMemory-backed MEMBERS is not the same as being SmartMemory-backed.
  test('a local declaring root still funnels, even with SmartMemory members declared', async () => {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    // A genuinely SmartMemory-backed member. A portfolio of local members would
    // prove strictly less than the criterion asks.
    const member = makeProjectRoot({
      smartmemory: { baseUrl: sm.baseUrl, apiKeyEnv: 'SM_FLUID_KEY', enabled: true },
      fluid: { provider: 'smartmemory', smartmemory: { workspaceId: 'team_member_ws' } },
    });
    // The DECLARING root is on the local floor: maya wired, fluid is not.
    const root = makeProjectRoot({
      maya: { baseUrl: maya.baseUrl, auth: { mode: 'provision' } },
      smartmemory: { baseUrl: sm.baseUrl, apiKeyEnv: 'SM_FLUID_KEY', enabled: true },
      fluid: { provider: 'local' },
    });
    declarePortfolio(root, [{ id: 'member', root: member }]);

    let composed = false;
    const srv = await startApp({
      root,
      deps: {
        composeContext: async () => { composed = true; return { blocks: [], omissions: [] }; },
      },
    });
    cleanups.push(() => srv.httpServer.close());

    const { body } = await postMessage(srv.baseUrl, { text: 'what did we decide', scope: 'portfolio' });
    assert.equal(body.ok, false);
    assert.equal(
      body.error.kind, 'connect-smartmemory',
      'a declared portfolio does not rescue a local declaring root',
    );
    // Not just the verdict — the members were never asked, so nothing was read
    // through a floor the funnel had already refused.
    assert.equal(composed, false, 'no member was asked');
    assert.equal(
      maya.seen.filter((r) => String(r.path).startsWith('/api/chat')).length, 0,
      'and no turn reached Maya',
    );
  });

  /** Every regular file under `dir`, as path → sha256. */
  function snapshotTree(dir) {
    const out = new Map();
    const walk = (at, rel) => {
      for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(at, entry.name);
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, key);
        else if (entry.isFile()) out.set(key, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    };
    walk(dir, '');
    return out;
  }

  /** A portfolio-ready root whose identity is ALREADY settled, so the only
   *  writes a turn could make are the ones under test. `static` mode with a
   *  workspace claim skips both provisioning and the legacy verify-and-migrate
   *  branch, each of which persists an identity of its own. */
  async function settledPortfolioRoot(deps = {}) {
    const maya = await makeMayaServer();
    const sm = await makeSmStub();
    const root = wiredRoot({ mayaBase: maya.baseUrl, smBase: sm.baseUrl, mode: 'static' });
    declarePortfolio(root);
    saveIdentity(root, { mode: 'static', access_token: 'settled-token', team_id: 'team_colleague' });
    const srv = await startApp({ root, deps: { composeContext: emptyContext, ...deps } });
    cleanups.push(() => srv.httpServer.close());
    return { srv, root, maya, sm };
  }

  // Read-only is the claim the whole feature rests on. It currently follows from
  // two separate rules (portfolio refuses a focusId; writeback is gated on one),
  // which is an inference, not a guarantee — and the client is asked to lie here
  // (`writeback: true`) because the panel's own suppression is not the server's.
  test('a portfolio turn performs no write-back — JSON transport', async () => {
    const writes = [];
    const { srv } = await settledPortfolioRoot({
      performWriteback: async (...args) => { writes.push(args); return { outcome: 'ok' }; },
      createClient: () => ({ chat: async () => ({ success: true, response: 'ok', message_id: 'm1' }) }),
    });

    const { body } = await postMessage(srv.baseUrl, {
      text: 'what did we decide', scope: 'portfolio', writeback: true,
    });
    assert.equal(body.ok, true, 'the turn itself still answers');
    assert.deepEqual(writes, [], 'the write-back seam is never reached');
    assert.equal(body.writeback ?? null, null, 'and no outcome is reported');
  });

  test('a portfolio turn performs no write-back — SSE transport', async () => {
    // A SECOND call site (the stream handler emits its own writeback event).
    // Pinning only the JSON path leaves the streaming one — the one the panel
    // actually uses — unpinned.
    const writes = [];
    const { srv } = await settledPortfolioRoot({
      performWriteback: async (...args) => { writes.push(args); return { outcome: 'ok' }; },
      createClient: () => ({
        chatStream: async ({ onToken }) => {
          onToken?.('ok');
          return { success: true, response: 'ok', message_id: 'm1' };
        },
      }),
    });

    const { events } = await postStream(srv.baseUrl, {
      text: 'what did we decide', scope: 'portfolio', writeback: true,
    });
    const final = events.find((e) => e.event === 'final');
    assert.ok(final?.data?.ok, 'the streamed turn still answers');
    assert.deepEqual(writes, [], 'the write-back seam is never reached on the stream either');
    assert.equal(events.some((e) => e.event === 'writeback'), false, 'and no writeback event is emitted');
  });

  test('a portfolio turn leaves the project tree byte-identical', async () => {
    // The two tests above pin the injected SEAM. This one runs the REAL
    // write-back dependency and compares the tree, so a write arriving through
    // any other path on this turn — a context builder, a journal, a provenance
    // record — is caught too. `performWriteback` is deliberately NOT injected.
    const { srv, root } = await settledPortfolioRoot({
      createClient: () => ({ chat: async () => ({ success: true, response: 'ok', message_id: 'm1' }) }),
    });
    const before = snapshotTree(root);

    const { body } = await postMessage(srv.baseUrl, {
      text: 'what did we decide', scope: 'portfolio', writeback: true, focusId: null,
    });
    assert.equal(body.ok, true);

    const after = snapshotTree(root);
    assert.deepEqual([...after.keys()], [...before.keys()], 'no file added or removed');
    for (const [path, hash] of before) {
      assert.equal(after.get(path), hash, `${path} was modified by a read-only turn`);
    }
  });
});
