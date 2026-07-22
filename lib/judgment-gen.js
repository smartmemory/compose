/**
 * lib/judgment-gen.js — judgment projections (S04).
 *
 * records → REGISTER.md, LEDGER.md, OBJECTIVE.md, positions/<slug>.md, and
 * the OKF bundle root index.md. Projections are PURE OUTPUT: generation
 * reads only records — never an existing projection — so any hand-edit is
 * overwritten by the next regeneration and there are no preserved sections
 * (curated prose is `note` records rendered at their anchors).
 *
 * Output is a deterministic function of the records (no wall-clock in the
 * bytes), which is what makes the fixed-point roundtrip guard meaningful:
 * regen of the generator's own output is byte-identical.
 *
 * OKF (design Decision 8): per-item files carry frontmatter type/title/
 * timestamp plus the smartmemory { reference: true, origin } extension;
 * `resource` is emitted ONLY when a record carries a real provider id AND
 * an enrichment workspace (team_id) is configured — a made-up resource
 * would be a dangling identity claim. The bundle root carries
 * okf_version "0.1" and no type (okf.ts renderOkf rule).
 */
import {
  readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { createJudgmentStore } from './judgment/store/index.js';

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

function smartmemoryTeamId(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf8'));
    return config?.judgment?.enrichment?.smartmemory?.team_id ?? null;
  } catch {
    return null;
  }
}

// ── snapshot ────────────────────────────────────────────────────────────────

/**
 * Load everything projection-relevant from the store into a plain snapshot,
 * so the generator core stays pure.
 */
function loadSnapshot(cwd) {
  const store = createJudgmentStore(cwd);
  const positions = store.listPositionSlugs().map((slug) => ({
    slug,
    chain: store.readPositionChain(slug),
    status: store.derivePositionStatus(slug),
  }));
  return {
    positions,
    joints: store.listJoints(),
    ledger: store.readLedgerEvents(),
    teamId: smartmemoryTeamId(cwd),
  };
}

// ── rendering helpers ───────────────────────────────────────────────────────

function anchoredNotes(ledger, anchor) {
  return ledger.filter((e) => e.kind === 'note' && e.anchor === anchor);
}

function renderNotes(notes) {
  return notes.map((n) => `> **${n.title}** — ${n.body ?? ''}`.trimEnd()).join('\n\n');
}

function okfFrontmatter({ type, title, timestamp, resource }) {
  const lines = ['---'];
  if (type) lines.push(`type: ${type}`);
  else lines.push('okf_version: "0.1"');
  lines.push(`title: ${title}`);
  if (timestamp) lines.push(`timestamp: "${timestamp}"`);
  if (resource) lines.push(`resource: "${resource}"`);
  lines.push('smartmemory:');
  lines.push('  reference: true');
  lines.push('  origin: compose-projection');
  lines.push('---');
  return lines.join('\n');
}

function buildResource(teamId, providerId) {
  if (!teamId || !providerId) return null;
  return `smartmemory://${encodeURIComponent(teamId)}/${encodeURIComponent(providerId)}`;
}

function renderClaim(claim) {
  const lines = [`- **${claim.id}** \`[${claim.grounding}]\`${claim.owner_locked ? ' `[owner-locked]`' : ''} ${claim.text}`];
  if (Array.isArray(claim.supports) && claim.supports.length > 0) {
    lines.push(`  - supports: ${claim.supports.join(', ')}`);
  }
  if (claim.elicitation) {
    lines.push(`  - elicitation: asked "${claim.elicitation.asked}" (answered ${claim.elicitation.answered_at}, ref ${claim.elicitation.answer_ref})`);
  }
  return lines.join('\n');
}

function renderPosition(position, snapshot) {
  const { slug, chain, status } = position;
  const current = chain[chain.length - 1];
  const resource = buildResource(snapshot.teamId, current?.provider_ids?.smartmemory);
  const parts = [okfFrontmatter({
    type: 'position',
    title: slug,
    timestamp: current?.provenance?.written_at,
    resource,
  })];
  parts.push('');
  parts.push(`# ${slug}`);
  parts.push('');
  parts.push(`**Status:** ${status} · **Conviction:** ${current.conviction?.level ?? '—'} (${current.conviction?.source ?? '—'})`);
  if (current.retracted) {
    parts.push('');
    parts.push('**Retracted.** The latest revision is a tombstone.');
  }
  if (current.claims?.length) {
    parts.push('');
    parts.push(`## Claims (r${current.rev})`);
    parts.push('');
    for (const claim of current.claims) parts.push(renderClaim(claim));
  }
  if (current.rejected_alternatives?.length) {
    parts.push('');
    parts.push('## Rejected alternatives');
    parts.push('');
    for (const alt of current.rejected_alternatives) parts.push(`- ${alt.what} — ${alt.why}`);
  }
  parts.push('');
  parts.push('## History');
  parts.push('');
  for (const rev of chain) {
    const marks = [];
    if (rev.supersedes) marks.push(`supersedes ${rev.supersedes}`);
    if (rev.retracted) marks.push('tombstone');
    parts.push(`- r${rev.rev} — ${rev.provenance?.written_at ?? 'unknown'}${marks.length ? ` (${marks.join(', ')})` : ''}`);
  }
  const notes = anchoredNotes(snapshot.ledger, `position:${slug}`);
  if (notes.length) {
    parts.push('');
    parts.push(renderNotes(notes));
  }
  return parts.join('\n') + '\n';
}

function renderJointSection(joint, snapshot) {
  const parts = [`## ${joint.slug}`];
  parts.push('');
  parts.push(`- **Question:** ${joint.question}`);
  parts.push(`- **If true:** ${joint.branch_true}`);
  parts.push(`- **If false:** ${joint.branch_false}`);
  parts.push(`- **Method:** ${joint.resolve_by} · cost ${joint.cost} · rank ${joint.rank}`);
  parts.push(`- **State:** ${joint.state}`);
  if (joint.flags?.length) parts.push(`- **Flags:** ${joint.flags.join(', ')}`);
  if (joint.ext) {
    parts.push(joint.ext.judgment_dispatch
      ? `- **Ext:** judgment-dispatch — ${joint.ext.reason}`
      : `- **Ext:** sharpened "${joint.ext.sharpened_question}" · bar: ${joint.ext.bar} · falsifier: ${joint.ext.falsifier}`);
  }
  if (joint.straddle) {
    parts.push(`- **Straddle:** signal ${joint.straddle.discriminating_signal} · kill: ${joint.straddle.kill_criteria}`);
  }
  if (joint.resolution) {
    const r = joint.resolution;
    const detail = r.evidence ?? r.learned ?? r.reason ?? r.why ?? '';
    parts.push(`- **Resolution:** ${r.outcome}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    if (r.outcome === 'inconclusive' && r.would_have_settled) {
      parts.push(`  - would have settled: ${r.would_have_settled}`);
    }
    if (r.ext_result) {
      parts.push(`  - ext result: ${r.ext_result.outcome} (${r.ext_result.found_or_provoked}) — ${r.ext_result.search_record}`);
    }
  }
  if (joint.dissolution) {
    parts.push(`- **Dissolved into:** ${joint.dissolution.decomposed_into.join(', ')}`);
  }
  const notes = anchoredNotes(snapshot.ledger, `joint:${joint.slug}`);
  if (notes.length) {
    parts.push('');
    parts.push(renderNotes(notes));
  }
  return parts.join('\n');
}

const RANK_ORDER = { high: 0, medium: 1 };

function renderRegister(snapshot) {
  const parts = ['# Judgment Register'];
  const headerNotes = anchoredNotes(snapshot.ledger, 'register-header');
  if (headerNotes.length) {
    parts.push('');
    parts.push(renderNotes(headerNotes));
  }
  const joints = [...snapshot.joints].sort((a, b) =>
    (RANK_ORDER[a.rank] - RANK_ORDER[b.rank]) || a.slug.localeCompare(b.slug));
  for (const joint of joints) {
    parts.push('');
    parts.push(renderJointSection(joint, snapshot));
  }
  const footerNotes = anchoredNotes(snapshot.ledger, 'register-footer');
  if (footerNotes.length) {
    parts.push('');
    parts.push(renderNotes(footerNotes));
  }
  return parts.join('\n') + '\n';
}

const EVENT_DETAIL_KEYS = [
  'refs', 'rejected', 'conviction', 'trigger', 'open_joints', 'prediction',
  'disposition', 'recall_verdict', 'attribution', 'prediction_ref',
  'prediction_grade', 'reason', 'rank_change', 'elicitation',
];

function renderLedger(snapshot) {
  const parts = ['# Judgment Ledger'];
  const headerNotes = anchoredNotes(snapshot.ledger, 'ledger-header');
  if (headerNotes.length) {
    parts.push('');
    parts.push(renderNotes(headerNotes));
  }
  snapshot.ledger.forEach((event, i) => {
    parts.push('');
    parts.push(`## ${i + 1}. ${event.kind}: ${event.title}`);
    if (event.body) {
      parts.push('');
      parts.push(event.body);
    }
    const details = EVENT_DETAIL_KEYS
      .filter((k) => event[k] !== undefined && !(Array.isArray(event[k]) && event[k].length === 0))
      .map((k) => `- ${k}: ${typeof event[k] === 'string' ? event[k] : JSON.stringify(event[k])}`);
    if (event.anchor) details.push(`- anchor: ${event.anchor}`);
    if (details.length) {
      parts.push('');
      parts.push(details.join('\n'));
    }
    parts.push('');
    parts.push(`*${event.provenance?.written_at ?? ''}${event.provenance?.via ? ` · via ${event.provenance.via}` : ''}*`);
  });
  return parts.join('\n') + '\n';
}

function renderObjective(snapshot) {
  const objective = snapshot.positions.find((p) => p.slug === 'objective');
  if (objective) return renderPosition(objective, snapshot);
  return [
    okfFrontmatter({ type: 'position', title: 'objective' }),
    '',
    '# objective',
    '',
    'No objective recorded.',
  ].join('\n') + '\n';
}

function renderIndex(snapshot) {
  const parts = [okfFrontmatter({ type: null, title: 'Judgment canon' })];
  parts.push('');
  parts.push('# Judgment canon (generated)');
  parts.push('');
  parts.push('All files in this bundle are projections of `records/` — regenerated, never hand-edited.');
  parts.push('');
  parts.push('- [Register](REGISTER.md)');
  parts.push('- [Ledger](LEDGER.md)');
  parts.push('- [Objective](OBJECTIVE.md)');
  if (snapshot.positions.length) {
    parts.push('');
    parts.push('## Positions');
    parts.push('');
    for (const p of snapshot.positions) {
      parts.push(`- [${p.slug}](positions/${p.slug}.md) — ${p.status}`);
    }
  }
  return parts.join('\n') + '\n';
}

// ── public surface ──────────────────────────────────────────────────────────

/**
 * Pure generator core: snapshot → { relPath: content }. Exported for tests;
 * `now` is accepted for interface stability but the output deliberately
 * contains no wall-clock bytes (fixed-point requirement).
 */
export function generateFromRecords(snapshot, { now } = {}) { // eslint-disable-line no-unused-vars
  const files = {
    'docs/judgment/REGISTER.md': renderRegister(snapshot),
    'docs/judgment/LEDGER.md': renderLedger(snapshot),
    'docs/judgment/OBJECTIVE.md': renderObjective(snapshot),
    'docs/judgment/index.md': renderIndex(snapshot),
  };
  for (const position of snapshot.positions) {
    files[`docs/judgment/positions/${position.slug}.md`] = renderPosition(position, snapshot);
  }
  return files;
}

/**
 * Regenerate every projection from records on disk. Atomic per file.
 * @returns {{ files: string[] }} relative paths written
 */
export function regenerateProjections(cwd) {
  const files = generateFromRecords(loadSnapshot(cwd));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(cwd, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    atomicWrite(path, content);
  }
  return { files: Object.keys(files) };
}

/**
 * Fixed-point roundtrip guard: regenerate in memory and compare byte-for-byte
 * against what is on disk. Any drift (hand-edit, stale projection) fails.
 * @returns {{ fixedPoint: boolean, diffs: string[] }}
 */
export function checkProjectionRoundtrip(cwd) {
  const files = generateFromRecords(loadSnapshot(cwd));
  const diffs = [];
  for (const [rel, content] of Object.entries(files)) {
    const path = join(cwd, rel);
    const onDisk = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (onDisk !== content) diffs.push(rel);
  }
  // Orphan detection: a projection file the generator no longer emits (stale
  // position projection, leftover from an older generator) is drift too.
  const positionsDir = join(cwd, 'docs', 'judgment', 'positions');
  if (existsSync(positionsDir)) {
    for (const f of readdirSync(positionsDir)) {
      if (!f.endsWith('.md')) continue;
      const rel = `docs/judgment/positions/${f}`;
      if (!(rel in files)) diffs.push(`${rel} (orphan — not emitted by the generator)`);
    }
  }
  return { fixedPoint: diffs.length === 0, diffs };
}
