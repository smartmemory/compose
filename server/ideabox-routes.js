/**
 * server/ideabox-routes.js — REST API for the ideabox feature.
 *
 * Routes:
 *   GET    /api/ideabox                  — return parsed ideabox JSON (cached)
 *   POST   /api/ideabox/ideas            — add new idea
 *   PATCH  /api/ideabox/ideas/:id        — update priority/status/etc.
 *   POST   /api/ideabox/ideas/:id/promote — promote to feature
 *   POST   /api/ideabox/ideas/:id/kill   — kill with reason
 *   DELETE /api/ideabox/ideas/:id        — not allowed (use kill)
 */

import fs from 'node:fs'
import path from 'node:path'
// The ideabox mutators are gone from this module: the write path is closed here
// until S3b-2 wires it onto the fluid record store (see `writesMovedToCli`).
import { IdeaboxCache } from './ideabox-cache.js'
import { resolveIdeaboxPathFromConfig } from '../lib/project-paths.js'

/**
 * @param {object} app              — Express app
 * @param {{ getProjectRoot, getDataDir }} deps
 */
export function attachIdeaboxRoutes(app, { getProjectRoot, getDataDir }) {
  // Lazily created per project root — we need to handle project switches
  let _cache = null
  let _lastProjectRoot = null
  let _lastDataDir = null

  function getCache() {
    const projectRoot = getProjectRoot()
    const dataDir = getDataDir()
    if (!_cache || _lastProjectRoot !== projectRoot || _lastDataDir !== dataDir) {
      const config = loadConfig(projectRoot)
      const sourceFile = resolveIdeaboxPathFromConfig(projectRoot, config)
      _cache = new IdeaboxCache(dataDir, sourceFile)
      _lastProjectRoot = projectRoot
      _lastDataDir = dataDir
    }
    return _cache
  }

  // GET /api/ideabox
  app.get('/api/ideabox', (_req, res) => {
    try {
      const cache = getCache()
      const data = cache.get()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas
  /**
   * S3b-1 (F1): the cockpit's WRITE path is closed until S3b-2 wires it onto the
   * record store.
   *
   * The CLI now treats `docs/product/ideabox.md` as GENERATED output. These
   * handlers used to rewrite that markdown directly and return 200, so leaving
   * them live would mean an idea added or edited in the cockpit reports success,
   * is overwritten by the next CLI render, and takes the user's text with it.
   * `POST /ideas` was worse still: it allocated from the markdown's own counter
   * while the record store allocates from its own, so the two mint the same
   * IDEA-N without either knowing.
   *
   * Failing closed is the honest state. A visible 409 naming the working path
   * beats a silent success that loses the write. The previous bodies are not
   * kept behind this guard — unreachable code that looks live is how a hole gets
   * quietly reopened, and S3b-2 rewrites these onto the provider rather than
   * restoring them.
   *
   * Reads stay open: the markdown is a faithful projection of the records.
   */
  const writesMovedToCli = (_req, res) => res.status(409).json({
    error:
      'The ideabox has moved to the record store and the cockpit write path is not wired to it yet. '
      + 'An idea saved here would be overwritten by the next render, so the write is refused rather than lost. '
      + 'Use `compose ideabox <add|pri|kill|discuss|promote>` until this is restored.',
    code: 'IDEABOX_WRITES_MOVED_TO_CLI',
  })

  app.post('/api/ideabox/ideas', writesMovedToCli)
  app.patch('/api/ideabox/ideas/:id', writesMovedToCli)
  app.post('/api/ideabox/ideas/:id/promote', writesMovedToCli)
  app.post('/api/ideabox/ideas/:id/kill', writesMovedToCli)
  app.post('/api/ideabox/ideas/:id/resurrect', writesMovedToCli)
  app.post('/api/ideabox/ideas/:id/discuss', writesMovedToCli)

  // DELETE /api/ideabox/ideas/:id — not allowed
  app.delete('/api/ideabox/ideas/:id', (_req, res) => {
    res.status(405).json({ error: 'Deletion not allowed. Use POST /api/ideabox/ideas/:id/kill instead.' })
  })
}

// ---------------------------------------------------------------------------
// Internal: load compose.json config
// ---------------------------------------------------------------------------

function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.compose', 'compose.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}
