/**
 * textFit.js — measured text for the Day ribbon (COMP-DAYVIEW-DESIGN-FIX-1 U2, M2). The ribbon is drawn 1 SVG unit = 1 CSS px
 * (M1), so a label's width in px is its width on screen and text can be cut by what fits, never by a character count.
 *
 * Widths come from a canvas 2D context in the page's own font. jsdom has no canvas (its `getContext` only logs "not
 * implemented"), so there, and anywhere a context cannot be made, a fixed average glyph width stands in: deterministic, so
 * the tests can assert what fits.
 */
const FONT = "'Inter Variable', 'Inter', system-ui, -apple-system, sans-serif";
/** Average glyph width in em for the stand-in measure (Inter at 11 to 13 px reads about 0.56 em per character). */
export const AVG_CHAR_EM = 0.56;

let ctx;
function context() {
  if (ctx !== undefined) return ctx;
  ctx = null;
  try {
    const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
    if (!jsdom && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d') || null;
  } catch { ctx = null; }
  return ctx;
}

/** Width in px of `text` at `px` size and `weight`. */
export function textWidth(text, px, weight = 400) {
  const s = String(text ?? '');
  const c = context();
  if (c) {
    c.font = `${weight} ${px}px ${FONT}`;
    return c.measureText(s).width;
  }
  return s.length * px * AVG_CHAR_EM;
}

/** `text` cut with an ellipsis to fit `maxPx`; '' when not even one character and the ellipsis fit. */
export function fitText(text, maxPx, px, weight = 400) {
  const s = String(text ?? '');
  if (!(maxPx > 0)) return '';
  if (textWidth(s, px, weight) <= maxPx) return s;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${s.slice(0, mid).trimEnd()}…`, px, weight) <= maxPx) lo = mid; else hi = mid - 1;
  }
  return lo === 0 ? '' : `${s.slice(0, lo).trimEnd()}…`;
}
