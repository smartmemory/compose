#!/usr/bin/env node
/**
 * bin/judgment-import.js — one-time markdown → records import (S07/W3).
 *
 * Parses the hand-written judgment canon (REGISTER.md, LEDGER.md,
 * OBJECTIVE.md, positions/*.md) into records and writes them THROUGH the
 * writer with `via: 'import'` — historical transcription, not new
 * authorship: original dates and `[ASSERT]` grounding are preserved
 * (ASSERT claims gain a citation-elicitation pointing at the imported
 * source), `minutes` costs map to `hours` with a note flag, and curated
 * banners/prose become `note` records with placement anchors.
 *
 * Ledger entries that predate the schema's kind-specific requirements and
 * cannot be mapped losslessly (e.g. the slot-assignment `rank` entry) fall
 * back to `note` records that keep the original heading in the title —
 * deterministic, honest, and reviewable in the cutover diff.
 *
 * Dry-run stages the import in a temp workspace and diffs the regenerated
 * projections against the current hand-written files; the real run is
 * refused if records already exist (import is one-time). Kept for provider
 * migrations (PROVIDER-SEAM: switching is a re-import, never a sync).
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import {
  judgmentPositionCreate,
  judgmentJointAdd,
  judgmentLedgerAppend,
} from '../lib/judgment-writer.js';
import { getJudgmentValidator } from '../lib/judgment/schema.js';

const METHODS = ['EXT', 'INT', 'CONSTRUCT', 'ASSERT', 'STRADDLE'];
const RULED_COSTS = ['hours', 'days', 'weeks', 'months'];
const DEFAULT_DATE = '2026-07-20';

/** Map a raw cost cell onto the ruled COARSE-BUCKETS. */
export function mapCost(raw) {
  const cost = String(raw ?? '').toLowerCase().trim();
  if (RULED_COSTS.includes(cost)) return { cost, note: null };
  if (cost === 'minutes') return { cost: 'hours', note: 'import: cost "minutes" mapped to "hours" (COARSE-BUCKETS)' };
  return { cost: 'hours', note: `import: cost "${raw}" is not a ruled bucket — defaulted to "hours"` };
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

function cells(line) {
  return line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

function plain(cell) {
  return cell.replace(/\*\*/g, '').replace(/`/g, '').replace(/~~/g, '').trim();
}

function ts(date) {
  return `${date}T12:00:00Z`;
}

function convictionFrom(text) {
  const t = (text ?? '').toLowerCase();
  const level = ['high', 'medium', 'low'].find((l) => t.includes(l)) ?? 'medium';
  const source = t.includes('inferred') ? 'inferred' : (t.includes('stated') || t.includes('owner') ? 'stated' : 'inferred');
  return { level, source };
}

function isTableRow(line) {
  return line.startsWith('|') && !/^\|[\s\-:|]+\|?\s*$/.test(line);
}

// ---------------------------------------------------------------------------
// REGISTER.md → joints + anchored notes
// ---------------------------------------------------------------------------

function parseRegister(text, objectiveQuestions) {
  const lines = text.split('\n');
  const joints = [];
  const notes = [];
  const struckRows = new Map(); // slug → question (for dissolved joints)

  let section = 'banner';
  const bannerLines = [];
  const footerBlocks = []; // { title, body[] }
  let currentFooter = null;

  const sectionOf = (heading) => {
    if (/^## Under test/.test(heading)) return { name: 'table', state: 'under_test', rank: 'high' };
    if (/^## Open — high/.test(heading)) return { name: 'table', state: 'open', rank: 'high' };
    if (/^## Open — medium/.test(heading)) return { name: 'table', state: 'open', rank: 'medium' };
    if (/^## Resolved/.test(heading)) return { name: 'resolved' };
    if (/^## Dissolved/.test(heading)) return { name: 'dissolved' };
    return { name: 'footer', title: heading.replace(/^##\s*/, '') };
  };

  let mode = { name: 'banner' };
  let dissolvedBody = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^# /.test(line)) continue;
    if (/^## /.test(line)) {
      mode = sectionOf(line);
      if (mode.name === 'footer') {
        currentFooter = { title: mode.title, body: [] };
        footerBlocks.push(currentFooter);
      }
      continue;
    }
    if (mode.name === 'banner') {
      bannerLines.push(line);
      continue;
    }
    if (mode.name === 'footer') {
      currentFooter.body.push(line);
      continue;
    }
    if (mode.name === 'dissolved') {
      dissolvedBody.push(line);
      continue;
    }
    if (mode.name === 'table' || mode.name === 'resolved') {
      if (!isTableRow(line)) {
        // inter-table prose (Moved here…, Re-weighted…, demotion notes)
        if (line.trim()) footerBlocks.push({ title: 'register prose', body: [line] });
        continue;
      }
      const row = cells(line);
      if (row.length < 4 || plain(row[0]).toLowerCase() === 'joint') continue;
      if (raw.includes('~~')) {
        struckRows.set(plain(row[0]), plain(row[1]));
        continue;
      }
      if (mode.name === 'resolved') {
        const [slugCell, dateCell, byCell, outcomeCell] = row;
        const slug = plain(slugCell);
        const date = plain(dateCell);
        const question = objectiveQuestions.get(slug) ?? '(question not recorded at import)';
        const refMatch = /\(`?(decide: [a-z0-9-]+)`?\)/.exec(outcomeCell);
        const { cost, note } = mapCost('minutes'); // the register records these as minutes-scale ASSERT rulings
        joints.push({
          date,
          record: {
            slug,
            question,
            branch_true: '(not recorded at import)',
            branch_false: '(not recorded at import)',
            resolve_by: METHODS.find((m) => byCell.includes(m)) ?? 'ASSERT',
            cost,
            rank: 'medium',
            state: 'resolved',
            flags: [note].filter(Boolean),
            resolution: {
              outcome: 'resolved',
              evidence: plain(outcomeCell),
              elicitation: {
                asked: question,
                answered_at: ts(date),
                answer_ref: refMatch ? refMatch[1] : 'docs/judgment/LEDGER.md',
              },
            },
          },
        });
        continue;
      }
      // open / under_test tables
      const [slugCell, qCell, tCell, fCell, byCell, costCell] = row;
      const slug = plain(slugCell);
      // Strip flag tokens BEFORE method detection — 'EXT-UNREACHABLE' must not
      // read as method EXT (already-knew resolves by INT).
      const byClean = plain(byCell ?? '').replace(/EXT-UNREACHABLE/g, '').replace(/blocked on sharpening/gi, '');
      const method = (/\b(EXT|INT|CONSTRUCT|ASSERT|STRADDLE)\b/.exec(byClean) ?? [])[1] ?? 'INT';
      const { cost, note } = mapCost(plain(costCell ?? ''));
      const flags = [];
      if (/EXT-UNREACHABLE/.test(byCell ?? '')) flags.push('EXT-UNREACHABLE');
      if (/blocked on sharpening/i.test(byCell ?? '')) flags.push('blocked-on-sharpening');
      const methodNote = byClean
        .replace(new RegExp(`\\b${method}\\b`), '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s—·-]+|[\s—·-]+$/g, '');
      if (methodNote) flags.push(`method-note: ${methodNote}`);
      if (note) flags.push(note);
      joints.push({
        date: DEFAULT_DATE,
        record: {
          slug,
          question: plain(qCell),
          branch_true: plain(tCell),
          branch_false: plain(fCell),
          resolve_by: method,
          cost,
          rank: mode.rank,
          state: mode.state,
          flags,
        },
      });
    }
  }

  // Dissolved joints from struck rows + the Dissolved section prose.
  const dissolvedText = dissolvedBody.join('\n');
  for (const [slug, question] of struckRows) {
    const halves = [...new Set([...dissolvedText.matchAll(/\bthe ([A-Z][a-z]+)\b/g)].map((m) => m[1].toLowerCase()))];
    joints.push({
      date: DEFAULT_DATE,
      record: {
        slug,
        question: question || '(question not recorded at import)',
        branch_true: '(not recorded at import)',
        branch_false: '(not recorded at import)',
        resolve_by: 'CONSTRUCT',
        cost: 'hours',
        rank: 'medium',
        state: 'dissolved',
        flags: ['import: resolve_by/cost not recorded on the dissolved row — defaulted'],
        dissolution: { decomposed_into: halves.length ? halves : ['recorded-in-dissolution-note'] },
      },
    });
  }

  notes.push({
    date: '2026-07-22',
    event: { kind: 'note', title: 'Register banner (imported)', body: bannerLines.filter(Boolean).join('\n'), anchor: 'register-header' },
  });
  if (dissolvedText.trim()) {
    footerBlocks.push({ title: 'Dissolved', body: dissolvedBody });
  }
  for (const block of footerBlocks) {
    const body = block.body.filter(Boolean).join('\n').trim();
    if (!body) continue;
    notes.push({
      date: '2026-07-22',
      event: { kind: 'note', title: `Register: ${block.title} (imported)`, body, anchor: 'register-footer' },
    });
  }
  return { joints, notes };
}

// ---------------------------------------------------------------------------
// OBJECTIVE.md → position 'objective' + question map
// ---------------------------------------------------------------------------

function parseObjective(text) {
  const questions = new Map();
  for (const line of text.split('\n')) {
    if (!isTableRow(line)) continue;
    const row = cells(line);
    if (row.length >= 3 && /`[a-z0-9-]+`/.test(row[0])) {
      questions.set(plain(row[0]), plain(row[1]));
    }
  }
  const primary = /\*\*Primary:\*\*\s*([\s\S]*?)\n\n/.exec(text)?.[1]?.replace(/\n/g, ' ').trim()
    ?? '(objective not parseable at import)';
  // The file's own header tags it `[ASSERT]` — preserved verbatim (binding:
  // import preserves grounding). The elicitation citation records honestly
  // that this was back-inferred, never elicited; the health warning survives
  // in the anchored prose note.
  const position = {
    date: DEFAULT_DATE,
    slug: 'objective',
    record: {
      slug: 'objective',
      claims: [{
        id: 'c1',
        text: primary,
        grounding: 'ASSERT',
        supports: [],
        elicitation: {
          asked: 'What are we optimizing for?',
          answered_at: ts(DEFAULT_DATE),
          answer_ref: 'import:docs/judgment/OBJECTIVE.md (back-inferred draft — NOT owner-confirmed, see health warning)',
        },
      }],
      conviction: { level: 'low', source: 'inferred' },
    },
  };
  const note = {
    date: DEFAULT_DATE,
    event: { kind: 'note', title: 'OBJECTIVE.md (imported prose)', body: text.trim(), anchor: 'position:objective' },
  };
  return { position, note, questions };
}

// ---------------------------------------------------------------------------
// positions/*.md → position records + prose notes
// ---------------------------------------------------------------------------

function parsePositionFile(slug, text, sourceRel) {
  const date = /\*\*Held since:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1]
    ?? /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? DEFAULT_DATE;
  const conviction = convictionFrom(/\*\*Conviction:\*\*([^\n]*)/.exec(text)?.[1] ?? '');

  const claims = [];
  const cite = (asked) => ({ asked, answered_at: ts(date), answer_ref: `import:${sourceRel}` });

  // Numbered argument table: | # | Step | Grounding |
  for (const line of text.split('\n')) {
    if (!isTableRow(line)) continue;
    const row = cells(line);
    if (row.length >= 3 && /^\d+$/.test(plain(row[0]))) {
      const id = `c${plain(row[0])}`;
      const step = plain(row[1]);
      const groundingCell = row[2];
      const derivedFrom = /derived from (\d+)/i.exec(groundingCell);
      let claim;
      if (derivedFrom) {
        claim = { id, text: step, grounding: 'DERIVED', supports: [`c${derivedFrom[1]}`] };
      } else {
        // Preserve the recorded grounding verbatim (binding); AGENT only when
        // the cell names none of the vocabulary.
        const grounding = (/\b(EXT|INT|ASSERT|DERIVED|AGENT)\b/.exec(groundingCell) ?? [])[1] ?? 'AGENT';
        claim = { id, text: step, grounding, supports: [] };
        if (grounding === 'ASSERT') claim.elicitation = cite(step);
      }
      if (/owner-locked/.test(groundingCell)) claim.owner_locked = true;
      claims.push(claim);
    }
  }
  // Evidence bullets: - `[EXT]` text
  if (claims.length === 0) {
    let n = 0;
    for (const line of text.split('\n')) {
      const m = /^-\s*`\[(EXT|INT|ASSERT|AGENT|DERIVED)\]`\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      n += 1;
      const claim = { id: `c${n}`, text: plain(m[2]), grounding: m[1], supports: [] };
      if (m[1] === 'ASSERT') claim.elicitation = cite(claim.text);
      if (/owner-locked/.test(line)) claim.owner_locked = true;
      claims.push(claim);
    }
  }
  if (claims.length === 0) {
    const claimSection = /## (?:The )?[Cc]laim\n+([\s\S]*?)(?:\n## |$)/.exec(text)?.[1]?.replace(/\n/g, ' ').trim();
    claims.push({ id: 'c1', text: claimSection ?? '(claim not parseable at import)', grounding: 'AGENT', supports: [] });
  }

  return {
    position: { date, slug, record: { slug, claims, conviction } },
    note: {
      date,
      event: { kind: 'note', title: `${basename(sourceRel)} (imported prose)`, body: text.trim(), anchor: `position:${slug}` },
    },
  };
}

// ---------------------------------------------------------------------------
// LEDGER.md → ledger events (schema-mapped, note fallback)
// ---------------------------------------------------------------------------

const LEDGER_KINDS = ['decide', 'kill', 'override', 'escalate', 'calibrate', 'postmortem', 'rank', 'note', 'correct', 'open'];

function parseLedger(text) {
  const lines = text.split('\n');
  const entries = [];
  let banner = [];
  let sawSection = false;
  let currentDate = DEFAULT_DATE;
  let current = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^###\s+([a-z]+):\s*(.+)$/.exec(line);
    if (/^## /.test(line)) {
      flush();
      sawSection = true;
      const date = /(\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
      if (date) currentDate = date;
      entries.push({ kind: 'note', title: `Ledger section: ${line.replace(/^##\s*/, '')} (imported)`, body: [], anchor: 'ledger', date: currentDate });
      continue;
    }
    if (heading && LEDGER_KINDS.includes(heading[1])) {
      flush();
      const rest = heading[2].trim();
      const date = /(\d{4}-\d{2}-\d{2})/.exec(rest)?.[1] ?? currentDate;
      current = { kind: heading[1], title: rest, body: [], anchor: null, date };
      continue;
    }
    if (line === '---') { flush(); continue; }
    if (!sawSection && !current) { banner.push(line); continue; }
    if (current) current.body.push(line);
    else if (line.trim()) entries.push({ kind: 'note', title: 'Ledger prose (imported)', body: [line], anchor: 'ledger', date: currentDate });
  }
  flush();

  const validator = getJudgmentValidator();
  const probeProvenance = { actor: 'agent', written_at: ts(DEFAULT_DATE), via: 'import' };

  const events = [];
  if (banner.filter(Boolean).length) {
    events.push({
      date: DEFAULT_DATE,
      event: { kind: 'note', title: 'Ledger banner (imported)', body: banner.filter(Boolean).join('\n'), anchor: 'ledger-header' },
    });
  }
  for (const entry of entries) {
    const body = (entry.body ?? []).filter(Boolean).join('\n').trim();
    const event = { kind: entry.kind, title: entry.title, body };
    if (entry.anchor) event.anchor = entry.anchor;
    if (entry.kind === 'decide' || entry.kind === 'kill') {
      const rejectedLine = /\*\*Rejected[^:]*:\*\*\s*([\s\S]*?)(?:\n\*\*|$)/.exec(body)?.[1];
      if (entry.kind === 'decide') {
        event.rejected = rejectedLine
          ? [{ what: rejectedLine.replace(/\n/g, ' ').trim(), why: 'recorded in the imported entry body' }]
          : [];
        event.conviction = convictionFrom(/\*\*Conviction:\*\*([^\n]*)/.exec(body)?.[1] ?? '');
      }
    }
    if (entry.kind === 'override') {
      event.reason = body.split('\n')[0] || entry.title;
    }
    if (!body) delete event.body;

    const { valid } = validator.validate('ledger_event', { ...event, provenance: probeProvenance });
    if (valid) {
      events.push({ date: entry.date, event });
    } else {
      // pre-schema entry shape → honest note fallback, original heading kept
      events.push({
        date: entry.date,
        event: { kind: 'note', title: `${entry.kind}: ${entry.title} (imported as note)`, body: body || entry.title, anchor: 'ledger' },
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

function readSources(cwd) {
  const dir = join(cwd, 'docs', 'judgment');
  const positionsDir = join(dir, 'positions');
  const positionFiles = existsSync(positionsDir)
    ? readdirSync(positionsDir).filter((f) => f.endsWith('.md')).sort()
    : [];
  return {
    register: readFileSync(join(dir, 'REGISTER.md'), 'utf8'),
    ledger: readFileSync(join(dir, 'LEDGER.md'), 'utf8'),
    objective: readFileSync(join(dir, 'OBJECTIVE.md'), 'utf8'),
    positions: positionFiles.map((f) => ({
      slug: f.replace(/\.md$/, ''),
      rel: `docs/judgment/positions/${f}`,
      text: readFileSync(join(positionsDir, f), 'utf8'),
    })),
  };
}

function buildPlan(sources) {
  const objective = parseObjective(sources.objective);
  const register = parseRegister(sources.register, objective.questions);
  const ledger = parseLedger(sources.ledger);

  const positions = [objective.position];
  const notes = [objective.note];
  for (const file of sources.positions) {
    const parsed = parsePositionFile(file.slug, file.text, file.rel);
    positions.push(parsed.position);
    notes.push(parsed.note);
  }
  // Event order: ledger banner + entries (chronology), then register notes,
  // then position prose notes.
  const events = [...ledger, ...register.notes, ...notes];
  return { positions, joints: register.joints, events };
}

async function executePlan(cwd, plan) {
  for (const p of plan.positions) {
    await judgmentPositionCreate(cwd, p.record, { via: 'import', writtenAt: ts(p.date) });
  }
  for (const j of plan.joints) {
    await judgmentJointAdd(cwd, j.record, { via: 'import', writtenAt: ts(j.date) });
  }
  for (const e of plan.events) {
    await judgmentLedgerAppend(cwd, e.event, { via: 'import', writtenAt: ts(e.date) });
  }
}

function diffProjections(stagingCwd, cwd) {
  const stagingDir = join(stagingCwd, 'docs', 'judgment');
  const files = ['REGISTER.md', 'LEDGER.md', 'OBJECTIVE.md', 'index.md',
    ...readdirSync(join(stagingDir, 'positions')).filter((f) => f.endsWith('.md')).map((f) => `positions/${f}`)];
  return files.map((rel) => {
    const generated = readFileSync(join(stagingDir, rel), 'utf8');
    const currentPath = join(cwd, 'docs', 'judgment', rel);
    const current = existsSync(currentPath) ? readFileSync(currentPath, 'utf8') : null;
    return { file: `docs/judgment/${rel}`, changed: current !== generated, new: current === null };
  });
}

/**
 * Run the import. Dry-run: stage in a temp workspace, report counts + the
 * projection diff, write nothing into cwd. Real run: refuse if records
 * exist, then write records through the writer (projections cut over as a
 * side-effect of each write).
 *
 * @param {string} cwd
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function runJudgmentImport(cwd, { dryRun = false } = {}) {
  // Preflight the configured canon provider: if judgment.provider selects an
  // unimplemented/unknown backend this throws HERE, before any staging or
  // copying — floor records must never land under a config that rejects them.
  const { createJudgmentStore } = await import('../lib/judgment/store/index.js');
  createJudgmentStore(cwd);
  if (existsSync(join(cwd, 'docs', 'judgment', 'records'))) {
    throw new Error(
      'judgment records already exist under docs/judgment/records/ — import is one-time (remove records/ to re-run; '
      + 'if a cutover was interrupted after records landed, regenerate projections via lib/judgment-gen.js#regenerateProjections)',
    );
  }
  const sources = readSources(cwd);
  const plan = buildPlan(sources);

  // Stage the FULL import in a temp workspace: every record goes through the
  // writer there, and the staged projections are what the human gate diffs
  // against the current hand-written files (staging path is returned so the
  // diff is actually inspectable).
  const staging = mkdtempSync(join(tmpdir(), 'judgment-import-staging-'));
  await executePlan(staging, plan);
  const diff = diffProjections(staging, cwd);

  if (!dryRun) {
    // Crash-safe cutover: the writer-produced records land in cwd via copy →
    // single rename (no partial records/ tree on interruption), then the
    // projections regenerate from them. A crash after the rename self-heals:
    // every subsequent writer op regenerates all projections.
    const { cpSync, renameSync: rename } = await import('node:fs');
    const { regenerateProjections } = await import('../lib/judgment-gen.js');
    const dst = join(cwd, 'docs', 'judgment', 'records');
    const tmpDst = `${dst}.importing.${process.pid}`;
    cpSync(join(staging, 'docs', 'judgment', 'records'), tmpDst, { recursive: true });
    rename(tmpDst, dst);
    regenerateProjections(cwd);
  }

  return {
    dryRun,
    staging,
    counts: {
      positions: plan.positions.length,
      joints: plan.joints.length,
      ledger_events: plan.events.length,
    },
    diff,
  };
}

// CLI: node bin/judgment-import.js [--dry-run] [cwd]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const cwd = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.cwd();
  runJudgmentImport(cwd, { dryRun }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
