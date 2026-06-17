/**
 * validate-routes.js — Read-only cross-artifact validation REST API (COMP-PARITY-6).
 *
 * Route:
 *   GET /api/validate?scope=feature|project&featureCode=<CODE>
 *     Surfaces `compose validate` (lib/feature-validator.js validateFeature/
 *     validateProject) as structured JSON for the cockpit Validate view.
 *     Read-only; local-only (no network xref resolution); degrades, never 500s.
 *
 * Deliberately NOT under an auth-allowlisted prefix (mirrors health-routes.js):
 * non-allowlisted → default-deny in remote mode, open on localhost.
 *
 * Reuses (no logic fork): lib/feature-validator.js validateFeature/validateProject.
 */
import {
  validateFeature as defaultValidateFeature,
  validateProject as defaultValidateProject,
} from '../lib/feature-validator.js';

const SEVERITIES = ['error', 'warning', 'info'];

/** Group a findings array into { error: n, warning: n, info: n }. */
export function summarizeFindings(findings = []) {
  const by = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (by[f?.severity] !== undefined) by[f.severity] += 1;
  }
  return by;
}

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {Function} [deps.validateFeature] — injectable (default: lib validator)
 * @param {Function} [deps.validateProject] — injectable (default: lib validator)
 */
export function attachValidateRoutes(app, {
  validateFeature = defaultValidateFeature,
  validateProject = defaultValidateProject,
} = {}) {
  app.get('/api/validate', async (req, res) => {
    const root = req.workspace?.root;
    if (!root) {
      // No workspace to validate — a guarded failure, not a 500.
      return res.json({ scope: null, findings: [], bySeverity: summarizeFindings([]), unavailable: true });
    }
    const scope = req.query.scope === 'feature' ? 'feature' : 'project';
    const featureCode = typeof req.query.featureCode === 'string' ? req.query.featureCode : null;

    if (scope === 'feature' && !featureCode) {
      return res.status(400).json({ error: 'scope=feature requires featureCode' });
    }

    try {
      const result = scope === 'feature'
        ? await validateFeature(root, featureCode)        // local-only; no `external`
        : await validateProject(root, {});                // local-only; no `external`
      const findings = Array.isArray(result.findings) ? result.findings : [];
      // Pass the validator result through verbatim + add the severity rollup.
      return res.json({ ...result, bySeverity: summarizeFindings(findings) });
    } catch (err) {
      // validateCode throws INVALID_INPUT on a malformed feature code → 400.
      if (err && err.code === 'INVALID_INPUT') {
        return res.status(400).json({ error: err.message });
      }
      // Any other failure degrades to a non-500 unavailable body.
      return res.json({ scope, feature_code: featureCode, findings: [], bySeverity: summarizeFindings([]), unavailable: true, error: err?.message || 'validate failed' });
    }
  });
}
