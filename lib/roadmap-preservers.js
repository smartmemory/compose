/**
 * Preservation helpers for typed-writer regen of ROADMAP.md.
 *
 * COMP-MCP-MIGRATION-2-1-1 (Option A — hand-rolled augmentation).
 *
 * Three pure functions with no I/O. Each scans an existing ROADMAP.md
 * source string and returns a Map of curated content for the writer to
 * splice back during regen, so typed-writer flips don't destroy:
 *
 *   - phase-status overrides like `PARKED (Claude Code dependency)`
 *   - anonymous historical rows with `—` in the Feature column
 *   - non-feature sections wrapped in `<!-- preserved-section: <id> -->`
 */

const PHASE_HEADING_RE = /^##\s+(.+?)\s+—\s+(.+?)\s*$/;
const FENCE_RE = /^```/;
const TABLE_HEADER_RE = /^\|.*\|$/;
const TABLE_DIVIDER_RE = /^\|[\s|:-]+\|$/;
const TABLE_ROW_RE = /^\|.+\|$/;
const FEATURE_CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;

const PRESERVED_OPEN_RE = /^<!--\s*preserved-section:\s*([a-z][a-z0-9-]*)\s*-->\s*$/;
const PRESERVED_CLOSE_RE = /^<!--\s*\/preserved-section\s*-->\s*$/;

/**
 * Scan ROADMAP.md text and return a Map of phaseId → override text.
 *
 * Override is the substring after `— ` in any `## ...` heading line.
 * Headings without an em-dash override are not included.
 * Headings inside fenced code blocks are ignored.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function readPhaseOverrides(text) {
  const out = new Map();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(PHASE_HEADING_RE);
    if (m) out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

/**
 * Scan ROADMAP.md text and return a Map of phaseId → AnonRow[].
 *
 * AnonRow shape: { rawLine, predecessorCode }
 * - rawLine: the full table-row line as it appears in source.
 * - predecessorCode: feature code of the prior typed row in the same phase
 *   table, or null if this anon row was at the table head (no typed predecessor).
 *
 * A row is "anonymous" if its Feature column (detected by header) is `—` or
 * doesn't match FEATURE_CODE_RE. The current parser regex (looser, requires
 * trailing -<digits>) is NOT used here; we use the strict regex for accurate
 * classification (anon means truly no feature code, not the parser's regex bug).
 * For the 3-col anonymous form (`# | Item | Status`), all rows are anon.
 *
 * @param {string} text
 * @returns {Map<string, Array<{rawLine: string, predecessorCode: string|null}>>}
 */
export function readAnonymousRows(text) {
  const out = new Map();
  let inFence = false;
  let currentPhaseId = null;
  let inTable = false;
  let codeColIdx = -1; // -1 means anonymous-form (3-col) table
  let lastTypedCode = null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Phase heading resets table state.
    const phaseMatch = line.match(/^##\s+(.+?)(?:\s+—\s+.+)?\s*$/);
    if (phaseMatch && line.startsWith('## ')) {
      currentPhaseId = phaseMatch[1].trim();
      inTable = false;
      codeColIdx = -1;
      lastTypedCode = null;
      continue;
    }

    if (!currentPhaseId) continue;
    if (!TABLE_ROW_RE.test(line.trim())) {
      inTable = false;
      codeColIdx = -1;
      lastTypedCode = null;
      continue;
    }

    const cells = line.split('|').slice(1, -1).map(c => c.trim());

    // Header row — detect column layout.
    if (!inTable) {
      const lower = cells.map(c => c.toLowerCase());
      const featureIdx = lower.findIndex(c => c === 'feature');
      if (featureIdx !== -1) {
        codeColIdx = featureIdx;
      } else if (lower[0] === 'id') {
        codeColIdx = 0;
      } else {
        codeColIdx = -1; // anonymous form
      }
      inTable = true;
      lastTypedCode = null;
      continue;
    }

    // Skip divider rows.
    if (TABLE_DIVIDER_RE.test(line.trim())) continue;

    // Data row.
    let isAnon = false;
    if (codeColIdx === -1) {
      isAnon = true;
    } else {
      const codeCell = cells[codeColIdx] ?? '';
      if (codeCell === '—' || codeCell === '' || !FEATURE_CODE_RE.test(codeCell)) {
        isAnon = true;
      }
    }

    if (isAnon) {
      const arr = out.get(currentPhaseId) ?? [];
      arr.push({ rawLine: line, predecessorCode: lastTypedCode });
      out.set(currentPhaseId, arr);
    } else {
      lastTypedCode = cells[codeColIdx];
    }
  }
  return out;
}

/**
 * Scan ROADMAP.md text and return a Map of preserved-section id → rawSource.
 *
 * rawSource includes both open and close markers and everything between.
 * Markers inside fenced code blocks are ignored. Unbalanced markers (open
 * without matching close) are excluded.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function readPreservedSections(text) {
  const out = new Map();
  let inFence = false;
  let openId = null;
  let openLineIdx = -1;
  const lines = text.split('\n');

  // Track byte offsets to slice rawSource.
  // Compute cumulative offsets per line (start-of-line offsets).
  const lineOffsets = new Array(lines.length + 1);
  lineOffsets[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i + 1] = lineOffsets[i] + lines[i].length + 1; // +1 for newline
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const openMatch = line.match(PRESERVED_OPEN_RE);
    if (openMatch) {
      openId = openMatch[1];
      openLineIdx = i;
      continue;
    }
    if (openId !== null && PRESERVED_CLOSE_RE.test(line)) {
      const startOffset = lineOffsets[openLineIdx];
      const endOffset = lineOffsets[i + 1] - 1; // exclude trailing newline of close marker line
      out.set(openId, text.slice(startOffset, endOffset));
      openId = null;
      openLineIdx = -1;
    }
  }
  // Unbalanced open is silently dropped (could log, but tests expect empty/missing).
  return out;
}

/**
 * For each `## ` phase heading in source, capture the entire phase block —
 * heading line + everything up to (but not including) the next `## ` heading,
 * `<!-- preserved-section: ... -->` open marker, or EOF. Trailing `---`
 * separator and surrounding blank lines before the next boundary are excluded.
 *
 * Used by the writer as a fallback for phases that have no feature.json
 * features — emit the raw block verbatim so curated prose, exit text, and
 * legacy table formatting all survive regen.
 *
 * Headings inside fenced code blocks are ignored.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function readPhaseBlocks(text) {
  const out = new Map();
  let inFence = false;
  let inPreserved = false;
  let currentPhaseId = null;
  let currentStartLineIdx = -1;
  const lines = text.split('\n');

  const finalize = (endLineIdx) => {
    if (currentPhaseId === null || currentStartLineIdx < 0) return;
    // Walk back over trailing blank lines and a single `---` separator.
    let endIdx = endLineIdx;
    while (endIdx > currentStartLineIdx && lines[endIdx - 1].trim() === '') endIdx--;
    if (endIdx > currentStartLineIdx && lines[endIdx - 1].trim() === '---') endIdx--;
    while (endIdx > currentStartLineIdx && lines[endIdx - 1].trim() === '') endIdx--;
    const block = lines.slice(currentStartLineIdx, endIdx).join('\n');
    out.set(currentPhaseId, block);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (PRESERVED_OPEN_RE.test(line)) {
      finalize(i);
      currentPhaseId = null;
      currentStartLineIdx = -1;
      inPreserved = true;
      continue;
    }
    if (PRESERVED_CLOSE_RE.test(line)) {
      inPreserved = false;
      continue;
    }
    if (inPreserved) continue;

    const phaseMatch = line.match(/^##\s+(.+?)(?:\s+—\s+.+)?\s*$/);
    if (phaseMatch && line.startsWith('## ')) {
      finalize(i);
      currentPhaseId = phaseMatch[1].trim();
      currentStartLineIdx = i;
    }
  }
  finalize(lines.length);

  return out;
}

/**
 * Return the array of phaseIds in their order of appearance in source.
 *
 * Used by the writer to preserve original phase order when emitting phases
 * that exist only in the source (no feature.json features). Headings inside
 * fenced code blocks or inside open preserved-section markers are ignored.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function readPhaseOrder(text) {
  const out = [];
  let inFence = false;
  let inPreserved = false;
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (PRESERVED_OPEN_RE.test(line)) {
      inPreserved = true;
      continue;
    }
    if (PRESERVED_CLOSE_RE.test(line)) {
      inPreserved = false;
      continue;
    }
    if (inPreserved) continue;

    const phaseMatch = line.match(/^##\s+(.+?)(?:\s+—\s+.+)?\s*$/);
    if (phaseMatch && line.startsWith('## ')) {
      out.push(phaseMatch[1].trim());
    }
  }
  return out;
}

/**
 * For each preserved section, find the phaseId of the most recent `## ` heading
 * before its open marker. Returns Map<id, phaseId|null>.
 *
 * Used by the writer to splice preserved sections back into the regenerated
 * output at the correct sequential position relative to phases.
 *
 * - `null` anchor means the preserved section appeared at the top of the
 *   file before any phase heading (e.g. Roadmap Conventions).
 * - Markers inside fenced code blocks are ignored (false-positive guard).
 * - Open markers without a matching close are excluded.
 *
 * @param {string} text
 * @returns {Map<string, string|null>}
 */
export function readPreservedSectionAnchors(text) {
  const out = new Map();
  let inFence = false;
  let currentPhaseId = null;
  let openId = null;
  let openAnchor = null;

  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Phase headings inside an open preserved-section do NOT advance the anchor.
    if (openId === null) {
      const phaseMatch = line.match(/^##\s+(.+?)(?:\s+—\s+.+)?\s*$/);
      if (phaseMatch && line.startsWith('## ') && !PRESERVED_OPEN_RE.test(line) && !PRESERVED_CLOSE_RE.test(line)) {
        currentPhaseId = phaseMatch[1].trim();
        continue;
      }
    }

    const openMatch = line.match(PRESERVED_OPEN_RE);
    if (openMatch) {
      openId = openMatch[1];
      openAnchor = currentPhaseId;
      continue;
    }
    if (openId !== null && PRESERVED_CLOSE_RE.test(line)) {
      out.set(openId, openAnchor);
      openId = null;
      openAnchor = null;
    }
  }
  return out;
}
