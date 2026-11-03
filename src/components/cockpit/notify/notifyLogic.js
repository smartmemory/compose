/**
 * notifyLogic.js — COMP-COCKPIT-NOTIFY-CHIP-1 (phase 1): pure source adapters behind the header chip, its tray and the
 * security banner. Everything here renders what Compose ALREADY reads (the /api/fleet sm_status panels, cadence's
 * `outage` and `attention` screens) with thresholds that already exist (`fleetLogic.js`: imported, never re-declared).
 *
 * Phase 2 (COMP-NOTIFY-ASKS-1 / HITL-1 post envelope `type ask|alert`, `kind`, `severity`) swaps THIS file's adapters for
 * the envelope; the components only see rows `{key, kind, severity, title, detail, since, sourceLabel, action}`.
 * No React imports. NOTIFY-INBOX-1 reuses `tagOf` and adds `groupOf`, the ONE classifier the chip and the inbox drawer share.
 */
import { ctxLevel, smPanel, readerUp, DISK_RED_GB, fmtAge } from '../fleetLogic.js';
import { groupOf, stripTag } from '../../../../lib/owner-queue-class.js';
import { isCleared, clearedOf, answeredOf, securityAck, fnv1a } from './notifyState.js';

// COMP-COCKPIT-NOTIFY-ACTIONS-1: the classifier moved verbatim to lib/ (the server's answer route needs it and the published
// package does not ship src/). Re-exported so every import of it from here keeps working: still ONE classifier.
export { TAGS, tagWord, tagOf, stripTag, groupOf } from '../../../../lib/owner-queue-class.js';

/**
 * COMP-COCKPIT-RIBBON-METER-1: which row names a seat or a lane the Day page can flash. Only two sources carry one: a cadence
 * attention wall named `seatN <window>` (the seat id), and a session over its context named `<lane>-main` (the lane lead).
 * The owner queue carries who asked, not a lane, and outage and disk are not about either. A lane guess that is not a
 * ribbon lane (`forge-main` has no `forge` lane) is harmless: Day takes the event only when the lane exists.
 */
export const RIBBON_FOCUS = 'compose:ribbon-focus';
export const seatOfWall = (name) => /^(seat\d+)(?=\s|$)/i.exec(String(name ?? ''))?.[1].toLowerCase() ?? null;
export const laneOfSession = (name) => /^(.+)-main$/.exec(String(name ?? ''))?.[1] ?? null;

/** `{kind: 'seat' | 'lane', id, label}` for a row that names one, else null. A seat wins over a lane. */
export function jumpOf(row) {
  if (row?.seat) return { kind: 'seat', id: row.seat, label: `Show ${row.seat} ▸` };
  if (row?.lane) return { kind: 'lane', id: row.lane, label: `Show ${row.lane} lane ▸` };
  return null;
}

/** Ask Day to flash the row's seat or lane. True only when a listener took it (`preventDefault()`); false means run the row's own action. */
export function tryJump(row, target = globalThis.window) {
  const j = jumpOf(row);
  if (!j || !target) return false;
  return !target.dispatchEvent(new CustomEvent(RIBBON_FOCUS, { detail: { [j.kind]: j.id }, cancelable: true }));
}

const SM_DOWN = 'sm_status';

/** One sm_status panel -> `{rows, unavailable}`. A reader that is down, a missing panel and a partial read all count as unavailable. */
function panelRows(fleet, name) {
  const panel = smPanel(fleet, name);
  const label = readerUp(fleet, 'sm_status') ? `${SM_DOWN} ${name}` : SM_DOWN;
  if (!panel || panel.value == null) return { rows: null, unavailable: label };
  return { rows: panel.value, unavailable: panel.error != null ? label : null };
}

/**
 * COMP-COCKPIT-COUNT-ONE-1: the ONE owner count. The queue rows that wait on the owner: every `security` and `asks` row by
 * `groupOf`, overdue or not (decided-for-you and FYI rows never count). Security first, then oldest first (largest `age`).
 * `{rows, n}`; `null` when the queue source is down or not an array, never `[]` for unknown. The chip, Home's and Day's WHAT
 * line and the NOW drawer's "Waiting on you" all read this, so they cannot disagree.
 */
export function ownerAsks(queueRows, state = null, _now = Date.now()) {
  if (!Array.isArray(queueRows)) return null;
  const rank = (q) => (groupOf(q?.text) === 'security' ? 0 : 1);
  // NOTIFY-ACTIONS-1: with Compose's notify state, an ask answered from the cockpit stops counting until the queue drops
  // its id; a security row always counts. No state = the COUNT-ONE-1 count, unchanged. `_now` is the caller's clock, kept in
  // the signature so every caller passes the same three arguments. COMP-COCKPIT-NOTIFY-ANSWERED-REOPEN-1: an answer hides
  // only the record it answered; the same id re-asked later (a newer record) counts again.
  const rows = queueRows
    .filter((q) => {
      const g = groupOf(q?.text);
      if (g === 'security') return true;
      return g === 'asks' && !(state && answeredOf(state, `ask:${q?.id}`, { age: q?.age, now: _now }));
    })
    .sort((a, b) => rank(a) - rank(b) || (Number.isFinite(b?.age) ? b.age : -1) - (Number.isFinite(a?.age) ? a.age : -1));
  return { rows, n: rows.length };
}

/** owner queue -> the `ownerAsks` rows: a security row, an overdue (`red`) ask or an ask not yet overdue. A security row is never also listed as an ask. */
export function queueAdapter(fleet, state = null, now = Date.now()) {
  const { rows, unavailable } = panelRows(fleet, 'queue');
  const out = [];
  for (const q of ownerAsks(rows, state, now)?.rows ?? []) {
    const security = groupOf(q?.text) === 'security';
    const overdue = !security && q?.red === true;
    const from = q.by ?? 'unknown';
    out.push({
      key: `${security ? 'security' : 'ask'}:${q.id}`,
      kind: security ? 'security' : overdue ? 'ask-overdue' : 'ask',
      severity: security ? 'critical' : 'warn',
      title: stripTag(q.text),
      detail: security ? `Owner queue, from ${from}` : overdue ? `Owner question overdue, from ${from}` : `Owner question, from ${from}`,
      since: Number.isFinite(q.age) ? q.age : null,
      sourceLabel: 'owner queue',
      action: 'inbox',
      // NOTIFY-ACTIONS-1: what the inline actions need (the id to answer, the text for the options, the hash for escalation).
      id: String(q.id ?? ''),
      text: String(q.text ?? ''),
      ...(Array.isArray(q.options) ? { options: q.options } : {}),
      ...(security ? { textHash: fnv1a(q.text) } : {}),
    });
  }
  return { rows: out, unavailable };
}

/** sessions over CTX_RED. */
export function contextAdapter(fleet) {
  const { rows, unavailable } = panelRows(fleet, 'sessions');
  const out = (Array.isArray(rows) ? rows : [])
    .filter((s) => ctxLevel(s?.ctx) === 'red')
    .map((s, i) => ({
      key: `ctx:${s.session_id ?? s.name ?? i}`,
      kind: 'context',
      severity: 'warn',
      title: `${s.name ?? 'A session'} is over ${Math.round(s.ctx / 1000)}K context`,
      detail: 'Compaction and hand-off are due',
      since: null,
      sourceLabel: 'sessions',
      action: 'fleet',
      ...(laneOfSession(s.name) ? { lane: laneOfSession(s.name) } : {}),
    }));
  return { rows: out, unavailable };
}

/** free disk under DISK_RED_GB. */
export function diskAdapter(fleet) {
  const { rows: df, unavailable } = panelRows(fleet, 'df');
  const free = df?.free_gb;
  const rows = Number.isFinite(free) && free < DISK_RED_GB
    ? [{
      key: 'disk', kind: 'disk', severity: 'critical', title: `Disk ${Math.floor(free)} GB free`,
      detail: `Below ${DISK_RED_GB} GB: new test runs stop`, since: null, sourceLabel: 'disk', action: 'fleet',
    }]
    : [];
  return { rows, unavailable };
}

const ageSince = (iso, now) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
};

/** cadence outage screen: only `state: 'outage'` is a row. `ok` is clear. `stale` and `unknown` mean cadence cannot say, so the source is unavailable, never clear. */
export function outageAdapter(outage, now = Date.now()) {
  const label = 'cadence outage';
  const v = outage?.value;
  if (outage?.error != null || !v) return { rows: [], unavailable: label };
  if (v.state === 'outage') {
    return {
      rows: [{
        key: 'outage', kind: 'outage', severity: 'critical', title: 'Claude API outage',
        detail: `${v.fails ?? 0} failing probes`, since: ageSince(v.since, now), sourceLabel: label, action: 'cadence',
      }],
      unavailable: null,
    };
  }
  return { rows: [], unavailable: v.state === 'ok' ? null : label };
}

/**
 * cadence attention `alerts` (every wall whose state is not ok) -> seat wall / attention rows. A wall in `state: fallback`
 * means its reader used a default, not that a limit tripped: it is `defaults` (a grey tray line), never a row or a count.
 */
export function attentionAdapter(attention) {
  const label = 'cadence attention';
  const v = attention?.value;
  if (attention?.error != null || !v) return { rows: [], defaults: [], unavailable: label };
  const alerts = Array.isArray(v.alerts) ? v.alerts : null;
  if (!alerts) return { rows: [], defaults: [], unavailable: label };
  // Cadence answers HTTP 200 with `errors` (and `alerts: []`) when its own reader failed: that is a lost source, never "no alerts".
  // Any rows that did come back stay.
  const readerLost = Array.isArray(v.errors) && v.errors.length > 0;
  return {
    defaults: alerts.filter((a) => a.state === 'fallback').map((a) => a.name),
    rows: alerts.filter((a) => a.state !== 'fallback').map((a) => ({
      key: `attention:${a.name}`,
      kind: 'attention',
      severity: 'warn',
      title: `${a.name}: ${a.state}`,
      detail: a.why ?? (a.value != null && a.trip != null ? `${a.value} against ${a.trip}` : 'Cadence attention'),
      since: null,
      sourceLabel: label,
      action: 'cadence',
      wall: a.name,
      ...(seatOfWall(a.name) ? { seat: seatOfWall(a.name) } : {}),
    })),
    unavailable: readerLost ? label : null,
  };
}

/**
 * cadence `review` backlog (COMP-COCKPIT-TAB-DEPTH-1 F2, review M1): one critical (red) row per post-land review group in
 * review over `reviewMaxH` (24 h), carrying its lane and age. Groups under the limit make no row. A failed read, or a body
 * with no `inReview` list, is `unavailable`, never an empty list. Overdue UNITS are not a row: the Cadence belt's `late`
 * badge already shows them with the same thresholds (`isLate`: ready >30 min, review >24 h).
 */
export function reviewAdapter(review, now = Date.now()) {
  const label = 'post-land review';
  const v = review?.value;
  if (review?.error != null || !v || !Array.isArray(v.inReview)) return { rows: [], unavailable: label };
  const maxMs = (Number.isFinite(v.reviewMaxH) ? v.reviewMaxH : 24) * 3_600_000;
  const rows = v.inReview
    .filter((g) => g.overdue === true || (Number.isFinite(g.ageMs) && g.ageMs > maxMs))
    .map((g) => {
      const ageS = Number.isFinite(g.ageMs) ? g.ageMs / 1000 : ageSince(g.dispatchedAt, now);
      return {
        key: `review:${g.id}`, kind: 'review', severity: 'critical',
        title: `Post-land review over ${Number.isFinite(v.reviewMaxH) ? v.reviewMaxH : 24} h: ${g.lane}`,
        detail: `${g.rows?.length ?? 0} landed ${g.rows?.length === 1 ? 'row' : 'rows'} waiting in review`,
        since: ageS, sourceLabel: label, action: 'cadence', lane: g.lane,
      };
    });
  return { rows, unavailable: null };
}

const SEVERITY_RANK = { critical: 0, warn: 1 };
export const FLEET_UNREADABLE = 'fleet unreadable';

/**
 * `sources` = `{fleet, outage, attention, review}` (fleet is the /api/fleet body; the others `{value, error}`).
 * NOTIFY-ACTIONS-1: `state` is Compose's notify list (`notifyState.js`). Rows it clears move out of `rows` into `cleared`
 * (each flagged `cleared: {action, at, until?}`), so the chip and the tray count open rows only. `state === undefined`
 * or `null` hides nothing; `stateUnavailable` is set by the caller when the state read failed.
 */
export function collect(sources, now = Date.now(), state = null) {
  const results = [
    queueAdapter(sources.fleet, state, now),
    contextAdapter(sources.fleet),
    diskAdapter(sources.fleet),
    outageAdapter(sources.outage, now),
    attentionAdapter(sources.attention),
    reviewAdapter(sources.review, now),
  ];
  const defaults = results.flatMap((r) => r.defaults ?? []);
  const all = results.flatMap((r) => r.rows)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? -1) - (a.since ?? -1) || a.key.localeCompare(b.key));
  const rows = [];
  const cleared = [];
  for (const r of all) {
    if (state && isCleared(r.key, r, state, now)) cleared.push({ ...r, cleared: clearedOf(r.key, r, state, now) });
    else rows.push(r);
  }
  const unknown = [...new Set(results.map((r) => r.unavailable).filter(Boolean))];
  // A failed refresh keeps the last good fleet body on screen (fleetPoller): its rows may be stale, so the chip cannot say "All clear".
  if (sources.fleet && sources.fleetError != null && !unknown.includes(FLEET_UNREADABLE)) unknown.push(FLEET_UNREADABLE);
  return { rows, cleared, unknown, defaults };
}

/** The row kinds that wait on the owner: the count `ownerAsks` makes (the chip, WHAT and the NOW drawer show this one number). */
const OWNER_KINDS = new Set(['security', 'ask', 'ask-overdue']);
const OTHER_WORD = { context: 'context', disk: 'disk', outage: 'outage', attention: 'Cadence', review: 'review' };

/**
 * `all-clear` (every source answered, no rows) | `alerts` | `unknown` (no rows, a source is down).
 * COUNT-ONE-1 review M1: `count` is the owner-ask rows only, the same n WHAT and the NOW drawer show; the other alert kinds
 * (context, disk, outage, attention, review) are `others` (their words), shown beside the number and in the tone, never added to it.
 */
export function chipState(collected) {
  const critical = collected.rows.filter((r) => r.severity === 'critical').length;
  const count = collected.rows.filter((r) => OWNER_KINDS.has(r.kind)).length;
  const others = [...new Set(collected.rows.filter((r) => !OWNER_KINDS.has(r.kind)).map((r) => OTHER_WORD[r.kind] ?? r.kind))];
  const unavailable = collected.unknown.length;
  if (collected.rows.length > 0) return { state: 'alerts', count, critical, unavailable, others };
  if (unavailable > 0) return { state: 'unknown', count: 0, critical: 0, unavailable, others: [] };
  return { state: 'all-clear', count: 0, critical: 0, unavailable: 0, others: [] };
}

export function chipLabel(cs) {
  if (cs.state === 'all-clear') return 'All clear';
  if (cs.state === 'unknown') return 'Alerts unknown';
  const marker = cs.others?.length ? cs.others.join(', ') : '';
  if (cs.count === 0) return `Alerts: ${marker}`;
  return `${cs.count} alert${cs.count === 1 ? '' : 's'}${marker ? ` · ${marker}` : ''}`;
}

/** The unknown line the tray shows: "No alerts from the sources that answered; N unavailable". */
export function unknownLine(collected) {
  const n = collected.unknown.length;
  if (!n) return '';
  return collected.rows.length ? `${n} source${n === 1 ? '' : 's'} unavailable` : `No alerts from the sources that answered; ${n} unavailable`;
}

/** The grey tray line for cadence walls whose reader used a default; '' when none. Never part of the count. */
export function defaultsLine(collected) {
  const n = collected.defaults?.length ?? 0;
  return n ? `${n} reader${n === 1 ? '' : 's'} on defaults` : '';
}

/**
 * Red strip text for the open security rows: `{text, more, row}`; null when none. NOTIFY-ACTIONS-1: with a state, a row
 * acknowledged and not escalated since (same text hash), or resolved from the cockpit, no longer raises the banner; the
 * banner returns for a new id or a changed text, never for an age change. `more` counts the other unacknowledged rows.
 */
export function bannerText(collected, state = null, now = Date.now()) {
  const sec = collected.rows.filter((r) => r.kind === 'security')
    .filter((r) => !state || (!securityAck(state, r.key, r) && !answeredOf(state, r.key, { age: r.since, now })));
  if (!sec.length) return null;
  const top = sec[0];
  const age = top.since == null ? '' : ` (${fmtAge(top.since)})`;
  return { text: `Security: ${top.title}${age}`, more: sec.length - 1, row: top };
}
