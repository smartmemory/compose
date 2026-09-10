/** Git object/ref plumbing. Never checks out a branch or changes the real index. */
import { execFileSync } from 'node:child_process';
import { withTemporaryIndex, snapshotWorkingTree } from './consumer-fanout.js';

export class WaveCheckpointError extends Error {
  constructor(code, message) { super(message); this.name = 'WaveCheckpointError'; this.code = code; }
}
const fail = (code, message) => { throw new WaveCheckpointError(code, message); };
function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 512 * 1024 * 1024, ...opts }).trim();
}
function symbolicRef(cwd, ref) {
  try { return git(cwd, ['symbolic-ref', '-q', ref]); }
  catch (error) { if (error.status === 1) return null; throw error; }
}
function validateRef(cwd, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/compose/wave/')) fail('WAVE_CHECKPOINT_DIVERGED', 'Expected a Compose wave ref');
  try { git(cwd, ['check-ref-format', ref]); }
  catch { fail('WAVE_CHECKPOINT_DIVERGED', 'Invalid wave ref'); }
  if (symbolicRef(cwd, ref)) fail('WAVE_CHECKPOINT_DIVERGED', 'Symbolic wave refs are not allowed');
  // Include other linked worktrees: updating their checked-out branch moves HEAD too.
  const worktrees = git(cwd, ['worktree', 'list', '--porcelain']);
  if (worktrees.split('\n').includes(`branch ${ref}`)) fail('WAVE_CHECKPOINT_DIVERGED', 'Wave ref is checked out in a worktree');
}
export function readCheckpointRef({ cwd, ref }) {
  validateRef(cwd, ref);
  try { return git(cwd, ['show-ref', '--verify', '--hash', ref]); }
  catch (error) { if (error.status === 1 || error.status === 128 && /not a valid ref/.test(error.stderr?.toString())) return null; throw error; }
}
export function prepareCheckpoint({ cwd, ref, parentCommit, tree, workingTree, message, commitMetadata }) {
  validateRef(cwd, ref);
  if (typeof parentCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(parentCommit)) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Parent must be a commit OID');
  const parent = git(cwd, ['rev-parse', '--verify', `${parentCommit}^{commit}`]);
  const capturedTree = tree ?? (workingTree === true ? snapshotWorkingTree(cwd) : workingTree);
  if (!capturedTree) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Checkpoint needs a tree or workingTree:true');
  const treeId = git(cwd, ['rev-parse', '--verify', `${capturedTree}^{tree}`]);
  const metadata = structuredClone(commitMetadata ?? {
    authorName: git(cwd, ['config', 'user.name']), authorEmail: git(cwd, ['config', 'user.email']),
    date: new Date().toISOString(),
  });
  if (!metadata.authorName || !metadata.authorEmail || !Number.isFinite(Date.parse(metadata.date))) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Invalid pinned commit metadata');
  metadata.date = new Date(metadata.date).toISOString();
  if (typeof message !== 'string' || !message) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Checkpoint message is required');
  const env = { ...process.env, GIT_AUTHOR_NAME: metadata.authorName, GIT_COMMITTER_NAME: metadata.authorName,
    GIT_AUTHOR_EMAIL: metadata.authorEmail, GIT_COMMITTER_EMAIL: metadata.authorEmail,
    GIT_AUTHOR_DATE: metadata.date, GIT_COMMITTER_DATE: metadata.date };
  const commit = git(cwd, ['commit-tree', treeId, '-p', parent], { input: message, env });
  return { ref, parentCommit: parent, tree: treeId, commit, message, commitMetadata: metadata };
}
export function publishCheckpoint({ cwd, ref, expected, commit }) {
  validateRef(cwd, ref);
  git(cwd, ['cat-file', '-e', `${commit}^{commit}`]);
  const zero = '0'.repeat(git(cwd, ['rev-parse', 'HEAD']).length);
  try { git(cwd, ['update-ref', ref, commit, expected ?? zero]); }
  catch (error) { fail('WAVE_CHECKPOINT_DIVERGED', `Checkpoint compare-and-swap refused: ${error.message}`); }
  return commit;
}
export function worktreeBaseFor({ journal, ref }) {
  const wave = journal?.wave;
  if (!wave) return null;
  if (wave.checkpoints.some(checkpoint => checkpoint.state !== 'published')) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Checkpoint publication is pending');
  const expected = wave.checkpoints.at(-1)?.commit ?? null;
  if (ref !== expected) fail('WAVE_CHECKPOINT_DIVERGED', 'Wave ref differs from the published journal tip');
  return expected ?? wave.baseCommit;
}
export function squashOntoBase({ cwd, ref, base }) {
  if (git(cwd, ['rev-parse', 'HEAD']) !== base) fail('WAVE_CHECKPOINT_DIVERGED', 'HEAD moved from the pinned base');
  const tip = readCheckpointRef({ cwd, ref });
  if (!tip) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Wave ref is missing');
  return withTemporaryIndex(cwd, env => {
    git(cwd, ['read-tree', base], { env });
    const diff = execFileSync('git', ['diff', '--binary', base, tip, '--'], { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (diff) git(cwd, ['apply', '--cached', '--binary', '-'], { env, input: diff });
    const tree = git(cwd, ['write-tree'], { env });
    if (tree !== git(cwd, ['rev-parse', `${tip}^{tree}`])) fail('WAVE_CHECKPOINT_DIVERGED', 'Squashed tree differs from checkpoint');
    return tree;
  });
}
export function removeCheckpointRef({ cwd, ref, expected }) {
  validateRef(cwd, ref);
  if (!expected) fail('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Deletion requires the expected tip');
  git(cwd, ['update-ref', '-d', ref, expected]);
}
/** Pure resume-table classification; all supplied decisions are durable ordinal evidence. */
export function reconcileCheckpoint({ journalEntry: entry, refValue }) {
  if (!entry) return refValue == null ? 'ADMIT_FROM_BASE' : 'WAVE_CHECKPOINT_DIVERGED';
  if (entry.evidenceMissing) return 'WAVE_CHECKPOINT_EVIDENCE_MISSING';
  if (entry.diverged) return 'WAVE_CHECKPOINT_DIVERGED';
  if (!entry.commit) {
    if (refValue !== (entry.previousCommit ?? null)) return 'WAVE_CHECKPOINT_DIVERGED';
    return entry.gateOutcome === 'approve' ? 'PREPARE_AND_PUBLISH' : 'RECOVER_WAITING_GATE';
  }
  if (refValue === entry.commit) {
    if (entry.state === 'prepared') return 'MARK_PUBLISHED';
    return entry.terminal ? 'PRESERVE_PUBLISHED' : 'ALREADY_PUBLISHED';
  }
  if (refValue === entry.parentCommit || refValue == null && entry.waveNumber === 1) return 'REPLAY_AND_PUBLISH';
  if (entry.knownAncestorCommits?.includes(refValue)) return 'RECONCILE_IN_ORDER';
  return 'WAVE_CHECKPOINT_DIVERGED';
}
