/**
 * qa-scope-routes.js — Read-only QA-scope REST API (COMP-PARITY-10).
 *
 * Route:
 *   GET /api/qa-scope?featureCode=<CODE> — surfaces `compose qa-scope <CODE>`
 *     (diff-to-route mapping from COMP-QA) as structured JSON for the cockpit's
 *     QA Scope view. Maps the feature's recorded filesChanged → affected /
 *     adjacent routes via lib/qa-scoping.js. Read-only, no side effects.
 *
 * Not auth-gated (mirrors GET /api/environment-health): it reads only
 * feature.json + heuristic route mapping, no host paths leaked, no mutation.
 *
 * Degrade-never-fail: a bad feature code or unreadable feature.json returns a
 * structured { found:false } / empty result, never a 500.
 *
 * Reuses (no logic fork):
 *   - lib/feature-json.js  — readFeature(cwd, code)
 *   - lib/qa-scoping.js    — mapFilesToRoutes(filesChanged,{cwd}), classifyRoutes(routes,[])
 */
import { readFeature as defaultReadFeature } from '../lib/feature-json.js';
import {
  mapFilesToRoutes as defaultMapFilesToRoutes,
  classifyRoutes as defaultClassifyRoutes,
} from '../lib/qa-scoping.js';

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {Function} [deps.readFeature]      — (cwd, code) => FeatureJson|null
 * @param {Function} [deps.mapFilesToRoutes] — (filesChanged, {cwd}) => {affectedRoutes,unmappedFiles,framework,docsOnly}
 * @param {Function} [deps.classifyRoutes]   — (routes, allKnown) => {affected,adjacent}
 */
export function attachQaScopeRoutes(app, {
  readFeature = defaultReadFeature,
  mapFilesToRoutes = defaultMapFilesToRoutes,
  classifyRoutes = defaultClassifyRoutes,
} = {}) {
  app.get('/api/qa-scope', (req, res) => {
    const featureCode = (req.query.featureCode || '').toString().trim();
    if (!featureCode) {
      return res.json({ found: false, error: 'featureCode required' });
    }

    const root = req.workspace?.root;
    if (!root) {
      return res.json({ found: false, error: 'no workspace root', featureCode });
    }

    let feature;
    try {
      feature = readFeature(root, featureCode);
    } catch {
      feature = null;
    }
    if (!feature) {
      return res.json({ found: false, featureCode });
    }

    const filesChanged = feature.filesChanged ?? [];
    if (filesChanged.length === 0) {
      // Mirror the CLI's empty-diff guidance (bin/compose.js:2716-2719).
      return res.json({
        found: true,
        featureCode,
        filesChanged: [],
        framework: 'unknown',
        docsOnly: false,
        affected: [],
        adjacent: [],
        unmappedFiles: [],
        emptyDiff: true,
      });
    }

    // Same pipeline as the CLI (bin/compose.js:2722-2724); allKnown=[] (v1: no registry).
    let result, classified;
    try {
      result = mapFilesToRoutes(filesChanged, { cwd: root });
      classified = classifyRoutes(result.affectedRoutes, []);
    } catch (e) {
      return res.json({ found: true, featureCode, error: e?.message || 'qa-scope failed' });
    }

    res.json({
      found: true,
      featureCode,
      filesChanged,
      framework: result.framework,
      docsOnly: result.docsOnly,
      affected: classified.affected,
      adjacent: classified.adjacent,
      unmappedFiles: result.unmappedFiles,
      emptyDiff: false,
    });
  });
}
