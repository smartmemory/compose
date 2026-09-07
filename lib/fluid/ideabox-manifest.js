/**
 * lib/fluid/ideabox-manifest.js — a durable record of a migration in flight.
 *
 * COMP-IDEABOX-MIGRATE-DIALECT FU-1.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * ----------------------------------
 * `importIdeabox` writes records sequentially. Crash on idea 2 and ideas 3..N
 * were never issued, so they carry no event — and the gate's resume policy is
 * derived from the event log, so it classifies every one of them as a
 * hand-added stray and refuses. The recovery the refusal names (`compose
 * ideabox add`, then `render`) runs the same gate, so the installation is
 * stranded with no way forward.
 *
 * The event log can only testify about handles the import reached. The
 * unattempted TAIL of a migration leaves no trace anywhere, which is why this
 * has to be an intention written down BEFORE the first write rather than an
 * inference from what happened after it.
 *
 * WHY IT IS SAFE TO TRUST
 * -----------------------
 * The manifest may only ever WIDEN the resumable set, and only under two
 * conditions checked together: it is still open (a completed import removes
 * it), and its hash matches the document being read right now. A hand-added
 * idea changes the document, so the hash stops matching and the gate refuses —
 * the protection the gate exists for is not weakened by anything here.
 *
 * WHERE IT LIVES
 * --------------
 * `.compose/data/`, beside the provider's lock. `data/` is blanket-gitignored
 * (`.gitignore:3`); the ideabox's own directory is TRACKED, and a stray file
 * there gets committed by accident (see the temp-file note in
 * `render-ideabox.js`). A manifest that is missing — a fresh clone, a provider
 * with no local lock path — degrades to REFUSE, which is the safe direction.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The source document changed WHILE its own migration was running.
 *
 * Raised by `importIdeabox` after its last write, when the file it parsed is no
 * longer the file on disk. During a migration the ideabox is still the user's
 * OWN SOURCE DOCUMENT, not generated output, so an edit to it is real content
 * that never reached the store — and the projection that follows would erase
 * it. Failing here leaves the manifest OPEN, so the next run refuses as
 * `IDEABOX_MANIFEST_STALE` and names the mid-migration edit.
 *
 * Lives in this leaf module rather than beside the other migration errors
 * because `ideabox-migrate.js` imports `importIdeabox`, so importing back from
 * it would close a cycle.
 */
export class IdeaboxSourceChangedDuringImport extends Error {
  constructor(ideaboxPath) {
    super(
      `compose: the ideabox at ${ideaboxPath} was edited while its migration was running, so the ` +
      `import stopped before finishing. Until the migration completes this file is still your ` +
      `source document rather than generated output, and continuing would have replaced it with a ` +
      `projection built from the version read at the start — destroying whatever was just added. ` +
      `Nothing has been changed and the unfinished migration is still recorded. Records written ` +
      `before the edit are already in the store, so re-running will NOT pick the edit up. Decide ` +
      `which document is right and say so: \`compose ideabox adopt-file\` finishes the migration ` +
      `against the file as it now stands, keeping the edit; \`compose ideabox discard-edits\` puts ` +
      `the file back as the migration read it and finishes that, after saving a copy of the current ` +
      `file first.`
    );
    this.name = 'IdeaboxSourceChangedDuringImport';
    this.code = 'IDEABOX_SOURCE_CHANGED_DURING_IMPORT';
  }
}

/**
 * The current manifest format.
 *
 * v2 adds `text`: the source markdown itself, not only its hash. That is what
 * makes `compose ideabox discard-edits` LOSSLESS — without the original
 * document there is nothing to put back, and the only recovery from a
 * mid-migration edit is to adopt whatever the file now says. An ideabox is a
 * small file and this is written once per migration.
 *
 * A v1 manifest is still valid and still resumes; it simply has no `text`, so
 * `discard-edits` refuses on one and names `adopt-file` as its recovery.
 */
export const MANIFEST_VERSION = 2;

/** Content identity of the document a migration was planned against. */
export function hashMarkdown(markdown) {
  return createHash('sha256').update(String(markdown ?? ''), 'utf8').digest('hex');
}

/**
 * Where this provider keeps the manifest for this ideabox, or null when there
 * is nowhere durable to put one.
 *
 * Derived from `provider.lockPath`, which is the one machine-local, gitignored
 * location both the gate and the importer already have in hand. Keyed by the
 * ideabox path so two ideaboxes under one project do not share a manifest.
 * A provider with no lock path (SmartMemory — see `factory.js`) gets null and
 * therefore no resume widening, which matches its already-documented lack of
 * machine-local coordination.
 */
export function manifestPath(provider, ideaboxPath) {
  if (!provider?.lockPath || !ideaboxPath) return null;
  const key = createHash('sha256').update(String(ideaboxPath)).digest('hex').slice(0, 12);
  return join(dirname(provider.lockPath), `ideabox-migration-${key}.json`);
}

/**
 * Declare a migration BEFORE the first record is written.
 *
 * @param {object} provider
 * @param {string} ideaboxPath
 * @param {object} plan
 * @param {string} plan.markdown the exact text that was parsed
 * @param {string[]} plan.planned every idea handle the import intends to write
 * @param {string[]} [plan.plannedClusters] cluster NAMES, for diagnostics only —
 *   cluster handles are allocated by the store and are not known in advance,
 *   and the gate's resume decision is about idea handles from the markdown.
 * @returns {string|null} the path written, or null when there is no home
 */
export function openManifest(provider, ideaboxPath, { markdown, planned, plannedClusters = [] }) {
  const path = manifestPath(provider, ideaboxPath);
  if (!path) return null;
  const hash = hashMarkdown(markdown);

  // A RETRY MUST NOT TOUCH THE PLAN IT IS RETRYING.
  //
  // Every resumed import came through here again, and rewriting a manifest that
  // already says the same thing is pure risk: the file whose entire job is to
  // survive a crash was being destroyed and recreated by each attempt to
  // recover from one. An open manifest carrying this hash and this plan is
  // already correct, so it is left exactly where it is.
  const open = readManifest(provider, ideaboxPath);
  // An identical plan is left exactly where it is — EXCEPT when it predates the
  // stored text. We are holding the very document a v1 manifest failed to keep,
  // so upgrading it here costs one write and gives an in-flight migration the
  // lossless recovery it was started without.
  if (open && open.hash === hash && sameSet(open.planned, planned)
      && typeof open.text === 'string') return path;

  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({
    version: MANIFEST_VERSION,
    source: ideaboxPath,
    hash,
    // The document itself, so `discard-edits` has something to put back.
    text: String(markdown ?? ''),
    planned,
    plannedClusters,
    startedAt: new Date().toISOString(),
  }, null, 2);

  // Temp + rename, the pattern `publishProjection` uses on the projection.
  // A plain `writeFileSync` truncates first, so a crash or a full disk between
  // the truncate and the write leaves a manifest that is present but empty —
  // and a manifest that cannot be read is a manifest that does not vouch for
  // anything, which turns the whole remaining corpus into strays. `rename` is
  // atomic: the manifest is either the old plan or the new one, never neither.
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

/** Order-insensitive equality for two handle lists. */
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** The import finished. Removing the file is what makes "open" mean something. */
export function closeManifest(provider, ideaboxPath) {
  const path = manifestPath(provider, ideaboxPath);
  if (!path) return;
  rmSync(path, { force: true });
}

/**
 * The open manifest for this ideabox, or null.
 *
 * An unreadable or malformed manifest reads as absent: every ambiguous state
 * here has to fall back to refusing, because the one thing this must not do is
 * widen the resumable set on a guess.
 */
export function readManifest(provider, ideaboxPath) {
  const path = manifestPath(provider, ideaboxPath);
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data.hash !== 'string' || !Array.isArray(data.planned)) return null;
    return data;
  } catch {
    return null;
  }
}
