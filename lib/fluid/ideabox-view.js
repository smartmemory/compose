/**
 * lib/fluid/ideabox-view.js — fluid records → the ideabox's client-facing shape.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-2 (D21, reversed after review).
 *
 * THE ONE MAPPING
 * ---------------
 * `/api/ideabox` and every mutation response are produced HERE, from records.
 * The first draft of this slice derived them by parsing the markdown projection
 * the write had just rendered — one shape, reusing a proven parser, no second
 * adapter to drift. That was wrong for two reasons that outrank tidiness:
 *
 *   1. **The feature's acceptance criterion says otherwise** ("`useIdeaboxStore`
 *      / `/api/ideabox` serve from fluid records", design.md). Parsing the
 *      projection is serving from a rendering of the records, which is not the
 *      same claim.
 *   2. **It is only correct on the local provider.** The projection is a LOCAL
 *      file. Configure the SmartMemory provider — a store shared across machines
 *      — and a write on machine A never regenerates machine B's markdown, so B's
 *      REST and UI serve an indefinitely stale view of a store that is perfectly
 *      up to date. Fidelity of the projection says nothing about its freshness.
 *
 * The cost of this direction is the one the first draft was avoiding: this file
 * is a second place where a record's fields become a client's fields, and a
 * field added to the record contract but not here is invisible to the cockpit.
 * That is bounded by a test asserting this projection and the markdown one carry
 * the same field set, so the two cannot silently disagree.
 *
 * WHY THE SHAPE IS THE LEGACY PARSER'S AND NOT THE RECORD'S
 * --------------------------------------------------------
 * `id` here is the record's HANDLE (`IDEA-42`), not its `id` (a provider UUID
 * that changes on a provider swap). Every client keys on the handle and always
 * has. `description` is the record's `body`, `status` is the uppercase display
 * token, and an untriaged priority is an em dash rather than null. Returning raw
 * records would have been cleaner and would have broken the cockpit, the mobile
 * app and their tests in the same commit.
 */

import { toMarkdownDate } from './ideabox-dates.js';
import { KIND } from './provider.js';

/** Canonical status → the display token the surfaces have always rendered. */
const STATUS_TOKEN = Object.freeze({
  new: 'NEW',
  discussing: 'DISCUSSING',
  promoted: 'PROMOTED',
  killed: 'KILLED',
});

/** The numeric suffix of a handle, which clients sort and display as `num`. */
export function handleNumber(handle) {
  const m = /-([0-9]+)$/.exec(handle ?? '');
  return m ? Number(m[1]) : 0;
}

/**
 * One record → one client idea.
 *
 * @param {object} record a normalized fluid record
 * @param {Map<string,string>} clusterTitles handle → display title. Clients show
 *   and filter on the cluster's NAME, which is what the markdown surface always
 *   gave them; the record stores a handle so that renaming an umbrella does not
 *   orphan its members. Resolution happens here rather than at the call site so
 *   no caller can forget it and leak `CLUS-3` into the UI.
 */
export function toClientIdea(record, clusterTitles = new Map()) {
  return {
    id: record.handle,
    num: handleNumber(record.handle),
    title: record.title,
    // `status_label` preserves what an author wrote when the canonical enum
    // could not hold it (`RE-AIMED (2026-07-21)`); the markdown surface shows
    // that token, so this one must too.
    status: record.status_label || STATUS_TOKEN[record.status] || 'NEW',
    priority: record.priority ?? '—',
    tags: [...(record.tags ?? [])],
    source: record.source ?? '',
    description: record.body ?? '',
    cluster: record.cluster ? clusterTitles.get(record.cluster) ?? record.cluster : null,
    clusterHandle: record.cluster ?? null,
    mapsTo: record.links?.find((l) => l.type === 'maps_to')?.target ?? '',
    promotedTo: record.links?.find((l) => l.type === 'promoted_to')?.target ?? '',
    effort: record.effort ?? null,
    impact: record.impact ?? null,
    killedReason: record.killed?.reason ?? '',
    killedDate: record.killed ? toMarkdownDate(record.killed.at) : '',
    discussion: (record.discussion ?? []).map((d) => ({
      date: toMarkdownDate(d.at),
      author: d.author ?? 'unknown',
      text: d.text,
    })),
  };
}

/** Cluster handle → title, for `toClientIdea`. */
export function clusterTitleMap(clusters) {
  return new Map((clusters ?? []).map((c) => [c.handle, c.title]));
}

/**
 * The whole `/api/ideabox` payload, read from the provider.
 *
 * Live and killed ideas are separate arrays because that is the split every
 * client already renders, and `nextId` is derived rather than stored — the
 * markdown parser computed it the same way, and a stored counter would be a
 * second allocator disagreeing with the provider's.
 *
 * @param {import('./provider.js').FluidProvider} provider
 */
export async function ideaboxView(provider) {
  const [ideas, clusters] = await Promise.all([
    provider.listRecords({ kind: KIND.IDEA }),
    provider.listRecords({ kind: KIND.CLUSTER }),
  ]);

  const titles = clusterTitleMap(clusters);
  const byHandle = (a, b) => handleNumber(a.handle) - handleNumber(b.handle);
  const ordered = [...ideas].sort(byHandle);

  const maxNum = ordered.reduce((m, r) => Math.max(m, handleNumber(r.handle)), 0);

  return {
    ideas: ordered.filter((r) => r.status !== 'killed').map((r) => toClientIdea(r, titles)),
    killed: ordered.filter((r) => r.status === 'killed').map((r) => toClientIdea(r, titles)),
    nextId: maxNum + 1,
    clusters: [...clusters]
      .sort((a, b) => (a.cluster_order ?? Number.MAX_SAFE_INTEGER) - (b.cluster_order ?? Number.MAX_SAFE_INTEGER)
        || handleNumber(a.handle) - handleNumber(b.handle))
      .map((c) => ({ handle: c.handle, name: c.title, theme: c.body ?? '', order: c.cluster_order ?? null })),
  };
}

/**
 * One record → the client shape, resolving its cluster title from the provider.
 *
 * The convenience form for a mutation response, which has one record and no
 * cluster list in hand. `listRecords` for clusters is a handful of small reads
 * on the floor and one call on a remote provider, and getting the name right
 * matters more: a response whose `cluster` is `CLUS-3` where the hydrate says
 * `Umbrella A` makes an optimistic client redraw the idea into a group that does
 * not exist.
 */
export async function toClientIdeaWith(provider, record) {
  if (!record?.cluster) return toClientIdea(record);
  return toClientIdea(record, clusterTitleMap(await provider.listRecords({ kind: KIND.CLUSTER })));
}
