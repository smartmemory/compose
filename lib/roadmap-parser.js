/**
 * roadmap-parser.js — Parse ROADMAP.md into structured feature entries.
 *
 * Extracts feature codes, descriptions, statuses, and phase membership
 * from the markdown table format used by Compose roadmaps.
 */

import { isFeatureCode } from './feature-code.js';
import { PRESERVED_OPEN_RE, PRESERVED_CLOSE_RE } from './roadmap-preservers.js';
import { parseStatusToken, splitPhaseHeading, PHASE_HEADING_TEXT_RE } from './roadmap-heading.js';

// Re-exported for backward compatibility — these now live in roadmap-heading.js,
// the shared source of truth for heading/status parsing (issue #38).
export { parseStatusToken, STATUS_TOKENS } from './roadmap-heading.js';

// Statuses that exclude a feature from the buildable list. KILLED is
// terminal; BLOCKED isn't buildable until unblocked.
const SKIP_STATUSES = new Set(['COMPLETE', 'SUPERSEDED', 'PARKED', 'KILLED', 'BLOCKED']);

const MILESTONE_HEADING_RE = /^###\s+(.+?)(?:\s*:\s*(.+))?$/;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const FENCE_RE = /^```/;

/**
 * Split a markdown table row into trimmed cells, honoring escaped pipes.
 * Splits on UNESCAPED `|` only (`/(?<!\\)\|/`), drops the leading/trailing empty
 * cells from the outer pipes, and unescapes `\|` → `|` in each cell. Symmetric
 * with `escCell()` in roadmap-gen.js. For pipe-free rows this is identical to a
 * naive `split('|')`.
 *
 * The canonical row splitter — every ROADMAP-row parse site (validator,
 * write-guard, this parser) must use it so a `\|` in a description cell can never
 * shift status-column detection (COMP-MCP-VALIDATE-4).
 *
 * @param {string} rawLine - A full table row line, e.g. "| a | b \\| c | PLANNED |"
 * @returns {string[]} trimmed, unescaped cells
 */
export function splitRoadmapCells(rawLine) {
  return rawLine.trim().split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * @typedef {{ code: string, description: string, status: string, phaseId: string, position: number }} FeatureEntry
 */

/**
 * Parse ROADMAP.md text into an ordered list of feature entries.
 * Anonymous rows (code === '—' or no code) are included for dependency chain
 * purposes but can be filtered out for build lists.
 *
 * @param {string} text - Raw ROADMAP.md content
 * @returns {FeatureEntry[]}
 */
export function parseRoadmap(text) {
  const lines = text.split('\n');
  const entries = [];
  let currentPhaseId = '';
  let currentParentPhaseId = '';
  let currentPhaseStatus = '';
  let position = 0;
  let inTable = false;
  let inFence = false;
  let inPreserved = false;
  let columnLayout = null; // { codeCol, descCol, statusCol }

  for (const line of lines) {
    // Fence + preserved-section detection run on the RAW line (never the
    // trimmed one) so the parser agrees with the preservers — which use raw
    // lines — on what counts as a marker. Markers/fences are column-0 by
    // convention; an indented `<!-- preserved-section -->` is NOT a marker.
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      inTable = false;
      columnLayout = null;
      continue;
    }
    if (inFence) continue;

    // Content inside a preserved-section is curated narrative emitted verbatim
    // by the writer (readPreservedSections). It must not be parsed as feature
    // rows — otherwise migrate mints phantom features from planning tables with
    // non-standard schemas, and the roundtrip never reaches a fixed point.
    if (PRESERVED_OPEN_RE.test(line)) {
      inPreserved = true;
      inTable = false;
      columnLayout = null;
      continue;
    }
    if (PRESERVED_CLOSE_RE.test(line)) {
      inPreserved = false;
      continue;
    }
    if (inPreserved) continue;

    const trimmed = line.trim();

    // Phase heading: ## Phase 0: Bootstrap — COMPLETE (title may contain em-dashes)
    const phaseMatch = trimmed.match(PHASE_HEADING_TEXT_RE);
    if (phaseMatch) {
      const { title, status } = splitPhaseHeading(phaseMatch[1]);
      currentPhaseId = title;
      currentParentPhaseId = title;
      currentPhaseStatus = status;
      inTable = false;
      columnLayout = null;
      continue;
    }

    // Milestone heading: ### Milestone 1: Stratum Engine Complete
    const milestoneMatch = trimmed.match(MILESTONE_HEADING_RE);
    if (milestoneMatch) {
      // Nest under the PARENT phase, resetting on each milestone. Without
      // resetting off the parent, consecutive ### headings would accumulate
      // ("Phase > M1 > M2") instead of yielding sibling milestones.
      const milestoneLabel = milestoneMatch[1].trim();
      currentPhaseId = currentParentPhaseId
        ? `${currentParentPhaseId} > ${milestoneLabel}`
        : milestoneLabel;
      inTable = false;
      columnLayout = null;
      continue;
    }

    // Table row
    if (!TABLE_ROW_RE.test(trimmed)) {
      if (inTable) {
        inTable = false;
        columnLayout = null;
      }
      continue;
    }

    // Escaped-pipe-aware cell split (the canonical splitter — see splitRoadmapCells).
    const cells = splitRoadmapCells(trimmed);

    // Skip separator rows (|---|---|---|)
    if (cells.every(c => /^[-:]+$/.test(c))) {
      continue;
    }

    // Detect header row
    if (!inTable) {
      inTable = true;
      columnLayout = detectColumnLayout(cells);
      continue;
    }

    if (!columnLayout) continue;

    // Parse data row
    const code = cells[columnLayout.codeCol] ?? '—';
    const desc = cells[columnLayout.descCol] ?? '';
    let status = cells[columnLayout.statusCol] ?? '';

    // Clean up status (strip bold markers, etc.) then reduce to a bare enum
    // token so a cell like "PARKED — needs Claude Code adoption" yields PARKED
    // (the inline rationale would otherwise produce a schema-invalid status).
    // Cells with no recognized token are left as-is (the validator flags them).
    status = status.replace(/\*\*/g, '').trim();
    const statusToken = parseStatusToken(status);
    if (statusToken) status = statusToken;

    // If the entire phase is a SKIP_STATUS, only fill in rows that have NO
    // explicit status. An explicit per-row status (e.g. a PLANNED item under a
    // rolled-up COMPLETE phase) must win over the phase-level override.
    const explicitStatus = status;
    if (SKIP_STATUSES.has(currentPhaseStatus) && !explicitStatus) {
      status = currentPhaseStatus;
    }

    const isAnonymous = code === '—' || code === '-' || !isFeatureCode(code);

    entries.push({
      code: isAnonymous ? `_anon_${position}` : code,
      description: desc.replace(/\*\*/g, '').trim(),
      status: status || 'PLANNED',
      phaseId: currentPhaseId,
      position: position++,
    });
  }

  return entries;
}

/**
 * Detect the column layout of a table header row.
 *
 * Supported layouts:
 *   4-col: # | Feature | Item | Status   → code=Feature, desc=Item
 *   4-col: ID | Item | Location | Status → code=ID, desc=Item
 *   3-col: ID | Feature | Status         → code=ID, desc=Feature
 *   3-col: ID | Item | Status            → code=ID, desc=Item
 *   3-col: # | Item | Status             → anonymous (# is a row number, not a code)
 */
function detectColumnLayout(headerCells) {
  const lower = headerCells.map(c => c.toLowerCase());

  // 4+ columns: look for a Feature column as the code source
  if (lower.length >= 4) {
    const featureIdx = lower.findIndex(c => c === 'feature');
    if (featureIdx !== -1) {
      return {
        codeCol: featureIdx,
        descCol: featureIdx + 1,
        statusCol: lower.length - 1,
      };
    }
    // No "feature" column — use first col as code, second as desc
    return {
      codeCol: 0,
      descCol: 1,
      statusCol: lower.length - 1,
    };
  }

  // 3 columns: check if first column is "id" (contains feature codes)
  if (lower.length === 3 && lower[0] === 'id') {
    return {
      codeCol: 0,
      descCol: 1,
      statusCol: 2,
    };
  }

  // 3-column fallback: # | Item | Status (row-number tables, anonymous)
  return {
    codeCol: -1, // will yield undefined → anonymous
    descCol: Math.min(1, lower.length - 2),
    statusCol: lower.length - 1,
  };
}

/**
 * Return only features that should be built:
 * - has a real feature code (not anonymous)
 * - status is PLANNED or IN_PROGRESS or PARTIAL
 *
 * @param {FeatureEntry[]} entries
 * @returns {FeatureEntry[]}
 */
export function filterBuildable(entries) {
  return entries.filter(e =>
    !e.code.startsWith('_anon_') && !SKIP_STATUSES.has(e.status)
  );
}
