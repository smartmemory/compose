import { mkdirSync } from 'fs';
import { join } from 'path';
import { TrackerProvider, TrackerConfigError, CAP } from './provider.js';
import { GitHubApi } from './github-api.js';
import { OpLog, Cache, ConflictLedger, Reconciler } from './sync-engine.js';
import { generateRoadmapFromBase } from '../roadmap-gen.js';
import { spliceChangelog } from '../changelog-writer.js';

const META_RE = /<!--compose-feature\n([\s\S]*?)\n-->/;
function encodeBody(obj) {
  return `${obj.description ?? ''}\n\n<!--compose-feature\n${JSON.stringify(obj, null, 2)}\n-->`;
}
function decodeBody(body) {
  const m = META_RE.exec(body ?? '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const TERMINAL_STATUSES = new Set(['COMPLETE', 'KILLED', 'SUPERSEDED']);

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
    this._dataDir = dataDir;
    this._locks = new Map();
    this._projectMeta = null; // memoized once per process: { projectId, fieldId, optionsByName }
    this.reconciler = new Reconciler({
      log: this.log,
      cache: this.cache,
      dir: dataDir,
      apply: (op) => this._applyOp(op),
    });

    // Probe 1: verify token can reach the repo (catches missing `repo` scope or wrong repo).
    const repoResp = await this.api.getRepo();
    if (repoResp.status !== 200) {
      throw new TrackerConfigError(
        `GitHub repo "${cfg.repo}" not accessible — token missing \`repo\` scope or repo not found`,
        { missingScope: 'repo', status: repoResp.status },
      );
    }

    // Probe 2: if projectNumber is configured, verify Projects v2 access.
    if (cfg.projectNumber) {
      const accessErr = await this._probeProjectsAccess();
      if (accessErr) {
        throw new TrackerConfigError(
          `GitHub Projects v2 (project #${cfg.projectNumber}) not accessible — token missing \`project\` scope`,
          { missingScope: 'project', projectNumber: cfg.projectNumber },
        );
      }
    }

    return this;
  }

  // Probe Projects v2 access during init. Returns a truthy error string when access is denied,
  // null when access is fine. This is separate from _resolveProjectMeta so it never caches.
  async _probeProjectsAccess() {
    const projectNumber = this.cfg.projectNumber;
    const owner = this.cfg.repo.split('/')[0];
    const query = `
      query($owner: String!, $number: Int!) {
        ${owner}: repositoryOwner(login: $owner) {
          projectV2(number: $number) { id }
        }
      }
    `;
    const { errors } = await this.api.graphql(query, { owner, number: projectNumber });
    if (errors?.length) {
      // Distinguish actual access errors from "project not found" — both cause a probe failure.
      return errors[0]?.message ?? 'access denied';
    }
    return null;
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

  async setStatus(code, to, meta = {}) {
    return this._lock(code, async () => {
      const cur = await this.cache.get(code);
      if (!cur) throw new Error(`setStatus: feature "${code}" not found`);
      const event = {
        type: 'status',
        from: cur.status,
        to,
        ts: Date.now(),
        by: meta.by ?? meta.reason ?? 'agent',
      };
      await this.cache.put(code, { ...cur, status: to }, { pending: true });
      await this.cache.markPending(code);
      await this.log.append({
        op: 'setStatus',
        code,
        payload: { to, event },
        baseVersion: await this.cache.version(code),
      });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }

  async recordCompletion(code, rec) {
    // commit_sha is required for replay-safe dedup
    if (!rec.commit_sha) throw new Error('recordCompletion: commit_sha is required');
    return this._lock(code, async () => {
      const cur = await this.cache.get(code);
      if (!cur) throw new Error(`recordCompletion: feature "${code}" not found`);
      const completions = cur.completions ?? [];
      // Dedup by commit_sha in cache path (per-code lock makes concurrent calls sequential)
      if (completions.some(c => c.commit_sha === rec.commit_sha)) {
        return this.cache.get(code);
      }
      const completion = { ...rec };
      const next = { ...cur, completions: [...completions, completion] };
      await this.cache.put(code, next, { pending: true });
      await this.cache.markPending(code);
      await this.log.append({
        op: 'recordCompletion',
        code,
        payload: { completion },
        baseVersion: await this.cache.version(code),
      });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }

  async appendEvent(code, event) {
    const id = await this._resolveIssueId(code);
    await this._postEvent(id.issueNumber, event);

    // Mirror status changes to Projects v2 (best-effort, non-fatal).
    // The set_feature_status writer emits { tool: 'set_feature_status', from, to }.
    const newStatus = event.to ?? (event.type === 'status' ? event.to : undefined);
    if ((event.tool === 'set_feature_status' || event.type === 'status') && newStatus) {
      try {
        const issue = await this.api.getIssue(id.issueNumber);
        await this._mirrorProjectV2Status(issue, newStatus);
      } catch (err) {
        // Non-fatal: Projects v2 is a mirror only.
        console.warn('[tracker] appendEvent: Projects v2 mirror error (non-fatal):', err?.message);
      }
    }
  }

  async _postEvent(issueNumber, event) {
    await this.api.addIssueComment(issueNumber, `<!--compose-event ${JSON.stringify(event)}-->`);
  }

  async readEvents(code) {
    let id;
    try {
      id = await this._resolveIssueId(code);
    } catch {
      return [];
    }
    const EVENT_RE = /^<!--compose-event ([\s\S]*?)-->$/;
    const comments = await this.api.listIssueComments(id.issueNumber);
    const events = [];
    for (const comment of comments) {
      const m = EVENT_RE.exec((comment.body ?? '').trim());
      if (!m) continue;
      try {
        events.push(JSON.parse(m[1]));
      } catch {
        // skip malformed
      }
    }
    return events;
  }

  async health() {
    const pendingOps = (await this.log.pending()).length;
    const ledger = new ConflictLedger(this._dataDir);
    const conflicts = (await ledger.all()).length;

    // mixedSources: CAP entities NOT supported by this provider that the factory routes locally.
    // GitHubProvider supports FEATURES, EVENTS, ROADMAP, CHANGELOG.
    // JOURNAL and VISION always fall back to local.
    const mixedSources = [CAP.JOURNAL, CAP.VISION]
      .filter(cap => !this.capabilities().has(cap))
      .map(cap => cap.toLowerCase());

    return {
      ok: true,
      provider: 'github',
      canonical: 'github',
      pendingOps,
      conflicts,
      mixedSources,
    };
  }

  async sync() {
    const before = (await this.log.pending()).length;
    const quarantinedBefore = (await this.log.quarantined()).length;
    await this.reconciler.flush();
    const after = (await this.log.pending()).length;
    const quarantinedAfter = (await this.log.quarantined()).length;
    const newlyQuarantined = quarantinedAfter - quarantinedBefore;
    const drained = (before - after) - newlyQuarantined; // only truly-resolved ops
    return { drained, quarantined: quarantinedAfter, pending: after };
  }

  // Resolve Projects v2 metadata once per process instance. Returns null if
  // projectNumber is not configured (Projects v2 mirror is skipped silently).
  async _resolveProjectMeta() {
    if (this._projectMeta !== null) return this._projectMeta;

    const projectNumber = this.cfg.projectNumber;
    if (!projectNumber) {
      this._projectMeta = undefined; // cache absence so we don't retry
      return undefined;
    }

    const owner = this.cfg.repo.split('/')[0];
    const query = `
      query($owner: String!, $number: Int!) {
        ${owner}: repositoryOwner(login: $owner) {
          projectV2(number: $number) {
            id
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options { id name }
              }
            }
          }
        }
      }
    `;
    const { data, errors } = await this.api.graphql(query, { owner, number: projectNumber });
    if (errors?.length) {
      console.warn('[tracker] Projects v2 metadata lookup failed:', errors);
      this._projectMeta = undefined;
      return undefined;
    }
    const proj = data?.[owner]?.projectV2;
    if (!proj) {
      console.warn('[tracker] Projects v2: project not found for number', projectNumber);
      this._projectMeta = undefined;
      return undefined;
    }
    const optionsByName = {};
    for (const opt of (proj.field?.options ?? [])) {
      optionsByName[opt.name] = opt.id;
    }
    this._projectMeta = { projectId: proj.id, fieldId: proj.field?.id, optionsByName };
    return this._projectMeta;
  }

  // Best-effort Projects v2 status mirror. NEVER throws — label+body+state are source of truth.
  async _mirrorProjectV2Status(issue, statusValue) {
    try {
      const meta = await this._resolveProjectMeta();
      if (!meta) return; // not configured or lookup failed

      const optionId = meta.optionsByName[statusValue];
      if (!optionId) {
        console.warn(`[tracker] Projects v2: no option for status "${statusValue}" — skipping mirror`);
        return;
      }

      // Add issue to the project (idempotent on GitHub's side) and get the item id.
      const addQuery = `
        mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
            item { id }
          }
        }
      `;
      const addResp = await this.api.graphql(addQuery, {
        projectId: meta.projectId,
        contentId: issue.node_id,
      });
      if (addResp.errors?.length) {
        console.warn('[tracker] Projects v2 addProjectV2ItemById failed:', addResp.errors);
        return;
      }
      const itemId = addResp.data?.addProjectV2ItemById?.item?.id;
      if (!itemId) {
        console.warn('[tracker] Projects v2: could not resolve item id for issue', issue.number);
        return;
      }

      // Update the Status single-select field.
      const updateQuery = `
        mutation($input: UpdateProjectV2ItemFieldValueInput!) {
          updateProjectV2ItemFieldValue(input: $input) {
            projectV2Item { id }
          }
        }
      `;
      const updateResp = await this.api.graphql(updateQuery, {
        input: {
          projectId: meta.projectId,
          itemId,
          fieldId: meta.fieldId,
          value: { singleSelectOptionId: optionId },
        },
      });
      if (updateResp.errors?.length) {
        console.warn('[tracker] Projects v2 updateProjectV2ItemFieldValue failed:', updateResp.errors);
      }
    } catch (err) {
      // Projects v2 is a mirror; non-fatal
      console.warn('[tracker] Projects v2 mirror error (non-fatal):', err?.message);
    }
  }

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

    if (op.op === 'putFeature' || op.op === 'persistFeatureRaw') {
      const id = await this._resolveIssueId(op.code);
      const issue = await this.api.getIssue(id.issueNumber);
      if (op.baseVersion && issue.updated_at !== op.baseVersion) {
        const e = new Error('stale');
        e.casMismatch = { remoteVersion: issue.updated_at };
        throw e;
      }
      const next = op.payload;
      const updated = await this.api.updateIssue(id.issueNumber, {
        body: encodeBody(next),
        labels: ['compose-feature', `status:${next.status}`],
        state: TERMINAL_STATUSES.has(next.status) ? 'closed' : 'open',
      });
      return { version: updated.updated_at };
    }

    if (op.op === 'setStatus') {
      const id = await this._resolveIssueId(op.code);
      const issue = await this.api.getIssue(id.issueNumber);
      if (op.baseVersion && issue.updated_at !== op.baseVersion) {
        const e = new Error('stale');
        e.casMismatch = { remoteVersion: issue.updated_at };
        throw e;
      }
      const next = { ...decodeBody(issue.body), status: op.payload.to };
      const updated = await this.api.updateIssue(id.issueNumber, {
        body: encodeBody(next),
        labels: ['compose-feature', `status:${next.status}`],
        state: TERMINAL_STATUSES.has(next.status) ? 'closed' : 'open',
      });
      // Post status event as a compose-event comment (source of truth for readEvents)
      await this._postEvent(id.issueNumber, op.payload.event);
      // Best-effort Projects v2 mirror — pass the full issue object (has node_id)
      await this._mirrorProjectV2Status(issue, op.payload.to);
      return { version: updated.updated_at };
    }

    if (op.op === 'recordCompletion') {
      const id = await this._resolveIssueId(op.code);
      const issue = await this.api.getIssue(id.issueNumber);
      if (op.baseVersion && issue.updated_at !== op.baseVersion) {
        const e = new Error('stale');
        e.casMismatch = { remoteVersion: issue.updated_at };
        throw e;
      }
      const decoded = decodeBody(issue.body) ?? {};
      const existingCompletions = decoded.completions ?? [];
      const sha = op.payload.completion.commit_sha;
      // Idempotent: skip if already persisted (reconcile replay safety, unconditional on sha)
      if (!existingCompletions.some(c => c.commit_sha === sha)) {
        decoded.completions = [...existingCompletions, op.payload.completion];
      }
      const updated = await this.api.updateIssue(id.issueNumber, {
        body: encodeBody(decoded),
        labels: issue.labels?.map(l => l.name ?? l) ?? [],
      });
      // Post completion event comment
      await this._postEvent(id.issueNumber, {
        type: 'completion',
        commit_sha: sha,
        ts: Date.now(),
      });
      return { version: updated.updated_at };
    }

    throw new Error(`_applyOp: unknown op ${op.op}`);
  }

  /**
   * Render the roadmap by fetching the remote ROADMAP.md as the merge base,
   * merging the current feature list into it, and committing the result back
   * via the Contents API with optimistic-lock (SHA-based). On SHA conflict,
   * refetches and retries once.
   *
   * Returns the roadmapPath string (consistent with LocalFileProvider.renderRoadmap
   * which returns the path via writeRoadmap).
   */
  async renderRoadmap() {
    const roadmapPath = this.cfg.github?.roadmapPath ?? this.cfg.roadmapPath ?? 'ROADMAP.md';
    const branch = this.cfg.github?.branch ?? this.cfg.branch ?? 'main';

    const doRender = async () => {
      const { text, sha } = await this.api.getContents(roadmapPath, branch);
      const features = await this.listFeatures();
      const merged = generateRoadmapFromBase(text, features, { cwd: this.cwd });
      await this.api.putContents(roadmapPath, merged, {
        sha,
        branch,
        message: 'chore(tracker): roadmap',
      });
    };

    try {
      await doRender();
    } catch (e) {
      if (e.shaConflict) {
        // Refetch new base and retry once
        await doRender();
      } else {
        throw e;
      }
    }

    return roadmapPath;
  }

  // ---------------------------------------------------------------------------
  // Low-level changelog primitives (FIX A)
  // Called by changelog-writer.js addChangelogEntry via getChangelog/putChangelog.
  // ---------------------------------------------------------------------------

  /**
   * Fetch the current CHANGELOG.md text from the remote repo.
   * Returns '' if the file does not yet exist (404 → empty seed).
   */
  async getChangelog() {
    const changelogPath = this.cfg.github?.changelogPath ?? this.cfg.changelogPath ?? 'CHANGELOG.md';
    const branch = this.cfg.github?.branch ?? this.cfg.branch ?? 'main';
    try {
      const { text } = await this.api.getContents(changelogPath, branch);
      return text;
    } catch (e) {
      // 404 = file doesn't exist yet; return empty string so writers create it.
      if (e.status === 404 || e.message?.includes('404') || e.message?.includes('Not Found')) {
        return '';
      }
      throw e;
    }
  }

  /**
   * Write the full CHANGELOG.md text to the remote repo.
   * Re-fetches the current SHA inside putChangelog so the caller's
   * get→splice→put sequence works correctly (the sha is always fresh at
   * write time). On SHA conflict (409), refetches and retries once.
   */
  async putChangelog(text) {
    const changelogPath = this.cfg.github?.changelogPath ?? this.cfg.changelogPath ?? 'CHANGELOG.md';
    const branch = this.cfg.github?.branch ?? this.cfg.branch ?? 'main';
    const message = `docs(changelog): update`;

    const doWrite = async () => {
      // Fetch current SHA for optimistic-lock. 404 → no sha (new file).
      let sha;
      try {
        const current = await this.api.getContents(changelogPath, branch);
        sha = current.sha;
      } catch (e) {
        if (e.status === 404 || e.message?.includes('404') || e.message?.includes('Not Found')) {
          sha = undefined;
        } else {
          throw e;
        }
      }
      await this.api.putContents(changelogPath, text, { sha, branch, message });
    };

    try {
      await doWrite();
    } catch (e) {
      if (e.shaConflict) {
        // Refetch SHA and retry once.
        await doWrite();
      } else {
        throw e;
      }
    }
  }

  /**
   * Append a changelog entry to the remote CHANGELOG.md via the Contents API
   * with optimistic-lock (SHA-based). On SHA conflict, refetches and retries once.
   * If the entry is idempotent (already present), returns without writing.
   *
   * NOTE: The production path (addChangelogEntry in changelog-writer.js) calls
   * getChangelog()+putChangelog() directly.  appendChangelog() is kept for
   * conformance suite callers that invoke the composite op directly on the provider.
   */
  async appendChangelog(entry) {
    const changelogPath = this.cfg.github?.changelogPath ?? this.cfg.changelogPath ?? 'CHANGELOG.md';
    const branch = this.cfg.github?.branch ?? this.cfg.branch ?? 'main';

    const doAppend = async () => {
      const { text, sha } = await this.api.getContents(changelogPath, branch);
      const { content, idempotent } = spliceChangelog(text, entry);
      if (idempotent) return { idempotent: true };
      await this.api.putContents(changelogPath, content, {
        sha,
        branch,
        message: `docs(changelog): ${entry.code ?? ''}`,
      });
      return { idempotent: false };
    };

    let result;
    try {
      result = await doAppend();
    } catch (e) {
      if (e.shaConflict) {
        // Refetch new base and retry once
        result = await doAppend();
      } else {
        throw e;
      }
    }

    return result;
  }
}
