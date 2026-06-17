/**
 * feature-scaffold-routes.js — POST /api/features/scaffold.
 *
 * Cockpit equivalent of `compose feature <CODE>`: scaffolds docs/features/<CODE>/
 * (feature.json + seed design.md) and the ROADMAP.md row. Reuses the typed writer
 * addRoadmapEntry (lib/feature-writer.js) — never reimplements scaffolding and
 * never echoes the regenerated roadmap back (the lib return is already compact).
 *
 * Sensitive (mutating). attachFeatureScaffoldRoutes(app, deps?) — deps is for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
import { addRoadmapEntry as defaultAddRoadmapEntry } from '../lib/feature-writer.js';
import { isFeatureCode } from '../lib/feature-code.js';
import { getTargetRoot as defaultGetProjectRoot } from './project-root.js';
import { resolveFeaturesPathFromConfig, relForDisplay } from '../lib/project-paths.js';

const DEFAULT_PHASE = 'Backlog';

export function attachFeatureScaffoldRoutes(app, deps = {}) {
  const addRoadmapEntry = deps.addRoadmapEntry || defaultAddRoadmapEntry;
  const getProjectRoot = deps.getProjectRoot || defaultGetProjectRoot;

  app.post('/api/features/scaffold', requireSensitiveToken, async (req, res) => {
    const body = req.body || {};
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const phase = (typeof body.phase === 'string' && body.phase.trim())
      || (typeof body.group === 'string' && body.group.trim())
      || DEFAULT_PHASE;

    if (!isFeatureCode(code)) {
      return res.status(400).json({ error: 'Invalid feature code (e.g. COMP-FOO-1)' });
    }
    if (!description) {
      return res.status(400).json({ error: 'description is required' });
    }

    const projectRoot = getProjectRoot();
    try {
      // 1. feature.json + ROADMAP.md row (compact return — no roadmap echo).
      const result = await addRoadmapEntry(projectRoot, { code, description, phase });

      // 2. Seed design.md stub (addRoadmapEntry does not write it). Idempotent.
      //    Resolve the ABSOLUTE features dir (may be relocated) — mirror ideabox.
      let featurePath = null;
      try {
        const composeJsonPath = path.join(projectRoot, '.compose', 'compose.json');
        let cfg = {};
        if (fs.existsSync(composeJsonPath)) {
          try { cfg = JSON.parse(fs.readFileSync(composeJsonPath, 'utf-8')); } catch { /* default cfg */ }
        }
        const featuresBase = resolveFeaturesPathFromConfig(projectRoot, cfg);
        const featureDir = path.join(featuresBase, code);
        const designPath = path.join(featureDir, 'design.md');
        if (!fs.existsSync(designPath)) {
          const today = new Date().toISOString().slice(0, 10);
          fs.mkdirSync(featureDir, { recursive: true });
          fs.writeFileSync(designPath,
            `# ${code}: ${description}\n\n**Status:** PLANNED\n**Created:** ${today}\n\n---\n\n## Intent\n\n${description}\n\n---\n\n## Notes\n\n_Seed design doc created by the New Feature dialog. \`compose build\` will expand it._\n`);
        }
        featurePath = relForDisplay(projectRoot, featureDir);
      } catch { /* design seed is best-effort; feature.json + roadmap already written */ }

      // COMPACT result — never the full roadmap (memory: MCP add_roadmap_entry echo
      // blows the token cap; the lib return is small, keep it small here too).
      return res.json({
        ok: true,
        code: result.code,
        phase: result.phase,
        position: result.position,
        roadmap_path: result.roadmap_path,
        featurePath,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const code409 = /already exists/i.test(msg);
      return res.status(code409 ? 409 : 400).json({ error: msg });
    }
  });
}
