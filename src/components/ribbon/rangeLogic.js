/**
 * rangeLogic.js — the pure half of the ribbon's range control (COMP-COCKPIT-RIBBON-RANGE-1).
 *
 * A window is `{from, to}`, both ISO strings WITH an offset (what `/api/ribbon` takes and what the URL hash carries).
 * Presets are wall-clock arithmetic in the offset of `now` (an ISO string's own offset, else the browser's), the same way
 * `ribbonLayout.js` reads clocks, so a window means the same thing in every zone and test. A DST change inside a window
 * shifts nothing in a fixed-offset `now`; in the browser's own zone the presets read each edge on the local clock (see `inBrowserZone`).
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
/**
 * Marks closer than this (in track px) merge into one count badge: a mark glyph is about 12 px wide at the ribbon's true
 * size, so two closer than that overprint. U2 M5: the rule is pixels at every window width (the old "only above 36 h" rule
 * stacked glyph runs on the Day window).
 */
export const CLUSTER_PX = 12;

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

// Presets and the browser's DST. `now` reaches them as an ISO string with ONE fixed offset, which cannot say when the zone
// changes it. When that offset is the browser's own at `now`, the browser's zone rules are known: the day's edges are read
// on the local clock and each end carries the offset in force at ITS instant, so a day that holds a clock change still starts
// and ends on its local hours. Any other offset (a fixture, a UTC `Z` string) has no rules to use: it stays one fixed offset.
const browserOff = (ms) => -new Date(ms).getTimezoneOffset() * MIN;
const inBrowserZone = (now) => typeof now !== 'string' || zoneOf(now) === browserOff(toMs(now));
/** Local midnight that starts the day holding `now`. */
function midnightOf(now) {
  if (!inBrowserZone(now)) return dayStart(toMs(now), zoneOf(now));
  const t = new Date(toMs(now));
  return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
}
/** `anchor` moved by `shift` on the wall clock (a calendar step, not elapsed time): 30 h after a local midnight is 06:00 the next day. */
function wallShift(now, anchor, shift) {
  if (!inBrowserZone(now)) return anchor + shift;
  const d = new Date(anchor + browserOff(anchor) + shift);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
}
const winFor = (now, a, b) => (inBrowserZone(now) ? { from: isoAt(a, browserOff(a)), to: isoAt(b, browserOff(b)) } : win(a, b, zoneOf(now)));
const aroundDay = (now, fromShift, toShift) => { const d = midnightOf(now); return winFor(now, wallShift(now, d, fromShift), wallShift(now, d, toShift)); };

/** Named table: each preset resolves `(now)` to a window with the right-of-now section visible. */
export const PRESETS = {
  '6h': (now) => { const n = toMs(now); return winFor(now, n - 4 * HOUR, n + 2 * HOUR); },
  day: (now) => aroundDay(now, -6 * HOUR, 30 * HOUR),
  '3d': (now) => aroundDay(now, -2 * DAY, 2 * DAY),
  week: (now) => aroundDay(now, -6 * DAY, 2 * DAY),
};
export const PRESET_KEYS = ['6h', 'day', '3d', 'week'];
export const PRESET_LABEL = { '6h': '6h', day: 'Day', '3d': '3 days', week: 'Week' };

export const widthOf = (w) => toMs(w.to) - toMs(w.from);
const containsNow = (w, now) => toMs(w.from) <= toMs(now) && toMs(now) <= toMs(w.to);

/** The preset key whose width this window has, else null. */
export function activePreset(w) {
  const width = widthOf(w);
  const ref = '2026-01-01T12:00:00Z';
  // Within an hour: a window that holds a clock change is an hour wider or narrower than its preset's nominal width.
  return PRESET_KEYS.find((k) => Math.abs(widthOf(PRESETS[k](ref)) - width) <= HOUR) || null;
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
  // A hand-typed or bookmarked `+08:00` arrives as a space (URLSearchParams reads `+` as one); no ISO string holds a space, so read it back (RIBBON-TOP-1).
  const plus = (v) => (v == null ? v : v.replace(/ (\d\d:\d\d)$/, '+$1'));
  const from = plus(q.get('from'));
  const to = plus(q.get('to'));
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

/**
 * ISO string for a `datetime-local` value, read in the zone of `like` (an ISO string with an offset). When `like` is in the
 * browser's own zone (U2-DATA Q2), the value is read on the browser's local clock and carries the offset in force at ITS
 * instant, the presets' rule: a picked time across a clock change keeps its wall hour instead of shifting by the change.
 */
export function fromLocalInput(value, like) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(value || '');
  if (!m) return null;
  if (inBrowserZone(like)) {
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    return Number.isFinite(ms) ? isoAt(ms, browserOff(ms)) : null;
  }
  const off = zoneOf(like);
  const wallMs = Date.parse(`${value}:00Z`);
  return Number.isFinite(wallMs) ? isoAt(wallMs - off, off) : null;
}

/**
 * One lane's marks, merged where they sit closer than `CLUSTER_PX` on a track `widthPx` wide. A run of marks within
 * `CLUSTER_PX` of the run's first mark becomes `{kind: 'cluster', at, count, items}` (at = the members' mean time); a mark
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
