/**
 * server/ideabox-routes.js — REST API for the ideabox feature.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-2: this module reads and writes FLUID RECORDS.
 *
 * Routes:
 *   GET    /api/ideabox                     — the whole ideabox, from the records
 *   POST   /api/ideabox/ideas               — capture a new idea
 *   PATCH  /api/ideabox/ideas/:id           — edit fields (priority, effort, impact, …)
 *   POST   /api/ideabox/ideas/:id/promote   — promote to a feature
 *   POST   /api/ideabox/ideas/:id/kill      — kill with a reason
 *   POST   /api/ideabox/ideas/:id/resurrect — return a killed idea to the live set
 *   POST   /api/ideabox/ideas/:id/discuss   — append to the deliberation trail
 *   DELETE /api/ideabox/ideas/:id           — not allowed (use kill)
 *
 * WHAT S3b-1 LEFT HERE AND WHY IT IS GONE
 * ---------------------------------------
 * S3b-1 cut the CLI over to the record store and closed all six mutating
 * handlers with a 409, because they rewrote `docs/product/ideabox.md` directly
 * and that file had just become generated output: an idea saved here would have
 * reported success, been overwritten by the next render, and taken the user's
 * text with it. Failing closed was the honest interim state. This slice replaces
 * it with real handlers rather than restoring the old bodies.
 *
 * EVERY MUTATION GOES THROUGH `fluid/ideabox-ops.js`, WHICH THE CLI ALSO USES.
 * Not "the same way the CLI does" — the same code. Two call sites that each had
 * to remember to run the migration gate before writing, and to re-render after,
 * would drift exactly the way `smartmemory-provider.js` drifted from
 * `local-provider.js` in S3b-1: satisfying the interface completely while
 * silently missing a guarantee.
 *
 * Responses come from `fluid/ideabox-view.js`, which projects records into the
 * shape the cockpit and the mobile app have always consumed (`id` is the handle,
 * `description` is the body, an untriaged priority is an em dash).
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  ideaboxContext,
  addIdea,
  addDiscussion,
  killIdea,
  promoteIdea,
  resurrectIdea,
  updateIdea,
  IdeaboxConflict,
  IdeaboxInvalid,
  IdeaboxNotFound,
  IdeaboxRenderFailed,
} from '../lib/fluid/ideabox-ops.js'
import { writeIdeaboxProjection } from '../lib/fluid/render-ideabox.js'
import { ideaboxView, toClientIdeaWith } from '../lib/fluid/ideabox-view.js'
import { relForDisplay } from '../lib/project-paths.js'

/**
 * @param {object} app              — Express app
 * @param {{ getProjectRoot, getDataDir, broadcastMessage }} deps
 */
export function attachIdeaboxRoutes(app, { getProjectRoot, broadcastMessage }) {
  /**
   * A fresh context per request, deliberately.
   *
   * The provider holds paths, not state — every handle lookup re-reads the
   * records directory and the events log — so caching one would buy nothing and
   * cost correctness the moment the project root changes underneath a long-lived
   * server, which is the case this file has always had to handle.
   */
  function context() {
    const projectRoot = getProjectRoot()
    return ideaboxContext(projectRoot, { config: loadConfig(projectRoot) ?? {}, origin: 'ui:ideabox' })
  }

  function broadcastUpdate() {
    if (broadcastMessage) {
      broadcastMessage({ type: 'ideaboxUpdated', timestamp: new Date().toISOString() })
    }
  }

  /**
   * Map an op failure onto HTTP.
   *
   * `IdeaboxRenderFailed` is deliberately NOT an error response. The record is
   * durable; only the generated markdown is stale. Both clients roll their
   * optimistic update back on any non-ok response, so reporting a failure here
   * would make a committed idea vanish from the UI and invite the user to type
   * it again — producing the duplicate the whole record store exists to prevent.
   * It is answered as a success carrying `projectionStale`, so a client that
   * wants to surface the staleness can, and one that ignores unknown fields
   * behaves correctly by default.
   */
  async function send(res, run, okStatus = 200) {
    try {
      const { body, broadcast = true } = await run()
      if (broadcast) broadcastUpdate()
      res.status(okStatus).json(body)
    } catch (err) {
      if (err instanceof IdeaboxRenderFailed) {
        // The write landed. Tell the truth about both halves.
        broadcastUpdate()
        const idea = err.record ? await safeIdea(err.record) : null
        return res.status(okStatus).json({
          ...(idea ?? {}),
          projectionStale: true,
          warning: err.message,
        })
      }
      if (err instanceof IdeaboxNotFound) return res.status(404).json({ error: err.message, code: err.code })
      if (err instanceof IdeaboxInvalid) return res.status(400).json({ error: err.message, code: err.code, field: err.field })
      if (err instanceof IdeaboxConflict) return res.status(409).json({ error: err.message, code: err.code })
      return res.status(500).json({ error: err.message })
    }
  }

  /** Best-effort client projection for the render-failed path, which must not
   *  fail a second time on the way out. */
  async function safeIdea(record) {
    try {
      const ctx = await context()
      return await toClientIdeaWith(ctx.provider, record)
    } catch {
      return null
    }
  }

  // GET /api/ideabox — served from the records, per the feature's acceptance
  // criterion. NOT from `docs/product/ideabox.md`: that file is a local
  // projection, and on a store shared across machines (the SmartMemory
  // provider) a write on one machine never regenerates another's copy, so
  // reading it would serve an indefinitely stale view of a current store.
  app.get('/api/ideabox', async (_req, res) => {
    try {
      const ctx = await context()
      res.json(await ideaboxView(ctx.provider))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas
  app.post('/api/ideabox/ideas', async (req, res) => {
    const { title, description, source, tags, cluster } = req.body || {}
    await send(res, async () => {
      const ctx = await context()
      const { record } = await addIdea(ctx, { title, body: description, source, tags, cluster })
      return { body: await toClientIdeaWith(ctx.provider, record) }
    }, 201)
  })

  // PATCH /api/ideabox/ideas/:id
  app.patch('/api/ideabox/ideas/:id', async (req, res) => {
    await send(res, async () => {
      const ctx = await context()
      const { record } = await updateIdea(ctx, req.params.id, req.body || {})
      return { body: await toClientIdeaWith(ctx.provider, record) }
    })
  })

  // POST /api/ideabox/ideas/:id/promote
  app.post('/api/ideabox/ideas/:id/promote', async (req, res) => {
    await send(res, async () => {
      const ctx = await context()
      const { record, featureCode, featurePath } = await promoteIdea(
        ctx, req.params.id, (req.body || {}).featureCode || ''
      )
      // `featureCode` and `featurePath` are a promotion-specific envelope around
      // the idea, not fields of it. The mobile client reads `result.featureCode`
      // to name what it just created, and it matters most in exactly the case
      // where the client did not supply one and the server derived it.
      return {
        body: {
          ...(await toClientIdeaWith(ctx.provider, record)),
          featureCode,
          featurePath: relForDisplay(ctx.cwd, featurePath),
        },
      }
    })
  })

  // POST /api/ideabox/ideas/:id/kill
  app.post('/api/ideabox/ideas/:id/kill', async (req, res) => {
    await send(res, async () => {
      const ctx = await context()
      const { record } = await killIdea(ctx, req.params.id, (req.body || {}).reason || '')
      return { body: await toClientIdeaWith(ctx.provider, record) }
    })
  })

  // POST /api/ideabox/ideas/:id/resurrect
  app.post('/api/ideabox/ideas/:id/resurrect', async (req, res) => {
    await send(res, async () => {
      const ctx = await context()
      const { record } = await resurrectIdea(ctx, req.params.id)
      return { body: await toClientIdeaWith(ctx.provider, record) }
    })
  })

  // POST /api/ideabox/ideas/:id/discuss
  app.post('/api/ideabox/ideas/:id/discuss', async (req, res) => {
    const { author, text } = req.body || {}
    if (!author) return res.status(400).json({ error: 'author is required' })
    await send(res, async () => {
      const ctx = await context()
      const { record } = await addDiscussion(ctx, req.params.id, { author, text })
      return { body: await toClientIdeaWith(ctx.provider, record) }
    }, 201)
  })

  // POST /api/ideabox/render — rebuild the projection from the records (the
  // repair for a landed-unrendered write: the durable record is fine, only the
  // generated file is stale). The HTTP twin of `compose ideabox render`;
  // touches no record. (FOH-6 S4 — the colleague panel's repair affordance.)
  app.post('/api/ideabox/render', async (_req, res) => {
    await send(res, async () => {
      const ctx = await context()
      await writeIdeaboxProjection(ctx.provider, ctx.ideaboxPath)
      return { body: { ok: true } }
    })
  })

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
