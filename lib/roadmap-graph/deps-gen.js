/**
 * deps-gen.js — COMP-ROADMAP-GRAPH-EDGES-1: infer roadmap `depends_on` edges for
 * a project and write them into each feature's deps.yaml (the file
 * server/feature-scan.js reads as `<featuresDir>/<CODE>/deps.yaml`).
 *
 * Sources, strongest first (one edge keeps the first source that found it):
 *   links        feature.json `links` of kind depends_on / blocks
 *   list         a ROADMAP `Depends On:` block item `- CODE: PREREQ, PREREQ; prose`
 *                (codes before the first `;` or sentence end only)
 *   prose        "depends on" / "blocked by" / "requires" / "waits on" (and
 *                "after", ROADMAP only) IMMEDIATELY followed by a known feature
 *                code, in ROADMAP.md and the feature's design/prd/README docs
 *   phase-order  `## Phase N` (or `## Feature N`) sequence: a feature in phase
 *                N+1 with no inbound dependency from any other source depends
 *                on the last row of the previous phase group. `1a`/`1b` (and
 *                `1`/`1b`) share base 1 and get no edge between them. Rows
 *                already COMPLETE/SUPERSEDED/KILLED get none (finished order is
 *                history, and the graph drops those nodes anyway).
 *
 * Every endpoint must be a known code (a feature.json folder or a ROADMAP row;
 * a doc-only folder too when the file lives in a doc-only folder), so the
 * canonical projection never refuses with DANGLING_EDGE. Generated lines carry
 * `# source: ...`; lines without it are hand-written and never touched. A code
 * listed under `ignore_generated:` in a deps.yaml is never generated there again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseRoadmap } from '../roadmap-parser.js';

export const GENERATED_HEADER = '# Roadmap-graph edges (COMP-ROADMAP-GRAPH-EDGES-1). Items with a trailing source comment are\n'
  + '# written by scripts/roadmap-deps-gen.mjs and rewritten on every run: delete one and list its\n'
  + '# code under ignore_generated: to keep it out. Items without one are hand-written, never touched.';
// A generated line is a list item with a trailing `# source:` comment, nothing else.
const GENERATED_LINE_RE = /^\s+-\s+\S+\s+#\s*source:/;
const SOURCE_RANK = { links: 0, list: 1, prose: 2, 'phase-order': 3 };
const CODE_RE = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;
const PHRASE_RE = /\b(depends on|depend on|blocked by|requires|required|waits on|wait on|after)\s+(?:the\s+)?(?:feature\s+)?[`*[]*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/gi;
// plan.md / blueprint.md are implementation narrative ("after X merge", "requires X
// normalization"): measured as the main false-positive source, so not scanned.
const DOC_FILES = ['design.md', 'prd.md', 'README.md'];
const DONE = new Set(['COMPLETE', 'SUPERSEDED', 'KILLED']);
const PHASE_RE = /^##\s+(?:Phase|Feature)\s+(\d+(?:\.\d+)?)([a-z])?\b/i;

/** Known codes in a line, in order, with their columns. */
function codesIn(line, known) {
  const out = [];
  for (const m of line.matchAll(CODE_RE)) if (known.has(m[0])) out.push({ code: m[0], index: m.index });
  return out;
}

/**
 * Prose phrase edges in one line. The dependent is `context` (the table row's
 * code, or the doc's feature), except for "X depends on / blocked by / waits on
 * Y" with X a known code ending at most 15 chars before the phrase
 * ("X (Phase 2) waits on Y"). `after` counts only when `allowAfter` (ROADMAP
 * rows; in feature docs it is implementation narrative: "after X merge").
 * A negated phrase ("not", "no longer", "n't" just before it) is skipped.
 * @returns {{from:string,to:string}[]} from = prerequisite, to = dependent
 */
export function proseEdges(line, known, context, { allowAfter = true } = {}) {
  const edges = [];
  for (const m of line.matchAll(PHRASE_RE)) {
    const phrase = m[1].toLowerCase();
    const prereq = m[2];
    if (!known.has(prereq)) continue;
    if (phrase === 'after' && !allowAfter) continue;
    const before = line.slice(0, m.index);
    if (/(\bnot|\bno longer|n't)\s*$/i.test(before.slice(-14))) continue;
    let dependent = context;
    if (/^(depends? on|blocked by|waits? on)$/.test(phrase)) {
      const subj = codesIn(before, known).filter((c) => before.length - (c.index + c.code.length) <= 15).pop();
      if (subj) dependent = subj.code;
    }
    if (dependent && dependent !== prereq) edges.push({ from: prereq, to: dependent });
  }
  return edges;
}

/** `- CODE: PREREQ, PREREQ; prose` inside a Depends On block. */
export function listItemEdges(line, known) {
  const m = line.match(/^\s*[-*]\s+`?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`?\s*:\s*(.*)$/);
  if (!m || !known.has(m[1])) return [];
  const head = m[2].split(';')[0].split(/\.(?:\s|$)/)[0];
  return codesIn(head, known).filter((c) => c.code !== m[1]).map((c) => ({ from: c.code, to: m[1] }));
}

/** Edges from a ROADMAP.md text: Depends On lists, prose, and phase order rows. */
export function roadmapEdges(text, known, relPath) {
  const edges = [];
  const lines = text.split('\n');
  let inFence = false;
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const src = `${relPath}:${i + 1}`;
    if (/^\s*(\*\*)?depends on(\*\*)?\s*:?(\*\*)?\s*$/i.test(line)) { inList = true; continue; }
    if (inList) {
      if (/^\s*[-*]\s/.test(line)) {
        for (const e of listItemEdges(line, known)) edges.push({ ...e, source: 'list', where: src });
        continue;
      }
      if (line.trim() !== '') inList = false;
      else continue;
    }
    // A table row's dependent is the row's first known code (the Feature column).
    const context = line.trim().startsWith('|') ? codesIn(line, known)[0]?.code : null;
    for (const e of proseEdges(line, known, context)) edges.push({ ...e, source: 'prose', where: src });
  }
  return edges;
}

/**
 * Phase groups: [{run, base, label, codes[], done}], codes in row order. A run
 * is a stretch of consecutive `## Phase N` headings; any other `##` heading
 * ends it (compose reuses "Phase 6" in two unrelated parts of its ROADMAP, so
 * numbers only order phases inside one run). Rows come from parseRoadmap,
 * whose phaseId is the heading title (`Phase 1b: ...`).
 */
export function phaseGroups(text) {
  const runOf = new Map(); // heading title -> run (null = title used twice: ambiguous)
  let run = 0;
  let prevPhase = false;
  for (const line of text.split('\n')) {
    if (!/^##\s/.test(line)) continue;
    const isPhase = PHASE_RE.test(line.trim());
    if (isPhase && !prevPhase) run++;
    prevPhase = isPhase;
    if (!isPhase) continue;
    const title = line.trim().replace(/^##\s+/, '').split(/\s+—\s+/)[0].trim();
    runOf.set(title, runOf.has(title) ? null : run);
  }
  const groups = new Map(); // `${run}:${base}` -> group
  for (const e of parseRoadmap(text)) {
    if (e.code.startsWith('_anon_')) continue;
    const top = e.phaseId.split(' > ')[0];
    const m = `## ${top}`.match(PHASE_RE);
    const r = runOf.get(top);
    if (!m || r == null) continue; // named epics (`## COMP-UI: ...`) are not a sequence
    const base = Number(m[1]);
    const k = `${r}:${base}`;
    if (!groups.has(k)) groups.set(k, { run: r, base, label: top.split(':')[0], codes: [], done: new Set() });
    groups.get(k).codes.push(e.code); // parseRoadmap yields rows in document order
    if (DONE.has(String(e.status).toUpperCase())) groups.get(k).done.add(e.code);
  }
  return [...groups.values()].sort((x, y) => x.run - y.run || x.base - y.base);
}

/** Phase-order edges for dependents with no inbound edge in `existing`. */
export function phaseOrderEdges(groups, known, existing) {
  const hasInbound = new Set(existing.map((e) => e.to));
  const edges = [];
  for (let k = 1; k < groups.length; k++) {
    if (groups[k].run !== groups[k - 1].run) continue;
    const prev = groups[k - 1].codes.filter((c) => known.has(c));
    const anchor = prev[prev.length - 1];
    if (!anchor) continue;
    for (const code of groups[k].codes) {
      if (!known.has(code) || hasInbound.has(code) || code === anchor || groups[k].done.has(code)) continue;
      edges.push({ from: anchor, to: code, source: 'phase-order', where: `${groups[k - 1].label} -> ${groups[k].label}` });
    }
  }
  return edges;
}

/** Hand-written entries of a deps.yaml text (generated lines removed). */
export function handEntries(text) {
  const kept = String(text || '').split('\n').filter((l) => !GENERATED_LINE_RE.test(l)).join('\n');
  let doc = {};
  try { doc = parseYaml(kept) || {}; } catch { return { unparseable: true, depends_on: [], blocks: [], ignore: [] }; }
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return { depends_on: arr(doc.depends_on), blocks: arr(doc.blocks), concurrent_with: arr(doc.concurrent_with), ignore: arr(doc.ignore_generated) };
}

/**
 * Rewrite a deps.yaml: drop every generated line, keep everything else verbatim,
 * append the new generated lines at the end of their key's block.
 * @param {string|null} text existing file (null = none)
 * @param {{depends_on: {code,source}[], blocks: {code,source}[]}} gen
 * @returns {string|null} new text, or null when the file should not exist
 */
export function mergeDepsYaml(text, gen) {
  const lines = (text == null ? '' : text).split('\n').filter((l) => !GENERATED_LINE_RE.test(l));
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  // A key left with no items (its items were all generated) goes too.
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = lines[i].match(/^(depends_on|blocks):\s*$/);
    if (k && !(lines[i + 1] && /^\s+-\s/.test(lines[i + 1]))) lines.splice(i, 1);
  }
  for (const key of ['depends_on', 'blocks']) {
    const items = [...(gen[key] || [])].sort((a, b) => a.code.localeCompare(b.code))
      .map((e) => `  - ${e.code}  # source: ${e.source}`);
    if (!items.length) continue;
    let at = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
    if (at === -1) {
      if (!lines.length) lines.push(...GENERATED_HEADER.split('\n'));
      lines.push(`${key}:`, ...items);
      continue;
    }
    let end = at + 1;
    while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
    lines.splice(end, 0, ...items);
  }
  const body = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (!body.length) return null;
  return lines.join('\n') + '\n';
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

/**
 * Collect every inferred edge for a project and plan the deps.yaml writes.
 * @param {{featuresDir: string, roadmapPath: string, root: string, externalPrefixes?: string[]}} p
 */
export function planProject({ featuresDir, roadmapPath, root, externalPrefixes = [] }) {
  const rel = (f) => path.relative(root, f);
  const isExternal = (c) => externalPrefixes.some((p) => c.startsWith(p));
  const folders = new Map(); // code -> {hasFeatureJson}
  for (const d of fs.existsSync(featuresDir) ? fs.readdirSync(featuresDir, { withFileTypes: true }) : []) {
    if (d.isDirectory()) folders.set(d.name, { hasFeatureJson: fs.existsSync(path.join(featuresDir, d.name, 'feature.json')) });
  }
  const roadmapText = readText(roadmapPath) || '';
  const roadmapCodes = new Set(parseRoadmap(roadmapText).map((e) => e.code).filter((c) => !c.startsWith('_anon_')));
  const canonical = new Set([...roadmapCodes, ...[...folders].filter(([, f]) => f.hasFeatureJson).map(([c]) => c)]);
  const all = new Set([...canonical, ...folders.keys()].filter((c) => !isExternal(c)));

  const found = [];
  found.push(...roadmapEdges(roadmapText, all, rel(roadmapPath)));
  for (const code of [...folders.keys()].sort()) {
    const dir = path.join(featuresDir, code);
    const spec = readText(path.join(dir, 'feature.json'));
    if (spec) {
      try {
        for (const l of JSON.parse(spec).links || []) {
          if (!l || !all.has(l.to_code)) continue;
          if (l.kind === 'depends_on') found.push({ from: l.to_code, to: code, source: 'links', where: rel(path.join(dir, 'feature.json')) });
          if (l.kind === 'blocks') found.push({ from: code, to: l.to_code, source: 'links', where: rel(path.join(dir, 'feature.json')) });
        }
      } catch { /* malformed feature.json: no links */ }
    }
    for (const f of DOC_FILES) {
      const text = readText(path.join(dir, f));
      if (!text) continue;
      let inFence = false;
      text.split('\n').forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
        if (inFence) return;
        for (const e of proseEdges(line, all, code, { allowAfter: false })) found.push({ ...e, source: 'prose', where: `${rel(path.join(dir, f))}:${i + 1}` });
      });
    }
  }

  // Hand-written edges, read from every folder's deps.yaml.
  const hand = [];
  const files = new Map(); // code -> {text, entries}
  for (const code of folders.keys()) {
    const text = readText(path.join(featuresDir, code, 'deps.yaml'));
    const entries = handEntries(text);
    files.set(code, { text, entries });
    for (const d of entries.depends_on) hand.push({ from: d, to: code });
    for (const b of entries.blocks) hand.push({ from: code, to: b });
  }
  const key = (e) => `${e.from}|${e.to}`;
  const handKeys = new Set(hand.map(key));

  // Strongest source per edge; drop self, hand-written and 2-cycles.
  const best = new Map();
  for (const e of found.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])) {
    if (e.from === e.to || handKeys.has(key(e)) || best.has(key(e))) continue;
    best.set(key(e), e);
  }
  const phase = phaseOrderEdges(phaseGroups(roadmapText), canonical, [...hand, ...best.values()]);
  for (const e of phase) if (!handKeys.has(key(e)) && !best.has(key(e))) best.set(key(e), e);
  const dropped = { cycle: [], unplaceable: [], dangling: [], ignored: [] };
  for (const e of [...best.values()]) {
    const rev = `${e.to}|${e.from}`;
    if (handKeys.has(rev)) { best.delete(key(e)); dropped.cycle.push(e); continue; }
    const other = best.get(rev);
    if (other && SOURCE_RANK[other.source] <= SOURCE_RANK[e.source]) { best.delete(key(e)); dropped.cycle.push(e); }
  }

  // Place: dependent's folder (depends_on), else prerequisite's folder (blocks).
  const gen = new Map(); // code -> {depends_on: [], blocks: []}
  const placed = [];
  for (const e of [...best.values()].sort((a, b) => key(a).localeCompare(key(b)))) {
    const home = folders.has(e.to) ? { code: e.to, k: 'depends_on', other: e.from }
      : folders.has(e.from) ? { code: e.from, k: 'blocks', other: e.to } : null;
    if (!home) { dropped.unplaceable.push(e); continue; }
    // The canonical projection checks feature.json folders' edges against its known set.
    if (folders.get(home.code).hasFeatureJson && !(canonical.has(e.from) && canonical.has(e.to))) { dropped.dangling.push(e); continue; }
    if (files.get(home.code).entries.ignore.includes(home.other)) { dropped.ignored.push(e); continue; }
    if (!gen.has(home.code)) gen.set(home.code, { depends_on: [], blocks: [] });
    gen.get(home.code)[home.k].push({ code: home.other, source: `${e.source} ${e.where}` });
    placed.push({ ...e, file: rel(path.join(featuresDir, home.code, 'deps.yaml')), key: home.k });
  }

  const writes = [];
  for (const [code, { text }] of files) {
    if (files.get(code).entries.unparseable) continue;
    const next = mergeDepsYaml(text, gen.get(code) || { depends_on: [], blocks: [] });
    if ((next ?? null) !== (text ?? null)) writes.push({ file: path.join(featuresDir, code, 'deps.yaml'), text: next });
  }
  return { placed, dropped, writes, handCount: hand.length, folders: folders.size, roadmapRows: roadmapCodes.size };
}

/** Apply planned writes (null text = delete the generated-only file). */
export function applyWrites(writes) {
  for (const w of writes) {
    if (w.text == null) { try { fs.unlinkSync(w.file); } catch { /* already gone */ } continue; }
    const tmp = `${w.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, w.text);
    fs.renameSync(tmp, w.file);
  }
}
