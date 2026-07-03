/**
 * smartmemory-routes.js — COMP-SMARTMEMORY-RECALL S01.
 *
 * Route:
 *   GET /api/smartmemory/recall?featureCode=<CODE> — ranked prior-context
 *     lookup for the cockpit's Recall tab, backed by INGEST's SmartMemory
 *     client + config (lib/smartmemory-client.js, lib/smartmemory-config.js).
 *
 * Degrade-never-fail (the qa-scope-routes.js model): every branch returns a
 * shaped 200, never a throw. Flag OFF (or no workspace root) answers from
 * config alone — zero client construction, zero SmartMemory-bound traffic.
 *
 * Not on the auth allowlist (server/index.js) — auth-gated in remote mode
 * like the vision routes, since results can carry local project context.
 */
import { getSmartmemoryConfig, resolveProjectTag as defaultResolveProjectTag } from '../lib/smartmemory-config.js';
import { createSmartmemoryClient } from '../lib/smartmemory-client.js';
import { readFeature as defaultReadFeature } from '../lib/feature-json.js';
import { resolveFeaturesPath as defaultResolveFeaturesPath } from '../lib/project-paths.js';

function defaultCreateClient(cfg) {
  return createSmartmemoryClient(cfg);
}

function shortReason(e) {
  return e?.message?.slice(0, 200) || 'unreachable';
}

function safeProjectTag(resolveProjectTag, root) {
  try {
    return resolveProjectTag(root);
  } catch {
    return null;
  }
}

/** Defensive adapter over the SmartMemory hit shape (multiple field-name fallbacks). */
function mapHit(hit) {
  const content = hit?.content ?? hit?.text ?? '';
  return {
    id: hit?.id ?? hit?.item_id ?? null,
    snippet: content.length > 280 ? content.slice(0, 280) + '…' : content,
    score: hit?.score ?? null,
    memoryType: hit?.memory_type ?? hit?.memoryType ?? null,
    ts: hit?.context?.event?.ts ?? hit?.context?.ts ?? hit?.ts ?? null,
    project: hit?.context?.project ?? null,
  };
}

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {Function} [deps.getConfig]           — (cwd) => {} | {enabled,baseUrl,apiKeyEnv,timeoutMs}
 * @param {Function} [deps.createClient]         — (cfg) => { search(query, opts) }
 * @param {Function} [deps.readFeature]          — (cwd, code, featuresDir) => FeatureJson|null
 * @param {Function} [deps.resolveFeaturesPath]  — (cwd) => absolute features dir
 * @param {Function} [deps.resolveProjectTag]    — (cwd) => canonical project tag
 */
export function attachSmartmemoryRoutes(app, {
  getConfig = getSmartmemoryConfig,
  createClient = defaultCreateClient,
  readFeature = defaultReadFeature,
  resolveFeaturesPath = defaultResolveFeaturesPath,
  resolveProjectTag = defaultResolveProjectTag,
} = {}) {
  app.get('/api/smartmemory/recall', async (req, res) => {
    const root = req.workspace?.root;
    if (!root) {
      return res.json({ enabled: false });
    }

    let cfg;
    try {
      cfg = getConfig(root);
    } catch {
      cfg = {};
    }
    if (cfg?.enabled !== true) {
      return res.json({ enabled: false });
    }

    const featureCode = (req.query.featureCode || '').toString().trim();
    if (!featureCode) {
      return res.json({ enabled: true, available: true, results: [], invalidFeatureCode: true });
    }

    let feature;
    try {
      feature = readFeature(root, featureCode, resolveFeaturesPath(root));
    } catch {
      feature = null;
    }
    const desc = feature?.description || '';
    const query = desc ? `${featureCode} ${desc}` : featureCode;

    let hits;
    try {
      const client = createClient(cfg);
      hits = await client.search(query, { top_k: 10 });
    } catch (e) {
      return res.json({ enabled: true, available: false, error: shortReason(e) });
    }

    const results = (Array.isArray(hits) ? hits : (hits?.results ?? [])).map(mapHit);
    return res.json({
      enabled: true,
      available: true,
      featureCode,
      project: safeProjectTag(resolveProjectTag, root),
      results,
    });
  });
}
