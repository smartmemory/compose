/**
 * migrate-anon — COMP-MCP-MIGRATION-2-1-1-1
 *
 * `compose migrate-anon`: interactive promotion of historical *anonymous*
 * ROADMAP rows (the `| — | Item | Status |` form preserved verbatim by
 * COMP-MCP-MIGRATION-2-1-1) to typed features.
 *
 * Load-bearing correctness point: anonymous rows are re-emitted on regen by
 * `predecessorCode` anchoring, and a row only stops being anonymous when its raw
 * Feature cell becomes a valid code. So scaffolding a feature.json ALONE leaves
 * the `—` row passing through verbatim → a DUPLICATE. Promotion therefore strips
 * the source `rawLine` from ROADMAP.md *before* scaffold+regen.
 *
 * `readAnonymousRows` is the canonical classifier for which rows are anonymous +
 * their order + anchor; this module only adds header-aware cell display and the
 * strip-then-scaffold primitive on top of it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { resolveRoadmapPath, loadFeaturesDir } from './project-paths.js';
import { readAnonymousRows, PRESERVED_OPEN_RE, PRESERVED_CLOSE_RE } from './roadmap-preservers.js';
import { splitRoadmapCells, detectColumnLayout } from './roadmap-parser.js';
import { splitPhaseHeading, PHASE_HEADING_TEXT_RE, parseStatusToken, STATUS_TOKENS } from './roadmap-heading.js';
import { isFeatureCode } from './feature-code.js';
import { listFeatures, positionSortKey } from './feature-json.js';
import { addRoadmapEntry } from './feature-writer.js';

const FENCE_RE = /^```/;
const TABLE_ROW_RE = /^\|.+\|$/;
const TABLE_DIVIDER_RE = /^\|[\s|:-]+\|$/;

// Strip markdown bold/code markers so a `**IN_PROGRESS**` or `` `x` `` cell
// matches the same way the roadmap parser sees it (it bold-strips before parsing).
// NB: do NOT strip `_` — it's part of the `IN_PROGRESS` status token itself.
const stripEmphasis = (s) => String(s ?? '').replace(/[*`]/g, '').trim();

/**
 * Parse anonymous rows for display, header-aware. Classification + raw text +
 * anchor come from the canonical `readAnonymousRows`; the column layout only
 * decides which cell is title vs status, and is taken from the **nearest
 * preceding header** of each row's own table — a phase can hold multiple tables
 * with different layouts (3-col then 4-col), so a single per-phase header is
 * wrong. The forward scan mirrors `readAnonymousRows`' table-state reset (a
 * non-table line or a new heading ends the current table) and matches anon rows
 * by in-order `rawLine` equality, so classification never drifts and the layout
 * is display-only (a misread can never affect strip/anchor).
 *
 * @param {string} text - ROADMAP.md source
 * @returns {Array<{phaseId:string, occurrenceIndex:number, num:string, title:string, status:string, rawLine:string, predecessorCode:string|null}>}
 */
export function collectAnonRowsFromText(text) {
  const anonMap = readAnonymousRows(text);
  const ptr = new Map(); // phaseId → next occurrence index to match
  const out = [];
  let inFence = false;
  let inPreserved = false;
  let cur = null;
  let header = null;
  let inTable = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (PRESERVED_OPEN_RE.test(trimmed)) { inPreserved = true; inTable = false; header = null; continue; }
    if (PRESERVED_CLOSE_RE.test(trimmed)) { inPreserved = false; continue; }
    if (inPreserved) continue;

    const h = line.match(PHASE_HEADING_TEXT_RE);
    if (h && line.startsWith('## ')) { cur = splitPhaseHeading(h[1]).title; inTable = false; header = null; continue; }
    if (!cur) continue;

    if (!TABLE_ROW_RE.test(trimmed)) { inTable = false; header = null; continue; }
    if (!inTable) { header = splitRoadmapCells(line); inTable = true; continue; } // header row
    if (TABLE_DIVIDER_RE.test(trimmed)) continue;

    // Data row — match against the canonical anon list in document order.
    const rows = anonMap.get(cur) ?? [];
    const p = ptr.get(cur) ?? 0;
    if (p < rows.length && line === rows[p].rawLine) {
      const layout = detectColumnLayout(header ?? ['#', 'Item', 'Status']);
      const cells = splitRoadmapCells(line);
      const num = layout.codeCol >= 0 ? (cells[layout.codeCol] ?? '') : (cells[0] ?? '');
      const title = stripEmphasis(cells[layout.descCol] ?? '');
      const status = parseStatusToken(stripEmphasis(cells[layout.statusCol] ?? '')) ?? 'PLANNED';
      out.push({ phaseId: cur, occurrenceIndex: p, num, title, status, rawLine: line, predecessorCode: rows[p].predecessorCode });
      ptr.set(cur, p + 1);
    }
  }
  return out;
}

/**
 * Locate the physical line index of the `occurrenceIndex`-th anonymous row in a
 * phase. Forward-scans, consuming `readAnonymousRows`' ordered rawLines so that
 * identical row text resolves to the correct physical occurrence (no global
 * string match). Returns -1 if not found.
 */
function anonLineIndex(text, phaseId, occurrenceIndex) {
  const rows = readAnonymousRows(text).get(phaseId) ?? [];
  if (occurrenceIndex < 0 || occurrenceIndex >= rows.length) return -1;
  const lines = text.split('\n');
  let inFence = false;
  let inPreserved = false;
  let cur = null;
  let ptr = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (PRESERVED_OPEN_RE.test(trimmed)) { inPreserved = true; continue; }
    if (PRESERVED_CLOSE_RE.test(trimmed)) { inPreserved = false; continue; }
    if (inPreserved) continue;
    const h = line.match(PHASE_HEADING_TEXT_RE);
    if (h && line.startsWith('## ')) { cur = splitPhaseHeading(h[1]).title; continue; }
    if (cur === phaseId && ptr < rows.length && line === rows[ptr].rawLine) {
      if (ptr === occurrenceIndex) return i;
      ptr++;
    }
  }
  return -1;
}

/**
 * Remove the `occurrenceIndex`-th anonymous row of `phaseId` from ROADMAP text.
 * Phase-scoped and occurrence-specific. Returns the new text (throws if not found).
 */
export function stripAnonLine(text, phaseId, occurrenceIndex) {
  const idx = anonLineIndex(text, phaseId, occurrenceIndex);
  if (idx === -1) {
    throw new Error(`migrate-anon: anon row #${occurrenceIndex} not found in phase "${phaseId}"`);
  }
  const lines = text.split('\n');
  lines.splice(idx, 1);
  return lines.join('\n');
}

// Best-effort end-of-phase position. Computed with positionSortKey (string-aware),
// NOT nextPositionInPhase which coerces string/ranged positions to 0.
async function endOfPhasePosition(cwd, phaseId) {
  // Config-aware features dir (mirrors addRoadmapEntry) — listFeatures defaults to
  // docs/features and would otherwise miss relocated feature sets.
  const peers = (await listFeatures(cwd, loadFeaturesDir(cwd))).filter((f) => f.phase === phaseId);
  if (peers.length === 0) return 1;
  const max = peers.reduce((m, f) => Math.max(m, positionSortKey(f.position)), 0);
  return max + 1;
}

/**
 * Promote one anonymous row to a typed feature: strip its rawLine, then scaffold.
 *
 * Failure handling keys on the error code, because addRoadmapEntry commits
 * feature.json BEFORE regenerating ROADMAP.md:
 *   - pre-commit failures (validation / code-exists / ROUNDTRIP_NOT_FIXED_POINT)
 *     → restore the stripped snapshot (nothing committed) and rethrow.
 *   - ROADMAP_PARTIAL_WRITE (feature.json committed, regen failed) → do NOT
 *     restore (that would re-add the anon row alongside the typed feature = the
 *     duplicate this flow avoids); rethrow as-is. Re-running reconciles.
 *
 * @param {string} cwd
 * @param {{phaseId:string, occurrenceIndex:number, title:string}} row
 * @param {{code:string, status?:string, scaffold?:Function}} opts
 */
export async function promoteAnonRow(cwd, row, { code, status = 'PLANNED', scaffold = addRoadmapEntry } = {}) {
  const upper = String(code).toUpperCase();
  if (!isFeatureCode(upper)) {
    throw new Error(`migrate-anon: "${code}" is not a valid feature code`);
  }
  const roadmapPath = resolveRoadmapPath(cwd);
  const snapshot = readFileSync(roadmapPath, 'utf-8');
  const stripped = stripAnonLine(snapshot, row.phaseId, row.occurrenceIndex);
  writeFileSync(roadmapPath, stripped);
  try {
    const position = await endOfPhasePosition(cwd, row.phaseId);
    return await scaffold(cwd, {
      code: upper,
      description: row.title,
      phase: row.phaseId,
      status,
      complexity: 'S',
      position,
    });
  } catch (err) {
    if (err && err.code === 'ROADMAP_PARTIAL_WRITE') throw err;
    // Pre-commit failure: nothing was committed — put the anon row back.
    writeFileSync(roadmapPath, snapshot);
    throw err;
  }
}

/**
 * Interactive driver. Streams are injectable for testing. Callers (the CLI) own
 * the non-TTY guard: pass `nonInteractive: true` for piped stdin / --non-interactive
 * / --dry-run, and this lists the rows without prompting.
 *
 * @param {string} cwd
 * @param {{input?:any, output?:any, nonInteractive?:boolean, dryRun?:boolean, scaffold?:Function}} [opts]
 * @returns {Promise<{listed:number, promoted:string[], aborted:boolean}>}
 */
export async function runMigrateAnon(cwd, opts = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    nonInteractive = false,
    dryRun = false,
    scaffold = addRoadmapEntry,
  } = opts;
  const write = (s) => output.write(s + '\n');
  const roadmapPath = resolveRoadmapPath(cwd);
  const rows = collectAnonRowsFromText(readFileSync(roadmapPath, 'utf-8'));

  if (rows.length === 0) {
    write('migrate-anon: no anonymous rows found.');
    return { listed: 0, promoted: [], aborted: false };
  }

  if (nonInteractive || dryRun) {
    write(`migrate-anon: ${rows.length} anonymous row(s):`);
    for (const r of rows) write(`  [${r.phaseId}] ${r.title}  (${r.status})`);
    write('Run interactively in a TTY to promote rows.');
    return { listed: rows.length, promoted: [], aborted: false };
  }

  const rl = createInterface({ input, output });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const promoted = [];
  const promotedByPhase = {};
  let aborted = false;

  try {
    for (const row of rows) {
      write(`\n[${row.phaseId}] ${row.title}`);
      write(`  inferred status: ${row.status}`);

      // Code prompt (re-prompt on invalid; Enter=skip; q=abort).
      let code = null;
      for (;;) {
        const ans = (await ask('  Code to assign (Enter=skip, q=abort): ')).trim();
        if (ans === '') break;
        if (ans.toLowerCase() === 'q') { aborted = true; break; }
        const c = ans.toUpperCase();
        if (!isFeatureCode(c)) { write(`  ✗ "${ans}" is not a valid feature code — try again`); continue; }
        code = c;
        break;
      }
      if (aborted) break;
      if (!code) continue;

      // Status confirm/override.
      const sAns = (await ask(`  Status [${row.status}] (Enter=keep, or one of ${STATUS_TOKENS.join('/')}): `)).trim();
      let status = row.status;
      if (sAns !== '') {
        const s = sAns.toUpperCase();
        if (STATUS_TOKENS.includes(s)) status = s;
        else write(`  (unrecognized status "${sAns}" — keeping ${row.status})`);
      }

      const liveIndex = row.occurrenceIndex - (promotedByPhase[row.phaseId] ?? 0);
      try {
        await promoteAnonRow(cwd, { ...row, occurrenceIndex: liveIndex }, { code, status, scaffold });
        promoted.push(code);
        promotedByPhase[row.phaseId] = (promotedByPhase[row.phaseId] ?? 0) + 1;
        write(`  ✓ promoted to ${code}`);
      } catch (err) {
        write(`  ✗ promotion failed: ${err.message}`);
        throw err;
      }
    }
  } finally {
    rl.close();
  }

  write(`\nmigrate-anon: ${promoted.length} promoted${aborted ? ' (aborted early)' : ''}.`);
  return { listed: rows.length, promoted, aborted };
}
