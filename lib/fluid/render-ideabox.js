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

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { KIND } from './provider.js';

const BANNER = [
  '<!-- GENERATED FILE — DO NOT EDIT.',
  '     Projection of the fluid-store idea records (COMP-PLAN-IDEA-UNIFY).',
  '     Edits here are overwritten on the next render. Change ideas with',
  '     `compose ideabox …` or the cockpit; both write to the store. -->',
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
  const priority = record.priority || '—';
  const tags = record.tags?.length ? ` | **Tags:** ${record.tags.join(' ')}` : '';
  out.push(`**Status:** ${status} | **Priority:** ${priority}${tags}`);

  if (record.source) out.push(`**Source:** ${record.source}`);
  if (record.body) out.push(`**Idea:** ${record.body}`);

  for (const link of record.links ?? []) {
    if (link.type === 'maps_to') out.push(`**Maps to:** ${link.target}`);
    if (link.type === 'promoted_to') out.push(`**Promoted to:** ${link.target}`);
  }

  if (record.discussion?.length) {
    out.push('**Discussion:**');
    for (const d of record.discussion) {
      out.push(`- [${d.at}] ${d.author ?? 'unknown'}: ${d.text}`);
    }
  }

  if (record.status === 'killed' && record.killed) {
    out.push(`**Killed:** ${record.killed.at} — ${record.killed.reason}`);
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
export function renderIdeabox({ ideas, clusters }) {
  const lines = [...BANNER, '', ...PREAMBLE, '', '## Ideas', ''];

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

  lines.push('## Killed Ideas', '');
  for (const idea of killed.sort(byHandle)) lines.push(...renderIdea(idea));

  return lines.join('\n');
}

/**
 * Read the records from a provider and render.
 * @param {import('./provider.js').FluidProvider} provider
 */
export async function renderIdeaboxFrom(provider) {
  const [ideas, clusters] = await Promise.all([
    provider.listRecords({ kind: KIND.IDEA }),
    provider.listRecords({ kind: KIND.CLUSTER }),
  ]);
  return renderIdeabox({ ideas, clusters });
}

/**
 * Render and write atomically (temp + rename), following the roadmap-gen
 * pattern — a half-written projection of canonical data is worse than none.
 */
export async function writeIdeaboxProjection(provider, outPath) {
  const markdown = await renderIdeaboxFrom(provider);
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = join(dirname(outPath), `.ideabox.md.tmp.${process.pid}`);
  writeFileSync(tmp, markdown, 'utf8');
  renameSync(tmp, outPath);
  return markdown;
}
