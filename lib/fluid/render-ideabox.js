/**
 * lib/fluid/render-ideabox.js — `ideabox.md` as a projection of the records.
 *
 * COMP-PLAN-IDEA-UNIFY S2, Decision 3's projection pattern (one canonical
 * store; surfaces are projections; never a second source), the same shape as
 * `ROADMAP.md ← feature.json`.
 *
 * The records are the ONLY input. This module never reads the existing
 * markdown to decide what to write — doing so is what turns a projection back
 * into a second source, and it is how a generator ends up preserving stale
 * content nobody can trace to an owner.
 *
 * Consequence, stated plainly: after the cutover the file is output. Hand edits
 * to it are lost on the next render, which is why the banner says so and why
 * the CLI (S3) is the supported way to change anything.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { withDirLock } from '../dir-lock.js';
import { toMarkdownDate } from './ideabox-dates.js';
import { KIND } from './provider.js';

// Says only what is true. The cockpit's write path is NOT on the store yet
// (S3b-2), and its endpoints fail closed until it is — so promising that "both
// write to the store" would invite exactly the edit that gets discarded.
const BANNER = [
  '<!-- GENERATED FILE — DO NOT EDIT.',
  '     Projection of the fluid-store idea records (COMP-PLAN-IDEA-UNIFY).',
  '     Edits here are overwritten on the next render. Change ideas with',
  '     `compose ideabox add|pri|kill|discuss|promote`, then `compose ideabox',
  '     render` if this file ever looks stale. -->',
];

const PREAMBLE = [
  '# Ideabox',
  '',
  '**Purpose:** Capture raw ideas before they\'re ready for the roadmap.',
  '',
  '## Conventions',
  '- **ID:** `IDEA-N` (sequential, never reuse)',
  '- **Status:** `NEW` | `DISCUSSING` | `PROMOTED` | `KILLED`',
  '- **Priority:** `P0` (promote now) | `P1` (next up) | `P2` (backlog) | `—` (untriaged)',
  '- **Source:** Where the idea came from',
  '- **Tags:** bare words, space-separated',
  // Carried forward from the hand-authored preamble: a real project convention
  // that the old template never knew about and silently deleted on every write.
  '- **Umbrella:** Ideas are grouped under thematic umbrellas. The umbrella name is a working label; ideas may move between umbrellas as they\'re discussed. IDs are stable.',
];

const STATUS_TOKEN = Object.freeze({
  new: 'NEW',
  discussing: 'DISCUSSING',
  promoted: 'PROMOTED',
  killed: 'KILLED',
});

function handleNumber(handle) {
  const m = /-([0-9]+)$/.exec(handle ?? '');
  return m ? Number(m[1]) : 0;
}

function renderIdea(record) {
  const out = [];
  out.push(`#### ${record.handle} — ${record.title}`);

  // `status_label` preserves what the author actually wrote when the canonical
  // enum could not hold it (`RE-AIMED (2026-07-21)`).
  const status = record.status_label || STATUS_TOKEN[record.status];
  const tags = record.tags?.length ? ` | **Tags:** ${record.tags.join(' ')}` : '';
  if (record.status === 'killed') {
    // A killed idea carries no priority segment. Not cosmetic: the legacy
    // serializer omits it (`lib/ideabox.js` — `**Status:** KILLED${tagStr}`),
    // and if the projection emits one, `serialize(parse(projection))` stops
    // being the identity. That fixed point is the assertion the whole cutover
    // rests on, and it would have broken the first time anyone killed an idea.
    // Invisible until now only because the Killed Ideas section was empty.
    out.push(`**Status:** ${status}${tags}`);
  } else {
    out.push(`**Status:** ${status} | **Priority:** ${record.priority || '—'}${tags}`);
  }

  if (record.source) out.push(`**Source:** ${record.source}`);
  if (record.body) out.push(`**Idea:** ${record.body}`);

  // Unrecognised hand-authored fields. The two serializers put these in
  // DIFFERENT slots and the projection has to match whichever one will read it
  // back: `serializeIdea` emits them after `**Idea:**` and before the trailing
  // known fields (`lib/ideabox.js`), while `serializeKilledIdea` emits them
  // after `**Killed:**`. Using the live slot for both meant a killed idea
  // carrying a custom field reordered the file on every write, so the
  // projection stopped being a fixed point of the serializer — the property the
  // whole cutover rests on. Killed ideas are emitted further down, next to
  // `**Killed:**`.
  if (!record.killed) {
    for (const extra of record.extra_fields ?? []) out.push(extra);
  }

  // `Promoted to:` is emitted BEFORE `Maps to:`, which reads backwards and is
  // deliberate. The legacy parser knows `Maps to` and does not know `Promoted
  // to`, so the latter lands in `_extraLines` — and the legacy serializer emits
  // extras BEFORE the trailing known fields (`lib/ideabox.js:436-440`, itself a
  // fix for reordering). Emitting them in the readable order therefore flips
  // them on the first `serialize(parse(projection))`, breaking the fixed point
  // for any idea carrying both edges. Invisible so far only because no idea has
  // ever had both.
  for (const link of record.links ?? []) {
    if (link.type === 'promoted_to') out.push(`**Promoted to:** ${link.target}`);
  }
  for (const link of record.links ?? []) {
    if (link.type === 'maps_to') out.push(`**Maps to:** ${link.target}`);
  }

  // The 2x2 matrix axes, in the legacy serializer's slot: after `Maps to:` and
  // before the discussion block (`lib/ideabox.js:441-442`). Position is not
  // cosmetic — the projection has to be a fixed point of that serializer.
  if (record.effort) out.push(`**Effort:** ${record.effort}`);
  if (record.impact) out.push(`**Impact:** ${record.impact}`);

  // `Killed:` precedes the discussion block for the same reason: that is where
  // `serializeKilledIdea` puts it (`lib/ideabox.js:465-471`). Emitting it after
  // the discussion cost the fixed point for every killed idea that had been
  // discussed — which is most of the ones anyone would want to kill.
  if (record.status === 'killed' && record.killed) {
    out.push(`**Killed:** ${toMarkdownDate(record.killed.at)} — ${record.killed.reason}`);
    // The killed serializer's slot for unrecognised fields: immediately after
    // `**Killed:**`, before the discussion block.
    for (const extra of record.extra_fields ?? []) out.push(extra);
  }

  if (record.discussion?.length) {
    out.push('**Discussion:**');
    for (const d of record.discussion) {
      out.push(`- [${toMarkdownDate(d.at)}] ${d.author ?? 'unknown'}: ${d.text}`);
    }
  }

  out.push('');
  return out;
}

/**
 * Render the markdown for a set of records.
 * @param {object} data
 * @param {Array<object>} data.ideas
 * @param {Array<object>} data.clusters
 * @returns {string}
 */
export function renderIdeabox({ ideas, clusters, preamble = null }) {
  // A project's own title and introduction, when it has one. The default
  // PREAMBLE is a template, and using it unconditionally deleted the heading and
  // prose an upgrading project had written for itself — the migration kept every
  // idea and silently rewrote the document around them
  // (COMP-IDEABOX-MIGRATE-DIALECT, Codex review finding 4).
  const preambleLines = preamble && preamble.length ? preamble : PREAMBLE;
  const lines = [...BANNER, '', ...preambleLines, '', '## Ideas', ''];
  // The legacy serializer emits a placeholder comment when the file contains no
  // `###` grouping heading at all, and the projection has to match it byte for
  // byte or `serialize(parse(projection))` stops being the identity. That state
  // is not exotic: it is every brand-new ideabox, and any ideabox whose ideas
  // have all been killed or promoted. Emitted below once both bucket counts are
  // known.
  const groupingPlaceholder = lines.length;

  // Deterministic ordering everywhere: rendering twice must produce identical
  // bytes, or the file churns in git on every unrelated write.
  const ordered = [...clusters].sort(
    (a, b) => (a.cluster_order ?? Number.MAX_SAFE_INTEGER) - (b.cluster_order ?? Number.MAX_SAFE_INTEGER)
      || handleNumber(a.handle) - handleNumber(b.handle)
  );

  const live = ideas.filter((i) => i.status !== 'killed');
  const killed = ideas.filter((i) => i.status === 'killed');
  const byHandle = (a, b) => handleNumber(a.handle) - handleNumber(b.handle);

  for (const cluster of ordered) {
    const members = live.filter((i) => i.cluster === cluster.handle).sort(byHandle);
    lines.push('---', '');
    lines.push(`### ${cluster.title}`, '');
    if (cluster.body) lines.push(`**Theme:** ${cluster.body}`, '');
    for (const idea of members) lines.push(...renderIdea(idea));
  }

  const unclustered = live.filter((i) => !i.cluster).sort(byHandle);
  if (unclustered.length) {
    lines.push('---', '');
    lines.push('### Unclustered', '');
    for (const idea of unclustered) lines.push(...renderIdea(idea));
  }

  // A live idea belongs to exactly one bucket: a cluster whose handle it names,
  // or Unclustered. An idea whose `cluster` holds anything else — most easily a
  // cluster NAME where a handle belongs, which the CLI accepts as free text —
  // matches neither filter and is silently absent from the file while its record
  // sits on disk. The projection is the only surface most readers ever see, so
  // that reads as deletion.
  //
  // Refusing is correct rather than merely safe: the alternative is to invent a
  // home for the idea, and a projection that guesses is a projection nobody can
  // trust. The write is abandoned before it starts, so the previous good file
  // survives to be re-rendered once the reference is fixed.
  if (ordered.length === 0 && unclustered.length === 0) {
    lines.splice(groupingPlaceholder, 0, '<!-- Ideas grouped by potential feature cluster -->', '');
  }

  const orphans = live.filter((i) => i.cluster && !clusters.some((c) => c.handle === i.cluster));
  if (orphans.length) {
    throw new Error(
      `fluid: cannot render the ideabox — ${orphans.length} idea(s) name a cluster that ` +
      `does not exist, and would silently vanish from the projection: ` +
      orphans.map((i) => `${i.handle} → "${i.cluster}"`).join(', ') +
      `. Point each at a real cluster handle (or clear it) and render again.`
    );
  }

  lines.push('## Killed Ideas', '');
  for (const idea of killed.sort(byHandle)) lines.push(...renderIdea(idea));

  return lines.join('\n');
}

/**
 * Read the records from a provider and render.
 * @param {import('./provider.js').FluidProvider} provider
 */
export async function renderIdeaboxFrom(provider, { preamble = null } = {}) {
  const [ideas, clusters] = await Promise.all([
    provider.listRecords({ kind: KIND.IDEA }),
    provider.listRecords({ kind: KIND.CLUSTER }),
  ]);
  return renderIdeabox({ ideas, clusters, preamble });
}

/**
 * NOT read from the destination.
 *
 * Carrying the existing file's preamble forward would preserve a project's own
 * title and introduction through migration — which is a real loss today
 * (COMP-IDEABOX-MIGRATE-DIALECT FU-4) — but it also makes the DESTINATION
 * authoritative, and `render` is documented as the way back from any hand edit
 * (`lib/ideabox-cli.js`). Reading the file we are about to repair means a
 * hand-corrupted heading survives the repair. The two cannot both hold while
 * the preamble lives only in the file; it has to become canon first.
 *
 * `renderIdeabox` therefore still ACCEPTS a preamble, and nothing supplies one.
 */

/**
 * Render and write atomically (temp + rename), following the roadmap-gen
 * pattern — a half-written projection of canonical data is worse than none.
 *
 * SERIALIZED AGAINST OTHER RENDERS, not just internally atomic.
 *
 * Atomicity alone leaves a real race once there are two writers (the CLI and the
 * REST API, from S3b-2). Each mutation is individually locked inside the
 * provider, but the render is a separate read-then-publish: writer A can read a
 * snapshot, writer B can then mutate AND publish a newer projection, and A's
 * rename lands last with the older content. Canon is untouched — the records are
 * still right — but the generated file stays wrong until the next write, and it
 * is the surface humans read.
 *
 * Taking the provider's mutation lock around read-and-publish closes it without
 * needing a reentrant lock: the mutation has already released by the time this
 * runs, and whichever render acquires last re-reads the current records, so the
 * file that lands last is the correct one.
 *
 * A provider with no lock (SmartMemory — see `factory.js`) renders unserialized,
 * which is the documented state of that provider rather than a new gap.
 */
export async function writeIdeaboxProjection(provider, outPath) {
  // THE SINGLE DOOR.
  //
  // Every projection write replaces the user's ideabox wholesale, so every
  // projection write is a potential erasure — and the migration gate that
  // prevents it used to be applied caller-by-caller. It was on the CLI render
  // and absent from the HTTP render, which meant a button in the cockpit could
  // do what the equivalent command refused to
  // (COMP-IDEABOX-MIGRATE-DIALECT, Codex review finding 1). Guarding each
  // caller is a list that has to stay complete forever; guarding the boundary
  // they all pass through is a fact. It goes here.
  //
  // Idempotent for the ordinary case: after a normal mutation the store is
  // ahead of the file, which the gate reads as already-migrated and returns
  // without work.
  //
  // DELIBERATELY OUTSIDE `withDirLock`, and it must stay there. The gate can
  // import, importing calls `provider.createRecord`, and that takes this same
  // lock — which is a non-reentrant `mkdirSync` lock (`lib/dir-lock.js`). Moving
  // this call under the lock to close the read-then-write window deadlocks every
  // migration: measured, it fails after the full 30s lock timeout rather than
  // completing. The remaining window (the file changing between this check and
  // the replacement below) is real and is tracked as FU-4's neighbour, FU-3 in
  // `docs/bugs/COMP-IDEABOX-MIGRATE-DIALECT/followups.md`; closing it needs a
  // source fingerprint re-checked inside the lock, not a bigger critical
  // section.
  const { ensureIdeaboxMigrated } = await import('./ideabox-migrate.js');
  await ensureIdeaboxMigrated(provider, outPath);

  return provider.lockPath
    ? withDirLock(provider.lockPath, () => publishProjection(provider, outPath))
    : publishProjection(provider, outPath);
}

async function publishProjection(provider, outPath) {
  // Rendered BEFORE the destination is touched, so a render that refuses (an
  // idea naming a cluster that does not exist) leaves the previous good file
  // exactly where it was rather than replacing it with a partial view.
  const markdown = await renderIdeaboxFrom(provider);
  mkdirSync(dirname(outPath), { recursive: true });
  // randomUUID, not pid: two renders from one process must not collide on the
  // temp name, and a recycled pid must not adopt a stranded file. Cleaned up on
  // failure because this directory is tracked — a leftover `.ideabox.md.tmp.*`
  // is named to be committed by accident.
  const tmp = join(dirname(outPath), `.ideabox.md.tmp.${randomUUID()}`);
  try {
    writeFileSync(tmp, markdown, 'utf8');
    renameSync(tmp, outPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return markdown;
}
