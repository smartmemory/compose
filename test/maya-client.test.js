/**
 * Contract tests for lib/maya-client.js (FOH-6 S1) against the maya-stub.
 *
 * The load-bearing behaviours, per design-foh-6.md §2:
 *   - Authorization: Bearer <token> on every chat call, token read at call time
 *   - 401 → ONE same-token retry, then MayaAuthError (never re-provision here)
 *   - channel_context passed through verbatim
 *   - per-call deadline (chat does LLM work upstream; a hung Maya must not pin
 *     the relay)
 *   - a 2xx we cannot trust (non-JSON, success:false, missing message_id) is a
 *     failure, not a success
 *   - health() never throws
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createMayaClient, MayaHttpError, MayaAuthError } =
  await import(`${ROOT}/lib/maya-client.js`);
const { makeMayaServer, servers } = await import(`${ROOT}/test/helpers/maya-stub.js`);

describe('maya-client', () => {
  after(() => servers.forEach((s) => s.close()));

  function client(baseUrl, { token = 'tok-1', ...opts } = {}) {
    return createMayaClient({ baseUrl, getToken: () => token, ...opts });
  }

  test('health: ok when up, {ok:false} when down, never throws', async () => {
    const { server, baseUrl } = await makeMayaServer();
    assert.deepEqual(await client(baseUrl).health(), { ok: true, status: 200 });
    server.__healthDown = true;
    assert.deepEqual(await client(baseUrl).health(), { ok: false, status: 503 });
    const dead = client('http://127.0.0.1:1');
    assert.equal((await dead.health()).ok, false);
  });

  test('chat happy path: bearer token, body shape, ChatResponse surfaced', async () => {
    const { baseUrl, seen } = await makeMayaServer();
    const res = await client(baseUrl).chat({
      message: 'what does IDEA-42 propose?',
      channelContext: [{ author: 'compose:idea IDEA-42', text: 'Redis streams' }],
    });
    assert.equal(res.success, true);
    assert.equal(res.response, 'echo:what does IDEA-42 propose?');
    assert.match(res.message_id, /^msg_/);
    assert.equal(res.memory_available, true);

    const call = seen.find((s) => s.path === '/api/chat');
    assert.equal(call.authorization, 'Bearer tok-1');
    assert.equal(call.body.message, 'what does IDEA-42 propose?');
    assert.equal(typeof call.body.timezone, 'string');
    // channel_context passes through VERBATIM — the wire name, not camelCase.
    assert.deepEqual(call.body.channel_context, [
      { author: 'compose:idea IDEA-42', text: 'Redis streams' },
    ]);
    assert.ok(!('channelContext' in call.body));
  });

  test('chat omits channel_context entirely when none composed', async () => {
    const { baseUrl, seen } = await makeMayaServer();
    await client(baseUrl).chat({ message: 'hi' });
    const call = seen.find((s) => s.path === '/api/chat');
    assert.ok(!('channel_context' in call.body));
  });

  test('401 once → single same-token retry succeeds', async () => {
    const { server, baseUrl, seen } = await makeMayaServer();
    server.__401Once = true;
    const res = await client(baseUrl).chat({ message: 'hi' });
    assert.equal(res.success, true);
    const calls = seen.filter((s) => s.path === '/api/chat');
    assert.equal(calls.length, 2);
    // SAME token both times — retry must not mint or refresh anything.
    assert.equal(calls[0].authorization, calls[1].authorization);
  });

  test('the 401 retry reuses the token CAPTURED at chat() start, even if getToken moves', async () => {
    const { server, baseUrl, seen } = await makeMayaServer();
    server.__401Once = true;
    // A concurrent paste/re-provision changes what getToken returns mid-turn;
    // the retry must NOT pick it up — that would move the retry onto a
    // different identity and conversation.
    let calls = 0;
    const c = createMayaClient({ baseUrl, getToken: () => (calls++ === 0 ? 'tok-first' : 'tok-second') });
    await c.chat({ message: 'hi' });
    const attempts = seen.filter((s) => s.path === '/api/chat');
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((a) => a.authorization === 'Bearer tok-first'));
  });

  test('401 always → MayaAuthError after exactly two attempts', async () => {
    const { server, baseUrl, seen } = await makeMayaServer();
    server.__401Always = true;
    await assert.rejects(
      client(baseUrl).chat({ message: 'hi' }),
      (err) => err instanceof MayaAuthError && err.status === 401,
    );
    assert.equal(seen.filter((s) => s.path === '/api/chat').length, 2);
  });

  test('deadline: a hung chat aborts with a status-0 MayaHttpError', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__slowMs = 5000;
    await assert.rejects(
      client(baseUrl, { chatTimeoutMs: 100 }).chat({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && !(err instanceof MayaAuthError) && err.status === 0,
    );
  });

  test('upstream 5xx → MayaHttpError carrying the status', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__chatFail = true;
    await assert.rejects(
      client(baseUrl).chat({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.status === 500,
    );
  });

  test('422 (channel_context rejected) → MayaHttpError 422, not auth', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__rejectChannelContext = true;
    await assert.rejects(
      client(baseUrl).chat({ message: 'hi', channelContext: [{ author: 'a', text: 't' }] }),
      (err) => err instanceof MayaHttpError && err.status === 422 && !(err instanceof MayaAuthError),
    );
  });

  test('2xx with a non-JSON body → malformed-response failure', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__htmlBody = true;
    await assert.rejects(
      client(baseUrl).chat({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.kind === 'malformed-response',
    );
  });

  test('2xx with success:false → failure, never surfaced as a reply', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__successFalse = true;
    await assert.rejects(
      client(baseUrl).chat({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.kind === 'malformed-response',
    );
  });

  test('unreachable host → status-0 MayaHttpError', async () => {
    await assert.rejects(
      client('http://127.0.0.1:1').chat({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.status === 0,
    );
  });

  test('chatStream: split frames deliver tokens in order and resolve the validated final', async () => {
    const { server, baseUrl, seen } = await makeMayaServer();
    server.__streamSplitFrames = true;
    const tokens = [];
    const res = await client(baseUrl).chatStream({
      message: 'stream this',
      channelContext: [{ author: 'compose:idea IDEA-42', text: 'Redis streams' }],
      onToken: (text) => tokens.push(text),
    });
    assert.equal(res.success, true);
    assert.equal(res.response, 'echo:stream this');
    assert.match(res.message_id, /^msg_/);
    assert.ok(tokens.length >= 2);
    assert.equal(tokens.join(''), res.response);

    const call = seen.find((s) => s.path === '/api/chat/stream');
    assert.equal(call.authorization, 'Bearer tok-1');
    assert.equal(call.accept, 'text/event-stream');
    assert.deepEqual(call.body.channel_context, [
      { author: 'compose:idea IDEA-42', text: 'Redis streams' },
    ]);
  });

  test('chatStream: resolves on final without hanging up on Maya\'s post-final work', async () => {
    // Maya persists the turn AFTER emitting final; the client must return the
    // reply immediately but drain to EOF instead of aborting (Codex r1 P1).
    const { server, baseUrl } = await makeMayaServer();
    server.__postFinalDelayMs = 150;
    const started = Date.now();
    const res = await client(baseUrl).chatStream({ message: 'hi' });
    assert.equal(res.success, true);
    assert.ok(Date.now() - started < 150, 'final must resolve before the upstream closes');
    // Give the detached drain time to reach the stub's delayed close.
    await new Promise((r) => setTimeout(r, 250));
    assert.notEqual(server.__clientGoneEarly, true,
      'client must not abort the upstream before its post-final close');
  });

  test('chatStream: HTTP 401 once retries exactly once with the captured token', async () => {
    const { server, baseUrl, seen } = await makeMayaServer();
    server.__401Once = true;
    let reads = 0;
    const c = createMayaClient({
      baseUrl,
      getToken: () => (reads++ === 0 ? 'tok-first' : 'tok-second'),
    });
    const res = await c.chatStream({ message: 'hi' });
    assert.equal(res.success, true);
    const calls = seen.filter((s) => s.path === '/api/chat/stream');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.authorization === 'Bearer tok-first'));
  });

  test('chatStream: mid-stream 401 event is MayaAuthError and is never retried', async () => {
    const { server, baseUrl, seen } = await makeMayaServer();
    server.__streamError401 = true;
    await assert.rejects(
      client(baseUrl).chatStream({ message: 'hi' }),
      (err) => err instanceof MayaAuthError && err.status === 401,
    );
    assert.equal(seen.filter((s) => s.path === '/api/chat/stream').length, 1);
  });

  test('chatStream: upstream error event becomes MayaHttpError with its status', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__streamErrorEvent = true;
    await assert.rejects(
      client(baseUrl).chatStream({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && !(err instanceof MayaAuthError)
        && err.status === 500 && err.message === 'boom',
    );
  });

  test('chatStream: cutoff without final is a malformed response', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__streamCutoff = true;
    await assert.rejects(
      client(baseUrl).chatStream({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.kind === 'malformed-response',
    );
  });

  test('chatStream: invalid final payload is a malformed response', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__successFalse = true;
    await assert.rejects(
      client(baseUrl).chatStream({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.kind === 'malformed-response',
    );
  });

  test('chatStream: non-SSE 2xx response is malformed', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__streamNonSse = true;
    await assert.rejects(
      client(baseUrl).chatStream({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.kind === 'malformed-response',
    );
  });

  test('chatStream: one overall deadline aborts before the stream opens', async () => {
    const { server, baseUrl } = await makeMayaServer();
    server.__slowMs = 200;
    await assert.rejects(
      client(baseUrl, { chatTimeoutMs: 25 }).chatStream({ message: 'hi' }),
      (err) => err instanceof MayaHttpError && err.status === 0,
    );
  });
});
