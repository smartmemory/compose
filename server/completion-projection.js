/**
 * server/completion-projection.js — COMP-COMPLETION-GATE slice 3 (§2.3b).
 *
 * The self-verifying projection: ONE predicate that decides whether a vision
 * item may be shown as `complete`, and FOUR transports that apply it —
 *
 *   verifiedCompleteProjection({ item, featureCode, cwd, … })
 *      ├── POST /api/vision/items/:id/completion-projection   (the gate over REST)
 *      ├── applyVerifiedProjection(store, …)                    (in-process: the
 *      │       /lifecycle/complete route, the startup scanner, the reconciler)
 *      └── VisionWriter.completeItem direct mode                (no server running)
 *
 * The property that matters: the predicate carries NO authority of its own. It
 * re-reads canonical state — feature.json, and the guard ledger when a guard
 * resource exists — and refuses unless the completion is ALREADY recorded
 * there. A caller who can satisfy it could simply have read the same truth, so
 * it can be public without reopening the bypass AC-10/AC-16 close. There is no
 * token, no secret, and nothing to forge.
 *
 * Three verification tiers, stamped on the projection so a reader can never
 * mistake a weaker one for a stronger one (AC-16b):
 *
 *   'guarded'                — a guard resource exists and its state is complete
 *   'canonical-status-only'  — feature.json is COMPLETE, no guard resource exists
 *                              (the 230 legacy features; startup seeding)
 *   'document-derived'       — no feature.json at all; the scanner derived
 *                              completion from documents (unmanaged folders).
 *                              Display state, never a completion compose vouches for.
 *
 * Only `guard_not_found` means legacy. Any other guard outcome — timeout, spawn
 * failure, corrupt registry — fails CLOSED (§2.3b, round 5).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { readFeature, featuresBase } from '../lib/feature-json.js';
import { loadFeaturesDir } from '../lib/project-paths.js';
import { resolveMode } from '../lib/lifecycle-modes.js';
import { guardEnabled, currentGuardState } from '../lib/completion-gate.js';
import { resourceId } from './lifecycle-guard.js';

export const VERIFIED_BY = Object.freeze({
  GUARDED: 'guarded',
  CANONICAL: 'canonical-status-only',
  DOCUMENT: 'document-derived',
});

/** The mode a vision item's lifecycle runs under; build when unstated. */
export function itemMode(item) {
  return resolveMode(item?.lifecycle?.mode ?? 'build');
}

/**
 * A MANAGED build-mode feature item: it is bound to a feature code by its
 * lifecycle, that lifecycle is build mode, and the workspace has a feature.json
 * for the code. This is the exact set the general status writers refuse
 * `complete` for (AC-10, AC-16). Everything else — fix/plan items, UI-created
 * items with no lifecycle, the `compose new` kickoff item (a build-mode item
 * with no feature.json) — is not a feature completion the gate governs, and
 * keeps its existing path (§2.3d; design §1.3 "documented, not changed").
 */
export function isManagedBuildItem(item, cwd) {
  const code = item?.lifecycle?.featureCode;
  if (!code || itemMode(item) !== 'build') return false;
  // EXISTENCE, not parseability: a present-but-malformed feature.json is a
  // managed feature whose canon is broken, and the refusals must still apply
  // (Codex r1 #1 — a corrupt file must not read as "unmanaged, anything goes").
  return canonicalFile(cwd, code).exists;
}

/** feature.json for `code`: whether it exists, and its parsed content (null when unreadable). */
export function canonicalFile(cwd, code) {
  const dir = loadFeaturesDir(cwd);
  const file = path.join(featuresBase(cwd, dir), code, 'feature.json');
  const exists = existsSync(file);
  return { exists, file, feature: exists ? readFeature(cwd, code, dir) : null };
}

/**
 * Decide whether `item` may be projected as complete for `featureCode`.
 *
 * @param {object}  a
 * @param {object}  a.item                the vision item (any transport's copy)
 * @param {string}  a.featureCode
 * @param {string}  a.cwd                 workspace root (feature.json, capabilities, resourceId)
 * @param {boolean} [a.consultGuard=true] read the guard ledger (async subprocess). The
 *                                        synchronous startup path passes false (§2.3b).
 * @param {boolean} [a.allowDocumentDerived=false] scanner only: accept a folder with no
 *                                        feature.json as the weakest tier
 * @returns {Promise<{ok:boolean, verified_by?:string, reasons:string[], guardState?:string|null}>}
 */
export async function verifiedCompleteProjection({
  item, featureCode, cwd, consultGuard = true, allowDocumentDerived = false,
}) {
  const reasons = [];
  if (!item) return { ok: false, reasons: ['vision item not found'] };
  if (!featureCode) return { ok: false, reasons: ['featureCode is required'] };
  if (!cwd) return { ok: false, reasons: ['cwd is required'] };

  // 3. the item is bound to this feature. An unbound item (no lifecycle) may be
  //    projected only when its id or featureCode field names the code — the
  //    same match `findFeatureItem` uses — so the scanner's freshly created
  //    items and legacy UI items are reachable, but a lifecycle bound to a
  //    DIFFERENT code is never overwritten.
  const bound = item.lifecycle?.featureCode;
  if (bound && bound !== featureCode) {
    return { ok: false, reasons: [`item ${item.id} is bound to ${bound}, not ${featureCode}`] };
  }
  if (!bound && item.id !== featureCode && item.featureCode !== featureCode && item.title !== featureCode) {
    return { ok: false, reasons: [`item ${item.id} is not bound to ${featureCode}`] };
  }

  // 1. canonical status
  const canon = canonicalFile(cwd, featureCode);
  if (canon.exists && !canon.feature) {
    // Present but unreadable: canon is BROKEN, not absent. Never downgrade to
    // the document tier; nothing can be verified against a corrupt file.
    return { ok: false, reasons: [`feature.json for ${featureCode} exists but could not be parsed — refusing to project a completion against broken canon`] };
  }
  const feature = canon.feature;
  if (!feature) {
    if (allowDocumentDerived) {
      return { ok: true, verified_by: VERIFIED_BY.DOCUMENT, reasons: [] };
    }
    return { ok: false, reasons: [`no feature.json for ${featureCode} — nothing canonical records a completion`] };
  }
  if (feature.status !== 'COMPLETE') {
    reasons.push(`feature.json for ${featureCode} reads ${feature.status ?? '(no status)'}, not COMPLETE`);
    return { ok: false, reasons };
  }

  // 2. the guard, only if a resource exists — and only when the workspace has
  //    the guard enabled; with it off no resource can have been created by
  //    compose and there is no stratum to ask.
  if (!consultGuard || !guardEnabled(cwd)) {
    return { ok: true, verified_by: VERIFIED_BY.CANONICAL, reasons: [], guardState: null };
  }
  const rid = resourceId(featureCode, cwd, itemMode(item));
  const g = await currentGuardState(rid);
  if (g.error) {
    // Fail closed. An unreachable guard is not a legacy feature.
    return {
      ok: false,
      reasons: [`guard state for ${featureCode} could not be read (${g.error.code || g.error.error_type || 'error'}: ${g.error.message || ''}) — refusing rather than downgrading the verification tier`],
      guardState: null,
    };
  }
  if (g.state === null) {
    return { ok: true, verified_by: VERIFIED_BY.CANONICAL, reasons: [], guardState: null };
  }
  if (g.state !== 'complete') {
    return { ok: false, reasons: [`guard for ${featureCode} is in state "${g.state}", not complete`], guardState: g.state };
  }
  return { ok: true, verified_by: VERIFIED_BY.GUARDED, reasons: [], guardState: 'complete' };
}

/**
 * The projection record written next to `status: 'complete'`.
 * @param {{ok:true, verified_by:string}} verdict
 * @param {{commitSha?:string, ledgerRef?:string, source?:string}} [evidence]
 */
export function projectionStamp(verdict, evidence = {}) {
  return {
    verified_by: verdict.verified_by,
    at: new Date().toISOString(),
    ...(evidence.commitSha ? { commit_sha: evidence.commitSha } : {}),
    ...(evidence.ledgerRef ? { ledger_ref: evidence.ledgerRef } : {}),
    ...(evidence.source ? { source: evidence.source } : {}),
  };
}

/**
 * In-process transport: verify, then write to the live VisionStore.
 * Used by the /lifecycle/complete route, the reconciler, and the startup
 * scanner (the latter with `consultGuard:false, allowDocumentDerived:true`).
 *
 * @returns {Promise<{ok:boolean, verified_by?:string, reasons:string[], item?:object}>}
 */
export async function applyVerifiedProjection(store, {
  itemId, featureCode, cwd, consultGuard = true, allowDocumentDerived = false, evidence = {},
}) {
  const item = store.items.get(itemId);
  const v = await verifiedCompleteProjection({ item, featureCode, cwd, consultGuard, allowDocumentDerived });
  if (!v.ok) return v;
  const prior = { status: item.status, completion_projection: item.completion_projection ?? null };
  const updated = store.updateItem(itemId, {
    status: 'complete',
    completion_projection: projectionStamp(v, evidence),
  });
  // `_save` swallows disk failures into a boolean the store records. A
  // projection that only reached memory is not a projection: it vanishes on
  // restart with no partial result and no recovery identity (Codex r1 #2).
  // Roll the live item back so memory and disk agree, and report the failure.
  if (store.lastSaveOk === false) {
    try { store.updateItem(itemId, prior); } catch { /* best-effort rollback */ }
    return { ok: false, reasons: [`vision-state could not be persisted for ${itemId} — projection rolled back`] };
  }
  return { ok: true, verified_by: v.verified_by, reasons: [], item: updated };
}

/** True when `p` is inside the workspace's features dir (used by the allowlist test's docs). */
export function isFeatureJsonPath(cwd, p) {
  const base = path.resolve(cwd, loadFeaturesDir(cwd));
  return path.resolve(p).startsWith(base) && existsSync(p);
}
