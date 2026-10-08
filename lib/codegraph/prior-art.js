// lib/codegraph/prior-art.js — STRAT-CODEGRAPH-1
//
// Prior-art search before design: does the concept already exist in the code?
// Name / qualified-name / docstring term match over the code graph; every match
// is listed with file:line. Runs before the explore_design step and is injected
// into its prompt as "this may already exist". WARN-ONLY: never throws.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { warnOnce } from './availability.js';
import { buildModel } from './model.js';
import { codegraphDir, loadSnapshots } from './snapshot.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'than', 'each', 'every', 'via', 'not',
  'are', 'was', 'its', 'any', 'all', 'one', 'two', 'new', 'add', 'use', 'run', 'get', 'set', 'make', 'should', 'must',
  'can', 'will', 'feature', 'support', 'build', 'compose', 'code', 'file', 'files', 'step', 'steps', 'before', 'after',
  'only', 'also', 'without', 'within', 'over', 'per', 'out', 'own', 'way', 'like', 'have', 'has', 'into', 'more',
]);

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Lowercased terms from prose or identifiers: camelCase / snake_case / kebab split, stopwords dropped. */
export function conceptTerms(text) {
  const words = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))];
}

/** Identifier-looking tokens in the text (for exact-name hits). */
function identifiersIn(text) {
  return new Set(String(text).match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []);
}

/**
 * @returns {Array<{ at, name, qualifiedName, type, score, matched: string[], exact: boolean }>}
 */
export function findPriorArt({ text, model, limit = 15 }) {
  const terms = conceptTerms(text);
  const idents = identifiersIn(text);
  const ticked = new Set([...String(text).matchAll(/`([A-Za-z_$][\w$.]*)(?:\(\))?`/g)].map((m) => m[1]));
  if (terms.length === 0 && idents.size === 0 && ticked.size === 0) return [];
  const termSet = new Set(terms);
  const matches = [];
  for (const e of model.entities) {
    // Prior art is about production capability: skip modules, tests and anonymous callbacks.
    if (e.type === 'module' || e.type === 'test' || e.qualifiedName.includes('@byte:') || TEST_PATH.test(e.path)) continue;
    const nameTerms = new Set(conceptTerms(e.name));
    const qualTerms = new Set(conceptTerms(e.qualifiedName));
    const docTerms = new Set(conceptTerms(e.doc));
    const matched = new Set();
    let score = 0;
    for (const t of termSet) {
      if (nameTerms.has(t)) { score += 3; matched.add(t); } else if (qualTerms.has(t)) { score += 2; matched.add(t); } else if (docTerms.has(t)) { score += 1; matched.add(t); }
    }
    // Exact name hit: a code-shaped name anywhere in the text, or any name the text puts in backticks
    // (a lowercase `parse` in prose would match every common word, so it counts only when backticked).
    const exact = (idents.has(e.name) && /[A-Z_]|\w\.\w/.test(e.name) && e.name.length >= 4) || ticked.has(e.name);
    if (exact) score += 10;
    if (!exact && matched.size < 2) continue;
    matches.push({ at: model.where(e), name: e.name, qualifiedName: e.qualifiedName, type: e.type, score, matched: [...matched], exact });
  }
  matches.sort((a, b) => b.score - a.score || (a.at < b.at ? -1 : 1));
  return matches.slice(0, limit);
}

export function formatPriorArt(matches) {
  if (matches.length === 0) return '';
  const lines = matches.map((m) => `- \`${m.at}\` ${m.qualifiedName} (${m.type})${m.exact ? ' — named in the description' : ` — matched: ${m.matched.join(', ')}`}`);
  return [
    '## Possible Prior Art (code graph, warn-only)',
    'These existing code entities match the feature description by name or docstring. Check whether the feature',
    'already exists, or should extend one of them, before designing something new. Each is `file:line`.',
    ...lines,
  ].join('\n');
}

/**
 * Design-step entry point. WARN-ONLY: returns { text, matches, recordPath } or { skipped }.
 */
export async function priorArtForDesign({ cwd, featureCode, description, env = process.env, loader = loadSnapshots, limit = 15 } = {}) {
  try {
    if (!description || !String(description).trim()) return { skipped: 'no feature description' };
    const loaded = await loader({ projectRoot: cwd, env });
    if (loaded.skipped || loaded.snapshots.length === 0) return { skipped: loaded.skipped ?? 'no snapshots' };
    const model = buildModel(loaded.snapshots);
    const matches = findPriorArt({ text: `${featureCode ?? ''} ${description}`, model, limit });
    const dir = join(codegraphDir(cwd), 'prior-art');
    mkdirSync(dir, { recursive: true });
    const recordPath = join(dir, `${String(featureCode || 'unknown').replace(/[^\w.-]+/g, '_')}.json`);
    writeFileSync(recordPath, `${JSON.stringify({
      featureCode, description, searched_at: new Date().toISOString(),
      snapshots: loaded.snapshots.map((s) => ({ repo: s.repo.name, fingerprint: s.snapshot.fingerprint, cached: s.cached })),
      matches,
    }, null, 2)}\n`);
    return { text: formatPriorArt(matches), matches, recordPath };
  } catch (err) {
    warnOnce('prior-art:unexpected', `prior-art search skipped: ${err?.message ?? err}`);
    return { skipped: err?.message ?? String(err) };
  }
}
