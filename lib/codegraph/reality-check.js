// lib/codegraph/reality-check.js — STRAT-CODEGRAPH-1
//
// Plan reality check. Every backticked name or path in a plan/blueprint gets one
// label against the code graph and the disk:
//   existing      resolves (evidence: index | disk | text)
//   new           marked "(new)" (or a File Plan row with action new/create/add) and absent
//   unmarked-new  absent and not marked: the plan proposes it without saying so, or it is wrong
//   unknown       the producer skipped the file (oversize, budget, missing TS grammar), or the
//                 run entity budget ran out (PARTIAL COVERAGE): absence proves nothing, so the
//                 name is never reported as missing
// The S3 replay (spikes-2026-10-08.md) found 10 of 18 flags were proposed names not
// marked (new), so those are reported as unmarked-new, not as errors.
//
// Built on validateBoundaryMap (lib/boundary-map.js); its result rides along.
// WARN-ONLY: planGateRealityCheck never throws and never decides a gate.
// Port of replays/tools/s3_reality.py + s3_classify.py, with the row-subject fix.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { validateBoundaryMap } from '../boundary-map.js';
import { warnOnce } from './availability.js';
import { buildModel } from './model.js';
import { codegraphDir, loadSnapshots, resolveRepos } from './snapshot.js';

const PATH_RE = /^(?<p>[\w.\-/<>@]+\.(?:js|ts|json|ya?ml|md|jsx|tsx|mjs|cjs|py|toml|sh))(?::(?<l>\d+)(?:-(?<l2>\d+))?)?$/;
const FN_LINE_RE = /^(?<n>[A-Za-z_$][\w$]*):(?<l>\d+)(?:-(?<l2>\d+))?$/;
const IDENT_RE = /^(?<n>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?<call>\(.*\))?$/;
const NEW_ACTIONS = /^(new|create|add)\b/i;
const FILE_PLAN_HEADINGS = new Set(['## File Plan', '## Files', '## File-by-File Plan']);
const TEXT_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** A bare identifier is a code name only when it looks like one; plain words are prose. */
function looksLikeCode(name, hasCall) {
  return hasCall
    || name.includes('.')
    || name.includes('_')
    || name.includes('$')
    || /[a-z0-9][A-Z]/.test(name)
    || /^[A-Z][A-Z0-9_]{2,}$/.test(name)
    || /^[A-Z][a-z0-9]+$/.test(name); // a simple class name such as `Widget` or `Db`
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalized identity of a token: no :line, no (args), no leading ./ */
export function normalizeToken(token) {
  return token.replace(/:\d+(?:-\d+)?$/, '').replace(/\(.*\)$/, '').replace(/^\.\//, '');
}

/**
 * Every backticked token in `text`, classified, with its 1-based line and marks.
 * @returns {Array<{line, token, kind: 'path'|'symbol:line'|'identifier', name, lineRef, markedNew, markedExisting}>}
 */
export function extractPlanNames(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let fence = false;
  let inFilePlan = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    // Only a File Plan table declares files new by its action column (boundary-map.js FILE_PLAN_ALIASES).
    // Any heading (any depth, any indent) ends the current section.
    if (/^\s*#{1,6}(\s|$)/.test(line)) inFilePlan = FILE_PLAN_HEADINGS.has(line.trim().replace(/\s+/g, ' '));
    const row = inFilePlan ? /^\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/.exec(line) : null;
    const rowSubjectNew = row && NEW_ACTIONS.test(row[2].trim()) ? row[1] : null;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1].trim();
      if (!token) continue;
      const after = line.slice(m.index + m[0].length);
      const markedNew = /^\s*\(new\)/i.test(after) || rowSubjectNew === m[1];
      const markedExisting = /^\s*\(existing\)/i.test(after);
      const base = { line: i + 1, token, markedNew, markedExisting };
      // Templates (`.compose/gsd/<code>/x.json`) and JSONPath (`$.steps.x`) name patterns, not files or symbols.
      if (/<[^>]*>/.test(token) || token.startsWith('$.')) continue;
      let match = PATH_RE.exec(token);
      if (match) {
        out.push({ ...base, kind: 'path', name: match.groups.p.replace(/^\.\//, ''), lineRef: match.groups.l ? Number(match.groups.l) : null });
        continue;
      }
      match = FN_LINE_RE.exec(token);
      if (match) {
        out.push({ ...base, kind: 'symbol:line', name: match.groups.n, lineRef: Number(match.groups.l) });
        continue;
      }
      match = IDENT_RE.exec(token);
      if (match && looksLikeCode(match.groups.n, !!match.groups.call)) {
        out.push({ ...base, kind: 'identifier', name: match.groups.n, lineRef: null });
      }
    }
  });
  return out;
}

function fileExists(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function commonParent(paths) {
  if (paths.length < 2) return null;
  const split = paths.map((p) => resolve(p).split(sep));
  const head = [];
  for (let i = 0; i < split[0].length; i++) {
    if (split.every((parts) => parts[i] === split[0][i])) head.push(split[0][i]);
    else break;
  }
  return head.length > 1 ? head.join(sep) : null;
}

/**
 * Project-relative display paths of every tracked or untracked-but-not-ignored file in the repos
 * (`git ls-files -co --exclude-standard`). Docs, YAML and JSON are not in the code index, so path
 * and basename checks need this. Not a git checkout: contributes nothing (disk checks still run).
 */
export function listRepoFiles(repos) {
  const out = new Set();
  for (const repo of repos) {
    try {
      const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], {
        cwd: repo.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const path of listed.split('\0')) if (path) out.add(`${repo.prefix}${path}`);
    } catch { /* not a git checkout, or git missing */ }
  }
  return out;
}

/**
 * Label every extracted name. `repos` come from resolveRepos (name, root, prefix).
 * @returns {{ mentions: object[], names: object[] }}
 */
export function labelNames({ names, model, projectRoot, repos, artifactPath = null, fileList = null }) {
  const listed = fileList ?? listRepoFiles(repos);
  const projectName = basename(resolve(projectRoot));
  const workspaceRoot = commonParent(repos.map((r) => r.root));
  // Declared-new propagates to other mentions of the same name. A full path propagates only to the
  // same path, or to a bare basename mention (`foo.js` after `lib/foo.js` (new)); never to a different
  // path that happens to share the basename.
  const declaredNew = new Set();
  const declaredNewBasenames = new Set();
  for (const n of names) {
    if (!n.markedNew) continue;
    const norm = normalizeToken(n.name);
    declaredNew.add(norm);
    declaredNewBasenames.add(norm.split('/').pop());
  }
  const isDeclaredNew = (norm) => declaredNew.has(norm) || (!norm.includes('/') && declaredNewBasenames.has(norm));
  const skipped = model.skipped ?? new Map();
  const filesSkipped = model.filesSkipped ?? 0;
  const budgetRepos = model.budgetExhaustedRepos ?? [];

  /** Skip reason codes a reader cannot decode on sight get a gloss. */
  const SKIP_GLOSS = { grammar_unavailable: 'grammar_unavailable: tree-sitter-typescript/javascript not installed' };

  /** Reason the producer skipped the file a path token names (display path, repo-relative, or bare basename). */
  function skipReason(p) {
    if (skipped.has(p)) return skipped.get(p);
    for (const repo of repos) {
      if (skipped.has(`${repo.prefix}${p}`)) return skipped.get(`${repo.prefix}${p}`);
    }
    if (!p.includes('/')) {
      for (const [path, reason] of skipped) if (path.endsWith(`/${p}`)) return reason;
    }
    return null;
  }

  function resolvePath(p) {
    if (model.files.has(p)) return { evidence: 'index' };
    if (listed.has(p) || fileExists(join(projectRoot, p))) return { evidence: 'disk' };
    for (const repo of repos) {
      if (fileExists(join(repo.root, p))) return { evidence: 'disk', displayPath: `${repo.prefix}${p}` };
    }
    if (!p.includes('/')) {
      const indexed = [...model.files].filter((f) => f.endsWith(`/${p}`));
      const matches = indexed.length > 0 ? indexed : [...listed].filter((f) => f === p || f.endsWith(`/${p}`));
      if (matches.length > 0) {
        return { evidence: indexed.length > 0 ? 'index' : 'disk', hint: `basename match: ${matches.slice(0, 3).join(', ')}`, displayPath: matches[0] };
      }
    }
    return null;
  }

  function displayPathFor(p, found) {
    return found?.displayPath ?? p;
  }

  const mentions = names.map((n) => {
    const row = { ...n, label: null, evidence: null, hint: null, at: null };
    if (n.kind === 'path') {
      // Before the disk check: a skipped file exists on disk but its names are not in the graph.
      const reason = skipReason(n.name);
      const found = reason == null ? resolvePath(n.name) : null;
      if (reason != null) {
        Object.assign(row, { label: 'unknown', evidence: 'skipped', hint: `file skipped: ${SKIP_GLOSS[reason] ?? reason}` });
      } else if (found) {
        Object.assign(row, { label: 'existing', evidence: found.evidence, hint: found.hint ?? null });
        const path = displayPathFor(n.name, found);
        if (n.lineRef != null && model.files.has(path)) {
          const owner = model.enclosing(path, n.lineRef);
          row.lineOwner = owner ? owner.qualifiedName : null;
        }
      } else {
        const stripped = n.name.startsWith(`${projectName}/`) ? n.name.slice(projectName.length + 1) : null;
        if (stripped && resolvePath(stripped)) {
          row.hint = `exists without ${projectName}/ prefix (${stripped})`;
        } else if (workspaceRoot && fileExists(join(workspaceRoot, n.name))) {
          Object.assign(row, { label: 'existing', evidence: 'disk', hint: 'workspace-relative path' });
        }
      }
    } else {
      const hits = model.lookup(n.name);
      if (hits.length > 0) {
        Object.assign(row, { label: 'existing', evidence: 'index', at: model.where(hits[0]) });
        if (n.kind === 'symbol:line') row.lineInSpan = hits.some((h) => h.line <= n.lineRef && n.lineRef <= h.endLine);
      }
    }
    return row;
  });

  // One text pass over indexed source files for identifiers the index does not hold
  // (config keys, env vars, members the parser keeps as unresolved spellings).
  const pending = [...new Set(mentions.filter((m) => !m.label && m.kind !== 'path').map((m) => m.name))];
  if (pending.length > 0) {
    const found = new Map();
    const pattern = new RegExp(`(?<![\\w$])(${pending.map(escapeRe).join('|')})(?![\\w$])`, 'g');
    const artifactAbs = artifactPath ? resolve(projectRoot, artifactPath) : null;
    for (const path of model.files) {
      if (path.startsWith('docs/')) continue;
      const abs = resolve(projectRoot, path);
      if (abs === artifactAbs) continue;
      let content;
      try {
        if (statSync(abs).size > TEXT_SCAN_MAX_BYTES) continue;
        content = readFileSync(abs, 'utf8');
      } catch { continue; }
      for (const m of content.matchAll(pattern)) {
        if (!found.has(m[1])) found.set(m[1], path);
      }
      if (found.size === pending.length) break;
    }
    for (const m of mentions) {
      if (!m.label && found.has(m.name)) Object.assign(m, { label: 'existing', evidence: 'text', at: found.get(m.name) });
    }
  }

  for (const m of mentions) {
    const norm = normalizeToken(m.name);
    if (m.label === 'existing') {
      if (m.markedNew) m.note = 'marked (new) but exists';
      continue;
    }
    if (m.label === 'unknown') continue;
    if (isDeclaredNew(norm) && !m.hint && !m.markedExisting) {
      m.label = 'new';
    } else if (budgetRepos.length > 0) {
      m.label = 'unknown';
      m.note = `partial coverage: the entity budget ran out in ${budgetRepos.join(', ')}`;
    } else {
      m.label = 'unmarked-new';
      const notes = [];
      if (m.markedExisting) notes.push('marked (existing) but not found');
      if (m.kind !== 'path' && filesSkipped > 0) notes.push(`may be in ${filesSkipped} skipped file(s)`);
      if (notes.length > 0) m.note = notes.join('; ');
    }
  }

  // One row per normalized name; the worst label wins (unmarked-new > unknown > new > existing).
  const rank = { 'unmarked-new': 3, unknown: 2, new: 1, existing: 0 };
  const byName = new Map();
  for (const m of mentions) {
    const key = `${m.kind === 'path' ? 'path' : 'name'}:${normalizeToken(m.name)}`;
    const cur = byName.get(key);
    if (!cur) {
      byName.set(key, { name: normalizeToken(m.name), kind: m.kind, label: m.label, evidence: m.evidence, hint: m.hint,
        notes: new Set(m.note ? [m.note] : []), at: m.at, lines: [m.line] });
    } else {
      cur.lines.push(m.line);
      if (m.note) cur.notes.add(m.note);
      if (rank[m.label] > rank[cur.label]) Object.assign(cur, { label: m.label, evidence: m.evidence, hint: m.hint });
    }
  }
  // Every conflicting mark survives aggregation (e.g. one mention fine, a later one "marked (new) but exists").
  const rows = [...byName.values()].map(({ notes, ...row }) => ({ ...row, note: notes.size > 0 ? [...notes].join('; ') : null }));
  return { mentions, names: rows, coverage: { filesSkipped, budgetExhaustedRepos: budgetRepos } };
}

/**
 * @returns {{ labels: object[], mentions: object[], counts: {existing, new, unmarked_new, unknown},
 *   coverage: {filesSkipped, budgetExhaustedRepos}, boundaryMap: object }}
 */
export function runRealityCheck({ text, artifactPath = null, projectRoot, model, repos, fileList = null }) {
  const extracted = extractPlanNames(text);
  const { mentions, names, coverage } = labelNames({ names: extracted, model, projectRoot, repos, artifactPath, fileList });
  const counts = { existing: 0, new: 0, unmarked_new: 0, unknown: 0 };
  for (const n of names) counts[n.label === 'unmarked-new' ? 'unmarked_new' : n.label]++;
  const boundaryMap = validateBoundaryMap({ blueprintText: text, blueprintPath: artifactPath, repoRoot: projectRoot });
  return { labels: names, mentions, counts, coverage, boundaryMap };
}

/** Human-readable report: unresolved names first, each with its artifact line(s). */
export function formatRealityReport(result, { artifact = null, maxLines = 40 } = {}) {
  const { counts, labels, boundaryMap, coverage } = result;
  const partial = coverage?.budgetExhaustedRepos?.length > 0
    ? ` — PARTIAL COVERAGE (entity budget ran out in ${coverage.budgetExhaustedRepos.join(', ')}; no name is reported missing)`
    : '';
  const skips = coverage?.filesSkipped > 0 ? `, ${coverage.filesSkipped} file(s) skipped by the indexer` : '';
  const head = `Code-graph reality check${artifact ? ` (${artifact})` : ''}: ${counts.existing} existing, ${counts.new} new, `
    + `${counts.unmarked_new} unmarked-new, ${counts.unknown ?? 0} unknown${skips} — warn-only${partial}`;
  const rows = [];
  const flagged = labels.filter((n) => n.label === 'unmarked-new' || n.label === 'unknown' || n.note);
  for (const n of flagged) {
    const lines = [...new Set(n.lines)].map((l) => `L${l}`).join(',');
    rows.push(`  ${lines} ${n.label} \`${n.name}\`${n.hint ? ` — ${n.hint}` : ''}${n.note ? ` — ${n.note}` : ''}`);
  }
  const newOnes = labels.filter((n) => n.label === 'new');
  if (newOnes.length > 0) rows.push(`  new (declared): ${newOnes.map((n) => `\`${n.name}\``).join(', ')}`);
  for (const v of boundaryMap?.violations ?? []) rows.push(`  boundary-map ${v.kind}: ${v.message}`);
  const shown = rows.slice(0, maxLines);
  if (rows.length > maxLines) shown.push(`  … ${rows.length - maxLines} more (see the recorded JSON)`);
  return [head, ...shown].join('\n');
}

function resolveArtifact(cwd, artifact, featureDir) {
  const candidates = [];
  if (artifact) candidates.push(isAbsolute(artifact) ? artifact : resolve(cwd, artifact));
  if (featureDir) candidates.push(join(featureDir, 'plan.md'));
  return candidates.find((p) => fileExists(p)) ?? null;
}

/**
 * Plan-gate entry point. WARN-ONLY: returns a report or a skip, never throws, never
 * decides the gate.
 *
 * @returns {Promise<{ text, counts, recordPath, result } | { skipped: string }>}
 */
export async function planGateRealityCheck({ cwd, artifact, featureCode, featureDir = null, env = process.env, loader = loadSnapshots } = {}) {
  try {
    const artifactPath = resolveArtifact(cwd, artifact, featureDir);
    if (!artifactPath) return { skipped: 'no plan artifact to check' };
    const loaded = await loader({ projectRoot: cwd, env });
    if (loaded.skipped || loaded.snapshots.length === 0) return { skipped: loaded.skipped ?? 'no snapshots' };
    const model = buildModel(loaded.snapshots);
    const text = readFileSync(artifactPath, 'utf8');
    const relArtifact = relative(cwd, artifactPath);
    const result = runRealityCheck({ text, artifactPath: relArtifact, projectRoot: cwd, model, repos: resolveRepos(cwd) });
    const dir = join(codegraphDir(cwd), 'reality');
    mkdirSync(dir, { recursive: true });
    const recordPath = join(dir, `${String(featureCode || 'unknown').replace(/[^\w.-]+/g, '_')}.json`);
    writeFileSync(recordPath, `${JSON.stringify({
      featureCode, artifact: relArtifact, checked_at: new Date().toISOString(),
      snapshots: loaded.snapshots.map((s) => ({ repo: s.repo.name, fingerprint: s.snapshot.fingerprint, cached: s.cached, joined: s.joined === true, producer: s.snapshot.producer ?? null, complete: s.snapshot.complete, timing: s.timing })),
      snapshot_errors: loaded.errors,
      coverage: { ...result.coverage, partial: result.coverage.budgetExhaustedRepos.length > 0 },
      counts: result.counts, labels: result.labels, boundaryMap: result.boundaryMap,
    }, null, 2)}\n`);
    return { text: formatRealityReport(result, { artifact: relArtifact }), counts: result.counts, recordPath, result };
  } catch (err) {
    warnOnce('reality:unexpected', `plan reality check skipped: ${err?.message ?? err}`);
    return { skipped: err?.message ?? String(err) };
  }
}

