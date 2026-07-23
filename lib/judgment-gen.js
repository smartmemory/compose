/**
 * lib/judgment-gen.js — judgment projections (S04).
 *
 * records → REGISTER.md, LEDGER.md, OBJECTIVE.md, SITUATION.md,
 * people/<slug>.md, positions/<slug>.md, and the OKF bundle root index.md.
 * Projections are PURE OUTPUT: generation
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
import {
  createJudgmentStore,
  effectiveStore,
  goalCutoverComplete,
} from './judgment/store/index.js';

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
  const rawStore = createJudgmentStore(cwd);
  const store = effectiveStore(rawStore);
  const positions = store.listPositionSlugs().map((slug) => ({
    slug,
    chain: store.readPositionChain(slug),
    status: store.derivePositionStatus(slug),
  }));
  return {
    positions,
    joints: store.listJoints(),
    ledger: store.readLedgerEvents(),
    people: store.listPeople(),
    situationEntities: store.listSituationEntities(),
    goalChain: store.readGoalChain(),
    goalState: store.readGoalState(),
    goalCutoverComplete: goalCutoverComplete(store),
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

function auditValue(value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function renderTraceLines(trace = [], { prefix = '  - ' } = {}) {
  return trace.map((entry) => {
    const prior = Object.entries(entry.prior ?? {})
      .map(([key, value]) => `${key}=${auditValue(value)}`)
      .join(', ');
    return `${prefix}corrected from ${prior} at ${entry.corrected_at ?? 'unknown'}`;
  });
}

function renderRecordedAndRemoval(entry, { prefix = '  - ' } = {}) {
  const lines = [];
  lines.push(`${prefix}recorded at ${entry.provenance?.written_at ?? 'unknown'}`);
  if (entry.removed) {
    lines.push(`${prefix}removed at ${entry.removed.at ?? 'unknown'} — ${entry.removed.reason}`);
  }
  return lines;
}

function renderAuditedFact(fact) {
  const lines = [`- **${fact.id}** ${fact.text}`];
  lines.push(`  - channel: \`${fact.channel}\``);
  if (fact.via !== undefined) lines.push(`  - via: ${fact.via}`);
  lines.push(`  - at: ${fact.at}`);
  lines.push(...renderTraceLines(fact.trace));
  return lines.join('\n');
}

const PERSON_SECTIONS = ['role', 'life', 'stated', 'revealed'];

function sectionTitle(section) {
  return section[0].toUpperCase() + section.slice(1);
}

function orderedPairLabel(left, right) {
  const suffix = (id) => Number.parseInt(String(id).replace(/^[^0-9]+/, ''), 10);
  const ids = [left, right].sort((a, b) => suffix(a) - suffix(b) || a.localeCompare(b));
  return `${ids[0]} ↔ ${ids[1]}`;
}

function renderPerson(person) {
  const lifecycle = person.facts.some((fact) => fact.channel === 'said') ? 'spoken' : 'stub';
  const parts = [okfFrontmatter({
    type: 'person',
    title: person.display_name,
    timestamp: person.provenance?.written_at,
  })];
  parts.push('');
  parts.push(`# ${person.display_name}`);
  parts.push('');
  parts.push(`**Lifecycle:** ${lifecycle}`);
  parts.push(`**Record:** \`${person.slug}\``);

  const factsById = new Map(person.facts.map((fact) => [fact.id, fact]));
  const rendered = new Set();
  for (const section of PERSON_SECTIONS) {
    parts.push('');
    parts.push(`## ${sectionTitle(section)}`);
    parts.push('');
    const sectionLines = [];
    for (const fact of person.facts.filter((entry) => entry.section === section)) {
      if (rendered.has(fact.id)) continue;
      const paired = fact.diverges_with ? factsById.get(fact.diverges_with) : null;
      const isStatedRevealedPair = (
        section === 'stated'
        && paired?.section === 'revealed'
        && paired.diverges_with === fact.id
      );
      sectionLines.push(renderAuditedFact(fact));
      rendered.add(fact.id);
      if (isStatedRevealedPair) {
        sectionLines.push(renderAuditedFact(paired));
        sectionLines.push(`  - divergence pair: ${orderedPairLabel(fact.id, paired.id)}`);
        rendered.add(paired.id);
      }
    }
    parts.push(sectionLines.length > 0 ? sectionLines.join('\n') : 'No facts recorded.');
  }

  parts.push('');
  parts.push('## Edges');
  parts.push('');
  if (person.edges.length === 0) {
    parts.push('None.');
  } else {
    for (const edge of person.edges) {
      parts.push(`- **${edge.id}** \`${edge.removed ? 'removed' : 'active'}\` — ${edge.kind} → [${edge.to}](${edge.to}.md)`);
      parts.push(...renderRecordedAndRemoval(edge));
    }
  }

  parts.push('');
  parts.push('## Open fields');
  parts.push('');
  if (person.open_fields.length === 0) {
    parts.push('None.');
  } else {
    for (const field of person.open_fields) {
      parts.push(`- **${field.id}** \`${field.status}\` — ${field.name}`);
      parts.push(`  - filled_by: ${field.filled_by ?? '—'}`);
      parts.push(`  - recorded at ${field.provenance?.written_at ?? 'unknown'}`);
      parts.push(...renderTraceLines(field.trace));
    }
  }

  parts.push('');
  parts.push('## Load links');
  parts.push('');
  if (person.load_links.length === 0) {
    parts.push('None.');
  } else {
    for (const link of person.load_links) {
      parts.push(`- **${link.id}** \`${link.removed ? 'removed' : 'active'}\` — fact ${link.fact} carries ${link.carries}`);
      parts.push(...renderRecordedAndRemoval(link));
    }
  }
  return parts.join('\n') + '\n';
}

function latestWrittenAt(records) {
  return records
    .map((record) => record.provenance?.written_at)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function renderSituation(snapshot) {
  const entities = [...(snapshot.situationEntities ?? [])].sort((a, b) => (
    a.display_name.localeCompare(b.display_name) || a.slug.localeCompare(b.slug)
  ));
  const parts = [okfFrontmatter({
    type: 'situation',
    title: 'Situation',
    timestamp: latestWrittenAt(entities),
  })];
  parts.push('');
  parts.push('# Situation');
  if (entities.length === 0) {
    parts.push('');
    parts.push('No situation entities recorded.');
  }
  for (const entity of entities) {
    parts.push('');
    parts.push(`## ${entity.display_name} (\`${entity.slug}\`)`);
    parts.push('');
    parts.push('### Facts');
    parts.push('');
    if (entity.facts.length === 0) {
      parts.push('None.');
    } else {
      for (const fact of entity.facts) parts.push(renderAuditedFact(fact));
    }

    parts.push('');
    parts.push('### Owed');
    parts.push('');
    if (entity.owed.length === 0) {
      parts.push('None.');
    } else {
      for (const owed of entity.owed) {
        parts.push(`> **OWED ${owed.id} · ${owed.status}** ${owed.name}`);
        parts.push(`> - why load-bearing: ${owed.why_load_bearing}`);
        parts.push(`> - filled_by: ${owed.filled_by ?? '—'}`);
        parts.push(`> - recorded at ${owed.provenance?.written_at ?? 'unknown'}`);
        parts.push(...renderTraceLines(owed.trace, { prefix: '> - ' }));
      }
    }

    parts.push('');
    parts.push('### Load links');
    parts.push('');
    if (entity.load_links.length === 0) {
      parts.push('None.');
    } else {
      for (const link of entity.load_links) {
        parts.push(`- **${link.id}** \`${link.removed ? 'removed' : 'active'}\` — fact ${link.fact} carries ${link.carries}`);
        parts.push(...renderRecordedAndRemoval(link));
      }
    }
  }
  return parts.join('\n') + '\n';
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
  'intent_id', 'tool', 'op',
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

function renderGoalClause(clause) {
  const lines = [`- **${clause.id}** ${clause.text}`];
  lines.push(`  - channel: \`${clause.channel}\``);
  if (clause.via !== undefined) lines.push(`  - via: ${clause.via}`);
  const citation = clause.elicitation;
  lines.push(
    `  - elicitation: asked "${citation.asked}" (answered ${citation.answered_at}, ref ${citation.answer_ref})`,
  );
  lines.push(...renderTraceLines(clause.trace));
  return lines.join('\n');
}

function tableCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderGoalObjective(snapshot) {
  const chain = snapshot.goalChain ?? [];
  const current = chain.at(-1);
  if (!current) {
    return [
      okfFrontmatter({ type: 'goal', title: 'Objective' }),
      '',
      '# Objective',
      '',
      'No goal recorded.',
    ].join('\n') + '\n';
  }

  const state = snapshot.goalState ?? { joints: [], load_links: [] };
  const parts = [okfFrontmatter({
    type: 'goal',
    title: 'Objective',
    timestamp: current.provenance?.written_at,
  })];
  parts.push('');
  parts.push('# Objective');
  parts.push('');
  parts.push(`**Current version:** v${current.version}`);
  const draft = (
    ['import', 'migration'].includes(current.provenance?.via)
    && !current.ratification
  );
  if (draft) {
    parts.push('');
    parts.push('**DRAFT HEALTH WARNING:** This imported/migrated goal is not owner-ratified.');
  }

  parts.push('');
  parts.push(`## Current clauses (v${current.version})`);
  parts.push('');
  for (const clause of current.clauses) parts.push(renderGoalClause(clause));

  parts.push('');
  parts.push('## Ratification citation');
  parts.push('');
  if (current.ratification) {
    parts.push(`- asked "${current.ratification.asked}"`);
    parts.push(`- quote: "${current.ratification.quote}"`);
    parts.push(
      `- answered ${current.ratification.answered_at}, ref ${current.ratification.answer_ref}`,
    );
  } else {
    parts.push('None — imported/migrated draft.');
  }

  parts.push('');
  parts.push('## Goal joints');
  parts.push('');
  if ((state.joints ?? []).length === 0) {
    parts.push('None.');
  } else {
    for (const link of state.joints) {
      parts.push(`- **${link.id}** \`${link.removed ? 'removed' : 'active'}\` — [${link.joint}](REGISTER.md#${link.joint})`);
      parts.push(...renderRecordedAndRemoval(link));
    }
  }

  parts.push('');
  parts.push('## Load-link bill');
  parts.push('');
  if ((state.load_links ?? []).length === 0) {
    parts.push('None.');
  } else {
    for (const link of state.load_links) {
      const version = Number(/^v([1-9][0-9]*)#/.exec(link.clause)?.[1]);
      const versionMark = version === current.version ? 'current version' : 'superseded version';
      parts.push(`- **${link.id}** \`${link.removed ? 'removed' : 'active'}\` — ${link.clause} \`${versionMark}\` carries ${link.carries}`);
      parts.push(...renderRecordedAndRemoval(link));
    }
  }

  parts.push('');
  parts.push('## Trajectory');
  parts.push('');
  parts.push('| Version | Date | Provocation | Diff note | Wording fix |');
  parts.push('|---|---|---|---|---|');
  for (const version of chain) {
    const provocation = version.provocation?.quote ?? 'unknown (migrated)';
    const wordingFix = version.clauses.some((clause) => (clause.trace?.length ?? 0) > 0)
      ? 'yes'
      : 'no';
    parts.push(
      `| v${version.version} | ${tableCell(version.provenance?.written_at ?? 'unknown')} | ${tableCell(provocation)} | ${tableCell(version.diff_note)} | ${wordingFix} |`,
    );
  }
  return parts.join('\n') + '\n';
}

function renderObjective(snapshot) {
  if (snapshot.goalCutoverComplete) return renderGoalObjective(snapshot);
  const objective = (snapshot.positions ?? []).find((p) => p.slug === 'objective');
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
  const positions = (snapshot.positions ?? []).filter(
    (position) => !(snapshot.goalCutoverComplete && position.slug === 'objective'),
  );
  const parts = [okfFrontmatter({ type: null, title: 'Judgment canon' })];
  parts.push('');
  parts.push('# Judgment canon (generated)');
  parts.push('');
  parts.push('All files in this bundle are projections of `records/` — regenerated, never hand-edited.');
  parts.push('');
  parts.push('- [Register](REGISTER.md)');
  parts.push('- [Ledger](LEDGER.md)');
  parts.push('- [Objective](OBJECTIVE.md)');
  if (positions.length) {
    parts.push('');
    parts.push('## Positions');
    parts.push('');
    for (const p of positions) {
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
    'docs/judgment/SITUATION.md': renderSituation(snapshot),
    'docs/judgment/index.md': renderIndex(snapshot),
  };
  for (const person of [...(snapshot.people ?? [])].sort((a, b) => a.slug.localeCompare(b.slug))) {
    files[`docs/judgment/people/${person.slug}.md`] = renderPerson(person);
  }
  for (const position of (snapshot.positions ?? [])) {
    if (snapshot.goalCutoverComplete && position.slug === 'objective') continue;
    files[`docs/judgment/positions/${position.slug}.md`] = renderPosition(position, snapshot);
  }
  return files;
}

const MANAGED_MARKDOWN_DIRS = [
  'docs/judgment/people',
  'docs/judgment/positions',
];

function managedStaleProjections(cwd, files) {
  const stale = [];
  for (const relDir of MANAGED_MARKDOWN_DIRS) {
    const dir = join(cwd, relDir);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (!(rel in files)) stale.push(rel);
    }
  }
  return stale;
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
  for (const rel of managedStaleProjections(cwd, files)) {
    unlinkSync(join(cwd, rel));
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
    if (!existsSync(path)) {
      diffs.push(`${rel} (missing)`);
      continue;
    }
    if (readFileSync(path, 'utf8') !== content) diffs.push(`${rel} (drift)`);
  }
  for (const rel of managedStaleProjections(cwd, files)) {
    diffs.push(`${rel} (orphan — not emitted by the generator)`);
  }
  return { fixedPoint: diffs.length === 0, diffs };
}
