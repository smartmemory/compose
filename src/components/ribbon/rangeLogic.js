/**
 * rangeLogic.js — the pure half of the ribbon's range control (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * A window is `{from, to}`, both ISO strings WITH an offset (what `/api/ribbon` takes and what the URL hash carries).
 * Presets are wall-clock arithmetic in the offset of `now` (an ISO string's own offset, else the browser's), the same way
 * `ribbonLayout.js` reads clocks, so a window means the same thing in every zone and test. A DST change inside a window
 * shifts nothing here: the offset of `now` is used throughout.
 */
import { offsetMs, toMs } from './ribbonLayout.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The feed refuses a window over 31 days; the ribbon is never shorter than an hour. */
export const MAX_WINDOW_MS = 31 * DAY;
export const MIN_WINDOW_MS = HOUR;
/** A drag on the axis shorter than this is a click, not a zoom. */
export const MIN_DRAG_MS = 15 * MIN;
/** Marks closer than this (in track px) merge into one count badge. */
export const CLUSTER_PX = 16;
/** The drawing clusters only windows wider than the day default (36 h): at day width ROWS's marks are drawn singly. */
export const CLUSTER_ABOVE_MS = 36 * HOUR;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Offset (ms east of UTC) that `now` is read in: its own ISO offset, else the browser's. */
export function zoneOf(now) {
  if (typeof now === 'string') return offsetMs(now);
  return -new Date(now).getTimezoneOffset() * MIN;
}

/** ISO string with an offset (`2026-10-31T18:00:00-07:00`) for `ms`, read in zone `off`. */
export function isoAt(ms, off) {
  const d = new Date(ms + off);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const zone = `${sign}${pad(Math.floor(a / HOUR))}:${pad(Math.floor((a % HOUR) / MIN))}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${zone}`;
}

/** ms of local midnight that starts the day holding `ms`, in zone `off`. */
const dayStart = (ms, off) => Math.floor((ms + off) / DAY) * DAY - off;

const win = (fromMs, toMs2, off) => ({ from: isoAt(fromMs, off), to: isoAt(toMs2, off) });

/** Named table: each preset resolves `(now)` to a window with the right-of-now section visible. */
export const PRESETS = {
  '6h': (now) => { const n = toMs(now); return win(n - 4 * HOUR, n + 2 * HOUR, zoneOf(now)); },
  day: (now) => { const off = zoneOf(now); const d = dayStart(toMs(now), off); return win(d - 6 * HOUR, d + 30 * HOUR, off); },
  '3d': (now) => { const off = zoneOf(now); const d = dayStart(toMs(now), off); return win(d - 2 * DAY, d + 2 * DAY, off); },
  week: (now) => { const off = zoneOf(now); const d = dayStart(toMs(now), off); return win(d - 6 * DAY, d + 2 * DAY, off); },
};
export const PRESET_KEYS = ['6h', 'day', '3d', 'week'];
export const PRESET_LABEL = { '6h': '6h', day: 'Day', '3d': '3 days', week: 'Week' };

export const widthOf = (w) => toMs(w.to) - toMs(w.from);
const containsNow = (w, now) => toMs(w.from) <= toMs(now) && toMs(now) <= toMs(w.to);

/** The preset key whose width this window has, else null. */
export function activePreset(w) {
  const width = widthOf(w);
  const ref = '2026-01-01T12:00:00Z';
  return PRESET_KEYS.find((k) => widthOf(PRESETS[k](ref)) === width) || null;
}

/** Live window: the preset's own anchoring. Past window: keep its centre, take the preset's width. */
export function applyPreset(key, w, now) {
  const preset = PRESETS[key];
  if (!preset) return w;
  if (containsNow(w, now)) return preset(now);
  const off = zoneOf(typeof w.from === 'string' ? w.from : now);
  const centre = (toMs(w.from) + toMs(w.to)) / 2;
  const half = widthOf(preset(now)) / 2;
  return win(centre - half, centre + half, off);
}

/** Back (-1) or forward (+1) by the window's own width. */
export function step(w, dir) {
  const width = widthOf(w);
  const off = zoneOf(w.from);
  return win(toMs(w.from) + dir * width, toMs(w.to) + dir * width, off);
}

/**
 * Same width, `now` back where the default puts it: the day width is exactly the day default; any other width puts
 * `now` a quarter of the width from the right edge.
 */
export function recentre(w, now) {
  const width = widthOf(w);
  if (width === widthOf(PRESETS.day(now))) return PRESETS.day(now);
  const off = zoneOf(now);
  const to = toMs(now) + width / 4;
  return win(to - width, to, off);
}

/**
 * Make a window legal: `from < to`, at least an hour, at most 31 days. `anchor` is the end that stays put (the one the
 * user did NOT just edit). Returns `{window, clampedBecause}`; `clampedBecause` is null when nothing moved.
 */
export function clampWindow(w, { anchor = 'from' } = {}) {
  const f = toMs(w.from);
  const t = toMs(w.to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return { window: null, clampedBecause: 'That is not a date and time.' };
  const off = zoneOf(w.from);
  const width = t - f;
  if (width < MIN_WINDOW_MS) {
    const because = width <= 0 ? 'The end must be after the start, so the window was set to 1 hour.' : 'A window is at least 1 hour.';
    return anchor === 'to'
      ? { window: win(t - MIN_WINDOW_MS, t, off), clampedBecause: because }
      : { window: win(f, f + MIN_WINDOW_MS, off), clampedBecause: because };
  }
  if (width > MAX_WINDOW_MS) {
    const because = 'A window is at most 31 days (what the feed serves).';
    return anchor === 'to'
      ? { window: win(t - MAX_WINDOW_MS, t, off), clampedBecause: because }
      : { window: win(f, f + MAX_WINDOW_MS, off), clampedBecause: because };
  }
  return { window: { from: w.from, to: w.to }, clampedBecause: null };
}

const HASH_PREFIX = '#ribbon.';

/** `#ribbon.from=<iso>&to=<iso>` to `{from, to}`; null for any other hash or an unusable pair. */
export function parseHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(HASH_PREFIX)) return null;
  const q = new URLSearchParams(hash.slice(HASH_PREFIX.length));
  const from = q.get('from');
  const to = q.get('to');
  if (!from || !to) return null;
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || f >= t) return null;
  return { from, to };
}

/** `{from, to}` to `#ribbon.from=<iso>&to=<iso>` with each ISO `encodeURIComponent`-ed. */
export function formatHash(w) {
  return `${HASH_PREFIX}from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;
}

/** A hash this control owns (valid or not), so clearing never touches someone else's hash. */
export const isRibbonHash = (hash) => typeof hash === 'string' && hash.startsWith(HASH_PREFIX);

/** `datetime-local` value ("2026-10-31T18:00") for an ISO string: its own wall clock, no zone shift. */
export const toLocalInput = (iso) => (typeof iso === 'string' ? iso.slice(0, 16) : '');

/** ISO string for a `datetime-local` value, read in the zone of `like` (an ISO string with an offset). */
export function fromLocalInput(value, like) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value || '')) return null;
  const off = zoneOf(like);
  const wallMs = Date.parse(`${value}:00Z`);
  return Number.isFinite(wallMs) ? isoAt(wallMs - off, off) : null;
}

/**
 * One lane's marks, merged where they sit closer than `CLUSTER_PX` on a track `widthPx` wide. A run of marks within
 * 16 px of the run's first mark becomes `{kind: 'cluster', at, count, items}` (at = the members' mean time); a mark
 * alone passes through unchanged. A cluster already in the list counts as its own `count`. Marks outside the window
 * pass through untouched (the drawing filters them).
 */
export function clusterMarks(marks, w, widthPx) {
  const f = toMs(w.from);
  const span = toMs(w.to) - f;
  const px = (m) => ((toMs(m.at) - f) / span) * widthPx;
  const inside = (m) => toMs(m.at) >= f && toMs(m.at) <= toMs(w.to);
  const sorted = [...(marks || [])].filter(inside).sort((a, b) => toMs(a.at) - toMs(b.at));
  const out = (marks || []).filter((m) => !inside(m));
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) out.push(run[0]);
    else {
      const items = run.flatMap((m) => (m.kind === 'cluster' ? m.items || [m] : [m]));
      const count = run.reduce((n, m) => n + (m.kind === 'cluster' ? m.count || 1 : 1), 0);
      const mean = Math.round(run.reduce((n, m) => n + toMs(m.at), 0) / run.length);
      const first = run[0].at;
      out.push({ kind: 'cluster', at: typeof first === 'string' ? isoAt(mean, zoneOf(first)) : mean, count, items });
    }
    run = [];
  };
  sorted.forEach((m) => {
    if (run.length && px(m) - px(run[0]) >= CLUSTER_PX) flush();
    run.push(m);
  });
  flush();
  return out.sort((a, b) => toMs(a.at) - toMs(b.at));
}
