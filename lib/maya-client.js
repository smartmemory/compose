/**
 * maya-client.js — COMP-FOH FOH-6 S1
 *
 * HTTP client for Maya's chat surface (`/Users/ruze/reg/my/SmartMemory/maya/`,
 * read-only upstream — POST /api/chat, routes.py:5354; GET /health,
 * maya_server.py:46). Speaks HTTP and nothing else; context composition and
 * write-back belong to the relay.
 *
 * Failure conventions, per design-foh-6.md §2 and the smartmemory-client
 * doctrine:
 *   - 401 → ONE retry with the SAME token (transient), then MayaAuthError.
 *     Never re-provision here: the identity owns the standing conversation,
 *     and a 401 does not prove expiry.
 *   - a 2xx we cannot trust (non-JSON body, success !== true, missing
 *     message_id) is a failure with kind 'malformed-response', not a success —
 *     message_id is the write-back idempotency key, so a reply without one
 *     cannot be treated as a completed turn.
 *   - network failure / deadline → status 0.
 *   - health() never throws.
 *
 * The chat deadline defaults generously (her turn does LLM work upstream);
 * the live VERIFY used 120s.
 */

/** Non-auth failure of a Maya call. */
export class MayaHttpError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = 'MayaHttpError';
    this.status = status;
    this.kind = kind;
  }
}

/** 401 after the single same-token retry. The relay maps this to the auth
 *  funnel with its explicit continuity-costing actions. */
export class MayaAuthError extends MayaHttpError {
  constructor(message) {
    super(message, 401);
    this.name = 'MayaAuthError';
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {() => (string|Promise<string>)} opts.getToken  read at CALL time
 * @param {number} [opts.timeoutMs]      health deadline (default 3000)
 * @param {number} [opts.chatTimeoutMs]  chat deadline (default 120000)
 */
export function createMayaClient({ baseUrl, getToken, timeoutMs = 3000, chatTimeoutMs = 120000 }) {
  async function fetchJson(path, { init, deadline }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    let res;
    let text;
    try {
      res = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
      text = await res.text();
    } catch (err) {
      throw new MayaHttpError(
        `maya: ${path} request failed: ${err?.message ?? 'unknown error'}`, 0,
      );
    } finally {
      clearTimeout(timer);
    }
    let parsed = null;
    let parseFailed = false;
    try { parsed = JSON.parse(text); } catch { parseFailed = true; }
    return { status: res.status, ok: res.ok, body: parsed, parseFailed };
  }

  /** Liveness only. Unauthenticated, never throws. */
  async function health() {
    try {
      const res = await fetchJson('/health', { deadline: timeoutMs });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    }
  }

  /**
   * One conversational turn. `channelContext` travels verbatim as the wire's
   * `channel_context: [{author, text}]` and is OMITTED (not sent empty) when
   * absent — an empty array still exercises Maya's context-injection path.
   *
   * @param {{message: string, channelContext?: Array<{author: string, text: string}>,
   *          surface?: string, timezone?: string}} args
   * @returns {Promise<{success: true, response: string, message_id: string,
   *                    memory_available?: boolean}>}
   */
  async function chat({ message, channelContext, surface, timezone = 'UTC' }) {
    const body = { message, timezone };
    if (Array.isArray(channelContext) && channelContext.length) {
      body.channel_context = channelContext;
    }
    if (surface !== undefined) body.surface = surface;

    // Captured ONCE per chat() call: "one same-token retry" is a literal
    // contract — reading the token again for the retry could pick up a
    // concurrent paste/re-provision and silently move the retry onto a
    // different identity and conversation (Codex r1 P2).
    const token = await getToken();
    const send = () => fetchJson('/api/chat', {
      deadline: chatTimeoutMs,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
    });

    let res = await send();
    if (res.status === 401) res = await send(); // one same-token retry
    if (res.status === 401) {
      throw new MayaAuthError('maya: authentication rejected after one same-token retry');
    }
    if (!res.ok) {
      throw new MayaHttpError(`maya: chat failed (HTTP ${res.status})`, res.status);
    }
    if (res.parseFailed) {
      throw new MayaHttpError(
        `maya: chat returned a 2xx (HTTP ${res.status}) with a non-JSON body`,
        res.status, 'malformed-response',
      );
    }
    const reply = res.body;
    if (reply?.success !== true || typeof reply?.response !== 'string'
        || typeof reply?.message_id !== 'string' || !reply.message_id) {
      throw new MayaHttpError(
        'maya: chat returned a 2xx body this relay cannot trust '
        + '(needs success:true, a response string, and a message_id)',
        res.status, 'malformed-response',
      );
    }
    return reply;
  }

  return { health, chat };
}
