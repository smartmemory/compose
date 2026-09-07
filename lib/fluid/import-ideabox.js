/**
 * lib/fluid/import-ideabox.js — one-time markdown → fluid records import.
 *
 * COMP-PLAN-IDEA-UNIFY S2. `ONE-WAY-WRITES`: this is an import, executed once,
 * NOT a sync. There is no reverse path and there must never be one — the
 * ideabox↔vision-store fragmentation this epic exists to end was created by
 * exactly that kind of two-way bridge. After the import, `ideabox.md` is a
 * projection (see render-ideabox.js) and the records are canon.
 *
 * The import is deliberately conservative about identity:
 *   - existing `IDEA-N` handles are carried over VERBATIM, because they are
 *     cited in docs, commits and conversation (the substrate ruling itself
 *     cites IDEA-20). A migration that renumbered would silently invalidate
 *     every one of those references.
 *   - every imported record is stamped `origin: import:ideabox`, so a migrated
 *     row stays distinguishable from a natively captured one for the rest of
 *     its life. Provenance is captured at write time and never retrofitted.
 */

import { readFileSync } from 'node:fs';

import { parseIdeabox } from '../ideabox.js';
import { toRecordTimestamp } from './ideabox-dates.js';
import {
  IdeaboxSourceChangedDuringImport,
  closeManifest,
  hashMarkdown,
  openManifest,
} from './ideabox-manifest.js';
import { writePreamble } from './ideabox-preamble.js';
import { assertIdeaboxReadable } from './ideabox-readable.js';
import { KIND } from './provider.js';

/** Markdown status token → canonical fluid status. */
const STATUS_MAP = Object.freeze({
  NEW: 'new',
  DISCUSSING: 'discussing',
  PROMOTED: 'promoted',
  KILLED: 'killed',
});

/**
 * The ideabox writes free-form status values (`RE-AIMED (2026-07-21)`,
 * `PROMOTED (→ FEAT-1)`). Map on the leading token and keep the full original
 * so nothing is silently normalized away.
 */
function toStatus(raw) {
  const token = String(raw ?? '').trim().split(/[\s(]/)[0].toUpperCase();
  return STATUS_MAP[token] ?? 'new';
}

function toPriority(raw) {
  const p = String(raw ?? '').trim();
  return /^P[012]$/.test(p) ? p : null;
}

/**
 * Import an ideabox markdown document into a fluid provider.
 *
 * @param {import('./provider.js').FluidProvider} provider
 * @param {object} opts
 * @param {string} [opts.markdown] document contents
 * @param {string} [opts.path] read the document from here instead
 * @param {boolean} [opts.dryRun] compute the plan without writing
 * @returns {Promise<{imported: string[], skipped: string[], clusters: string[], alreadyImported: boolean}>}
 */
export async function importIdeabox(provider, { markdown, path, dryRun = false } = {}) {
  const source = markdown ?? readFileSync(path, 'utf8');
  const parsed = parseIdeabox(source);
  // FU-2. This function is directly callable, and it used to read a failed
  // parse as an empty document — importing only the subset it recognised and
  // leaving the rest to be projected away by the next render. Same shape as the
  // bug that destroyed 18 ideas, one level up: the guard was on the destructive
  // path, not on the parse.
  assertIdeaboxReadable(parsed, path ?? '(in-memory ideabox)');

  const provenance = { origin: 'import:ideabox' };

  // Idempotence: a handle already present is left ALONE, not overwritten.
  // Re-running must not clobber edits made through the tools after the first
  // import, and must not throw on the handle-already-issued guard.
  const existing = new Set((await provider.listRecords()).map((r) => r.handle));

  const imported = [];
  const skipped = [];
  const clusterHandles = [];

  // FU-1: THE INTENTION, WRITTEN DOWN BEFORE THE FIRST WRITE.
  //
  // Records are created one at a time. A crash on idea 2 leaves ideas 3..N
  // never issued, so they carry no event, so the gate reads them as hand-added
  // strays and refuses — and every recovery it names runs the same gate. The
  // log can only testify about handles the import REACHED; the unattempted tail
  // leaves no trace, so it has to be declared in advance or it cannot be
  // recovered at all.
  //
  // Written before the first `createRecord` of either population, and removed
  // only on success, so "open" means "an import started here and did not
  // finish". A dry run declares nothing because it writes nothing.
  const plannedHandles = [
    ...(parsed.ideas ?? []).map((i) => i.id),
    ...(parsed.killed ?? []).map((i) => i.id),
  ];
  if (!dryRun && plannedHandles.length) {
    openManifest(provider, path, {
      markdown: source,
      planned: plannedHandles,
      plannedClusters: (parsed.clusters ?? []).map((c) => c.name),
    });
  }

  // THE DOCUMENT AROUND THE IDEAS (FU-4).
  //
  // A project's own title and introduction are content too, and the projection
  // used to replace them with the standard template on the first render after
  // migration. Captured here, at the one moment the source document is
  // authoritative, from the PARSER'S OWN output rather than a second scan of
  // the same text. It goes to a TRACKED sibling of the ideabox,
  // `<ideabox>.preamble.md` — not beside the migration manifest, which is
  // gitignored, because a tracked projection generated from untracked input
  // loses the heading on every clone that did not run the migration. See
  // `ideabox-preamble.js`.
  if (!dryRun) writePreamble(path, parsed.preamble);

  // ---- clusters first: members reference them by handle --------------------
  const clusterHandleByName = new Map();
  for (const cluster of parsed.clusters ?? []) {
    const known = (await provider.listRecords({ kind: KIND.CLUSTER }))
      .find((r) => r.title === cluster.name);
    if (known) {
      clusterHandleByName.set(cluster.name, known.handle);
      skipped.push(known.handle);
      continue;
    }
    if (dryRun) {
      clusterHandleByName.set(cluster.name, `(new cluster) ${cluster.name}`);
      continue;
    }
    const rec = await provider.createRecord({
      kind: KIND.CLUSTER,
      title: cluster.name,
      // The umbrella's hand-authored Theme paragraph. This is the field the
      // whole cluster-as-record decision exists for.
      body: cluster.theme ?? '',
      cluster_order: cluster.order,
      provenance,
      // See below — the import is the one caller that must survive a rerun.
      reclaimAborted: true,
    });
    clusterHandleByName.set(cluster.name, rec.handle);
    clusterHandles.push(rec.handle);
    imported.push(rec.handle);
  }

  // ---- ideas ---------------------------------------------------------------
  const all = [
    ...(parsed.ideas ?? []).map((i) => ({ idea: i, killed: false })),
    ...(parsed.killed ?? []).map((i) => ({ idea: i, killed: true })),
  ];

  for (const { idea, killed } of all) {
    if (existing.has(idea.id)) {
      skipped.push(idea.id);
      continue;
    }
    const clusterHandle = idea.cluster ? clusterHandleByName.get(idea.cluster) ?? null : null;
    const clusterOrder = idea.cluster
      ? (parsed.clusters ?? []).find((c) => c.name === idea.cluster)?.order ?? null
      : null;

    const record = {
      kind: KIND.IDEA,
      // Verbatim. The whole point of the caller-supplied handle path.
      handle: idea.id,
      title: idea.title,
      body: idea.description ?? '',
      status: killed ? 'killed' : toStatus(idea.status),
      // Keep the author's token when the canonical enum cannot hold it, so a
      // closed enum does not quietly flatten `RE-AIMED (2026-07-21)` to `NEW`.
      status_label: STATUS_MAP[String(idea.status ?? '').trim().toUpperCase()]
        ? null
        : (idea.status || null),
      priority: toPriority(idea.priority),
      // Carried, not dropped. `parseIdeabox` already validates both against
      // their enums and yields null otherwise (`lib/ideabox.js:304-311`), so
      // there is nothing to re-check here — but omitting them is not a harmless
      // gap. This function is the first-use migration gate every upgrading
      // install runs, and the render that follows it rewrites the markdown from
      // the records. A dropped field is therefore deleted from the user's file
      // on upgrade, silently, with no way back. No idea in THIS repo carries
      // either, which is exactly why it went unnoticed.
      effort: idea.effort ?? null,
      impact: idea.impact ?? null,
      cluster: clusterHandle,
      cluster_order: clusterOrder,
      tags: idea.tags ?? [],
      source: idea.source || null,
      // Whatever the parser could not name, kept rather than discarded — MINUS
      // the fields that have a typed home. `**Promoted to:**` is one the legacy
      // parser does not know, so it lands in `_extraLines`; carrying it as an
      // opaque extra puts it beyond the reach of `promoteIdea`, which filters
      // stale `promoted_to` links before adding the new one
      // (`ideabox-ops.js`). The record would then render BOTH the old target and
      // the current one. A field with a typed representation must be imported
      // into it, not carried around it.
      extra_fields: extrasWithoutTypedFields(idea._extraLines ?? []),
      links: [
        ...(promotedTargetOf(idea._extraLines ?? [])
          ? [{ type: 'promoted_to', target: promotedTargetOf(idea._extraLines ?? []) }]
          : []),
        ...(idea.mapsTo ? [{ type: 'maps_to', target: idea.mapsTo }] : []),
      ],
      killed: (killed || idea.killedReason)
        ? {
          at: toRecordTimestamp(idea.killedDate),
          reason: idea.killedReason || 'reason not recorded in markdown',
        }
        : null,
      discussion: (idea.discussion ?? []).map((d) => ({
        at: toRecordTimestamp(d.date),
        text: d.text ?? '',
        author: d.author ?? null,
      })),
      provenance,
    };

    if (dryRun) {
      imported.push(idea.id);
      continue;
    }
    // `reclaimAborted` makes the import RESTARTABLE. Creation burns the handle
    // before writing the record, and this loop skips only handles with a live
    // record — so a crash between those two steps leaves a handle that is
    // issued, absent, and permanently un-creatable. Without this flag the
    // one-time migration of a project's entire idea corpus cannot be rerun
    // after a partial failure, which is the failure it is most likely to have.
    // Narrow by construction: the provider reclaims ONLY a handle that was
    // never live and never deleted, and no other caller passes this.
    await provider.createRecord({ ...record, reclaimAborted: true });
    imported.push(idea.id);
  }

  // THE DOCUMENT IS STILL THE USER'S UNTIL THIS FINISHES.
  //
  // Every check up to here compares IDs, and an edit to an idea that ALREADY
  // has a record changes no ID at all: the assessment sees a file whose handles
  // are all known, calls it consistent, and the projection replaces the edited
  // body with the one imported from the version read at the start. The edit is
  // destroyed and it existed nowhere else.
  //
  // The scope is what makes this different from a hand edit to generated
  // output. DURING the migration this file is the source document — nothing in
  // it has reached the store yet — so an edit to it is unrecoverable content.
  // AFTER the migration it is output, and discarding hand edits is exactly what
  // `render` is for (`lib/ideabox-cli.js`); that contract is untouched. The
  // open manifest is precisely the marker that separates the two states.
  //
  // Failing here leaves the manifest OPEN on purpose. Nothing has been
  // destroyed, and the next run meets the refusal that already exists for this
  // shape: the hash no longer matches, so the gate stops with
  // `IDEABOX_MANIFEST_STALE` naming the mid-migration edit.
  if (!dryRun && path && plannedHandles.length) {
    if (hashMarkdown(readFileSync(path, 'utf8')) !== hashMarkdown(source)) {
      throw new IdeaboxSourceChangedDuringImport(path);
    }
  }

  // The import completed. Closing the manifest is what makes an OPEN one mean
  // "interrupted" — and it is what keeps the protection intact, since a
  // hand-added idea after a completed migration must still be refused.
  if (!dryRun) closeManifest(provider, path);

  return {
    imported,
    skipped,
    clusters: clusterHandles,
    // True when the document had content and every handle in it was already
    // present — i.e. this was a re-run, not a first import.
    alreadyImported: imported.length === 0 && skipped.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Typed fields hiding in the unrecognised pile
// ---------------------------------------------------------------------------

/** `**Promoted to:** X` written by hand, which the parser does not recognise. */
const PROMOTED_TO_RE = /^\*\*Promoted to:\*\*\s*(.+)$/;

function promotedTargetOf(extraLines) {
  for (const line of extraLines) {
    const m = String(line).match(PROMOTED_TO_RE);
    if (m) return m[1].trim();
  }
  return null;
}

/** Drop the lines lifted into typed fields so they are not rendered twice. */
function extrasWithoutTypedFields(extraLines) {
  return extraLines.filter((l) => !PROMOTED_TO_RE.test(String(l)));
}
