// lib/boundary-map.js
//
// parseBoundaryMap(blueprintText) -> { slices: Slice[], parseViolations: Violation[] }
// validateBoundaryMap({ blueprintText, blueprintPath, repoRoot }) ->
//   { ok: bool, violations: Violation[], warnings: Warning[] }
//
// See docs/features/COMP-GSD-1/{design.md, blueprint.md}.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KIND_ALLOWLIST = new Set([
  'interface',
  'type',
  'function',
  'class',
  'const',
  'hook',
  'component',
]);

const WRITE_ACTIONS = new Set([
  'new',
  'create',
  'add',
  'edit',
  'modify',
  'update',
  'refactor',
  'replace',
]);

const FILE_PLAN_ALIASES = ['## File Plan', '## Files', '## File-by-File Plan'];

const PRODUCES_RE =
  /^\s+(\S+)\s*(?:→|->)\s*([^()]+?)\s*\((interface|type|function|class|const|hook|component)\)\s*$/;
const PRODUCES_NO_KIND_RE = /^\s+(\S+)\s*(?:→|->)\s*([^()\s][^()]*?)\s*$/;
const CONSUMES_RE =
  /^\s+from\s+(S\d{2,})\s*:\s*(\S+)\s*(?:→|->)\s*([^()]+?)(?:\s*\([^)]*\))?\s*$/;

export function parseBoundaryMap(blueprintText) {
  const lines = blueprintText.split(/\r?\n/);
  // Locate ## Boundary Map
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Boundary Map\s*$/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return { slices: [], parseViolations: [] };

  // End at next ## heading or EOF
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }

  const slices = [];
  const parseViolations = [];
  const seenIds = new Map(); // id -> first slice index

  let cur = null;
  let block = null; // 'produces' | 'consumes' | null
  let nothingSentinel = null; // 'produces' | 'consumes' | null — set after a `nothing` literal until cleared

  function pushViolation(v) {
    parseViolations.push(v);
  }

  for (let i = start; i < end; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Slice heading
    const sliceM = line.match(/^### (S\d{2,})(?::\s*(.*))?\s*$/);
    if (sliceM) {
      const id = sliceM[1];
      const name = sliceM[2] || undefined;
      if (seenIds.has(id)) {
        pushViolation({
          kind: 'duplicate_slice_id',
          scope: 'parse',
          slice: id,
          message: `Duplicate slice id ${id} at line ${lineNo}; first occurrence wins`,
        });
        // Still create a "shadow" slice so we keep parsing for further error reporting,
        // but mark it as duplicate so downstream checks can ignore it.
        cur = { id, name, produces: [], consumes: [], leaf: false, sink: false, line: lineNo, _duplicate: true };
        slices.push(cur);
      } else {
        cur = { id, name, produces: [], consumes: [], leaf: false, sink: false, line: lineNo };
        slices.push(cur);
        seenIds.set(id, slices.length - 1);
      }
      block = null;
      nothingSentinel = null;
      continue;
    }

    // Block headers
    const prodHdr = line.match(/^Produces:\s*(nothing\b.*)?\s*$/);
    if (prodHdr && cur) {
      block = 'produces';
      nothingSentinel = null;
      if (prodHdr[1]) {
        cur.sink = true;
        block = null; // no entries expected
        nothingSentinel = 'produces';
      }
      continue;
    }
    const consHdr = line.match(/^Consumes:\s*(nothing\b.*)?\s*$/);
    if (consHdr && cur) {
      block = 'consumes';
      nothingSentinel = null;
      if (consHdr[1]) {
        cur.leaf = true;
        block = null;
        nothingSentinel = 'consumes';
      }
      continue;
    }

    // Blank line clears nothing; entries are indented under the block
    if (/^\s*$/.test(line)) continue;

    // Entries
    if (block === 'produces' && cur) {
      const m = line.match(PRODUCES_RE);
      if (m) {
        const [, file, symbolStr, kind] = m;
        const symbols = symbolStr.split(',').map((s) => s.trim()).filter(Boolean);
        if (symbols.length === 0) {
          pushViolation({
            kind: 'malformed_entry',
            scope: 'parse',
            slice: cur.id,
            message: `Empty symbol list at line ${lineNo}`,
          });
          continue;
        }
        cur.produces.push({ file, symbols, kind, line: lineNo });
        continue;
      }
      // Try no-kind regex
      if (PRODUCES_NO_KIND_RE.test(line)) {
        pushViolation({
          kind: 'missing_kind',
          scope: 'parse',
          slice: cur.id,
          message: `Produces entry at line ${lineNo} missing required (<kind>) parenthetical`,
        });
        continue;
      }
      pushViolation({
        kind: 'malformed_produces',
        scope: 'parse',
        slice: cur.id,
        message: `Malformed Produces entry at line ${lineNo}: ${line}`,
      });
      continue;
    }

    if (block === 'consumes' && cur) {
      const m = line.match(CONSUMES_RE);
      if (m) {
        const [, from, file, symbolStr] = m;
        const symbols = symbolStr.split(',').map((s) => s.trim()).filter(Boolean);
        if (symbols.length === 0) {
          pushViolation({
            kind: 'malformed_entry',
            scope: 'parse',
            slice: cur.id,
            message: `Empty consume symbol list at line ${lineNo}`,
          });
          continue;
        }
        cur.consumes.push({ from, file, symbols, line: lineNo });
        continue;
      }
      pushViolation({
        kind: 'malformed_consumes',
        scope: 'parse',
        slice: cur.id,
        message: `Malformed Consumes entry at line ${lineNo}: ${line}`,
      });
      continue;
    }

    // Non-blank line outside any block.
    // After a `nothing` sentinel, an indented entry-shaped line is a parse error
    // (the only valid zero-entry forms are the sentinels themselves).
    if (nothingSentinel && cur && /^\s+\S/.test(line)) {
      const looksLikeEntry =
        PRODUCES_RE.test(line) ||
        PRODUCES_NO_KIND_RE.test(line) ||
        CONSUMES_RE.test(line) ||
        /^\s+from\s+S\d{2,}\s*:/.test(line) ||
        /(?:→|->)/.test(line);
      if (looksLikeEntry) {
        pushViolation({
          kind: 'malformed_after_nothing',
          scope: 'parse',
          slice: cur.id,
          message: `Slice ${cur.id} has an entry-shaped line at line ${lineNo} after a "${nothingSentinel}: nothing" sentinel; "nothing" forbids further entries`,
        });
      }
    }
    // Otherwise ignore (could be prose between slices).
  }

  return { slices, parseViolations };
}

// ---------- File Plan parsing ----------

function parseFilePlan(blueprintText) {
  const lines = blueprintText.split(/\r?\n/);
  let aliasIdx = -1;
  let aliasUsed = null;
  for (let i = 0; i < lines.length; i++) {
    for (const alias of FILE_PLAN_ALIASES) {
      if (lines[i].trim() === alias) {
        aliasIdx = i;
        aliasUsed = alias;
        break;
      }
    }
    if (aliasIdx !== -1) break;
  }
  if (aliasIdx === -1) return { found: false, entries: [] };

  // Walk until next ## heading or EOF
  let end = lines.length;
  for (let i = aliasIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }

  const entries = [];
  for (let i = aliasIdx + 1; i < end; i++) {
    const line = lines[i];
    // Markdown table row: starts with | and has at least 2 pipes; skip header & sep
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    // Skip header row "File | Action | ..."
    if (/^file$/i.test(cells[0]) && /^action$/i.test(cells[1])) continue;
    // Skip separator row "---|---|..."
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const fileRaw = cells[0];
    const actionRaw = cells[1];
    const file = fileRaw.replace(/`/g, '').trim();
    if (!file) continue;
    entries.push({ file, action: actionRaw, line: i + 1 });
  }
  return { found: true, alias: aliasUsed, entries };
}

function normalizeAction(actionRaw) {
  const trimmed = actionRaw.trim();
  if (!trimmed) return '';
  const firstTok = trimmed.split(/\s+/)[0];
  return firstTok.toLowerCase().replace(/[.,;:]+$/, '');
}

// ---------- Validator ----------

export function validateBoundaryMap({ blueprintText, blueprintPath, repoRoot }) {
  const violations = [];
  const warnings = [];

  const { slices, parseViolations } = parseBoundaryMap(blueprintText);
  for (const v of parseViolations) violations.push(v);

  if (slices.length === 0 && parseViolations.length === 0) {
    return { ok: true, violations: [], warnings: [] };
  }

  // Filter out duplicate-shadow slices for downstream checks
  const liveSlices = slices.filter((s) => !s._duplicate);

  // Build File Plan index — a file may appear in multiple rows; isPlannedWrite
  // is true if ANY row has an allow-listed write action.
  const filePlan = parseFilePlan(blueprintText);
  const filePlanIndex = new Map(); // file -> { rows: [{action, normalized}], isPlannedWrite: bool }
  const unknownActionWarned = new Set();

  if (!filePlan.found) {
    warnings.push({
      kind: 'no_file_plan',
      scope: 'blueprint',
      message: 'Blueprint has no recognized File Plan heading',
    });
  } else {
    for (let rowIdx = 0; rowIdx < filePlan.entries.length; rowIdx++) {
      const row = filePlan.entries[rowIdx];
      const norm = normalizeAction(row.action);
      const isWrite = WRITE_ACTIONS.has(norm);
      let entry = filePlanIndex.get(row.file);
      if (!entry) {
        entry = { rows: [], isPlannedWrite: false };
        filePlanIndex.set(row.file, entry);
      }
      entry.rows.push({ action: row.action, normalized: norm });
      if (isWrite) entry.isPlannedWrite = true;
      const dedupKey = `${rowIdx} ${row.file} ${norm}`;
      if (!isWrite && !unknownActionWarned.has(dedupKey)) {
        unknownActionWarned.add(dedupKey);
        warnings.push({
          kind: 'unknown_action',
          scope: 'file-plan',
          file: row.file,
          message: `File Plan action "${row.action}" for ${row.file} is not in the recognized write-action allow-list`,
        });
      }
    }
  }

  function isPlannedWrite(file) {
    const e = filePlanIndex.get(file);
    return !!(e && e.isPlannedWrite);
  }

  function fileExists(file) {
    if (!repoRoot) return false;
    try {
      return existsSync(join(repoRoot, file));
    } catch {
      return false;
    }
  }

  // 1. File-Plan-or-disk check — emit one violation per (slice, file, symbol)
  for (const slice of liveSlices) {
    const entries = [
      ...slice.produces.map((p) => ({ file: p.file, symbols: p.symbols })),
      ...slice.consumes.map((c) => ({ file: c.file, symbols: c.symbols })),
    ];
    for (const entry of entries) {
      if (isPlannedWrite(entry.file)) continue;
      if (fileExists(entry.file)) continue;
      for (const sym of entry.symbols) {
        violations.push({
          kind: 'missing_file',
          scope: 'entry',
          slice: slice.id,
          file: entry.file,
          symbol: sym,
          message: `File ${entry.file} referenced in slice ${slice.id} (symbol ${sym}) is not in File Plan and does not exist on disk`,
        });
      }
    }
  }

  // 2. Symbol presence check
  for (const slice of liveSlices) {
    const entries = [
      ...slice.produces.map((p) => ({ file: p.file, symbols: p.symbols })),
      ...slice.consumes.map((c) => ({ file: c.file, symbols: c.symbols })),
    ];
    for (const entry of entries) {
      if (isPlannedWrite(entry.file)) continue;
      if (!fileExists(entry.file)) continue; // covered by missing_file or no repoRoot
      let content;
      try {
        content = readFileSync(join(repoRoot, entry.file), 'utf8');
      } catch {
        continue;
      }
      for (const sym of entry.symbols) {
        if (!content.includes(sym)) {
          violations.push({
            kind: 'missing_symbol',
            scope: 'entry',
            slice: slice.id,
            file: entry.file,
            symbol: sym,
            message: `Symbol ${sym} not found in ${entry.file} (slice ${slice.id})`,
          });
        }
      }
    }
  }

  // 3. Topology check
  const sliceOrder = new Map();
  liveSlices.forEach((s, i) => sliceOrder.set(s.id, i));
  for (let i = 0; i < liveSlices.length; i++) {
    const slice = liveSlices[i];
    for (const c of slice.consumes) {
      if (!sliceOrder.has(c.from)) {
        for (const sym of c.symbols) {
          violations.push({
            kind: 'dangling_consume',
            scope: 'entry',
            slice: slice.id,
            file: c.file,
            symbol: sym,
            message: `Slice ${slice.id} consumes ${sym} from ${c.from}:${c.file}, but ${c.from} has no heading in this map`,
          });
        }
        continue;
      }
      const targetIdx = sliceOrder.get(c.from);
      if (targetIdx >= i) {
        for (const sym of c.symbols) {
          violations.push({
            kind: 'forward_reference',
            scope: 'entry',
            slice: slice.id,
            file: c.file,
            symbol: sym,
            message: `Slice ${slice.id} consumes ${sym} from ${c.from}:${c.file}, which appears at or after ${slice.id} in document order`,
          });
        }
      }
    }
  }

  // 4. Producer/consumer match
  for (const slice of liveSlices) {
    for (const c of slice.consumes) {
      const producerIdx = sliceOrder.get(c.from);
      if (producerIdx === undefined) continue; // dangling already flagged
      const producer = liveSlices[producerIdx];
      // Find matching produces entries for the file
      const producesForFile = producer.produces.filter((p) => p.file === c.file);
      if (producesForFile.length === 0) {
        for (const sym of c.symbols) {
          violations.push({
            kind: 'producer_consumer_mismatch',
            scope: 'entry',
            slice: slice.id,
            file: c.file,
            symbol: sym,
            message: `Slice ${slice.id} consumes ${sym} from ${c.from}:${c.file}, but ${c.from} does not produce that file`,
          });
        }
        continue;
      }
      const producedSymbols = new Set();
      for (const p of producesForFile) for (const s of p.symbols) producedSymbols.add(s);
      for (const sym of c.symbols) {
        if (!producedSymbols.has(sym)) {
          violations.push({
            kind: 'producer_consumer_mismatch',
            scope: 'entry',
            slice: slice.id,
            file: c.file,
            symbol: sym,
            message: `Slice ${slice.id} consumes ${sym} from ${c.from}:${c.file}, but ${c.from} does not produce ${sym} in that file`,
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

// ---------- CLI for manual dogfood ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node lib/boundary-map.js <blueprint-path> [repoRoot]');
    process.exit(2);
  }
  const repoRoot = process.argv[3] || process.cwd();
  const blueprintText = readFileSync(path, 'utf8');
  const r = validateBoundaryMap({ blueprintText, blueprintPath: path, repoRoot });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
