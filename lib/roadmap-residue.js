/**
 * roadmap-residue.js — detect hand-authored content a ROADMAP.md regeneration
 * would drop (COMP-CONFLICT-MERGE).
 *
 * `compose roadmap generate` renders feature rows from feature.json and preserves
 * curated content through a whitelist of six readers. Content matching none of
 * them is dropped, and the row-level losslessness check (`checkRoundtrip`) is
 * blind to prose — so a curated block can vanish while the tool reports
 * "lossless: true".
 *
 * Residue = a line present in the base text, non-trivial, absent from the
 * generated output, and not explained by a legitimate regeneration (a feature
 * row rewritten, a table header re-emitted, a phase heading whose status flipped).
 *
 * Compare the base against the FINAL canonical bytes (after all generation
 * passes), never the first pass: the duplicate-heading loss only manifests on a
 * later pass, so a first-pass diff passes cleanly and then writes the lossy file.
 */

import { PRESERVED_OPEN_RE, PRESERVED_CLOSE_RE } from './roadmap-preservers.js';
import { splitPhaseHeading, PHASE_HEADING_TEXT_RE } from './roadmap-heading.js';
import { isFeatureCode } from './feature-code.js';
import { detectColumnLayout, splitRoadmapCells } from './roadmap-parser.js';
import { RoadmapProseLossError } from './roadmap-errors.js';

export { RoadmapProseLossError };

const FENCE_RE = /^```/;
const TABLE_ROW_RE = /^\|.+\|$/;
const HEADING_RE = /^#{1,6}\s/;
const DIVIDER_CELLS = (cells) => cells.length > 0 && cells.every((c) => /^[-:]+$/.test(c));

// buildKeyDocs (roadmap-gen.js) renders the `## Key Documents` table from feature
// designDocs: a `| Document | What it is |` header, a divider, then rows of the
// exact shape `| `<path>` | <CODE> design |`. Those lines are GENERATOR-OWNED — a
// designDoc change legitimately rewrites them — so they must never count as
// hand-authored loss, or `--protect` would freeze a stale generated link and
// default generate would refuse a legitimate regeneration.
//
// The row is generator-owned ONLY when its code is a REAL current feature code —
// identity, not shape. Shape alone is ambiguous: a curated row like
// `| `.../spec` | API-1 design |` looks identical to a generated one, so shape
// matching would silently drop it. Keying on the actual feature set means a
// curated row that references a non-feature "code" stays eligible (design path-2
// preserved), while a real feature's row — even after its designDoc changes — is
// correctly treated as the generator's. When the caller cannot supply the feature
// set (featureCodes = null), fall back to the shape check (looser, used only by
// pure-unit callers that control their inputs).
const KEY_DOCS_BLOCK = 'Key Documents';
const KEY_DOCS_HEADER_RE = /^\|\s*Document\s*\|\s*What it is\s*\|$/;
const TABLE_DIVIDER_RE = /^\|[\s|:-]+\|$/;
function isGeneratedKeyDocRow(text, featureCodes) {
  const cells = splitRoadmapCells(text);
  if (cells.length !== 2) return false;
  if (!/^`[^`]+`$/.test(cells[0])) return false;
  const m = cells[1].match(/^(\S+)\s+design$/);
  if (!m || !isFeatureCode(m[1])) return false;
  return featureCodes ? featureCodes.has(m[1]) : true;
}
const isGeneratedKeyDoc = (block, text, featureCodes) =>
  block === KEY_DOCS_BLOCK &&
  (KEY_DOCS_HEADER_RE.test(text) || TABLE_DIVIDER_RE.test(text) || isGeneratedKeyDocRow(text, featureCodes));

/**
 * Stable block id for a heading line. A `## ` phase heading keys on its TITLE
 * with the status suffix stripped, so a status flip (`— PLANNED` → `— COMPLETE`)
 * does not re-key the prose beneath it and manufacture false residue. Any other
 * heading keys on its trimmed text.
 */
function blockIdForHeading(trimmed) {
  const m = trimmed.match(PHASE_HEADING_TEXT_RE);
  if (m && trimmed.startsWith('## ')) return splitPhaseHeading(m[1]).title;
  return trimmed.replace(/^#{1,6}\s*/, '').trim();
}

/**
 * Classify every line of a ROADMAP.md text, tracking the nearest heading (its
 * stable block id) and table state. Only `kind: 'other'` lines — hand-authored
 * prose, curated non-feature table rows — are eligible to be residue; a heading
 * becomes eligible separately, when its phase no longer exists in the output.
 *
 * @returns {Array<{lineNo:number, text:string, block:string|null, kind:string}>}
 *   kind ∈ blank | fence | structural | heading | tableHeader | tableDivider | featureRow | other
 */
function classifyLines(text) {
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  let inPreserved = false;
  let block = null;
  let inTable = false;
  let columnLayout = null;
  let curatedTable = false; // a non-feature table the writer does NOT regenerate
  const endTable = () => { inTable = false; columnLayout = null; curatedTable = false; };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const push = (kind) => out.push({ lineNo: i + 1, text: trimmed, block, kind });

    if (FENCE_RE.test(raw)) { inFence = !inFence; endTable(); push('fence'); continue; }
    if (inFence) { push('other'); continue; } // fenced prose survives only if re-emitted; treat as eligible

    // Preserved-section content is emitted verbatim by the writer, so it always
    // survives — never residue. Marker lines and their content are structural.
    // (Duplicate/unbalanced ids, which DO lose content, are caught by the
    // strict preserved-section guard before this check runs.)
    if (PRESERVED_OPEN_RE.test(raw)) { inPreserved = true; endTable(); push('structural'); continue; }
    if (PRESERVED_CLOSE_RE.test(raw)) { inPreserved = false; push('structural'); continue; }
    if (inPreserved) { push('structural'); continue; }

    if (HEADING_RE.test(trimmed)) {
      block = blockIdForHeading(trimmed);
      endTable();
      const level = (trimmed.match(/^#+/)[0]).length;
      out.push({ lineNo: i + 1, text: trimmed, block, kind: 'heading', level });
      continue;
    }
    if (trimmed === '') { push('blank'); continue; }
    if (trimmed === '---') { push('structural'); continue; }

    if (TABLE_ROW_RE.test(trimmed)) {
      const cells = splitRoadmapCells(trimmed);
      if (!inTable && !DIVIDER_CELLS(cells)) {
        // Header row. A feature/id-coded table (codeCol !== -1) is regenerated
        // verbatim, so header + divider + rows are the generator's. A curated
        // non-feature table (codeCol === -1, e.g. `| Document | ... |`) is
        // hand-authored — its header and divider must travel with the block, so
        // they are eligible, otherwise --protect wraps rows into a headerless,
        // orphaned table and reports success.
        inTable = true;
        columnLayout = detectColumnLayout(cells);
        curatedTable = !columnLayout || columnLayout.codeCol === -1;
        push(curatedTable ? 'other' : 'tableHeader');
        continue;
      }
      if (DIVIDER_CELLS(cells)) { push(curatedTable ? 'other' : 'tableDivider'); continue; }
      // Data row: a resolvable feature code in a feature table is the generator's.
      if (!curatedTable && columnLayout && isFeatureCode(cells[columnLayout.codeCol] ?? '')) {
        push('featureRow'); continue;
      }
      push('other'); continue; // anonymous row / curated non-feature table row
    }

    endTable();
    push('other');
  }
  return out;
}

const keyOf = (block, text) => `${block ?? ''}\u0000${text}`;

/**
 * Lines present in `baseText` that `candidateText` fails to carry over.
 *
 * Occurrence-aware: membership ("does this line appear anywhere") cannot detect
 * losing ONE of two identical lines, which is exactly the duplicate-block case.
 * Keyed by (containing block, line text) and compared by count, so losing one
 * occurrence of a repeated heading or curated row is still residue.
 *
 * @param {string} baseText
 * @param {string} candidateText  the FINAL canonical bytes that will be written
 * @param {object} [opts]
 * @param {Set<string>} [opts.featureCodes]  current feature codes, so generator-owned
 *   Key Documents rows are recognised by identity rather than shape. Omit only from
 *   pure-unit callers that control their inputs.
 * @returns {Array<{lineNo:number, text:string, nearestHeading:string|null}>}
 */
export function computeResidue(baseText, candidateText, opts = {}) {
  const featureCodes = opts.featureCodes ?? null;
  const isGenKeyDoc = (block, text) => isGeneratedKeyDoc(block, text, featureCodes);
  const baseRecs = classifyLines(baseText);
  const candRecs = classifyLines(candidateText);

  // Headings are handled by LEVEL:
  //  - `#`/`##` (phase-level): membership by stable block id. The generator
  //    INTENTIONALLY collapses duplicate `##` phase headings (self-healing
  //    dedupe), so occurrence-counting them false-positives on normalization and
  //    would make --protect wrap a phase heading and destroy it. A phase heading
  //    is residue only when its whole section vanished; lost content beneath a
  //    collapsed duplicate is still caught as prose residue.
  //  - `###`+ (sub-headings): NOT deduped by the generator (preserved verbatim in
  //    their phase block), so losing one is real loss — occurrence-count by
  //    (block, text) to catch a bare sub-heading dropped when an identically
  //    named one survives elsewhere.
  const candidatePhaseBlocks = new Set();
  const candSubHeadingCount = new Map();
  const candCount = new Map(); // ELIGIBLE prose lines keyed by (block, text)
  for (const r of candRecs) {
    if (r.kind === 'blank') continue;
    if (r.kind === 'heading') {
      if (r.level <= 2) candidatePhaseBlocks.add(r.block);
      else candSubHeadingCount.set(keyOf(r.block, r.text), (candSubHeadingCount.get(keyOf(r.block, r.text)) ?? 0) + 1);
      continue;
    }
    // Count ONLY eligible prose, symmetric with baseContentCount below. Counting
    // generator-owned lines (feature rows, dividers, generated key-docs) here would
    // let a regenerated feature row "pay for" a lost base prose line of identical
    // text under the same block — a silent loss.
    if (r.kind !== 'other' || isGenKeyDoc(r.block, r.text)) continue;
    const k = keyOf(r.block, r.text);
    candCount.set(k, (candCount.get(k) ?? 0) + 1);
  }

  // Pre-count base occurrences so, for N identical lines with N-D survivors, we
  // can flag the FIRST D and keep the last N-D. The loss mechanism (Map collision
  // in readPhaseBlocks) keeps the LAST occurrence, so the lost ones are the
  // earliest — flagging those makes the reported line accurate and lets --protect
  // wrap the occurrence that actually disappears.
  const baseContentCount = new Map();
  const baseSubCount = new Map();
  for (const r of baseRecs) {
    if (r.kind === 'other' && !isGenKeyDoc(r.block, r.text)) {
      const k = keyOf(r.block, r.text);
      baseContentCount.set(k, (baseContentCount.get(k) ?? 0) + 1);
    } else if (r.kind === 'heading' && r.level >= 3) {
      const k = keyOf(r.block, r.text);
      baseSubCount.set(k, (baseSubCount.get(k) ?? 0) + 1);
    }
  }

  const flaggedContent = new Map();
  const flaggedSub = new Map();
  const residue = [];
  const lose = (r) => residue.push({ lineNo: r.lineNo, text: r.text, nearestHeading: r.block });
  const flagFirstD = (k, deficitBase, deficitCand, flagged) => {
    const deficit = (deficitBase.get(k) ?? 0) - (deficitCand.get(k) ?? 0);
    const seen = flagged.get(k) ?? 0;
    if (seen < deficit) { flagged.set(k, seen + 1); return true; }
    return false;
  };
  for (const r of baseRecs) {
    if (r.kind === 'heading') {
      if (r.level <= 2) {
        if (!candidatePhaseBlocks.has(r.block)) lose(r); // whole section vanished
      } else if (flagFirstD(keyOf(r.block, r.text), baseSubCount, candSubHeadingCount, flaggedSub)) {
        lose(r);
      }
      continue;
    }
    if (r.kind !== 'other') continue;
    if (isGenKeyDoc(r.block, r.text)) continue; // generator-owned, not hand-authored
    if (flagFirstD(keyOf(r.block, r.text), baseContentCount, candCount, flaggedContent)) lose(r);
  }
  return residue;
}

/** Section id from a heading: lowercase slug, letter-initial, `[a-z][a-z0-9-]*`. */
function sectionSlug(heading, used) {
  let base = String(heading ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base || !/^[a-z]/.test(base)) base = base ? `s-${base}` : 'preserved';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/**
 * Rewrite `baseText`, wrapping each contiguous run of residue lines in
 * `<!-- preserved-section: <id> -->` … `<!-- /preserved-section -->` markers with
 * ids derived from the run's nearest heading. Regenerating from the result
 * preserves the previously-dropped content. Turns the error into a one-command fix.
 *
 * @param {string} baseText
 * @param {Array<{lineNo:number, nearestHeading:string|null}>} residue
 * @returns {string}
 */
export function protectResidue(baseText, residue) {
  if (!residue || residue.length === 0) return baseText;
  const lines = baseText.split('\n');

  // Group residue into contiguous line runs.
  const sorted = [...residue].sort((a, b) => a.lineNo - b.lineNo);
  const runs = [];
  for (const r of sorted) {
    const last = runs[runs.length - 1];
    if (last && r.lineNo === last.end + 1) last.end = r.lineNo;
    else runs.push({ start: r.lineNo, end: r.lineNo, heading: r.nearestHeading });
  }

  // Insert markers bottom-up so earlier line indices stay valid; within a run,
  // splice the close (higher index) before the open (lower index). Seed the
  // used-id set with ids ALREADY in the file, so a generated id can never collide
  // with an existing preserved-section (which would then drop content on the next
  // generate via the id-keyed Map).
  const used = new Set();
  for (const line of lines) {
    const m = line.match(PRESERVED_OPEN_RE);
    if (m) used.add(m[1]);
  }
  const ids = runs.map((run) => sectionSlug(run.heading, used));
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    lines.splice(run.end, 0, '<!-- /preserved-section -->');
    lines.splice(run.start - 1, 0, `<!-- preserved-section: ${ids[i]} -->`);
  }
  return lines.join('\n');
}
