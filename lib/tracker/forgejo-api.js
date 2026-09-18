import { TrackerConfigError } from './provider.js';

export const FORGEJO_BASE_URL = 'https://git.smartmemory.ai';

function resolveToken(auth = {}) {
  if (auth.token) return auth.token;
  const tokenEnv = auth.tokenEnv ?? 'COMPOSE_FORGEJO_TOKEN';
  return process.env[tokenEnv] || null;
}

function pinnedBaseUrl(configuredUrl = FORGEJO_BASE_URL) {
  let parsed;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new TrackerConfigError(`tracker.forgejo.baseUrl must be ${FORGEJO_BASE_URL}`);
  }

  const pinned = new URL(FORGEJO_BASE_URL);
  if (
    parsed.origin !== pinned.origin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !['', '/'].includes(parsed.pathname)
  ) {
    throw new TrackerConfigError(
      `tracker.forgejo.baseUrl origin must be ${pinned.origin} (got "${configuredUrl}")`,
      { expectedOrigin: pinned.origin, actualOrigin: parsed.origin },
    );
  }

  return pinned;
}

export class ForgejoApi {
  constructor(cfg, transport = null) {
    this.repo = cfg.repo;
    if (!this.repo || !/^[^\s/#]+\/[^\s/#]+$/.test(this.repo)) {
      throw new TrackerConfigError(`tracker.forgejo.repo must be "owner/name" (got "${this.repo}")`);
    }

    this.baseUrl = pinnedBaseUrl(cfg.baseUrl);
    this.token = resolveToken(cfg.auth);
    if (!this.token) {
      throw new TrackerConfigError(
        'no Forgejo token: set COMPOSE_FORGEJO_TOKEN or tracker.forgejo.auth.tokenEnv',
        { missing: 'token' },
      );
    }
    this.transport = transport;
  }

  async _req(method, path, body) {
    const url = new URL(`/api/v1${path}`, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new TrackerConfigError(
        `Forgejo request origin must remain pinned to ${this.baseUrl.origin}`,
        { expectedOrigin: this.baseUrl.origin, actualOrigin: url.origin },
      );
    }

    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    if (this.transport) {
      return this.transport.request(method, url.toString(), body, {
        headers,
        redirect: 'manual',
      });
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    return {
      status: res.status,
      body: await res.json().catch(() => ({})),
      headers: res.headers,
    };
  }

  async getIssueResult(number) {
    return this._req('GET', `/repos/${this.repo}/issues/${number}`);
  }

  async updateStateResult(number, { state }) {
    return this._req('PATCH', `/repos/${this.repo}/issues/${number}`, { state });
  }

  async addLabelResult(number, labelName) {
    return this._req('POST', `/repos/${this.repo}/issues/${number}/labels`, {
      labels: [labelName],
    });
  }

  async listIssueComments(number) {
    return this._req('GET', `/repos/${this.repo}/issues/${number}/comments`);
  }

  async addIssueComment(number, body) {
    return this._req('POST', `/repos/${this.repo}/issues/${number}/comments`, { body });
  }
}
