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

  if (records.length === 0) {
    if (inMarkdown.length === 0) return { migrated: false, imported: [] };
    // The upgrade path. `importIdeabox` preserves every IDEA-N handle verbatim
    // (they are cited in docs and commits) and is restartable after a partial
    // failure, so a crash here does not strand the installation.
    const result = await importIdeabox(provider, { markdown, path: ideaboxPath });
    return { migrated: true, imported: result.imported };
  }

  const known = new Set(records.map((r) => r.handle));
  const missing = inMarkdown.filter((id) => !known.has(id));
  if (missing.length) throw new IdeaboxMigrationConflict(missing, ideaboxPath);

  return { migrated: false, imported: [] };
}
