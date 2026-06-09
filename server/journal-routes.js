/**
 * journal-routes.js — Journal & changelog cockpit surface (COMP-COCKPIT-9).
 *
 * Routes:
 *   GET  /api/journal?feature=<code>&limit=N   — getJournalEntries passthrough
 *   GET  /api/changelog?feature=<code>&limit=N — getChangelogEntries (note: lib
 *                                                filter key is `code`, normalized here)
 *   POST /api/journal                          — write a journal entry (sensitive token)
 *
 * `limit` must be parsed numerically (parseInt + clamp, same pattern as
 * GET /api/builds) — both lib readers only honor `limit` when it is a number;
 * a raw req.query string is silently ignored.
 *
 * POST derives date (today, local) + slug (slugified summary) and maps
 * `summary` → `summary_for_index`. Storage-level dedup in writeJournalEntry
 * returns `idempotent: true` on a (date, slug) collision; the route retries
 * with -2, -3, … suffixes (≤ 20) so two same-day entries with the same
 * summary produce two distinct files.
 *
 * Error mapping: 400 on missing summary/sections and on writer errors with
 * code === 'INVALID_INPUT'; anything else (incl. JOURNAL_INDEX_FORMAT) → 500.
 */

import { writeJournalEntry, getJournalEntries } from '../lib/journal-writer.js';
import { getChangelogEntries } from '../lib/changelog-writer.js';

const MAX_SLUG_RETRIES = 20;

/** Local YYYY-MM-DD (not UTC — journal dates follow the developer's clock). */
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Slugify a summary to conform to SLUG_RE: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/. */
function slugify(summary) {
  return String(summary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

function parseLimit(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : undefined;
}

/**
 * @param {object} app — Express app
 * @param {{ projectRoot: string|function, requireSensitiveToken: function }} deps
 */
export function attachJournalRoutes(app, { projectRoot, requireSensitiveToken }) {
  const root = () => (typeof projectRoot === 'function' ? projectRoot() : projectRoot);

  app.get('/api/journal', (req, res) => {
    try {
      const opts = {};
      const limit = parseLimit(req.query.limit);
      if (limit !== undefined) opts.limit = limit;
      if (req.query.feature) opts.feature_code = String(req.query.feature);
      res.json(getJournalEntries(root(), opts));
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/changelog', (req, res) => {
    try {
      const opts = {};
      const limit = parseLimit(req.query.limit);
      if (limit !== undefined) opts.limit = limit;
      // Lib filter key is `code` (vs journal's `feature_code`) — normalized here.
      if (req.query.feature) opts.code = String(req.query.feature);
      res.json(getChangelogEntries(root(), opts));
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/journal', requireSensitiveToken, async (req, res) => {
    const body = req.body || {};
    const { summary, feature_code, sections } = body;

    if (typeof summary !== 'string' || summary.trim().length === 0) {
      return res.status(400).json({ error: 'summary is required' });
    }
    if (!sections || typeof sections !== 'object') {
      return res.status(400).json({ error: 'sections is required' });
    }
    for (const key of ['what_happened', 'what_we_built', 'what_we_learned', 'open_threads']) {
      if (typeof sections[key] !== 'string' || sections[key].trim().length === 0) {
        return res.status(400).json({ error: `sections.${key} is required and must be non-empty` });
      }
    }

    const date = todayLocal();
    const baseSlug = slugify(summary);
    if (!baseSlug) {
      return res.status(400).json({ error: 'summary must contain at least one alphanumeric character' });
    }

    try {
      // Write-retry loop: (date, slug) collisions come back idempotent:true;
      // suffix -2, -3, … until a fresh file lands.
      let result = null;
      for (let attempt = 1; attempt <= MAX_SLUG_RETRIES; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        result = await writeJournalEntry(root(), {
          date,
          slug,
          sections,
          summary_for_index: summary,
          ...(feature_code ? { feature_code } : {}),
        });
        if (result.idempotent !== true) {
          return res.json(result);
        }
      }
      return res.status(500).json({
        error: `journal write: could not find a free slug for "${baseSlug}" after ${MAX_SLUG_RETRIES} attempts`,
      });
    } catch (err) {
      const status = err && err.code === 'INVALID_INPUT' ? 400 : 500;
      return res.status(status).json({ error: err.message || String(err) });
    }
  });
}
