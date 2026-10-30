/**
 * focusedFeature.js — the focused feature (COMP-AUDIT-17 §2.5). Pure, no React.
 *
 * Focus is explicit state, separate from selection. Only the right panel's
 * Focus button sets it and only the chip's × (or a project switch, or a stale
 * code on load) clears it. Selecting, re-clicking, deselecting never touch it.
 */

export const FOCUS_STORAGE_KEY = 'compose:focusedFeature';

/** The feature code of an item, in the order the cockpit has always used; '' when it has none. */
export function itemFeatureCode(item) {
  if (!item) return '';
  const code = item.featureCode || item.feature_code || item.lifecycle?.featureCode || '';
  return typeof code === 'string' ? code : '';
}

/** True when some item carries `code`. */
export function featureCodeResolves(items, code) {
  if (!code || !Array.isArray(items)) return false;
  return items.some((i) => itemFeatureCode(i) === code);
}

/**
 * The feature the cockpit is about: focus wins, else the bound agent session's.
 * Filters apply only when `source === 'focus'`; displays use `code` whatever the source.
 * @returns {{code: string|null, source: 'focus'|'session'|null}}
 */
export function resolveFeatureContext({ focusedFeature, sessionState } = {}) {
  if (focusedFeature) return { code: focusedFeature, source: 'focus' };
  const sessionCode = sessionState?.featureCode;
  if (sessionCode) return { code: sessionCode, source: 'session' };
  return { code: null, source: null };
}

/** The code a feature filter should use: only an explicit focus filters a project view. */
export function filterFeatureCode(ctx) {
  return ctx?.source === 'focus' ? ctx.code : null;
}

/** A persisted value is usable only if it is a non-empty string. */
export function parseStoredFocus(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * Focus reducer. State is the focused code or null. Actions:
 *   focus {item}        set from an item whose code resolves (no code: no change)
 *   clear               the chip's ×
 *   projectSwitch       cleared
 *   reconcile {items}   cleared when items are loaded and none carries the code
 * Any other action (select, reselect, deselect, session bind, ...) leaves it as is.
 */
export function focusReducer(state, action) {
  switch (action?.type) {
    case 'focus': {
      const code = itemFeatureCode(action.item);
      return code || state;
    }
    case 'clear':
    case 'projectSwitch':
      return null;
    case 'reconcile':
      if (state && Array.isArray(action.items) && action.items.length > 0 && !featureCodeResolves(action.items, state)) return null;
      return state;
    default:
      return state;
  }
}
