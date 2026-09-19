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
import { normalizeOwnedPath, profilesDigest as digestJson } from './pipeline-profiles.js';
import { worktreeBaseFor, readCheckpointRef, prepareCheckpoint, publishCheckpoint, reconcileCheckpoint, WaveCheckpointError } from './wave-checkpoint.js';

import { validateRoutingRecord, validateRoutingJournal, initializeRoutingJournal, routingIssuanceState, validateRoutingStart, readRoutingStart, acquireRoutingLock, routingMetadataBundle, validateRoutingReceiptSpool, validateReceiptRouting, prepareRoutingResolution, latestRoutingCall, prepareRoutingOutcome, prepareEngineReceiptEvidence } from './routing-ledger.js';
import { readRoutingSnapshot } from './flow-state.js';
import { canonicalRoutingJson, routingRefuse, routingDigest } from './model-router.js';

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

// Module-level, journal-path-keyed one-writer guard shared by every
// ConsumerFanoutArtifacts instance on the same file. Combined with the
// mutate-against-fresh primitive (#mutate reloads the on-disk journal before
// applying a change), it guarantees no write is ever based on a stale snapshot.
const journalWriters = new Set();

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

export function withTemporaryIndex(cwd, fn) {
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

/** Enumerate the exact retained patch, never the worker's reported files_changed. */
function retainedPatchEvidence(cwd, baseCommit, diff) {
  return withTemporaryIndex(cwd, env => {
    git(cwd, ['read-tree', baseCommit], { env });
    if (diff) git(cwd, ['apply', '--cached', '--binary', '-'], { env, input: diff });
    const capturedTree = git(cwd, ['write-tree'], { env });
    // --no-renames gives delete/add endpoints; -z preserves whitespace and newlines.
    const changedPaths = git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', baseCommit, '--'],
      { env, trim: false }).split('\0').filter(Boolean);
    return { baseCommit, capturedTree, changedPaths };
  });
}
function checkOwnership(cwd, entry, { capture = false } = {}) {
  if (!entry.ownership && !Object.hasOwn(entry.itemBinding?.item ?? {}, 'files_owned')) return null;
  let allowedFiles = [];
  let evidence;
  let code = 'FILES_OWNED_VIOLATION';
  let files = [];
  try {
    if (!entry.itemBinding || entry.itemBinding.itemDigest !== digestJson(entry.itemBinding.item)) {
      code = 'OWNERSHIP_EVIDENCE_MISMATCH'; throw new Error('Item binding missing or digest differs');
    }
    const owned = entry.itemBinding?.item?.files_owned;
    if (!Array.isArray(owned)) throw new Error('files_owned must be an array');
    allowedFiles = owned.map(normalizeOwnedPath);
    if (typeof entry.diff !== 'string' || entry.diffDigest !== sha256(entry.diff) || !entry.ownership?.baseCommit) {
      code = 'OWNERSHIP_EVIDENCE_MISMATCH';
      throw new Error('Retained patch/base/digest missing or changed');
    }
    evidence = retainedPatchEvidence(cwd, entry.ownership.baseCommit, entry.diff);
    if (!capture && (evidence.capturedTree !== entry.ownership.capturedTree
      || digestJson(evidence.changedPaths) !== digestJson(entry.ownership.changedPaths))) {
      code = 'OWNERSHIP_EVIDENCE_MISMATCH';
      throw new Error('Retained patch tree/paths differ from capture');
    }
    files = evidence.changedPaths.filter(file => !allowedFiles.includes(file));
    if (!files.length) { if (capture) entry.ownership = evidence; return null; }
  } catch (error) {
    if (code !== 'FILES_OWNED_VIOLATION' || evidence === undefined && allowedFiles.length) code = 'OWNERSHIP_EVIDENCE_MISMATCH';
    files = evidence?.changedPaths ?? [];
    return { code, taskId: entry.itemBinding?.item?.id, stepId: entry.scopedId, itemIndex: entry.itemIndex,
      generation: entry.generation, dispatchToken: entry.dispatchToken, severity: 'error', files, allowedFiles,
      diffDigest: entry.diffDigest, message: error.message };
  }
  if (capture) entry.ownership = evidence;
  return { code, taskId: entry.itemBinding?.item?.id, stepId: entry.scopedId, itemIndex: entry.itemIndex,
    generation: entry.generation, dispatchToken: entry.dispatchToken, severity: 'error', files, allowedFiles,
    diffDigest: entry.diffDigest, message: `Task ${entry.itemBinding?.item?.id ?? entry.scopedId} changed unowned paths: ${files.join(', ')}` };
}

/**
 * Apply one lane's cumulative diff to a temporary index.
 *
 * `--3way`: every lane diffs against the SAME baseline, so once lane 1 has
 * landed, lane 2's hunks still carry baseline context. A plain `git apply`
 * rejects any hunk whose context line was touched by an earlier lane — even
 * when the edits themselves do not overlap (two lanes appending tests to the
 * same file, 2026-08-30: `patch failed: test/version-check.test.js:5`, four
 * paid revise rounds). Three-way falls back to merging against the recorded
 * preimage blobs (`index` lines in the diff), so only a genuine overlap fails.
 * A genuine conflict still throws: `git apply` exits non-zero and the temporary
 * index (with its conflict entries) is discarded by withTemporaryIndex.
 */
function applyDiffToIndex(cwd, diff, env) {
  git(cwd, ['apply', '--cached', '--3way', '--binary', '-'], {
    env,
    input: diff,
    timeout: 60_000,
  });
}

/** Working tree + one lane diff, merged in a temporary index; returns the tree id. */
function mergeDiffIntoWorkingTree(cwd, diff) {
  return withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', 'HEAD'], { env });
    git(cwd, ['add', '-A'], { env });
    applyDiffToIndex(cwd, diff, env);
    return git(cwd, ['write-tree'], { env });
  });
}

/**
 * Move the working tree from one snapshot tree to another WITHOUT `git clean`.
 *
 * A two-tree `read-tree -m -u` writes exactly the paths that differ between
 * the trees and leaves untracked and ignored content alone. restoreWorkingTree
 * (baseline restore) cleans first, which is right for a full reset but wrong
 * mid-merge: a lane that edits .gitignore makes previously ignored files
 * visible, and a clean under the new rules would delete files no snapshot ever
 * captured (Codex review of e98ea87, 2026-08-30). The real index is untouched.
 */
function checkoutTreeDelta(cwd, fromTree, toTree) {
  withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', fromTree], { env });
    // A freshly read index has no stat data, so every entry looks modified and
    // the two-tree merge refuses ("not uptodate"). Refresh against the working
    // tree, which matches fromTree by the witness check that precedes this.
    git(cwd, ['update-index', '-q', '--refresh'], { env });
    git(cwd, ['read-tree', '-m', '-u', fromTree, toTree], { env });
  });
}

/**
 * Rollback variant of checkoutTreeDelta for a working tree that may be
 * PARTIALLY written (a forward checkout that threw mid-way). `--reset -u`
 * rewrites every path listed in fromTree or toTree to its toTree state without
 * demanding an up-to-date worktree, and — unlike restoreWorkingTree — never
 * runs `git clean`, so untracked and ignored content is untouched (Codex r3).
 * fromTree must be a SUPERSET of anything the forward pass may have written.
 */
function rollbackTreeDelta(cwd, fromTree, toTree) {
  withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', fromTree], { env });
    git(cwd, ['read-tree', '--reset', '-u', toTree], { env });
  });
}

function computeWitnessChain(cwd, orderedEntries) {
  return withTemporaryIndex(cwd, (env) => {
    git(cwd, ['read-tree', 'HEAD'], { env });
    git(cwd, ['add', '-A'], { env });
    const chain = [git(cwd, ['write-tree'], { env })];
    for (const entry of orderedEntries) {
      if (entry.diff.length > 0) applyDiffToIndex(cwd, entry.diff, env);
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

export function routingJournalPath(options) { return journalLocation(options); }

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

/** Cancellation must never enter the merge-repair/revise decision channel. */
export class MergeAfterCancelError extends ConsumerArtifactError {
  constructor(message) {
    super('MERGE_AFTER_CANCEL', message);
    this.name = 'MergeAfterCancelError';
  }
}

export class ConsumerFanoutArtifacts {
  constructor({ runId, targetCwd, artifactRoot, hooks = {}, revisionDigest, specDigest, profilesDigest, routingBinding, routingAncestry, routingObservation = false }) {
    this._routingObservation = routingObservation;
    if (routingObservation && !routingBinding) routingRefuse('ROUTING_BINDING_MISSING', 'Observation requires a bound journal');
    this._routingAncestry = routingAncestry ? structuredClone(routingAncestry) : null;
    if (routingAncestry && !routingBinding) routingRefuse('ROUTING_BINDING_MISSING', 'Retained ancestry requires a run binding');
    this._routingBinding = routingBinding ? structuredClone(validateRoutingRecord(routingBinding)) : null;
    if (routingBinding && (routingBinding.type !== 'run-binding' || routingBinding.runId !== runId || (revisionDigest && routingBinding.revisionDigest !== revisionDigest))) routingRefuse('ROUTING_BINDING_DRIFT', 'Routing constructor binding differs');
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
    this._initialProfilesDigest = profilesDigest;
    this._initialSpecDigest = typeof specDigest === 'string' && specDigest.length > 0 ? specDigest : null;
    this.runRoot = join(this.artifactRoot, runDirectoryName(runId));
    this.journalPath = join(this.runRoot, 'journal.json');
    this.hooks = hooks ?? {};
    mkdirSync(this.runRoot, { recursive: true });
    const participating = this._routingBinding || (existsSync(this.journalPath) && JSON.parse(readFileSync(this.journalPath, 'utf8')).routing);
    const release = participating ? acquireRoutingLock(`${this.journalPath}.routing-lock`) : null;
    try { this.journal = this.#load(); } finally { release?.(); }
  }

  #writeGuarded(value) {
    // Module-level one-writer guard keyed by journal PATH — coordinates every
    // ConsumerFanoutArtifacts instance on the same file, not just this instance.
    if (journalWriters.has(this.journalPath)) {
      throw new ConsumerArtifactError(
        'JOURNAL_WRITER_REENTRY',
        `consumer journal already has an active writer: ${this.journalPath}`,
      );
    }
    journalWriters.add(this.journalPath);
    try {
      durableWriteJson(this.journalPath, value);
    } finally {
      journalWriters.delete(this.journalPath);
    }
  }

  /**
   * Single-source-of-truth mutation: apply a synchronous change to the CURRENT
   * on-disk journal, never to a possibly-stale in-memory base. Under the one-writer
   * guard: reload fresh from disk, run `fn` (which mutates `this.journal`), durably
   * write, and leave `this.journal` as exactly what was written. The in-memory model
   * is thereby a read cache only. Re-entrant: a nested mutation just runs against the
   * already-fresh `this.journal` and lets the outer write persist it.
   */
  #mutate(fn, { routing = false } = {}) {
    if (this._inMutation) return fn();
    if (journalWriters.has(this.journalPath)) {
      throw new ConsumerArtifactError(
        'JOURNAL_WRITER_REENTRY',
        `consumer journal already has an active writer: ${this.journalPath}`,
      );
    }
    journalWriters.add(this.journalPath);
    this._inMutation = true;
    let release;
    try {
      if (this._routingBinding || this.journal?.routing) release = acquireRoutingLock(`${this.journalPath}.routing-lock`);
      this.journal = this.#reload();
      const before = routing ? canonicalRoutingJson(this.journal) : null;
      const result = fn();
      if (this.journal.routing) {
        validateRoutingJournal(this.journal.routing, this._routingBinding ?? this.journal.routing.runBinding);
        validateRoutingReceiptSpool(this.journal, this.journalPath);
      }
      if (routing) {
        validateRoutingJournal(this.journal.routing, this._routingBinding ?? this.journal.routing?.runBinding);
        if (canonicalRoutingJson(this.journal) === before) return structuredClone(result);
        this.hooks.beforeRoutingWrite?.(structuredClone(this.journal));
      }
      this.journal.updatedAt = now();
      durableWriteJson(this.journalPath, this.journal);
      if (routing) this.hooks.afterRoutingWrite?.(structuredClone(this.journal));
      return routing ? structuredClone(result) : result;
    } finally {
      this._inMutation = false;
      try { release?.(); } finally { journalWriters.delete(this.journalPath); }
    }
  }

  #save() {
    this.journal.updatedAt = now();
    if (this._inMutation) {
      // Interim durable write within an active mutation (the guard is already held).
      durableWriteJson(this.journalPath, this.journal);
    } else {
      this.#writeGuarded(this.journal);
    }
  }

  #validateDeferredRouting(deferred, pin, token) {
    if (!deferred || pin.tokenIndex[token]) routingRefuse('ROUTING_BINDING_MISSING', 'Participating dispatch routing link missing');
    let start = this.routingContext?.start;
    if (!start) {
      const snapshot = readRoutingSnapshot(this.runId, { revisionDigest: pin.runBinding.revisionDigest, rootDigest: pin.rootDigest });
      start = readRoutingStart({ cwd: snapshot.workspaceRoot, startId: pin.startId, rootDigest: pin.rootDigest });
    }
    validateRoutingStart(start);
    const step = start.spec.effective.flows[deferred.flow]?.steps?.find(s => s.id === deferred.step);
    const stages = step?.fanout?.steps;
    if (start.rootDigest !== pin.rootDigest || !stages
      || !(stages.length > 1 || step.fanout.dispatch === 'engine')
      || !Number.isInteger(deferred.stage) || !stages[deferred.stage]) {
      routingRefuse('ROUTING_BINDING_MISSING', 'Participating dispatch requires a routing link');
    }
  }

  /** Read + validate + default + adopt-pins the existing on-disk journal. No write. */
  #reload() {
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
    if (this._routingBinding || journal.routing) {
      validateRoutingJournal(journal.routing, this._routingBinding ?? journal.routing?.runBinding);
      validateRoutingReceiptSpool(journal, this.journalPath);
      if (journal.routing.runBinding.runId !== this.runId) routingRefuse('ROUTING_BINDING_DRIFT', 'Journal/run binding identity differs');
      for (const [token, binding] of Object.entries(journal.dispatchBindings ?? {})) {
        if (!binding.routing) { this.#validateDeferredRouting(binding.deferred, journal.routing, token); continue; }
        const issuance = journal.routing.records[binding.routing.recordId];
        if (issuance?.type !== 'issuance' || journal.routing.tokenIndex[token] !== issuance.id) routingRefuse('ROUTING_BINDING_MISSING', 'Dispatch issuance/index missing');
        const expected = { rootDigest: issuance.rootDigest, recordId: issuance.id, admissionId: issuance.admissionId,
          logicalTaskId: issuance.logicalTaskId, logicalWaveId: issuance.logicalWaveId, logicalEpoch: issuance.logicalEpoch };
        if (canonicalRoutingJson(binding.routing) !== canonicalRoutingJson(expected)) routingRefuse('ROUTING_BINDING_DRIFT', 'Dispatch routing link differs');
      }
    }
    journal.revisionDigest ??= null;
    journal.specDigest ??= null;
    journal.gateBinding ??= null;
    journal.gateRetries ??= {};
    journal.worktrees ??= [];
    journal.witnesses ??= [];
    journal.issuances ??= [];
    journal.mergeTransactions ??= [];
    // Adopt constructor-supplied pins onto an EXISTING unpinned journal — a legacy
    // pre-pinning journal, or one first created at the gate path before this
    // manager was constructed. An already-pinned journal keeps its pins; a
    // constructor pin that DIFFERS from a persisted one is a real revision drift.
    if (this._initialRevisionDigest) {
      if (!journal.revisionDigest) journal.revisionDigest = this._initialRevisionDigest;
      else if (journal.revisionDigest !== this._initialRevisionDigest) {
        throw new ConsumerArtifactError(
          'CONSUMER_RUN_REVISION_MISMATCH',
          `consumer journal revision ${journal.revisionDigest} does not match run revision ${this._initialRevisionDigest}`,
          { journaledRevisionDigest: journal.revisionDigest, runRevisionDigest: this._initialRevisionDigest },
        );
      }
    }
    if (this._initialSpecDigest) {
      if (!journal.specDigest) journal.specDigest = this._initialSpecDigest;
      else if (journal.specDigest !== this._initialSpecDigest) {
        throw new ConsumerArtifactError(
          'CONSUMER_RUN_REVISION_MISMATCH',
          `consumer journal spec ${journal.specDigest} does not match local spec ${this._initialSpecDigest}`,
          { journaledSpecDigest: journal.specDigest, currentSpecDigest: this._initialSpecDigest },
        );
      }
    }
    if (this._initialProfilesDigest !== undefined) {
      if (journal.profilesDigest !== undefined && journal.profilesDigest !== this._initialProfilesDigest) {
        throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Consumer profiles changed');
      }
      if (journal.profilesDigest === undefined && (journal.issuances.length || journal.wave)) {
        throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Cannot add profiles to an active legacy run');
      }
      journal.profilesDigest = this._initialProfilesDigest;
    }
    return journal;
  }

  #load() {
    if (!existsSync(this.journalPath)) {
      const journal = {
        version: JOURNAL_VERSION,
        ...(this._routingBinding ? { routing: initializeRoutingJournal(this._routingBinding, this._routingAncestry) } : {}),
        ...(this._initialProfilesDigest !== undefined ? { profilesDigest: this._initialProfilesDigest } : {}),
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
        gateRetries: {},
        worktrees: [],
        witnesses: [],
        issuances: [],
        mergeTransactions: [],
      };
      if (journal.routing) this.hooks.beforeRoutingWrite?.(structuredClone(journal));
      this.#writeGuarded(journal);
      if (journal.routing) this.hooks.afterRoutingWrite?.(structuredClone(journal));
      return journal;
    }
    // Existing journal: reload (validates + adopts pins). Persist an adoption so a
    // legacy/gate-first-created journal is pinned even if no mutation follows.
    const before = readFileSync(this.journalPath, 'utf8');
    const journal = this.#reload();
    if ((this._initialRevisionDigest && journal.revisionDigest !== JSON.parse(before).revisionDigest)
      || (this._initialSpecDigest && journal.specDigest !== JSON.parse(before).specDigest)
      || (this._initialProfilesDigest !== undefined && journal.profilesDigest !== JSON.parse(before).profilesDigest)) {
      this.#writeGuarded(journal);
    }
    return journal;
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
      baseCommit: this.journal.wave
        ? (this.journal.waveAdmissions?.find(a => a.fanoutStepId === descriptor.step && a.epoch === (this.journal.dispatchBindings?.[descriptor.dispatchToken]?.itemBinding.epoch ?? descriptor.epoch))?.baseCommit
          ?? worktreeBaseFor({ journal: this.journal, ref: readCheckpointRef({ cwd: this.targetCwd, ref: this.journal.wave.ref }) }))
        : git(this.targetCwd, ['rev-parse', 'HEAD']),
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
  bindRunRevision({ revisionDigest, specDigest, profilesDigest }) {
    return this.#mutate(() => {
      if (profilesDigest !== undefined) {
        if (this.journal.profilesDigest !== undefined && this.journal.profilesDigest !== profilesDigest
          || this.journal.profilesDigest === undefined && (this.journal.issuances.length || this.journal.wave)) {
          throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Consumer profiles changed');
        }
        this.journal.profilesDigest = profilesDigest;
      }
      if (typeof revisionDigest === 'string' && revisionDigest.length > 0) {
        if (this.journal.revisionDigest === null) {
          this.journal.revisionDigest = revisionDigest;
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
      }
      return this.journal;
    });
  }

  /** Routing methods never create receipt state and never adopt a root into legacy journals. */
  #routingPut(record) {
    const routing = this.journal.routing;
    if (!routing) routingRefuse('ROUTING_BINDING_MISSING', 'Routing journal was not initialized');
    validateRoutingRecord(record, routing);
    const previous = Object.hasOwn(routing.records, record.id) ? routing.records[record.id] : null;
    if (record.type === 'outcome' && !previous && canonicalRoutingJson(prepareRoutingOutcome(routing, record.issuanceId)) !== canonicalRoutingJson(record)) routingRefuse('ROUTING_BINDING_DRIFT', 'Outcome must be derived from retained evidence');
    if (previous && canonicalRoutingJson(previous) !== canonicalRoutingJson(record)) routingRefuse(
      ['call-intent', 'call-resolution', 'call-evidence-head', 'unsupported-observation'].includes(record.type)
        ? 'ROUTING_CALL_EVIDENCE_CONFLICT' : 'ROUTING_BINDING_DRIFT', 'Immutable routing record changed');
    if (!previous) Object.defineProperty(routing.records, record.id, { value: structuredClone(record), enumerable: true, writable: true, configurable: true });
    return structuredClone(previous ?? record);
  }

  recordRoutingRecord(record) {
    if (record.type === 'issuance') return this.recordRoutingIssuance({ issuance: record });
    if (record.type === 'issuance-event') return this.recordRoutingEvent(record);
    return this.#mutate(() => this.#routingPut(record), { routing: true });
  }

  recordRoutingAdmissions(records) {
    return this.#mutate(() => {
      if (!Array.isArray(records) || records.some(r => r.type !== 'admission')) routingRefuse('ROUTING_SCHEMA_INVALID', 'Expected complete admission batch');
      for (const record of records) validateRoutingRecord(record, this.journal.routing);
      return records.map(record => this.#routingPut(record));
    }, { routing: true });
  }

  exportRoutingJournal() {
    this.journal = this.#reload();
    if (!this.journal.routing) routingRefuse('ROUTING_BINDING_MISSING', 'Routing journal is missing');
    return structuredClone(this.journal.routing);
  }

  recordRoutingOutcome(issuanceId) {
    return this.#mutate(() => {
      const routing = this.journal.routing;
      if (routing?.records[issuanceId]?.runId !== this.runId) routingRefuse('ROUTING_BINDING_MISSING', 'Outcome requires the original issuance owner');
      const result = this.#routingPut(prepareRoutingOutcome(routing, issuanceId));
      this.recordRoutingCheckpoint();
      return result;
    }, { routing: true });
  }

  openRoutingOwner(owner) {
    this.exportRoutingJournal();
    if (canonicalRoutingJson(this.journal.routing.records[owner.id]) !== canonicalRoutingJson(owner)) routingRefuse('ROUTING_BINDING_DRIFT', 'Owner locator was not retained');
    const artifactRoot = dirname(dirname(owner.journalLocator));
    if (join(artifactRoot, runDirectoryName(owner.ownerRunId), 'journal.json') !== owner.journalLocator || !existsSync(owner.journalLocator)) routingRefuse('ROUTING_BINDING_MISSING', 'Original owner journal missing');
    const routingBinding = this.journal.routing.runBinding.id === owner.runBindingId ? this.journal.routing.runBinding : this.journal.routing.records[owner.runBindingId];
    return new ConsumerFanoutArtifacts({ runId: owner.ownerRunId, targetCwd: this.targetCwd, artifactRoot, routingBinding, revisionDigest: owner.revisionDigest });
  }

  recordRoutingCheckpoint() {
    return this.#mutate(() => {
      const routing = this.journal.routing;
      const intents = Object.values(routing.records).filter(r => r.type === 'call-intent');
      const heads = intents.map(r => latestRoutingCall(routing, r.id).head?.id).filter(Boolean).sort();
      const outcomes = Object.values(routing.records).filter(r => r.type === 'outcome');
      const outcomeIds = outcomes.filter(r => !outcomes.some(next => next.previousOutcomeId === r.id)).map(r => r.id).sort();
      const payload = { ownerRunId: this.runId, heads, outcomeIds };
      return this.#routingPut({ schemaVersion: 1, type: 'evidence-checkpoint', startId: routing.startId, rootDigest: routing.rootDigest,
        id: routingDigest({ type: 'evidence-checkpoint', ...payload }), ...payload });
    }, { routing: true });
  }

  readRoutingRecord(id) {
    this.journal = this.#reload();
    if (!this.journal.routing || !Object.hasOwn(this.journal.routing.records, id)) routingRefuse('ROUTING_BINDING_MISSING', 'Expected routing record is missing');
    return structuredClone(this.journal.routing.records[id]);
  }

  recordRoutingIssuance({ issuance, prepareMetadata = this._routingObservation }) {
    if (prepareMetadata && !this.journal.routing?.records[issuance.id]) issuance = { ...issuance, observationVersion: 1 };
    return this.#mutate(() => {
      const routing = this.journal.routing;
      if (!routing) routingRefuse('ROUTING_BINDING_MISSING', 'Routing journal is missing');
      validateRoutingRecord(issuance, routing);
      if (issuance.type !== 'issuance') routingRefuse('ROUTING_SCHEMA_INVALID', 'Expected issuance record');
      const existing = Object.hasOwn(routing.tokenIndex, issuance.issuanceToken) ? routing.tokenIndex[issuance.issuanceToken] : null;
      if (existing && existing !== issuance.id) routingRefuse('ROUTING_BINDING_DRIFT', 'Issuance token already belongs to another record');
      const siblings = Object.values(routing.records).filter(r => r.type === 'issuance' && r.admissionId === issuance.admissionId && r.id !== issuance.id);
      if (!existing && siblings.length && !issuance.priorRecordId) routingRefuse('ROUTING_BINDING_MISSING', 'Reissuance must retain its prior record link');
      if (issuance.priorRecordId) {
        if (siblings.some(r => r.priorRecordId === issuance.priorRecordId)) routingRefuse('ROUTING_BINDING_DRIFT', 'Issuance chain cannot fork');
        const prior = routing.records[issuance.priorRecordId];
        if (!prior || prior.type !== 'issuance') routingRefuse('ROUTING_BINDING_MISSING', 'Prior issuance missing');
        if (prior.admissionId !== issuance.admissionId || prior.id === issuance.id) routingRefuse('ROUTING_BINDING_DRIFT', 'Retry must retain admission and change token');
        if (routingIssuanceState(routing, prior.id).state !== 'settled') routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Prior execution is unresolved');
      }
      const result = this.#routingPut(issuance);
      if (!existing) Object.defineProperty(routing.eventTips, issuance.id, { value: { count: 0, eventId: null }, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(routing.tokenIndex, issuance.issuanceToken, { value: issuance.id, enumerable: true, writable: true, configurable: true });
      if (prepareMetadata || issuance.observationVersion === 1) this.#prepareRoutingMetadata(issuance);
      return result;
    }, { routing: true });
  }

  #prepareRoutingMetadata(issuance) {
    if (issuance?.type !== 'issuance') routingRefuse('ROUTING_BINDING_MISSING', 'Metadata issuance missing');
    if (issuance.runId !== this.runId) routingRefuse('ROUTING_BINDING_DRIFT', 'Metadata belongs to the original owner');
    const existing = Object.values(this.journal.routing.records).find(r => r.type === 'issuance-metadata' && r.issuanceId === issuance.id);
    if (!existing && routingIssuanceState(this.journal.routing, issuance.id).state !== 'prepared') routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Historical launch cannot acquire a retroactive metadata certificate');
    const bundle = routingMetadataBundle(this.journal.routing, issuance, this.journalPath);
    this.#routingPut(bundle.owner); this.#routingPut(bundle.metadata);
    this.recordPendingUsageReceipt({ dispatchId: bundle.receipt.dispatchId, receipt: bundle.receipt });
    return bundle;
  }

  prepareRoutingMetadata(issuanceId) {
    return this.#mutate(() => this.#prepareRoutingMetadata(this.journal.routing.records[issuanceId]), { routing: true });
  }

  recordRoutingEvent(event) {
    return this.#mutate(() => {
      if (event.type !== 'issuance-event') routingRefuse('ROUTING_SCHEMA_INVALID', 'Expected execution event');
      const routing = this.journal.routing;
      if (!routing) routingRefuse('ROUTING_BINDING_MISSING', 'Routing journal is missing');
      const exists = Object.hasOwn(routing.records, event.id);
      const tip = routing.eventTips[event.issuanceId];
      if (!tip) routingRefuse('ROUTING_BINDING_MISSING', 'Event issuance tip missing');
      if (!exists && event.sequence !== tip.count) routingRefuse('ROUTING_BINDING_DRIFT', 'Event does not extend issuance tip');
      const record = this.#routingPut(event);
      if (!exists) routing.eventTips[event.issuanceId] = { count: tip.count + 1, eventId: event.id };
      routingIssuanceState(this.journal.routing, event.issuanceId);
      return record;
    }, { routing: true });
  }

  /** S1b primitives are invoked explicitly; existing runners do not install observers. */
  recordRoutingEvidence(records) {
    return this.#mutate(() => records.map(r => this.#routingPut(r)), { routing: true });
  }

  recordRoutingCallIntent({ binding, callSite, ...fields }) {
    return this.#mutate(() => {
      const routing = this.journal.routing;
      if (!routing || binding.ownerRunId !== this.runId || binding.ownerJournal !== this.journalPath) routingRefuse('ROUTING_BINDING_MISSING', 'Call needs original owner journal');
      if (typeof callSite !== 'string' || !callSite) routingRefuse('ROUTING_SCHEMA_INVALID', 'Call site is required');
      const prefix = `${canonicalRoutingJson([callSite, fields.purpose])}:`;
      const calls = Object.values(routing.records).filter(r => r.type === 'call-intent' && r.recordId === binding.recordId);
      if (calls.some(r => r.callSlot.startsWith(prefix) && (!latestRoutingCall(routing, r.id).resolution || latestRoutingCall(routing, r.id).resolution.outcome === 'unresolved'))) routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Unresolved invocation slot cannot be relaunched');
      if (binding.observationId && calls.length) routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Unsupported observation already owns an invocation; a new launch needs a distinct durable observation slot');
      const callSlot = `${prefix}${calls.filter(r => r.callSlot.startsWith(prefix)).length}`;
      const id = routingDigest({ type: 'call-intent', recordId: binding.recordId, callSlot });
      return this.#routingPut({ schemaVersion: 1, type: 'call-intent', id, ...binding, callSlot, ...fields });
    }, { routing: true });
  }

  recordRoutingCallResolution({ intentId, evidence, receipt = null }) {
    return this.#mutate(() => {
      const routing = this.journal.routing;
      const intent = routing?.records[intentId];
      if (!intent || intent.ownerRunId !== this.runId) routingRefuse('ROUTING_BINDING_MISSING', 'Resolution requires original owner');
      if (receipt) {
        this.recordPendingUsageReceipt({ dispatchId: receipt.dispatchId, receipt });
        const ref = { ownerRunId: this.runId, dispatchId: receipt.dispatchId, payloadDigest: routingDigest(receipt) };
        if (evidence.usageRef && canonicalRoutingJson(evidence.usageRef) !== canonicalRoutingJson(ref)) routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Receipt reference differs');
        evidence = { ...evidence, usageRef: ref };
      }
      const result = prepareRoutingResolution(routing, intentId, evidence);
      this.#routingPut(result.resolution); this.#routingPut(result.head);
      this.recordRoutingCheckpoint();
      return result.resolution;
    }, { routing: true });
  }

  /** Retain extracted engine receipt bytes; extraction hooks belong to D2. */
  recordRoutingEngineReceipt({ receipt, sequence, unsupportedReason, context = {} }) {
    return this.recordRoutingObservation({ unsupportedReason, context, evidenceSource: 'engine-receipt',
      evidenceRef: { ownerRunId: this.runId, dispatchId: receipt.dispatchId, sequence, payloadDigest: routingDigest(receipt) },
      engineReceiptEvidence: { ownerRunId: this.runId, sequence, receipt } });
  }

  recordRoutingObservation({ unsupportedReason, parentRecordId = null, parentIntentId = null, callSite, evidenceSource = 'connector', evidenceRef = null, engineReceiptEvidence = null, context = {} }) {
    return this.#mutate(() => {
      const routing = this.journal.routing;
      if (!routing) routingRefuse('ROUTING_BINDING_MISSING', 'Observation requires routing journal');
      const binding = routing.runBinding;
      const owner = { schemaVersion: 1, type: 'receipt-owner', startId: routing.startId, rootDigest: routing.rootDigest,
        id: routingDigest({ type: 'receipt-owner', runId: this.runId }), ownerRunId: this.runId,
        revisionDigest: binding.revisionDigest, journalLocator: this.journalPath, runBindingId: binding.id };
      this.#routingPut(owner);
      const identity = evidenceSource === 'engine-receipt' ? { receiptId: evidenceRef?.dispatchId } : { callSite, parentIntentId, unsupportedReason,
        scopedStep: context.scopedStep ?? null, stage: context.stage ?? null, epoch: context.epoch ?? null };
      if (evidenceSource !== 'engine-receipt' && (typeof callSite !== 'string' || !callSite)) routingRefuse('ROUTING_BINDING_MISSING', 'Observation requires a durable invocation/coverage slot');
      if (evidenceRef && evidenceRef.ownerRunId !== this.runId) routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Engine receipt belongs to another physical run');
      if (evidenceSource === 'engine-receipt' && !evidenceRef?.dispatchId) routingRefuse('ROUTING_BINDING_MISSING', 'Engine receipt identity missing');
      if (evidenceSource === 'engine-receipt') {
        if (!engineReceiptEvidence) {
          const retained = this.journal.pendingUsageReceipts?.find(p => p.dispatchId === evidenceRef.dispatchId);
          if (!retained || retained.state !== 'acknowledged') routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Engine reference lacks retained acknowledged receipt evidence');
          engineReceiptEvidence = { ownerRunId: this.runId, sequence: retained.seq ?? null, receipt: retained.receipt };
        }
        engineReceiptEvidence = prepareEngineReceiptEvidence(engineReceiptEvidence);
      }
      const id = routingDigest({ type: 'unsupported-observation', startId: routing.startId, ownerRunId: this.runId, ...identity });
      const physical = Object.fromEntries(['scopedStep', 'stage', 'epoch', 'itemIndex', 'generation', 'logicalWaveId', 'logicalTaskId', 'itemBindingRef'].map(k => [k, context[k] ?? null]));
      return this.#routingPut({ schemaVersion: 1, type: 'unsupported-observation', startId: routing.startId, rootDigest: routing.rootDigest, id, recordId: id,
        source: 'unsupported', unsupportedReason, ownerRunId: this.runId, ownerJournal: this.journalPath, issuanceId: null, issuanceToken: null,
        parentRecordId, parentIntentId, ...physical, evidenceSource, evidenceRef, engineReceiptEvidence, observedDispatchToken: context.issuanceToken ?? null,
        incompleteReasons: evidenceSource === 'engine-audit' ? ['engine-evidence-unavailable'] : [] });
    }, { routing: true });
  }

  pendingRoutingReceipts() {
    this.journal = this.#reload();
    if (!this.journal.routing) routingRefuse('ROUTING_BINDING_MISSING', 'Routing journal missing');
    return structuredClone((this.journal.pendingUsageReceipts ?? []).filter(p => p.receipt?.detail?.routing && p.state === 'pending'));
  }

  /** Additive v1 seam records: absent until explicitly enabled. */
  recordWaveAdmission(admission) {
    return this.#mutate(() => {
      if (!Array.isArray(admission.items) || !admission.inputDigest || !admission.baseCommit) {
        throw new ConsumerArtifactError('WAVE_INPUT_INVALID', 'Admission needs full items, digest and pinned base');
      }
      if (this.journal.wave && !this.journal.waveAdmissions?.some(a => a.fanoutStepId === admission.fanoutStepId && a.epoch === admission.epoch)) {
        const base = worktreeBaseFor({ journal: this.journal, ref: readCheckpointRef({ cwd: this.targetCwd, ref: this.journal.wave.ref }) });
        if (base !== admission.baseCommit) throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Admission base differs from published tip');
      }
      this.journal.waveAdmissions ??= [];
      const previous = this.journal.waveAdmissions.find(a => a.fanoutStepId === admission.fanoutStepId && a.epoch === admission.epoch);
      if (previous) {
        if (digestJson({ ...previous, validatedAt: null }) !== digestJson({ ...admission, validatedAt: null })) {
          throw new ConsumerArtifactError('WAVE_INPUT_INVALID', 'Recorded wave admission changed');
        }
        return previous;
      }
      const record = { ...structuredClone(admission), validatedAt: admission.validatedAt ?? now() };
      this.journal.waveAdmissions.push(record);
      return record;
    });
  }

  recordDispatchBinding({ dispatchToken, itemBinding, resolvedProfile, routing, deferred }) {
    return this.#mutate(() => {
      if (this.journal.profilesDigest !== undefined && resolvedProfile?.profilesDigest !== this.journal.profilesDigest) {
        throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Dispatch profile is not pinned to this run');
      }
      if (itemBinding.itemDigest !== digestJson(itemBinding.item)) {
        throw new ConsumerArtifactError('WAVE_INPUT_INVALID', 'Dispatch item digest differs');
      }
      this.journal.dispatchBindings ??= {};
      if (routing) {
        const issuance = this.journal.routing?.records[routing.recordId];
        if (!issuance || issuance.type !== 'issuance' || this.journal.routing.tokenIndex[dispatchToken] !== issuance.id) routingRefuse('ROUTING_BINDING_MISSING', 'Dispatch routing issuance/token missing');
        const expected = { rootDigest: issuance.rootDigest, recordId: issuance.id, admissionId: issuance.admissionId,
          logicalTaskId: issuance.logicalTaskId, logicalWaveId: issuance.logicalWaveId, logicalEpoch: issuance.logicalEpoch };
        if (canonicalRoutingJson(routing) !== canonicalRoutingJson(expected)) routingRefuse('ROUTING_BINDING_DRIFT', 'Dispatch routing link differs');
        for (const [field, value] of Object.entries(issuance.selected.resolution)) {
          if (!Object.hasOwn(resolvedProfile ?? {}, field) || canonicalRoutingJson(resolvedProfile[field]) !== canonicalRoutingJson(value)) routingRefuse('ROUTING_BINDING_DRIFT', 'Dispatch profile differs from immutable route');
        }
      } else if (this.journal.routing) {
        // A durable deferred identity is checked against the sealed spec on reads too.
        this.#validateDeferredRouting(deferred, this.journal.routing, dispatchToken);
      }
      const binding = { itemBinding: structuredClone(itemBinding), resolvedProfile: structuredClone(resolvedProfile), ...(routing ? { routing: structuredClone(routing) } : {}),
        ...(this.journal.routing && !routing ? { deferred: structuredClone(deferred) } : {}) };
      const previous = this.journal.dispatchBindings[dispatchToken];
      if (previous && digestJson(previous) !== digestJson(binding)) {
        throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Dispatch binding changed');
      }
      this.journal.dispatchBindings[dispatchToken] = binding;
      return binding;
    });
  }

  recordPendingUsageReceipt({ dispatchId, receipt }) {
    return this.#mutate(() => {
      if (receipt?.detail?.routing) {
        if (!this.journal.routing) routingRefuse('ROUTING_BINDING_MISSING', 'Routing receipt requires an owner journal');
        validateReceiptRouting(receipt.detail.routing, this.journal.routing);
        if (dispatchId !== receipt.dispatchId || receipt.detail.routing.ownerRunId !== this.runId) routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Receipt spool owner/id differs');
      }
      this.journal.pendingUsageReceipts ??= [];
      const existing = this.journal.pendingUsageReceipts.find(r => r.dispatchId === dispatchId);
      if (existing) {
        if (digestJson(existing.receipt) !== digestJson(receipt)) {
          throw new ConsumerArtifactError('CONSUMER_EVIDENCE_MISMATCH', 'Receipt payload changed on replay');
        }
        return existing;
      }
      const record = { dispatchId, receipt: structuredClone(receipt), state: 'pending' };
      this.journal.pendingUsageReceipts.push(record);
      return record;
    });
  }

  acknowledgeUsageReceipt({ dispatchId, seq, payloadDigest }) {
    return this.#mutate(() => {
      const receipt = this.journal.pendingUsageReceipts?.find(r => r.dispatchId === dispatchId);
      if (!receipt) throw new ConsumerArtifactError('CONSUMER_EVIDENCE_MISMATCH', 'Receipt intent is missing');
      if (payloadDigest !== undefined && routingDigest(receipt.receipt) !== payloadDigest) routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Acknowledgement payload differs');
      if (receipt.seq !== undefined && seq !== undefined && receipt.seq !== seq) routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Receipt sequence changed');
      receipt.state = 'acknowledged';
      if (seq !== undefined) receipt.seq = seq;
      return receipt;
    });
  }

  initializeWave({ ref, profilesDigest }) {
    return this.#mutate(() => {
      if (this.journal.wave) {
        if (this.journal.wave.ref !== ref || this.journal.wave.profilesDigest !== profilesDigest) {
          throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Wave configuration changed');
        }
        return this.journal.wave;
      }
      if (readCheckpointRef({ cwd: this.targetCwd, ref }) !== null) {
        throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Pre-existing unowned wave ref');
      }
      if (existsSync(resolve(this.targetCwd, git(this.targetCwd, ['rev-parse', '--git-path', 'MERGE_HEAD'])))
        || git(this.targetCwd, ['ls-files', '-u'])) throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Unresolved index merge');
      const baseCommit = git(this.targetCwd, ['rev-parse', 'HEAD']);
      this.journal.wave = { ref, baseCommit, baseTree: git(this.targetCwd, ['rev-parse', 'HEAD^{tree}']),
        initialWorkingTree: snapshotWorkingTree(this.targetCwd), profilesDigest, checkpoints: [] };
      return this.journal.wave;
    });
  }

  recordPreparedCheckpoint(checkpoint) {
    return this.#mutate(() => {
      const wave = this.journal.wave;
      if (!wave) throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Wave not initialized');
      const existing = wave.checkpoints.find(c => c.gateToken === checkpoint.gateToken);
      if (existing) {
        if (existing.commit !== checkpoint.commit || existing.tree !== checkpoint.tree) {
          throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Checkpoint token changed');
        }
        return existing;
      }
      const parent = wave.checkpoints.at(-1)?.commit ?? wave.baseCommit;
      if (checkpoint.parentCommit !== parent || checkpoint.waveNumber !== wave.checkpoints.length + 1
        || !checkpoint.gateToken || !Number.isInteger(checkpoint.gateOrdinal)) {
        throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Checkpoint order or identity differs');
      }
      const record = { ...structuredClone(checkpoint), state: 'prepared', preparedAt: now() };
      wave.checkpoints.push(record);
      return record;
    });
  }

  markCheckpointPublished({ gateToken, commit, evidenceReceiptId }) {
    return this.#mutate(() => {
      const checkpoint = this.journal.wave?.checkpoints.find(c => c.gateToken === gateToken);
      if (!checkpoint || checkpoint.commit !== commit
        || readCheckpointRef({ cwd: this.targetCwd, ref: this.journal.wave.ref }) !== commit) {
        throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Publication does not match prepared checkpoint');
      }
      this.#verifyCheckpointObject(checkpoint);
      checkpoint.state = 'published';
      checkpoint.publishedAt ??= now();
      checkpoint.materializedTree ??= checkpoint.tree;
      if (evidenceReceiptId) checkpoint.evidenceReceiptId = evidenceReceiptId;
      return checkpoint;
    });
  }

  /** Recover approved obligations only; never replay their patches into the live parent. */
  recoverCheckpoint(transaction) {
    const wave = this.journal.wave;
    if (!wave) return;
    let checkpoint = wave.checkpoints.find(c => c.gateToken === transaction.gateToken);
    const tip = readCheckpointRef({ cwd: this.targetCwd, ref: wave.ref });
    // A verified newer recorded tip must never be rewound to a historical checkpoint.
    const index = checkpoint ? wave.checkpoints.indexOf(checkpoint) : -1;
    if (checkpoint && (checkpoint.gateOrdinal !== transaction.gateOrdinal
      || checkpoint.gateStepId !== transaction.gateStepId || checkpoint.tree !== transaction.witnessChain.at(-1)
      || checkpoint.parentCommit !== transaction.checkpointParent)) {
      throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Checkpoint differs from its approved merge obligation');
    }
    for (const [i, recorded] of wave.checkpoints.entries()) {
      if (recorded.parentCommit !== (wave.checkpoints[i - 1]?.commit ?? wave.baseCommit)) {
        throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Recorded checkpoint chain is broken');
      }
    }
    if (index >= 0 && wave.checkpoints.slice(index + 1).some(c => c.state === 'published' && c.commit === tip)) {
      for (const recorded of wave.checkpoints.slice(index)) this.#verifyCheckpointObject(recorded);
      return;
    }
    if (!checkpoint) {
      const previous = wave.checkpoints.at(-1)?.commit ?? null;
      if (reconcileCheckpoint({ journalEntry: { gateOutcome: 'approve', previousCommit: previous }, refValue: tip }) !== 'PREPARE_AND_PUBLISH') {
        throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Unexpected ref before preparation');
      }
      if (!Number.isInteger(transaction.gateOrdinal)) throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Missing gate ordinal');
      const tree = transaction.witnessChain.at(-1);
      this.#verifyCheckpointReplay(transaction, tree);
      this.#materializeCheckpoint(transaction, tree);
      const prepared = prepareCheckpoint({ cwd: this.targetCwd, ref: wave.ref,
        parentCommit: transaction.checkpointParent ?? previous ?? wave.baseCommit, tree,
        message: `Compose wave ${wave.checkpoints.length + 1} run ${this.runId} gate ${transaction.gateToken}` });
      checkpoint = this.recordPreparedCheckpoint({ ...prepared, waveNumber: wave.checkpoints.length + 1,
        fanoutStepId: transaction.fanoutStepId, epoch: transaction.epoch, gateStepId: transaction.gateStepId,
        gateToken: transaction.gateToken, gateOrdinal: transaction.gateOrdinal, baselineTree: transaction.baselineTree,
        orderedDispatchTokens: transaction.acceptedDispatchTokens ?? transaction.orderedDiffs.map(d => d.dispatchToken) });
    }
    this.#verifyCheckpointObject(checkpoint);
    const action = reconcileCheckpoint({ journalEntry: checkpoint, refValue: tip });
    if (action === 'REPLAY_AND_PUBLISH') {
      if (checkpoint.payloadsDroppedAt) throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Checkpoint payloads were already cleaned');
      this.#materializeCheckpoint(transaction, checkpoint.tree);
      this.#verifyCheckpointReplay(transaction, checkpoint.tree);
      publishCheckpoint({ cwd: this.targetCwd, ref: wave.ref, expected: tip, commit: checkpoint.commit });
    } else if (!['MARK_PUBLISHED', 'ALREADY_PUBLISHED'].includes(action)) {
      throw new WaveCheckpointError(action, 'Cannot reconcile checkpoint ref');
    } else if (transaction.witnessChain.slice(0, -1).includes(snapshotWorkingTree(this.targetCwd))) {
      this.#materializeCheckpoint(transaction, checkpoint.tree);
    }
    this.markCheckpointPublished({ gateToken: checkpoint.gateToken, commit: checkpoint.commit });
  }

  #materializeCheckpoint(transaction, tree) {
    const live = snapshotWorkingTree(this.targetCwd);
    if (live === tree) return;
    if (transaction.witnessChain.includes(live)) {
      checkoutTreeDelta(this.targetCwd, live, tree);
      return;
    }
    const changed = git(this.targetCwd, ['diff', '--name-only', '-z', '--no-renames', tree, live, '--'], { trim: false }).split('\0').filter(Boolean);
    const wavePaths = new Set(git(this.targetCwd, ['diff', '--name-only', '-z', '--no-renames', transaction.baselineTree, tree, '--'],
      { trim: false }).split('\0').filter(Boolean));
    if (changed.some(path => wavePaths.has(path))) {
      throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Parent differs ambiguously from the integrated checkpoint');
    }
    // Independent post-wave edits are preserved; publication captures only the witness.
  }

  #verifyCheckpointReplay(transaction, expectedTree) {
    try {
      const tree = withTemporaryIndex(this.targetCwd, env => {
        git(this.targetCwd, ['read-tree', transaction.baselineTree], { env });
        for (const ordered of transaction.orderedDiffs) {
          if (typeof ordered.diff !== 'string' || sha256(ordered.diff) !== ordered.digest) throw new Error('Missing or changed retained patch');
          if (ordered.diff) applyDiffToIndex(this.targetCwd, ordered.diff, env);
        }
        return git(this.targetCwd, ['write-tree'], { env });
      });
      if (tree !== expectedTree) throw new Error('Replayed tree differs');
    } catch (error) { throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', error.message); }
  }

  #verifyCheckpointObject(checkpoint) {
    try {
      const object = git(this.targetCwd, ['cat-file', 'commit', checkpoint.commit], { trim: false });
      const boundary = object.indexOf('\n\n');
      const headers = object.slice(0, boundary).split('\n');
      const metadata = checkpoint.commitMetadata;
      const epoch = Math.floor(Date.parse(metadata.date) / 1000);
      const identity = `${metadata.authorName} <${metadata.authorEmail}> ${epoch} +0000`;
      const expectedHeaders = [`tree ${checkpoint.tree}`, `parent ${checkpoint.parentCommit}`,
        `author ${identity}`, `committer ${identity}`];
      if (digestJson(headers) !== digestJson(expectedHeaders)
        || object.slice(boundary + 2).replace(/\n$/, '') !== checkpoint.message.replace(/\n$/, '')) {
        throw new Error('Checkpoint identity/tree/parent/message differs');
      }
      git(this.targetCwd, ['cat-file', '-e', `${checkpoint.parentCommit}^{commit}`]);
      git(this.targetCwd, ['cat-file', '-e', `${checkpoint.tree}^{tree}`]);
    } catch (error) { throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', error.message); }
  }

  /** Record which fanout step a merge gate settles, so resume never re-derives it
   *  from a mutable local spec that may have drifted. First-write-wins per gate. */
  recordGateBinding({ gateStepId, fanoutStepId }) {
    if (!gateStepId || !fanoutStepId) return;
    this.#mutate(() => {
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
    });
  }

  /** Durable merge-gate retry state. The journal is the run-owned resume seam;
   *  Stratum's persisted flow is intentionally read-only from Compose. */
  gateRetryState(gateStepId) {
    if (existsSync(this.journalPath)) this.journal = this.#reload();
    const state = this.journal.gateRetries?.[gateStepId] ?? {};
    return {
      roundCount: Number.isInteger(state.roundCount) && state.roundCount >= 0 ? state.roundCount : 0,
      lastFailureFingerprint: typeof state.lastFailureFingerprint === 'string'
        ? state.lastFailureFingerprint
        : undefined,
    };
  }

  recordGateRetryState(gateStepId, update) {
    if (!gateStepId || !update || typeof update !== 'object') return this.gateRetryState(gateStepId);
    if (update.roundCount !== undefined
      && (!Number.isInteger(update.roundCount) || update.roundCount < 0)) {
      throw new ConsumerArtifactError('MERGE_GATE_RETRY_STATE_INVALID', 'merge gate round count must be a non-negative integer');
    }
    if (update.lastFailureFingerprint !== undefined
      && typeof update.lastFailureFingerprint !== 'string') {
      throw new ConsumerArtifactError('MERGE_GATE_RETRY_STATE_INVALID', 'merge gate failure fingerprint must be a string');
    }
    return this.#mutate(() => {
      this.journal.gateRetries ??= {};
      const existing = this.journal.gateRetries[gateStepId] ?? {};
      const next = {
        roundCount: Number.isInteger(existing.roundCount) && existing.roundCount >= 0
          ? existing.roundCount
          : 0,
        ...(typeof existing.lastFailureFingerprint === 'string'
          ? { lastFailureFingerprint: existing.lastFailureFingerprint }
          : {}),
      };
      if (update.roundCount !== undefined) next.roundCount = update.roundCount;
      if (update.lastFailureFingerprint !== undefined) {
        next.lastFailureFingerprint = update.lastFailureFingerprint;
      }
      this.journal.gateRetries[gateStepId] = next;
      return structuredClone(next);
    });
  }

  /**
   * Reconcile journal records against an audit. `scope` bounds which records may
   * be mutated: a per-item settlement (concurrent, possibly-stale snapshot) must
   * pass `{ fanoutStepId, itemIndex }` so it touches ONLY its own item's records —
   * an unordered stale snapshot from one item must never supersede another item's
   * newer issuance (C1). Global reconciliation (merge-gate discovery, resume
   * recovery) passes no scope and runs only at ordered, single-threaded points
   * with a fresh audit.
   */
  reconcileAudit(audit, scope = null) {
    return this.#mutate(() => this.#reconcileAuditInto(audit, scope));
  }

  #reconcileAuditInto(audit, scope) {
    const inScope = (fanoutStepId, itemIndex) => !scope
      || (scope.fanoutStepId === fanoutStepId && scope.itemIndex === itemIndex);
    let changed = false;
    for (const issuance of this.journal.issuances) {
      if (issuance.state === 'merged' || issuance.state === 'superseded' || issuance.state === 'failed') continue;
      if (!inScope(issuance.fanoutStepId, issuance.itemIndex)) continue;
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
      if (!inScope(worktree.fanoutStepId, worktree.itemIndex)) continue;
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
    return this.#mutate(() => {
      const binding = this.journal.dispatchBindings?.[descriptor.dispatchToken]?.itemBinding;
      if (isNoneIsolation(descriptor) && Object.hasOwn(binding?.item ?? {}, 'files_owned')) {
        throw new ConsumerArtifactError('WAVE_OWNERSHIP_INVALID', 'Ownership requires worktree isolation');
      }
      // Per-item settlement: the descriptor's audit is a concurrent snapshot that
      // may be stale for OTHER items, so reconcile only this item's own records.
      this.#reconcileAuditInto(audit, { fanoutStepId: descriptor.step, itemIndex: descriptor.itemIndex });
      const prepared = this.journal.issuances.find(
        (entry) => entry.dispatchToken === descriptor.dispatchToken,
      );
      if (prepared?.state === 'prepared' || prepared?.state === 'failed') {
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
      return { action: 'execute', worktree: worktree.path, witness: newWitness, restored: false };
    });
  }

  /**
   * Restore a still-ready issuance's worktree to its pre-stage witness. Used when
   * the agent/connector threw mid-stage: the retry (or the failure report) must
   * start from the clean pre-stage snapshot, not a half-mutated worktree.
   * Returns false when there is nothing to restore (no worktree or no witness).
   */
  restoreToPreStageWitness(descriptor) {
    return this.#mutate(() => {
      const worktree = this.#worktreeFor(descriptor);
      const witness = this.journal.witnesses.find(
        (entry) => entry.dispatchToken === descriptor.dispatchToken,
      );
      if (!worktree || !witness || !existsSync(worktree.path)) return false;
      restoreWorkingTree(worktree.path, witness.witnessTree);
      witness.restoredAt = now();
      witness.restoreCount = (witness.restoreCount ?? 0) + 1;
      return true;
    });
  }

  prepareIssuance(descriptor, envelope, { finalStage, itemBinding, resolvedProfile, ownership } = {}) {
    return this.#mutate(() => {
      const existing = this.journal.issuances.find(
        (entry) => entry.dispatchToken === descriptor.dispatchToken,
      );
      if (existing) return existing;

      const binding = itemBinding ?? this.journal.dispatchBindings?.[descriptor.dispatchToken]?.itemBinding
        ?? (ownership ? {
          item: structuredClone(descriptor.item ?? {}), itemDigest: digestJson(descriptor.item ?? {}),
          epoch: descriptor.epoch, sourceProvenance: 'descriptor.item',
        } : undefined);
      const ownershipEnabled = ownership || Object.hasOwn(binding?.item ?? {}, 'files_owned');
      const profile = resolvedProfile ?? this.journal.dispatchBindings?.[descriptor.dispatchToken]?.resolvedProfile;
      const fields = { ...(binding ? { itemBinding: structuredClone(binding) } : {}),
        ...(profile ? { resolvedProfile: structuredClone(profile) } : {}) };
      if (isNoneIsolation(descriptor)) {
        if (ownership || Object.hasOwn(binding?.item ?? {}, 'files_owned')) {
          throw new ConsumerArtifactError('WAVE_OWNERSHIP_INVALID', 'Ownership requires worktree isolation');
        }
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
          ...fields,
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
        ...fields,
        ...(ownershipEnabled && finalStage ? { ownership: { baseCommit: worktree.baseCommit } } : {}),
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
      if (finalStage && ownershipEnabled) {
        const finding = checkOwnership(this.targetCwd, entry, { capture: true });
        if (finding) this.#failOwnership(entry, finding);
      }
      this.journal.issuances.push(entry);
      return entry;
    });
  }

  #failOwnership(entry, finding) {
    entry.state = 'failed';
    entry.findings ??= [];
    if (!entry.findings.some(f => f.code === finding.code && f.message === finding.message)) entry.findings.push(finding);
    entry.ownership ??= {};
    entry.ownership.finding = finding;
    entry.envelope = { ...entry.envelope, failure: `${finding.code}: ${finding.message}` };
    delete entry.envelope.output;
  }

  #verifyOwnership(entry, ordered) {
    let finding = checkOwnership(this.targetCwd, entry);
    if (entry.itemBinding && ordered && (ordered.diff !== entry.diff || ordered.digest !== entry.diffDigest
      || ordered.bindingDigest !== digestJson(entry.itemBinding))) {
      finding = { code: 'OWNERSHIP_EVIDENCE_MISMATCH', message: 'Ordered patch/binding differs from captured issuance',
        dispatchToken: entry.dispatchToken, severity: 'error', files: [], allowedFiles: entry.itemBinding.item?.files_owned ?? [] };
    }
    if (finding) {
      this.#failOwnership(entry, finding);
      this.#save();
      throw new ConsumerMergeDecisionError(finding.code, finding.message, { finding });
    }
  }

  prepareArtifactFailure(descriptor, envelope, error) {
    return this.#mutate(() => {
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
      return entry;
    });
  }

  acceptedEntriesFor(fanoutStepId) {
    return this.journal.issuances
      .filter((entry) => entry.fanoutStepId === fanoutStepId && entry.state === 'accepted')
      .sort((a, b) => a.itemIndex - b.itemIndex
        || a.scopedId.localeCompare(b.scopedId)
        || a.generation - b.generation);
  }

  prepareMerge({ gateStepId, gateToken, fanoutStepId, audit }) {
    return this.#mutate(() => {
    this.#reconcileAuditInto(audit, null);
    const existing = this.journal.mergeTransactions.find((entry) => entry.gateToken === gateToken);
    if (existing?.state === 'blocked') {
      throw new ConsumerMergeDecisionError(
        existing.failureCode ?? 'MERGE_TRANSACTION_BLOCKED',
        existing.failure ?? 'consumer merge transaction is blocked',
        { gateToken },
      );
    }
    if (existing) {
      for (const ordered of existing.orderedDiffs ?? []) {
        const issuance = this.journal.issuances.find(e => e.dispatchToken === ordered.dispatchToken);
        if (issuance) this.#verifyOwnership(issuance, ordered);
      }
      return existing;
    }

    const accepted = this.acceptedEntriesFor(fanoutStepId);
    // Only isolation:worktree items own a diff and participate in the merge.
    // isolation:none items already wrote in the target cwd; they are accepted
    // evidence but owe no diff (a pure-none fanout yields zero ordered diffs).
    const worktreeAccepted = accepted.filter((entry) => entry.isolation !== 'none');
    for (const entry of worktreeAccepted) this.#verifyOwnership(entry);
    const baselineTree = snapshotWorkingTree(this.targetCwd);
    // A worker that changed NOTHING owes an empty diff, not a missing one, and it
    // must not join the merge: applying nothing leaves the tree identical, so its
    // witness entry repeats its predecessor and the uniqueness check below fires
    // — blocking a merge whose only fault is that one worker had nothing to do.
    // That is the normal outcome whenever a task is fanned out more ways than it
    // divides (observed: 2 workers on a 2-edit single-file doc change, one
    // no-op). computeWitnessChain already skips `apply` for a zero-length diff;
    // it just pushed a tree anyway, so the intent was there and the chain wasn't.
    //
    // Filtered AFTER the completeness accounting below reads `worktreeAccepted`,
    // so a NULL diff (never captured — a real fault) still fails there. Empty and
    // absent are different things and stay that way.
    const mergeParticipants = worktreeAccepted.filter((entry) => (entry.diff?.length ?? 0) > 0);
    const orderedDiffs = mergeParticipants.map((entry) => ({
      dispatchToken: entry.dispatchToken,
      scopedId: entry.scopedId,
      itemIndex: entry.itemIndex,
      generation: entry.generation,
      digest: entry.diffDigest,
      ...(entry.itemBinding ? { bindingDigest: digestJson(entry.itemBinding) } : {}),
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
      witnessChain = computeWitnessChain(this.targetCwd, mergeParticipants);
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
      ...(this.journal.wave ? {
        epoch: audit?.steps?.[fanoutStepId]?.epoch,
        checkpointParent: this.journal.wave.checkpoints.at(-1)?.commit ?? this.journal.wave.baseCommit,
        acceptedDispatchTokens: worktreeAccepted.map(e => e.dispatchToken),
        gateOrdinal: (audit?.events ?? []).filter(e => e.type === 'gate_resolved' && e.stepId === gateStepId).length,
      } : {}),
      baselineTree,
      witnessChain,
      orderedDiffs,
      recovery: { baselineRestores: 0 },
      preparedAt: now(),
    };
    this.journal.mergeTransactions.push(transaction);
    // One durable record contains the entire token/order/diff/witness chain
    // before any target working-tree mutation occurs.
    return transaction;
    });
  }

  /** A merge round is "decided" once another party has recorded its gate outcome
   *  or rolled its baseline back. applyMerge must never write over that. */
  #assertMergeNotDecided(tx, gateToken) {
    if (tx.gateOutcome !== undefined || tx.state === 'rolled_back') {
      throw new ConsumerMergeDecisionError(
        'MERGE_TRANSACTION_DECIDED',
        `consumer merge ${gateToken} was already resolved (${tx.gateOutcome ?? tx.state}) `
          + `by another party; refusing to apply/record over a decided round`,
        { gateToken, gateOutcome: tx.gateOutcome, state: tx.state },
      );
    }
  }

  #currentTransaction(gateToken) {
    if (existsSync(this.journalPath)) this.journal = this.#reload();
    return this.journal.mergeTransactions.find((entry) => entry.gateToken === gateToken);
  }

  async applyMerge(transaction) {
    const gateToken = transaction.gateToken;
    let current = this.#currentTransaction(gateToken);
    if (!current) {
      throw new ConsumerMergeDecisionError(
        'MERGE_TRANSACTION_MISSING', `consumer merge transaction ${gateToken} is missing`, { gateToken },
      );
    }
    if (current.state === 'blocked') {
      throw new ConsumerMergeDecisionError(
        current.failureCode ?? 'MERGE_TRANSACTION_BLOCKED',
        current.failure ?? 'consumer merge transaction is blocked', { gateToken },
      );
    }
    this.#assertMergeNotDecided(current, gateToken);
    // The plan (baseline, witness chain, ordered diffs) is immutable after
    // prepareMerge; the mutable lifecycle state is re-read from the fresh journal
    // at every write below so applyMerge never writes over a concurrent decision.
    const { witnessChain, baselineTree, orderedDiffs } = current;

    if (current.state === 'complete') {
      const completedTree = snapshotWorkingTree(this.targetCwd);
      if (completedTree === witnessChain.at(-1)) return current;
      // A completed journal with a non-final working tree means the process died
      // before gate resolution and the target changed afterward. Re-enter the same
      // prefix/unmatched recovery algorithm instead of trusting state.
      this.#mutate(() => {
        const tx = this.journal.mergeTransactions.find((e) => e.gateToken === gateToken);
        if (!tx) return;
        this.#assertMergeNotDecided(tx, gateToken);
        tx.state = 'prepared';
        tx.recovery ??= { baselineRestores: 0 };
        tx.recovery.completedTreeMismatch = completedTree;
        tx.recovery.completedTreeMismatchAt = now();
      });
    }
    let currentTree = snapshotWorkingTree(this.targetCwd);
    let prefix = witnessChain.indexOf(currentTree);
    if (prefix < 0) {
      restoreWorkingTree(this.targetCwd, baselineTree);
      this.#mutate(() => {
        const tx = this.journal.mergeTransactions.find((e) => e.gateToken === gateToken);
        if (!tx) return;
        this.#assertMergeNotDecided(tx, gateToken);
        tx.recovery ??= { baselineRestores: 0 };
        tx.recovery.baselineRestores = (tx.recovery.baselineRestores ?? 0) + 1;
        tx.recovery.lastUnmatchedTree = currentTree;
        tx.recovery.lastRestoredAt = now();
      });
      currentTree = snapshotWorkingTree(this.targetCwd);
      if (currentTree !== baselineTree) {
        throw new ConsumerMergeDecisionError(
          'MERGE_BASELINE_RESTORE_FAILED',
          `consumer merge baseline verification failed: expected ${baselineTree}, got ${currentTree}`,
        );
      }
      prefix = 0;
    }

    for (let orderedIndex = prefix; orderedIndex < orderedDiffs.length; orderedIndex += 1) {
      const ordered = orderedDiffs[orderedIndex];
      // Tree the working tree's TRACKED content currently equals (by witness).
      let trackedTree = witnessChain[orderedIndex];
      try {
        if (typeof this.hooks.insideDiffApply === 'function') {
          await this.hooks.insideDiffApply({
            cwd: this.targetCwd,
            orderedIndex,
            orderedDiff: structuredClone(ordered),
            transaction: structuredClone(current),
          });
        }
        // Re-read the transaction fresh and refuse if the round was decided
        // (rolled back / gate resolved) by another party — checked AFTER the await
        // above and immediately BEFORE mutating the working tree, so a stale diff is
        // NEVER applied over a decided round (which the gate rollback would then
        // clobber). In-process this is fully sealed: production applyMerge has no
        // awaits between this check and the apply. Two truly concurrent PROCESSES
        // retain an inherent TOCTOU window here — there is no OS-level journal lock;
        // cross-process concurrent merge relies on the run's single-owner assumption,
        // not a lockfile in this slice.
        const live = this.#currentTransaction(gateToken);
        if (live) this.#assertMergeNotDecided(live, gateToken);
        this.#mutate(() => {
          const issuance = this.journal.issuances.find(e => e.dispatchToken === ordered.dispatchToken);
          if (issuance) this.#verifyOwnership(issuance, ordered);
        });
        // Same merge algorithm as the witness precompute (temporary index,
        // three-way), then the merged tree is checked out. Applying straight to
        // the working tree cannot use --3way (it requires the real index to match).
        const mergedTree = mergeDiffIntoWorkingTree(this.targetCwd, ordered.diff);
        // Mark the merged tree as written BEFORE the checkout starts: if the
        // checkout throws part-way, the rollback still knows every path it may
        // have touched. A rollback must transition from that tree, never from a
        // fresh snapshot (which would reclassify newly un-ignored files as
        // tracked and delete them on the way back to baseline — Codex r2/r3).
        trackedTree = mergedTree;
        checkoutTreeDelta(this.targetCwd, witnessChain[orderedIndex], mergedTree);
        const landedTree = snapshotWorkingTree(this.targetCwd);
        const expectedTree = witnessChain[orderedIndex + 1];
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
        // The pre-apply DECIDED guard throws before touching the tree; propagate it
        // as-is (no baseline restore / block) rather than mislabeling it as an
        // apply failure over a round another party already owns.
        if (error instanceof ConsumerMergeDecisionError) throw error;
        // Roll back by tree delta from the last tree we may have WRITTEN, never
        // by clean and never from a fresh snapshot: the failing lane may have
        // just un-ignored files that no snapshot holds. Reset-style so a
        // partially written checkout rolls back too.
        rollbackTreeDelta(this.targetCwd, trackedTree, baselineTree);
        const restored = snapshotWorkingTree(this.targetCwd);
        if (restored !== baselineTree) {
          throw new Error(`consumer merge rollback verification failed: expected ${baselineTree}, got ${restored}`);
        }
        const failure = `consumer merge apply failed and baseline was restored: ${error.message}`;
        this.#mutate(() => {
          const tx = this.journal.mergeTransactions.find((e) => e.gateToken === gateToken);
          // Never overwrite a concurrent decision, even on the error path.
          if (!tx || tx.gateOutcome !== undefined || tx.state === 'rolled_back') return;
          tx.state = 'blocked';
          tx.failureCode = 'MERGE_APPLY_FAILED';
          tx.failure = failure;
          tx.recovery ??= { baselineRestores: 0 };
          tx.recovery.baselineRestores = (tx.recovery.baselineRestores ?? 0) + 1;
          tx.recovery.lastRestoredAt = now();
        });
        throw new ConsumerMergeDecisionError(
          'MERGE_APPLY_FAILED',
          failure,
          { cause: error },
        );
      }
    }

    const finalTree = snapshotWorkingTree(this.targetCwd);
    const expectedFinal = witnessChain.at(-1);
    if (finalTree !== expectedFinal) {
      throw new ConsumerMergeDecisionError(
        'MERGE_FINAL_WITNESS_MISMATCH',
        `consumer merge final tree ${finalTree} does not match ${expectedFinal}`,
      );
    }
    return this.#mutate(() => {
      const tx = this.journal.mergeTransactions.find((e) => e.gateToken === gateToken);
      if (!tx) {
        throw new ConsumerMergeDecisionError(
          'MERGE_TRANSACTION_MISSING', `consumer merge transaction ${gateToken} is missing`, { gateToken },
        );
      }
      // STOP rather than record a merge over a round decided since we started.
      this.#assertMergeNotDecided(tx, gateToken);
      tx.state = 'complete';
      tx.completedAt = now();
      for (const ordered of orderedDiffs) {
        const issuance = this.journal.issuances.find(
          (entry) => entry.dispatchToken === ordered.dispatchToken,
        );
        if (issuance && issuance.state === 'accepted') {
          issuance.state = 'merged';
          issuance.mergedAt = now();
        }
      }
      return tx;
    });
  }

  restoreMergeBaseline(transaction, audit, opts = {}) {
    if (!transaction) return undefined;
    return this.#mutate(() => {
      // Re-find against the fresh journal — the passed reference may predate a
      // concurrent instance's writes; we mutate what is CURRENTLY on disk.
      const tx = this.journal.mergeTransactions.find((entry) => entry.gateToken === transaction.gateToken);
      if (!tx) return undefined;
      const wasBlocked = tx.state === 'blocked';
      restoreWorkingTree(this.targetCwd, tx.baselineTree);
      tx.state = wasBlocked ? 'blocked' : 'rolled_back';
      tx.rolledBackAt = now();
      tx.rollbackReason = opts.reason ?? null;
      tx.recovery ??= { baselineRestores: 0 };
      tx.recovery.baselineRestores = (tx.recovery.baselineRestores ?? 0) + 1;
      tx.recovery.baselineVerifiedTree = tx.baselineTree;
      tx.recovery.baselineVerifiedAt = now();
      // Rolling back un-applies this transaction's diffs from the target, so any
      // issuance it marked `merged` (a crash between applyMerge and gateResolve) is
      // no longer merged. Restore merge eligibility (`merged` -> `accepted`) so a
      // non-re-enumerating repair round can merge it again — BUT reconcile each
      // restored entry against the CURRENT audit (ground truth). An entry whose
      // item index no longer exists in the current generation, or whose generation
      // or accepted token is stale, is superseded, NEVER resurrected as an accepted
      // diff. Without the audit the entry is only restored if it was mid-flight.
      for (const ordered of tx.orderedDiffs ?? []) {
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
      return tx;
    });
  }

  /** C40: a failed restore callback writes nothing. Persist its finding through
   * a separate guarded mutation, reloading the durable transaction first. */
  markRollbackFailed(transaction, error) {
    if (!transaction) return undefined;
    return this.#mutate(() => {
      const tx = this.journal.mergeTransactions.find((entry) => entry.gateToken === transaction.gateToken);
      if (!tx) return undefined;
      tx.state = 'rollback_failed';
      tx.failureCode = 'merge_revert_failed';
      tx.failure = error?.message ?? String(error);
      return tx;
    });
  }

  markGateResolved(transaction, outcome) {
    if (!transaction) return undefined;
    return this.#mutate(() => {
      const tx = this.journal.mergeTransactions.find((entry) => entry.gateToken === transaction.gateToken);
      if (!tx) return undefined;
      tx.gateOutcome = outcome;
      tx.gateResolvedAt = now();
      // Supersession is driven by re-enumeration, NOT by the gate outcome (see F1).
      return tx;
    });
  }

  /** Recovery-only: record that a completed transaction's gate advanced (approve)
   *  without re-running its merge, expressed as a change to the fresh journal. */
  markGateAdvanced({ gateToken, outcome, at }) {
    return this.#mutate(() => {
      const tx = this.journal.mergeTransactions.find((entry) => entry.gateToken === gateToken);
      if (!tx) return undefined;
      tx.gateOutcome = outcome;
      tx.gateResolvedAt ??= at ?? now();
      return tx;
    });
  }

  cleanupWorktrees(reason, { dispatchTokens } = {}) {
    this.#mutate(() => {
      const selected = dispatchTokens ? new Set(dispatchTokens) : null;
      const eligible = token => {
        if (selected && !selected.has(token)) return false;
        if (!this.journal.wave) return true;
        return this.journal.wave.checkpoints.some(c => c.state === 'published' && c.evidenceReceiptId
          && c.orderedDispatchTokens.includes(token));
      };
      const worktreeKeys = new Set(this.journal.issuances.filter(e => eligible(e.dispatchToken)).map(e => e.worktreeKey));
      for (const record of this.journal.worktrees) {
        if (record.cleanedAt || (selected || this.journal.wave) && !worktreeKeys.has(record.key)) continue;
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
        if (eligible(issuance.dispatchToken) && typeof issuance.diff === 'string') {
          issuance.diff = null;
          issuance.diffDroppedAt = now();
        }
      }
      for (const checkpoint of this.journal.wave?.checkpoints ?? []) {
        if (checkpoint.state === 'published' && checkpoint.evidenceReceiptId
          && checkpoint.orderedDispatchTokens.every(eligible)) checkpoint.payloadsDroppedAt ??= now();
      }
      for (const transaction of this.journal.mergeTransactions) {
        for (const ordered of transaction.orderedDiffs ?? []) {
          if (eligible(ordered.dispatchToken) && typeof ordered.diff === 'string') ordered.diff = null;
        }
        if (transaction.orderedDiffs?.length > 0 && transaction.orderedDiffs.every(d => d.diff === null) && !transaction.diffPayloadsDroppedAt) {
          transaction.diffPayloadsDroppedAt = now();
        }
      }
    });
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
  profilesDigest,
}) {
  if (!runId || !existsSync(journalLocation({ runId, targetCwd, artifactRoot }))) return null;
  const { journal } = new ConsumerFanoutArtifacts({ runId, targetCwd, artifactRoot });

  if ((journal.profilesDigest !== undefined || profilesDigest !== undefined) && journal.profilesDigest !== profilesDigest) {
    throw new ConsumerArtifactError('CONSUMER_PROFILE_REVISION_MISMATCH', 'Consumer profiles differ from the pinned run',
      { recorded: journal.profilesDigest, current: profilesDigest });
  }
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
    const eventOffset = transaction.gateOrdinal ?? gateEventOffsets.get(transaction.gateStepId) ?? 0;
    const resolvedEvent = matchingGateEvents[eventOffset];
    gateEventOffsets.set(transaction.gateStepId, eventOffset + 1);
    const resolvedOutcome = transaction.gateOutcome ?? resolvedEvent?.detail?.decision;
    const approvedComplete = transaction.state === 'complete' && resolvedOutcome === 'approve';

    if (approvedComplete && (artifacts.journal.wave || gateState?.status !== 'waiting_gate')) {
      if (artifacts.journal.wave) artifacts.recoverCheckpoint(transaction);
      artifacts.markGateAdvanced({ gateToken: transaction.gateToken, outcome: resolvedOutcome, at: resolvedEvent?.at });
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
