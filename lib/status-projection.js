/**
 * status-projection.js — the single canonical status mapping (COMP-MCP-VALIDATE-3).
 *
 * Projects a feature/ROADMAP status (UPPERCASE roadmap vocabulary) onto the
 * vision-state status (lowercase tracker vocabulary). Used on WRITE (the
 * `setFeatureStatus` projection and the back-projection migration) AND on READ
 * (the validator's `*_VS_VISION_STATE` comparison), so a status written by the
 * projection can never itself trip STATUS_MISMATCH_*_VS_VISION_STATE — one rule
 * set, enforced on write and read.
 *
 * Pure data, no IO.
 */

// feature/ROADMAP UPPERCASE status -> vision-state lowercase status.
const FEATURE_TO_VISION = {
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'in_progress', // vision cannot represent "partially shipped"
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
  PARKED: 'parked',
  KILLED: 'killed',
  SUPERSEDED: 'superseded', // D1: vision VALID_STATUSES gains 'superseded'
};

// feature/ROADMAP UPPERCASE status -> external issue state.
const FEATURE_TO_EXTERNAL_EXPECT = {
  PLANNED: 'open',
  IN_PROGRESS: 'open',
  PARTIAL: 'open',
  COMPLETE: 'closed',
  BLOCKED: 'open',
  PARKED: null,
  KILLED: 'closed',
  SUPERSEDED: 'closed',
};

/**
 * @param {string|null|undefined} status  A feature/ROADMAP status (any case).
 * @returns {string|null} The vision-state status, or null for empty/unknown
 *   input. Vision-native statuses with no feature-vocab key (e.g. ready/review)
 *   also return null; callers treat null as "no opinion" — the validator falls
 *   back to identity, the writer skips the projection.
 */
export function featureStatusToVisionStatus(status) {
  if (!status) return null;
  return FEATURE_TO_VISION[String(status).toUpperCase()] ?? null;
}

/**
 * @param {string|null|undefined} status  A feature/ROADMAP status (any case).
 * @returns {'open'|'closed'|null} The desired external issue state, or null
 *   when the status is parked, empty, or unknown.
 */
export function featureStatusToExternalExpect(status) {
  if (!status) return null;
  return FEATURE_TO_EXTERNAL_EXPECT[String(status).toUpperCase()] ?? null;
}
