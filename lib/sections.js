/**
 * sections.js — per-task plan section files for COMP-PLAN-SECTIONS.
 *
 * Owned by compose. Invoked from build.js after the Phase 6 plan_gate is
 * approved (emitSections) and after the feature-final ship step records a
 * commit (appendTrailers). External skills (buddy:*, superpowers:*) are
 * untouched.
 *
 * See docs/features/COMP-PLAN-SECTIONS/{design,blueprint,plan}.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SECTIONS_DIR, getSectionsThreshold } from './constants.js';
import { parsePlanItems } from './plan-parser.js';

// ---------- Pure helpers ----------

/**
 * slugify(text) — stable URL-safe slug. Lowercase, runs of non-alphanumerics
 * collapse to single dashes, leading/trailing dashes trimmed, capped at 40.
 */
export function slugify(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, ''); // trim trailing dash if cap landed on one
}

/**
 * shouldEmitSections(taskCount) — true iff taskCount > threshold.
 */
export function shouldEmitSections(taskCount) {
  if (!Number.isFinite(taskCount)) return false;
  return taskCount > getSectionsThreshold();
}

/**
 * parseTaskBlocks(planMarkdown) — split a plan into task blocks.
 *
 * Recognised heading shapes:
 *   ## Task N <separator> <title>
 *   ### Task N <separator> <title>
 * where <separator> is optional and may be one of: '—', '-', ':', '.'.
 *
 * Returns [{ id: 'TN', title, headingLevel, body }] in order. Empty array
 * if no task headings match.
 */
export function parseTaskBlocks(planMarkdown) {
  if (!planMarkdown || typeof planMarkdown !== 'string') return [];

  const lines = planMarkdown.split('\n');
  const headingRe = /^(#{2,3})\s+Task\s+(\d+)\b\s*(?:[—\-:.]\s*)?(.*)$/i;

  // Collect heading positions
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      heads.push({
        line: i,
        headingLevel: m[1].length,
        num: parseInt(m[2], 10),
        title: (m[3] || '').trim(),
      });
    }
  }
  if (heads.length === 0) return [];

  const blocks = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].line + 1;
    const end = i + 1 < heads.length ? heads[i + 1].line : lines.length;
    const body = lines.slice(start, end).join('\n').replace(/^\n+|\n+$/g, '');
    blocks.push({
      id: `T${heads[i].num}`,
      title: heads[i].title,
      headingLevel: heads[i].headingLevel,
      body,
    });
  }
  return blocks;
}

/**
 * extractSectionFiles(taskBody) — distinct file refs declared in checkboxes.
 *
 * Reuses plan-parser.parsePlanItems for `Files:` extraction. Returns deduped
 * file paths in encounter order; empty array if none.
 */
export function extractSectionFiles(taskBody) {
  const items = parsePlanItems(taskBody || '');
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (it.file && !seen.has(it.file)) {
      seen.add(it.file);
      out.push(it.file);
    }
  }
  return out;
}

// ---------- Filesystem: emitSections ----------

function readPlan(featureDir) {
  const planPath = path.join(featureDir, 'plan.md');
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, 'utf8');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * parseDependsOn(taskBody) — string-match a "Depends on:" or "Depends:" line
 * from the task body. Returns the trimmed value, or null if none found.
 */
export function parseDependsOn(taskBody) {
  if (!taskBody || typeof taskBody !== 'string') return null;
  const m = taskBody.match(/^[ \t]*Depends(?:\s+on)?:\s*(.+?)\s*$/im);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function renderSectionFile({ block, idx, files }) {
  const filesLine = files.length ? files.join(', ') : '—';
  const title = block.title || `Task ${block.id.slice(1)}`;
  const dependsRaw = parseDependsOn(block.body);
  const dependsLine = dependsRaw || '—';
  return [
    `# Section ${pad2(idx)} — ${title}`,
    ``,
    `**Task ID:** ${block.id}`,
    `**Depends on:** ${dependsLine}`,
    `**Files:** ${filesLine}`,
    ``,
    `## Plan`,
    ``,
    block.body,
    ``,
  ].join('\n');
}

/**
 * emitSections(featureDir) — idempotent emission of `<featureDir>/sections/`.
 *
 * Returns { created: string[], skipped: string[] } (relative paths within
 * sections/). No-op if `plan.md` is missing or task count is sub-threshold.
 * Existing section files are NEVER overwritten.
 */
export function emitSections(featureDir) {
  const result = { created: [], skipped: [] };
  if (!featureDir) return result;

  const plan = readPlan(featureDir);
  if (plan == null) return result;

  const blocks = parseTaskBlocks(plan);
  if (!shouldEmitSections(blocks.length)) return result;

  const sectionsDir = path.join(featureDir, SECTIONS_DIR);
  fs.mkdirSync(sectionsDir, { recursive: true });

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const idx = i + 1;
    const slug = slugify(block.title) || `task-${block.id.slice(1)}`;
    const filename = `section-${pad2(idx)}-${slug}.md`;
    const fullPath = path.join(sectionsDir, filename);
    if (fs.existsSync(fullPath)) {
      result.skipped.push(filename);
      continue;
    }
    const files = extractSectionFiles(block.body);
    const content = renderSectionFile({ block, idx, files });
    fs.writeFileSync(fullPath, content);
    result.created.push(filename);
  }

  return result;
}

// ---------- Filesystem: appendTrailers ----------

const TRAILER_HEADING_RE = /^## What Was Built(?:\s*\(iteration\s+(\d+)\))?\s*$/gm;

function readDeclaredFiles(sectionContent) {
  const m = sectionContent.match(/^\*\*Files:\*\*\s+(.+)$/m);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw || raw === '—' || raw === '-') return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * maxIteration(sectionContent) — scan all "What Was Built" headers and return
 * the maximum iteration N (treating the unnumbered first one as N=1). Returns
 * 0 if no trailer exists yet.
 */
function maxIteration(sectionContent) {
  const re = /^## What Was Built(?:\s*\(iteration\s+(\d+)\))?\s*$/gm;
  let max = 0;
  let m;
  while ((m = re.exec(sectionContent)) !== null) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function nextTrailerHeading(maxIter) {
  if (maxIter <= 0) return '## What Was Built';
  return `## What Was Built (iteration ${maxIter + 1})`;
}

/**
 * computeFilteredDiffStat(cwd, commit, declaredFiles) — best-effort per-section
 * `git diff --stat <commit>~1..<commit> -- <files>`. Returns the trimmed string,
 * or a sentinel:
 *   - "(no declared files)" when declaredFiles is empty
 *   - "(diff stat unavailable)" on any failure
 */
function computeFilteredDiffStat(cwd, commit, declaredFiles) {
  if (!declaredFiles || declaredFiles.length === 0) return '(no declared files)';
  if (!cwd || !commit) return '(diff stat unavailable)';
  try {
    // Use execFileSync with an argv array — no shell, no expansion, so file paths
    // containing $(...), backticks, backslashes, spaces, etc. are passed verbatim
    // to git as literal pathspecs.
    const argv = ['diff', '--stat', `${commit}~1..${commit}`, '--', ...declaredFiles];
    const out = execFileSync('git', argv, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out || '(diff stat unavailable)';
  } catch {
    return '(diff stat unavailable)';
  }
}

function renderTrailer({ heading, commit, diffStat, owned, deviated }) {
  const ownedStr = owned.length ? owned.join(', ') : 'None';
  const deviatedStr = deviated.length ? deviated.join(', ') : 'None';
  const commitStr = commit ? `\`${commit}\`` : '`unknown`';
  const diffStr = diffStat && String(diffStat).trim() ? String(diffStat).trim() : '(diff stat unavailable)';
  return [
    ``,
    heading,
    ``,
    `- **Commit:** ${commitStr}`,
    `- **Diff:** ${diffStr}`,
    `- **Files this section owns that changed:** ${ownedStr}`,
    `- **Files this section declared but did not change:** ${deviatedStr}`,
    ``,
  ].join('\n');
}

/**
 * appendTrailers({ featureDir, commit, filesChanged, cwd, diffStat? }) — append
 * a "What Was Built" block to every section file under `<featureDir>/sections/`.
 *
 * - No-op if sections/ is absent.
 * - Auto-numbers re-runs as `iteration max(N)+1` (append-only; never overwrites).
 * - Per-section partition: declared ∩ changed → owned; declared \ changed →
 *   deviation. Changed-but-undeclared is deferred to COMP-PLAN-SECTIONS-REPORT.
 * - Per-section diff stat: when `cwd` is provided, runs
 *     `git diff --stat <commit>~1..<commit> -- <declared-files>`
 *   filtered to that section's declared files. When `cwd` is omitted but a
 *   `diffStat` string is provided (legacy callers), uses that string verbatim.
 *
 * Returns { trailed: string[] } — section filenames updated.
 */
export function appendTrailers({ featureDir, commit, filesChanged, cwd, diffStat } = {}) {
  const result = { trailed: [] };
  if (!featureDir) return result;
  const sectionsDir = path.join(featureDir, SECTIONS_DIR);
  if (!fs.existsSync(sectionsDir)) return result;

  const changedSet = new Set(Array.isArray(filesChanged) ? filesChanged : []);
  const files = fs
    .readdirSync(sectionsDir)
    .filter(f => /^section-\d+-.+\.md$/.test(f))
    .sort();

  for (const filename of files) {
    const fullPath = path.join(sectionsDir, filename);
    const existing = fs.readFileSync(fullPath, 'utf8');
    const declared = readDeclaredFiles(existing);
    const owned = declared.filter(f => changedSet.has(f));
    const deviated = declared.filter(f => !changedSet.has(f));
    const heading = nextTrailerHeading(maxIteration(existing));
    // Prefer cwd-based per-section filtered diff. Fall back to legacy diffStat
    // string only when cwd is not supplied. Wrapped in try/catch — failure
    // substitutes "(diff stat unavailable)".
    let perSectionDiff;
    if (cwd) {
      try {
        perSectionDiff = computeFilteredDiffStat(cwd, commit, declared);
      } catch {
        perSectionDiff = '(diff stat unavailable)';
      }
    } else {
      perSectionDiff = diffStat;
    }
    const trailer = renderTrailer({ heading, commit, diffStat: perSectionDiff, owned, deviated });
    const sep = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(fullPath, existing + sep + trailer);
    result.trailed.push(filename);
  }

  return result;
}
