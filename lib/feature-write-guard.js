/**
 * feature-write-guard.js — Write-time feature.json validation (COMP-MCP-VALIDATE-1).
 *
 * The feature.json schema (contracts/feature-json.schema.json) and the
 * cross-reference existence rule were historically enforced ONLY on read, by
 * lib/feature-validator.js. This module enforces the SAME rules at write time so
 * malformed shape / invalid link kind / dangling to_code is rejected before
 * commit — closing the source of FEATURE_JSON_SCHEMA_VIOLATION and
 * DANGLING_LINK_FEATURES_TARGET.
 *
 * Layering: imports only the Ajv SchemaValidator (server/) and the feature-code
 * regex. It does NOT import feature-json.js, feature-validator.js, or
 * feature-writer.js — those import this module, so this stays a leaf to keep the
 * graph acyclic.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SchemaValidator } from '../server/schema-validator.js';
import { FEATURE_CODE_RE_STRICT } from './feature-code.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../contracts/feature-json.schema.json');

// Memoize the compiled validator (the schema is static). This is the only thing
// safe to cache — code-existence sources change at runtime and are read fresh.
let _validator = null;
function validator() {
  if (!_validator) _validator = new SchemaValidator(SCHEMA_PATH);
  return _validator;
}

/**
 * Thrown when a feature.json write would persist invalid data.
 * `kind` mirrors the read validator's finding kinds so callers can branch.
 */
export class FeatureWriteValidationError extends Error {
  /**
   * @param {'FEATURE_JSON_SCHEMA_VIOLATION'|'DANGLING_LINK_FEATURES_TARGET'} kind
   * @param {string[]} violations
   */
  constructor(kind, violations) {
    super(`${kind}: ${violations.join('; ')}`);
    this.name = 'FeatureWriteValidationError';
    this.kind = kind;
    this.violations = violations;
  }
}

/**
 * Validate a feature's `links[]` against the canonical JSON schema. Throws
 * FeatureWriteValidationError('FEATURE_JSON_SCHEMA_VIOLATION') for any link-shape
 * violation (bad `kind` enum, missing `to_code` on a non-external link, malformed
 * external-link provider fields, …).
 *
 * SCOPE (COMP-MCP-VALIDATE-1): only `/links/*` violations are enforced at write
 * time. Whole-object schema tightening — `complexity` enum convergence, the
 * `artifacts[].type` enum, `additionalProperties` — is **deliberately deferred**
 * to COMP-MCP-VALIDATE-SCHEMA-TIGHTEN (see contracts/feature-json.schema.json
 * field comments), and the writers legitimately produce values that pass only
 * the permissive read schema today. -1 closes the link-kind / link-shape source
 * named in its charter, nothing wider.
 *
 * @param {object} feature
 */
export function assertValidLinkShape(feature) {
  const { valid, errors } = validator().validateRoot(feature);
  if (valid) return;
  const linkErrors = (errors || []).filter((e) => (e.instancePath || '').startsWith('/links'));
  if (linkErrors.length === 0) return;
  throw new FeatureWriteValidationError(
    'FEATURE_JSON_SCHEMA_VIOLATION',
    linkErrors.map((e) => `${e.instancePath}: ${e.message}`),
  );
}

function resolvePaths(cwd) {
  let featuresRel = 'docs/features';
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    if (cfg?.paths?.features) featuresRel = cfg.paths.features;
  } catch { /* no config — use defaults (mirrors resolveProjectPaths) */ }
  return {
    features: join(cwd, featuresRel),
    roadmap: join(cwd, 'ROADMAP.md'),
    visionState: join(cwd, '.compose', 'data', 'vision-state.json'),
  };
}

/**
 * Strict feature codes present in a ROADMAP.md table. Self-contained, lean
 * mirror of the validator's column-aware scan (lib/feature-validator.js:144-202)
 * — NOT extracted from it, because that loop is dual-purpose (it also builds
 * citationRows for XREF parsing). We need only the code set.
 *
 * @param {string} roadmapPath
 * @returns {string[]}
 */
export function scanRoadmapRows(roadmapPath) {
  const codes = [];
  let text;
  try { text = readFileSync(roadmapPath, 'utf8'); } catch { return codes; }

  let codeIdx = -1, statusIdx = -1;
  let inTable = false, sawSeparator = false;
  for (const rawLine of text.split('\n')) {
    if (/^##\s+/.test(rawLine)) { inTable = false; sawSeparator = false; codeIdx = statusIdx = -1; continue; }
    const rowMatch = rawLine.match(/^\|(.+)\|\s*$/);
    if (!rowMatch) { inTable = false; sawSeparator = false; continue; }
    const cols = rowMatch[1].split('|').map((c) => c.trim());
    const lower = cols.map((c) => c.toLowerCase());
    const featureColIdx = lower.findIndex((c) => ['feature', 'code', 'item', 'name'].includes(c));
    const statusColIdx = lower.findIndex((c) => ['status', 'state'].includes(c));
    if (featureColIdx >= 0 && statusColIdx >= 0) {
      codeIdx = featureColIdx; statusIdx = statusColIdx; inTable = true; sawSeparator = false; continue;
    }
    if (cols.every((c) => /^[-:]+$/.test(c))) { if (inTable) sawSeparator = true; continue; }
    if (!inTable || !sawSeparator || codeIdx < 0 || codeIdx >= cols.length) continue;
    const codeRaw = cols[codeIdx].replace(/\*/g, '').replace(/`/g, '').trim();
    if (FEATURE_CODE_RE_STRICT.test(codeRaw)) codes.push(codeRaw);
  }
  return codes;
}

/**
 * The set of feature codes that "exist" in any authoritative source — feature
 * folders, ROADMAP rows, or vision-state items. Mirrors the union the read
 * validator's dangling-link check consults (foldersByCode ∪ roadmapByCode ∪
 * visionByCode). Read fresh every call (no memo): ROADMAP and vision-state
 * change independently of feature writes in long-lived processes.
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
export function knownFeatureCodes(cwd) {
  const paths = resolvePaths(cwd);
  const codes = new Set();

  // Feature folders
  if (existsSync(paths.features)) {
    for (const dirent of readdirSync(paths.features, { withFileTypes: true })) {
      if (dirent.isDirectory() && FEATURE_CODE_RE_STRICT.test(dirent.name)) codes.add(dirent.name);
    }
  }

  // ROADMAP rows
  for (const code of scanRoadmapRows(paths.roadmap)) codes.add(code);

  // Vision-state items
  try {
    const vs = JSON.parse(readFileSync(paths.visionState, 'utf8'));
    for (const item of (Array.isArray(vs.items) ? vs.items : [])) {
      const code = item?.lifecycle?.featureCode || item?.featureCode;
      if (code && FEATURE_CODE_RE_STRICT.test(code)) codes.add(code);
    }
  } catch { /* missing vision-state — folders/roadmap still apply */ }

  return codes;
}

/**
 * Assert every same-project link target (non-external to_code) that this write
 * INTRODUCES exists. No-op (zero I/O) when the feature carries no such links —
 * the common write.
 *
 * Delta-aware: only links not already present in `opts.priorLinks` (the on-disk
 * version) are checked. This is the correct write-time semantic — reject new
 * drift, not pre-existing state — and it makes a legitimately forced
 * forward-reference durable: once persisted, later unrelated writes (status,
 * completions, build lifecycle) re-run this guard but skip the now-existing
 * link, so they don't spuriously throw `DANGLING_LINK_FEATURES_TARGET`.
 *
 * Throws FeatureWriteValidationError('DANGLING_LINK_FEATURES_TARGET') for any
 * newly-introduced missing target unless opts.allowForwardRefs is set (the
 * explicit force path that introduces the forward-reference in the first place).
 *
 * @param {string} cwd
 * @param {object} feature
 * @param {{allowForwardRefs?: boolean, priorLinks?: Array}} [opts]
 */
export function assertLinkTargetsExist(cwd, feature, opts = {}) {
  if (opts.allowForwardRefs) return;
  const links = Array.isArray(feature?.links) ? feature.links : [];
  const prior = Array.isArray(opts.priorLinks) ? opts.priorLinks : [];
  const isPrior = (l) => prior.some((p) => p.kind === l.kind && p.to_code === l.to_code);
  const targets = links
    .filter((l) => l && l.kind !== 'external' && typeof l.to_code === 'string')
    .filter((l) => !isPrior(l)) // only newly-introduced links
    .map((l) => l.to_code);
  if (targets.length === 0) return; // cheap path — no scan

  const known = knownFeatureCodes(cwd);
  const missing = targets.filter((code) => code !== feature.code && !known.has(code));
  if (missing.length > 0) {
    throw new FeatureWriteValidationError(
      'DANGLING_LINK_FEATURES_TARGET',
      missing.map((code) => `${code} does not exist in any source`),
    );
  }
}
