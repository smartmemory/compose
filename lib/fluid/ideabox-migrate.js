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
import { importIdeabox } from './import-ideabox.js';
import { KIND } from './provider.js';

export class IdeaboxUnreadable extends Error {
  constructor(unread, ideaboxPath) {
    super(
      `compose: the ideabox at ${ideaboxPath} declares ${unread.length} idea(s) this version cannot ` +
      `read: ${unread.join(', ')}. Refusing rather than proceeding, because continuing would treat ` +
      `them as absent and the next write would overwrite this file with a projection that does not ` +
      `contain them. This usually means the file is in a dialect newer or older than this install, ` +
      `or is partly converted. Nothing has been changed. Back the file up, then either upgrade ` +
      `compose or convert the entries by hand.`
    );
    this.name = 'IdeaboxUnreadable';
    this.code = 'IDEABOX_UNREADABLE';
    this.unread = unread;
  }
}

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
 * @param {import('./provider.js').FluidProvider} provider
 * @param {string} ideaboxPath absolute path to the markdown ideabox
 * @returns {Promise<{migrated: boolean, imported: string[]}>}
 */
export async function ensureIdeaboxMigrated(provider, ideaboxPath) {
  const records = await provider.listRecords({ kind: KIND.IDEA });
  const markdown = existsSync(ideaboxPath) ? readFileSync(ideaboxPath, 'utf8') : null;

  if (markdown === null) return { migrated: false, imported: [] };

  const parsed = parseIdeabox(markdown);
  const inMarkdown = [...(parsed.ideas ?? []), ...(parsed.killed ?? [])].map((i) => i.id);

  // READABILITY BEFORE SEMANTICS.
  //
  // Every branch below reads `inMarkdown` as a statement about what the user
  // has. That is only true if the parse actually understood the file. When it
  // did not, an id vanishes from `inMarkdown` and every branch silently reads
  // its absence as consent — "no ideas here" — and the next write projects over
  // it. That is not a hypothetical: it destroyed 18 ideas in one command
  // (COMP-IDEABOX-MIGRATE-DIALECT).
  //
  // So compare what the file DECLARES against what the parser PRODUCED, and
  // stop on any gap. This deliberately catches more than the empty parse that
  // motivated it: a half-converted file yields some ideas and hides the rest,
  // which every count-based check (`inMarkdown.length === 0`) waves straight
  // through while it is just as destructive.
  // What the parse could see but not read. Taken from the parser itself, not
  // from a second scan of the same text: two readers of one document is the
  // exact shape that produced this bug and three of its follow-ons.
  const unread = [...new Set(parsed.unconsumed ?? [])].filter((id) => !inMarkdown.includes(id));
  if (unread.length) throw new IdeaboxUnreadable(unread, ideaboxPath);

  // The same id declared twice is the half-converted document: the parser reads
  // one copy, so the check above is satisfied while the other — routinely the
  // older, richer one — is invisible and would be deleted by the next render.
  const seen = new Set();
  const duplicated = [...new Set([
    ...[...inMarkdown, ...(parsed.unconsumed ?? [])].filter((id) => seen.size === seen.add(id).size),
    // An umbrella named after an idea that also exists here as a real idea:
    // the half-converted document, where the richer original survives only as
    // the heading the parser turned into a cluster.
    ...(parsed.collisions ?? []),
  ])];
  if (duplicated.length) throw new IdeaboxUnreadable(duplicated, ideaboxPath);

  const known = new Set(records.map((r) => r.handle));
  const missing = inMarkdown.filter((id) => !known.has(id));

  if (records.length === 0) {
    if (inMarkdown.length === 0) return { migrated: false, imported: [] };
    // The upgrade path.
    const result = await importIdeabox(provider, { markdown, path: ideaboxPath });
    return { migrated: true, imported: result.imported };
  }

  if (missing.length) {
    // RESUME versus REFUSE, decided PER HANDLE from the events log.
    //
    // A crash partway through the first-use import leaves some records written
    // and the rest missing, which lands here rather than in the empty-store
    // branch above. Refusing that outright strands the installation: the error
    // names `compose ideabox add`, `add` runs this same gate, so every command
    // fails and there is no way out — and the reclaim path built for exactly
    // this case is never reached.
    //
    // The log distinguishes the two populations. A handle the import already
    // burned carries an event; `importIdeabox` skips live records and reclaims
    // its own aborted allocations, so resuming is safe and lossless.
    //
    // The evidence has to be per-handle, not "did an import ever run". Once the
    // first import succeeds the log carries `imported` events forever, so a
    // global check would quietly import anything later hand-added to what is
    // now generated output — losing the very protection this gate exists for.
    // A handle with no event was never issued here: it was typed into the file
    // by hand, and importing it would treat the markdown as authoritative when
    // it no longer is.
    // Three populations, and only one of them is resumable:
    //   - issued, no `deleted` event  → a create that crashed. RESUME.
    //   - issued, `deleted` event     → deliberately retired; this file is just
    //                                   stale output. REFUSE (a render fixes it,
    //                                   and importing would resurrect it).
    //   - never issued               → hand-typed into generated output. REFUSE.
    const { issued, deleted } = await handleHistory(provider);
    const resumable = missing.filter((id) => issued.has(id) && !deleted.has(id));
    const strays = missing.filter((id) => !resumable.includes(id));
    if (strays.length) throw new IdeaboxMigrationConflict(strays, ideaboxPath);

    const result = await importIdeabox(provider, { markdown, path: ideaboxPath });
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
