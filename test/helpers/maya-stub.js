/**
 * test/helpers/maya-stub.js — raw node:http stubs for the FOH-6 colleague relay:
 * one for Maya's chat surface, one for smart-memory-service's test provisioning
 * surface. Shared by test/maya-client.test.js and test/maya-routes.test.js.
 *
 * Same doctrine as smartmemory-stub.js: THE STUB IS THE WIRE CONTRACT. The
 * shapes here reproduce what the FOH-6 live-fire verified against the real
 * stack (VERIFY-1/2/3, foh-6-progress.md):
 *   - POST /api/chat answers `{success, response, message_id, memory_available}`
 *     and accepts `channel_context: [{author, text}]` on input.
 *   - POST /test/provision-user answers `{user_id, tenant_id, team_id,
 *     access_token}`; same-email re-provision answers 409 (probed live).
 *   - DELETE /test/provision-user requires `{email, user_id, tenant_id}`.
 *   - POST /memory/beta/nda/accept is Bearer-authenticated.
 *
 * Failure knobs (set on the returned server object, __hits-style):
 *   maya.__401Once / .__401Always   — auth rejection, once vs standing
 *   maya.__slowMs                   — delay /api/chat past a client deadline
 *   maya.__rejectChannelContext     — 422 when channel_context present (the
 *                                     "Maya upgrade dropped the field" case)
 *   maya.__healthDown               — /health answers 503
 *   maya.__chatFail                 — /api/chat answers 500
 *   maya.__htmlBody                 — /api/chat answers 200 with HTML (proxy page)
 *   maya.__successFalse             — /api/chat answers 200 {success:false,...}
 *
 * No express, no mocking library.
 */

import http from 'node:http';

/** Servers opened here; importing suites close them in `after`. */
export const servers = [];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

/** Maya's surface: GET /health, POST /api/chat. */
export async function makeMayaServer() {
  const seen = [];
  let nextMsg = 0;
  let used401 = false;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      seen.push({
        path: req.url, method: req.method, body: parsed,
        authorization: req.headers.authorization ?? null,
      });
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url === '/health' && req.method === 'GET') {
        if (server.__healthDown) return json(503, { status: 'down' });
        return json(200, { status: 'ok' });
      }

      if (req.url === '/api/chat' && req.method === 'POST') {
        const answer = () => {
          if (server.__401Always || (server.__401Once && !used401)) {
            used401 = true;
            return json(401, { detail: 'unauthorized' });
          }
          if (server.__rejectChannelContext && parsed?.channel_context) {
            return json(422, { detail: 'channel_context is not accepted' });
          }
          if (server.__chatFail) return json(500, { detail: 'internal error' });
          if (server.__htmlBody) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html>proxy error page</html>');
          }
          if (server.__successFalse) {
            return json(200, { success: false, response: '', error: 'turn failed' });
          }
          nextMsg += 1;
          return json(200, {
            success: true,
            response: `echo:${parsed?.message ?? ''}`,
            message_id: `msg_${nextMsg}`,
            memory_available: true,
          });
        };
        if (server.__slowMs) return void setTimeout(answer, server.__slowMs).unref();
        return answer();
      }

      return json(404, { detail: 'no route' });
    });
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, seen };
}

/**
 * smart-memory-service's provisioning surface: POST/DELETE /test/provision-user,
 * POST /memory/beta/nda/accept. `teamId` is settable so the workspace-collision
 * refusal can be driven against a token whose claim equals the fluid workspace.
 */
export async function makeSmStub({ teamId = 'team_colleague' } = {}) {
  const seen = [];
  const provisioned = new Set();
  let nextUser = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      seen.push({
        path: req.url, method: req.method, body: parsed,
        authorization: req.headers.authorization ?? null,
      });
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url === '/test/provision-user' && req.method === 'POST') {
        const email = parsed?.email;
        if (!email) return json(422, { detail: 'email required' });
        // Probed live 2026-08-11: same-email re-provision is refused.
        if (provisioned.has(email)) return json(409, { detail: 'Email already registered' });
        provisioned.add(email);
        nextUser += 1;
        return json(200, {
          user_id: `user_${nextUser}`,
          tenant_id: `tenant_${nextUser}`,
          team_id: server.__teamId ?? teamId,
          access_token: `token-${nextUser}`,
        });
      }

      if (req.url === '/test/provision-user' && req.method === 'DELETE') {
        if (!parsed?.email || !parsed?.user_id || !parsed?.tenant_id) {
          return json(422, { detail: 'email, user_id, tenant_id required' });
        }
        provisioned.delete(parsed.email);
        return json(200, { status: 'deleted' });
      }

      if (req.url === '/memory/beta/nda/accept' && req.method === 'POST') {
        if (!req.headers.authorization) return json(401, { detail: 'unauthorized' });
        if (server.__ndaFail) return json(500, { detail: 'nda failed' });
        return json(200, { accepted: true, version: parsed?.version ?? null });
      }

      return json(404, { detail: 'no route' });
    });
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, seen };
}
