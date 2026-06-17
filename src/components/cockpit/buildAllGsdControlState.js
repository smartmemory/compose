/**
 * buildAllGsdControlState.js — COMP-PARITY-8.
 *
 * Pure dispatch-shaping logic for <BuildAllGsdControl>. Kept JSX-free so it is
 * testable under `node --test` (which cannot parse JSX) and mirrors the repo
 * convention used by viewTabsState.js / opsStripLogic.js.
 *
 * The component owns the React state + the confirm dialog + the startBuild call;
 * this module just answers two questions:
 *   - what payload does each action send to startBuild?
 *   - is a GSD submit currently allowed (non-empty feature code)?
 *
 * No React imports; fully testable in Node.js.
 */

/**
 * Copy for the "Build all PLANNED" confirm dialog. Roadmap-wide and expensive,
 * so the action is gated behind a confirm (COMP-PARITY-8 design).
 */
export const BUILD_ALL_CONFIRM = {
  title: 'Build all PLANNED features?',
  body: 'This builds every still-buildable (PLANNED/PARTIAL) feature on the roadmap in dependency order. It is roadmap-wide and expensive.',
};

/**
 * Payload for the roadmap-wide batch build. No featureCode — `mode:'all'` is
 * roadmap-wide and reads ROADMAP.md under the server cwd (runBuildAll).
 *
 * @returns {{ mode: 'all' }}
 */
export function buildAllPayload() {
  return { mode: 'all' };
}

/**
 * Trims a raw feature-code input.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeFeatureCode(raw) {
  return (raw ?? '').trim();
}

/**
 * Whether a GSD submit is allowed for the given (raw) input — true only when the
 * trimmed feature code is non-empty.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function canSubmitGsd(raw) {
  return normalizeFeatureCode(raw).length > 0;
}

/**
 * Payload for a per-feature GSD dispatch. Returns null when the code is empty,
 * so callers can block the request and surface a validation error instead of
 * firing a code-less GSD build.
 *
 * @param {string} raw
 * @returns {{ featureCode: string, mode: 'gsd' } | null}
 */
export function gsdPayload(raw) {
  const featureCode = normalizeFeatureCode(raw);
  if (!featureCode) return null;
  return { featureCode, mode: 'gsd' };
}
