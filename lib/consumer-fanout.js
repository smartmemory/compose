/**
 * Crash-safe consumer-dispatch artifacts for the TS-native ready[] pump.
 *
 * All metadata and item worktrees live outside the merge target. Journal writes
 * are fsync + atomic rename so a process kill cannot expose a half-record.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const JOURNAL_VERSION = 1;
let tempIndexSequence = 0;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function git(cwd, args, opts = {}) {
  const output = execFileSync('git', args, {
    cwd,
    encoding: opts.encoding ?? 'utf8',
    input: opts.input,
    env: opts.env ?? process.env,
    timeout: opts.timeout ?? 30_000,
    // A cumulative diff (git diff --cached --binary) can dwarf execFileSync's
    // 1 MiB default stdout buffer. Without headroom a >1 MiB diff throws ENOBUFS
    // at capture AND identically on every recovery re-run — a permanent wedge.
    // Every git call in this module routes through here, so one ceiling covers
    // diff capture, snapshots, and merges alike.
    maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return opts.trim === false ? output : output.trim();
}

function fsyncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function durableWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

/** Resolve symlinks in every existing prefix, including for a not-yet-created leaf. */
function canonicalPath(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const existing = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return resolve(existing, ...missing);
}

function withTemporaryIndex(cwd, fn) {
  const indexPath = join(
    tmpdir(),
    `compose-consumer-index-${process.pid}-${tempIndexSequence++}-${randomUUID()}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    return fn(env);
  } finally {
    rmSync(indexPath, { force: true });
  }
}

/** Snapshot tracked + untracked, non-ignored working content without touching the real index. */
export function snapshotWorkingTree(cwd) {
  return withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', 'HEAD'], { env });
    git(cwd, ['add', '-A'], { env });
    return git(cwd, ['write-tree'], { env });
  });
}

function restoreWorkingTree(cwd, treeId) {
  // This intentionally normalizes the staged/unstaged split, matching Compose's
  // existing snapshot restore semantics. The final reset leaves HEAD/index alone
  // while retaining the restored tree as working content.
  try { git(cwd, ['clean', '-fd']); } catch { /* nothing untracked to remove */ }
  git(cwd, ['read-tree', '--reset', '-u', treeId]);
  git(cwd, ['reset', '-q', 'HEAD']);
  const actual = snapshotWorkingTree(cwd);
  if (actual !== treeId) {
    throw new Error(`consumer snapshot restore verification failed: expected ${treeId}, got ${actual}`);
  }
}

function cumulativeDiff(cwd, baseCommit) {
  return withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', baseCommit], { env });
    git(cwd, ['add', '-A'], { env });
    return git(cwd, ['diff', '--cached', '--binary', baseCommit, '--'], {
      env,
      timeout: 60_000,
      trim: false,
    });
  });
}

function computeWitnessChain(cwd, orderedEntries) {
  return withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', 'HEAD'], { env });
    git(cwd, ['add', '-A'], { env });
    const chain = [git(cwd, ['write-tree'], { env })];
    for (const entry of orderedEntries) {
      if (entry.diff.length > 0) {
        git(cwd, ['apply', '--cached', '--binary', '-'], {
          env,
          input: entry.diff,
          timeout: 60_000,
        });
      }
      chain.push(git(cwd, ['write-tree'], { env }));
    }
    return chain;
  });
}

function defaultArtifactRoot(targetCwd) {
  const workspaceKey = sha256(resolve(targetCwd)).slice(0, 24);
  return join(tmpdir(), 'compose-consumer-fanout', workspaceKey);
}

function runDirectoryName(runId) {
  return `${String(runId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)}-${sha256(runId).slice(0, 12)}`;
}

function journalLocation({ runId, targetCwd, artifactRoot }) {
  const target = canonicalPath(targetCwd);
  const root = canonicalPath(artifactRoot ?? defaultArtifactRoot(target));
  return join(root, runDirectoryName(runId), 'journal.json');
}

function worktreeKey(descriptor) {
  return `${descriptor.id}@${descriptor.generation}`;
}

/**
 * Python-parity: a fanout with `isolation: "none"` runs its items in the shared
 * target cwd (no per-item worktree, no diff capture, no merge participation).
 * Only `isolation: "worktree"` items own a detached worktree and owe a diff.
 */
function isNoneIsolation(descriptor) {
  return descriptor?.policy?.isolation === 'none';
}

function terminalItem(item) {
  return ['succeeded', 'failed', 'skipped', 'cancelled'].includes(item?.status);
}

export function isConsumerDescriptor(entry) {
  return Boolean(
    entry
      && typeof entry === 'object'
      && typeof entry.dispatchToken === 'string'
      && entry.dispatchToken.length > 0
      && Number.isInteger(entry.itemIndex)
      && Number.isInteger(entry.stage)
      && Number.isInteger(entry.generation)
      && typeof entry.step === 'string'
      && entry.policy
      && typeof entry.policy === 'object',
  );
}

export class ConsumerArtifactError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ConsumerArtifactError';
    this.code = code;
    this.detail = detail;
  }
}

export class ConsumerMergeDecisionError extends ConsumerArtifactError {
  constructor(code, message, detail = {}) {
    super(code, message, detail);
    this.name = 'ConsumerMergeDecisionError';
  }
}

export class ConsumerFanoutArtifacts {
  constructor({ runId, targetCwd, artifactRoot, hooks = {}, revisionDigest, specDigest }) {
    this.runId = runId;
    this.targetCwd = canonicalPath(targetCwd);
    this.artifactRoot = canonicalPath(artifactRoot ?? defaultArtifactRoot(this.targetCwd));
    const artifactRelative = relative(this.targetCwd, this.artifactRoot);
    if (artifactRelative === ''
      || (!artifactRelative.startsWith('..') && !isAbsolute(artifactRelative))) {
      throw new ConsumerArtifactError(
        'ARTIFACT_ROOT_INSIDE_TARGET',
        `consumer artifact root must be outside the merge target: ${this.artifactRoot}`,
      );
    }
    // Revision pins are written into the FIRST durable journal write (below), so
    // a crash between journal creation and the first bind cannot leave an
    // unpinned journal that a drifted spec could later re-pin as the truth.
    this._initialRevisionDigest = typeof revisionDigest === 'string' && revisionDigest.length > 0 ? revisionDigest : null;
    this._initialSpecDigest = typeof specDigest === 'string' && specDigest.length > 0 ? specDigest : null;
    this.runRoot = join(this.artifactRoot, runDirectoryName(runId));
    this.journalPath = join(this.runRoot, 'journal.json');
    this.hooks = hooks ?? {};
    mkdirSync(this.runRoot, { recursive: true });
    this.journal = this.#load();
  }

  #load() {
    if (!existsSync(this.journalPath)) {
      const journal = {
        version: JOURNAL_VERSION,
        runId: this.runId,
        targetCwd: this.targetCwd,
        createdAt: now(),
        updatedAt: now(),
        // The run revision this journal belongs to. `revisionDigest` is the
        // engine's effective-spec digest (echoed by every descriptor); `specDigest`
        // is Compose's fingerprint of the local pipeline spec it derives final-stage
        // and merge-gate ownership from. Both are pinned in THIS initial write when
        // available, and re-checked on resume so a mid-run spec edit cannot silently
        // strand diffs.
        revisionDigest: this._initialRevisionDigest,
        specDigest: this._initialSpecDigest,
        gateBinding: null,
        worktrees: [],
        witnesses: [],
        issuances: [],
        mergeTransactions: [],
      };
      durableWriteJson(this.journalPath, journal);
      return journal;
    }
    const journal = JSON.parse(readFileSync(this.journalPath, 'utf8'));
    if (journal.version !== JOURNAL_VERSION || journal.runId !== this.runId) {
      throw new ConsumerArtifactError('JOURNAL_IDENTITY_MISMATCH', 'consumer artifact journal identity mismatch');
    }
    if (resolve(journal.targetCwd) !== this.targetCwd) {
      throw new ConsumerArtifactError(
        'JOURNAL_TARGET_MISMATCH',
        `consumer artifact journal targets ${journal.targetCwd}, not ${this.targetCwd}`,
      );
    }
    journal.revisionDigest ??= null;
    journal.specDigest ??= null;
    journal.gateBinding ??= null;
    journal.worktrees ??= [];
    journal.witnesses ??= [];
    journal.issuances ??= [];
    journal.mergeTransactions ??= [];
    // Adopt constructor-supplied pins onto an EXISTING unpinned journal — a legacy
    // pre-pinning journal, or one first created at the gate path before this
    // manager was constructed. An already-pinned journal keeps its pins; a
    // constructor pin that DIFFERS from a persisted one is a real revision drift.
    let adopted = false;
    if (this._initialRevisionDigest) {
      if (!journal.revisionDigest) { journal.revisionDigest = this._initialRevisionDigest; adopted = true; }
      else if (journal.revisionDigest !== this._initialRevisionDigest) {
        throw new ConsumerArtifactError(
          'CONSUMER_RUN_REVISION_MISMATCH',
          `consumer journal revision ${journal.revisionDigest} does not match run revision ${this._initialRevisionDigest}`,
          { journaledRevisionDigest: journal.revisionDigest, runRevisionDigest: this._initialRevisionDigest },
        );
      }
    }
    if (this._initialSpecDigest) {
      if (!journal.specDigest) { journal.specDigest = this._initialSpecDigest; adopted = true; }
      else if (journal.specDigest !== this._initialSpecDigest) {
        throw new ConsumerArtifactError(
          'CONSUMER_RUN_REVISION_MISMATCH',
          `consumer journal spec ${journal.specDigest} does not match local spec ${this._initialSpecDigest}`,
          { journaledSpecDigest: journal.specDigest, currentSpecDigest: this._initialSpecDigest },
        );
      }
    }
    if (adopted) durableWriteJson(this.journalPath, journal);
    return journal;
  }

  #save() {
    this.journal.updatedAt = now();
    durableWriteJson(this.journalPath, this.journal);
  }

  #worktreeFor(descriptor) {
    return this.journal.worktrees.find((entry) => entry.key === worktreeKey(descriptor));
  }

  #ensureWorktree(descriptor) {
    const key = worktreeKey(descriptor);
    let record = this.#worktreeFor(descriptor);
    if (record) {
      if (existsSync(record.path)) {
        try {
          if (git(record.path, ['rev-parse', '--is-inside-work-tree']) === 'true') {
            if (record.status !== 'ready') {
              record.status = 'ready';
              record.readyAt = now();
              this.#save();
            }
            return record;
          }
        } catch { /* partial worktree creation; rebuild below */ }
      }

      if (record.status === 'creating') {
        try { git(this.targetCwd, ['worktree', 'prune']); } catch { /* best effort */ }
        rmSync(record.path, { recursive: true, force: true });
        mkdirSync(dirname(record.path), { recursive: true });
        git(this.targetCwd, ['worktree', 'add', '--detach', record.path, record.baseCommit], { timeout: 60_000 });
        record.status = 'ready';
        record.readyAt = now();
        record.recoveredAt = now();
        this.#save();
        return record;
      }

      // Only the CURRENT issuance's pre-stage witness is a safe reconstruction
      // point. An older stage witness predates that stage's filesystem mutation
      // and would silently discard persistent `${prev}` state.
      const witness = this.journal.witnesses.find(
        (entry) => entry.worktreeKey === key
          && entry.dispatchToken === descriptor.dispatchToken,
      );
      if (!witness) {
        throw new ConsumerArtifactError(
          'ITEM_WORKTREE_LOST',
          `consumer worktree artifact was lost for ${descriptor.id} generation ${descriptor.generation}`,
          { descriptor },
        );
      }
      try { git(this.targetCwd, ['worktree', 'prune']); } catch { /* best effort */ }
      rmSync(record.path, { recursive: true, force: true });
      git(this.targetCwd, ['worktree', 'add', '--detach', record.path, record.baseCommit], { timeout: 60_000 });
      restoreWorkingTree(record.path, witness.witnessTree);
      record.status = 'ready';
      record.recoveredAt = now();
      this.#save();
      return record;
    }

    for (const prior of this.journal.worktrees) {
      if (prior.scopedId === descriptor.id && prior.generation !== descriptor.generation && !prior.superseded) {
        prior.superseded = true;
        prior.supersededAt = now();
      }
    }
    for (const issuance of this.journal.issuances) {
      if (issuance.scopedId === descriptor.id
        && issuance.generation !== descriptor.generation
        && issuance.state !== 'merged'
        && issuance.state !== 'superseded') {
        issuance.state = 'superseded';
        issuance.supersededAt = now();
      }
    }

    const path = join(this.runRoot, 'worktrees', sha256(key).slice(0, 32));
    record = {
      key,
      scopedId: descriptor.id,
      fanoutStepId: descriptor.step,
      itemIndex: descriptor.itemIndex,
      generation: descriptor.generation,
      path,
      baseCommit: git(this.targetCwd, ['rev-parse', 'HEAD']),
      status: 'creating',
      superseded: false,
      createdAt: now(),
    };
    this.journal.worktrees.push(record);
    this.#save();

    mkdirSync(dirname(path), { recursive: true });
    try {
      git(this.targetCwd, ['worktree', 'add', '--detach', path, record.baseCommit], { timeout: 60_000 });
    } catch (error) {
      try { git(this.targetCwd, ['worktree', 'prune']); } catch { /* best effort */ }
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
    record.status = 'ready';
    record.readyAt = now();
    this.#save();
    return record;
  }

  #auditItem(audit, fanoutStepId, itemIndex) {
    return audit?.steps?.[fanoutStepId]?.fanout?.items?.[itemIndex] ?? null;
  }

  /**
   * Pin the run revision + local-spec fingerprint at the first consumer issuance.
   * First-write-wins; a later issuance carrying a DIFFERENT engine revision digest
   * is a mid-run revision the journal must reject rather than silently absorb.
   */
  bindRunRevision({ revisionDigest, specDigest }) {
    let changed = false;
    if (typeof revisionDigest === 'string' && revisionDigest.length > 0) {
      if (this.journal.revisionDigest === null) {
        this.journal.revisionDigest = revisionDigest;
        changed = true;
      } else if (this.journal.revisionDigest !== revisionDigest) {
        throw new ConsumerArtifactError(
          'CONSUMER_RUN_REVISION_MISMATCH',
          `consumer run revision changed mid-run: journaled ${this.journal.revisionDigest}, descriptor ${revisionDigest}`,
          { journaledRevisionDigest: this.journal.revisionDigest, descriptorRevisionDigest: revisionDigest },
        );
      }
    }
    if (typeof specDigest === 'string' && specDigest.length > 0 && this.journal.specDigest === null) {
      this.journal.specDigest = specDigest;
      changed = true;
    }
    if (changed) this.#save();
    return this.journal;
  }

  /** Record which fanout step a merge gate settles, so resume never re-derives it
   *  from a mutable local spec that may have drifted. First-write-wins per gate. */
  recordGateBinding({ gateStepId, fanoutStepId }) {
    if (!gateStepId || !fanoutStepId) return;
    const existing = this.journal.gateBinding ?? {};
    if (existing[gateStepId] === fanoutStepId) return;
    if (existing[gateStepId] && existing[gateStepId] !== fanoutStepId) {
      throw new ConsumerArtifactError(
        'CONSUMER_GATE_BINDING_MISMATCH',
        `merge gate ${gateStepId} was journaled against fanout ${existing[gateStepId]}, not ${fanoutStepId}`,
        { gateStepId, journaledFanoutStepId: existing[gateStepId], fanoutStepId },
      );
    }
    this.journal.gateBinding = { ...existing, [gateStepId]: fanoutStepId };
    this.#save();
  }

  reconcileAudit(audit) {
    let changed = false;
    for (const issuance of this.journal.issuances) {
      if (issuance.state === 'merged' || issuance.state === 'superseded') continue;
      const fanoutItems = audit?.steps?.[issuance.fanoutStepId]?.fanout?.items;
      const item = Array.isArray(fanoutItems) ? fanoutItems[issuance.itemIndex] : undefined;
      if (!item) {
        // The fanout has no item at this index. If the fanout IS present in the
        // audit (re-enumeration produced FEWER items), the issuance's evidence is
        // stale ground-truth — supersede it so a later merge never resurrects a
        // diff for an item index that no longer exists. If the fanout is absent
        // from the audit entirely, there is nothing to reconcile against; leave it.
        if (Array.isArray(fanoutItems)) {
          issuance.state = 'superseded';
          issuance.supersededAt = now();
          changed = true;
        }
        continue;
      }
      if (item.generation !== issuance.generation) {
        issuance.state = 'superseded';
        issuance.supersededAt = now();
        changed = true;
      } else if (item.status === 'succeeded'
        && item.acceptedDispatchToken === issuance.dispatchToken) {
        issuance.state = 'accepted';
        issuance.acceptedAt = now();
        changed = true;
      } else if (terminalItem(item)
        || (typeof item.dispatchToken === 'string' && item.dispatchToken !== issuance.dispatchToken)) {
        issuance.state = 'superseded';
        issuance.supersededAt = now();
        changed = true;
      }
    }

    for (const worktree of this.journal.worktrees) {
      const item = this.#auditItem(audit, worktree.fanoutStepId, worktree.itemIndex);
      if (item && item.generation !== worktree.generation && !worktree.superseded) {
        worktree.superseded = true;
        worktree.supersededAt = now();
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  /**
   * Reconcile a ready issuance. Returns either a stored envelope to re-report,
   * or a verified worktree path in which the stage may execute.
   */
  reconcileDescriptor(descriptor, audit) {
    this.reconcileAudit(audit);
    const prepared = this.journal.issuances.find(
      (entry) => entry.dispatchToken === descriptor.dispatchToken,
    );
    if (prepared?.state === 'prepared') {
      return { action: 'report', envelope: structuredClone(prepared.envelope), issuance: prepared };
    }
    if (prepared?.state === 'accepted') {
      return { action: 'accepted', issuance: prepared };
    }

    if (isNoneIsolation(descriptor)) {
      // In-cwd execution: no worktree, no pre-stage witness, no diff. A crash
      // before the prepared envelope simply re-executes in the target on retry
      // (Python parity), and the envelope journaling below still guards a crash
      // between prepare and step_done.
      return { action: 'execute', worktree: this.targetCwd, witness: null, isolation: 'none' };
    }

    const worktree = this.#ensureWorktree(descriptor);
    const witness = this.journal.witnesses.find(
      (entry) => entry.dispatchToken === descriptor.dispatchToken,
    );
    if (witness) {
      restoreWorkingTree(worktree.path, witness.witnessTree);
      witness.restoredAt = now();
      witness.restoreCount = (witness.restoreCount ?? 0) + 1;
      this.#save();
      return { action: 'execute', worktree: worktree.path, witness, restored: true };
    }

    const newWitness = {
      dispatchToken: descriptor.dispatchToken,
      scopedId: descriptor.id,
      fanoutStepId: descriptor.step,
      itemIndex: descriptor.itemIndex,
      generation: descriptor.generation,
      stage: descriptor.stage,
      attempt: descriptor.attempt,
      worktreeKey: worktree.key,
      witnessTree: snapshotWorkingTree(worktree.path),
      createdAt: now(),
    };
    this.journal.witnesses.push(newWitness);
    this.#save();
    return { action: 'execute', worktree: worktree.path, witness: newWitness, restored: false };
  }

  /**
   * Restore a still-ready issuance's worktree to its pre-stage witness. Used when
   * the agent/connector threw mid-stage: the retry (or the failure report) must
   * start from the clean pre-stage snapshot, not a half-mutated worktree.
   * Returns false when there is nothing to restore (no worktree or no witness).
   */
  restoreToPreStageWitness(descriptor) {
    const worktree = this.#worktreeFor(descriptor);
    const witness = this.journal.witnesses.find(
      (entry) => entry.dispatchToken === descriptor.dispatchToken,
    );
    if (!worktree || !witness || !existsSync(worktree.path)) return false;
    restoreWorkingTree(worktree.path, witness.witnessTree);
    witness.restoredAt = now();
    witness.restoreCount = (witness.restoreCount ?? 0) + 1;
    this.#save();
    return true;
  }

  prepareIssuance(descriptor, envelope, { finalStage }) {
    const existing = this.journal.issuances.find(
      (entry) => entry.dispatchToken === descriptor.dispatchToken,
    );
    if (existing) return existing;

    if (isNoneIsolation(descriptor)) {
      // Envelope-only journal entry: no worktree, no witness, no diff. It never
      // participates in the merge (prepareMerge filters isolation:none out), so
      // its files persist directly in the target cwd.
      const entry = {
        dispatchToken: descriptor.dispatchToken,
        scopedId: descriptor.id,
        fanoutStepId: descriptor.step,
        itemIndex: descriptor.itemIndex,
        generation: descriptor.generation,
        stage: descriptor.stage,
        attempt: descriptor.attempt,
        revisionDigest: descriptor.revisionDigest,
        contractDigest: descriptor.contractDigest,
        isolation: 'none',
        worktreeKey: null,
        witnessTree: null,
        state: 'prepared',
        envelope: structuredClone(envelope),
        diff: null,
        hadCumulativeDiff: false,
        diffDigest: null,
        finalStage: finalStage === true,
        preparedAt: now(),
      };
      this.journal.issuances.push(entry);
      this.#save();
      return entry;
    }

    const worktree = this.#worktreeFor(descriptor);
    const witness = this.journal.witnesses.find(
      (entry) => entry.dispatchToken === descriptor.dispatchToken,
    );
    if (!worktree || !witness) {
      throw new ConsumerArtifactError(
        'ISSUANCE_WITNESS_MISSING',
        `cannot prepare ${descriptor.id}: durable pre-stage witness is missing`,
      );
    }
    const diff = finalStage ? cumulativeDiff(worktree.path, worktree.baseCommit) : null;
    const entry = {
      dispatchToken: descriptor.dispatchToken,
      scopedId: descriptor.id,
      fanoutStepId: descriptor.step,
      itemIndex: descriptor.itemIndex,
      generation: descriptor.generation,
      stage: descriptor.stage,
      attempt: descriptor.attempt,
      revisionDigest: descriptor.revisionDigest,
      contractDigest: descriptor.contractDigest,
      isolation: 'worktree',
      worktreeKey: worktree.key,
      witnessTree: witness.witnessTree,
      state: 'prepared',
      envelope: structuredClone(envelope),
      diff,
      hadCumulativeDiff: diff !== null,
      diffDigest: diff === null ? null : sha256(diff),
      preparedAt: now(),
    };
    this.journal.issuances.push(entry);
    this.#save();
    return entry;
  }

  prepareArtifactFailure(descriptor, envelope, error) {
    const existing = this.journal.issuances.find(
      (entry) => entry.dispatchToken === descriptor.dispatchToken,
    );
    if (existing) return existing;
    const entry = {
      dispatchToken: descriptor.dispatchToken,
      scopedId: descriptor.id,
      fanoutStepId: descriptor.step,
      itemIndex: descriptor.itemIndex,
      generation: descriptor.generation,
      stage: descriptor.stage,
      attempt: descriptor.attempt,
      revisionDigest: descriptor.revisionDigest,
      contractDigest: descriptor.contractDigest,
      worktreeKey: worktreeKey(descriptor),
      witnessTree: null,
      state: 'prepared',
      envelope: structuredClone(envelope),
      diff: null,
      hadCumulativeDiff: false,
      diffDigest: null,
      artifactFailure: { code: error.code, message: error.message },
      preparedAt: now(),
    };
    this.journal.issuances.push(entry);
    this.#save();
    return entry;
  }

  acceptedEntriesFor(fanoutStepId) {
    return this.journal.issuances
      .filter((entry) => entry.fanoutStepId === fanoutStepId && entry.state === 'accepted')
      .sort((a, b) => a.itemIndex - b.itemIndex
        || a.scopedId.localeCompare(b.scopedId)
        || a.generation - b.generation);
  }

  prepareMerge({ gateStepId, gateToken, fanoutStepId, audit }) {
    this.reconcileAudit(audit);
    const existing = this.journal.mergeTransactions.find((entry) => entry.gateToken === gateToken);
    if (existing?.state === 'blocked') {
      throw new ConsumerMergeDecisionError(
        existing.failureCode ?? 'MERGE_TRANSACTION_BLOCKED',
        existing.failure ?? 'consumer merge transaction is blocked',
        { gateToken },
      );
    }
    if (existing) return existing;

    const accepted = this.acceptedEntriesFor(fanoutStepId);
    // Only isolation:worktree items own a diff and participate in the merge.
    // isolation:none items already wrote in the target cwd; they are accepted
    // evidence but owe no diff (a pure-none fanout yields zero ordered diffs).
    const worktreeAccepted = accepted.filter((entry) => entry.isolation !== 'none');
    const baselineTree = snapshotWorkingTree(this.targetCwd);
    const orderedDiffs = worktreeAccepted.map((entry) => ({
      dispatchToken: entry.dispatchToken,
      scopedId: entry.scopedId,
      itemIndex: entry.itemIndex,
      generation: entry.generation,
      digest: entry.diffDigest,
      diff: entry.diff,
    }));
    const recordBlocked = (code, message, witnessChain = [baselineTree]) => {
      const transaction = {
        gateStepId,
        gateToken,
        fanoutStepId,
        state: 'blocked',
        baselineTree,
        witnessChain,
        orderedDiffs,
        recovery: { baselineRestores: 0 },
        failureCode: code,
        failure: `${code}: ${message}`,
        preparedAt: now(),
      };
      this.journal.mergeTransactions.push(transaction);
      this.#save();
      return transaction;
    };
    const auditItems = audit?.steps?.[fanoutStepId]?.fanout?.items ?? [];
    const succeeded = auditItems.filter((item) => item?.status === 'succeeded');
    // Every succeeded item must have an accepted issuance; only worktree items
    // must additionally carry a captured diff.
    if (accepted.length !== succeeded.length || worktreeAccepted.some((entry) => entry.diff === null)) {
      const detail = `merge gate ${gateStepId} has ${succeeded.length} succeeded items but `
        + `${accepted.length} accepted (${worktreeAccepted.length} worktree diffs)`;
      recordBlocked('ACCEPTED_ARTIFACTS_INCOMPLETE', detail);
      throw new ConsumerMergeDecisionError(
        'ACCEPTED_ARTIFACTS_INCOMPLETE', detail, { gateStepId, fanoutStepId },
      );
    }

    let witnessChain;
    try {
      witnessChain = computeWitnessChain(this.targetCwd, worktreeAccepted);
    } catch (error) {
      recordBlocked(
        'MERGE_WITNESS_PRECOMPUTE_FAILED',
        `consumer merge witness precompute failed: ${error.message}`,
      );
      throw new ConsumerMergeDecisionError(
        'MERGE_WITNESS_PRECOMPUTE_FAILED',
        `consumer merge witness precompute failed: ${error.message}`,
        { cause: error },
      );
    }
    if (witnessChain[0] !== baselineTree) {
      recordBlocked(
        'MERGE_BASELINE_CHANGED_DURING_PRECOMPUTE',
        `consumer merge baseline changed from ${baselineTree} to ${witnessChain[0]}`,
        witnessChain,
      );
      throw new ConsumerMergeDecisionError(
        'MERGE_BASELINE_CHANGED_DURING_PRECOMPUTE',
        'consumer merge baseline changed during witness precompute',
        { witnessChain },
      );
    }
    if (new Set(witnessChain).size !== witnessChain.length) {
      recordBlocked(
        'MERGE_WITNESS_NOT_UNIQUE',
        'consumer merge aborted: expected tree-witness chain is not unique',
        witnessChain,
      );
      throw new ConsumerMergeDecisionError(
        'MERGE_WITNESS_NOT_UNIQUE',
        'consumer merge aborted: expected tree-witness chain is not unique',
        { witnessChain },
      );
    }

    const transaction = {
      gateStepId,
      gateToken,
      fanoutStepId,
      state: 'prepared',
      baselineTree,
      witnessChain,
      orderedDiffs,
      recovery: { baselineRestores: 0 },
      preparedAt: now(),
    };
    this.journal.mergeTransactions.push(transaction);
    // One durable record contains the entire token/order/diff/witness chain
    // before any target working-tree mutation occurs.
    this.#save();
    return transaction;
  }

  async applyMerge(transaction) {
    if (transaction.state === 'blocked') {
      throw new ConsumerMergeDecisionError(
        transaction.failureCode ?? 'MERGE_TRANSACTION_BLOCKED',
        transaction.failure ?? 'consumer merge transaction is blocked',
      );
    }
    if (transaction.state === 'complete') {
      const completedTree = snapshotWorkingTree(this.targetCwd);
      if (completedTree === transaction.witnessChain.at(-1)) return transaction;
      // A completed journal with a non-final working tree means the process
      // died before gate resolution and the target changed afterward. Re-enter
      // the same prefix/unmatched recovery algorithm instead of trusting state.
      transaction.state = 'prepared';
      transaction.recovery ??= { baselineRestores: 0 };
      transaction.recovery.completedTreeMismatch = completedTree;
      transaction.recovery.completedTreeMismatchAt = now();
      this.#save();
    }
    let currentTree = snapshotWorkingTree(this.targetCwd);
    let prefix = transaction.witnessChain.indexOf(currentTree);
    if (prefix < 0) {
      restoreWorkingTree(this.targetCwd, transaction.baselineTree);
      transaction.recovery ??= { baselineRestores: 0 };
      transaction.recovery.baselineRestores = (transaction.recovery.baselineRestores ?? 0) + 1;
      transaction.recovery.lastUnmatchedTree = currentTree;
      transaction.recovery.lastRestoredAt = now();
      this.#save();
      currentTree = snapshotWorkingTree(this.targetCwd);
      if (currentTree !== transaction.baselineTree) {
        throw new ConsumerMergeDecisionError(
          'MERGE_BASELINE_RESTORE_FAILED',
          `consumer merge baseline verification failed: expected ${transaction.baselineTree}, got ${currentTree}`,
        );
      }
      prefix = 0;
    }

    for (let orderedIndex = prefix; orderedIndex < transaction.orderedDiffs.length; orderedIndex += 1) {
      const ordered = transaction.orderedDiffs[orderedIndex];
      try {
        if (typeof this.hooks.insideDiffApply === 'function') {
          await this.hooks.insideDiffApply({
            cwd: this.targetCwd,
            orderedIndex,
            orderedDiff: structuredClone(ordered),
            transaction: structuredClone(transaction),
          });
        }
        git(this.targetCwd, ['apply', '--binary', '-'], { input: ordered.diff, timeout: 60_000 });
        const landedTree = snapshotWorkingTree(this.targetCwd);
        const expectedTree = transaction.witnessChain[orderedIndex + 1];
        if (landedTree !== expectedTree) {
          throw new ConsumerArtifactError(
            'MERGE_PREFIX_WITNESS_MISMATCH',
            `consumer diff ${orderedIndex} produced ${landedTree}, expected ${expectedTree}`,
          );
        }
      } catch (error) {
        // An injected crash represents abrupt process death: preserve the partial
        // target exactly so a fresh loop must exercise unmatched-tree recovery.
        if (error?.code === 'INJECTED_CONSUMER_CRASH') throw error;
        restoreWorkingTree(this.targetCwd, transaction.baselineTree);
        transaction.state = 'blocked';
        transaction.failure = error.message;
        transaction.recovery ??= { baselineRestores: 0 };
        transaction.recovery.baselineRestores = (transaction.recovery.baselineRestores ?? 0) + 1;
        transaction.recovery.lastRestoredAt = now();
        this.#save();
        throw new ConsumerMergeDecisionError(
          'MERGE_APPLY_FAILED',
          `consumer merge apply failed and baseline was restored: ${error.message}`,
          { cause: error },
        );
      }
    }

    const finalTree = snapshotWorkingTree(this.targetCwd);
    const expectedFinal = transaction.witnessChain.at(-1);
    if (finalTree !== expectedFinal) {
      throw new ConsumerMergeDecisionError(
        'MERGE_FINAL_WITNESS_MISMATCH',
        `consumer merge final tree ${finalTree} does not match ${expectedFinal}`,
      );
    }
    transaction.state = 'complete';
    transaction.completedAt = now();
    for (const ordered of transaction.orderedDiffs) {
      const issuance = this.journal.issuances.find(
        (entry) => entry.dispatchToken === ordered.dispatchToken,
      );
      if (issuance && issuance.state !== 'merged') {
        issuance.state = 'merged';
        issuance.mergedAt = now();
      }
    }
    this.#save();
    return transaction;
  }

  restoreMergeBaseline(transaction, audit) {
    if (!transaction) return;
    const wasBlocked = transaction.state === 'blocked';
    restoreWorkingTree(this.targetCwd, transaction.baselineTree);
    transaction.state = wasBlocked ? 'blocked' : 'rolled_back';
    transaction.rolledBackAt = now();
    transaction.recovery ??= { baselineRestores: 0 };
    transaction.recovery.baselineRestores = (transaction.recovery.baselineRestores ?? 0) + 1;
    transaction.recovery.baselineVerifiedTree = transaction.baselineTree;
    transaction.recovery.baselineVerifiedAt = now();
    // Rolling back un-applies this transaction's diffs from the target, so any
    // issuance it marked `merged` (a crash between applyMerge and gateResolve) is
    // no longer merged. Restore merge eligibility (`merged` -> `accepted`) so a
    // non-re-enumerating repair round can merge it again — BUT reconcile each
    // restored entry against the CURRENT audit (ground truth). An entry whose
    // item index no longer exists in the current generation, or whose generation
    // or accepted token is stale, is superseded, NEVER resurrected as an accepted
    // diff. Without the audit the entry is only restored if it was mid-flight.
    for (const ordered of transaction.orderedDiffs ?? []) {
      const issuance = this.journal.issuances.find(
        (entry) => entry.dispatchToken === ordered.dispatchToken,
      );
      if (!issuance || issuance.state !== 'merged') continue;
      const fanoutItems = audit?.steps?.[issuance.fanoutStepId]?.fanout?.items;
      const item = Array.isArray(fanoutItems) ? fanoutItems[issuance.itemIndex] : undefined;
      const stale = Array.isArray(fanoutItems) && (
        !item
        || item.generation !== issuance.generation
        || (item.status === 'succeeded' && item.acceptedDispatchToken !== issuance.dispatchToken)
        || (typeof item.dispatchToken === 'string' && item.dispatchToken !== issuance.dispatchToken)
      );
      if (stale) {
        issuance.state = 'superseded';
        issuance.supersededAt = now();
        delete issuance.mergedAt;
      } else {
        issuance.state = 'accepted';
        delete issuance.mergedAt;
      }
    }
    this.#save();
  }

  markGateResolved(transaction, outcome) {
    if (transaction) {
      transaction.gateOutcome = outcome;
      transaction.gateResolvedAt = now();
      // Supersession is driven by re-enumeration, NOT by the gate outcome. A
      // revise that routes to a repair step (rather than back to the fanout)
      // re-enumerates nothing: the succeeded items keep their generation and
      // acceptedDispatchToken, so their accepted diffs must survive to the next
      // gate round. reconcileAudit / #ensureWorktree mark an issuance superseded
      // only when the audit shows a newer generation for its scoped id or its
      // token rotated — the authoritative signal that its evidence was replaced.
      this.#save();
    }
  }

  cleanupWorktrees(reason) {
    for (const record of this.journal.worktrees) {
      if (record.cleanedAt) continue;
      if (existsSync(record.path)) {
        try {
          git(this.targetCwd, ['worktree', 'remove', '--force', record.path], { timeout: 60_000 });
        } catch {
          rmSync(record.path, { recursive: true, force: true });
          try { git(this.targetCwd, ['worktree', 'prune']); } catch { /* best effort */ }
        }
      }
      record.cleanedAt = now();
      record.cleanupReason = reason;
    }
    for (const issuance of this.journal.issuances) {
      if (typeof issuance.diff === 'string') {
        issuance.diff = null;
        issuance.diffDroppedAt = now();
      }
    }
    for (const transaction of this.journal.mergeTransactions) {
      for (const ordered of transaction.orderedDiffs ?? []) {
        if (typeof ordered.diff === 'string') ordered.diff = null;
      }
      if (transaction.orderedDiffs?.length > 0 && !transaction.diffPayloadsDroppedAt) {
        transaction.diffPayloadsDroppedAt = now();
      }
    }
    this.#save();
  }
}

/**
 * Resume-time revision guard. Before Compose trusts its (mutable) local pipeline
 * spec to detect final stages or discover merge-gate ownership, verify the spec
 * still describes the run being resumed. A spec edited between crash and resume
 * could otherwise approve the fanout's merge gate WITHOUT applying the accepted
 * diffs, or exit the pump with diffs stranded.
 *
 * Fails loudly (never reconciles, never resolves a gate) on any mismatch:
 *  - the journal holds work but is MISSING its revision pins (fail-closed: a
 *    journal that recorded issuances/worktrees/merges without pins cannot be
 *    verified against the local spec, so it must not be trusted);
 *  - the local-spec fingerprint differs from the one pinned at run start;
 *  - the engine's resume-response revision differs from the journaled revision;
 *  - a journal entry carries a revision other than the run's.
 *
 * Returns null (no-op) when the run has no consumer journal, or when the journal
 * is empty AND unpinned — a pre-first-issuance artifact with nothing staked on
 * it, safe to let the run recreate and re-pin (new code pins at creation, so this
 * only covers legacy journals).
 */
export function verifyConsumerRunRevision({
  runId,
  targetCwd,
  artifactRoot,
  specDigest,
  resumeRevisionDigest,
}) {
  if (!runId || !existsSync(journalLocation({ runId, targetCwd, artifactRoot }))) return null;
  const { journal } = new ConsumerFanoutArtifacts({ runId, targetCwd, artifactRoot });

  const fullyPinned = Boolean(journal.revisionDigest) && Boolean(journal.specDigest);
  if (!fullyPinned) {
    const hasWork = journal.issuances.length > 0
      || journal.worktrees.length > 0
      || journal.mergeTransactions.length > 0;
    if (hasWork) {
      throw new ConsumerArtifactError(
        'CONSUMER_RUN_REVISION_MISMATCH',
        `consumer journal for run ${runId} recorded work but is missing its revision pins `
          + `(revisionDigest=${journal.revisionDigest ?? 'null'}, specDigest=${journal.specDigest ?? 'null'}) `
          + `- cannot verify the local spec still describes it`,
        { runId, revisionDigest: journal.revisionDigest, specDigest: journal.specDigest, hasWork: true },
      );
    }
    return null;
  }

  if (journal.specDigest && specDigest && journal.specDigest !== specDigest) {
    throw new ConsumerArtifactError(
      'CONSUMER_RUN_REVISION_MISMATCH',
      `consumer pipeline spec changed since run ${runId} started: `
        + `recorded specDigest ${journal.specDigest}, current ${specDigest}`
        + (journal.revisionDigest ? ` (engine revision ${journal.revisionDigest})` : ''),
      {
        runId,
        recordedSpecDigest: journal.specDigest,
        currentSpecDigest: specDigest,
        revisionDigest: journal.revisionDigest,
      },
    );
  }

  if (journal.revisionDigest && resumeRevisionDigest && journal.revisionDigest !== resumeRevisionDigest) {
    throw new ConsumerArtifactError(
      'CONSUMER_RUN_REVISION_MISMATCH',
      `consumer engine revision changed since run ${runId} started: `
        + `journaled ${journal.revisionDigest}, resume ${resumeRevisionDigest}`,
      { runId, journaledRevisionDigest: journal.revisionDigest, resumeRevisionDigest },
    );
  }

  const stray = journal.issuances.find(
    (entry) => entry.revisionDigest
      && journal.revisionDigest
      && entry.revisionDigest !== journal.revisionDigest,
  );
  if (stray) {
    throw new ConsumerArtifactError(
      'CONSUMER_RUN_REVISION_MISMATCH',
      `consumer journal entry ${stray.dispatchToken} carries revision ${stray.revisionDigest}, `
        + `not the run revision ${journal.revisionDigest}`,
      { runId, entryRevisionDigest: stray.revisionDigest, revisionDigest: journal.revisionDigest },
    );
  }

  return journal;
}

/**
 * Resume-time cleanup for a process that died after gateResolve durably
 * advanced the engine but before Compose marked/released local artifacts.
 * Returns false without creating anything when the run has no consumer journal.
 */
export function recoverAdvancedConsumerArtifacts({
  runId,
  targetCwd,
  artifactRoot,
  audit,
}) {
  if (!runId || !existsSync(journalLocation({ runId, targetCwd, artifactRoot }))) return false;
  const artifacts = new ConsumerFanoutArtifacts({ runId, targetCwd, artifactRoot });
  let recoveredDecision = false;
  let approvedAdvanced = false;
  const gateEventOffsets = new Map();
  const gateEvents = (audit?.events ?? []).filter((event) => event?.type === 'gate_resolved');
  const terminal = ['completed', 'failed', 'budget_exhausted', 'killed', 'cancelled'].includes(audit?.status);
  for (const transaction of artifacts.journal.mergeTransactions) {
    const gateState = audit?.steps?.[transaction.gateStepId];
    const matchingGateEvents = gateEvents.filter(
      (event) => event.stepId === transaction.gateStepId,
    );
    const eventOffset = gateEventOffsets.get(transaction.gateStepId) ?? 0;
    const resolvedEvent = matchingGateEvents[eventOffset];
    gateEventOffsets.set(transaction.gateStepId, eventOffset + 1);
    const resolvedOutcome = transaction.gateOutcome ?? resolvedEvent?.detail?.decision;
    const approvedComplete = transaction.state === 'complete' && resolvedOutcome === 'approve';

    if (approvedComplete && gateState?.status !== 'waiting_gate') {
      transaction.gateOutcome = resolvedOutcome;
      transaction.gateResolvedAt ??= resolvedEvent?.at ?? now();
      recoveredDecision = true;
      approvedAdvanced = true;
    } else if (!transaction.gateOutcome && (terminal || (resolvedOutcome && resolvedOutcome !== 'approve'))) {
      // Recovery may only roll back an UNRESOLVED transaction — the round that was
      // interrupted mid-finalization. A transaction that already carries a
      // gateOutcome was resolved in a PRIOR round; its rollback/merge is durable
      // history, and re-restoring its stale baseline here would clobber a later
      // approved merge (the current target). restoreMergeBaseline reconciles any
      // restored evidence against the current audit before it is trusted.
      artifacts.restoreMergeBaseline(transaction, audit);
      if (resolvedOutcome) artifacts.markGateResolved(transaction, resolvedOutcome);
      recoveredDecision = recoveredDecision || Boolean(resolvedOutcome);
    }
  }
  if (approvedAdvanced || terminal) {
    artifacts.cleanupWorktrees(approvedAdvanced ? 'merge gate advanced before restart' : 'run terminalized before restart');
  }
  return recoveredDecision || terminal;
}
