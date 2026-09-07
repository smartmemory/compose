/**
 * lib/fluid/ideabox-preamble.js — a project's own heading and introduction,
 * kept beside the projection rather than inside it.
 *
 * COMP-IDEABOX-MIGRATE-DIALECT FU-4.
 *
 * THE DEFECT
 * ----------
 * `renderIdeabox` emits a hardcoded template preamble, so the first projection
 * after a migration replaced a project's own title and introductory prose with
 * the standard one. Ideas, clusters, custom fields and bodies all survived; the
 * document AROUND them did not. Measured on forge-top: `# Forge Ideabox` and
 * its two-line introduction were destroyed.
 *
 * WHY A SIDECAR AND NOT A RECORD
 * ------------------------------
 * The obvious fix — carry the preamble forward from the file being replaced —
 * was implemented and rejected, because it makes the DESTINATION authoritative
 * and `render` is documented as the way back from any hand edit
 * (`lib/ideabox-cli.js`). A projection that reads its own destination cannot
 * repair it.
 *
 * The alternative was to make the preamble a record. The owner rejected that:
 * it means a new ontology type in every SmartMemory tenant and a decision about
 * what a remote store does with per-document text. The preamble is not a
 * property of the idea corpus at all — it is a property of THIS FILE, and the
 * file is local no matter which provider holds the records.
 *
 * The projection therefore stays independent of its destination: it is rendered
 * from the records plus this sidecar, and a hand edit to the file's heading is
 * still discarded by the next render, exactly as a hand edit to an idea is.
 *
 * WHY IT IS TRACKED, AND NOT BESIDE THE MANIFEST
 * ----------------------------------------------
 * The first version of this put the sidecar in gitignored `.compose/data/`,
 * next to the migration manifest, keyed off `provider.lockPath`. That was
 * wrong twice.
 *
 * It made a TRACKED projection depend on UNTRACKED input. The heading then
 * survived only on the machine that ran the migration: any other clone — a
 * teammate, CI — found no sidecar, rendered the template over the custom
 * heading and committed that, and the migrating machine restored it on its next
 * render. FU-4's own defect, recurring on every clone, plus git churn on a
 * tracked file. This is the exact failure the owner already ruled on: records
 * were moved OUT of gitignored `vision-state.json` in the S3 entry-gate ruling
 * of 2026-08-04 (see the header of `local-provider.js`) because canon that a
 * tracked file is generated from cannot itself be ignored. The manifest is a
 * fair neighbour for none of this: it is TRANSIENT, alive only between the
 * start and the end of one import, while the preamble is durable content with
 * the same lifecycle as the records.
 *
 * And keying off `provider.lockPath` excluded SmartMemory, which has no lock —
 * the very provider whose existence was the argument for a local sidecar rather
 * than a record. Keyed off the ideabox path instead, every provider gets one.
 *
 * Beside the document it describes, it is also discoverable: the hand-written
 * recovery below is a file someone can find, not a hashed name under a hidden
 * directory. A deliberately named, deliberately committed file is not the stray
 * temp file that tracked directories have to be protected from.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The preamble file for this ideabox: a tracked sibling of it.
 *
 * `docs/product/ideabox.md` → `docs/product/ideabox.preamble.md`. Derived from
 * the ideabox path alone, so it does not depend on which provider holds the
 * records and every provider gets one. Plain markdown rather than JSON so a
 * project that has to write one by hand can just write it.
 */
export function preamblePath(ideaboxPath) {
  if (!ideaboxPath) return null;
  return String(ideaboxPath).replace(/(\.md)?$/i, '.preamble.md');
}

/**
 * The generated banner is not part of anyone's introduction.
 *
 * A document being imported is normally a legacy one and carries no banner, but
 * a store whose records were removed re-imports its own PROJECTION — and the
 * parser hands back everything before `## Ideas`, banner included. Capturing
 * that would make the next render emit the banner twice, and the one after that
 * three times.
 */
function withoutBanner(text) {
  const lines = String(text ?? '').split('\n');
  if (!/^\s*<!--/.test(lines[0] ?? '') || !/GENERATED FILE/.test(lines[0] ?? '')) return text;
  const end = lines.findIndex((l) => /-->/.test(l));
  if (end === -1) return text;
  return lines.slice(end + 1).join('\n').replace(/^\n+/, '');
}

/**
 * Capture the source document's own preamble.
 *
 * @param {string} ideaboxPath
 * @param {string} text `parseIdeabox(...).preamble` — the parser's own output,
 *   never a second scan of the same document. Two readers of one document is
 *   the exact shape that produced this whole bug class.
 * @returns {string|null} the path written, or null when there is nothing to
 *   write or nowhere to write it
 */
export function writePreamble(ideaboxPath, text) {
  const path = preamblePath(ideaboxPath);
  if (!path) return null;
  const body = withoutBanner(text);
  if (!body || !body.trim()) return null;
  // Nothing to do when it already says this. Same reasoning as the manifest: a
  // rewrite that changes nothing is a window in which a crash can lose
  // something, for no gain.
  if (readPreamble(ideaboxPath) === body) return path;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

/**
 * The captured preamble, or null.
 *
 * Null is the ordinary answer for a project that migrated before this existed,
 * and it means the renderer falls back to the standard template — which is what
 * that project already has in its file, so nothing changes for it.
 */
export function readPreamble(ideaboxPath) {
  const path = preamblePath(ideaboxPath);
  if (!path || !existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return null;
    // Trailing blank lines are structural, not content — the renderer puts its
    // own separator before `## Ideas`, and the parser pops them on the way back
    // (`lib/ideabox.js`), so leaving one here costs the fixed point that the
    // whole cutover rests on. `writePreamble` never stores one because it
    // stores what the parser already popped; a sidecar written BY HAND does,
    // because every editor ends a file with a newline — and writing one by hand
    // is the documented recovery for a project that migrated before this
    // existed.
    const lines = text.split('\n');
    while (lines.length && lines.at(-1).trim() === '') lines.pop();
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null;
  }
}
