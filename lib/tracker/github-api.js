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
    const r = await this._req('POST', '/graphql', { query, variables });
    return { data: r.body?.data, errors: r.body?.errors };
  }

  /**
   * GET /repos/:repo/contents/:path?ref=:ref
   * Returns { text, sha } where text is the decoded file content.
   * If the file does not exist (404), returns { text: '', sha: null }.
   */
  async getContents(path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const r = await this._req('GET', `/repos/${this.repo}/contents/${path}${query}`);
    if (r.status === 404) return { text: '', sha: null };
    if (r.status !== 200) {
      throw new Error(
        `getContents ${path}@${ref}: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`
      );
    }
    const content = r.body?.content ?? '';
    // GitHub returns base64 with embedded newlines — strip them before decoding.
    const text = Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf-8');
    const sha = r.body?.sha ?? null;
    return { text, sha };
  }

  /**
   * PUT /repos/:repo/contents/:path
   * Creates or updates a file.
   * @param {string} path - File path in the repo
   * @param {string} text - New file content (UTF-8)
   * @param {{ sha: string|null, branch: string, message: string }} opts
   *   sha: current blob SHA (omit or pass null to create a new file)
   *   branch: target branch
   *   message: commit message
   * On 409 (SHA conflict / optimistic-lock failure) throws with e.shaConflict = true.
   */
  async putContents(path, text, { sha, branch, message }) {
    const body = {
      message,
      content: Buffer.from(text, 'utf-8').toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;
    const r = await this._req('PUT', `/repos/${this.repo}/contents/${path}`, body);
    if (r.status === 409) {
      const e = new Error(`putContents: SHA conflict for ${path}`);
      e.shaConflict = true;
      throw e;
    }
    return r.body;
  }
}
