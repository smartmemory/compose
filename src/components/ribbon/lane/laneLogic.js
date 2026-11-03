/**
 * laneLogic.js — the pure half of the lane drawer and lane page (COMP-COCKPIT-RIBBON-LANE-1).
 *
 * Input is ONE lane object from the ribbon feed for the current window (`ribbon-contract.json` `lanes[]`): spans, marks,
 * current, next, eta. Nothing here fetches. Every function returns words or numbers a view can print, never an empty cell.
 */
import { smPanel } from '../../cockpit/fleetLogic.js';
import { clock, etaLabel, etaWord, fmtDur, HAS_ZONE, ownerAtNow, toMs, when } from '../ribbonLayout.js';

const MIN = 60_000;

/** Stage order on a unit row: author, review, fix, gate, then the two marks (land, deploy) drawn after the segments. */
export const JOB_ORDER = ['authoring', 'review', 'fix_rounds', 'gate'];

/** Plain words for a segment key (a work `job`, a wait `cause`, or `notRecorded`). */
export const SEGMENT_WORD = {
  authoring: 'author', review: 'review', fix_rounds: 'fix', gate: 'gate',
  waitReview: 'waiting on review', waitOwner: 'waiting on you', waitGate: 'waiting on the gate', waitQuota: 'waiting on seat quota', waitUnknown: 'waiting',
  notRecorded: 'not recorded',
};

const WAIT_KEY = { review: 'waitReview', owner: 'waitOwner', gate: 'waitGate', quota: 'waitQuota' };

/** Cause words for TIME LOST. */
export const CAUSE_WORD = { review: 'review', owner: 'you', gate: 'the gate', quota: 'seat quota', unknown: 'unknown cause' };

const segKey = (s) => (s.kind === 'notRecorded' ? 'notRecorded' : s.kind === 'wait' ? (WAIT_KEY[s.cause] || 'waitUnknown') : (s.job || 'authoring'));

const lastMark = (marks, kind, unit) => {
  const hit = (marks || []).filter((m) => m.kind === kind && m.unit === unit).sort((a, b) => toMs(b.at) - toMs(a.at))[0];
  return hit ? hit.at : null;
};

/** True when this lane stamped at least one deploy (or failed deploy) in the window. */
export const laneRecordsDeploys = (lane) => (lane?.marks || []).some((m) => m.kind === 'deploy' || m.kind === 'deployFail');

/**
 * Landed vs live, in words. `unit` carries `landedAt`, `deployedAt`, `deployFailedAt`. A lane that stamped no deploy at all
 * in the window says "no deploy stamp" (the stamp may simply not exist for that lane), otherwise a landed unit without one
 * is "landed, not deployed yet".
 */
export function liveState(unit, recordsDeploys = true) {
  if (!unit?.landedAt && !unit?.deployedAt) return 'not landed yet';
  if (unit.deployFailedAt && (!unit.deployedAt || toMs(unit.deployFailedAt) > toMs(unit.deployedAt))) return 'deploy failed';
  if (unit.deployedAt) return 'deployed';
  return recordsDeploys ? 'landed, not deployed yet' : 'no deploy stamp';
}

/**
 * One row per unit with its segments, newest first. Spans without a unit (`notRecorded` gaps) become a row of their own with
 * `unit: null` so the time is still on the page. Each segment is `{key, kind, job, cause, start, end, why}`.
 */
export function unitSegments(lane) {
  const spans = lane?.spans || [];
  const marks = lane?.marks || [];
  const rec = laneRecordsDeploys(lane);
  const byUnit = new Map();
  spans.forEach((s, i) => {
    const id = s.unit ?? `\u0000gap${i}`;
    if (!byUnit.has(id)) byUnit.set(id, { unit: s.unit ?? null, title: s.title ?? null, segments: [] });
    const row = byUnit.get(id);
    if (!row.title && s.title) row.title = s.title;
    row.segments.push({ key: segKey(s), kind: s.kind, job: s.job ?? null, cause: s.cause ?? null, start: s.start, end: s.end, why: s.why ?? null });
  });
  // A landed unit whose spans fell before the window still appears through its marks.
  for (const m of marks) {
    if (m.unit && !byUnit.has(m.unit) && (m.kind === 'land' || m.kind === 'deploy' || m.kind === 'deployFail')) {
      byUnit.set(m.unit, { unit: m.unit, title: m.title ?? null, segments: [] });
    }
  }
  const rows = [...byUnit.values()].map((r) => {
    const landedAt = r.unit ? lastMark(marks, 'land', r.unit) : null;
    const deployedAt = r.unit ? lastMark(marks, 'deploy', r.unit) : null;
    const deployFailedAt = r.unit ? lastMark(marks, 'deployFail', r.unit) : null;
    const segments = [...r.segments].sort((a, b) => toMs(a.start) - toMs(b.start));
    const out = { ...r, segments, landedAt, deployedAt, deployFailedAt };
    out.live = r.unit ? liveState(out, rec) : 'no unit recorded';
    out.last = Math.max(...segments.map((s) => toMs(s.end)), ...[landedAt, deployedAt, deployFailedAt].filter(Boolean).map(toMs));
    return out;
  });
  rows.sort((a, b) => b.last - a.last);
  return rows;
}

/** Minutes lost per wait cause in the window, plus the minutes nobody recorded. `total` adds both. */
export function timeLost(lane) {
  const byCause = {};
  let notRecorded = 0;
  for (const s of lane?.spans || []) {
    const mins = Math.max(0, (toMs(s.end) - toMs(s.start)) / MIN);
    if (s.kind === 'wait') byCause[s.cause || 'unknown'] = (byCause[s.cause || 'unknown'] || 0) + mins;
    else if (s.kind === 'notRecorded') notRecorded += mins;
  }
  const waited = Object.values(byCause).reduce((a, b) => a + b, 0);
  return { byCause, notRecorded, waited, total: waited + notRecorded };
}

/** The `n` newest landings with their live state in words. */
export function lastLanded(lane, n = 3) {
  const rec = laneRecordsDeploys(lane);
  const rows = new Map(unitSegments(lane).filter((r) => r.unit).map((r) => [r.unit, r]));
  return (lane?.marks || [])
    .filter((m) => m.kind === 'land')
    .sort((a, b) => toMs(b.at) - toMs(a.at))
    .slice(0, n)
    .map((m) => {
      const row = rows.get(m.unit);
      const u = row || { landedAt: m.at, deployedAt: lastMark(lane.marks, 'deploy', m.unit), deployFailedAt: lastMark(lane.marks, 'deployFail', m.unit) };
      return { unit: m.unit, title: m.title || m.unit || '(untitled)', at: m.at, live: liveState(u, rec) };
    });
}

/** The wait the lane sits in right now (last span, a wait, still open at `now`), else null. */
export function currentWait(lane, now) {
  const spans = [...(lane?.spans || [])].sort((a, b) => toMs(b.end) - toMs(a.end));
  const last = spans[0];
  return last && last.kind === 'wait' && toMs(last.end) >= toMs(now) - 5 * MIN ? last : null;
}

/** "as of 20:14" for a stamp the estimator wrote without a zone (its own local clock), "as of today 16:40" for one with a zone. */
export function asOfWord(asOf, now) {
  if (!asOf) return null;
  return `as of ${HAS_ZONE.test(String(asOf)) ? when(asOf, now) : clock(asOf)}`;
}

/** EXPECTED LANDING as one line: the estimate with its `as of`, "on answer", or the no-data words. */
export function expectedLanding(lane, now) {
  const wait = currentWait(lane, now);
  if (ownerAtNow(wait)) return { text: 'on answer', sub: 'waiting on you' }; // OWNER-IDENTITY-1: the one at-now owner rule
  const eta = lane?.eta;
  if (!eta) return { text: 'no estimate', sub: null };
  if (eta.noData) return { text: 'no estimate (n<10)', sub: eta.raw || null };
  return { text: `p50 ${etaWord(eta.p50, now)} · p80 ${etaWord(eta.p80, now)}`, sub: asOfWord(eta.asOf, now) };
}

/** NOW: the current unit and since when, or "nothing running"; "past window" when the window does not contain now. */
export function nowLine(lane, live, now) {
  if (!live) return 'past window';
  const c = lane?.current;
  if (!c) return 'nothing running';
  return `${c.title || c.id} · since ${when(c.since, now)}`;
}

/** NEXT (up to 2 titles); "past window" when the window does not contain now, "nothing queued" when empty. */
export function nextLines(lane, live, n = 2) {
  if (!live) return ['past window'];
  const next = (lane?.next || []).slice(0, n).map((x) => x.title || x.id);
  return next.length ? next : ['nothing queued'];
}

/** "1h 30m" for minutes. */
export const minutesWord = (mins) => fmtDur(mins * MIN);

/** Every unit id the lane has touched in the window (current, next, spans, marks): the key that ties a chain to the lane. */
export function laneUnitIds(lane) {
  const ids = new Set();
  if (lane?.current?.id) ids.add(lane.current.id);
  (lane?.next || []).forEach((x) => x?.id && ids.add(x.id));
  (lane?.spans || []).forEach((s) => s?.unit && ids.add(s.unit));
  (lane?.marks || []).forEach((m) => m?.unit && ids.add(m.unit));
  return ids;
}

/**
 * Plan (3): a chain has no lane field. It belongs to a lane when one of its step names is a unit id the lane touched. The
 * frontier chain is the linked chain with a step that is not done, else the newest linked chain (the list is newest first).
 */
export function chainForLane(lane, chains) {
  const ids = laneUnitIds(lane);
  const linked = (Array.isArray(chains) ? chains : []).filter((c) => (c.steps || []).some((s) => ids.has(s.name)));
  return linked.find((c) => c.steps.some((s) => s.stateKind !== 'done')) || linked[0] || null;
}

/** Lanes whose session is not named after the lane: lane `2.0`'s session is `sm20-main` (the feed also has its own lane `sm20`). */
export const LANE_SESSION_ALIASES = { '2.0': ['sm20'] };

/**
 * Plan (2): sm_status `sessions[]` have `{name, busy, ctx, session_id}` and no lane field. A session belongs to a lane when its
 * name is `<lane>-main` or starts with `<lane>-`. No match means the drawer shows the seat only.
 */
export function sessionsForLane(sessions, laneName) {
  if (!laneName || !Array.isArray(sessions)) return [];
  const bases = [laneName, ...(LANE_SESSION_ALIASES[laneName] || [])];
  return sessions.filter((s) => s && typeof s.name === 'string' && bases.some((b) => s.name === `${b}-main` || s.name.startsWith(`${b}-`)));
}

/**
 * Where the drawer's sessions come from, with the source's own state kept (a failed or still-loading read is never an empty
 * list). `fleet` is `useFleet()`'s `{data, error, loading}`. Returns `{status: 'loading'|'unavailable'|'ok', sessions, reason}`.
 */
export function sessionsSource(fleet, laneName) {
  const sm = fleet?.data?.sources?.sm_status;
  const panel = smPanel(fleet?.data, 'sessions');
  if (panel && Array.isArray(panel.value)) return { status: 'ok', sessions: sessionsForLane(panel.value, laneName), reason: null };
  if (!fleet?.data && fleet?.loading) return { status: 'loading', sessions: [], reason: null };
  const reason = panel ? panel.error : (sm?.error ?? fleet?.error ?? (fleet?.data ? 'sm_status reader is down' : 'no fleet data'));
  return { status: 'unavailable', sessions: [], reason: String(reason ?? 'no sessions source') };
}

export { clock, etaWord };
