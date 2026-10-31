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

/** Wall-clock fields of an ISO string (or of a number, read in UTC), as `{y, mo, d, h, mi}`; null when unparseable. */
function wall(t) {
  if (typeof t === 'string') {
    const m = ISO_PARTS.exec(t);
    return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] } : null;
  }
  if (typeof t === 'number' && Number.isFinite(t)) {
    const x = new Date(t);
    return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() };
  }
  return null;
}
const dayNumber = (w) => Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / DAY);
const weekdayOf = (w) => WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()];

/** "16:40". */
export function clock(t) {
  const w = wall(t);
  return w ? `${pad(w.h)}:${pad(w.mi)}` : '';
}

/** Offset of an ISO string from UTC in ms (`Z` and a missing offset are 0). */
export function offsetMs(iso) {
  const m = /([+-])(\d\d):?(\d\d)$/.exec(String(iso));
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * HOUR + Number(m[3]) * MIN) : 0;
}

/** Day word relative to `now`: "yesterday", "today", "tomorrow", else "Fri 30 Oct". */
function dayWord(t, now) {
  const w = wall(t);
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
  return `${dayWord(t, now)} ${clock(t)}`.trim();
}

/** "Sat 31". */
export function dayLabel(t) {
  const w = wall(t);
  return w ? `${weekdayOf(w)} ${w.d}` : '';
}

/** "Fri 30 Oct 18:00". */
export function dateWhen(t) {
  const w = wall(t);
  return w ? `${weekdayOf(w)} ${w.d} ${MONTHS[w.mo - 1]} ${pad(w.h)}:${pad(w.mi)}` : '';
}

/** True for the day default: from is yesterday 18:00 and to is tomorrow 06:00, both relative to now. */
export function isDayDefault(from, to, now) {
  return dayWord(from, now) === 'yesterday' && clock(from) === '18:00' && dayWord(to, now) === 'tomorrow' && clock(to) === '06:00';
}

/** Card title text: the day-default window reads relative to now, any other window reads as dates. */
export function windowTitle(from, to, now) {
  return isDayDefault(from, to, now)
    ? `Lanes · ${when(from, now)} to ${when(to, now)}`
    : `Lanes · ${dateWhen(from)} to ${dateWhen(to)}`;
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
  const w = wall(p50);
  const n = wall(now);
  if (!w || !n) return '';
  const diff = dayNumber(w) - dayNumber(n);
  if (diff <= 0) return clock(p50);
  if (diff === 1) return `${clock(p50)} ${weekdayOf(w)}`;
  return weekdayOf(w);
}

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
    return { len, range: ongoing ? `${clock(item.start)} to now` : `${clock(item.start)} to ${clock(item.end)}` };
  };
  switch (item.kind) {
    case 'work': {
      const { len } = span();
      const ongoing = now != null && toMs(item.end) >= toMs(now);
      return `${item.lane} · working on ${titleOf(item)}\n${ongoing ? `since ${clock(item.start)}` : `${clock(item.start)} to ${clock(item.end)}`} (${len})`;
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
        ? `${titleOf(item)} ${causePhrase(item.cause)} since ${clock(item.since)}`
        : `Working on ${titleOf(item)} since ${clock(item.since)} (${age})`;
    }
    case 'next':
      return `Next: ${(item.titles || []).join(', then ')}`;
    case 'eta':
      return `Expected landing of the current unit: ${etaLabel(item.p50, now)} (estimate.py, as of ${clock(item.asOf)})`;
    case 'noEta':
      return `No estimate yet${item.raw && typeof item.raw === 'string' ? ` (${item.raw})` : ''}`;
    case 'prev':
      return `Earlier estimate: ${etaLabel(item.p50, now)} (as of ${clock(item.asOf)})`;
    case 'hold':
    case 'outage': {
      const lead = item.kind === 'hold' ? 'Hold' : 'Outage';
      const to = item.end ? clock(item.end) : 'ongoing';
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
