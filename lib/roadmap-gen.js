/**
 * roadmap-gen.js — Generate ROADMAP.md from feature.json files.
 *
 * feature.json is the source of truth. ROADMAP.md is a rendered view.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { listFeatures, positionSortKey } from './feature-json.js';
import { parseStatusToken } from './roadmap-parser.js';
import { loadFeaturesDir, resolveRoadmapPath } from './project-paths.js';
import {
  readPhaseOverrides,
  readAnonymousRows,
  readPreservedSections,
  readPreservedSectionAnchors,
  readPhaseOrder,
  readPhaseBlocks,
} from './roadmap-preservers.js';
import { emitDrift } from './roadmap-drift.js';
import { isNarrativeOwned, narrativeOwnedMessage } from './roadmap-config.js';

// Escape literal pipes in free-text table cells so they don't break markdown
// column splitting. Symmetric with the unescape in roadmap-parser.js /
// roadmap-preservers.js (split on unescaped `|`, then restore `\|` → `|`).
// Only applied to description/item cells — #/code/status never contain pipes.
const escCell = (s) => String(s ?? '').replace(/\|/g, '\\|');

const STATUS_ORDER = ['IN_PROGRESS', 'PARTIAL', 'PLANNED', 'COMPLETE', 'SUPERSEDED', 'PARKED'];

/**
 * Compute the aggregate status for a phase based on its features.
 */
function phaseStatus(features) {
  const statuses = new Set(features.map(f => f.status));
  if (statuses.size === 1) return [...statuses][0];
  if (statuses.has('IN_PROGRESS') || statuses.has('PARTIAL')) return 'PARTIAL';
  if (statuses.has('PLANNED') && statuses.has('COMPLETE')) return 'PARTIAL';
  return 'PLANNED';
}

/**
 * Pure transform: merge a features array into a base ROADMAP.md text string
 * and return the resulting text. No filesystem access.
 *
 * @param {string} baseText - The existing ROADMAP.md content (empty string for a fresh file)
 * @param {Array} features - Feature objects (as returned by listFeatures)
 * @param {object} [opts]
 * @param {string} [opts.projectName] - Project name for default preamble
 * @param {string} [opts.projectDescription] - Project description for default preamble
 * @param {string} [opts.cwd] - Used only for drift emission (optional; defaults to '')
 * @param {string} [opts.featuresDir] - Passed through to buildKeyDocs (optional)
 * @param {string} [opts.now] - ISO date (YYYY-MM-DD) for the 'Last updated' line; defaults to today. Inject for deterministic output.
 * @param {boolean} [opts.suppressDrift] - When true, skip emitDrift side effects (used by the pure roundtrip checker).
 * @returns {string} - Merged ROADMAP.md content
 */
export function generateRoadmapFromBase(baseText, features, opts = {}) {
  const cwd = opts.cwd ?? '';
  const featuresDir = opts.featuresDir ?? 'docs/features';

  const existingText = baseText ?? '';
  const preamble = readPreamble(cwd, opts, existingText);
  const overrides = readPhaseOverrides(existingText);
  const anonRows = readAnonymousRows(existingText);
  const preserved = readPreservedSections(existingText);
  const anchors = readPreservedSectionAnchors(existingText);
  const sourcePhaseOrder = readPhaseOrder(existingText);
  const phaseBlocks = readPhaseBlocks(existingText);

  // Build anchor → preservedIds Map for splice-back during phase emission.
  const anchorToPreserved = new Map();
  for (const [id, anchor] of anchors) {
    const arr = anchorToPreserved.get(anchor) ?? [];
    arr.push(id);
    anchorToPreserved.set(anchor, arr);
  }

  // Group by phase. Phase-less features fall into the conventional `Features`
  // bucket — the SAME phase identity a curated `## Features` source section
  // parses to — so they MERGE into one section instead of being emitted as a
  // second, hardcoded `## Features` heading alongside the source block (BUG-26).
  const phases = new Map();
  const UNGROUPED_PHASE = 'Features';

  for (const f of features) {
    const phase = f.phase || UNGROUPED_PHASE;
    if (!phases.has(phase)) phases.set(phase, []);
    phases.get(phase).push(f);
  }

  const sections = [preamble.trimEnd()];

  // Splice in any preserved sections anchored to null (top-of-file, before first phase).
  for (const id of anchorToPreserved.get(null) ?? []) {
    sections.push(preserved.get(id));
  }

  // Build merged phase order: source order first (preserves curated sequencing
  // for empty/legacy phases that have no feature.json), then any feature.json
  // phases not yet in source (truly new phases) sorted by feature position.
  //
  // Dedupe by phase identity (first occurrence wins). A phaseId is a section
  // identity; the same `## ` heading appearing twice in source is the
  // duplicate-section bug, not two distinct phases. Without this dedupe the
  // emit loop below pushes an anon-phase block once per occurrence, so regen
  // is a fixed point on duplicates (2x stays 2x forever) rather than a
  // converger — a duplicate introduced once becomes permanent and survives
  // hand-collapse on the next regen. Deduping makes regen self-healing:
  // 4x/2x/1x source all converge to 1x output.
  const orderedPhaseIds = [...new Set(sourcePhaseOrder)];
  const seenInSource = new Set(sourcePhaseOrder);
  const newPhases = [...phases.keys()].filter(p => !seenInSource.has(p));
  // Range-tolerant numeric key (same as listFeatures' sort) so a new phase whose
  // features carry ranged-string positions ("92–95") still orders numerically
  // instead of collapsing to a NaN comparator.
  newPhases.sort((a, b) => {
    const minA = Math.min(...phases.get(a).map(f => positionSortKey(f.position)));
    const minB = Math.min(...phases.get(b).map(f => positionSortKey(f.position)));
    return minA - minB;
  });
  orderedPhaseIds.push(...newPhases);

  // Render each phase. Phases with feature.json features render their tables;
  // phases that exist only in source (override + anon rows) render heading + anon rows.
  const emittedPreservedIds = new Set();
  for (const phase of orderedPhaseIds) {
    const phaseFeatures = phases.get(phase) ?? [];
    const override = overrides.get(phase);

    if (phaseFeatures.length === 0) {
      // No feature.json features for this phase. Splice the original phase
      // block verbatim — preserves heading override + intro prose + table
      // (anon rows) + exit text. If the source has no block (truly new phase
      // with no source counterpart and no features), skip.
      const block = phaseBlocks.get(phase);
      if (block && block.trim().length > 0) {
        sections.push(block.trimEnd());
        for (const id of anchorToPreserved.get(phase) ?? []) {
          sections.push(preserved.get(id));
          emittedPreservedIds.add(id);
        }
      }
      continue;
    }

    // Typed phase: render from feature.json with override + anon-row interleave.
    const rollupStatus = phaseStatus(phaseFeatures);
    let headingStatus = rollupStatus;
    if (override) {
      const overrideToken = parseStatusToken(override);
      if (overrideToken && overrideToken !== rollupStatus) {
        if (cwd && !opts.suppressDrift) emitDrift(cwd, { phaseId: phase, override, computed: rollupStatus });
      }
      // Override always wins. We can't reliably distinguish curated overrides
      // from previously-auto-generated rollups without explicit marking, so
      // we preserve all overrides and let drift detection surface divergence.
      headingStatus = override;
    }
    const phaseAnonRows = anonRows.get(phase) ?? [];
    const sourceBlock = phaseBlocks.get(phase);
    if (sourceBlock) {
      // Splice regenerated table into the source block so curated prose
      // (intro paragraph, exit text, links) survives.
      sections.push(spliceTableIntoBlock(sourceBlock, phase, headingStatus, phaseFeatures, phaseAnonRows));
    } else {
      // Truly new phase (no source counterpart): synthesize from scratch.
      sections.push(renderPhase(phase, headingStatus, phaseFeatures, phaseAnonRows));
    }

    for (const id of anchorToPreserved.get(phase) ?? []) {
      sections.push(preserved.get(id));
      emittedPreservedIds.add(id);
    }
  }

  // (Phase-less features are now grouped under the `Features` phase above and
  // rendered by the main phase loop — no separate ungrouped emission. See BUG-26.)

  // Splice any preserved sections whose anchor phase didn't survive — append at end.
  for (const [id, anchor] of anchors) {
    if (anchor === null) continue;
    if (emittedPreservedIds.has(id)) continue;
    if (!phases.has(anchor)) {
      sections.push(preserved.get(id));
    }
  }

  // Key documents auto-gen is suppressed when a `key-documents` preserved-section exists.
  // The preserved section already carries the curated content (including external links).
  if (!preserved.has('key-documents')) {
    const keyDocs = buildKeyDocs(features, featuresDir);
    if (keyDocs) sections.push(keyDocs);
  }

  return sections.join('\n\n---\n\n') + '\n';
}

/**
 * Generate ROADMAP.md content from feature.json files.
 *
 * @param {string} cwd - Project root
 * @param {object} [opts]
 * @param {string} [opts.featuresDir] - Relative path to features dir
 * @param {string} [opts.projectName] - Project name for header
 * @param {string} [opts.projectDescription] - Project description for header
 * @param {string} [opts.now] - ISO date (YYYY-MM-DD) for the 'Last updated' line; defaults to today. Inject for deterministic output.
 * @returns {string} - Generated ROADMAP.md content
 */
export function generateRoadmap(cwd, opts = {}) {
  const roadmapPath = resolveRoadmapPath(cwd);
  const existingText = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '';

  // Narrative-owned workspace: ROADMAP.md is hand-authored. Return it verbatim
  // rather than regenerating from feature.json (#39).
  if (isNarrativeOwned(cwd)) {
    console.warn(narrativeOwnedMessage(cwd));
    return existingText;
  }

  const featuresDir = opts.featuresDir ?? loadFeaturesDir(cwd);
  const features = listFeatures(cwd, featuresDir);

  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  return generateRoadmapFromBase(existingText, features, { ...opts, cwd, featuresDir, now });
}

/**
 * Read the preamble (everything before the first ## Phase/Feature section)
 * from an existing ROADMAP.md, or generate a default one.
 */
function readPreamble(cwd, opts, existingText) {
  if (existingText && existingText.length > 0) {
    // Find the first `## ` or `<!-- preserved-section: ... -->` marker.
    // Preserved-section markers belong to the preservation flow, not the preamble,
    // so they bound the preamble the same way phase headings do.
    let firstHeadingIdx = -1;
    for (const re of [/^## /m, /^<!--\s*preserved-section:/m]) {
      const m = existingText.match(re);
      if (m) {
        const idx = existingText.indexOf(m[0]);
        if (firstHeadingIdx === -1 || idx < firstHeadingIdx) firstHeadingIdx = idx;
      }
    }
    if (firstHeadingIdx === -1) {
      // No phase headings found — the entire file is a preamble (e.g. remote file
      // contains only a header/intro with no generated sections yet). Preserve it.
      const stripped = existingText.trimEnd().replace(/\n---\s*$/, '').trimEnd();
      if (stripped.length > 0) return stripped;
    } else if (firstHeadingIdx > 0) {
      // Walk back over a possible `---\n\n` separator immediately before the heading
      // so it doesn't get duplicated against the join("\n\n---\n\n") below.
      let cutIdx = firstHeadingIdx;
      const tail = existingText.slice(0, cutIdx).trimEnd();
      // If preamble ends with `---`, strip it.
      const stripped = tail.replace(/\n---\s*$/, '').trimEnd();
      if (stripped.length > 0) return stripped;
    }
  }

  // Default preamble
  const name = opts.projectName ?? 'Project';
  const desc = opts.projectDescription ?? '';
  const today = opts.now ?? new Date().toISOString().slice(0, 10);
  return `# ${name} Roadmap

${desc ? desc + '\n\n' : ''}<!-- Generated from feature.json — do not edit manually -->
<!-- Run: compose roadmap generate -->

**Last updated:** ${today}

---

## Roadmap Conventions

- **Status:** \`PLANNED\` | \`IN_PROGRESS\` | \`PARTIAL\` | \`COMPLETE\` | \`SUPERSEDED\` | \`PARKED\`
- Items are numbered sequentially. Never reuse a number.
- Cross-reference stable IDs (e.g. \`FEAT-1\`) not section headings.`;
}

/**
 * Render a phase section with its feature table.
 */
/**
 * Splice a regenerated table into a source phase block so curated prose
 * (intro paragraph, exit text, doc links) survives a no-op regen.
 *
 * Strategy: the source block is `<heading>\n\n<prose>\n\n<table>\n\n<trailing>`.
 * Find the table boundaries (header row + divider through the last contiguous
 * `|...|` row), replace heading line with the override/rollup-aware version,
 * replace the table portion with a freshly rendered one, keep everything else.
 */
function spliceTableIntoBlock(sourceBlock, phaseName, headingStatus, features, anonRows) {
  const lines = sourceBlock.split('\n');
  const isTableLine = (s) => /^\s*\|.*\|\s*$/.test(s);

  // Locate the first table row (header) — first `|...|` line.
  let tableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableLine(lines[i])) {
      tableStart = i;
      break;
    }
  }

  // Locate the last contiguous table row — walk forward from tableStart over
  // any `|...|` lines. Allow blank lines inside if the next non-blank is a
  // table line (rare but possible). Simpler: stop at first non-table-non-blank.
  let tableEnd = tableStart;
  if (tableStart !== -1) {
    let i = tableStart;
    while (i < lines.length) {
      if (isTableLine(lines[i])) {
        tableEnd = i;
        i++;
      } else if (lines[i].trim() === '' && i + 1 < lines.length && isTableLine(lines[i + 1])) {
        i++; // skip blank between rows
      } else {
        break;
      }
    }
  }

  // Build the replacement table (header + divider + rows with anon interleave).
  const newTable = renderTableLines(features, anonRows);

  // Replace heading line (always lines[0] for a phase block).
  const headingLine = `## ${phaseName} — ${headingStatus}`;
  const out = [headingLine];

  if (tableStart === -1) {
    // No existing table — append the new one after the existing prose.
    for (let i = 1; i < lines.length; i++) out.push(lines[i]);
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    out.push(...newTable);
    return out.join('\n');
  }

  // Emit prose between heading and table.
  for (let i = 1; i < tableStart; i++) out.push(lines[i]);

  // Emit the regenerated table.
  out.push(...newTable);

  // Emit trailing content after the original table.
  for (let i = tableEnd + 1; i < lines.length; i++) out.push(lines[i]);

  return out.join('\n');
}

/**
 * Render the table portion (header + divider + rows) for a phase. Anon rows
 * interleave by predecessorCode rules.
 */
function renderTableLines(features, anonRows) {
  const hasSubItems = features.some(f => f.items && f.items.length > 0);
  const lines = [];

  const anonByPredecessor = new Map();
  for (const row of anonRows) {
    const arr = anonByPredecessor.get(row.predecessorCode) ?? [];
    arr.push(row.rawLine);
    anonByPredecessor.set(row.predecessorCode, arr);
  }
  const emitAnonAfter = (code) => {
    for (const raw of anonByPredecessor.get(code) ?? []) lines.push(raw);
    anonByPredecessor.delete(code);
  };

  if (hasSubItems) {
    lines.push('| # | Feature | Item | Status |');
    lines.push('|---|---------|------|--------|');
    emitAnonAfter(null);
    for (const f of features) {
      if (f.items && f.items.length > 0) {
        for (const item of f.items) {
          const num = item.position ?? '—';
          const desc = escCell(item.description ?? '');
          const st = item.status ?? f.status;
          lines.push(`| ${num} | ${f.code} | ${desc} | ${st} |`);
        }
      } else {
        const num = f.position ?? '—';
        lines.push(`| ${num} | ${f.code} | ${escCell(f.description)} | ${f.status} |`);
      }
      emitAnonAfter(f.code);
    }
  } else {
    lines.push('| # | Feature | Description | Status |');
    lines.push('|---|---------|-------------|--------|');
    emitAnonAfter(null);
    for (const f of features) {
      const num = f.position ?? '—';
      const desc = escCell(f.description ?? '');
      lines.push(`| ${num} | ${f.code} | ${desc} | ${f.status} |`);
      emitAnonAfter(f.code);
    }
  }

  // Leftovers (predecessor deleted) — append at end of table.
  for (const [, leftover] of anonByPredecessor) {
    for (const raw of leftover) lines.push(raw);
  }

  return lines;
}

function renderPhase(phaseName, status, features, anonRows = []) {
  const lines = [`## ${phaseName} — ${status}`, ''];

  // Phase description from the first feature's phaseDescription if available
  const desc = features[0]?.phaseDescription;
  if (desc) {
    lines.push(desc, '');
  }

  // Determine table columns based on whether features have sub-items
  const hasSubItems = features.some(f => f.items && f.items.length > 0);

  // Index anon rows by predecessorCode for interleave.
  const anonByPredecessor = new Map();
  for (const row of anonRows) {
    const key = row.predecessorCode; // null = head-of-table
    const arr = anonByPredecessor.get(key) ?? [];
    arr.push(row.rawLine);
    anonByPredecessor.set(key, arr);
  }
  const emitAnonAfter = (code) => {
    for (const raw of anonByPredecessor.get(code) ?? []) lines.push(raw);
    anonByPredecessor.delete(code);
  };

  if (hasSubItems) {
    // Expanded: one row per sub-item
    lines.push('| # | Feature | Item | Status |');
    lines.push('|---|---------|------|--------|');
    emitAnonAfter(null); // any head-of-table anon rows
    for (const f of features) {
      if (f.items && f.items.length > 0) {
        for (const item of f.items) {
          const num = item.position ?? '—';
          const desc = escCell(item.description ?? '');
          const st = item.status ?? f.status;
          lines.push(`| ${num} | ${f.code} | ${desc} | ${st} |`);
        }
      } else {
        const num = f.position ?? '—';
        lines.push(`| ${num} | ${f.code} | ${escCell(f.description)} | ${f.status} |`);
      }
      emitAnonAfter(f.code);
    }
  } else {
    // Simple: one row per feature
    lines.push('| # | Feature | Description | Status |');
    lines.push('|---|---------|-------------|--------|');
    // COMP-MCP-MIGRATION-2-1: no truncation. Curated descriptions are
     // often multi-sentence; truncating them at 80 chars makes regen lossy.
     // Markdown tables tolerate long cells fine.
    emitAnonAfter(null); // any head-of-table anon rows
    for (const f of features) {
      const num = f.position ?? '—';
      const desc = escCell(f.description ?? '');
      lines.push(`| ${num} | ${f.code} | ${desc} | ${f.status} |`);
      emitAnonAfter(f.code);
    }
  }

  // Any anon rows whose predecessor was deleted: append at the end of the table.
  for (const [, leftover] of anonByPredecessor) {
    for (const raw of leftover) lines.push(raw);
  }

  // Exit criteria
  const exit = features[0]?.phaseExit;
  if (exit) {
    lines.push('', `**Exit:** ${exit}`);
  }

  // Links to design docs
  const docsLinks = features
    .filter(f => f.designDoc)
    .map(f => `See \`${f.designDoc}\` for ${f.code} design.`);
  if (docsLinks.length > 0) {
    lines.push('', docsLinks.join('\n'));
  }

  return lines.join('\n');
}

/**
 * Build a Key Documents section from features that have design docs.
 */
function buildKeyDocs(features, featuresDir) {
  const docs = features
    .filter(f => existsSync || f.designDoc) // always include if designDoc is set
    .filter(f => f.designDoc)
    .map(f => `| \`${f.designDoc}\` | ${f.code} design |`);

  if (docs.length === 0) return null;

  return [
    '## Key Documents',
    '',
    '| Document | What it is |',
    '|---|---|',
    ...docs,
  ].join('\n');
}

/**
 * Write the generated ROADMAP.md to disk.
 *
 * @param {string} cwd - Project root
 * @param {object} [opts]
 */
export function writeRoadmap(cwd, opts = {}) {
  const roadmapPath = resolveRoadmapPath(cwd);

  // Narrative-owned workspace: never overwrite hand-authored ROADMAP.md (#39).
  // No-op + warn; the existing file on disk is the source of truth.
  if (isNarrativeOwned(cwd)) {
    console.warn(narrativeOwnedMessage(cwd));
    return roadmapPath;
  }

  const content = generateRoadmap(cwd, opts);
  writeFileSync(roadmapPath, content);
  return roadmapPath;
}
