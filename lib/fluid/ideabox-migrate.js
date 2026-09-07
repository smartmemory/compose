/**
 * lib/fluid/ideabox-migrate.js — the first-use gate between a markdown ideabox
 * and the record store.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-1 (F2).
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * ----------------------------------
 * `@smartmemory/compose` is published. Other projects have their own populated
 * `docs/product/ideabox.md` and no fluid records. The cutover makes records
 * canon and the markdown a projection of them — so without this gate, the first
 * `compose ideabox add` in an upgraded project allocates IDEA-1 against an empty
 * store and the projection replaces that project's entire ideabox with the one
 * idea they just typed. Their ideas would survive only in their git history.
 *
 * The blueprint missed this by treating the import as a one-time operation on
 * THIS repository. It is not: it is an upgrade path, and it runs once per
 * installation, on whatever that installation happens to have.
 *
 * WHY IT REFUSES RATHER THAN REPAIRS
 * ----------------------------------
 * The dangerous state is not "no records" — that one is unambiguous and is
 * simply imported. It is a PARTIAL store: some records present, and markdown
 * entries that have no record behind them. Any automatic reading of that state
 * is a guess. Importing the strays assumes the markdown is authoritative, which
 * it no longer is. Ignoring them assumes they were deliberately deleted, and
 * projects over them. Both silently discard someone's work in one of the two
 * cases. So it stops and names what it found.
 *
 * That check costs a parse of a small file per mutation, which is the same file
 * the CLI already read on every mutation before the cutover.
 */

import { existsSync, readFileSync } from 'node:fs';

import { parseIdeabox } from '../ideabox.js';
import { hashMarkdown, readManifest } from './ideabox-manifest.js';
// FU-2: the readability check lives in its own leaf module so the PARSER's own
// module can import it without closing a cycle through this one. Re-exported
// here because this was its address for its whole life so far.
import { IdeaboxUnreadable, assertIdeaboxReadable } from './ideabox-readable.js';
import { importIdeabox } from './import-ideabox.js';
import { KIND } from './provider.js';

export { IdeaboxUnreadable, assertIdeaboxReadable };

export class IdeaboxMigrationConflict extends Error {
  constructor(missing, ideaboxPath) {
    super(
      `compose: the ideabox at ${ideaboxPath} contains ${missing.length} idea(s) with no record ` +
      `behind them: ${missing.join(', ')}. The record store is canon now, so this file is ` +
      `generated output — which means these entries were either hand-added after the migration ` +
      `or lost by a partial one, and guessing which would discard someone's work either way. ` +
      `Re-add them with \`compose ideabox add\`, or delete them from the file if they are stale, ` +
      `then run \`compose ideabox render\`.`
    );
    this.name = 'IdeaboxMigrationConflict';
    this.code = 'IDEABOX_MIGRATION_CONFLICT';
    this.missing = missing;
  }
}

/**
 * An interrupted migration whose source document has changed underneath it.
 *
 * Distinct from a conflict: the entries are ones this store PLANNED to write,
 * so they are not strays — but the plan was made against a different version of
 * the file, and importing the current one would import a document nobody
 * checked. FU-1.
 */
export class IdeaboxManifestStale extends Error {
  constructor(ideaboxPath) {
    super(
      `compose: the ideabox at ${ideaboxPath} has an unfinished migration recorded against a ` +
      `DIFFERENT version of this file — the document was most likely edited while the migration ` +
      `was running, or after it was interrupted. Resuming would import a version nobody checked, ` +
      `and the entries added since would be projected away. Nothing has been changed. To recover ` +
      `without losing anything: copy the text that is only in this file somewhere safe, restore ` +
      `the file to the version the migration started from, run the command again so the migration ` +
      `finishes, then re-apply those changes with \`compose ideabox\`. Deleting the record of the ` +
      `unfinished migration is NOT a shortcut — it makes the partially migrated store canon, and ` +
      `the next render replaces this file with a projection of it.`
    );
    this.name = 'IdeaboxManifestStale';
    this.code = 'IDEABOX_MANIFEST_STALE';
  }
}

/**
 * The source document changed between the gate's check and the projection's
 * write. FU-3.
 *
 * The remedy is genuinely different from a conflict's — nothing is wrong with
 * the file or the store, the two writers simply interleaved — so it does not
 * reuse `IdeaboxMigrationConflict`, whose text tells the user to re-add ideas
 * by hand.
 */
export class IdeaboxChangedUnderLock extends Error {
  constructor(ideaboxPath, reason) {
    super(
      `compose: the ideabox at ${ideaboxPath} changed between the check and the write ` +
      `(${reason}), so the projection was abandoned rather than replacing content that was ` +
      `never checked. Nothing has been changed. Run the command again.`
    );
    this.name = 'IdeaboxChangedUnderLock';
    this.code = 'IDEABOX_CHANGED_UNDER_LOCK';
    this.reason = reason;
  }
}

/**
 * PURE. What the gate WOULD do, computed without doing any of it.
 *
 * Split out of `ensureIdeaboxMigrated` for FU-3: the projection has to re-run
 * this decision INSIDE its write lock, and it can only do that if making the
 * decision writes nothing and takes no lock. Reads exactly three things —
 * `listRecords`, `readEvents`, the markdown — none of which lock, so running it
 * under the projection lock cannot deadlock the way moving the whole gate under
 * it does (measured: a full 30s lock timeout, see `render-ideabox.js`).
 *
 * Refusals are RETURNED, not thrown, because a decision procedure that throws
 * cannot be used to ask a question.
 *
 * @returns {Promise<{action: 'none'|'import', markdown?: string} |
 *                   {action: 'refuse', reason: string, error: Error}>}
 */
export async function assessIdeabox(provider, ideaboxPath) {
  const records = await provider.listRecords({ kind: KIND.IDEA });
  const markdown = existsSync(ideaboxPath) ? readFileSync(ideaboxPath, 'utf8') : null;

  if (markdown === null) return { action: 'none' };

  const parsed = parseIdeabox(markdown);
  const inMarkdown = [...(parsed.ideas ?? []), ...(parsed.killed ?? [])].map((i) => i.id);

  try {
    assertIdeaboxReadable(parsed, ideaboxPath);
  } catch (error) {
    return { action: 'refuse', reason: 'unreadable', error };
  }

  const known = new Set(records.map((r) => r.handle));
  const missing = inMarkdown.filter((id) => !known.has(id));

  if (records.length === 0) {
    if (inMarkdown.length === 0) return { action: 'none' };
    // The upgrade path.
    return { action: 'import', markdown };
  }

  // AN OPEN MANIFEST MEANS THE MIGRATION NEVER FINISHED, and that is a fact
  // about the DOCUMENT, not only about the handles that happen to be absent.
  //
  // Scoping this to the missing-handles branch was wrong in a way the ID
  // comparison hides: an edit to an idea that ALREADY has a record changes no
  // ID, so nothing is missing, and the gate waved a file through that the
  // projection then rewrote from the version read at the start of the import.
  // Until the migration completes this file is still the SOURCE document, so
  // the question here is whether it is the same document, not whether its ids
  // line up. (After the migration there is no manifest, so `render` still
  // discards hand edits to what is by then generated output — that contract is
  // untouched.)
  const manifest = readManifest(provider, ideaboxPath);
  const planned = new Set();
  if (manifest) {
    if (manifest.hash !== hashMarkdown(markdown)) {
      // Planned against a different document. Every handle it names is suspect,
      // and so is every handle in the file now.
      return {
        action: 'refuse',
        reason: 'manifest-stale',
        error: new IdeaboxManifestStale(ideaboxPath),
      };
    }
    for (const handle of manifest.planned) planned.add(handle);
    // Same document, unfinished import. Finishing it is a no-op for handles
    // that already landed, and it is what closes the manifest — so a crash
    // between the last write and the close heals on the next command instead of
    // leaving the store in a state every later check has to reason about.
    if (missing.length === 0) return { action: 'import', markdown };
  }

  if (missing.length) {
    // RESUME versus REFUSE, decided PER HANDLE.
    //
    // A crash partway through the first-use import leaves some records written
    // and the rest missing, which lands here rather than in the empty-store
    // branch above. Refusing that outright strands the installation: the error
    // names `compose ideabox add`, `add` runs this same gate, so every command
    // fails and there is no way out — and the reclaim path built for exactly
    // this case is never reached.
    //
    // The evidence has to be per-handle, not "did an import ever run". Once the
    // first import succeeds the log carries `imported` events forever, so a
    // global check would quietly import anything later hand-added to what is
    // now generated output — losing the very protection this gate exists for.
    // A handle with no event and no manifest entry was never issued here: it
    // was typed into the file by hand, and importing it would treat the
    // markdown as authoritative when it no longer is.
    //
    // Two sources of evidence, because neither alone covers the whole failure:
    //
    //   - THE EVENT LOG covers handles the import REACHED. `importIdeabox`
    //     skips live records and reclaims its own aborted allocations, so a
    //     handle that was issued and not deleted is a create that crashed, and
    //     resuming it is safe and lossless.
    //   - THE MANIFEST covers the handles it never reached. An import that dies
    //     on idea 2 leaves ideas 3..N with no event anywhere, and no amount of
    //     reading the log afterwards can distinguish them from strays — the
    //     intention has to have been written down first (FU-1).
    //
    // Three populations, and only two of them are resumable:
    //   - issued, no `deleted` event  → a create that crashed. RESUME.
    //   - planned by an OPEN manifest whose hash still matches this file
    //                                 → never attempted. RESUME.
    //   - issued, `deleted` event     → deliberately retired; this file is just
    //                                   stale output. REFUSE (a render fixes it,
    //                                   and importing would resurrect it).
    //   - neither                     → hand-typed into generated output. REFUSE.
    const { issued, deleted } = await handleHistory(provider);

    const resumable = missing.filter(
      (id) => (issued.has(id) && !deleted.has(id)) || (planned.has(id) && !deleted.has(id)),
    );
    const strays = missing.filter((id) => !resumable.includes(id));
    if (strays.length) {
      return {
        action: 'refuse',
        reason: 'stray-entries',
        error: new IdeaboxMigrationConflict(strays, ideaboxPath),
      };
    }

    return { action: 'import', markdown };
  }

  return { action: 'none' };
}

/**
 * Ensure the record store reflects the markdown before any mutation touches it.
 *
 * Runs before every mutating ideabox command. Three states, one of which stops
 * the command:
 *
 *   - **no records, markdown has entries** → import it (the upgrade path)
 *   - **records exist, markdown adds nothing** → already migrated, proceed
 *   - **records exist, markdown has entries with no record** → refuse
 *
 * A fresh project with no markdown and no records is the trivial first case and
 * simply proceeds.
 *
 * Assess, then act. The decision is `assessIdeabox` and this is the only thing
 * that executes it; the split exists so the projection can ask the same
 * question under its lock (FU-3) without re-implementing the answer.
 *
 * @param {import('./provider.js').FluidProvider} provider
 * @param {string} ideaboxPath absolute path to the markdown ideabox
 * @returns {Promise<{migrated: boolean, imported: string[]}>}
 */
export async function ensureIdeaboxMigrated(provider, ideaboxPath) {
  const assessment = await assessIdeabox(provider, ideaboxPath);

  if (assessment.action === 'refuse') throw assessment.error;

  if (assessment.action === 'import') {
    const result = await importIdeabox(provider, {
      markdown: assessment.markdown,
      path: ideaboxPath,
    });
    return { migrated: true, imported: result.imported };
  }

  return { migrated: false, imported: [] };
}

/**
 * Which handles this store's log has seen, and which of those were retired.
 *
 * Both sets are empty when the history cannot be read, which makes every
 * missing handle a stray and every ambiguous state a refusal. That is the safe
 * direction: resuming on a guess is the one thing this must not do.
 */
async function handleHistory(provider) {
  const empty = { issued: new Set(), deleted: new Set() };
  if (typeof provider.readEvents !== 'function') return empty;
  try {
    const events = (await provider.readEvents()) ?? [];
    const issued = new Set();
    const deleted = new Set();
    for (const event of events) {
      if (!event?.handle) continue;
      issued.add(event.handle);
      if (event.type === 'deleted') deleted.add(event.handle);
    }
    return { issued, deleted };
  } catch {
    return empty;
  }
}
