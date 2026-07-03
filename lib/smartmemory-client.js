/**
 * smartmemory-client.js — COMP-SMARTMEMORY-INGEST S02
 *
 * Raw HTTP client for the SmartMemory ingest/search wire contract. Global
 * `fetch` + `AbortController` timeout. No SDK, no new dependency.
 */

/**
 * Thrown on non-2xx from ingest/search, OR on a 2xx whose body doesn't match
 * the expected shape (non-JSON, or missing the field the caller depends on —
 * `status` for ingest, `results` for search). The latter case sets
 * `kind: 'malformed-response'` so callers can tell "the service said no" from
 * "the service said something we can't trust" if they want to, while both
 * still surface as one failure type upstream (sync: `failed`; emitter:
 * counts toward the circuit breaker).
 */
export class SmartmemoryHttpError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = 'SmartmemoryHttpError';
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Build a client bound to a resolved config. The API key is read from
 * process.env[cfg.apiKeyEnv] at call time (missing ⇒ treated as unreachable).
 * @param {{ baseUrl: string, apiKeyEnv?: string, timeoutMs?: number }} cfg
 * @returns {{ health(): Promise<{ok:boolean,status?:number}>, ingest(content:string,ctx:object): Promise<{status:string,unchanged:boolean,raw:object}>, search(query:string,opts?:object): Promise<object> }}
 */
export function createSmartmemoryClient(cfg) {
  const baseUrl = cfg.baseUrl;
  const timeoutMs = cfg.timeoutMs ?? 3000;

  async function withTimeout(fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  function authHeader() {
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    if (!key) {
      throw new SmartmemoryHttpError('smartmemory: missing api key', 0);
    }
    return `Bearer ${key}`;
  }

  async function health() {
    try {
      const res = await withTimeout((signal) => fetch(`${baseUrl}/health`, { signal }));
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    }
  }

  async function ingest(content, ctx) {
    const auth = authHeader(); // throws BEFORE any fetch when key is missing
    let res;
    try {
      res = await withTimeout((signal) => fetch(`${baseUrl}/memory/ingest?mode=sync`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth,
        },
        body: JSON.stringify({ content, context: ctx }),
      }));
    } catch (err) {
      throw new SmartmemoryHttpError(`smartmemory: ingest request failed: ${err.message}`, 0);
    }
    if (!res.ok) {
      throw new SmartmemoryHttpError(`smartmemory: ingest failed (HTTP ${res.status})`, res.status);
    }
    let raw;
    try {
      raw = await res.json();
    } catch {
      throw new SmartmemoryHttpError(
        `smartmemory: ingest returned a 2xx (HTTP ${res.status}) with a non-JSON body`,
        res.status, 'malformed-response',
      );
    }
    if (typeof raw?.status !== 'string') {
      throw new SmartmemoryHttpError(
        `smartmemory: ingest returned a 2xx (HTTP ${res.status}) body missing a "status" field`,
        res.status, 'malformed-response',
      );
    }
    const unchanged = raw.status === 'unchanged' || raw.unchanged === true;
    return { status: raw.status, unchanged, raw };
  }

  async function search(query, opts = {}) {
    const auth = authHeader();
    let res;
    try {
      res = await withTimeout((signal) => fetch(`${baseUrl}/memory/search`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth,
        },
        body: JSON.stringify({ query, ...opts }),
      }));
    } catch (err) {
      throw new SmartmemoryHttpError(`smartmemory: search request failed: ${err.message}`, 0);
    }
    if (!res.ok) {
      throw new SmartmemoryHttpError(`smartmemory: search failed (HTTP ${res.status})`, res.status);
    }
    let raw;
    try {
      raw = await res.json();
    } catch {
      throw new SmartmemoryHttpError(
        `smartmemory: search returned a 2xx (HTTP ${res.status}) with a non-JSON body`,
        res.status, 'malformed-response',
      );
    }
    if (!Array.isArray(raw?.results)) {
      throw new SmartmemoryHttpError(
        `smartmemory: search returned a 2xx (HTTP ${res.status}) body missing a "results" array`,
        res.status, 'malformed-response',
      );
    }
    return raw;
  }

  return { health, ingest, search };
}
