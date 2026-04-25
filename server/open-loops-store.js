/**
 * open-loops-store.js — COMP-OBS-LOOPS persistence layer.
 *
 * Reads/writes item.lifecycle.lifecycle_ext.open_loops[] via the existing
 * updateLifecycleExt path (same as BRANCH for branch_lineage).
 *
 * Design decisions:
 *   - Server fills id (UUID v4), created_at, parent_feature from item.lifecycle.featureCode.
 *   - parent_feature is REQUIRED by schema — route returns 400 if item lacks featureCode.
 *   - Append-only: resolution is set in-place; entries are never deleted.
 *   - isStaleLoop is exported here and imported by status-snapshot.js so the
 *     panel and STATUS agree on the stale predicate (Decision 3).
 */

import { randomUUID } from 'node:crypto';

/**
 * Returns true if a loop is unresolved and past its TTL.
 * @param {object} loop — OpenLoop object
 * @param {number} nowMs — epoch ms (Date.parse result or Date.now())
 */
export function isStaleLoop(loop, nowMs) {
  if (loop.resolution) return false; // resolved — never stale
  const ttl = loop.ttl_days ?? 90;
  const ageMs = nowMs - Date.parse(loop.created_at);
  return ageMs > ttl * 24 * 60 * 60 * 1000;
}

/**
 * Add an OpenLoop to an item.
 * The caller must persist the result via store.updateLifecycleExt(item.id, 'open_loops', next).
 *
 * @param {object} item — vision store item (must have lifecycle.featureCode)
 * @param {{ kind, summary, parent_branch?, ttl_days? }} fields
 * @returns {{ loop: OpenLoop, nextLoops: OpenLoop[] }}
 * @throws {Error} if item has no featureCode (400 guard)
 */
export function addOpenLoop(item, { kind, summary, parent_branch, ttl_days }) {
  const featureCode = item.lifecycle?.featureCode;
  if (!featureCode) {
    throw Object.assign(new Error('item has no lifecycle.featureCode — cannot create feature-scoped open loop'), { status: 400 });
  }

  const loop = {
    id: randomUUID(),
    kind,
    summary,
    created_at: new Date().toISOString(),
    parent_feature: featureCode,
    parent_branch: parent_branch ?? null,
    resolution: null,
    ttl_days: ttl_days ?? 90,
  };

  const existing = item.lifecycle?.lifecycle_ext?.open_loops ?? [];
  const nextLoops = [...existing, loop];
  return { loop, nextLoops };
}

/**
 * Resolve an open loop in place.
 * @param {object} item — vision store item
 * @param {string} loopId
 * @param {{ note: string, resolved_by: string }} resolution
 * @returns {{ loop: OpenLoop, nextLoops: OpenLoop[] }}
 * @throws {Error} if loopId not found (404) or already resolved (400)
 */
export function resolveOpenLoop(item, loopId, { note, resolved_by }) {
  const existing = item.lifecycle?.lifecycle_ext?.open_loops ?? [];
  const idx = existing.findIndex(l => l.id === loopId);
  if (idx === -1) {
    throw Object.assign(new Error(`loop not found: ${loopId}`), { status: 404 });
  }
  const loop = existing[idx];
  if (loop.resolution !== null && loop.resolution !== undefined) {
    throw Object.assign(new Error(`loop already resolved: ${loopId}`), { status: 400 });
  }

  const resolved = {
    ...loop,
    resolution: {
      resolved_at: new Date().toISOString(),
      resolved_by: resolved_by || 'unknown',
      note: note || '',
    },
  };

  const nextLoops = existing.map((l, i) => (i === idx ? resolved : l));
  return { loop: resolved, nextLoops };
}

/**
 * List open loops for an item.
 * @param {object} item
 * @param {{ includeResolved?: boolean }} opts
 * @returns {OpenLoop[]}
 */
export function listOpenLoops(item, { includeResolved = false } = {}) {
  const loops = item.lifecycle?.lifecycle_ext?.open_loops ?? [];
  if (includeResolved) return [...loops];
  return loops.filter(l => l.resolution == null);
}
