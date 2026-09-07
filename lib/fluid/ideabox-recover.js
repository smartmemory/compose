/**
 * lib/fluid/ideabox-recover.js — the supported way out of a stranded ideabox.
 *
 * COMP-IDEABOX-MIGRATE-DIALECT, the escape hatch FU-1 left open.
 *
 * THE STATE THIS EXISTS FOR
 * -------------------------
 * A migration is interrupted, and the document is edited before it is resumed.
 * The manifest is open, its hash no longer matches the file, and the gate
 * refuses — correctly, because resuming would import a document nobody checked
 * and project away whatever was added. But EVERY ideabox command runs that
 * gate, so the project is stranded, and the only exit needing no tooling was
 * destructive: delete the manifest, and the partially migrated store becomes
 * canon so the next render replaces the file.
 *
 * That is FU-1's stranding shape with a worse escape hatch. The refusal is
 * right; having no supported way out is the defect.
 *
 * WHAT THE TWO COMMANDS MEAN
 * --------------------------
 * Both say "I have decided which document is right", which is precisely the
 * judgement the gate refuses to make on the user's behalf:
 *
 *   - `adoptFile`     — the file on disk is right. Finish the migration against
 *                       it, updating already-imported records to match.
 *   - `discardEdits`  — the migration is right. Put the file back as it was
 *                       read and finish that, after saving a copy first.
 *
 * WHY THESE DO NOT RUN THE GATE
 * -----------------------------
 * Every other mutation calls it first (`ideabox-ops.js`, invariant 1). These
 * two cannot: the gate throws `IDEABOX_MANIFEST_STALE`, which is the state they
 * exist to leave. They are the one deliberate exception, and they are narrower
 * than the gate rather than wider — they refuse unless the project is ACTUALLY
 * stranded, so neither is a general "make the file canon" door.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseIdeabox } from '../ideabox.js';
import {
  hashMarkdown,
  manifestPath,
  openManifest,
  readManifest,
} from './ideabox-manifest.js';
import { ensureIdeaboxMigrated } from './ideabox-migrate.js';
import { assertIdeaboxReadable } from './ideabox-readable.js';
import { ideaToRecord } from './import-ideabox.js';
import { KIND } from './provider.js';
import { UNPATCHABLE, normalizeRecord } from './record-shape.js';
import { writeIdeaboxProjection } from './render-ideabox.js';

/** Nothing to recover: the project is not in the stranded state. */
export class IdeaboxNotStranded extends Error {
  constructor(ideaboxPath, why) {
    super(
      `compose: nothing to recover for ${ideaboxPath} — ${why}. These commands exist only to ` +
      `resolve a migration that was interrupted and whose source document then changed. Ordinary ` +
      `hand edits to a migrated ideabox are not recovered here: that file is generated output, and ` +
      `\`compose ideabox render\` is the way back from an edit to it.`
    );
    this.name = 'IdeaboxNotStranded';
    this.code = 'IDEABOX_NOT_STRANDED';
  }
}

/** The manifest predates the stored source text, so there is nothing to restore. */
export class IdeaboxNoStoredSource extends Error {
  constructor(ideaboxPath) {
    super(
      `compose: cannot discard the edits to ${ideaboxPath} — the interrupted migration was ` +
      `recorded by an older version of compose that did not keep a copy of the document it read, ` +
      `so there is nothing to put back. Discarding would delete the current text and restore ` +
      `nothing. Use \`compose ideabox adopt-file\` to finish the migration against the file as it ` +
      `now stands; the entries it already imported are unaffected either way.`
    );
    this.name = 'IdeaboxNoStoredSource';
    this.code = 'IDEABOX_NO_STORED_SOURCE';
  }
}

/**
 * The stranded state, or null.
 *
 * ONE definition, shared by both commands and by nothing else. Stranded means:
 * an open manifest exists, the file exists, and the manifest's hash does not
 * match it. Every other shape is somebody else's job —
 *
 *   - no manifest      → migration finished (or never ran). `render` is the
 *                        repair path for a hand edit to generated output.
 *   - hash MATCHES     → an interrupted migration with an untouched document,
 *                        which `ensureIdeaboxMigrated` already resumes on its
 *                        own. Recovering it here would be a second mechanism
 *                        for a case that has one.
 *   - no lock path     → no manifest is ever written (SmartMemory), so such a
 *                        project cannot reach this state at all.
 */
export function strandedState(provider, ideaboxPath) {
  const manifest = readManifest(provider, ideaboxPath);
  if (!manifest) return null;
  if (!existsSync(ideaboxPath)) return null;
  const markdown = readFileSync(ideaboxPath, 'utf8');
  if (manifest.hash === hashMarkdown(markdown)) return null;
  return { manifest, markdown };
}

function requireStranded(provider, ideaboxPath) {
  const state = strandedState(provider, ideaboxPath);
  if (state) return state;
  const manifest = readManifest(provider, ideaboxPath);
  if (!manifest) throw new IdeaboxNotStranded(ideaboxPath, 'no interrupted migration is recorded');
  if (!existsSync(ideaboxPath)) throw new IdeaboxNotStranded(ideaboxPath, 'the file does not exist');
  throw new IdeaboxNotStranded(
    ideaboxPath,
    'the interrupted migration matches the file, so re-running any ideabox command finishes it',
  );
}

/**
 * `compose ideabox discard-edits` — the migration is right.
 *
 * `onBackup` is called with the copy's path BEFORE the file is overwritten, not
 * returned at the end. The return value only reaches the caller when everything
 * after the overwrite also succeeded, and the resume that follows can throw —
 * at which point the user has been told their text is gone and NOT where the
 * copy is, which is the one moment the path matters. The error message this
 * command is reached from promises the path is printed; a promise kept only on
 * the happy path is not kept.
 *
 * @returns {Promise<{backup: string|null, result: object}>}
 */
export async function discardEdits(provider, ideaboxPath, { onBackup = null } = {}) {
  const { manifest, markdown } = requireStranded(provider, ideaboxPath);
  if (typeof manifest.text !== 'string') throw new IdeaboxNoStoredSource(ideaboxPath);

  // BEFORE ANYTHING IS WRITTEN, including the backup. The stored text was
  // readable when the manifest was opened — the gate proved it — but the
  // manifest is a file on disk like any other, and restoring a document the
  // parser can only half read would patch records toward that subset and then
  // refuse. Checked here, the failure changes nothing at all.
  const restoring = assertIdeaboxReadable(parseIdeabox(manifest.text), ideaboxPath);

  // THE COPY COMES FIRST, and its path is returned so the caller can print it.
  //
  // "Discard" is a decision someone can make in a hurry, and this is the one
  // command in the ideabox that deliberately destroys text. Refusing to lose it
  // anyway costs one file. Unlike the FU-4 preamble this copy IS transient — it
  // is a safety net for one command, not an input to the projection — so
  // gitignored `.compose/data/` is its right home rather than a tracked sibling.
  const backup = writeBackup(provider, ideaboxPath, markdown);
  if (backup && onBackup) onBackup(backup);

  // PUT THE RECORDS BACK TOO, not only the file.
  //
  // The two commands can be run in sequence: an `adopt-file` that crashes after
  // its reconcile has already patched records to match the edited document, and
  // the user then changes their mind. Restoring the markdown alone does not undo
  // that — the ordinary import SKIPS records that already exist, so the edited
  // body survived in the store and the very next projection wrote it back into
  // the file that had just been restored. A discard that silently keeps the
  // edits is the content loss this whole feature exists to prevent, inverted.
  //
  // Reconciling BEFORE the overwrite is what keeps a crash here safe: until the
  // file is restored the project is still stranded, so a rerun of this command
  // is still allowed and the reconcile is idempotent. Do it after, and a crash
  // in between leaves a project that is no longer stranded, refuses to discard,
  // and quietly holds the edits.
  const reverted = await reconcileRecords(provider, ideaboxPath, restoring);

  writeFileAtomic(ideaboxPath, manifest.text);
  // The hash matches again, so the ORDINARY resume path finishes the job. No
  // second import mechanism: recovery hands the existing one a state it can
  // already handle.
  const result = await ensureIdeaboxMigrated(provider, ideaboxPath);
  await writeIdeaboxProjection(provider, ideaboxPath);
  return { backup, result, reverted, leftover: await leftoverFrom(provider, restoring) };
}

/**
 * What an interrupted adoption left in the store that the restored document
 * does not name — reported, never removed.
 *
 * Discarding puts back every field it can, but two things it cannot take back,
 * and BOTH are deliberate rather than missing:
 *
 *   - AN UMBRELLA the adoption created. Deleting records is the one thing this
 *     whole feature refuses to do, and the renderer emits an empty umbrella on
 *     purpose (a project may create one before filing anything into it), so a
 *     leftover shows up in the file with nothing under it.
 *   - A DISCUSSION ENTRY typed into the document during the outage. The trail is
 *     append-only on the seam because it is evidence, so an entry that reached a
 *     record stays on it.
 *
 * Neither loses anything the user had; both leave something they may not expect.
 * Silence is what would make that a defect, so the command says so.
 */
async function leftoverFrom(provider, restoring) {
  const named = new Set((restoring.clusters ?? []).map((c) => c.name));
  const clusters = (await provider.listRecords({ kind: KIND.CLUSTER }))
    .filter((c) => !named.has(c.title))
    .map((c) => c.title);

  const inDoc = new Map(
    [...(restoring.ideas ?? []), ...(restoring.killed ?? [])]
      .map((i) => [i.id, (i.discussion ?? []).length]),
  );
  const discussed = (await provider.listRecords({ kind: KIND.IDEA }))
    .filter((r) => (r.discussion ?? []).length > (inDoc.get(r.handle) ?? 0))
    .map((r) => r.handle);

  return { clusters, discussed };
}

/**
 * `compose ideabox adopt-file` — the file on disk is right.
 *
 * The step order is fixed and it is what makes a crash mid-recovery safe:
 * a crash between 2 and 3 leaves the manifest stale, so this command reruns and
 * step 2 is idempotent; a crash after 3 is an ordinary resumable migration with
 * the updates already applied.
 *
 * @returns {Promise<{updated: string[], discussed: string[], imported: string[], kept: string[], reclustered: string[]}>}
 */
export async function adoptFile(provider, ideaboxPath) {
  const { markdown } = requireStranded(provider, ideaboxPath);

  // 1. READABLE FIRST, changing nothing. Adopting a document the parser cannot
  //    fully read would import the subset it understood and project away the
  //    rest — the original bug, performed deliberately.
  const parsed = assertIdeaboxReadable(parseIdeabox(markdown), ideaboxPath);

  // 2. Reconcile what is already in the store against what the file now says.
  const { updated, discussed, kept, reclustered } = await reconcileRecords(provider, ideaboxPath, parsed);

  // 3. Re-plan, atomically, against the document being adopted.
  openManifest(provider, ideaboxPath, {
    markdown,
    planned: [...(parsed.ideas ?? []), ...(parsed.killed ?? [])].map((i) => i.id),
    plannedClusters: (parsed.clusters ?? []).map((c) => c.name),
  });
  // NOT recapturing the preamble here, though the recovery must recapture it:
  // step 4's import already does (`import-ideabox.js` writes it from the
  // document it is importing, which after step 3 is this one). A second call
  // would be a redundant writer of the same file, and the version of this bug
  // that keeps recurring is two writers of one thing drifting apart. Pinned by
  // the adopt-file preamble test, which fails if EITHER writer stops.

  // 4. The hash matches now, so the ordinary resume path imports the handles
  //    that were never reached — including any the user added by hand, which
  //    the re-planned manifest now vouches for.
  const { imported } = await ensureIdeaboxMigrated(provider, ideaboxPath);
  await writeIdeaboxProjection(provider, ideaboxPath);
  return { updated, discussed, imported, kept, reclustered };
}

/**
 * Step 2, exported so a test can interrupt the command exactly here.
 *
 * IDEMPOTENT BY CONSTRUCTION: it patches only fields that differ, so a second
 * pass over an unchanged document reports nothing. That is not a nicety — the
 * crash-safety argument for the step order depends on it.
 *
 * NEVER DELETES. A handle in the store and absent from the file is kept and
 * reported. Removing it would be exactly the silent-loss guess the gate exists
 * to refuse, and the user may have deleted the line by accident.
 */
export async function reconcileRecords(provider, ideaboxPath, parsed) {
  const provenance = { origin: 'import:ideabox' };
  const stored = await provider.listRecords({ kind: KIND.IDEA });
  const byHandle = new Map(stored.map((r) => [r.handle, normalizeRecord(r)]));

  // Clusters first, exactly as the import does: an idea the user moved into a
  // NEW umbrella has nowhere to point until that umbrella exists, and a null
  // cluster here would silently unfile it. `findOrCreateRecord` is the seam's
  // atomic lookup-or-create, so this is idempotent across reruns.
  const clusterHandleByName = new Map();
  const reclustered = [];
  for (const cluster of parsed.clusters ?? []) {
    const { record } = await provider.findOrCreateRecord(
      { kind: KIND.CLUSTER, title: cluster.name },
      { body: cluster.theme ?? '', cluster_order: cluster.order, provenance },
    );
    clusterHandleByName.set(cluster.name, record.handle);

    // AN UMBRELLA THAT ALREADY EXISTS IS RECONCILED LIKE ANY OTHER RECORD.
    // `findOrCreateRecord` returns a known cluster untouched, and step 4's
    // import skips known clusters too — so an edit to the THEME of an umbrella
    // that was already imported reached neither writer, and the projection put
    // the old theme back over it. That is the same content loss as an edited
    // idea body, one record kind over, and it is invisible to any test whose
    // umbrella is new.
    const patch = patchFor(normalizeRecord(record), {
      body: cluster.theme ?? '',
      cluster_order: cluster.order ?? null,
    });
    if (Object.keys(patch).length) {
      await provider.updateRecord(record.handle, patch);
      reclustered.push(cluster.name);
    }
  }

  const all = [
    ...(parsed.ideas ?? []).map((idea) => ({ idea, killed: false })),
    ...(parsed.killed ?? []).map((idea) => ({ idea, killed: true })),
  ];

  const updated = [];
  const discussed = [];
  for (const { idea, killed } of all) {
    const current = byHandle.get(idea.id);
    // Not in the store yet: step 4 imports it. Creating it here would duplicate
    // the import's own path and skip its `reclaimAborted` handling.
    if (!current) continue;

    const desired = ideaToRecord(idea, { killed, parsed, clusterHandleByName, provenance });
    const patch = patchFor(current, desired);
    if (Object.keys(patch).length) {
      await provider.updateRecord(idea.id, patch);
      updated.push(idea.id);
    }

    // Discussion is APPEND-ONLY on the seam — `updateRecord` refuses to patch
    // it, deliberately, because the deliberation trail is evidence rather than
    // a mutable blob (`record-shape.js`). So an entry present in the file and
    // absent from the store is appended, and nothing is ever removed. An entry
    // deleted from the file therefore survives in the record, which is the same
    // direction every other refusal in this bug takes.
    const have = new Set((current.discussion ?? []).map(discussionKey));
    let appended = 0;
    for (const entry of desired.discussion ?? []) {
      if (have.has(discussionKey(entry))) continue;
      await provider.appendDiscussion(idea.id, entry);
      appended += 1;
    }
    if (appended) discussed.push(`${idea.id} (+${appended})`);
  }

  const inFile = new Set(all.map(({ idea }) => idea.id));
  const kept = stored.map((r) => r.handle).filter((h) => !inFile.has(h));
  return { updated, discussed, kept, reclustered };
}

/** Identity of a discussion entry, for "is this one already recorded". */
function discussionKey(entry) {
  return JSON.stringify([entry?.at ?? null, entry?.author ?? null, entry?.text ?? '']);
}

/**
 * The patchable difference between a stored record and what the file now says.
 *
 * `UNPATCHABLE` fields are dropped rather than compared: identity, provenance
 * and the append-only discussion trail are not the file's to change, and
 * including any of them would make `updateRecord` refuse the whole patch.
 */
function patchFor(current, desired) {
  const patch = {};
  for (const [key, value] of Object.entries(desired)) {
    if (UNPATCHABLE.includes(key)) continue;
    if (!deepEqual(current[key] ?? null, value ?? null)) patch[key] = value;
  }
  return patch;
}

function deepEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The saved copy of the document the user is about to discard. */
function writeBackup(provider, ideaboxPath, markdown) {
  const home = manifestPath(provider, ideaboxPath);
  if (!home) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dirname(home), `ideabox-discarded-${stamp}-${randomUUID().slice(0, 8)}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, markdown);
  return path;
}

/** Temp + rename, so an interrupted write cannot leave a half-file. */
function writeFileAtomic(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
