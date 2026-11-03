/**
 * server/evidence-routes.js — the cockpit's read of the evidence store
 * (COMP-DOGFOOD-EVIDENCE-GATE-1). Read-only: receipts are written by the MCP
 * state tools and `lib/evidence-cli.js`, never over HTTP.
 *
 *   GET /api/evidence?feature=<code>   → { records: [ {id, kind, checked_at, subject} ] } (newest last)
 *   GET /api/evidence/:id              → the stored record, 404 when unknown
 *
 * Mounted from attachVisionRoutes: a receipt is about a vision item's state.
 */
import { evidenceStorePath, listEvidence, readEvidence } from '../lib/evidence.js';

export function attachEvidenceRoutes(app, { storePath } = {}) {
  const store = () => storePath || evidenceStorePath();

  app.get('/api/evidence', (req, res) => {
    const feature = typeof req.query.feature === 'string' ? req.query.feature : '';
    if (!feature) return res.status(400).json({ error: 'feature is required' });
    try {
      const records = listEvidence({ feature, store: store() }).map((r) => ({
        id: r.id, kind: r.evidence?.kind ?? null, checked_at: r.checked_at, subject: r.subject ?? null,
      }));
      res.json({ records });
    } catch (err) {
      res.status(500).json({ error: `evidence store unreadable: ${err.message}` });
    }
  });

  app.get('/api/evidence/:id', (req, res) => {
    try {
      const rec = readEvidence(req.params.id, { store: store() });
      if (!rec) return res.status(404).json({ error: `${req.params.id} is not in the evidence store` });
      res.json(rec);
    } catch (err) {
      res.status(500).json({ error: `evidence store unreadable: ${err.message}` });
    }
  });
}
