import { execFileSync } from 'child_process';
import { TrackerConfigError } from './provider.js';

function resolveToken(auth = {}, noGhFallback = false) {
  if (auth.token) return auth.token;
  if (auth.tokenEnv && process.env[auth.tokenEnv]) return process.env[auth.tokenEnv];
  if (noGhFallback) return null;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

export class GitHubApi {
  constructor(cfg, transport = null) {
    this.repo = cfg.repo;
    if (!this.repo || !/^[^/]+\/[^/]+$/.test(this.repo)) {
      throw new TrackerConfigError(`tracker.github.repo must be "owner/name" (got "${this.repo}")`);
    }
    this.token = resolveToken(cfg.auth, cfg.auth?._noGhFallback || cfg._noGhFallback);
    if (!this.token) {
      throw new TrackerConfigError('no GitHub token: set tracker.github.auth.tokenEnv or run `gh auth login`',
        { missing: 'token' });
    }
    this.transport = transport;
  }
  async _req(method, path, body) {
    if (this.transport) return this.transport.request(method, path, body);
    const res = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const remainingHdr = res.headers.get('x-ratelimit-remaining');
    const resetHdr = res.headers.get('x-ratelimit-reset');
    if (res.status === 403 && remainingHdr !== null && Number(remainingHdr) === 0) {
      const e = new Error('rate limited');
      e.rateLimit = { resetMs: Number(resetHdr) * 1000 - Date.now() };
      throw e;
    }
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  }
  async createIssue({ title, body, labels }) {
    const r = await this._req('POST', `/repos/${this.repo}/issues`, { title, body, labels });
    return r.body;
  }
  async getIssue(number) { return (await this._req('GET', `/repos/${this.repo}/issues/${number}`)).body; }
  async updateIssue(number, patch) { return (await this._req('PATCH', `/repos/${this.repo}/issues/${number}`, patch)).body; }
  async searchFeatureIssues() {
    return (await this._req('GET', `/search/issues?q=repo:${this.repo}+label:compose-feature`)).body.items ?? [];
  }
  async addIssueComment(number, body) {
    return (await this._req('POST', `/repos/${this.repo}/issues/${number}/comments`, { body })).body;
  }
  async listIssueComments(number) {
    return (await this._req('GET', `/repos/${this.repo}/issues/${number}/comments`)).body ?? [];
  }
  async graphql(query, variables) {
    return (await this._req('POST', '/graphql', { query, variables })).body?.data;
  }
}
