/**
 * test/helpers/maya-stub.js — raw node:http stubs for the FOH-6 colleague relay:
 * one for Maya's chat surface, one for smart-memory-service's test provisioning
 * surface. Shared by test/maya-client.test.js and test/maya-routes.test.js.
 *
 * Same doctrine as smartmemory-stub.js: THE STUB IS THE WIRE CONTRACT. The
 * NON-STREAM shapes here reproduce what the FOH-6 live-fire verified against
 * the real stack (VERIFY-1/2/3, foh-6-progress.md). The /api/chat/stream
 * shapes (S5) are SOURCE-DERIVED from maya routes.py:5362 + turn_events.py —
 * mirrored exactly, but not yet wire-verified (ledger §S5 evidence scope):
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
 *   maya.__streamErrorEvent         — stream emits a terminal 500 error event
 *   maya.__streamError401           — stream emits a terminal 401 error event
 *   maya.__streamCutoff             — stream closes after tokens, without final
 *   maya.__streamSplitFrames        — stream splits frames at awkward byte boundaries
 *   maya.__streamNonSse             — stream path answers a non-SSE 2xx body
 *   maya.__postFinalDelayMs         — hold the stream open after final (post-
 *                                     final work); sets __clientGoneEarly if
 *                                     the client hangs up before the close
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

function streamFrame(event, envelope) {
  return `event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function writeSplit(res, bytes) {
  const firstData = bytes.indexOf('data: ');
  const firstBoundary = bytes.indexOf('\n\n');
  const secondBoundary = bytes.indexOf('\n\n', firstBoundary + 2);
  const cuts = [
    3,
    firstData + 8,
    firstBoundary + 1,
    firstBoundary + 2,
    secondBoundary + 1,
    secondBoundary + 2,
    bytes.length,
  ].filter((cut, index, all) => cut > 0 && cut <= bytes.length && cut > (all[index - 1] ?? 0));
  let offset = 0;
  const writeNext = () => {
    if (offset >= bytes.length) return res.end();
    const next = cuts.find((cut) => cut > offset) ?? bytes.length;
    res.write(bytes.slice(offset, next));
    offset = next;
    if (offset === firstBoundary + 2) return setTimeout(writeNext, 15);
    return setImmediate(writeNext);
  };
  writeNext();
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
        accept: req.headers.accept ?? null,
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

      if (req.url === '/api/chat/stream' && req.method === 'POST') {
        const answer = () => {
          if (server.__401Always || (server.__401Once && !used401)) {
            used401 = true;
            return json(401, { detail: 'unauthorized' });
          }
          if (server.__rejectChannelContext && parsed?.channel_context) {
            return json(422, { detail: 'channel_context is not accepted' });
          }
          if (server.__chatFail) return json(500, { detail: 'internal error' });
          if (server.__streamNonSse) return json(200, { detail: 'not an event stream' });

          nextMsg += 1;
          const replyText = `echo:${parsed?.message ?? ''}`;
          const reply = server.__successFalse
            ? { success: false, response: '', error: 'turn failed' }
            : {
                success: true,
                response: replyText,
                message_id: `msg_${nextMsg}`,
                memory_available: true,
              };
          const turnId = `turn_${nextMsg}`;
          const envelope = (seq, kind, status, payload) => ({
            turn_id: turnId,
            seq,
            ts: Date.now() / 1000,
            kind,
            status,
            payload,
            protocol: 'maya.turn.v1',
          });
          const splitAt = Math.max(1, Math.floor(replyText.length / 2));
          const chunks = [replyText.slice(0, splitAt), replyText.slice(splitAt)];
          let bytes = chunks.map((text, seq) => streamFrame(
            'token', envelope(seq, 'maya.turn.token', 'progress', { text }),
          )).join('');

          if (!server.__streamCutoff) {
            if (server.__streamError401 || server.__streamErrorEvent) {
              const statusCode = server.__streamError401 ? 401 : 500;
              bytes += streamFrame('error', envelope(
                chunks.length, 'maya.turn.error', 'error',
                { detail: 'boom', status_code: statusCode },
              ));
            } else {
              bytes += streamFrame('final', envelope(
                chunks.length, 'maya.turn.final', 'ok', reply,
              ));
            }
          }

          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (server.__postFinalDelayMs) {
            // Maya does post-final work (history, persistence) before closing
            // the stream. A client that aborts on receipt of `final` shows up
            // here as a close before writableEnded.
            res.on('close', () => {
              if (!res.writableEnded) server.__clientGoneEarly = true;
            });
            res.write(bytes);
            setTimeout(() => res.end(), server.__postFinalDelayMs).unref();
            return undefined;
          }
          if (server.__streamSplitFrames) return writeSplit(res, bytes);
          return res.end(bytes);
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
        // __ndaVersion models the real server (beta.py): any other version is a
        // 409 `version_mismatch` that names the version in force.
        if (server.__ndaVersion && parsed?.version !== server.__ndaVersion) {
          return json(409, { detail: { code: 'version_mismatch', current_version: server.__ndaVersion } });
        }
        return json(200, { accepted: true, version: parsed?.version ?? null });
      }

      // The token-verification read the static-token paste flow uses
      // (auth.py:673 — UserResponse carries default_team_id). Knobs:
      // __meFail → 500; __meTeamId overrides the returned workspace.
      if (req.url === '/auth/me' && req.method === 'GET') {
        if (!req.headers.authorization) return json(401, { detail: 'unauthorized' });
        if (server.__meFail) return json(500, { detail: 'me failed' });
        return json(200, {
          id: 'user_me', email: 'me@compose.invalid', tenant_id: 'tenant_me',
          default_team_id: server.__meTeamId ?? teamId,
        });
      }

      return json(404, { detail: 'no route' });
    });
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, seen };
}
