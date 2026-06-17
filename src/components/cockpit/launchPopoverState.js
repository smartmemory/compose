/**
 * launchPopoverState.js — Pure logic for LaunchPopover, testable without
 * React/JSX (the repo runs UI logic tests under `node --test`, which cannot
 * parse JSX — see opsStripLogic.js / viewTabsState.js for the same pattern).
 *
 * buildLaunchPayload shapes the startBuild() argument object for the three
 * launcher lifecycles (COMP-PARITY-2):
 *
 *   - fix:    { featureCode: <bug code>, mode: 'bug', description }
 *   - new:    { mode: 'new', description: <intent> }            (no featureCode)
 *   - resume: { featureCode: <active bug code>, mode: 'bug', resume: true }
 *
 * It returns either `{ args }` (ready to spread into startBuild) or
 * `{ error }` (a validation message to surface to the user). It never throws.
 */

/**
 * @param {'fix'|'new'|'resume'} lifecycle
 * @param {{ bugCode?: string, intent?: string, description?: string, resumableCode?: string }} fields
 * @returns {{ args: object }|{ error: string }}
 */
export function buildLaunchPayload(lifecycle, fields = {}) {
  const {
    bugCode = '',
    intent = '',
    description = '',
    resumableCode = '',
  } = fields;

  if (lifecycle === 'new') {
    const text = (intent || '').trim();
    if (!text) return { error: 'Product intent is required' };
    return { args: { mode: 'new', description: text } };
  }

  if (lifecycle === 'resume') {
    const code = (resumableCode || '').trim();
    if (!code) return { error: 'No active fix to resume' };
    return { args: { featureCode: code, mode: 'bug', resume: true } };
  }

  // Default: 'fix'
  const code = (bugCode || '').trim();
  if (!code) return { error: 'Bug code is required' };
  return { args: { featureCode: code, mode: 'bug', description: (description || '').trim() } };
}
