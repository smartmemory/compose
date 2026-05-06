/**
 * roadmap-gen.js — Generate ROADMAP.md from feature.json files.
 *
 * feature.json is the source of truth. ROADMAP.md is a rendered view.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { listFeatures } from './feature-json.js';
import { loadFeaturesDir } from './project-paths.js';
import {
  readPhaseOverrides,
  readAnonymousRows,
  readPreservedSections,
  readPreservedSectionAnchors,
  readPhaseOrder,
  readPhaseBlocks,
} from './roadmap-preservers.js';
import { emitDrift } from './roadmap-drift.js';

const STATUS_ORDER = ['IN_PROGRESS', 'PARTIAL', 'PLANNED', 'COMPLETE', 'SUPERSEDED', 'PARKED'];
const STATUS_TOKENS = ['COMPLETE', 'IN_PROGRESS', 'PARTIAL', 'PLANNED', 'SUPERSEDED', 'PARKED', 'BLOCKED', 'KILLED'];

/**
 * Extract the leading status token from override text like
 * `PARTIAL (1a–1d COMPLETE, 2 PLANNED)` → `PARTIAL`.
 * Returns null if no token recognized.
 */
function parseStatusToken(override) {
  for (const t of STATUS_TOKENS) {
    if (override === t) return t;
    if (override.startsWith(t + ' ') || override.startsWith(t + '(')) return t;
  }
  return null;
}

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
 * Generate ROADMAP.md content from feature.json files.
 *
 * @param {string} cwd - Project root
 * @param {object} [opts]
 * @param {string} [opts.featuresDir] - Relative path to features dir
 * @param {string} [opts.projectName] - Project name for header
 * @param {string} [opts.projectDescription] - Project description for header
 * @returns {string} - Generated ROADMAP.md content
 */
export function generateRoadmap(cwd, opts = {}) {
  const featuresDir = opts.featuresDir ?? loadFeaturesDir(cwd);
  const features = listFeatures(cwd, featuresDir);

  // Read existing ROADMAP.md once: preamble + curated content for splice-back.
  const roadmapPath = join(cwd, 'ROADMAP.md');
  const existingText = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '';
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

  // Group by phase
  const phases = new Map();
  const ungrouped = [];

  for (const f of features) {
    const phase = f.phase ?? null;
    if (!phase) {
      ungrouped.push(f);
      continue;
    }
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
  const orderedPhaseIds = [...sourcePhaseOrder];
  const seenInSource = new Set(sourcePhaseOrder);
  const newPhases = [...phases.keys()].filter(p => !seenInSource.has(p));
  newPhases.sort((a, b) => {
    const minA = Math.min(...phases.get(a).map(f => f.position ?? 999));
    const minB = Math.min(...phases.get(b).map(f => f.position ?? 999));
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
        emitDrift(cwd, { phaseId: phase, override, computed: rollupStatus });
      }
      // Override always wins. We can't reliably distinguish curated overrides
      // from previously-auto-generated rollups without explicit marking, so
      // we preserve all overrides and let drift detection surface divergence.
      headingStatus = override;
    }
    const phaseAnonRows = anonRows.get(phase) ?? [];
    sections.push(renderPhase(phase, headingStatus, phaseFeatures, phaseAnonRows));

    for (const id of anchorToPreserved.get(phase) ?? []) {
      sections.push(preserved.get(id));
      emittedPreservedIds.add(id);
    }
  }

  // Render ungrouped features
  if (ungrouped.length > 0) {
    sections.push(renderPhase('Features', phaseStatus(ungrouped), ungrouped, []));
  }

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
    if (firstHeadingIdx > 0) {
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
  const today = new Date().toISOString().slice(0, 10);
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
          const desc = item.description ?? '';
          const st = item.status ?? f.status;
          lines.push(`| ${num} | ${f.code} | ${desc} | ${st} |`);
        }
      } else {
        const num = f.position ?? '—';
        lines.push(`| ${num} | ${f.code} | ${f.description} | ${f.status} |`);
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
      const desc = f.description ?? '';
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
  const content = generateRoadmap(cwd, opts);
  const roadmapPath = join(cwd, 'ROADMAP.md');
  writeFileSync(roadmapPath, content);
  return roadmapPath;
}
