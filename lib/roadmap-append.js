/**
 * roadmap-append.js — COMP-NEWUSER-README-1: append a feature row to ROADMAP.md
 * in the column shape the target table already has.
 *
 * `compose feature` used to write a fixed 4-column row (`# | code | desc | status`)
 * into whatever table it found. The table `compose init` scaffolds is 3-column
 * (`# | Item | Status`), so the new row was ragged and `compose roadmap` then
 * exited with "no named feature rows were parsed". The writer now reads the
 * header, and when the table has no Feature column it adds one first (existing
 * rows get `—`, which the parser already reads as anonymous, exactly as before).
 */
import { splitRoadmapCells, detectColumnLayout } from './roadmap-parser.js';

const ROW_RE = /^\s*\|/;

function cellsOf(line) {
  return splitRoadmapCells(line.trim());
}

function join(cells) {
  return `| ${cells.join(' | ')} |`;
}

/**
 * Find tables as { start, end } line ranges (header at start, last row at end).
 */
function findTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (!ROW_RE.test(lines[i])) { i++; continue; }
    const start = i;
    while (i < lines.length && ROW_RE.test(lines[i])) i++;
    tables.push({ start, end: i - 1 });
  }
  return tables;
}

/**
 * @param {string} roadmap  ROADMAP.md text
 * @param {string} code     feature code
 * @param {string} description
 * @returns {{ text: string, itemNumber: number }}
 */
export function appendFeatureRow(roadmap, code, description) {
  const nums = [...roadmap.matchAll(/^\| (\d+) \|/gm)].map((m) => parseInt(m[1], 10));
  const itemNumber = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const safeDesc = String(description).replace(/\|/g, '\\|');

  const lines = roadmap.split('\n');
  const tables = findTables(lines);

  // Target: the first item table (header starts with `#` or `ID`, last cell is
  // Status) that holds a PLANNED row. Same preference the old writer had.
  const target = tables.find((t) => {
    if (t.end - t.start < 2) return false;
    const header = cellsOf(lines[t.start]).map((c) => c.toLowerCase());
    if (header.length < 3) return false;
    if (header[0] !== '#' && header[0] !== 'id') return false;
    if (header[header.length - 1] !== 'status') return false;
    return lines.slice(t.start + 2, t.end + 1).some((l) => /\|\s*PLANNED\s*\|\s*$/.test(l));
  });

  if (!target) {
    const section =
      `\n\n## Features\n\n| # | Feature | Item | Status |\n|---|---------|------|--------|\n` +
      `| ${itemNumber} | ${code} | ${safeDesc} | PLANNED |\n`;
    return { text: roadmap + section, itemNumber };
  }

  const header = cellsOf(lines[target.start]);
  let layout = detectColumnLayout(header);

  if (layout.codeCol === -1) {
    // `# | Item | Status` (anonymous). Insert a Feature column after the first
    // column in the header, separator and every row of this table.
    const at = 1;
    for (let r = target.start; r <= target.end; r++) {
      const cells = cellsOf(lines[r]);
      if (r === target.start) cells.splice(at, 0, 'Feature');
      else if (cells.every((c) => /^[-:]+$/.test(c))) {
        lines[r] = `|${[...cells, '-'].map(() => '---').join('|')}|`;
        continue;
      } else cells.splice(at, 0, '—');
      lines[r] = join(cells);
    }
    layout = detectColumnLayout(cellsOf(lines[target.start]));
  }

  const width = cellsOf(lines[target.start]).length;
  const row = new Array(width).fill('');
  if (header[0].toLowerCase() === '#' || layout.codeCol !== 0) row[0] = String(itemNumber);
  row[layout.codeCol] = code;
  row[layout.descCol] = safeDesc;
  row[layout.statusCol] = 'PLANNED';
  lines.splice(target.end + 1, 0, join(row));
  return { text: lines.join('\n'), itemNumber };
}
