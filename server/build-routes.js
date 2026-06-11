/**
 * build-routes.js — POST /api/build/start, POST /api/build/abort.
 *
 * Both endpoints require the sensitive token. They wrap the importable
 * `runBuild` / `abortBuild` functions from `lib/build.js` (used by the CLI).
 *
 * Concurrency: `runBuild` rejects a second build for the same featureCode
 * while one is active. Different featureCodes can run concurrently.
 * `active-build.json` is last-writer-wins; "the most recent active build"
 * is what the mobile UI surfaces.
 *
 * `attachBuildRoutes(app, deps?)` — `deps` is optional and primarily for
 * tests; it lets a caller inject mock `runBuild` / `abortBuild` / `getDataDir`.
 */

import { runBuild as defaultRunBuild, abortBuild as defaultAbortBuild } from '../lib/build.js';
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
import { getDataDir as defaultGetDataDir } from './project-root.js';
import { readBuildHistory } from '../lib/build-history.js';

export function attachBuildRoutes(app, deps = {}) {
  const runBuild = deps.runBuild || defaultRunBuild;
  const abortBuild = deps.abortBuild || defaultAbortBuild;
  const getDataDir = deps.getDataDir || defaultGetDataDir;

  // COMP-COCKPIT-3: read-only past-builds history. No sensitive token —
  // mirrors GET /api/build/state (read-only, no secrets in the records).
  app.get('/api/builds', (req, res) => {
    try {
      const raw = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 50;
      const builds = readBuildHistory(getDataDir(), { limit });
      res.json({ builds });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/build/start', requireSensitiveToken, async (req, res) => {
    const body = req.body || {};
    const { featureCode, mode = 'feature', description = '' } = body;
    if (!featureCode) {
      return res.status(400).json({ error: 'featureCode required' });
    }
    if (mode !== 'feature' && mode !== 'bug') {
      return res.status(400).json({ error: "mode must be 'feature' or 'bug'" });
    }
    try {
      const opts = mode === 'bug'
        ? { mode, template: 'bug-fix', description }
        : { mode, description };
      const result = await runBuild(featureCode, opts);
      res.json(result ?? { ok: true });
    } catch (err) {
      const code = /already active/i.test(err && err.message ? err.message : '') ? 409 : 500;
      res.status(code).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/build/abort', requireSensitiveToken, async (req, res) => {
    const body = req.body || {};
    const { featureCode } = body;
    if (!featureCode) {
      return res.status(400).json({ error: 'featureCode required' });
    }
    try {
      const result = await abortBuild(getDataDir(), featureCode);
      res.json(result ?? { ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });
}
