/**
 * vocabulary-compliance.js — deterministic Compose-side vocabulary checks.
 *
 * E3/F5: the TS engine's `judged:` ensure cannot see the changed files or the
 * vocabulary (the judge receives only {result, input} and fails when evidence is
 * missing), so it is unevaluable as a merge guard. v1 vocabulary enforcement is
 * therefore moved here: compose evaluates it over the ACTUAL changed files at the
 * review_merge step and, on violation, sends a FAILURE step_done envelope so the
 * engine's attempts/retry lifecycle governs (never a throw past the step handler).
 *
 * Inert when contracts/vocabulary.yaml is missing / empty / comments-only. Message
 * Stable message formats let tagVocabularyViolations classify them.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { normalize, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VOCAB_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

/** Raised by loadVocabulary; `.violations` mirrors the Python ValueError([...]). */
export class VocabularyError extends Error {
  constructor(violations) {
    super(Array.isArray(violations) ? violations.join('; ') : String(violations));
    this.name = 'VocabularyError';
    this.violations = Array.isArray(violations) ? violations : [String(violations)];
  }
}

/**
 * Load and validate vocabulary.yaml. Returns {} for missing/empty/comments-only
 * files (the no-op case). Throws VocabularyError([messages]) on malformed YAML or
 * schema errors.
 * @returns {Record<string, {reject: string[], reason: string}>}
 */
export function loadVocabulary(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return {};

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (exc) {
    throw new VocabularyError([`vocabulary.yaml malformed: cannot read ${path}: ${exc.message}`]);
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (exc) {
    throw new VocabularyError([`vocabulary.yaml malformed: ${exc.message}`]);
  }

  // Empty file or comments-only → null/undefined → treat as empty.
  if (parsed === null || parsed === undefined) return {};

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VocabularyError(['vocabulary.yaml schema error: top-level must be a mapping']);
  }

  const validated = {};
  for (const [canonical, entry] of Object.entries(parsed)) {
    if (typeof canonical !== 'string' || !IDENTIFIER_RE.test(canonical)) {
      throw new VocabularyError([
        `vocabulary.yaml schema error: canonical name ${JSON.stringify(canonical)} `
        + `must match identifier syntax (letters, digits, underscore; starts with letter or underscore)`,
      ]);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new VocabularyError([
        `vocabulary.yaml schema error: entry for ${JSON.stringify(canonical)} `
        + `must be a mapping, got ${Array.isArray(entry) ? 'array' : typeof entry}`,
      ]);
    }

    const allowedFields = new Set(['reject', 'reason']);
    const unknown = Object.keys(entry).filter((k) => !allowedFields.has(k)).sort();
    if (unknown.length > 0) {
      throw new VocabularyError([
        `vocabulary.yaml schema error: entry for ${JSON.stringify(canonical)} `
        + `has unknown fields: ${JSON.stringify(unknown)}. Allowed: ["reject","reason"]`,
      ]);
    }

    const reject = entry.reject;
    if (!Array.isArray(reject) || reject.length === 0) {
      throw new VocabularyError([
        `vocabulary.yaml schema error: entry for ${JSON.stringify(canonical)} must have non-empty 'reject' list`,
      ]);
    }

    for (const alias of reject) {
      if (typeof alias !== 'string' || !IDENTIFIER_RE.test(alias)) {
        throw new VocabularyError([
          `vocabulary.yaml schema error: alias ${JSON.stringify(alias)} in ${JSON.stringify(canonical)} `
          + `must match identifier syntax`,
        ]);
      }
      if (alias === canonical) {
        throw new VocabularyError([
          `vocabulary.yaml schema error: canonical ${JSON.stringify(canonical)} cannot reject itself`,
        ]);
      }
    }

    const reason = entry.reason ?? '';
    if (reason !== null && typeof reason !== 'string') {
      throw new VocabularyError([
        `vocabulary.yaml schema error: reason for ${JSON.stringify(canonical)} must be a string`,
      ]);
    }

    validated[canonical] = { reject: [...reject], reason: reason || '' };
  }

  // Cross-entry validation: no duplicate aliases, no canonical-as-alias.
  const canonicals = new Set(Object.keys(validated));
  const aliasToCanonical = new Map();
  for (const [canonical, entry] of Object.entries(validated)) {
    for (const alias of entry.reject) {
      if (canonicals.has(alias)) {
        throw new VocabularyError([
          `vocabulary.yaml schema error: ${JSON.stringify(alias)} is both a canonical `
          + `and a rejected alias for ${JSON.stringify(canonical)}`,
        ]);
      }
      if (aliasToCanonical.has(alias)) {
        throw new VocabularyError([
          `vocabulary.yaml schema error: alias ${JSON.stringify(alias)} is rejected by `
          + `multiple canonicals (${aliasToCanonical.get(alias)}, ${canonical})`,
        ]);
      }
      aliasToCanonical.set(alias, canonical);
    }
  }

  return validated;
}

/** git diff --name-only <base> plus untracked files. Returns null on any failure. */
function gitChangedFiles(base, cwd) {
  try {
    const diff = execFileSync('git', ['diff', '--name-only', base], {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tracked = diff.split('\n').filter(Boolean);
    let untracked = [];
    try {
      const others = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      untracked = others.split('\n').filter(Boolean);
    } catch { /* untracked listing best-effort */ }
    const seen = new Set();
    const combined = [];
    for (const f of [...tracked, ...untracked]) {
      if (!seen.has(f)) { seen.add(f); combined.push(f); }
    }
    return combined;
  } catch {
    return null;
  }
}

function scanFileForAliases(displayPath, absPath, aliasToCanonical, canonicalToReason, matchers) {
  const violations = [];
  let size;
  try {
    size = statSync(absPath).size;
  } catch {
    return violations; // disappeared between checks
  }
  if (size > VOCAB_SIZE_LIMIT) return violations; // skip large files silently

  let lines;
  try {
    lines = readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return violations;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    for (const [alias, pattern] of matchers) {
      // G5: emit one violation per OCCURRENCE (python parity — the builtin uses
      // finditer), not one per line. matchAll requires the global flag on pattern.
      for (const _match of lines[i].matchAll(pattern)) {
        void _match;
        const canonical = aliasToCanonical.get(alias);
        const reason = canonicalToReason.get(canonical) ?? '';
        let msg = `vocabulary violation: ${displayPath}:${lineNo} uses '${alias}' — canonical is '${canonical}'`;
        if (reason) msg += ` (reason: ${reason})`;
        violations.push(msg);
      }
    }
  }
  return violations;
}

/**
 * Scan `filesChanged` for rejected vocabulary aliases. Returns an array of
 * violation strings — EMPTY means compliant or inert (no vocabulary, nothing to
 * scan). Never throws for violations: schema/malformed vocab errors are returned
 * as (blocking) violation strings too, so the caller converts them into a failure
 * envelope rather than crashing the step handler.
 *
 * @param {string}   vocabPath   path to vocabulary.yaml (resolved against cwd)
 * @param {string[]} filesChanged authoritative list of touched files
 * @param {object}   [opts]
 * @param {boolean}  [opts.gitFallback=false] scan `git diff <base>` when filesChanged is empty
 * @param {string}   [opts.base='HEAD']
 * @param {string}   [opts.cwd=process.cwd()]
 * @returns {string[]}
 */
export function vocabularyCompliance(vocabPath, filesChanged, { gitFallback = false, base = 'HEAD', cwd = process.cwd() } = {}) {
  let vocab;
  try {
    vocab = loadVocabulary(vocabPath);
  } catch (err) {
    // A malformed / invalid vocabulary blocks the step (matches the Python builtin
    // raising) — surface the schema errors as violations.
    return err instanceof VocabularyError ? err.violations : [String(err?.message ?? err)];
  }
  if (!vocab || Object.keys(vocab).length === 0) return []; // no vocabulary → nothing to check

  const aliasToCanonical = new Map();
  const canonicalToReason = new Map();
  for (const [canonical, entry] of Object.entries(vocab)) {
    canonicalToReason.set(canonical, entry.reason);
    for (const alias of entry.reject) aliasToCanonical.set(alias, canonical);
  }

  let fileList;
  if (Array.isArray(filesChanged) && filesChanged.length > 0) {
    fileList = filesChanged;
  } else if (gitFallback) {
    const fallback = gitChangedFiles(base, cwd);
    if (fallback === null) return []; // git failed; nothing we can do
    fileList = fallback;
  } else {
    return []; // no files to scan
  }

  // Normalize + dedupe; keep only existing regular files.
  const seen = new Set();
  const files = []; // [displayPath, absPath]
  for (const f of fileList) {
    const disp = normalize(f);
    if (seen.has(disp)) continue;
    seen.add(disp);
    const abs = isAbsolute(disp) ? disp : join(cwd, disp);
    try {
      if (statSync(abs).isFile()) files.push([disp, abs]);
    } catch { /* missing/deleted — skip */ }
  }
  if (files.length === 0) return [];

  const matchers = new Map();
  for (const alias of aliasToCanonical.keys()) {
    matchers.set(alias, new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
  }

  const violations = [];
  for (const [disp, abs] of files) {
    violations.push(...scanFileForAliases(disp, abs, aliasToCanonical, canonicalToReason, matchers));
  }
  return violations;
}
