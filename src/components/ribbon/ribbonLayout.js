/**
 * ribbonLayout.js — the pure half of the Day ribbon (COMP-COCKPIT-RIBBON-ROWS-1).
 *
 * Everything here is arithmetic and wording: where a time sits on the track, which ticks the axis gets, how lanes group
 * and fold, and the exact tooltip text for every drawn item. `DayRibbon.jsx` only draws what these return.
 *
 * Clock text is read from the ISO string's own wall-clock fields (`2026-10-31T16:40:00-07:00` is "16:40" wherever the
 * browser runs), so a window means the same thing on every machine and in every test.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_PARTS = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/;

/** Named table by window width: the first row whose `maxHours` holds the window picks the tick step. */
export const AXIS_STEP = [
  { maxHours: 8, stepHours: 1 },
  { maxHours: 36, stepHours: 3 },
  { maxHours: 96, stepHours: 12 },
  { maxHours: Infinity, stepHours: 24 },
];

/** A tick is never closer than this to its neighbour; the axis drops every other one until it holds. */
export const MIN_TICK_PX = 48;

export const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

/**
 * U2 RANGE M1: a pointer's client x as an x in the svg's own units. The svg scales its viewBox `vbW` x `vbH` into the box
 * `rect` with "xMidYMid meet", so when the box's aspect differs the drawing is letterboxed: scale is the smaller of the two
 * ratios and the slack is split either side. Reading x as `(clientX - rect.left) * vbW / rect.width` ignores both and puts
 * a drag hundreds of units off (viewBox 1200x307 in a 1200x153.5 box: client 346 is x 92, not 346).
 */
export function clientToSvgX(clientX, rect, vbW, vbH) {
  const w = rect?.width || vbW;
  const h = rect?.height || vbH;
  const k = Math.min(w / vbW, h / vbH) || 1;
  const pad = (w - vbW * k) / 2;
  return (clientX - (rect?.left || 0) - pad) / k;
}

/** x position of time `t` on a track `width` wide, `from` at 0 and `to` at `width`. */
export function xOf(t, from, to, width) {
  const f = toMs(from);
  return ((toMs(t) - f) / (toMs(to) - f)) * width;
}

/** True when `now` is inside the window (both ends included). */
export function isLive(from, to, now) {
  const n = toMs(now);
  return n >= toMs(from) && n <= toMs(to);
}

/** "4h 30m", "40m", "2d 3h", "3h". Whole minutes; under a minute reads "0m". */
export function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / MIN));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const pad = (n) => String(n).padStart(2, '0');

const HAS_OFFSET = /(?:Z|[+-]\d\d:?\d\d)$/;
const utcFields = (ms) => {
  const x = new Date(ms);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() };
};
/** Offset in ms of `ref` (an ISO string that carries the window's offset), or null when it names none. */
const refOffset = (ref) => (typeof ref === 'string' && HAS_OFFSET.test(ref) ? offsetMs(ref) : null);

/**
 * Wall-clock fields as `{y, mo, d, h, mi}`, null when unparseable. `ref` is any ISO string carrying the window's offset
 * (`now`, `from`). With it, a string whose own offset differs (the feed's `...Z` stamps) and a number (ms) are converted
 * to that offset first, so "as of" reads the same wall time as the axis. Without it a string reads its own fields and a
 * number reads UTC (the callers that pass an already shifted number).
 */
function wall(t, ref) {
  const off = refOffset(ref);
  if (typeof t === 'string') {
    const m = ISO_PARTS.exec(t);
    if (!m) return null;
    if (off != null && HAS_OFFSET.test(t) && offsetMs(t) !== off) return utcFields(Date.parse(t) + off);
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  }
  if (typeof t === 'number' && Number.isFinite(t)) return utcFields(t + (off ?? 0));
  return null;
}
const dayNumber = (w) => Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / DAY);
const weekdayOf = (w) => WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()];

/** "16:40". */
export function clock(t, ref) {
  const w = wall(t, ref);
  return w ? `${pad(w.h)}:${pad(w.mi)}` : '';
}

/** Offset of an ISO string from UTC in ms (`Z` and a missing offset are 0). */
export function offsetMs(iso) {
  const m = /([+-])(\d\d):?(\d\d)$/.exec(String(iso));
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * HOUR + Number(m[3]) * MIN) : 0;
}

/** Day word relative to `now`: "yesterday", "today", "tomorrow", else "Fri 30 Oct". */
function dayWord(t, now) {
  const w = wall(t, now);
  const n = wall(now);
  if (!w || !n) return '';
  const diff = dayNumber(w) - dayNumber(n);
  if (diff === -1) return 'yesterday';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return `${weekdayOf(w)} ${w.d} ${MONTHS[w.mo - 1]}`;
}

/** "yesterday 22:10", "today 09:10", "Fri 30 Oct 18:00". */
export function when(t, now) {
  return `${dayWord(t, now)} ${clock(t, now)}`.trim();
}

/** "Sat 31". */
export function dayLabel(t, ref) {
  const w = wall(t, ref);
  return w ? `${weekdayOf(w)} ${w.d}` : '';
}

/** "Fri 30 Oct 18:00". */
export function dateWhen(t, ref) {
  const w = wall(t, ref);
  return w ? `${weekdayOf(w)} ${w.d} ${MONTHS[w.mo - 1]} ${pad(w.h)}:${pad(w.mi)}` : '';
}

/** True for the day default: from is yesterday 18:00 and to is tomorrow 06:00, both relative to now. */
export function isDayDefault(from, to, now) {
  return dayWord(from, now) === 'yesterday' && clock(from, now) === '18:00' && dayWord(to, now) === 'tomorrow' && clock(to, now) === '06:00';
}

/** Card title text: the day-default window reads relative to now, any other window reads as dates. */
export function windowTitle(from, to, now) {
  return isDayDefault(from, to, now)
    ? `Lanes · ${when(from, now)} to ${when(to, now)}`
    : `Lanes · ${dateWhen(from, now)} to ${dateWhen(to, now)}`;
}

/** Tick step in hours for a window (the AXIS_STEP row that holds its width). */
export function axisStepHours(from, to) {
  const hours = (toMs(to) - toMs(from)) / HOUR;
  return AXIS_STEP.find((r) => hours <= r.maxHours).stepHours;
}

/**
 * Axis ticks `[{t, x, label, midnight}]` over a track `trackPx` wide, aligned to the wall clock of `from`. Midnight
 * carries the day label ("Sat 31"); the window's own ends are the card's job, so a tick on an end is left out.
 */
export function axisTicks(from, to, trackPx) {
  const f = toMs(from);
  const e = toMs(to);
  const off = offsetMs(typeof from === 'string' ? from : new Date(f).toISOString());
  const step = axisStepHours(from, to) * HOUR;
  const first = Math.ceil((f + off) / step) * step - off;
  let ticks = [];
  for (let t = first; t <= e; t += step) {
    if (t <= f || t >= e) continue;
    const local = (((t + off) % DAY) + DAY) % DAY;
    const midnight = local === 0;
    ticks.push({ t, x: xOf(t, f, e, trackPx), label: midnight ? dayLabel(t + off) : clock(t + off), midnight });
  }
  const gap = () => Math.min(...ticks.slice(1).map((k, i) => k.x - ticks[i].x));
  while (ticks.length > 1 && gap() < MIN_TICK_PX) {
    const anchor = Math.max(0, ticks.findIndex((k) => k.midnight));
    ticks = ticks.filter((_, i) => (i - anchor) % 2 === 0);
  }
  return ticks;
}

/** "seat3" -> "s3" for the lane label column; anything else is shown as given. */
export const seatShort = (seat) => (seat ? String(seat).replace(/^seat/i, 's') : '');

/**
 * Lanes grouped Product then Ops, each group `{group, label, rows, idle}`. `rows` are the lanes with something to
 * show; every idle lane folds into one `idle` entry per group `{n, lanes, names, seatNote}` (null when the group has
 * none) and, when `idleOpen`, its lanes come back in `idle.rows` to draw under the fold row. `seatNote` reads
 * "(seatN has room for them)" only when an idle lane has a known seat under 50% in `seats` (`[{label, pct}]`).
 */
export function layoutLanes(lanes, { idleOpen = false, seats = [] } = {}) {
  const GROUPS = [['product', 'PRODUCT'], ['ops', 'OPS']];
  const under50 = (seats || []).filter((s) => typeof s?.pct === 'number' && s.pct < 50);
  return GROUPS.map(([group, label]) => {
    const mine = (lanes || []).filter((l) => l.group === group);
    const idle = mine.filter((l) => l.idle);
    const room = under50
      .filter((s) => idle.some((l) => l.seat === s.label))
      .sort((a, b) => a.pct - b.pct)[0];
    return {
      group,
      label,
      rows: mine.filter((l) => !l.idle),
      idle: idle.length
        ? { n: idle.length, lanes: idle, names: idle.map((l) => l.lane), open: !!idleOpen, seatNote: room ? `(${room.label} has room for them)` : null }
        : null,
    };
  }).filter((g) => g.rows.length || g.idle);
}

const CAUSE_PHRASE = { review: 'waiting on review', owner: 'waiting on you', gate: 'waiting on gate', quota: 'waiting on quota' };
const CAUSE_UNKNOWN = 'waiting (cause not recorded)';
export const causePhrase = (cause) => CAUSE_PHRASE[cause] || CAUSE_UNKNOWN;
const titleOf = (item) => item.title || item.text || item.unit || item.id || '(untitled)';

/** ETA label: "21:30" the same day, "02:00 Sun" the next, "Mon" further out. */
export function etaLabel(p50, now) {
  const w = wall(p50, now);
  const n = wall(now);
  if (!w || !n) return '';
  const diff = dayNumber(w) - dayNumber(n);
  if (diff <= 0) return clock(p50, now);
  if (diff === 1) return `${clock(p50, now)} ${weekdayOf(w)}`;
  return weekdayOf(w);
}

const DURATION = /^(\d+(?:\.\d+)?)\s*([mhd])$/;
const UNIT_MS = { m: MIN, h: HOUR, d: DAY };
export const HAS_ZONE = /(Z|[+-]\d\d:?\d\d)$/;

/** A duration string ("9h", "32h", "40m") in ms, else null. */
const durationMs = (v) => {
  const m = DURATION.exec(String(v ?? '').trim());
  return m ? Number(m[1]) * UNIT_MS[m[2]] : null;
};

/**
 * U2 M3: where a p50 sits on the time axis, in ms. An ISO time is itself; a duration from the estimator ("9h") counts from
 * `now`. Null for anything else (the ribbon then has no point to draw and says so in words).
 */
export function etaAt(p50, now) {
  if (p50 == null || p50 === '') return null;
  const d = durationMs(p50);
  if (d != null) return toMs(now) + d;
  const t = Date.parse(p50);
  return Number.isFinite(t) ? t : null;
}

/**
 * One p50/p80 value in words. The contract's examples are ISO times, but the live estimator (`estimate.py`) prints durations
 * ("9h", "32h"): a time reads like the ribbon's ETA ("21:30", "Mon"), a duration reads "in 9h", anything else is shown as given.
 */
export function etaWord(v, now) {
  if (v == null || v === '') return 'unknown';
  if (Number.isFinite(Date.parse(v))) return etaLabel(v, now);
  const d = durationMs(v);
  // U2 M3: "in 200h" reads as days past two days ("in 8d 8h"), the way every other long span on the ribbon reads.
  if (d != null) return d > 2 * DAY ? `in ${fmtDur(d)}` : `in ${String(v).trim()}`;
  return String(v);
}

/** "20:14" for an `asOf` the estimator wrote without a zone (its own local clock), else the clock in the window's offset. */
export const asOfClock = (asOf, now) => (HAS_ZONE.test(String(asOf)) ? clock(asOf, now) : clock(asOf));

/**
 * The tooltip for one drawn item, as the mock's wording (lines joined with "\n"). `item.kind` picks the shape:
 * `work`, `wait`, `notRecorded`, `land`, `deploy`, `deployFail`, `decide`, `cluster`, `current`, `next`, `eta`,
 * `prev`, `hold`, `outage`, `region`, `seatReset`, `expiry`, `alert`. Span items carry `lane`, `start`, `end`, `now`.
 */
export function tipText(item) {
  const { now } = item;
  const span = () => {
    const len = fmtDur(toMs(item.end) - toMs(item.start));
    const ongoing = now != null && toMs(item.end) >= toMs(now);
    return { len, range: ongoing ? `${clock(item.start, now)} to now` : `${clock(item.start, now)} to ${clock(item.end, now)}` };
  };
  switch (item.kind) {
    case 'work': {
      const { len } = span();
      const ongoing = now != null && toMs(item.end) >= toMs(now);
      return `${item.lane} · working on ${titleOf(item)}\n${ongoing ? `since ${clock(item.start, now)}` : `${clock(item.start, now)} to ${clock(item.end, now)}`} (${len})`;
    }
    case 'wait': {
      const { len, range } = span();
      const head = `${item.lane} · ${causePhrase(item.cause)} ${len}`;
      return [head, titleOf(item), range].join('\n');
    }
    case 'notRecorded':
      return `${item.lane} · not recorded ${fmtDur(toMs(item.end) - toMs(item.start))}\n${item.why || 'No start stamp for this span; work may have happened.'}`;
    case 'land':
      return `Landed · ${titleOf(item)}\n${when(item.at, now)} · click for detail`;
    case 'deploy':
      return `Deployed · ${titleOf(item)}\n${when(item.at, now)} · click for detail`;
    case 'deployFail':
      return `Deploy failed · ${titleOf(item)}\n${when(item.at, now)} · click for detail`;
    case 'decide':
      return `Decided for you · ${titleOf(item)}\n${when(item.at, now)} · click for detail`;
    case 'cluster':
      return `${item.count} events near ${when(item.at, now)}\nclick to open`;
    case 'current': {
      const age = fmtDur(toMs(now) - toMs(item.since));
      return item.cause
        ? `${titleOf(item)} ${causePhrase(item.cause)} since ${clock(item.since, now)}`
        : `Working on ${titleOf(item)} since ${clock(item.since, now)} (${age})`;
    }
    case 'next':
      return `Next: ${(item.titles || []).join(', then ')}`;
    case 'eta':
      return `Expected landing of the current unit: ${etaWord(item.p50, now)} (estimate.py, as of ${asOfClock(item.asOf, now)})`;
    case 'noEta':
      return `No estimate yet${item.raw && typeof item.raw === 'string' ? ` (${item.raw})` : ''}`;
    case 'prev':
      return `Earlier estimate: ${etaWord(item.p50, now)} (as of ${asOfClock(item.asOf, now)})`;
    case 'hold':
    case 'outage': {
      const lead = item.kind === 'hold' ? 'Hold' : 'Outage';
      const to = item.end ? clock(item.end, now) : 'ongoing';
      return `${lead} · ${item.label}\n${when(item.start, now)} to ${to}${item.source ? ` · ${item.source}` : ''}`;
    }
    case 'region':
      return `Not recorded · ${item.source}\n${item.why || 'This source has no data for this span.'}`;
    case 'seatReset':
      return `Seat reset · ${item.label}\n${when(item.at, now)}${item.atGate ? ' · at the quota gate' : ''}`;
    case 'expiry':
      return `Expiry · ${item.label}\n${when(item.at, now)}`;
    case 'alert':
      return `Alert · ${item.title || item.text || 'alert'}\nsince ${when(item.since, now)}`;
    default:
      return '';
  }
}

// ---- AHEAD row: one line of reset ticks (COMP-COCKPIT-RIBBON-RESETS-COMPACT-1) ----

/** Ticks whose x is closer than this to the first tick of a run merge into one counted tick (a short label "s1" is ~16 px wide). */
export const RESET_MERGE_PX = 18;
/** Width of one character of the row's 11.5 px text, as the row's label-fit rule counts it. */
export const RESET_CHAR_PX = 6.4;

/** "seat2" -> "s2", "codex" -> "cx", anything else as given: the label beside a reset tick. */
export function resetTag(pin) {
  const seat = String(pin?.seat || pin?.label || '');
  if (/^seat\d+$/i.test(seat)) return seat.replace(/^seat/i, 's');
  if (/^codex/i.test(seat)) return 'cx';
  return seat;
}

/** "in 1.3h" / "in 40m" for the next-reset label. */
const inWord = (ms) => (ms >= HOUR ? `in ${Math.round((ms / HOUR) * 10) / 10}h` : `in ${Math.max(1, Math.round(ms / MIN))}m`);

/** The full label of a seat's next reset: "seat2 resets in 1.3h" (a seat reset only). */
export const nextResetLabel = (pin, now) => `${pin.seat || pin.label} resets ${inWord(toMs(pin.at) - toMs(now))}`;

/** U2 M7: a merged tick names its seats when there are two or fewer ("s1, s2"), else counts them ("4 seats reset"), never "x4". */
export function mergedLabel(items) {
  const tags = [...new Set((items || []).map(resetTag))];
  return tags.length <= 2 ? tags.join(', ') : `${tags.length} seats reset`;
}

const toneOf = (items, alertSeats) => (items.some((p) => p.atGate) ? 'gate' : items.some((p) => alertSeats.includes(p.seat)) ? 'alert' : 'plain');

/**
 * What the AHEAD row draws. `pins` are the feed's pins; returns `{ticks, off}`.
 * `ticks` (in the window, left to right): `{x, items, count, label, full, tone, tip}` where `x` is the offset on a track
 * `trackPx` wide, `items` the pins it stands for (more than one when ticks merged), `label` the words beside it ("s1",
 * "cx", the next reset's full words, or "s1, s2" / "4 seats reset" when merged; U2 M7), `full` true for a seat's next reset, `tone` one of
 * `plain` / `gate` (at the quota cap) / `alert` (the seat has an open alert in `alertSeats`), `tip` the hover text (a
 * merged tick lists every reset it holds). `off` are pins past the window's right edge (`[{pin, label}]`). Only resets after
 * `now` are drawn (U2 M7).
 * A seat's NEXT reset (first one after `now`) gets its full label when it has room before the next tick, else its short tag.
 */
export function resetTicks(pins, { from, to, now, trackPx, alertSeats = [] }) {
  const f = toMs(from);
  const e = toMs(to);
  const sorted = [...(pins || [])].sort((a, b) => toMs(a.at) - toMs(b.at));
  const off = sorted.filter((p) => toMs(p.at) > e).map((p) => ({ pin: p, label: p.kind === 'expiry' ? p.label : resetTag(p) }));
  // U2 M7: a reset that already happened is not ahead of anyone; the row draws only what is still to come.
  const inside = sorted.filter((p) => toMs(p.at) >= f && toMs(p.at) <= e && toMs(p.at) > toMs(now));
  const next = new Set();
  const seen = new Set();
  sorted.forEach((p) => {
    if (p.kind !== 'seatReset' || toMs(p.at) <= toMs(now) || seen.has(p.seat)) return;
    seen.add(p.seat);
    next.add(p);
  });
  const runs = [];
  inside.forEach((p) => {
    const x = xOf(p.at, f, e, trackPx);
    const last = runs[runs.length - 1];
    if (last && x - last.x < RESET_MERGE_PX) last.items.push(p);
    else runs.push({ x, items: [p] });
  });
  const ticks = runs.map((r, i) => {
    const room = (runs[i + 1] ? runs[i + 1].x : trackPx) - r.x - 6;
    const p = r.items[0];
    const count = r.items.length;
    let label;
    let full = false;
    if (count > 1) label = mergedLabel(r.items);
    else if (p.kind === 'expiry') label = p.label;
    else if (next.has(p) && nextResetLabel(p, now).length * RESET_CHAR_PX <= room) { label = nextResetLabel(p, now); full = true; } else label = resetTag(p);
    const tip = count > 1
      ? [`${count} resets ${clock(p.at, now)}`, ...r.items.map((q) => `${q.label} ${clock(q.at, now)}`)].join('\n')
      : tipText({ ...p, now });
    return { x: r.x, items: r.items, count, label, full, tone: toneOf(r.items, alertSeats), tip };
  });
  return { ticks, off };
}

/**
 * RESETS-COMPACT-1 F4: the always-visible "next resets" line under the AHEAD row. Merged ticks hide the full words on live
 * data (the seats reset within minutes of each other), so each seat's NEXT future reset is spelled out here instead:
 * `[{seat, tag, word, text, tone}]` in time order (`{tag: 's2', word: '1.3h', text: 's2 1.3h'}`), or `null` with none.
 * `tone` is `alert` for a seat in `alertSeats`, else `plain`. Reads `now` from the caller, never the wall clock.
 */
export function nextResetsLine(pins, { now, alertSeats = [] } = {}) {
  const n = toMs(now);
  const seen = new Set();
  const items = [];
  [...(pins || [])].sort((a, b) => toMs(a.at) - toMs(b.at)).forEach((p) => {
    if (p.kind !== 'seatReset' || !(toMs(p.at) > n) || seen.has(p.seat)) return;
    seen.add(p.seat);
    const tag = resetTag(p);
    const word = inWord(toMs(p.at) - n).replace(/^in /, '');
    items.push({ seat: p.seat, tag, word, text: `${tag} ${word}`, tone: alertSeats.includes(p.seat) ? 'alert' : 'plain' });
  });
  return items.length ? items : null;
}

/** Alerts with no lane whose `since` falls in the window: the ones the AHEAD row used to draw as triangles, now one chip. */
export function orphanAlerts(alerts, from, to) {
  const f = toMs(from);
  const e = toMs(to);
  return (alerts || []).filter((a) => !(a.lane ?? a.action?.lane ?? null) && a.since && toMs(a.since) >= f && toMs(a.since) <= e);
}

const CLEARED_WORD = { ack: 'acknowledged', dismiss: 'dismissed', snooze: 'snoozed', resolved: 'resolved' };
/**
 * NOTIFY-ACTIONS-1: an alert's tip; a cleared one adds ` · acknowledged|dismissed|snoozed|resolved HH:MM`, on the
 * ribbon's own clock (`clock(t, now)`, the window's zone) like the "since" time beside it, never the browser's zone.
 */
export const alertTip = (a, now) => {
  const base = tipText({ ...a, kind: 'alert', now });
  return a.cleared ? `${base} · ${CLEARED_WORD[a.cleared.action] ?? a.cleared.action} ${clock(a.cleared.at, now)}` : base;
};

// ---- one lane state for every view (COMP-DAYVIEW-DESIGN-FIX-1 U1, S1 + S2) ----

/** A current unit with no newer stamp for this long is drawn stale, gets no ETA and is not counted as working. */
export const STALE_MS = 24 * HOUR;
/** A span still counts as "at now" when it ended this recently before the feed's own clock (a poll's worth of drift). */
const AT_NOW_SLACK_MS = 120_000;

/**
 * The clock "at now" is judged against: the feed's own `now` when it is older than the page's (U2, RIBBON-ROWS-1 M2). A body
 * kept after a failed refresh, or served from the route's 120 s cache, has its open spans ending at ITS now; judged against
 * the page's later clock they would all look finished and a known wait would flip to "working". The page says the body is
 * old (DayView's refresh note); the state stays the last known one.
 */
const refOf = (n, asOf) => { const a = toMs(asOf); return Number.isFinite(a) ? Math.min(n, a) : n; };

/** The spans a lane has at `now` (work or wait, never notRecorded), judged at `ref` (refOf). */
const spansAtNow = (lane, n, ref = n) => (lane?.spans || []).filter((s) => s.kind !== 'notRecorded' && toMs(s.start) <= n && toMs(s.end) >= ref - AT_NOW_SLACK_MS);
/** A span's real start: `since` (the producer's unclipped start) when the window cut it, else `start`. */
const realStart = (s) => toMs(s.since ?? s.start);

/**
 * The latest stamp the current unit has: the real start of any of its spans, or the end of one that closed (`open: false`).
 * An open span's end is now by construction (the producer extends an unended stamp), so it is not evidence (F3).
 */
function lastStampOf(lane, cur, n) {
  let last = null;
  for (const s of lane?.spans || []) {
    if (s.kind === 'notRecorded' || s.unit !== cur.id) continue;
    for (const v of [realStart(s), s.open === false ? toMs(s.end) : NaN]) if (Number.isFinite(v) && v <= n && (last === null || v > last)) last = v;
  }
  return last;
}

/**
 * What a lane is doing at `now`, the ONE answer the ribbon's NOW text, the phone's Now list and the legend share, so the
 * views cannot disagree (S1). An owner wait wins over any other span; otherwise the span that started last is the lane's
 * current interval (a wait that began after the work ended is a wait, work that resumed after a wait is work).
 * `asOf` is the feed's own `now` (refOf). A wait's age counts from its own real start, never from the unit's dispatch
 * (U2, RIBBON-ROWS-1 M1; F2's fold for stamp spans the window clipped).
 * `{kind: 'wait', cause, since, phrase, span}` | `{kind: 'stale' | 'working', since, phrase}` | null (nothing at now).
 * `stale` (S2, F3): the current unit has no stamp within `STALE_MS` of now (dispatch, any span start, any closed end), so
 * it reads as old work, not live. Dispatch age alone never makes a unit stale.
 */
export function laneState(lane, now, asOf = null) {
  const n = toMs(now);
  const at = spansAtNow(lane, n, refOf(n, asOf));
  const isOwner = (s) => s.kind === 'wait' && s.cause === 'owner';
  const owner = at.find((s) => isOwner(s) && s.queueId) || at.find(isOwner); // U3-FU: the queue's span names the wait, a stamp is only the fallback
  const latest = [...at].sort((a, b) => realStart(b) - realStart(a) || toMs(b.end) - toMs(a.end) || (a.kind === 'wait' ? -1 : 1))[0];
  const wait = owner || (latest?.kind === 'wait' ? latest : null);
  const cur = lane?.current || null;
  if (wait) {
    const since = realStart(wait);
    const cause = wait.cause || 'unknown';
    return { kind: 'wait', cause, since, phrase: `${causePhrase(cause)} ${fmtDur(n - since)}`, span: wait };
  }
  if (!cur) return null;
  const since = toMs(cur.since);
  if (!Number.isFinite(since)) return { kind: 'working', since: null, phrase: 'working' };
  const age = n - since;
  const last = Math.max(since, lastStampOf(lane, cur, n) ?? -Infinity);
  return n - last > STALE_MS
    ? { kind: 'stale', since, phrase: `stale: working ${fmtDur(age)}, no stamp in 24h` }
    : { kind: 'working', since, phrase: `working ${fmtDur(age)}` };
}

/**
 * C3: the feed with every LIVE owner wait dropped whose ask is no longer open for the headline. `openIds` are the ids
 * `ownerAsks(feed.owner.open, notifyState)` keeps (the WHAT line's own rule); null means "unknown", so nothing is dropped.
 * A past owner wait (it ended before now) is history and always stays. "Live" is judged on the feed's clock (refOf).
 */
export function withOwnerOpen(feed, openIds, now) {
  if (!feed || !Array.isArray(feed.lanes) || !Array.isArray(openIds)) return feed;
  const keep = new Set(openIds);
  const ref = refOf(toMs(now), feed.now);
  const live = (s) => s.kind === 'wait' && s.cause === 'owner' && s.queueId && toMs(s.end) >= ref - AT_NOW_SLACK_MS;
  return { ...feed, lanes: feed.lanes.map((l) => ({ ...l, spans: (l.spans || []).filter((s) => !live(s) || keep.has(s.queueId)) })) };
}

/**
 * The owner waits the ribbon draws at now: one per open ask, `[{lane, queueId}]` (what the test compares to the headline).
 * The queue is the one "at now" source (`lib/owner-spans.js`): a stamp span, even one clipped at the read, is history.
 */
export function ownerWaitsAtNow(lanes, now, asOf = null) {
  const n = toMs(now);
  return (lanes || []).flatMap((l) => spansAtNow(l, n, refOf(n, asOf)).filter((s) => s.kind === 'wait' && s.cause === 'owner' && s.queueId).map((s) => ({ lane: l.lane, queueId: s.queueId })));
}

/** Plain names for the feed's source-level gaps (C2: they are text under the ribbon, never a box over the lanes). */
const GAP_WORDS = { spend: 'spend history', expiry: 'plan expiry dates', ownerQueue: 'the owner queue', quota: 'seat quota', holds: 'launch holds' };
export const gapWord = (source) => GAP_WORDS[source] || GAP_WORDS[String(source).split('.')[0]] || source;

/** U2 M4: what each `sourceErrors` key leaves off the page, in words (`server/ribbon-routes.js` names the keys). */
const SOURCE_WORDS = {
  stamps: 'What each lane is doing', quota: 'Seat resets and quota waits', ownerQueue: 'Questions waiting on you', holds: 'Launch holds',
  ledger: 'Landings and deploys', outage: 'Outage notices', seats: 'Seat usage', eta: 'Landing estimates',
};
const localClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * U2 M4: one plain line per missing source, `[{key, text, title}]`. `text` names what is missing and since when
 * ("Seat resets and quota waits: not read since 14:02, retrying"); the raw reason (a Python error, a path-free message) is
 * only the `title`, so no stack word or millisecond count is on screen. Keys are deduped on their top-level name
 * ("quota.seat3" is "quota"). `good` is `{key: epoch ms}` of the last clean read (`useRibbonFeed().sourceGood`); `ref` an ISO
 * string whose offset the time is read in (the page's now), else the browser's clock. U3 (review U2 F4): `retrying: false`
 * (a past window, which `useRibbonFeed` never polls) says "not read again" instead of claiming a retry that never comes.
 */
export function sourceErrorLines(sourceErrors, good = {}, ref = null, { retrying = true } = {}) {
  const byKey = new Map();
  for (const [k, v] of Object.entries(sourceErrors || {})) {
    const key = String(k).split('.')[0];
    byKey.set(key, [byKey.get(key), String(v ?? '')].filter(Boolean).join('; '));
  }
  return [...byKey].map(([key, why]) => {
    const at = good?.[key];
    const when2 = Number.isFinite(at) ? `not read since ${typeof ref === 'string' ? clock(at, ref) : localClock(at)}` : 'not read yet';
    return { key, text: `${SOURCE_WORDS[key] || key}: ${when2}, ${retrying ? 'retrying' : 'not read again for a past window'}`, title: why };
  });
}
