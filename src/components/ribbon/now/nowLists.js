/**
 * nowLists.js — COMP-COCKPIT-RIBBON-NOW-1: the rows behind the Day page's "now" lists. Pure, no React, no network.
 *
 * Inputs are the shared reads: `fleet` (GET /api/fleet body), `index` (GET /api/units/index body) and `feed` (GET
 * /api/ribbon body). A source that is unknown comes back as `null` (the drawer prints "source unavailable"), never as an
 * empty list, so "nothing is running" and "we could not tell" never look the same.
 */
import { smPanel } from '../../cockpit/fleetLogic.js';
import { etaWord } from '../lane/laneLogic.js';
import { stripTag } from '../../cockpit/notify/notifyLogic.js';
import { laneState } from '../ribbonLayout.js';

const ms = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
const laneOfSession = (name) => String(name ?? '').replace(/-main$/, '');
const oldestFirst = (a, b) => (a.since ?? Infinity) - (b.since ?? Infinity);

/** "2 h 10 m" style span from `from` to `now`; "time not recorded" when `from` is unknown. */
export function agoWords(from, now) {
  if (from === null || from === undefined) return 'time not recorded';
  const m = Math.max(0, Math.round((now - from) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} m` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** "today 09:10", "yesterday 18:00" or "Oct 29 18:00" for the "Since ..." sub-line. */
export function sinceWords(t, now) {
  const day = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff === 0) return `today ${hhmm(t)}`;
  if (diff === 1) return `yesterday ${hhmm(t)}`;
  return `${new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hhmm(t)}`;
}

const clip = (text, n = 80) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Who is running something right now: one row per busy session and per live job (the same things `runningNow` counts), plus
 * Compose's own agent. A session's unit and start come from the feed lane named like it. When sm_status is down the lanes
 * that have a `current` unit stand in; with neither source the answer is `null`.
 * Rows: `{kind, lane, unit, title, since}` oldest first.
 */
export function workingNow(fleet, feed, agent = null, now = Date.now()) {
  const sessions = smPanel(fleet, 'sessions');
  const jobs = smPanel(fleet, 'jobs');
  const okS = Array.isArray(sessions?.value);
  const okJ = Array.isArray(jobs?.value);
  const lanes = Array.isArray(feed?.lanes) ? feed.lanes : null;
  const currentOf = (lane) => lanes?.find((l) => l.lane === lane)?.current ?? null;
  const rows = [];
  if (okS || okJ) {
    if (agent?.status === 'working') rows.push({ kind: 'compose', lane: 'Compose', unit: null, title: 'Compose\'s own agent', since: null });
    for (const s of okS ? sessions.value : []) {
      if (s?.busy !== true) continue;
      const lane = laneOfSession(s.name);
      const cur = currentOf(lane);
      rows.push({ kind: 'session', lane, unit: cur?.id ?? null, title: cur?.title ?? null, since: ms(cur?.since) });
    }
    for (const j of okJ ? jobs.value : []) {
      if (j?.alive !== true) continue;
      rows.push({ kind: 'job', lane: laneOfSession(j.session), unit: j.id ?? null, title: j.kind ?? null, since: Number.isFinite(j.age) ? now - j.age * 1000 : null });
    }
  } else if (lanes && !feed?.sourceErrors?.stamps) {
    // S2: only a lane whose current unit is live work stands in; a stale or waiting one is not "working". U2 NOW M1: with the
    // stamps unreadable the lanes have no current unit to read, so the answer is unknown, never "nobody is working".
    const at = typeof feed?.now === 'string' ? feed.now : now; // the feed's own clock, as phoneLines reads it
    for (const l of lanes) if (l.current && laneState(l, at)?.kind === 'working') rows.push({ kind: 'lane', lane: l.lane, unit: l.current.id, title: l.current.title ?? null, since: ms(l.current.since) });
  } else return null;
  return rows.sort(oldestFirst);
}

/**
 * Units waiting on a review or on the owner, oldest first: `{review: rows, you: rows}`, rows `{unit, lane, title, since}`.
 * `since` is `authorDoneAt` for a review wait. COUNT-ONE-1: when `ownerRows` is given (the queue rows `ownerAsks` counts, the
 * chip's own count) the `you` group is those rows, `since` = `now - age`; `ownerRows === null` (queue source down) makes
 * `you` null (the drawer says "source unavailable"). When `ownerRows` is omitted, `you` is the index's owner-wait units (their
 * `since` is `ownerWaitSince`, null when the index carries none). `null` when the index has no `units` array.
 */
export function waitingNow(index, ownerRows, now = Date.now()) {
  if (!Array.isArray(index?.units)) return null;
  const pick = (waiting, startKey) => index.units
    .filter((u) => u?.waiting === waiting)
    .map((u) => ({ unit: u.id, lane: u.lane ?? null, title: u.title ?? null, since: startKey ? ms(u[startKey]) : null }))
    .sort(oldestFirst);
  let you;
  if (ownerRows === undefined) you = pick('owner', 'ownerWaitSince');
  else if (ownerRows === null) you = null;
  else {
    you = ownerRows
      .map((q) => ({ unit: q.id, lane: null, title: stripTag(q.text), since: Number.isFinite(q.age) ? now - q.age * 1000 : null, by: q.by ?? null }))
      .sort(oldestFirst);
  }
  return { review: pick('review', 'authorDoneAt'), you };
}

/**
 * What landed after `sinceMs`, newest first, each with its live state in words, plus `also`: the feed's deploys and decisions
 * after the same mark. `also` is null when the feed is down; `alsoPartial` is true when the ribbon window starts after
 * `sinceMs` (older marks are not in the feed). The whole answer is null when the index is down or there is no mark.
 */
export function landedSince(index, sinceMs, feed = null) {
  if (!Array.isArray(index?.units) || !Number.isFinite(sinceMs)) return null;
  const rows = index.units
    .map((u) => ({ u, at: ms(u?.landedAt) }))
    .filter((x) => x.at !== null && x.at > sinceMs)
    .sort((a, b) => b.at - a.at)
    .map(({ u, at }) => ({ unit: u.id, lane: u.lane ?? null, title: u.title ?? null, landedAt: at, state: ms(u.deployedAt) !== null ? 'deployed' : 'not deployed yet' }));
  let also = null;
  // U2 NOW M1: deploys come from the ledger and decisions from the owner queue; with either unreadable the list would be
  // missing rows it cannot name, so it is unknown (null), never a short list read as complete.
  const errs = feed?.sourceErrors || {};
  if (Array.isArray(feed?.lanes) && !errs.ledger && !errs.ownerQueue) {
    also = feed.lanes
      .flatMap((l) => (l.marks || []).map((m) => ({ kind: m.kind, lane: l.lane, unit: m.unit ?? null, title: m.title ?? null, text: m.text ?? null, at: ms(m.at) })))
      .filter((m) => ['deploy', 'deployFail', 'decide'].includes(m.kind) && m.at !== null && m.at > sinceMs)
      .sort((a, b) => b.at - a.at);
  }
  const from = ms(feed?.from);
  return { rows, also, alsoPartial: also !== null && from !== null && from > sinceMs };
}

/**
 * The phone's per-lane lines: `{lane, tone, state, title, eta, text}` (`tone` is laneState's kind or wait cause, null for an
 * index-only line) for each lane with something current, waiting or next. `text` is the one-line form
 * "<title> · <state> · ETA <when>"; U2 M14 draws `state`, `title` and `eta` as a two-line item. `eta` is `etaWord` of the
 * lane drawer (a time or "in 9h", never the feed's long `raw` text), and null for a lane that is waiting (M3: no ETA on a
 * wait; an owner wait reads "on answer"). `null` when the feed is down or its stamps are unreadable (U2 NOW M1). `index` may
 * be null (then no lane reads "waiting").
 */
export function phoneLines(feed, index, now = Date.now()) {
  if (!Array.isArray(feed?.lanes) || feed?.sourceErrors?.stamps) return null;
  const units = Array.isArray(index?.units) ? index.units : [];
  const nowIso = typeof feed.now === 'string' ? feed.now : new Date(now).toISOString(); // the feed's own clock, so a time reads in its offset
  const out = [];
  for (const l of feed.lanes) {
    const waits = units.filter((u) => u?.lane === l.lane && (u.waiting === 'review' || u.waiting === 'owner'));
    // S1: the ribbon's own answer for the lane (laneState), so "main" never reads "working" here and "waiting on review" there.
    const st = laneState(l, nowIso, nowIso);
    let title; let state; let tone = null;
    if (st) {
      const owner = st.kind === 'wait' && st.cause === 'owner';
      title = owner ? (st.span.title || l.current?.title || l.current?.id || 'an owner question') : (l.current?.title || l.current?.id || st.span?.title || st.span?.unit || l.lane);
      state = st.phrase;
      tone = st.kind === 'wait' ? st.cause : st.kind;
    } else if (waits.length) {
      title = waits[0].title || waits[0].id;
      const since = waits[0].waiting === 'owner' ? ms(waits[0].ownerWaitSince) : null;
      state = waits[0].waiting === 'owner' ? `waiting on you${since === null ? '' : ` ${agoWords(since, now)}`}` : 'waiting on review';
    }
    else if (l.next?.length) { title = l.next[0].title || l.next[0].id; state = 'next up'; }
    else continue;
    // S2: a stale unit has no live estimate, so it shows none. S1: an owner wait reads "on answer", as the ribbon's ETA does.
    // U2 M3: any other wait has no ETA (the unit lands after the wait, and nobody knows when that ends).
    const waiting = st?.kind === 'wait' || (!st && waits.length > 0);
    const eta = tone === 'stale' ? 'none (stale)' : l.eta && tone === 'owner' ? 'on answer' : waiting ? null
      : l.eta?.noData ? 'no data' : l.eta ? etaWord(l.eta.p50, nowIso) : 'unknown';
    const t = clip(String(title));
    out.push({ lane: l.lane, tone, state, title: t, eta, text: eta === null ? `${t} · ${state}` : `${t} · ${state} · ETA ${eta}` });
  }
  return out;
}

/** U3 (DV#15): how many hours the phone's per-lane strip covers, ending at now. */
export const STRIP_HOURS = 12;
const STRIP_CAUSES = new Set(['owner', 'review', 'gate', 'quota']);

/**
 * U3 (DV#15): the phone's 12 h state strip for one feed lane, `[{x, w, tone}]` in a `px`-wide box. `tone` is the ribbon's
 * state words (`working`, `owner`, `review`, `gate`, `quota`, `unknown`; `norec` for a not-recorded span), so DayPhone reads
 * the same `--rb-*` palette as the ribbon and its dot. Spans are clipped to the last `hours` before `now` (the feed's own
 * clock when it has one) and keep a 1 px gap, as the ribbon keeps its 2 px one at its larger size. `[]` for no lane.
 */
export function stripSegs(lane, now, { hours = STRIP_HOURS, px = 72 } = {}) {
  const end = typeof now === 'string' ? Date.parse(now) : now;
  if (!lane || !Number.isFinite(end)) return [];
  const start = end - hours * 3_600_000;
  const x = (t) => ((t - start) / (end - start)) * px;
  const out = [];
  for (const s of lane.spans || []) {
    const a = Math.max(start, ms(s.start) ?? NaN);
    const b = Math.min(end, ms(s.end) ?? end);
    if (!Number.isFinite(a) || !(b > a)) continue;
    const tone = s.kind === 'work' ? 'working' : s.kind === 'wait' ? (STRIP_CAUSES.has(s.cause) ? s.cause : 'unknown') : 'norec';
    const x0 = x(a);
    out.push({ x: Math.round(x0 * 10) / 10, w: Math.round(Math.max(1, x(b) - x0 - 1) * 10) / 10, tone });
  }
  return out;
}
