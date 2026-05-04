/**
 * journal-writer.js — typed writer + reader for compose/docs/journal/.
 *
 * Sub-ticket #4 of COMP-MCP-FEATURE-MGMT (COMP-MCP-JOURNAL-WRITER).
 *
 * Five exports:
 *   writeJournalEntry(cwd, args)   — write/overwrite a session entry + index row
 *   getJournalEntries(cwd, opts)   — read, filter, sort, limit
 *   parseJournalEntry(text)        — parse a single entry file
 *   parseJournalIndex(text)        — parse docs/journal/README.md
 *   renderJournalEntry(args)       — render canonical Markdown from typed args
 *
 * No new dependencies. Hand-rolled frontmatter parser/encoder. Reuses
 * lib/idempotency.js (checkOrInsert, acquireLock), lib/feature-events.js
 * (appendEvent, normalizeSince). Advisory lock on journal-counter.lock.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, renameSync as _renameSync,
} from 'node:fs';

// Indirection layer so tests can monkeypatch individual fs operations
// without needing an external module loader.
export const _fsHooks = {
  renameSync: _renameSync,
};
import { join, dirname } from 'node:path';

import { appendEvent, normalizeSince } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';

// ---------------------------------------------------------------------------
// Constants & regexes
// ---------------------------------------------------------------------------

const JOURNAL_DIR     = 'docs/journal';
const INDEX_FILE      = 'README.md';
const ENTRIES_HEADING = '## Entries';

const TABLE_HEADER_RE = /^\|\s*Date\s*\|\s*Entry\s*\|\s*Summary\s*\|\s*$/;
const TABLE_SEP_RE    = /^\|[\s-]+\|[\s-]+\|[\s-]+\|\s*$/;
const ROW_RE          = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\[Session\s+(\d+):\s*(.+?)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*$/;
const FILENAME_RE     = /^(\d{4}-\d{2}-\d{2})-session-(\d+)-([a-z0-9][a-z0-9-]*[a-z0-9])\.md$/;
const SLUG_RE         = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;
import { FEATURE_CODE_RE_STRICT as FEATURE_CODE_RE } from './feature-code.js';

const REQUIRED_SECTIONS = ['what_happened', 'what_we_built', 'what_we_learned', 'open_threads'];
const SECTION_HEADINGS  = {
  what_happened:   '## What happened',
  what_we_built:   '## What we built',
  what_we_learned: '## What we learned',
  open_threads:    '## Open threads',
};

// Reverse map: heading text -> section key (case- and whitespace-insensitive).
// Keys are normalized: lowercased and internal whitespace runs collapsed.
const HEADING_TO_KEY = {};
for (const [k, v] of Object.entries(SECTION_HEADINGS)) {
  HEADING_TO_KEY[v.toLowerCase().replace(/\s+/g, ' ')] = k;
}

/** Normalize a heading string for canonical lookup. */
function normalizeHeading(h) {
  return h.toLowerCase().replace(/\s+/g, ' ');
}

const FRONTMATTER_RE   = /^---\n([\s\S]*?)\n---\n/;
const TITLE_RE         = /^# Session (\d+) — (.+?)\s*$/;
const HR_RE            = /^---\s*$/;
const ITALIC_LINE_RE   = /^\*([^*].+[^*])\*\s*$|^\*([^*])\*\s*$/;
const FRONTMATTER_KEYS = ['date', 'session_number', 'slug', 'summary', 'feature_code', 'closing_line'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 500;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function inputError(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

function formatError(message) {
  const err = new Error(message);
  err.code = 'JOURNAL_FORMAT';
  return err;
}

function indexFormatError(message) {
  const err = new Error(message);
  err.code = 'JOURNAL_INDEX_FORMAT';
  return err;
}

// ---------------------------------------------------------------------------
// Frontmatter parser & encoder
// ---------------------------------------------------------------------------

/**
 * Parse a one-level "YAML-ish" frontmatter block (key: value, no nesting).
 * Returns an object with string values except session_number which is coerced
 * to int. Throws JOURNAL_FORMAT on missing closing ---.
 */
function parseFrontmatter(raw) {
  const result = {};
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    // Unescape double-quoted values.
    // Decode \\ FIRST (using a placeholder) so that a literal \n sequence
    // (encoded as \\n) is not incorrectly converted to a real newline.
    if (value.startsWith('"') && value.endsWith('"')) {
      const BACKSLASH_PLACEHOLDER = '\x00BS\x00';
      value = value.slice(1, -1)
        .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(new RegExp(BACKSLASH_PLACEHOLDER, 'g'), '\\');
    }

    if (key === 'session_number') {
      const n = parseInt(value, 10);
      result[key] = Number.isNaN(n) ? value : n;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Encode a value for frontmatter. Bare for simple strings, double-quoted
 * with escaping otherwise.
 */
function encodeFrontmatterValue(value) {
  if (typeof value === 'number') return String(value);
  const s = String(value);
  const needsQuotes = s.includes('\n') ||
    s.includes('"') ||
    /^[\[{!&*#]/.test(s) ||
    s.startsWith(' ') ||
    s.endsWith(' ') ||
    s.includes(':');
  if (!needsQuotes) return s;
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// parseJournalEntry
// ---------------------------------------------------------------------------

/**
 * Parse a journal entry markdown file.
 *
 * Returns:
 *   {
 *     frontmatter: object,
 *     title: string | null,
 *     date: string | null,
 *     feature_code: string | null,
 *     sections: { what_happened, what_we_built, what_we_learned, open_threads },
 *     unknownSections: [{ heading, body, startLine }],
 *     closing_line: string | null,
 *     startLines: { what_happened?, what_we_built?, what_we_learned?, open_threads? }
 *   }
 */
export function parseJournalEntry(text) {
  let frontmatter = {};
  let body = text;

  // 1. Strip and parse frontmatter.
  const fmMatch = text.match(FRONTMATTER_RE);
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1]);
    body = text.slice(fmMatch[0].length);
  }

  const lines = body.split('\n');

  // 2. Find H1 title.
  let title = null;
  let titleSessionNumber = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TITLE_RE);
    if (m) {
      titleSessionNumber = parseInt(m[1], 10);
      title = m[2].trim();
      break;
    }
  }

  // session_number: frontmatter takes precedence over H1.
  const sessionNumber = (frontmatter.session_number !== undefined)
    ? frontmatter.session_number
    : titleSessionNumber;

  // date and feature_code from frontmatter.
  const date = frontmatter.date || null;
  const feature_code = frontmatter.feature_code || null;
  const slug = frontmatter.slug || null;

  // 3. Walk lines after H1 to collect sections.
  const sections = {
    what_happened: '',
    what_we_built: '',
    what_we_learned: '',
    open_threads: '',
  };
  const unknownSections = [];
  const startLines = {};

  let currentKey = null;       // canonical key or null
  let currentUnknown = null;   // { heading, startLine }
  let currentBuf = [];

  // fmOffset: the frontmatter consumed some lines from the original text.
  // For startLine reporting, we report line numbers within the body (post-fm).
  // We use 1-based within-body line numbers.

  function flushCurrent(endIdx) {
    const body_ = trimEdges(currentBuf.join('\n'));
    if (currentKey !== null) {
      sections[currentKey] = body_;
    } else if (currentUnknown !== null) {
      unknownSections.push({
        heading: currentUnknown.heading,
        body: body_,
        startLine: currentUnknown.startLine,
      });
    }
    currentKey = null;
    currentUnknown = null;
    currentBuf = [];
  }

  let pastH1 = false;
  let hrIndex = -1;  // index (0-based) of HR found after last section

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;  // 1-based

    // Wait until we pass the H1.
    if (!pastH1) {
      if (TITLE_RE.test(line)) pastH1 = true;
      continue;
    }

    // Check for an H2 heading.
    if (line.startsWith('## ')) {
      flushCurrent(lineNum);
      const headingText = line.trim();
      const key = HEADING_TO_KEY[normalizeHeading(headingText)];
      if (key) {
        currentKey = key;
        startLines[key] = lineNum;
      } else {
        const heading = headingText.slice(3).trim();
        currentUnknown = { heading, startLine: lineNum };
      }
      continue;
    }

    // Check for HR (only relevant if we're in a section).
    if (HR_RE.test(line) && (currentKey !== null || currentUnknown !== null)) {
      // HR is the delimiter between Open threads and closing line.
      // Stop accreting into current section.
      flushCurrent(lineNum);
      hrIndex = i;
      break;
    }

    // Accrete into current buffer.
    if (currentKey !== null || currentUnknown !== null) {
      currentBuf.push(line);
    }
  }

  // Flush anything remaining if no HR was found.
  if (currentKey !== null || currentUnknown !== null) {
    flushCurrent(lines.length + 1);
  }

  // 4. Determine closing_line.
  // Priority: frontmatter > body parse > null.
  let closing_line = frontmatter.closing_line || null;

  if (closing_line === null && hrIndex !== -1) {
    // Find the next non-blank line after the HR.
    for (let i = hrIndex + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      const candidate = lines[i].trim();
      // Match *text* (italic) pattern.
      const italicMatch = candidate.match(ITALIC_LINE_RE);
      if (italicMatch) {
        closing_line = (italicMatch[1] !== undefined ? italicMatch[1] : italicMatch[2]);
      } else {
        closing_line = candidate;
      }
      break;
    }
  }

  return {
    frontmatter,
    title,
    date,
    feature_code,
    slug,
    session_number: sessionNumber,
    sections,
    unknownSections,
    closing_line,
    startLines,
  };
}

function trimEdges(s) {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// parseJournalIndex
// ---------------------------------------------------------------------------

/**
 * Parse compose/docs/journal/README.md.
 *
 * Returns:
 *   { preamble, table_header_line, separator_line, rows, postamble }
 *
 * Throws JOURNAL_INDEX_FORMAT if the file is missing the ## Entries heading,
 * malformed table header, or missing separator.
 *
 * rows: Array of { date, session_number, slug, link_path, summary, line }
 *   or opaque { raw, line, slug: null, session_number: null } for unmatched rows.
 */
export function parseJournalIndex(text) {
  const lines = text.split('\n');

  // 1. Find ## Entries heading.
  const entriesIdx = lines.findIndex(l => l.trim() === ENTRIES_HEADING);
  if (entriesIdx === -1) {
    throw indexFormatError(`journal index missing "${ENTRIES_HEADING}" heading`);
  }

  const preambleLines = lines.slice(0, entriesIdx);

  // 2. Find table header — first non-blank line after ## Entries.
  let headerIdx = -1;
  for (let i = entriesIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (!TABLE_HEADER_RE.test(lines[i])) {
      throw indexFormatError(
        `journal index: expected table header "| Date | Entry | Summary |" at line ${i + 1}, got: ${lines[i]}`
      );
    }
    headerIdx = i;
    break;
  }
  if (headerIdx === -1) {
    throw indexFormatError('journal index: table header not found after ## Entries');
  }

  // 3. Next line must be separator.
  const sepIdx = headerIdx + 1;
  if (sepIdx >= lines.length || !TABLE_SEP_RE.test(lines[sepIdx])) {
    throw indexFormatError(
      `journal index: expected table separator at line ${sepIdx + 1}, got: ${lines[sepIdx] ?? '<EOF>'}`
    );
  }

  // 4. Parse rows.
  const rows = [];
  let tableEndIdx = sepIdx + 1;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      // Blank line ends the table.
      tableEndIdx = i;
      break;
    }
    if (!line.startsWith('|')) {
      // Non-table line ends the table.
      tableEndIdx = i;
      break;
    }
    const m = line.match(ROW_RE);
    if (m) {
      rows.push({
        date: m[1],
        session_number: parseInt(m[2], 10),
        summary_link_text: m[3].trim(),
        link_path: m[4].trim(),
        summary: m[5].trim(),
        line: i + 1,  // 1-based
        slug: extractSlugFromPath(m[4].trim()),
        raw: line,
      });
    } else {
      // Opaque row.
      rows.push({ raw: line, line: i + 1, slug: null, session_number: null });
    }
    tableEndIdx = i + 1;
  }

  const postambleLines = lines.slice(tableEndIdx);

  return {
    preamble: preambleLines.join('\n'),
    table_header_line: headerIdx + 1,   // 1-based
    separator_line: sepIdx + 1,          // 1-based
    rows,
    postamble: postambleLines.join('\n'),
  };
}

function extractSlugFromPath(linkPath) {
  const base = linkPath.split('/').pop() || '';
  const m = base.match(FILENAME_RE);
  return m ? m[3] : null;
}

// ---------------------------------------------------------------------------
// renderJournalEntry
// ---------------------------------------------------------------------------

/**
 * Render a canonical journal entry file.
 *
 * Args:
 *   date, slug, session_number, sections (all 4 keys),
 *   summary_for_index, feature_code?, closing_line?
 *
 * Returns a string ending with \n.
 */
export function renderJournalEntry({
  date,
  slug,
  session_number,
  sections,
  summary_for_index,
  feature_code,
  closing_line,
}) {
  // Build frontmatter.
  const fmLines = ['---'];
  fmLines.push(`date: ${encodeFrontmatterValue(date)}`);
  fmLines.push(`session_number: ${session_number}`);
  fmLines.push(`slug: ${encodeFrontmatterValue(slug)}`);
  fmLines.push(`summary: ${encodeFrontmatterValue(summary_for_index)}`);
  if (feature_code) fmLines.push(`feature_code: ${encodeFrontmatterValue(feature_code)}`);
  if (closing_line) fmLines.push(`closing_line: ${encodeFrontmatterValue(closing_line)}`);
  fmLines.push('---');

  // Derive title.
  let title;
  if (feature_code) {
    title = feature_code;
  } else if (summary_for_index) {
    // Up to first colon, or 80 chars, whichever is shorter.
    const colonIdx = summary_for_index.indexOf(':');
    const truncated = colonIdx !== -1 ? summary_for_index.slice(0, colonIdx) : summary_for_index;
    title = truncated.length > 80 ? truncated.slice(0, 80) : truncated;
  } else {
    title = slug;
  }

  const blocks = [];
  blocks.push(fmLines.join('\n'));
  blocks.push(`# Session ${session_number} — ${title}`);

  // Header metadata block.
  const metaLines = [`**Date:** ${date}`];
  if (feature_code) metaLines.push(`**Feature:** \`${feature_code}\``);
  blocks.push(metaLines.join('\n'));

  // Four canonical sections.
  for (const key of REQUIRED_SECTIONS) {
    blocks.push(`${SECTION_HEADINGS[key]}\n\n${sections[key]}`);
  }

  // Closing line block.
  if (closing_line) {
    blocks.push(`---\n\n*${closing_line}*`);
  }

  return blocks.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

function atomicWrite(targetPath, content) {
  const tmp = targetPath + '.tmp';
  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    writeFileSync(tmp, content, 'utf-8');
    _fsHooks.renameSync(tmp, targetPath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function safeAppendEvent(cwd, event) {
  try {
    appendEvent(cwd, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[journal-writer] audit append failed for ${event.tool}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Idempotent wrapper (mirrors changelog-writer.js)
// ---------------------------------------------------------------------------

function maybeIdempotent(args, fn) {
  if (args.idempotency_key) {
    return checkOrInsert(args.cwd, args.idempotency_key, fn).then(({ result }) => result);
  }
  return Promise.resolve().then(fn);
}

// ---------------------------------------------------------------------------
// Advisory lock for journal counter
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS   = 25;

function journalLockPath(cwd) {
  return join(cwd, '.compose', 'data', 'journal-counter.lock');
}

async function acquireJournalLock(cwd) {
  const { rmSync, statSync } = await import('node:fs');
  const path = journalLockPath(cwd);
  mkdirSync(dirname(path), { recursive: true });

  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(path);
      return () => {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale lock recovery.
      try {
        const { mtimeMs } = statSync(path);
        if (Date.now() - mtimeMs > LOCK_TIMEOUT_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch { /* stat raced; loop and retry */ }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`journal-writer lock timeout after ${LOCK_TIMEOUT_MS}ms: ${path}`);
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateArgs(args) {
  if (typeof args.date !== 'string' || !DATE_RE.test(args.date)) {
    throw inputError(`journal-writer: invalid date "${args.date}" — must match YYYY-MM-DD`);
  }
  if (typeof args.slug !== 'string' || !SLUG_RE.test(args.slug)) {
    throw inputError(`journal-writer: invalid slug "${args.slug}" — must match /^[a-z0-9][a-z0-9-]*[a-z0-9]$/`);
  }
  if (!args.sections || typeof args.sections !== 'object') {
    throw inputError('journal-writer: sections is required');
  }
  for (const key of REQUIRED_SECTIONS) {
    if (typeof args.sections[key] !== 'string' || args.sections[key].trim().length === 0) {
      throw inputError(`journal-writer: sections.${key} is required and must be a non-empty string`);
    }
  }
  if (typeof args.summary_for_index !== 'string' || args.summary_for_index.trim().length === 0) {
    throw inputError('journal-writer: summary_for_index is required and must be non-empty');
  }
  if (args.summary_for_index.includes('\n')) {
    throw inputError('journal-writer: summary_for_index must not contain newlines');
  }
  if (args.summary_for_index.includes('|')) {
    throw inputError('journal-writer: summary_for_index must not contain "|"');
  }
  if (args.feature_code !== undefined && args.feature_code !== null) {
    if (typeof args.feature_code !== 'string' || !FEATURE_CODE_RE.test(args.feature_code)) {
      throw inputError(`journal-writer: invalid feature_code "${args.feature_code}"`);
    }
  }
  if (args.closing_line !== undefined && args.closing_line !== null) {
    if (typeof args.closing_line !== 'string' || args.closing_line.trim().length === 0) {
      throw inputError('journal-writer: closing_line must be a non-empty string when provided');
    }
    if (args.closing_line.includes('\n')) {
      throw inputError('journal-writer: closing_line must not contain newlines');
    }
  }
}

// ---------------------------------------------------------------------------
// writeJournalEntry
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.date
 * @param {string} args.slug
 * @param {object} args.sections — all four keys, each non-empty string
 * @param {string} args.summary_for_index
 * @param {string} [args.feature_code]
 * @param {string} [args.closing_line]
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 * @returns {Promise<{ path: string, session_number: number, index_line: number, idempotent: boolean }>}
 */
export async function writeJournalEntry(cwd, args) {
  validateArgs(args);

  return maybeIdempotent({ ...args, cwd }, async () => {
    const journalDir = join(cwd, JOURNAL_DIR);
    const indexPath  = join(journalDir, INDEX_FILE);

    // Pre-flight: read + parse index before any disk mutation.
    if (!existsSync(indexPath)) {
      throw indexFormatError(`journal-writer: index file not found at ${indexPath}`);
    }
    const indexText = readFileSync(indexPath, 'utf-8');
    let parsed;
    try {
      parsed = parseJournalIndex(indexText);
    } catch (err) {
      // Re-throw with JOURNAL_INDEX_FORMAT so callers see the right code.
      if (err.code === 'JOURNAL_INDEX_FORMAT') throw err;
      throw indexFormatError(`journal-writer: index parse failed: ${err.message}`);
    }

    // Acquire advisory lock.
    const releaseLock = await acquireJournalLock(cwd);

    try {
      // List existing entries.
      mkdirSync(journalDir, { recursive: true });
      const dirEntries = readdirSync(journalDir);
      const existing = [];
      for (const name of dirEntries) {
        const m = name.match(FILENAME_RE);
        if (!m) continue;
        existing.push({
          date: m[1],
          session_number: parseInt(m[2], 10),
          slug: m[3],
          filename: name,
          path: join(journalDir, name),
        });
      }

      // Storage-level dedup.
      const dup = existing.find(e => e.date === args.date && e.slug === args.slug);

      if (dup && !args.force) {
        // Idempotent no-op: re-read the index INSIDE the lock so that
        // index_line reflects any rows inserted by concurrent writers
        // between the pre-flight parse and now.
        const dupFilename = dup.filename;
        const lockedIndexText = readFileSync(indexPath, 'utf-8');
        const lockedParsed = parseJournalIndex(lockedIndexText);
        const idxRow = lockedParsed.rows.find(r => r.link_path === dupFilename);
        const index_line = idxRow ? idxRow.line : -1;
        return {
          path: dup.path,
          session_number: dup.session_number,
          index_line,
          idempotent: true,
        };
      }

      let session_number;
      let action;  // 'insert' | 'overwrite'

      if (dup && args.force) {
        session_number = dup.session_number;
        action = 'overwrite';
      } else {
        // Compute next global session number.
        const maxSession = existing.length > 0
          ? Math.max(...existing.map(e => e.session_number))
          : -1;
        session_number = maxSession + 1;
        action = 'insert';
      }

      const filename = `${args.date}-session-${session_number}-${args.slug}.md`;
      const entryPath = join(journalDir, filename);

      // Render entry.
      const entryContent = renderJournalEntry({
        date: args.date,
        slug: args.slug,
        session_number,
        sections: args.sections,
        summary_for_index: args.summary_for_index,
        feature_code: args.feature_code,
        closing_line: args.closing_line,
      });

      // Build new index row.
      const rowSummaryLinkText = `Session ${session_number}: ${args.summary_for_index}`;
      const newRow = `| ${args.date} | [${rowSummaryLinkText}](${filename}) | ${args.summary_for_index} |`;

      // Re-read index (may have changed while we were computing).
      const freshIndexText = readFileSync(indexPath, 'utf-8');
      const freshParsed = parseJournalIndex(freshIndexText);

      let newIndexText;
      let index_line;

      if (action === 'overwrite') {
        // Replace the row in place.
        const lines = freshIndexText.split('\n');
        const existingRowIdx = freshParsed.rows.findIndex(r => r.link_path === filename);
        if (existingRowIdx !== -1) {
          const rowLine = freshParsed.rows[existingRowIdx].line;  // 1-based
          lines[rowLine - 1] = newRow;
          newIndexText = lines.join('\n');
          index_line = rowLine;
        } else {
          // Row not found in index — insert at top.
          const insertAt = freshParsed.separator_line;  // 1-based
          const linesArr = freshIndexText.split('\n');
          linesArr.splice(insertAt, 0, newRow);  // after separator
          newIndexText = linesArr.join('\n');
          index_line = insertAt + 1;  // 1-based line of new row
        }
      } else {
        // Insert immediately after separator line.
        const linesArr = freshIndexText.split('\n');
        const insertAt = freshParsed.separator_line;  // 1-based index of separator
        linesArr.splice(insertAt, 0, newRow);  // splice at position = separator_line (0-based = separator_line-1+1 = separator_line)
        newIndexText = linesArr.join('\n');
        index_line = insertAt + 1;  // 1-based
      }

      // Atomic writes with compensating-action rollback.
      //
      // New-entry path: write entry first, then index.  If index write fails,
      // delete the entry file so the journal stays consistent.
      //
      // Force-overwrite path: read the current entry content first (for
      // rollback), then write the new entry, then the index.  If index write
      // fails, restore the original entry content.
      if (action === 'insert') {
        atomicWrite(entryPath, entryContent);
        try {
          atomicWrite(indexPath, newIndexText);
        } catch (indexErr) {
          // Compensate: remove the entry file we just wrote.
          let unlinkMsg = '';
          try {
            unlinkSync(entryPath);
          } catch (unlinkErr) {
            unlinkMsg = `; additionally, rollback unlink of ${entryPath} failed: ${unlinkErr.message}`;
          }
          const err = new Error(
            `JOURNAL_PARTIAL_WRITE: index write failed after writing entry ${entryPath}${unlinkMsg}`,
          );
          err.code = 'JOURNAL_PARTIAL_WRITE';
          err.cause = indexErr;
          throw err;
        }
      } else {
        // overwrite: capture prior content for rollback.
        const priorContent = existsSync(entryPath) ? readFileSync(entryPath, 'utf-8') : null;
        atomicWrite(entryPath, entryContent);
        try {
          atomicWrite(indexPath, newIndexText);
        } catch (indexErr) {
          // Compensate: restore the original entry content.
          let restoreMsg = '';
          if (priorContent !== null) {
            try {
              atomicWrite(entryPath, priorContent);
            } catch (restoreErr) {
              restoreMsg = `; additionally, restore of ${entryPath} failed: ${restoreErr.message}`;
            }
          }
          const err = new Error(
            `JOURNAL_PARTIAL_WRITE: index write failed after overwriting entry ${entryPath}${restoreMsg}`,
          );
          err.code = 'JOURNAL_PARTIAL_WRITE';
          err.cause = indexErr;
          throw err;
        }
      }

      // Audit event.
      const event = {
        tool: 'write_journal_entry',
        date: args.date,
        slug: args.slug,
        session_number,
      };
      if (args.feature_code) event.feature_code = args.feature_code;
      if (args.force)         event.force = true;
      if (args.idempotency_key) event.idempotency_key = args.idempotency_key;
      safeAppendEvent(cwd, event);

      return { path: entryPath, session_number, index_line, idempotent: false };
    } finally {
      releaseLock();
    }
  });
}

// ---------------------------------------------------------------------------
// getJournalEntries
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.since]
 * @param {string} [opts.feature_code]
 * @param {number} [opts.session]
 * @param {number} [opts.limit]
 * @returns {{ entries: Array, count: number }}
 */
export function getJournalEntries(cwd, opts = {}) {
  const journalDir = join(cwd, JOURNAL_DIR);
  if (!existsSync(journalDir)) return { entries: [], count: 0 };

  const sinceMs = opts.since !== undefined ? normalizeSince(opts.since) : null;
  const featureFilter = opts.feature_code || null;
  const sessionFilter = opts.session !== undefined ? opts.session : null;
  const rawLimit = typeof opts.limit === 'number' ? opts.limit : DEFAULT_LIMIT;
  const limit = Math.max(0, Math.min(MAX_LIMIT, rawLimit));

  const dirEntries = readdirSync(journalDir);
  const matched = [];

  for (const name of dirEntries) {
    const m = name.match(FILENAME_RE);
    if (!m) continue;

    const entryDate = m[1];
    const entrySession = parseInt(m[2], 10);
    const entrySlug = m[3];
    const entryPath = join(journalDir, name);

    // Apply since filter early (using filename date).
    if (sinceMs !== null) {
      const entryMs = Date.parse(entryDate);
      if (Number.isNaN(entryMs) || entryMs < sinceMs) continue;
    }

    // Apply session filter early.
    if (sessionFilter !== null && entrySession !== sessionFilter) continue;

    // Read and parse.
    let parsed;
    try {
      const text = readFileSync(entryPath, 'utf-8');
      parsed = parseJournalEntry(text);
    } catch {
      continue;
    }

    // Apply feature_code filter.
    if (featureFilter !== null && parsed.feature_code !== featureFilter) continue;

    matched.push({
      date: entryDate,
      session_number: entrySession,
      slug: entrySlug,
      path: entryPath,
      summary: parsed.frontmatter.summary || null,
      feature_code: parsed.feature_code,
      sections: {
        what_happened:   parsed.sections.what_happened,
        what_we_built:   parsed.sections.what_we_built,
        what_we_learned: parsed.sections.what_we_learned,
        open_threads:    parsed.sections.open_threads,
      },
      unknownSections: parsed.unknownSections,
      closing_line: parsed.closing_line,
    });
  }

  // Sort newest-first: date desc, session_number desc.
  matched.sort((a, b) => {
    if (b.date !== a.date) return b.date.localeCompare(a.date);
    return b.session_number - a.session_number;
  });

  const entries = matched.slice(0, limit);
  return { entries, count: entries.length };
}
