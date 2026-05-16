/**
 * changelog-writer.js — typed writer + reader for compose/CHANGELOG.md.
 *
 * Sub-ticket #3 of COMP-MCP-FEATURE-MGMT (COMP-MCP-CHANGELOG-WRITER).
 *
 * Two operations:
 *   addChangelogEntry(cwd, args)  — render + insert/replace one entry, atomic write
 *   getChangelogEntries(cwd, opts) — read, filter by code/since, limit
 *
 * Plus exported helpers for tests / future COMP-MCP-VALIDATE:
 *   parseChangelog(text)
 *   renderEntry({ code, summary, body, sections })
 *
 * Reuses the writer framework: caller-supplied idempotency_key via
 * lib/idempotency.js, audit log via lib/feature-events.js, code validation +
 * safeAppendEvent pattern from lib/feature-writer.js. Atomic write mirrors
 * lib/sections.js writeRollup.
 *
 * No HTTP. Pure file IO so the same writers are callable from MCP tools, the
 * CLI, or future REST routes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendEvent, normalizeSince } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';

// providerFor is imported lazily to avoid the load-time cycle:
// factory.js → local-provider.js → changelog-writer.js
async function getProvider(cwd) {
  const { providerFor } = await import('./tracker/factory.js');
  return providerFor(cwd);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FEATURE_CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^v\d+\.\d+\.\d+$/;
const KNOWN_SECTIONS = new Set(['added', 'changed', 'fixed', 'snapshot']);
const SUBSECTION_ORDER = ['added', 'changed', 'fixed', 'snapshot'];
const SUBSECTION_LABELS = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  snapshot: 'Snapshot',
};

function inputError(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

function formatError(message) {
  const err = new Error(message);
  err.code = 'CHANGELOG_FORMAT';
  return err;
}

function validateCode(code) {
  if (typeof code !== 'string' || !FEATURE_CODE_RE.test(code)) {
    throw inputError(`changelog-writer: invalid feature code "${code}" — must match ${FEATURE_CODE_RE}`);
  }
}

function validateDateOrVersion(value) {
  if (typeof value !== 'string' || (!DATE_RE.test(value) && !VERSION_RE.test(value))) {
    throw inputError(`changelog-writer: invalid date_or_version "${value}" — must match YYYY-MM-DD or vX.Y.Z`);
  }
}

function validateSummary(summary) {
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw inputError('changelog-writer: summary is required');
  }
}

function validateSections(sections) {
  if (sections === undefined || sections === null) return;
  if (typeof sections !== 'object' || Array.isArray(sections)) {
    throw inputError('changelog-writer: sections must be an object');
  }
  for (const [k, v] of Object.entries(sections)) {
    if (!KNOWN_SECTIONS.has(k)) {
      throw inputError(`changelog-writer: invalid sections key "${k}" — must be one of ${[...KNOWN_SECTIONS].join(', ')}`);
    }
    if (!Array.isArray(v) || v.some(item => typeof item !== 'string')) {
      throw inputError(`changelog-writer: sections.${k} must be a string[]`);
    }
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const H1_RE = /^# Changelog\s*$/;
const SURFACE_RE = /^## (.+?)\s*$/;
const ENTRY_HEADER_RE = /^### ([A-Z][A-Z0-9-]*[A-Z0-9])\s+—\s+(.+?)\s*$/;
// Permissive subsection label: starts with a letter, contains any non-`*`/`:`
// thereafter. Tolerates digits, spaces, hyphens (e.g. `**Phase 7 review-loop fixes:**`).
const SUBSECTION_RE = /^\*\*([A-Za-z][^*:]*):\*\*\s*$/;
const BULLET_RE = /^- (.+)$/;

/**
 * parseChangelog(text) — single-pass tolerant parser.
 *
 * Returns:
 *   {
 *     h1: 'Changelog' | null,
 *     surfaces: [
 *       {
 *         kind: 'date' | 'version',
 *         label: string,
 *         startLine: number,    // 1-based, points at the `## ...` heading
 *         endLine: number,      // exclusive (1-based line number of next surface or EOF+1)
 *         entries: [
 *           {
 *             code, summary, body,
 *             sections: { added: [], changed: [], fixed: [], snapshot: [] },
 *             unknownLabels: { Hardened: [...], Knobs: [...] },
 *             startLine,        // 1-based, points at the `### CODE — ...` header
 *             endLine,          // exclusive
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Permissive: any line not matching a known structural marker accretes into
 * the current entry's body (entries inherit pre-subsection prose) or the
 * current entry's most-recently-opened labeled subsection (bullets only).
 */
export function parseChangelog(text) {
  const lines = text.split('\n');
  const result = { h1: null, surfaces: [] };

  let curSurface = null;
  let curEntry = null;
  let curLabelKey = null;  // 'added'/'changed'/.../null
  let curUnknownLabel = null;  // exact original label string
  // Buffer for body lines — flushed into entry.body when subsection or end-of-entry.
  let bodyBuf = [];

  function closeEntry(endLineExclusive) {
    if (curEntry) {
      // Only flush body buffer if no subsection has opened yet — once a
      // subsection opens, body was already captured at that point.
      if (curLabelKey === null && curUnknownLabel === null) {
        curEntry.body = trimEdges(bodyBuf.join('\n'));
      }
      curEntry.endLine = endLineExclusive;
      curSurface.entries.push(curEntry);
      curEntry = null;
      curLabelKey = null;
      curUnknownLabel = null;
      bodyBuf = [];
    }
  }

  function closeSurface(endLineExclusive) {
    closeEntry(endLineExclusive);
    if (curSurface) {
      curSurface.endLine = endLineExclusive;
      result.surfaces.push(curSurface);
      curSurface = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;  // 1-based

    if (result.h1 === null && H1_RE.test(line)) {
      result.h1 = 'Changelog';
      continue;
    }

    const surfaceM = line.match(SURFACE_RE);
    if (surfaceM) {
      closeSurface(lineNum);
      const label = surfaceM[1].trim();
      const kind = VERSION_RE.test(label) ? 'version'
                : DATE_RE.test(label) ? 'date'
                : 'date'; // permissive: unrecognized → treat as date
      curSurface = { kind, label, startLine: lineNum, endLine: -1, entries: [] };
      continue;
    }

    if (!curSurface) continue;  // pre-surface lines (e.g. blank after H1) — drop.

    const entryM = line.match(ENTRY_HEADER_RE);
    if (entryM) {
      closeEntry(lineNum);
      curEntry = {
        code: entryM[1],
        summary: entryM[2].trim(),
        body: '',
        sections: { added: [], changed: [], fixed: [], snapshot: [] },
        unknownLabels: {},
        startLine: lineNum,
        endLine: -1,
      };
      bodyBuf = [];
      curLabelKey = null;
      curUnknownLabel = null;
      continue;
    }

    if (!curEntry) continue;  // between surface heading and first entry.

    const subM = line.match(SUBSECTION_RE);
    if (subM) {
      // First subsection encountered → flush body buffer.
      if (curLabelKey === null && curUnknownLabel === null) {
        curEntry.body = trimEdges(bodyBuf.join('\n'));
        bodyBuf = [];
      }
      const rawLabel = subM[1];
      const key = rawLabel.toLowerCase();
      if (KNOWN_SECTIONS.has(key)) {
        curLabelKey = key;
        curUnknownLabel = null;
      } else {
        curLabelKey = null;
        curUnknownLabel = rawLabel;
        if (!curEntry.unknownLabels[rawLabel]) curEntry.unknownLabels[rawLabel] = [];
      }
      continue;
    }

    const bulletM = line.match(BULLET_RE);
    if (bulletM && (curLabelKey || curUnknownLabel)) {
      const item = bulletM[1];
      if (curLabelKey) curEntry.sections[curLabelKey].push(item);
      else if (curUnknownLabel) curEntry.unknownLabels[curUnknownLabel].push(item);
      continue;
    }

    // Otherwise, accrete to body buffer (only if no subsection has opened yet).
    if (curLabelKey === null && curUnknownLabel === null) {
      bodyBuf.push(line);
    }
    // Lines under a subsection that aren't bullets are silently dropped from
    // structured output but preserved by file content (parser is read-only).
  }

  closeSurface(lines.length + 1);
  return result;
}

function trimEdges(s) {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * renderEntry({ code, summary, body, sections }) — strict canonical output.
 *
 * Layout:
 *   ### <CODE> — <summary>
 *
 *   <body if present>
 *
 *   **Added:**
 *   - …
 *   …
 *
 * Subsections emitted only when non-empty, in the fixed order
 * Added → Changed → Fixed → Snapshot.
 *
 * Returns a string ending with a single trailing '\n'.
 */
export function renderEntry({ code, summary, body, sections } = {}) {
  const blocks = [`### ${code} — ${summary}`];
  if (body && body.trim().length) {
    blocks.push(body.trim());
  }
  for (const key of SUBSECTION_ORDER) {
    const items = sections && Array.isArray(sections[key]) ? sections[key] : [];
    if (items.length === 0) continue;
    const label = SUBSECTION_LABELS[key];
    const lines = [`**${label}:**`, ...items.map(it => `- ${it}`)];
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// addChangelogEntry
// ---------------------------------------------------------------------------

const CHANGELOG_FILE = 'CHANGELOG.md';

function changelogPath(cwd) {
  return join(cwd, CHANGELOG_FILE);
}

function readChangelogText(cwd) {
  const p = changelogPath(cwd);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

function safeAppendEvent(cwd, event) {
  try {
    appendEvent(cwd, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[changelog-writer] audit append failed for ${event.tool} ${event.code ?? ''}: ${err.message}`);
  }
}

function maybeIdempotent(args, fn) {
  if (args.idempotency_key) {
    return checkOrInsert(args.cwd, args.idempotency_key, fn).then(({ result }) => result);
  }
  return Promise.resolve().then(fn);
}

/**
 * spliceChangelog(currentText, entry) — pure string-in / string-out transform.
 *
 * Parses `currentText`, applies the mutation described by `entry` (same shape
 * as the `args` to addChangelogEntry), and returns the new file content.
 *
 * Exported so future providers (e.g. GitHubProvider) can fetch a remote blob,
 * pass it here, then PUT the result back — without touching the local FS.
 *
 * Throws formatError if the file exists but lacks the `# Changelog` header.
 * Returns { content, insertedAtLine, surface, action } — callers write content.
 */
export function spliceChangelog(currentText, entry) {
  const text = currentText;
  if (text.length > 0 && !H1_RE.test(text.split('\n')[0] ?? '')) {
    throw formatError('first line must be "# Changelog" (line 1)');
  }

  const parsed = parseChangelog(text);

  // Find existing entry across all matching surfaces.
  const matchingSurfaces = parsed.surfaces.filter(s => s.label === entry.date_or_version);
  let existingSurface = null;
  let existingEntry = null;
  for (const s of matchingSurfaces) {
    const e = s.entries.find(en => en.code === entry.code);
    if (e) { existingSurface = s; existingEntry = e; break; }
  }

  const rendered = renderEntry({
    code: entry.code,
    summary: entry.summary,
    body: entry.body,
    sections: entry.sections,
  });

  let action;
  let chosenSurfaceLabel = entry.date_or_version;
  let chosenSurfaceStartLine = -1;

  if (existingEntry && !entry.force) {
    // Storage-level idempotent no-op — caller decides what to do with this.
    return {
      content: null,
      insertedAtLine: existingEntry.startLine,
      surface: existingSurface.label,
      idempotent: true,
    };
  }

  if (existingEntry && entry.force) {
    action = { kind: 'replace', entry: existingEntry, code: entry.code };
    chosenSurfaceLabel = existingSurface.label;
    chosenSurfaceStartLine = existingSurface.startLine;
  } else if (matchingSurfaces.length > 0) {
    const surface = matchingSurfaces[0];
    action = { kind: 'append-to-surface', surface, code: entry.code };
    chosenSurfaceLabel = surface.label;
    chosenSurfaceStartLine = surface.startLine;
  } else if (text.length === 0) {
    action = { kind: 'new-file', code: entry.code };
    chosenSurfaceStartLine = 3;
  } else {
    action = { kind: 'new-surface', code: entry.code };
  }

  const { content, insertedAtLine } = buildNextContent(text, parsed, action, rendered, entry.date_or_version);

  // For new-surface, recompute chosenSurfaceStartLine from output.
  if (action.kind === 'new-surface' || action.kind === 'new-file') {
    const outLines = content.split('\n');
    for (let i = 0; i < outLines.length; i++) {
      if (outLines[i] === `## ${entry.date_or_version}`) {
        chosenSurfaceStartLine = i + 1;
        break;
      }
    }
  }

  return { content, insertedAtLine, surface: chosenSurfaceLabel, idempotent: false, action, chosenSurfaceStartLine };
}

/**
 * Build the next file content given current text + the parsed surfaces and
 * a chosen action.
 *
 * action.kind = 'replace' | 'append-to-surface' | 'new-surface' | 'new-file'
 */
function buildNextContent(text, parsed, action, rendered, dateOrVersion) {
  const lines = text.length ? text.split('\n') : [];
  // Note: split('\n') of '...\n' yields a trailing '' — we treat lines as
  // 1-indexed with `lines[lineNum - 1]`. We rebuild by line indexes.

  if (action.kind === 'new-file') {
    // Empty file → emit H1 + blank + new surface block (containing entry).
    const surfaceBlock = `## ${dateOrVersion}\n\n${rendered}`;
    const out = `# Changelog\n\n${surfaceBlock}`;
    return { content: out.endsWith('\n') ? out : out + '\n', insertedAtLine: locateEntryHeaderLineInSurface(out, action.code, dateOrVersion) };
  }

  if (action.kind === 'new-surface') {
    // Insert new surface immediately after H1 (and any blank line after H1).
    // Find H1 line in the parse result; if absent we shouldn't be here.
    let h1Idx = lines.findIndex(l => H1_RE.test(l));
    if (h1Idx === -1) {
      // shouldn't happen — H1 missing path throws elsewhere; defensive fallback:
      const out = `# Changelog\n\n## ${dateOrVersion}\n\n${rendered}` + (text ? '\n' + text : '');
      return { content: out, insertedAtLine: locateEntryHeaderLineInSurface(out, action.code, dateOrVersion) };
    }
    // Insert after H1 + at most one blank line.
    let insertAt = h1Idx + 1;
    if (lines[insertAt] !== undefined && lines[insertAt].trim() === '') insertAt++;
    const block = `## ${dateOrVersion}\n\n${rendered}`;
    const before = lines.slice(0, insertAt).join('\n');
    const after = lines.slice(insertAt).join('\n');
    let merged;
    if (before.length === 0) {
      merged = block + (after.length ? '\n' + after : '');
    } else {
      merged = before + '\n' + block + (after.length ? '\n' + after : '');
    }
    if (!merged.endsWith('\n')) merged += '\n';
    // Ensure separation: a blank line between block and following surface heading.
    merged = ensureBlankBefore(merged, '## ', `## ${dateOrVersion}`);
    return { content: merged, insertedAtLine: locateEntryHeaderLineInSurface(merged, action.code, dateOrVersion) };
  }

  if (action.kind === 'append-to-surface') {
    const surface = action.surface;
    // Insertion point: end of the surface (last line of surface, exclusive).
    // surface.endLine is 1-based exclusive.
    let insertBefore = surface.endLine - 1;  // 0-based index of next surface heading or EOF
    // Trim trailing blank lines inside the surface so we get exactly one blank
    // line of separation.
    while (insertBefore > surface.startLine - 1 && (lines[insertBefore - 1] ?? '').trim() === '') {
      insertBefore--;
    }
    const before = lines.slice(0, insertBefore).join('\n');
    const after = lines.slice(insertBefore).join('\n');
    // Ensure exactly one blank line between previous content and rendered, and
    // one blank between rendered and after.
    const sep1 = before.endsWith('\n') ? '\n' : (before.length ? '\n\n' : '');
    let middle = (before.length ? sep1 : '') + rendered;
    if (!middle.endsWith('\n')) middle += '\n';
    let merged = before + middle.slice(before.endsWith('\n') ? 0 : 0);
    // Simpler reconstruction:
    const beforePart = lines.slice(0, insertBefore).join('\n');
    const afterPart = lines.slice(insertBefore).join('\n');
    const beforeNorm = beforePart.length ? beforePart.replace(/\n*$/, '\n') : '';
    const afterNorm = afterPart.length ? afterPart.replace(/^\n*/, '') : '';
    let out = beforeNorm + '\n' + rendered;
    if (afterNorm.length) {
      // Need a blank line before next surface heading.
      out = out.replace(/\n*$/, '\n');
      out += '\n' + afterNorm;
    }
    if (!out.endsWith('\n')) out += '\n';
    return { content: out, insertedAtLine: locateEntryHeaderLineInSurface(out, action.code, dateOrVersion) };
  }

  if (action.kind === 'replace') {
    const entry = action.entry;
    // Replace lines [entry.startLine, entry.endLine) with rendered.
    const startIdx = entry.startLine - 1;
    const endIdx = entry.endLine - 1;
    const before = lines.slice(0, startIdx).join('\n');
    const after = lines.slice(endIdx).join('\n');
    const beforeNorm = before.length ? before.replace(/\n*$/, '\n') : '';
    const afterNorm = after.length ? after.replace(/^\n*/, '') : '';
    let out = beforeNorm + rendered;
    if (afterNorm.length) {
      out = out.replace(/\n*$/, '\n');
      out += '\n' + afterNorm;
    }
    if (!out.endsWith('\n')) out += '\n';
    return { content: out, insertedAtLine: locateEntryHeaderLineInSurface(out, action.code, dateOrVersion) };
  }

  throw new Error(`changelog-writer: unknown action kind "${action.kind}"`);
}

function ensureBlankBefore(text, marker, exceptMarker) {
  // Walk lines and ensure there is a blank line between adjacent surface
  // headings. Specifically ensure that exceptMarker (the one we just wrote) is
  // separated from any subsequent line starting with marker.
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (lines[i] === exceptMarker) {
      // if next non-empty starts with marker without a blank, insert one.
      // Look ahead to find next non-empty line.
      let j = i + 1;
      while (j < lines.length && lines[j] === '') j++;
      // We've already pushed lines[i]. Now just ensure one blank exists if next non-empty line starts with marker.
      if (j < lines.length && lines[j].startsWith(marker) && j === i + 1) {
        out.push('');
      }
    }
  }
  return out.join('\n');
}

/**
 * Locate the entry header `### CODE — ` within a specific surface (matched by
 * `## label` heading). Scans only the section between `## label` and the next
 * `## ` heading or EOF, so duplicate codes across different surfaces don't
 * collide.
 */
function locateEntryHeaderLineInSurface(text, code, surfaceLabel) {
  const lines = text.split('\n');
  const surfaceLine = `## ${surfaceLabel}`;
  const codeRe = new RegExp(`^### ${escapeRegex(code)}\\s+—\\s+`);
  // Find the topmost matching surface heading; entries land in the first match.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== surfaceLine) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('## ')) break;
      if (codeRe.test(lines[j])) return j + 1;
    }
    // Topmost surface scanned; if not found here, the entry isn't in this
    // surface — search subsequent matching surfaces.
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k] !== surfaceLine) continue;
      for (let m = k + 1; m < lines.length; m++) {
        if (lines[m].startsWith('## ')) break;
        if (codeRe.test(lines[m])) return m + 1;
      }
    }
    break;
  }
  return -1;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.date_or_version
 * @param {string} args.code
 * @param {string} args.summary
 * @param {string} [args.body]
 * @param {object} [args.sections]
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 * @returns {Promise<{ inserted_at: number, idempotent: boolean, surface: string }>}
 */
export async function addChangelogEntry(cwd, args) {
  validateCode(args.code);
  validateDateOrVersion(args.date_or_version);
  validateSummary(args.summary);
  validateSections(args.sections);

  return maybeIdempotent({ ...args, cwd }, async () => {
    // Route through provider low-level primitives (getChangelog / putChangelog).
    // Do NOT call provider.appendChangelog — that's LocalFileProvider→addChangelogEntry = recursion.
    const provider = await getProvider(cwd);
    const text = await provider.getChangelog();

    const spliced = spliceChangelog(text, args);

    if (spliced.idempotent) {
      // Storage-level idempotent no-op: no file write, no audit event
      // (Decision 2 of design). Caller-supplied idempotency_key replays are
      // handled separately by the maybeIdempotent wrapper above.
      return {
        inserted_at: spliced.insertedAtLine,
        idempotent: true,
        surface: spliced.surface,
      };
    }

    await provider.putChangelog(spliced.content);

    const event = {
      tool: 'add_changelog_entry',
      code: args.code,
      surface_label: spliced.surface,
      surface_start_line: spliced.chosenSurfaceStartLine,
    };
    if (args.idempotency_key) event.idempotency_key = args.idempotency_key;
    if (spliced.action?.kind === 'replace') event.force = true;
    safeAppendEvent(cwd, event);

    return {
      inserted_at: spliced.insertedAtLine,
      idempotent: false,
      surface: spliced.surface,
    };
  });
}

// ---------------------------------------------------------------------------
// getChangelogEntries
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.since] — shorthand "24h"/"7d"/"30m" or ISO date.
 *   Date-only; version surfaces always pass through.
 * @param {string} [opts.code] — exact-match feature code.
 * @param {number} [opts.limit] — default 50, max 500.
 * @returns {{ entries: Array, count: number }}
 */
export function getChangelogEntries(cwd, opts = {}) {
  const text = readChangelogText(cwd);
  const parsed = parseChangelog(text);

  const sinceMs = opts.since !== undefined ? normalizeSince(opts.since) : null;
  const codeFilter = opts.code;
  const rawLimit = typeof opts.limit === 'number' ? opts.limit : DEFAULT_LIMIT;
  const limit = Math.max(0, Math.min(MAX_LIMIT, rawLimit));

  const out = [];
  outer: for (const s of parsed.surfaces) {
    if (sinceMs !== null && s.kind === 'date') {
      const surfaceMs = Date.parse(s.label);
      if (Number.isNaN(surfaceMs) || surfaceMs < sinceMs) continue;
    }
    // Version surfaces: always pass through when `since` is set.
    for (const e of s.entries) {
      if (codeFilter && e.code !== codeFilter) continue;
      out.push({
        date_or_version: s.label,
        code: e.code,
        summary: e.summary,
        body: e.body,
        sections: e.sections,
        unknownLabels: e.unknownLabels,
        line_number: e.startLine,
      });
      if (out.length >= limit) break outer;
    }
  }

  return { entries: out, count: out.length };
}
