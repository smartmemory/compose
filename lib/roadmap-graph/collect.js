/**
 * collect.js — gather the roadmap-graph node universe + raw edges from a
 * project's feature folders and ROADMAP.md (COMP-ROADMAP-GRAPH-1).
 *
 * Node universe = (feature folders with feature.json) ∪ (real-coded ROADMAP.md
 * rows). feature.json wins on status when both exist; ROADMAP-only features get
 * a warning + minimal display metadata. The union's code set is the dangling
 * oracle for model.buildGraph.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { listFeatures } from '../feature-json.js';
import { loadFeaturesDir, loadExternalPrefixes } from '../project-paths.js';
import { parseRoadmap } from '../roadmap-parser.js';
import { SchemaValidator } from '../../server/schema-validator.js';
import { depsToEdges } from './model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPS_SCHEMA = resolve(__dirname, '../../contracts/roadmap-deps.schema.json');
const FRONTMATTER_SCHEMA = resolve(__dirname, '../../contracts/roadmap-graph-frontmatter.schema.json');

const FM_KEYS = ['name', 'priority', 'track', 'desc'];

/**
 * @param {string} cwd project root
 * @param {string} [featuresDir] relative features dir (default from compose.json)
 * @returns {{ nodes: object[], rawEdges: object[], knownCodes: Set<string>, warnings: string[] }}
 */
export function collectGraphInputs(cwd, featuresDir = loadFeaturesDir(cwd)) {
  const warnings = [];
  const depsValidator = new SchemaValidator(DEPS_SCHEMA);
  const fmValidator = new SchemaValidator(FRONTMATTER_SCHEMA);
  const externalPrefixes = loadExternalPrefixes(cwd);
  const isExternal = (code) => externalPrefixes.some((p) => code.startsWith(p));

  /** @type {Map<string, object>} id -> collected node (rendered features only) */
  const universe = new Map();
  // Codes that exist as cross-project references — known (so deps to them don't
  // dangle) but not rendered as nodes and not warned about.
  const externalCodes = new Set();

  // (a) Feature folders — authoritative source.
  const features = listFeatures(cwd, featuresDir);
  for (const f of features) {
    if (!f || typeof f.code !== 'string') continue;
    // An external-prefixed folder is a cross-project reference living here —
    // known (so edges resolve) but never rendered as one of THIS project's nodes.
    if (isExternal(f.code)) { externalCodes.add(f.code); continue; }
    const folder = join(cwd, featuresDir, f.code);
    const fm = readDisplayMetadata(folder, f, fmValidator, warnings);
    universe.set(f.code, {
      id: f.code,
      status: String(f.status || 'PLANNED').toUpperCase(),
      name: fm.name,
      priority: fm.priority,
      track: fm.track,
      desc: fm.desc,
      _hasFolder: true,
    });
  }

  // (b) ROADMAP.md rows — fallback for features not registered as folders.
  const roadmapPath = join(cwd, 'ROADMAP.md');
  if (existsSync(roadmapPath)) {
    let entries = [];
    try { entries = parseRoadmap(readFileSync(roadmapPath, 'utf-8')); } catch { /* ignore */ }
    for (const e of entries) {
      if (!e.code || e.code.startsWith('_anon_')) continue;
      if (universe.has(e.code)) continue; // folder wins
      if (isExternal(e.code)) { externalCodes.add(e.code); continue; } // cross-project ref
      universe.set(e.code, {
        id: e.code,
        status: String(e.status || 'PLANNED').toUpperCase(),
        name: e.code,
        priority: 'medium',
        track: 'standalone',
        desc: stripMd(e.description || ''),
        _hasFolder: false,
      });
      warnings.push(`${e.code}: unregistered (ROADMAP.md fallback — no feature.json)`);
    }
  }

  // Edges — only feature folders may declare deps.yaml.
  const rawEdges = [];
  for (const f of features) {
    if (!f || typeof f.code !== 'string') continue;
    if (isExternal(f.code)) continue;
    const depsPath = join(cwd, featuresDir, f.code, 'deps.yaml');
    if (!existsSync(depsPath)) continue;
    let deps;
    try {
      deps = parseYaml(readFileSync(depsPath, 'utf-8')) || {};
    } catch (err) {
      warnings.push(`${f.code}: unparseable deps.yaml (${err.message}) — skipped`);
      continue;
    }
    const res = depsValidator.validateRoot(deps);
    if (!res.valid) {
      const msg = res.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
      warnings.push(`${f.code}: invalid deps.yaml (${msg}) — skipped`);
      continue;
    }
    rawEdges.push(...depsToEdges(f.code, deps));
  }

  // An edge endpoint matching an external prefix is a cross-project reference we
  // cannot validate locally — treat it as known (never dangling). The node is
  // not rendered, so model.buildGraph silently drops the edge.
  for (const e of rawEdges) {
    for (const code of [e.from, e.to]) {
      if (!knownLocally(code, universe, externalCodes) && isExternal(code)) externalCodes.add(code);
    }
  }

  const knownCodes = new Set([...universe.keys(), ...externalCodes]);
  return { nodes: [...universe.values()], rawEdges, knownCodes, warnings };
}

function knownLocally(code, universe, externalCodes) {
  return universe.has(code) || externalCodes.has(code);
}

/**
 * Display metadata precedence: design.md YAML frontmatter > feature.json keys >
 * defaults. Returns { name, priority, track, desc }.
 */
function readDisplayMetadata(folder, feature, fmValidator, warnings) {
  const fromFeature = pick(feature, FM_KEYS);
  const fromDesign = readDesignFrontmatter(folder, fmValidator, feature.code, warnings);
  const merged = { ...fromFeature, ...fromDesign };
  return {
    name: merged.name || firstLine(feature.description) || feature.code,
    priority: merged.priority,
    track: merged.track,
    desc: merged.desc || stripMd(feature.description || ''),
  };
}

function readDesignFrontmatter(folder, fmValidator, code, warnings) {
  const designPath = join(folder, 'design.md');
  if (!existsSync(designPath)) return {};
  const text = readFileSync(designPath, 'utf-8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  let data;
  try { data = parseYaml(m[1]) || {}; } catch { return {}; }
  if (typeof data !== 'object' || Array.isArray(data)) return {};
  const res = fmValidator.validateRoot(data);
  if (!res.valid) {
    warnings.push(`${code}: invalid design.md frontmatter — ignored`);
    return {};
  }
  return pick(data, FM_KEYS);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

function firstLine(s) {
  return stripMd(String(s || '').split('\n')[0] || '').trim();
}

// Strip the heaviest markdown so node names/descs render cleanly as plain text.
function stripMd(s) {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*#+\s*/, '')
    .trim();
}
