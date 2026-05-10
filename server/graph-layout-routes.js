/**
 * graph-layout-routes.js — persistent graph node positions.
 *
 * Mounts:
 *   GET  /api/graph/layout → { positions: { [itemId]: {x, y} } }
 *   POST /api/graph/layout → body { positions: {...} } merged into existing.
 *
 * Storage: <dataDir>/graph-layout.json (resolved per-request via getDataDir()
 * so project switches see the right file).
 *
 * Merge semantics: POST is a partial update. Existing entries not present in
 * the body are preserved. Entries present in the body overwrite. Pass
 * `{ positions: { id: null } }` to drop an entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, ensureDataDir } from './project-root.js';

function layoutFile() {
  return path.join(getDataDir(), 'graph-layout.json');
}

function readPositions() {
  try {
    const raw = fs.readFileSync(layoutFile(), 'utf-8');
    const data = JSON.parse(raw);
    return (data && typeof data.positions === 'object' && data.positions) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[graph-layout] read failed:', err.message);
    }
    return {};
  }
}

function writePositions(positions) {
  ensureDataDir();
  const file = layoutFile();
  const dir = path.dirname(file);
  const data = JSON.stringify({ positions }, null, 2) + '\n';
  const tmp = path.join(dir, `graph-layout.json.tmp.${Date.now()}`);
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, file);
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export function attachGraphLayoutRoutes(app) {
  app.get('/api/graph/layout', (_req, res) => {
    res.json({ positions: readPositions() });
  });

  app.post('/api/graph/layout', (req, res) => {
    const body = req.body || {};
    const incoming = body.positions;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'positions object required' });
    }
    const existing = readPositions();
    const merged = { ...existing };
    for (const [id, pos] of Object.entries(incoming)) {
      if (pos === null) {
        delete merged[id];
        continue;
      }
      if (!pos || typeof pos !== 'object') continue;
      if (!isFiniteNumber(pos.x) || !isFiniteNumber(pos.y)) continue;
      merged[id] = { x: pos.x, y: pos.y };
    }
    try {
      writePositions(merged);
    } catch (err) {
      console.error('[graph-layout] write failed:', err.message);
      return res.status(500).json({ error: 'failed to persist layout' });
    }
    res.json({ ok: true, positions: merged });
  });
}
