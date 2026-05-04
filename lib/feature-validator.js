/**
 * Cross-artifact feature validator.
 *
 * Composes ROADMAP.md row, vision-state.json item, feature.json, feature folder
 * contents, linked artifacts, and cross-feature references. Returns structured
 * findings with severity. Hookable from pre-push.
 *
 * COMP-MCP-VALIDATE — sub-ticket #7 of COMP-MCP-FEATURE-MGMT.
 *
 * Public exports:
 *   validateFeature(cwd, code, options?) → { scope, feature_code, validated_at, findings: [...] }
 *   validateProject(cwd, options?) → { scope, validated_at, findings: [...] }
 *
 * Each finding: { severity: 'error'|'warning'|'info', kind, feature_code?, detail, source? }.
 *
 * Catalog (27 kinds): see docs/features/COMP-MCP-VALIDATE/design.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_CODE_RE_STRICT, validateCode } from './feature-code.js';
import { parseRoadmap } from './roadmap-parser.js';
import { listFeatures, readFeature } from './feature-json.js';
import { ArtifactManager } from '../server/artifact-manager.js';
import { SchemaValidator } from '../server/schema-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FEATURE_JSON_SCHEMA   = path.resolve(__dirname, '../contracts/feature-json.schema.json');
const VISION_STATE_SCHEMA   = path.resolve(__dirname, '../contracts/vision-state.schema.json');
const ROADMAP_ROW_SCHEMA    = path.resolve(__dirname, '../contracts/roadmap-row.schema.json');

const DEFAULT_PATHS = { docs: 'docs', features: 'docs/features', journal: 'docs/journal' };

const TERMINAL_STATUSES = new Set(['KILLED', 'SUPERSEDED']);
const VALID_STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE', 'SUPERSEDED', 'PARKED', 'BLOCKED', 'KILLED']);

const _validatorCache = {};
function getValidator(schemaPath) {
  if (!_validatorCache[schemaPath]) _validatorCache[schemaPath] = new SchemaValidator(schemaPath);
  return _validatorCache[schemaPath];
}

function nowIso() { return new Date().toISOString(); }

function readProjectConfig(cwd) {
  const configPath = path.join(cwd, '.compose', 'compose.json');
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return null; }
}

function resolveProjectPaths(cwd) {
  const cfg = readProjectConfig(cwd);
  const paths = (cfg && cfg.paths) || DEFAULT_PATHS;
  return {
    roadmap: path.join(cwd, 'ROADMAP.md'),
    visionState: path.join(cwd, '.compose', 'data', 'vision-state.json'),
    features: path.join(cwd, paths.features || DEFAULT_PATHS.features),
    journal: path.join(cwd, paths.journal || DEFAULT_PATHS.journal),
    changelog: path.join(cwd, 'CHANGELOG.md'),
  };
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

function loadValidationContext(cwd, options = {}) {
  const paths = resolveProjectPaths(cwd);

  // ROADMAP — direct table-row scan. Validator can't depend on parseRoadmap()
  // alone because lib/roadmap-parser.js:15 requires codes to end in -\d+
  // (STRAT-1, COMP-UI-3). Codes like COMP-MCP-PUBLISH end with non-numeric
  // suffixes and become _anon_*.
  //
  // Column-aware: parse the header row of each table to lock column indices
  // for "Feature" (code) and "Status". This avoids false positives where
  // status values (PARTIAL, COMPLETE) match the strict code regex, or where
  // descriptions contain code-like uppercase tokens.
  let roadmapRows = [];
  try {
    const text = fs.readFileSync(options.roadmapPath || paths.roadmap, 'utf8');
    let phaseId = '';
    let position = 0;
    let codeIdx = -1, statusIdx = -1, descIdx = -1;
    let inTable = false;
    let sawSeparator = false;

    for (const rawLine of text.split('\n')) {
      const phaseMatch = rawLine.match(/^##\s+(.+?)(?:\s+—\s+.+)?$/);
      if (phaseMatch) {
        phaseId = phaseMatch[1].trim();
        inTable = false; sawSeparator = false;
        codeIdx = statusIdx = descIdx = -1;
        continue;
      }
      const rowMatch = rawLine.match(/^\|(.+)\|\s*$/);
      if (!rowMatch) { inTable = false; sawSeparator = false; continue; }

      const cols = rowMatch[1].split('|').map((c) => c.trim());

      // Detect header row by column names. Recognize common column-name variants
      // (feature/code/item/name) and (status/state) so non-canonical tables that
      // still follow the convention are picked up (per Codex iter 1).
      const lower = cols.map((c) => c.toLowerCase());
      const featureColIdx = lower.findIndex((c) => ['feature', 'code', 'item', 'name'].includes(c));
      const statusColIdx  = lower.findIndex((c) => ['status', 'state'].includes(c));
      if (featureColIdx >= 0 && statusColIdx >= 0) {
        codeIdx = featureColIdx;
        statusIdx = statusColIdx;
        descIdx = lower.findIndex((c) => ['description', 'desc'].includes(c));
        inTable = true; sawSeparator = false;
        continue;
      }
      // Separator row (---|---|---)
      if (cols.every((c) => /^[-:]+$/.test(c))) {
        if (inTable) sawSeparator = true;
        continue;
      }
      // Data rows only after we've seen header + separator and have valid indices.
      if (!inTable || !sawSeparator || codeIdx < 0 || statusIdx < 0) continue;
      if (codeIdx >= cols.length || statusIdx >= cols.length) continue;

      const codeRaw = cols[codeIdx].replace(/\*/g, '').replace(/`/g, '').trim();
      if (!FEATURE_CODE_RE_STRICT.test(codeRaw)) continue;
      const status = cols[statusIdx].replace(/\*/g, '').trim();
      const description = descIdx >= 0 && descIdx < cols.length ? cols[descIdx] : '';
      position += 1;
      roadmapRows.push({ code: codeRaw, description, status, phaseId, position });
    }
  } catch (err) { /* ROADMAP missing — handled per-feature */ }

  const roadmapByCode = new Map(roadmapRows.map((r) => [r.code, r]));

  // Vision state
  let visionItems = [];
  let visionStateRaw = null;
  try {
    visionStateRaw = JSON.parse(fs.readFileSync(paths.visionState, 'utf8'));
    visionItems = Array.isArray(visionStateRaw.items) ? visionStateRaw.items : [];
  } catch { /* missing — handled per-feature */ }

  const visionByCode = new Map();
  for (const item of visionItems) {
    const code = item.lifecycle?.featureCode || item.featureCode;
    if (code && FEATURE_CODE_RE_STRICT.test(code)) visionByCode.set(code, item);
  }

  // Feature folders
  const foldersByCode = new Map();
  if (fs.existsSync(paths.features)) {
    for (const dirent of fs.readdirSync(paths.features, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const code = dirent.name;
      if (!FEATURE_CODE_RE_STRICT.test(code)) continue;
      const dir = path.join(paths.features, code);
      const files = new Set();
      try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) files.add(e.name); } catch {}
      const stat = fs.statSync(dir);
      foldersByCode.set(code, {
        dir,
        files,
        hasFeatureJson: files.has('feature.json'),
        hasKilled: files.has('killed.md'),
        mtime: stat.mtimeMs,
      });
    }
  }

  return {
    cwd,
    paths,
    options,
    roadmapByCode,
    visionByCode,
    visionItems,
    visionStateRaw,
    foldersByCode,
    externalPrefixes: options.externalPrefixes || [],
    featureJsonMode: options.featureJsonMode !== false,
  };
}

function loadFeatureContext(cwd, code, ctx) {
  const folder = ctx.foldersByCode.get(code);
  let featureJson = null;
  if (folder?.hasFeatureJson && ctx.featureJsonMode) {
    // Read directly using the configured features path. readFeature() in
    // lib/feature-json.js hardcodes docs/features and would miss configured
    // overrides — fixed per Codex iter 1.
    try {
      const txt = fs.readFileSync(path.join(folder.dir, 'feature.json'), 'utf8');
      featureJson = JSON.parse(txt);
    } catch { featureJson = null; }
  }
  const roadmap = ctx.roadmapByCode.get(code);
  const vision = ctx.visionByCode.get(code);
  const killed = !!folder?.hasKilled;
  return { code, folder, featureJson, roadmap, vision, killed };
}

// ---------------------------------------------------------------------------
// Finding factory
// ---------------------------------------------------------------------------

function finding(severity, kind, code, detail, source) {
  const f = { severity, kind, detail };
  if (code) f.feature_code = code;
  if (source) f.source = source;
  return f;
}

// ---------------------------------------------------------------------------
// Per-feature checks
// ---------------------------------------------------------------------------

function runKilledModeChecks(fctx, findings) {
  const { code, folder, roadmap, vision, featureJson } = fctx;
  // KILLED_STATUS_NOT_TERMINAL
  const statuses = [];
  if (roadmap?.status) statuses.push({ src: 'roadmap', val: String(roadmap.status).toUpperCase() });
  if (featureJson?.status) statuses.push({ src: 'feature.json', val: String(featureJson.status).toUpperCase() });
  if (vision?.status) statuses.push({ src: 'vision-state', val: String(vision.status).toUpperCase() });
  for (const s of statuses) {
    if (!TERMINAL_STATUSES.has(s.val)) {
      findings.push(finding('error', 'KILLED_STATUS_NOT_TERMINAL', code,
        `${s.src} status is ${s.val} but killed.md is present; expected KILLED or SUPERSEDED`));
    }
  }
  // KILLED_SUCCESSOR_NOT_LINKED
  try {
    const killedText = fs.readFileSync(path.join(folder.dir, 'killed.md'), 'utf8');
    const candidateCodes = new Set();
    const re = /\b([A-Z][A-Z0-9-]*[A-Z0-9])\b/g;
    let m;
    while ((m = re.exec(killedText))) {
      const candidate = m[1];
      if (candidate !== code && FEATURE_CODE_RE_STRICT.test(candidate)) candidateCodes.add(candidate);
    }
    if (candidateCodes.size > 0) {
      const links = featureJson?.links || [];
      const supersedes = new Set(links.filter((l) => l.kind === 'supersedes').map((l) => l.to_code));
      const matched = [...candidateCodes].some((c) => supersedes.has(c));
      if (!matched) {
        findings.push(finding('warning', 'KILLED_SUCCESSOR_NOT_LINKED', code,
          `killed.md mentions ${[...candidateCodes].join(', ')} but no link with kind 'supersedes' targets any of them`));
      }
    }
  } catch { /* killed.md not readable — skip */ }
}

function runSchemaChecks(fctx, ctx, findings) {
  const { code, featureJson, vision, roadmap } = fctx;
  if (featureJson) {
    const v = getValidator(FEATURE_JSON_SCHEMA);
    const r = v.validateRoot(featureJson);
    if (!r.valid) {
      for (const e of r.errors) {
        findings.push(finding('error', 'FEATURE_JSON_SCHEMA_VIOLATION', code,
          `${e.instancePath || '/'}: ${e.message}`));
      }
    }
  }
  if (vision) {
    // Validate the vision-state item against the Item subschema. Compose Ajv-friendly
    // ref against the loaded schema's $defs.
    const v = getValidator(VISION_STATE_SCHEMA);
    if (!v._itemValidator) {
      try {
        v._itemValidator = v.ajv.compile({ $ref: `${v.schema.$id}#/definitions/Item` });
      } catch { v._itemValidator = null; }
    }
    if (v._itemValidator) {
      const ok = v._itemValidator(vision);
      if (!ok) {
        for (const e of (v._itemValidator.errors || [])) {
          findings.push(finding('error', 'VISION_STATE_SCHEMA_VIOLATION', code,
            `${e.instancePath || '/'}: ${e.message}`));
        }
      }
    }
  }
  if (roadmap) {
    const v = getValidator(ROADMAP_ROW_SCHEMA);
    const r = v.validateRoot(roadmap);
    if (!r.valid) {
      for (const e of r.errors) {
        findings.push(finding('warning', 'ROADMAP_ROW_SCHEMA_VIOLATION', code,
          `${e.instancePath || '/'}: ${e.message}`));
      }
    }
  }
}

function normalizeStatus(s) {
  if (!s) return null;
  return String(s).toUpperCase();
}

function runStateMismatchChecks(fctx, findings) {
  const { code, roadmap, vision, featureJson } = fctx;
  const rStatus = normalizeStatus(roadmap?.status);
  const fStatus = normalizeStatus(featureJson?.status);
  const vStatus = normalizeStatus(vision?.status);
  // Status mismatches: error when both sources are post-PLANNED (real drift in
  // active or shipped work). Warning when one side is PLANNED (commonly stale
  // vision-state for shipped features — migration debt).
  function statusSeverity(a, b) {
    return (a === 'PLANNED' || b === 'PLANNED') ? 'warning' : 'error';
  }
  if (rStatus && fStatus && rStatus !== fStatus) {
    findings.push(finding(statusSeverity(rStatus, fStatus),
      'STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON', code,
      `ROADMAP says ${rStatus}, feature.json says ${fStatus}`));
  }
  if (rStatus && vStatus && rStatus !== vStatus) {
    findings.push(finding(statusSeverity(rStatus, vStatus),
      'STATUS_MISMATCH_ROADMAP_VS_VISION_STATE', code,
      `ROADMAP says ${rStatus}, vision-state says ${vStatus}`));
  }
  if (fStatus && vStatus && fStatus !== vStatus) {
    findings.push(finding(statusSeverity(fStatus, vStatus),
      'STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE', code,
      `feature.json says ${fStatus}, vision-state says ${vStatus}`));
  }
  // CONTRADICTORY_PHASE_CLAIM
  const fPhase = featureJson?.phase || featureJson?.lifecycle?.currentPhase;
  const vPhase = vision?.phase || vision?.lifecycle?.currentPhase;
  if (fPhase && vPhase && fPhase !== vPhase) {
    findings.push(finding('error', 'CONTRADICTORY_PHASE_CLAIM', code,
      `feature.json phase '${fPhase}' vs vision-state phase '${vPhase}'`));
  }
  // COMPLEXITY_OR_DESCRIPTION_DRIFT
  if (roadmap && featureJson) {
    if (roadmap.description && featureJson.description &&
        roadmap.description.trim() !== featureJson.description.trim() &&
        // Tolerate ROADMAP descriptions being truncated with "..."
        !roadmap.description.endsWith('...')) {
      findings.push(finding('warning', 'COMPLEXITY_OR_DESCRIPTION_DRIFT', code,
        `ROADMAP description differs from feature.json description`));
    }
  }
}

function runFolderRoadmapLinkageChecks(fctx, ctx, findings) {
  const { code, folder, roadmap, vision, featureJson } = fctx;
  const rStatus = normalizeStatus(roadmap?.status);

  if (roadmap && !folder) {
    // Severity model for missing folder:
    //   IN_PROGRESS         → error (active work without a tracking artifact)
    //   PARTIAL / BLOCKED   → warning (sub-tickets may live elsewhere; partial progress)
    //   PLANNED             → warning (un-started work)
    //   COMPLETE / SUPERSEDED / KILLED / PARKED / unknown → warning (historical baseline)
    if (rStatus === 'IN_PROGRESS') {
      findings.push(finding('error', 'ROADMAP_ROW_WITHOUT_FOLDER', code,
        `ROADMAP row status is IN_PROGRESS (active work) but no folder exists`));
    } else {
      findings.push(finding('warning', 'ROADMAP_ROW_WITHOUT_FOLDER', code,
        `ROADMAP row status is ${rStatus || 'unknown'} but no folder (legacy/partial/planned baseline)`));
    }
  }
  if (folder && !roadmap) {
    findings.push(finding('warning', 'FOLDER_WITHOUT_ROADMAP_ROW', code,
      `Feature folder exists but no row in ROADMAP.md`));
  }
  if (folder && !folder.hasFeatureJson && ctx.featureJsonMode) {
    findings.push(finding('info', 'FOLDER_WITHOUT_FEATURE_JSON', code,
      `Feature folder exists but no feature.json`));
  }
  // EMPTY_FEATURE_FOLDER — folder has no design/plan/blueprint and no killed.md.
  // Silent exemption for folders younger than 24h (mtime).
  if (folder && !folder.hasKilled) {
    const hasContent = ['design.md', 'plan.md', 'blueprint.md', 'prd.md', 'architecture.md', 'report.md']
      .some((f) => folder.files.has(f));
    if (!hasContent) {
      const ageMs = Date.now() - folder.mtime;
      if (ageMs > 24 * 60 * 60 * 1000) {
        findings.push(finding('warning', 'EMPTY_FEATURE_FOLDER', code,
          `Feature folder has no canonical artifacts (design/plan/blueprint/prd/architecture/report)`));
      }
    }
  }
}

function runArtifactLinkChecks(fctx, ctx, findings) {
  const { code, folder, featureJson } = fctx;
  if (!folder) return;
  const featureRootArg = ctx.paths.features;
  const am = new ArtifactManager(featureRootArg);
  let assessment = null;
  try { assessment = am.assess(code); } catch { /* fall through */ }

  // MISSING_DESIGN_ARTIFACT — error for active work, warning for COMPLETE (legacy may not have design.md).
  const status = normalizeStatus(featureJson?.status) || normalizeStatus(fctx.roadmap?.status);
  const ACTIVE_STATUSES = new Set(['IN_PROGRESS', 'PARTIAL', 'BLOCKED']);
  if (status && !folder.files.has('design.md')) {
    if (ACTIVE_STATUSES.has(status)) {
      findings.push(finding('error', 'MISSING_DESIGN_ARTIFACT', code,
        `Feature is ${status} (active work) but design.md is missing`));
    } else if (status === 'COMPLETE') {
      findings.push(finding('warning', 'MISSING_DESIGN_ARTIFACT', code,
        `Feature is COMPLETE but design.md is missing (legacy migration debt; current writers do not enforce this retroactively)`));
    }
    // PLANNED / SUPERSEDED / KILLED / PARKED — no finding (expected baseline)
  }
  // MISSING_COMPLETION_REPORT (warning, COMPLETE)
  if (status === 'COMPLETE' && !folder.files.has('report.md')) {
    findings.push(finding('warning', 'MISSING_COMPLETION_REPORT', code,
      `Feature is COMPLETE but report.md is missing (current writers do not enforce this; warning only)`));
  }

  // DANGLING_ARTIFACT_LINK + ARTIFACT_OUTSIDE_FEATURE_FOLDER
  const links = featureJson?.artifacts || [];
  for (const a of links) {
    const artPath = a.path && path.isAbsolute(a.path) ? a.path : path.join(ctx.cwd, a.path || '');
    if (a.path && !fs.existsSync(artPath)) {
      findings.push(finding('error', 'DANGLING_ARTIFACT_LINK', code,
        `Linked ${a.type || 'artifact'} path does not exist: ${a.path}`));
    }
    if (a.path && a.type !== 'journal' && a.type !== 'snapshot') {
      // Boundary-aware check with .. normalization: paths like
      // /root/docs/features/FEAT-1/../FEAT-2/plan.md resolve outside FEAT-1
      // even though they syntactically start with the folder path. Resolve
      // both sides before comparing (per Codex iter 2).
      const normArt = path.resolve(artPath);
      const normFolder = path.resolve(folder.dir);
      const inFolder = normArt === normFolder || normArt.startsWith(normFolder + path.sep);
      if (!inFolder) {
        findings.push(finding('error', 'ARTIFACT_OUTSIDE_FEATURE_FOLDER', code,
          `Linked ${a.type} ${a.path} is not under ${path.relative(ctx.cwd, folder.dir)}`));
      }
    }
  }
}

function runCrossFeatureRefChecks(fctx, ctx, findings) {
  const { code, featureJson } = fctx;
  if (!featureJson?.links) return;
  for (const link of featureJson.links) {
    if (!link.to_code) continue;
    const target = ctx.foldersByCode.has(link.to_code) ||
                   ctx.roadmapByCode.has(link.to_code) ||
                   ctx.visionByCode.has(link.to_code);
    if (!target) {
      findings.push(finding('error', 'DANGLING_LINK_FEATURES_TARGET', code,
        `link kind=${link.kind} → ${link.to_code} does not exist in any source`));
    }
  }
  // UNREFERENCED_FOLLOWUP — design.md mentions a code as parent but no typed link
  const design = path.join(fctx.folder?.dir || '', 'design.md');
  if (fs.existsSync(design)) {
    let text = '';
    try { text = fs.readFileSync(design, 'utf8'); } catch {}
    const linkedTo = new Set((featureJson.links || []).map((l) => l.to_code));
    const matches = text.match(/\bparent[^.]*?([A-Z][A-Z0-9-]*[A-Z0-9])/i);
    if (matches && matches[1] && matches[1] !== code && !linkedTo.has(matches[1])) {
      findings.push(finding('info', 'UNREFERENCED_FOLLOWUP', code,
        `design.md mentions parent ${matches[1]} but no typed link references it`));
    }
  }
  // SUPERSEDED_WITHOUT_LINK — non-killed feature in SUPERSEDED status without a
  // typed `supersedes` link to the successor.
  const status = normalizeStatus(featureJson?.status) || normalizeStatus(fctx.roadmap?.status);
  if (status === 'SUPERSEDED' && !fctx.killed) {
    const links = featureJson?.links || [];
    const hasSupersedes = links.some((l) => l.kind === 'supersedes' && l.to_code);
    if (!hasSupersedes) {
      findings.push(finding('info', 'SUPERSEDED_WITHOUT_LINK', code,
        `Feature is SUPERSEDED but has no link with kind 'supersedes' identifying the successor`));
    }
  }
}

function runCoherenceChecks(fctx, ctx, findings) {
  const { code, featureJson } = fctx;
  // COMPLETION_WITHOUT_CHANGELOG — check at project level, but per-feature too
  const status = normalizeStatus(featureJson?.status) || normalizeStatus(fctx.roadmap?.status);
  if (status === 'COMPLETE' || status === 'PARTIAL') {
    let changelog = '';
    try { changelog = fs.readFileSync(ctx.paths.changelog, 'utf8'); } catch {}
    const headerRe = new RegExp(`^###\\s+${code.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&')}\\b`, 'm');
    if (changelog && !headerRe.test(changelog)) {
      findings.push(finding('warning', 'COMPLETION_WITHOUT_CHANGELOG', code,
        `Feature is ${status} but no CHANGELOG.md entry references the code`));
    }
    // MISSING_COMPLETION_JOURNAL — heuristic: any journal file mentions the code
    if (status === 'COMPLETE') {
      const journalDir = ctx.paths.journal;
      let mentioned = false;
      try {
        for (const f of fs.readdirSync(journalDir)) {
          if (!f.endsWith('.md') || f === 'README.md') continue;
          try {
            const text = fs.readFileSync(path.join(journalDir, f), 'utf8');
            if (text.includes(code)) { mentioned = true; break; }
          } catch {}
        }
      } catch {}
      if (!mentioned) {
        findings.push(finding('warning', 'MISSING_COMPLETION_JOURNAL', code,
          `Feature is COMPLETE but no journal entry references the code`));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Project-level cross-cutting checks
// ---------------------------------------------------------------------------

function runOrphanFolderCheck(ctx, findings) {
  for (const [code, folder] of ctx.foldersByCode) {
    const inRoadmap = ctx.roadmapByCode.has(code);
    const inVision = ctx.visionByCode.has(code);
    if (!inRoadmap && !inVision && !folder.hasKilled) {
      // Downgrade to info for folders matching externalPrefixes
      const isExternal = ctx.externalPrefixes.some((p) => code.startsWith(p));
      const sev = isExternal ? 'info' : 'warning';
      findings.push(finding(sev, 'ORPHAN_FOLDER', code,
        `Feature folder exists but code is in neither ROADMAP nor vision-state`));
    }
  }
}

function runChangelogReferenceCheck(ctx, findings) {
  let text = '';
  try { text = fs.readFileSync(ctx.paths.changelog, 'utf8'); } catch { return; }
  const headerRe = /^###\s+([A-Z][A-Z0-9-]*[A-Z0-9])(?:\s|$)/gm;
  let m;
  while ((m = headerRe.exec(text))) {
    const code = m[1];
    if (!ctx.roadmapByCode.has(code) && !ctx.foldersByCode.has(code) && !ctx.visionByCode.has(code)) {
      // Downgraded from error: many shipped features have CHANGELOG entries without
      // ROADMAP rows or vision-state items (legacy pattern where CHANGELOG is the
      // source of truth for what shipped). Until COMP-FEATURE-FOLDER-BASELINE-CLEANUP
      // lands, this is migration debt, not regression.
      findings.push(finding('warning', 'CHANGELOG_MENTIONS_MISSING_FEATURE', code,
        `CHANGELOG entry header references feature code with no ROADMAP/vision-state/folder (legacy pattern)`));
    }
  }
}

function runJournalIndexDriftCheck(ctx, findings) {
  const indexPath = path.join(ctx.paths.journal, 'README.md');
  let indexText = '';
  try { indexText = fs.readFileSync(indexPath, 'utf8'); } catch { return; }
  const indexedFiles = new Set();
  const linkRe = /\(([\d-]+-session-\d+-[^)]+\.md)\)/g;
  let m;
  while ((m = linkRe.exec(indexText))) indexedFiles.add(m[1]);
  let actualFiles = new Set();
  try {
    for (const f of fs.readdirSync(ctx.paths.journal)) {
      if (f === 'README.md' || !f.endsWith('.md')) continue;
      actualFiles.add(f);
    }
  } catch { return; }
  for (const f of indexedFiles) {
    if (!actualFiles.has(f)) {
      findings.push(finding('error', 'JOURNAL_INDEX_VS_FILES_DRIFT', null,
        `Journal index references ${f} but the file does not exist`));
    }
  }
  for (const f of actualFiles) {
    if (!indexedFiles.has(f)) {
      findings.push(finding('error', 'JOURNAL_INDEX_VS_FILES_DRIFT', null,
        `Journal file ${f} exists but is not in the index`));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function validateFeature(cwd, code, options = {}) {
  validateCode(code);
  const ctx = loadValidationContext(cwd, options);
  const findings = [];

  // FEATURE_NOT_FOUND — uniform shape rather than throw.
  const exists = ctx.foldersByCode.has(code) || ctx.roadmapByCode.has(code) || ctx.visionByCode.has(code);
  if (!exists) {
    findings.push(finding('error', 'FEATURE_NOT_FOUND', code,
      `Feature code is strict-regex-valid but exists in no source (no folder, no ROADMAP row, no vision-state item)`));
    return { scope: 'feature', feature_code: code, validated_at: nowIso(), findings };
  }

  const fctx = loadFeatureContext(cwd, code, ctx);

  if (fctx.killed) {
    runKilledModeChecks(fctx, findings);
    return { scope: 'feature', feature_code: code, validated_at: nowIso(), findings };
  }

  runSchemaChecks(fctx, ctx, findings);
  runStateMismatchChecks(fctx, findings);
  runFolderRoadmapLinkageChecks(fctx, ctx, findings);
  runArtifactLinkChecks(fctx, ctx, findings);
  runCrossFeatureRefChecks(fctx, ctx, findings);
  runCoherenceChecks(fctx, ctx, findings);

  return { scope: 'feature', feature_code: code, validated_at: nowIso(), findings };
}

export async function validateProject(cwd, options = {}) {
  const ctx = loadValidationContext(cwd, options);
  const findings = [];

  const allCodes = new Set([
    ...ctx.roadmapByCode.keys(),
    ...ctx.visionByCode.keys(),
    ...ctx.foldersByCode.keys(),
  ]);

  for (const code of allCodes) {
    if (!FEATURE_CODE_RE_STRICT.test(code)) continue;
    const result = await validateFeature(cwd, code, options);
    findings.push(...result.findings);
  }

  runOrphanFolderCheck(ctx, findings);
  runChangelogReferenceCheck(ctx, findings);
  runJournalIndexDriftCheck(ctx, findings);

  return { scope: 'project', validated_at: nowIso(), findings };
}
