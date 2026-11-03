/**
 * ribbon-feed.js — the data behind the Day ribbon (COMP-COCKPIT-RIBBON-FEED-1). Pure: every source is read by
 * server/ribbon-routes.js and handed in. One row per lane, over any window the user picks: work spans, wait spans (with the
 * cause), `notRecorded` spans, marks (landings, deploys, decisions), the current and next units, ETAs, bands and pins.
 *
 * It invents no span it has no stamp for. A hole in the stamps comes back as a `notRecorded` span with the rule in words.
 * The interval rules are `timeIntervals` of process-metrics.js (the same rules `/api/process` sums into minutes).
 * Contract: docs/features/COMP-COCKPIT-RIBBON-FEED-1/ribbon-contract.json.
 */
import { subtract, timeIntervals, toLocal, union } from './process-metrics.js';
// A unit in a DEAD_STATES state (unit-index.js, the one home) is never `current`, never `next` and is left out of the ETA.
import { DEAD_STATES } from './unit-index.js';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Lane -> group. An unlisted lane is `ops` and logs one WARNING per lane. */
export const LANE_GROUPS = {
  product: ['2.0', 'sm20', 'main', 'web', 'maya', 'mcp', 'hub', 'codegen'],
  ops: ['ops', 'wiki', 'bench', 'cadence', 'setup', 'trader', 'forge'],
};
export const HOLD_MIN_MIN = 30; // C10 threshold (UX-ADJ-1 report.md:208)
export const HOLD_MERGE_GAP_MIN = 5;
/** gate.log `wait` reasons (the first word inside the closing parentheses) that mean "the gate is holding launches". `spacing` and `queue` are sub-minute throttles. */
export const HOLD_REASONS = ['fleet', 'load', 'rate', 'outage', 'quota', 'battery'];
/** At most this wide a window draws every 5h seat reset; a wider one draws the 7d resets and the 5h resets that came after a seat hit its limit. */
export const PIN_ALL_5H_MAX_H = 48;
const QUOTA_GATE_PCT = 100;
const QUOTA_SAMPLE_GAP_MS = 15 * MIN_MS;
const ABSENT_SOURCES = ['spend', 'expiry']; // no reader exists: the whole window is not recorded for them

/** Shown on hover by the view: how a span got its kind and cause. */
export const SPAN_RULES = {
  work: 'the time a job ran: authoring, a review, a fix round or the gate (the four job lists of the unit)',
  'wait.owner': 'an owner wait (owner_waits) that no job covers',
  'wait.review': 'from author_done_at to the first review or fix job',
  'wait.gate': 'from the end of the last review or fix job to the gate job or the landing',
  'wait.quota': 'a wait that overlaps a quota reading at or over the gate for the lane\'s seat (only when the seat is known)',
  'wait.unknown': 'any other wait: no job and no owner wait covers it, and no stamp says why',
  notRecorded: 'the stamps cannot bound the unit (rules U-a to U-e of the Process view): drawn dashed from its best known start to its landing, never filled in',
};

const RULE_WORDS = {
  'U-a': 'an end stamp with no start stamp (no dispatch stamp), rule U-a',
  'U-b': 'a start stamp with no end stamp, rule U-b',
  'U-c': 'fix rounds listed with no fix-run times, rule U-c',
  'U-d': 'no dispatch stamp and no author-done stamp, rule U-d',
  'U-e': 'a stamp that cannot be read, or an end before its start, rule U-e',
};
const JOB_WORDS = { authoring: 'authoring', review: 'review', fix_rounds: 'fix round', gate: 'gate' };

const iso = (ms) => new Date(ms).toISOString();
const present = (v) => v !== undefined && v !== null && v !== '';
const ms = (v) => (typeof v === 'string' ? toLocal(v) : null);
const firstOf = (list, f) => list.reduce((best, x) => { const t = f(x); return t !== null && (best === null || t < best) ? t : best; }, null);

export function fmtDur(d) {
  const m = Math.max(1, Math.round(d / MIN_MS));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

/**
 * A source error's meaning without where it came from: a home path (`/Users/<name>/...`, `/home/<name>/...`, `~/...`) is
 * cut to its last part, so "ENOENT ... '/Users/x/.claude/usage/snapshots.jsonl'" reads "ENOENT ... 'snapshots.jsonl'" in the
 * body that leaves the machine (`sourceErrors`, `notRecorded`). The full text stays in the server log.
 */
export function safeReason(text) {
  return String(text ?? '')
    .replace(/(?:\/(?:Users|home)\/[^\s'"`),;]+|~\/[^\s'"`),;]*)/g, (p) => {
      const last = p.replace(/\/+$/, '').split('/').pop();
      return last && last !== '~' && !/^(?:Users|home)$/.test(last) ? last : '<home>';
    });
}

/** A ∩ B for two interval unions. */
const intersect = (a, b) => subtract(a, subtract(a, b));

const warnedLanes = new Set();
export function laneGroup(lane, warn = console.warn) {
  if (LANE_GROUPS.product.includes(lane)) return 'product';
  if (!LANE_GROUPS.ops.includes(lane) && !warnedLanes.has(lane)) { warnedLanes.add(lane); warn(`[ribbon] lane "${lane}" is not in LANE_GROUPS: drawn in the ops group`); }
  return 'ops';
}

const laneOrder = (lane) => {
  const all = [...LANE_GROUPS.product, ...LANE_GROUPS.ops];
  const i = all.indexOf(lane);
  return i < 0 ? all.length : i;
};

// ---------------------------------------------------------------- source parsers

/** gate.log lines `<iso> <verb> <label> ... (<reason>)` -> `[{ms, verb, label, reason}]`; a line that does not parse is skipped. */
export function parseGateLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const t = toLocal(m[1]);
    if (t === null) continue;
    const r = /\(([^)]*)\)\s*$/.exec(m[4]);
    out.push({ ms: t, verb: m[2], label: m[3], reason: r ? r[1].split(/[\s=<,]/)[0] : '' });
  }
  return out;
}

/** Hold bands: runs of `wait` lines with a hold reason, merged across gaps under 5 min (an `admit` ends a run), kept at 30 min or more. */
export function holdBands(entries, { from, to, now, live }) {
  const runs = [];
  let cur = null;
  for (const e of [...entries].sort((a, b) => a.ms - b.ms)) {
    if (e.verb === 'admit') { cur = null; continue; }
    if (e.verb !== 'wait' || !HOLD_REASONS.includes(e.reason)) continue;
    if (cur && e.ms - cur.end < HOLD_MERGE_GAP_MIN * MIN_MS) { cur.end = e.ms; cur.n += 1; cur.reasons[e.reason] = (cur.reasons[e.reason] ?? 0) + 1; continue; }
    cur = { start: e.ms, end: e.ms, n: 1, reasons: { [e.reason]: 1 } };
    runs.push(cur);
  }
  const bands = [];
  for (const r of runs) {
    if (r.end - r.start < HOLD_MIN_MIN * MIN_MS) continue;
    const ongoing = live && now - r.end < HOLD_MERGE_GAP_MIN * MIN_MS;
    const end = ongoing ? null : r.end;
    if ((end ?? now) <= from || r.start >= to) continue;
    const top = Object.entries(r.reasons).sort((a, b) => b[1] - a[1])[0][0];
    bands.push({
      kind: 'hold', start: iso(r.start), end: end === null ? null : iso(end),
      label: `launch gate held new work ${fmtDur((end ?? now) - r.start)} (mostly ${top})`, source: 'launch-gate gate.log',
    });
  }
  return bands;
}

/** One lane for a decision: a lane name among the dash-separated words of `by`, then of the id, else null. */
export function laneOfDecision(row, lanes) {
  for (const field of [row.by, row.id]) {
    for (const tok of String(field ?? '').split('-')) if (lanes.includes(tok)) return tok;
  }
  return null;
}

/**
 * `decide` marks: the owner-absent rows of the decisions feed (COMP-COCKPIT-DECISIONS-1, `lib/decisions-ledger.js`): owner-queue
 * rows tagged APPLIED, and ledger `OWNER-ABSENT decision` lines with or without the colon. The Decisions pane reads the same rows.
 */
export function decideMarks({ decisions = [], lanes, from, to }) {
  const out = [];
  for (const row of decisions) {
    if (row?.decider !== 'absent' || typeof row.ts !== 'number' || row.ts < from || row.ts > to) continue;
    const queue = row.source === 'owner-queue';
    const text = queue ? row.text : `${row.by ? `${row.by}: ` : ''}${row.text}`;
    const rev = row.reverse !== undefined ? row.reverse : (/Reverse\s*=\s*([\s\S]+)$/.exec(row.text)?.[1].trim().slice(0, 300) ?? null);
    out.push({
      lane: queue ? laneOfDecision({ by: row.by, id: row.queueId }, lanes) : null,
      // `unit` is what the card's Reverse acts on: the first unit the decision names (null when it names none). `queueId` keeps the owner-queue row's identity.
      mark: { kind: 'decide', at: iso(row.ts), unit: Array.isArray(row.units) && typeof row.units[0] === 'string' ? row.units[0] : null, queueId: queue && typeof row.queueId === 'string' ? row.queueId : null, title: null, text: text.slice(0, 300), reverse: rev, source: queue ? 'owner-queue' : 'ledger' },
    });
  }
  return out;
}

/** Quota snapshots -> `{seat: [[start, end]]}`: the time each seat's reading sat at or over the gate (a reading counts until the next one, at most 15 min). */
export function quotaGateIntervals(snapshots, now) {
  const bySeat = new Map();
  for (const s of snapshots) {
    if (typeof s?.account !== 'string' || typeof s.ts !== 'number') continue;
    if (!bySeat.has(s.account)) bySeat.set(s.account, []);
    bySeat.get(s.account).push(s);
  }
  const out = {};
  for (const [seat, rows] of bySeat) {
    rows.sort((a, b) => a.ts - b.ts);
    const ivs = [];
    rows.forEach((r, i) => {
      if (!(r.used_pct >= QUOTA_GATE_PCT)) return;
      const a = r.ts * 1000;
      const next = i + 1 < rows.length ? rows[i + 1].ts * 1000 : now;
      ivs.push([a, Math.min(next, a + QUOTA_SAMPLE_GAP_MS)]);
    });
    out[seat] = union(ivs);
  }
  return out;
}

// ---------------------------------------------------------------- history

const hist = (times) => {
  const ok = times.filter((t) => t !== null);
  // A loop, not Math.min(...ok): the snapshot log passes ~110k entries and a spread that large overflows the stack.
  let min = Infinity;
  for (const t of ok) if (t < min) min = t;
  return { earliest: ok.length ? iso(min) : null, count: ok.length };
};

/** The earliest time and count per source, computed from what the sources hold now (the view says "no data before D"). */
export function computeHistory({ units = [], snapshots = [], ownerQueue = [], gateEntries = [], decisions = null }) {
  const ev = (f) => units.flatMap((u) => f(u.events ?? {}, u)).map((v) => ms(v));
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    'stamps.landed_at': hist(ev((e) => [e.landed_at])),
    'stamps.dispatched_at': hist(ev((e) => [e.dispatched_at])),
    'stamps.author_done_at': hist(ev((e) => [e.author_done_at])),
    'stamps.reviews': hist(ev((e) => list(e.reviews).map((r) => r?.at))),
    'stamps.fix_runs': hist(ev((e) => list(e.fix_runs).map((r) => r?.dispatched_at))),
    'stamps.gate_done_at': hist(ev((e) => list(e.gates).map((r) => r?.done_at))),
    'stamps.deployed_at': hist(ev((e, u) => (list(e.deploys).length ? list(e.deploys).map((d) => d?.at) : [u.deployedAt]))),
    'stamps.owner_waits': hist(ev((e) => list(e.owner_waits).map((w) => w?.start))),
    ownerQueue: hist(ownerQueue.map((r) => (typeof r?.ts === 'number' ? r.ts * 1000 : null))),
    ledger: decisions ? hist(decisions.filter((d) => d?.source === 'ledger' && d.decider === 'absent').map((d) => d.ts)) : { earliest: null, count: 0, note: 'not measured: the ledger was not read' },
    quota: hist(snapshots.map((s) => (typeof s?.ts === 'number' ? s.ts * 1000 : null))),
    holds: hist(gateEntries.map((e) => e.ms)),
    spend: { earliest: null, note: 'no persisted spend series (asked of ops)' },
    expiry: { earliest: null, note: 'no reader yet' },
  };
}

// ---------------------------------------------------------------- ETA history

/** `eta` with `prev`: the last DIFFERENT p50 for the lane from the history rows `[{lane, p50, asOf}]`, plus the row to append when p50 changed. */
export function etaWithPrev(lane, eta, rows) {
  if (!eta || eta.noData || typeof eta.p50 !== 'string') return { eta: eta ?? null, append: null };
  const mine = rows.filter((r) => r?.lane === lane);
  const last = mine[mine.length - 1];
  if (!last || last.p50 === eta.p50) {
    const prevRow = last ? [...mine].reverse().find((r) => r.p50 !== eta.p50) : null;
    return { eta: { ...eta, prev: prevRow ? { p50: prevRow.p50, asOf: prevRow.asOf } : null }, append: last ? null : { lane, p50: eta.p50, asOf: eta.asOf } };
  }
  return { eta: { ...eta, prev: { p50: last.p50, asOf: last.asOf } }, append: { lane, p50: eta.p50, asOf: eta.asOf } };
}

/** The not-landed live units of each lane as the estimate reader's `[{id, deps: []}]`, plus the `landedAt` field its filter reads. */
export function remainingByLane(units) {
  const out = {};
  for (const u of units) {
    if (u.landedAt || DEAD_STATES.includes(u.state)) continue;
    (out[u.lane] ??= []).push({ id: u.id, deps: [], landedAt: null });
  }
  return out;
}

// ---------------------------------------------------------------- the feed

function clipSpan(s, from, to) {
  const a = Math.max(s.start, from);
  const b = Math.min(s.end, to);
  return b > a ? { ...s, start: a, end: b } : null;
}

/** A live unit's start stamp with no end is a job still running: end it at `hi` (the end of the drawn window) so rule U-b does not hide it. */
function closeOpen(e, hi) {
  const at = iso(hi);
  const fix = (list, start, end) => (Array.isArray(list) ? list.map((x) => (x && present(x[start]) && !present(x[end]) ? { ...x, [end]: at } : x)) : list);
  return {
    ...e, owner_waits: fix(e.owner_waits, 'start', 'end'), reviews: fix(e.reviews, 'dispatched_at', 'at'),
    fix_runs: fix(e.fix_runs, 'dispatched_at', 'done_at'), gates: fix(e.gates, 'started_at', 'done_at'),
  };
}

/** The latest end stamp of a unit's recorded work (capped at `now`), or null when it has none. */
function lastStamp(e, now) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const all = [e.author_done_at, ...arr(e.reviews).map((r) => r?.at), ...arr(e.fix_runs).map((r) => r?.done_at), ...arr(e.gates).map((r) => r?.done_at), ...arr(e.owner_waits).map((w) => w?.end)];
  let last = null;
  for (const v of all) { const t = ms(v); if (t !== null && t <= now && (last === null || t > last)) last = t; }
  return last;
}

const isLive = (u) => !u.landedAt && !DEAD_STATES.includes(u.state);

/** The unit's own spans over [from, to]: `{spans}` (epoch-ms start/end, not yet formatted). */
function unitSpans(u, { from, to, now, current, prevLanding, quota }) {
  const e = u.events ?? {};
  const landedMs = ms(e.landed_at);
  const landed = landedMs !== null;
  const dispatched = ms(e.dispatched_at);
  // No start stamp on a landed unit: it still reads from the previous landing (else the window start), as `notRecorded` below.
  const lo = ms(e.ready_at) ?? dispatched ?? (landed ? ([prevLanding, from].find((t) => t !== null && t !== undefined && t < landedMs) ?? from) : null);
  // A unit not landed ends at now while it is the current one; otherwise at its last recorded stamp, so work it did in a past window stays drawn.
  const hi = landed ? landedMs : (current ? Math.min(now, to) : lastStamp(e, now));
  if (lo === null || hi === null || Math.max(lo, hi) <= from || Math.min(lo, hi) >= to) return [];
  const base = { unit: u.id, title: u.title ?? null };
  const spans = [];
  const ti = timeIntervals(current && !landed ? closeOpen(e, hi) : e, { lo, hi });

  if (ti.status === 'known') {
    for (const [job, ivs] of Object.entries(ti.jobs)) {
      for (const [a, b] of ivs) spans.push({ ...base, kind: 'work', start: a, end: b, job, cause: null, why: `${JOB_WORDS[job]} on ${u.id}`, durOf: [a, b] });
    }
    for (const [a, b] of ti.waitingOwner) spans.push({ ...base, kind: 'wait', start: a, end: b, job: null, cause: 'owner', why: `waiting on an owner answer (${u.id})`, durOf: [a, b] });

    const authorDone = ms(e.author_done_at);
    const rf = [...ti.jobs.review, ...ti.jobs.fix_rounds];
    const firstRF = rf.length ? Math.min(...rf.map((x) => x[0])) : null;
    const lastRF = rf.length ? Math.max(...rf.map((x) => x[1])) : null;
    const gates = ti.jobs.gate;
    const firstGate = gates.length ? Math.min(...gates.map((x) => x[0])) : null;
    const reviewWin = authorDone !== null ? [[authorDone, firstRF ?? hi]] : [];
    const gateWin = lastRF !== null ? [[lastRF, firstGate ?? hi]] : [];
    const inReview = intersect(ti.waiting, reviewWin);
    const inGate = subtract(intersect(ti.waiting, gateWin), inReview);
    const rest = subtract(subtract(ti.waiting, inReview), inGate);
    const q = quota ?? [];
    const place = (ivs, cause, why) => {
      const slow = intersect(ivs, q);
      for (const [a, b] of subtract(ivs, slow)) spans.push({ ...base, kind: 'wait', start: a, end: b, job: null, cause, why: `${why} (${u.id})`, durOf: [a, b] });
      for (const [a, b] of slow) spans.push({ ...base, kind: 'wait', start: a, end: b, job: null, cause: 'quota', why: `waiting: the seat was at its quota limit (${u.id})`, durOf: [a, b] });
    };
    place(inReview, 'review', 'waiting on review');
    place(inGate, 'gate', 'waiting on the gate');
    place(rest, 'unknown', 'waiting, cause not recorded');
  } else if (current && !landed && !present(e.author_done_at) && dispatched !== null && ti.rule === 'U-d') {
    // In flight and still authoring: a dispatch stamp and no end yet is a running job, drawn up to now.
    spans.push({ ...base, kind: 'work', start: dispatched, end: hi, job: 'authoring', cause: null, why: `authoring on ${u.id}, still running`, durOf: [dispatched, hi] });
  } else if (landed) {
    const end = landedMs;
    const start = [dispatched, ms(e.ready_at), prevLanding, from].find((t) => t !== null && t !== undefined && t < end) ?? from;
    spans.push({ ...base, kind: 'notRecorded', start, end, job: null, cause: null, why: `not recorded: ${RULE_WORDS[ti.rule] ?? 'the stamps cannot bound this unit'}`, durOf: [start, end] });
  }

  return spans.map((s) => clipSpan(s, from, to)).filter(Boolean).map((s) => {
    const { durOf, ...rest } = s;
    return { ...rest, why: s.kind === 'notRecorded' ? s.why : `${s.why}, ${fmtDur(s.end - s.start)}` };
  });
}

function pinList({ seats, snapshots, from, to, now, live }) {
  const pins = [];
  const wide = to - from > PIN_ALL_5H_MAX_H * HOUR_MS;
  const keep = (win, atGate) => !wide || win === '7d' || atGate;
  // Past: every distinct resets_at a snapshot series holds inside the window; at gate when the last reading before it was at the limit.
  const byKey = new Map();
  for (const s of snapshots) {
    if (typeof s?.account !== 'string' || typeof s.resets_at !== 'number' || typeof s.ts !== 'number') continue;
    const k = `${s.account}|${s.window}|${s.resets_at}`;
    const prev = byKey.get(k);
    if (!prev || s.ts > prev.ts) byKey.set(k, s);
  }
  const seen = new Set();
  for (const s of byKey.values()) {
    const at = s.resets_at * 1000;
    if (at < from || at > to || at > now) continue;
    const atGate = s.used_pct >= QUOTA_GATE_PCT;
    if (!keep(s.window, atGate)) continue;
    seen.add(`${s.account}|${s.window}|${Math.round(at / MIN_MS)}`);
    pins.push({ kind: 'seatReset', at: iso(at), label: `${s.account} ${s.window} limit resets`, seat: s.account, atGate });
  }
  if (live && seats) {
    for (const seat of seats) {
      for (const [win, w] of [['5h', seat.five_h], ['7d', seat.seven_d]]) {
        const at = w?.resets_at ? Date.parse(w.resets_at) : NaN;
        if (Number.isNaN(at) || at <= now || at > to) continue;
        const atGate = typeof w.used_pct === 'number' && w.used_pct >= QUOTA_GATE_PCT;
        if (!keep(win, atGate)) continue;
        pins.push({ kind: 'seatReset', at: iso(at), label: `${seat.id} ${win} limit resets`, seat: seat.id, atGate });
      }
    }
  }
  return pins.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/**
 * The whole answer. Times in are epoch ms (`from`, `to`, `now`, `asOf`); every source is already read, a failed one is `[]`/null
 * with its message in `sourceErrors`. `etas` is `{lane: eta}` (already through `etaWithPrev`).
 */
export function buildRibbon({
  from, to, now, asOf = now, units = [], snapshots = [], ownerQueue = [], decisions = [], gateEntries = [],
  outage = null, seats = null, etas = {}, history = null, sourceErrors = {}, warn = console.warn,
}) {
  const live = now >= from && now <= to;
  const hist = history ?? computeHistory({ units, snapshots, ownerQueue, gateEntries, decisions });
  const lanes = [...new Set(units.map((u) => u.lane))].sort((a, b) => laneOrder(a) - laneOrder(b) || (a < b ? -1 : 1));
  const quotaBySeat = quotaGateIntervals(snapshots, now);
  const stampsEarliest = Math.min(...['stamps.landed_at', 'stamps.dispatched_at'].map((k) => (hist[k]?.earliest ? Date.parse(hist[k].earliest) : Infinity)));

  const marksByLane = Object.fromEntries(lanes.map((l) => [l, []]));
  for (const { lane, mark } of decideMarks({ decisions, lanes, from, to })) {
    // A decision with no lane has no row of its own in the contract: it goes to the ops row (see the report, Questions).
    (marksByLane[lane] ?? marksByLane.ops ?? marksByLane[lanes[0]])?.push(mark);
  }

  let landings = 0;
  let dispatchedLandings = 0;
  const out = lanes.map((lane) => {
    const laneUnits = units.filter((u) => u.lane === lane);
    const marks = marksByLane[lane];
    // The lane's seat: the account on its newest unit that names one.
    const stampOf = (u) => ms(u.events?.landed_at) ?? ms(u.events?.dispatched_at) ?? ms(u.events?.ready_at) ?? 0;
    const seat = [...laneUnits].sort((a, b) => stampOf(b) - stampOf(a)).find((u) => u.events?.account)?.events.account ?? null;

    const liveUnits = live ? laneUnits.filter((u) => isLive(u) && ms(u.events?.dispatched_at) !== null) : [];
    const cur = liveUnits.sort((a, b) => ms(b.events.dispatched_at) - ms(a.events.dispatched_at))[0] ?? null;
    const landedSorted = laneUnits.map((u) => ms(u.events?.landed_at)).filter((t) => t !== null).sort((a, b) => a - b);

    const spans = [];
    for (const u of laneUnits) {
      const e = u.events ?? {};
      const landedMs = ms(e.landed_at);
      if (landedMs !== null && landedMs >= from && landedMs <= to) {
        marks.push({ kind: 'land', at: iso(landedMs), unit: u.id, title: u.title ?? null, text: null, reverse: null, source: 'stamps' });
        landings += 1;
        if (ms(e.dispatched_at) !== null) dispatchedLandings += 1;
      }
      const deploys = Array.isArray(e.deploys) ? e.deploys.filter((d) => d && ms(d.at) !== null) : [];
      const deployList = deploys.length ? deploys.map((d) => ({ at: ms(d.at), text: typeof d.host === 'string' ? d.host : null })) : (ms(u.deployedAt) !== null ? [{ at: ms(u.deployedAt), text: null }] : []);
      for (const d of deployList) {
        if (d.at < from || d.at > to) continue;
        marks.push({ kind: 'deploy', at: iso(d.at), unit: u.id, title: u.title ?? null, text: d.text, reverse: null, source: 'stamps' });
      }
      const prevLanding = landedMs === null ? null : ([...landedSorted].reverse().find((t) => t < landedMs) ?? null);
      spans.push(...unitSpans(u, { from, to, now, current: cur === u, prevLanding, quota: seat ? quotaBySeat[seat] : null }));
    }
    if (from < stampsEarliest) {
      const end = Math.min(to, stampsEarliest);
      const why = Number.isFinite(stampsEarliest) ? `not recorded: the stamp files start ${iso(stampsEarliest).slice(0, 10)}` : 'not recorded: no dispatch or landing stamp exists yet';
      if (end > from) spans.push({ kind: 'notRecorded', start: from, end, unit: null, title: null, job: null, cause: null, why });
    }
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    marks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const next = live
      ? laneUnits.filter((u) => isLive(u) && ms(u.events?.ready_at) !== null && ms(u.events?.dispatched_at) === null)
        .sort((a, b) => ms(a.events.ready_at) - ms(b.events.ready_at)).slice(0, 2)
        .map((u) => ({ id: u.id, title: u.title ?? null, titleSource: u.titleSource ?? 'none' }))
      : [];

    return {
      lane, group: laneGroup(lane, warn), seat,
      idle: !cur && spans.length === 0 && marks.length === 0,
      current: cur ? { id: cur.id, title: cur.title ?? null, titleSource: cur.titleSource ?? 'none', since: iso(ms(cur.events.dispatched_at)) } : null,
      spans: spans.map((s) => ({ ...s, start: iso(s.start), end: iso(s.end) })),
      marks, next, eta: live ? (etas[lane] ?? null) : null,
    };
  });

  const bands = holdBands(gateEntries, { from, to, now, live });
  if (live && outage?.state === 'outage' && typeof outage.since === 'string') {
    bands.push({ kind: 'outage', start: outage.since, end: null, label: 'Anthropic outage in progress', source: 'cadence outage.json' });
  }

  const notRecorded = [];
  for (const [source, h] of Object.entries(hist)) {
    if (sourceErrors[source.split('.')[0]]) continue; // reported below with the error
    const e = h?.earliest ? Date.parse(h.earliest) : null;
    if (e !== null && from < e) notRecorded.push({ source, start: iso(from), end: iso(Math.min(to, e)), why: `${source} has no records before ${iso(e).slice(0, 10)}` });
    else if (e === null && ABSENT_SOURCES.includes(source)) notRecorded.push({ source, start: iso(from), end: iso(to), why: h.note });
  }
  const safeErrors = Object.fromEntries(Object.entries(sourceErrors).map(([source, why]) => [source, safeReason(why)]));
  for (const [source, why] of Object.entries(safeErrors)) notRecorded.push({ source, start: iso(from), end: iso(to), why: `could not be read: ${why}` });

  const pct = landings ? Math.round((100 * dispatchedLandings) / landings) : null;
  return {
    from: iso(from), to: iso(to), now: iso(now), live,
    asOf: iso(asOf), ageS: Math.max(0, Math.floor((now - asOf) / 1000)),
    lanes: out, bands,
    pins: pinList({ seats, snapshots, from, to, now, live }),
    coverage: { n: landings, dispatched: dispatchedLandings, pct, label: pct === null ? 'no landings in this window' : `start stamps on ${pct}% of landings` },
    history: hist, notRecorded, sourceErrors: safeErrors,
  };
}
