/**
 * feature-scan.js — Scan feature folders and seed vision store.
 *
 * Scans docs/features/ (or custom path from config) and builds rich feature
 * records from the artifacts found:
 *   - Status parsed from design.md / plan.md / report.md frontmatter
 *   - Description from first non-heading paragraph
 *   - Artifact completeness assessment (confidence score)
 *   - Related features extracted from document cross-references
 *   - Sub-package detection (top-level dirs with README.md)
 *
 * Routes: GET /api/features/scan, POST /api/features/seed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { getTargetRoot, resolveProjectPath } from './project-root.js';
import { relForDisplay } from '../lib/project-paths.js';
import { assertValidLinkShape } from '../lib/feature-write-guard.js';
import { depsToEdges } from '../lib/roadmap-graph/model.js';

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

const STATUS_RE = /^\*\*Status:\*\*\s*(.+)$/im;
const DATE_RE = /^\*\*Date:\*\*\s*(.+)$/im;
const FEATURE_ID_RE = /^\*\*Feature\s*ID:\*\*\s*`?([^`\n]+)`?/im;
const RELATED_DOC_RE = /\[.*?\]\(\.\.\/([\w-]+)\//g;
// Match `**Predecessor:** CODE` and `**Successor:** CODE` lines in design docs.
// Captures the feature code (CODE_RE-shaped) optionally with parenthetical
// suffix like `COMP-WORKSPACE-{VISION,SESSIONS}` — we only take the bare code.
const PREDECESSOR_RE = /^\*\*Predecessor:\*\*\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b/gim;
const SUCCESSOR_RE   = /^\*\*Successor:\*\*\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b/gim;

/**
 * Parse markdown frontmatter-style metadata from a file.
 * Looks for **Key:** Value patterns in the first 30 lines.
 */
function parseMetadata(content) {
  const meta = {};
  const statusMatch = content.match(STATUS_RE);
  if (statusMatch) meta.status = statusMatch[1].trim();

  const dateMatch = content.match(DATE_RE);
  if (dateMatch) meta.date = dateMatch[1].trim();

  const idMatch = content.match(FEATURE_ID_RE);
  if (idMatch) meta.featureId = idMatch[1].trim();

  return meta;
}

/**
 * Extract related feature codes from markdown cross-references.
 * Matches patterns like [text](../FEATURE-CODE/file.md)
 */
function parseRelatedFeatures(content) {
  const related = new Set();
  let match;
  const re = new RegExp(RELATED_DOC_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    related.add(match[1]);
  }
  return [...related];
}

// Returns { predecessors: string[], successors: string[] } from `**Predecessor:**`
// and `**Successor:**` lines in design.md prose.
function parseSequenceRefs(content) {
  const predecessors = new Set();
  const successors = new Set();
  let m;
  const pre = new RegExp(PREDECESSOR_RE.source, 'gim');
  while ((m = pre.exec(content)) !== null) predecessors.add(m[1]);
  const suc = new RegExp(SUCCESSOR_RE.source, 'gim');
  while ((m = suc.exec(content)) !== null) successors.add(m[1]);
  return { predecessors: [...predecessors], successors: [...successors] };
}

/**
 * Map free-text status strings to vision store status keys.
 */
function normalizeStatus(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[^a-z_\s]/g, '').trim();
  if (lower.includes('complete') || lower.includes('done') || lower.includes('shipped')) return 'complete';
  if (lower.includes('in progress') || lower.includes('in_progress') || lower.includes('active')) return 'in_progress';
  if (lower.includes('partial')) return 'in_progress';
  if (lower.includes('blocked')) return 'blocked';
  if (lower.includes('parked') || lower.includes('paused')) return 'parked';
  if (lower.includes('killed') || lower.includes('cancelled') || lower.includes('superseded')) return 'killed';
  if (lower.includes('review')) return 'review';
  if (lower.includes('ready')) return 'ready';
  return null;
}

/**
 * Infer lifecycle phase from which artifacts exist.
 */
function inferPhase(artifacts) {
  if (artifacts.includes('report.md')) return 'verification';
  if (artifacts.includes('plan.md')) return 'planning';
  if (artifacts.includes('blueprint.md')) return 'planning';
  if (artifacts.includes('architecture.md')) return 'specification';
  if (artifacts.includes('prd.md')) return 'specification';
  if (artifacts.includes('design.md')) return 'planning';
  return 'vision';
}

/**
 * Compute a 0–3 confidence score based on artifact completeness.
 *   0 = no artifacts, 1 = some exist, 2 = key artifacts present, 3 = full set
 */
function computeConfidence(artifacts) {
  if (artifacts.length === 0) return 0;
  const key = ['design.md', 'plan.md'];
  const hasKey = key.filter(k => artifacts.includes(k)).length;
  if (artifacts.length >= 4 && hasKey === 2) return 3;
  if (hasKey >= 1 && artifacts.length >= 2) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Scan feature folders and return structured feature data.
 *
 * Each subdirectory of the features path is a feature. Reads metadata from
 * design.md, plan.md, report.md. Detects relationships from cross-references.
 *
 * @param {string} [featuresDir] — absolute path to features directory
 * @returns {Array<Feature>}
 */
export function scanFeatures(featuresDir) {
  const dir = featuresDir || resolveProjectPath('features');
  if (!fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const features = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const featureDir = path.join(dir, entry.name);
    const feature = {
      name: entry.name,
      description: '',
      status: null,
      date: null,
      phase: 'planning',
      confidence: 0,
      artifacts: [],
      relatedFeatures: [],
      predecessors: [],
      successors: [],
      group: null,  // explicit group from feature.json overrides derivation
      priority: null, // track/priority from design.md frontmatter (COMP-ROADMAP-GRAPH-2)
      deps: null,   // { depends_on?, blocks?, concurrent_with? } from deps.yaml
      hasFeatureJson: false, // feature.json present = a managed feature (canon)
    };

    // Read feature.json if present — supplies optional explicit `group`,
    // and may override description/status if more authoritative than the docs.
    try {
      const specPath = path.join(featureDir, 'feature.json');
      if (fs.existsSync(specPath)) {
        feature.hasFeatureJson = true;
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
        if (typeof spec.group === 'string' && spec.group.trim()) {
          feature.group = spec.group.trim();
        }
        // feature.json is canon for status. Set it first (highest precedence) so
        // the design.md prose loop below cannot override it — the vision store
        // is a managed projection of feature.json, not a thing that drifts from
        // it (COMP-ROADMAP-GRAPH-2: kills the feature.json/cockpit status de-sync).
        if (typeof spec.status === 'string' && spec.status.trim()) {
          feature.status = normalizeStatus(spec.status);
        }
      }
    } catch { /* ignore malformed feature.json */ }

    // COMP-ROADMAP-GRAPH-2 (S3): absorb the static collector's edge + track
    // metadata so a seeded store renders the same canonical graph.
    // deps.yaml -> typed dependency edges.
    try {
      const depsPath = path.join(featureDir, 'deps.yaml');
      if (fs.existsSync(depsPath)) {
        const deps = parseYaml(fs.readFileSync(depsPath, 'utf-8')) || {};
        if (deps && typeof deps === 'object' && !Array.isArray(deps)) feature.deps = deps;
      }
    } catch { /* unparseable deps.yaml — skip edges for this feature */ }

    // design.md YAML frontmatter `track`/`priority` (collect.js precedence:
    // frontmatter track > feature.json group). Rare, but kept faithful.
    try {
      const designPath = path.join(featureDir, 'design.md');
      if (fs.existsSync(designPath)) {
        const m = fs.readFileSync(designPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
        if (m) {
          const fm = parseYaml(m[1]) || {};
          if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
            if (typeof fm.track === 'string' && fm.track.trim()) feature.group = fm.track.trim();
            if (typeof fm.priority === 'string' && fm.priority.trim()) feature.priority = fm.priority.trim();
          }
        }
      }
    } catch { /* invalid frontmatter — ignore */ }

    // List artifacts
    try {
      feature.artifacts = fs.readdirSync(featureDir)
        .filter(f => f.endsWith('.md'))
        .sort();
    } catch { /* skip */ }

    // Read metadata from docs in priority order
    const docPriority = ['design.md', 'spec.md', 'plan.md', 'report.md', 'prd.md'];
    let gotDescription = false;
    const allRelated = new Set();

    for (const docFile of docPriority) {
      const filePath = path.join(featureDir, docFile);
      if (!fs.existsSync(filePath)) continue;

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const meta = parseMetadata(raw);

        // First status found wins
        if (!feature.status && meta.status) {
          feature.status = normalizeStatus(meta.status);
        }
        if (!feature.date && meta.date) {
          feature.date = meta.date;
        }

        // Description: first non-heading paragraph from first available doc
        if (!gotDescription) {
          const lines = raw.split('\n');
          const descLines = [];
          let pastHeading = false;
          for (const line of lines) {
            const trimmed = line.trim();
            // Skip metadata lines like **Status:** etc.
            if (trimmed.startsWith('**') && trimmed.includes(':**')) continue;
            if (trimmed.startsWith('---')) continue;
            if (trimmed.startsWith('>')) continue;
            if (!pastHeading && trimmed.startsWith('#')) { pastHeading = true; continue; }
            if (pastHeading && trimmed) { descLines.push(trimmed); }
            if (descLines.length >= 3) break;
          }
          if (descLines.length) {
            feature.description = descLines.join(' ');
            gotDescription = true;
          }
        }

        // Collect related features
        for (const rel of parseRelatedFeatures(raw)) {
          allRelated.add(rel);
        }
        // Collect sequence refs (predecessor → this → successor) — only design.md
        // is authoritative; other docs may inherit copy-paste headers.
        if (docFile === 'design.md') {
          const seq = parseSequenceRefs(raw);
          for (const code of seq.predecessors) feature.predecessors.push(code);
          for (const code of seq.successors) feature.successors.push(code);
        }
      } catch { /* skip */ }
    }

    // Remove self-references
    allRelated.delete(feature.name);
    feature.relatedFeatures = [...allRelated];
    feature.predecessors = [...new Set(feature.predecessors.filter(c => c !== feature.name))];
    feature.successors = [...new Set(feature.successors.filter(c => c !== feature.name))];

    // Infer phase from artifacts
    feature.phase = inferPhase(feature.artifacts);

    // Compute confidence from artifact completeness
    feature.confidence = computeConfidence(feature.artifacts);

    // Default status if none found in docs
    if (!feature.status) {
      // If there's a report.md, likely complete
      if (feature.artifacts.includes('report.md')) feature.status = 'complete';
      else feature.status = 'planned';
    }

    features.push(feature);
  }

  return features;
}

/**
 * Scan top-level directories that look like sub-packages.
 * A sub-package has a README.md or setup.py/pyproject.toml at its root.
 */
export function scanSubPackages() {
  const root = getTargetRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages = [];
  const markers = ['README.md', 'pyproject.toml', 'setup.py', 'package.json', 'Cargo.toml', 'go.mod'];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'docs') continue;

    const dirPath = path.join(root, entry.name);
    const hasMarker = markers.some(m => fs.existsSync(path.join(dirPath, m)));
    if (!hasMarker) continue;

    const pkg = { name: entry.name, type: 'package' };

    // Try to read description from README
    const readmePath = path.join(dirPath, 'README.md');
    if (fs.existsSync(readmePath)) {
      try {
        const raw = fs.readFileSync(readmePath, 'utf-8');
        const lines = raw.split('\n');
        let pastHeading = false;
        for (const line of lines) {
          if (!pastHeading && line.startsWith('#')) { pastHeading = true; continue; }
          if (pastHeading && line.trim()) {
            pkg.description = line.trim().substring(0, 200);
            break;
          }
        }
      } catch { /* skip */ }
    }

    packages.push(pkg);
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Feature.json write-back
// ---------------------------------------------------------------------------

/**
 * Resolve a feature directory for a vision item.
 *
 * Tries lifecycle.featureCode, item.featureCode, then item.title (since the
 * feature directory name equals the feature code, and items seeded from
 * scanFeatures use feature.name === feature code as the title).
 *
 * @returns {string|null} absolute path to docs/features/<code>, or null.
 */
function resolveFeatureDir(item, featuresDir) {
  if (!item) return null;
  const dir = featuresDir || resolveProjectPath('features');
  const candidates = [
    item.lifecycle?.featureCode,
    item.featureCode,
    item.title,
  ].filter(Boolean);
  for (const code of candidates) {
    const p = path.join(dir, code);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Persist a new `group` value to docs/features/<code>/feature.json.
 *
 * Reads the existing feature.json, sets `spec.group = newGroup` (or removes
 * the field if `newGroup` is null/empty), and writes atomically via temp +
 * rename. Errors are logged but non-fatal — items without a backing
 * feature.json simply skip silently.
 *
 * @param {object} item — vision item (must have lifecycle.featureCode or
 *                       featureCode or title that matches a feature dir name)
 * @param {string|null} newGroup — new group value (empty string / null to clear)
 * @param {string} [featuresDir] — override features dir (test only)
 * @returns {boolean} true if file was written, false if skipped.
 */
export function writeFeatureGroupToDisk(item, newGroup, featuresDir) {
  const featureDir = resolveFeatureDir(item, featuresDir);
  if (!featureDir) {
    if (process.env.DEBUG) {
      console.debug(`[feature-scan] writeFeatureGroupToDisk: no feature dir for item ${item?.id || '?'} (${item?.title || ''})`);
    }
    return false;
  }
  const specPath = path.join(featureDir, 'feature.json');
  if (!fs.existsSync(specPath)) {
    if (process.env.DEBUG) {
      console.debug(`[feature-scan] writeFeatureGroupToDisk: no feature.json at ${specPath}`);
    }
    return false;
  }

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  } catch (err) {
    console.warn(`[feature-scan] writeFeatureGroupToDisk: malformed feature.json at ${specPath}: ${err.message}`);
    return false;
  }

  const normalized = (typeof newGroup === 'string' && newGroup.trim()) ? newGroup.trim() : null;
  const current = (typeof spec.group === 'string' && spec.group.trim()) ? spec.group.trim() : null;
  if (normalized === current) {
    return false; // idempotent: nothing to do
  }

  if (normalized === null) {
    delete spec.group;
  } else {
    spec.group = normalized;
  }
  // Bump updated date if the field exists
  if ('updated' in spec) {
    spec.updated = new Date().toISOString().slice(0, 10);
  }

  // COMP-MCP-VALIDATE-1: never persist a malformed link shape via the vision
  // route. Existence (DANGLING) is intentionally NOT checked here: this path
  // only mutates `group`, so it cannot introduce a new dangling link, and
  // re-validating existence would wrongly block a group rename on a feature that
  // already carries a (possibly legitimately forced) forward-ref.
  try {
    assertValidLinkShape(spec);
  } catch (err) {
    console.warn(`[feature-scan] writeFeatureGroupToDisk: invalid feature.json at ${specPath}, not writing: ${err.message}`);
    return false;
  }

  try {
    const tmp = path.join(featureDir, `feature.json.tmp.${Date.now()}.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(spec, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, specPath);
    return true;
  } catch (err) {
    console.warn(`[feature-scan] writeFeatureGroupToDisk: failed to write ${specPath}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Upsert feature folders into the vision store.
 * Now uses parsed status, confidence, phase, and creates connections
 * for related features.
 *
 * @param {Array} features — result of scanFeatures()
 * @param {object} store — VisionStore instance
 * @returns {{ features: number, updated: number, connections: number }}
 */
export function seedFeatures(features, store) {
  const seeded = { features: 0, updated: 0, connections: 0 };
  const featureItemMap = new Map(); // featureCode → itemId
  const root = getTargetRoot();
  const featuresBase = resolveProjectPath('features');
  // Root-relative for the in-root default (relForDisplay guarantees byte-identity
  // there); absolute when the features dir is relocated outside the workspace root.
  const artifactPath = (feature, a) => relForDisplay(root, path.join(featuresBase, feature.name, a));

  // First pass: create/update items
  for (const feature of features) {
    let featureItem = Array.from(store.items.values()).find(
      i => i.lifecycle?.featureCode === feature.name
    );

    if (!featureItem) {
      featureItem = store.createItem({
        type: 'feature',
        title: feature.name,
        description: feature.description || '',
        status: feature.status || 'planned',
        phase: feature.phase || 'planning',
        confidence: feature.confidence,
        files: feature.artifacts.map(a => artifactPath(feature, a)),
        ...(feature.group ? { group: feature.group } : {}),
        ...(feature.priority ? { priority: feature.priority } : {}),
      });
      try {
        store.updateLifecycle(featureItem.id, { featureCode: feature.name, currentPhase: 'explore_design' });
      } catch { /* lifecycle method may not exist */ }
      featureItem = store.items.get(featureItem.id);
      seeded.features++;
    } else {
      // Update with richer data if we have it
      const updates = {};
      if (feature.description && feature.description !== featureItem.description) {
        updates.description = feature.description;
      }
      if (feature.status && feature.status !== featureItem.status) {
        updates.status = feature.status;
      }
      if (feature.confidence > (featureItem.confidence || 0)) {
        updates.confidence = feature.confidence;
      }
      const newFiles = feature.artifacts.map(a => artifactPath(feature, a));
      if (JSON.stringify(newFiles) !== JSON.stringify(featureItem.files || [])) {
        updates.files = newFiles;
      }
      if (feature.group && feature.group !== featureItem.group) {
        updates.group = feature.group;
      }
      if (feature.priority && feature.priority !== featureItem.priority) {
        updates.priority = feature.priority;
      }
      if (Object.keys(updates).length > 0) {
        store.updateItem(featureItem.id, updates);
        seeded.updated++;
      }
    }

    featureItemMap.set(feature.name, featureItem.id);
  }

  // Second pass: create connections for related features (undirected informs)
  for (const feature of features) {
    const fromId = featureItemMap.get(feature.name);
    if (!fromId || !feature.relatedFeatures.length) continue;

    for (const relatedName of feature.relatedFeatures) {
      const toId = featureItemMap.get(relatedName);
      if (!toId) continue;

      // Check if connection already exists
      const exists = Array.from(store.connections.values()).some(
        c => (c.fromId === fromId && c.toId === toId) ||
             (c.fromId === toId && c.toId === fromId)
      );
      if (exists) continue;

      try {
        store.createConnection({ fromId, toId, type: 'informs' });
        seeded.connections++;
      } catch { /* skip duplicate or invalid */ }
    }
  }

  // Third pass: directional sequence edges (predecessor → this → successor).
  // Mined from `**Predecessor:**` / `**Successor:**` lines in design.md.
  // Direction is meaningful: `informs` from earlier-shipping feature toward later.
  const addDirectional = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const exists = Array.from(store.connections.values()).some(
      c => c.fromId === fromId && c.toId === toId
    );
    if (exists) return;
    try {
      store.createConnection({ fromId, toId, type: 'informs' });
      seeded.connections++;
    } catch { /* skip */ }
  };
  for (const feature of features) {
    const thisId = featureItemMap.get(feature.name);
    if (!thisId) continue;
    for (const predCode of feature.predecessors) {
      addDirectional(featureItemMap.get(predCode), thisId);
    }
    for (const succCode of feature.successors) {
      addDirectional(thisId, featureItemMap.get(succCode));
    }
  }

  // Fourth pass (COMP-ROADMAP-GRAPH-2 S3a): deps.yaml dependency edges as typed
  // connections — `dep` -> blocks (directed), `concurrent` -> supports. These
  // structural edges are RECONCILED, not appended: deps.yaml is canon, so a
  // removed/retargeted dep must drop the stale edge from the live store too
  // (else the cockpit export drifts from the canonical projection). Endpoints
  // that resolve to no local item (external/missing) are skipped — buildGraph
  // would drop their edges anyway.
  const DEP_EDGE_CONN_TYPE = { dep: 'blocks', concurrent: 'supports' };
  const STRUCTURAL_TYPES = new Set(['blocks', 'supports']);
  const managedIds = new Set(featureItemMap.values());
  const desiredStructural = new Set(); // `${fromId}|${toId}|${type}`
  for (const feature of features) {
    if (!feature.deps) continue;
    for (const edge of depsToEdges(feature.name, feature.deps)) {
      const fromId = featureItemMap.get(edge.from);
      const toId = featureItemMap.get(edge.to);
      const connType = DEP_EDGE_CONN_TYPE[edge.type];
      if (!fromId || !toId || !connType) continue;
      desiredStructural.add(`${fromId}|${toId}|${connType}`);
    }
  }
  // Remove stale structural edges between two managed features that deps.yaml no
  // longer declares (feature relationships are source-managed, not hand-edited).
  for (const c of Array.from(store.connections.values())) {
    if (!STRUCTURAL_TYPES.has(c.type)) continue;
    if (!managedIds.has(c.fromId) || !managedIds.has(c.toId)) continue;
    if (!desiredStructural.has(`${c.fromId}|${c.toId}|${c.type}`)) {
      store.deleteConnection(c.id);
    }
  }
  // Add any missing desired structural edges.
  for (const key of desiredStructural) {
    const [fromId, toId, connType] = key.split('|');
    const exists = Array.from(store.connections.values()).some(
      c => c.fromId === fromId && c.toId === toId && c.type === connType
    );
    if (exists) continue;
    try {
      store.createConnection({ fromId, toId, type: connType });
      seeded.connections++;
    } catch { /* skip invalid */ }
  }

  if (seeded.features || seeded.updated || seeded.connections) {
    console.log(`[vision] Feature scan: ${seeded.features} new, ${seeded.updated} updated, ${seeded.connections} connections`);
  }
  return seeded;
}

/**
 * Seed sub-packages as vision items (type: 'track').
 */
export function seedSubPackages(packages, store) {
  let created = 0;
  for (const pkg of packages) {
    // Check if already exists by title
    const exists = Array.from(store.items.values()).some(
      i => i.title === pkg.name && i.type === 'track'
    );
    if (exists) continue;

    store.createItem({
      type: 'track',
      title: pkg.name,
      description: pkg.description || '',
      status: 'in_progress',
      phase: 'implementation',
      confidence: 2,
    });
    created++;
  }
  if (created) console.log(`[vision] Sub-package scan: ${created} new`);
  return created;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach feature scan/seed REST routes to an Express app.
 */
export function attachFeatureScanRoutes(app, { store, scheduleBroadcast }) {
  app.get('/api/features/scan', (_req, res) => {
    try {
      const features = scanFeatures();
      const packages = scanSubPackages();
      res.json({ features, packages, count: features.length + packages.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/features/seed', (_req, res) => {
    try {
      const features = scanFeatures();
      const seeded = seedFeatures(features, store);
      const packages = scanSubPackages();
      const pkgCount = seedSubPackages(packages, store);
      scheduleBroadcast();
      res.json({ ok: true, ...seeded, packages: pkgCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
