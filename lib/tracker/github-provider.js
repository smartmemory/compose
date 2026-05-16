import { mkdirSync } from 'fs';
import { join } from 'path';
import { TrackerProvider, CAP } from './provider.js';
import { GitHubApi } from './github-api.js';
import { OpLog, Cache, Reconciler } from './sync-engine.js';

const META_RE = /<!--compose-feature\n([\s\S]*?)\n-->/;
function encodeBody(obj) {
  return `${obj.description ?? ''}\n\n<!--compose-feature\n${JSON.stringify(obj, null, 2)}\n-->`;
}
function decodeBody(body) {
  const m = META_RE.exec(body ?? '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export class GitHubProvider extends TrackerProvider {
  name() { return 'github'; }
  capabilities() { return new Set([CAP.FEATURES, CAP.EVENTS, CAP.ROADMAP, CAP.CHANGELOG]); }

  async init(cwd, cfg) {
    this.cwd = cwd;
    this.cfg = cfg;
    const dataDir = join(cwd, '.compose/data');
    mkdirSync(dataDir, { recursive: true });
    this.api = new GitHubApi(cfg, cfg._transport ?? null);
    this.log = new OpLog(dataDir);
    this.cache = new Cache(dataDir);
    this.idmap = new Cache(join(dataDir, 'idmap'));
    this._locks = new Map();
    this.reconciler = new Reconciler({
      log: this.log,
      cache: this.cache,
      dir: dataDir,
      apply: (op) => this._applyOp(op),
    });
    return this;
  }

  // Per-code serialisation: each code gets its own promise chain so concurrent
  // creates for different codes run in parallel while the same code is FIFO.
  _lock(code, fn) {
    const prev = this._locks.get(code) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this._locks.set(code, next.catch(() => {}));
    return next;
  }

  async getFeature(code) {
    return this.cache.get(code);
  }

  async listFeatures() {
    const store = await this.cache.all();
    return Object.values(store)
      .map(e => e.value)
      .sort((a, b) =>
        (a.position ?? 0) - (b.position ?? 0) ||
        String(a.code).localeCompare(String(b.code))
      );
  }

  async createFeature(code, obj) {
    return this._lock(code, async () => {
      // Idempotent: if already in cache, return it.
      const existing = await this.cache.get(code);
      if (existing) return existing;
      await this.cache.put(code, obj, { version: null, pending: true });
      await this.cache.markPending(code);
      await this.log.append({ op: 'createFeature', code, payload: obj, baseVersion: null });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }

  async putFeature(code, obj) {
    return this._lock(code, async () => {
      const cur = await this.cache.get(code);
      if (cur && obj.status && obj.status !== cur.status) {
        throw new Error(`putFeature: status delta not allowed; use setStatus`);
      }
      await this.cache.put(code, obj, { pending: true });
      await this.cache.markPending(code);
      await this.log.append({
        op: 'putFeature',
        code,
        payload: obj,
        baseVersion: await this.cache.version(code),
      });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }

  // Raw write that allows status change (used by setStatus / policy layers).
  async persistFeatureRaw(code, obj) {
    return this._lock(code, async () => {
      await this.cache.put(code, obj, { pending: true });
      await this.cache.markPending(code);
      await this.log.append({
        op: 'persistFeatureRaw',
        code,
        payload: obj,
        baseVersion: await this.cache.version(code),
      });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }

  // T15 will implement events via structured compose-event comments.
  async readEvents(_code) { return []; }

  // Resolve the idmap entry for a code. If missing (e.g. createFeature op was
  // quarantined, or idmap was wiped), recover by searching existing issues.
  async _resolveIssueId(code) {
    let id = await this.idmap.get(code);
    if (id?.issueNumber) return id;

    // Recovery: search all compose-feature issues and find the one for this code.
    const issues = await this.api.searchFeatureIssues();
    const match = issues.find(issue => {
      const decoded = decodeBody(issue.body);
      if (decoded?.code === code) return true;
      // Fallback: title prefix match for issues written before decodeBody was available.
      return issue.title?.startsWith(`[${code}] `);
    });

    if (match) {
      const entry = { issueNumber: match.number, nodeId: match.node_id };
      await this.idmap.put(code, entry, { version: match.updated_at });
      return entry;
    }

    throw new Error(
      `github _applyOp: no issue mapping for "${code}" (create not yet reconciled and no matching issue found)`
    );
  }

  async _applyOp(op) {
    if (op.op === 'createFeature') {
      const issue = await this.api.createIssue({
        title: `[${op.code}] ${op.payload.description ?? ''}`,
        body: encodeBody(op.payload),
        labels: ['compose-feature', `status:${op.payload.status}`],
      });
      await this.idmap.put(
        op.code,
        { issueNumber: issue.number, nodeId: issue.node_id },
        { version: issue.updated_at },
      );
      return { version: issue.updated_at };
    }

    if (op.op === 'putFeature' || op.op === 'persistFeatureRaw' || op.op === 'setStatus') {
      const id = await this._resolveIssueId(op.code);
      const issue = await this.api.getIssue(id.issueNumber);
      if (op.baseVersion && issue.updated_at !== op.baseVersion) {
        const e = new Error('stale');
        e.casMismatch = { remoteVersion: issue.updated_at };
        throw e;
      }
      const next =
        op.op === 'setStatus'
          ? { ...decodeBody(issue.body), status: op.payload.to }
          : op.payload;
      const updated = await this.api.updateIssue(id.issueNumber, {
        body: encodeBody(next),
        labels: ['compose-feature', `status:${next.status}`],
        state: ['COMPLETE', 'KILLED', 'SUPERSEDED'].includes(next.status) ? 'closed' : 'open',
      });
      return { version: updated.updated_at };
    }

    throw new Error(`_applyOp: unknown op ${op.op}`);
  }
}
