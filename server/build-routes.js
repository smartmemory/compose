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

import fs from 'node:fs';
import path from 'node:path';
import { runBuild as defaultRunBuild, abortBuild as defaultAbortBuild } from '../lib/build.js';
import { runNew as defaultRunNew } from '../lib/new.js';
import { runBuildAll as defaultRunBuildAll } from '../lib/build-all.js';
import { runGsd as defaultRunGsd } from '../lib/gsd.js';
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
import { getDataDir as defaultGetDataDir, getTargetRoot as defaultGetTargetRoot } from './project-root.js';
import { readBuildHistory } from '../lib/build-history.js';

// A launcher conflict (another build/GSD run already owns the feature) is a
// user-facing 409, not a 500. runBuild surfaces "already active"; runGsd
// refuses a concurrent run ("Refusing to start a concurrent run").
function launcherErrorStatus(err) {
  const msg = err && err.message ? err.message : '';
  return /already active|already running|concurrent run|refusing to start/i.test(msg) ? 409 : 500;
}

export function attachBuildRoutes(app, deps = {}) {
  const runBuild = deps.runBuild || defaultRunBuild;
  const abortBuild = deps.abortBuild || defaultAbortBuild;
  const runNew = deps.runNew || defaultRunNew;
  const runBuildAll = deps.runBuildAll || defaultRunBuildAll;
  const runGsd = deps.runGsd || defaultRunGsd;
  const getDataDir = deps.getDataDir || defaultGetDataDir;
  // Bind build dispatch to the active project root (the same global target the
  // vision store + getDataDir() use). Without this the runners default to
  // process.cwd(), which switchProject() does not chdir — so after a project
  // switch the cockpit and a launched build could target different workspaces.
  const getTargetRoot = deps.getTargetRoot || defaultGetTargetRoot;

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
    const { featureCode, mode = 'feature', description = '', resume = false } = body;

    // featureCode is required for feature/bug/gsd; 'new' takes a free-text
    // intent (no code yet) and 'all' sweeps every PLANNED feature.
    if (!featureCode && mode !== 'all' && mode !== 'new') {
      return res.status(400).json({ error: 'featureCode required' });
    }
    if (!['feature', 'bug', 'new', 'all', 'gsd'].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'feature', 'bug', 'new', 'all', or 'gsd'" });
    }

    // PARITY-2: launch the `new` lifecycle from a description (intent).
    if (mode === 'new') {
      const intent = (description || '').trim();
      if (!intent) {
        return res.status(400).json({ error: 'intent (description) required for mode=new' });
      }
      try {
        const result = await runNew(intent, { cwd: getTargetRoot() });
        return res.json(result ?? { ok: true });
      } catch (err) {
        return res.status(500).json({ error: err.message || String(err) });
      }
    }

    // PARITY-8: build-all sweep.
    if (mode === 'all') {
      try {
        const result = await runBuildAll({ cwd: getTargetRoot() });
        return res.json(result ?? { ok: true });
      } catch (err) {
        return res.status(launcherErrorStatus(err)).json({ error: err.message || String(err) });
      }
    }

    // PARITY-8: GSD autonomous run for a single feature.
    if (mode === 'gsd') {
      try {
        const result = await runGsd(featureCode, { cwd: getTargetRoot() });
        return res.json(result ?? { ok: true });
      } catch (err) {
        return res.status(launcherErrorStatus(err)).json({ error: err.message || String(err) });
      }
    }

    // PARITY-2: resume an interrupted bug-fix flow from active-build.json.
    let resumeFlowId = null;
    if (resume === true) {
      if (mode !== 'bug') {
        return res.status(400).json({ error: 'resume is only supported for mode=bug' });
      }
      let active = null;
      try {
        const activePath = path.join(getDataDir(), 'active-build.json');
        active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      } catch {
        active = null;
      }
      if (!active || active.featureCode !== featureCode || !active.flowId) {
        return res.status(409).json({ error: 'no resumable build for featureCode' });
      }
      if (active.mode && active.mode !== 'bug') {
        return res.status(409).json({ error: `active build is mode=${active.mode}, not resumable as bug` });
      }
      resumeFlowId = active.flowId;
    }

    try {
      const opts = mode === 'bug'
        ? { mode, template: 'bug-fix', description, cwd: getTargetRoot(), ...(resumeFlowId ? { resumeFlowId } : {}) }
        : { mode, description, cwd: getTargetRoot() };
      const result = await runBuild(featureCode, opts);
      res.json(result ?? { ok: true });
    } catch (err) {
      res.status(launcherErrorStatus(err)).json({ error: err.message || String(err) });
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
