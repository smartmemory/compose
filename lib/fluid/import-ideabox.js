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

  const provenance = { origin: 'import:ideabox' };

  // Idempotence: a handle already present is left ALONE, not overwritten.
  // Re-running must not clobber edits made through the tools after the first
  // import, and must not throw on the handle-already-issued guard.
  const existing = new Set((await provider.listRecords()).map((r) => r.handle));

  const imported = [];
  const skipped = [];
  const clusterHandles = [];

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
      cluster: clusterHandle,
      cluster_order: clusterOrder,
      tags: idea.tags ?? [],
      source: idea.source || null,
      links: idea.mapsTo ? [{ type: 'maps_to', target: idea.mapsTo }] : [],
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

  return {
    imported,
    skipped,
    clusters: clusterHandles,
    // True when the document had content and every handle in it was already
    // present — i.e. this was a re-run, not a first import.
    alreadyImported: imported.length === 0 && skipped.length > 0,
  };
}
