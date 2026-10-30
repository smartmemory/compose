/**
 * popoutViews.js — the views the popout window (VisionTracker) can render.
 *
 * COMP-AUDIT-17: the popout keeps its own view set. Any key it has no branch
 * for (`dashboard`, `usage`, its own legacy default `roadmap`, garbage) renders
 * the Graph instead of a blank pane.
 */
export const POPOUT_VIEWS = ['graph', 'tree', 'pipeline', 'sessions', 'docs', 'gates', 'settings'];
export const POPOUT_FALLBACK_VIEW = 'graph';

export function popoutView(key) {
  return POPOUT_VIEWS.includes(key) ? key : POPOUT_FALLBACK_VIEW;
}
