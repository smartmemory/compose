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

/** Leading owner-queue tag -> display class. A display convention, not typing (phase 2 reads the envelope). */
export const TAGS = {
  SECURITY: 'security',
  CREDENTIAL: 'security',
  QUESTION: 'ask',
  APPLIED: 'decided',
  FYI: 'fyi',
  UPDATED: 'fyi',
};

/** The leading word when it is an exact TAGS word followed by `:`, `,`, whitespace or the end (a `-` never matches: unit ids; the live queue has "SECURITY, credential ..."). */
export function tagWord(text) {
  const m = /^\s*([A-Za-z]+)(?=[:,\s]|$)/.exec(String(text ?? ''));
  return m && Object.hasOwn(TAGS, m[1]) ? m[1] : null;
}

/** `security | ask | decided | fyi | untyped`. */
export function tagOf(text) {
  const w = tagWord(text);
  return w ? TAGS[w] : 'untyped';
}

/** The text without its leading tag and colon ("SECURITY: leaked key" -> "leaked key"). */
export function stripTag(text) {
  const w = tagWord(text);
  if (!w) return String(text ?? '').trim();
  return String(text).replace(/^\s*[A-Za-z]+\s*[:,]?\s*/, '').trim() || String(text).trim();
}

/**
 * The ONE classifier: owner-queue text -> `security | asks | decided | fyi`. The chip counts `security` and `asks`; the
 * inbox drawer (inboxLogic.js `groupInbox`) groups by it. An untyped row is an ask so nothing is missed.
 * Phase 2 (COMP-NOTIFY-ASKS-1) replaces the tag parse here with the envelope's `type/kind`: this is the only place to touch.
 */
export function groupOf(text) {
  const tag = tagOf(text);
  if (tag === 'security') return 'security';
  if (tag === 'decided') return 'decided';
  if (tag === 'fyi') return 'fyi';
  return 'asks';
}

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
export function ownerAsks(queueRows) {
  if (!Array.isArray(queueRows)) return null;
  const rank = (q) => (groupOf(q?.text) === 'security' ? 0 : 1);
  const rows = queueRows
    .filter((q) => { const g = groupOf(q?.text); return g === 'security' || g === 'asks'; })
    .sort((a, b) => rank(a) - rank(b) || (Number.isFinite(b?.age) ? b.age : -1) - (Number.isFinite(a?.age) ? a.age : -1));
  return { rows, n: rows.length };
}

/** owner queue -> the `ownerAsks` rows: a security row, an overdue (`red`) ask or an ask not yet overdue. A security row is never also listed as an ask. */
export function queueAdapter(fleet) {
  const { rows, unavailable } = panelRows(fleet, 'queue');
  const out = [];
  for (const q of ownerAsks(rows)?.rows ?? []) {
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
      ...(seatOfWall(a.name) ? { seat: seatOfWall(a.name) } : {}),
    })),
    unavailable: null,
  };
}

const SEVERITY_RANK = { critical: 0, warn: 1 };

/** `sources` = `{fleet, outage, attention}` (fleet is the /api/fleet body; the others `{value, error}`). */
export function collect(sources, now = Date.now()) {
  const results = [
    queueAdapter(sources.fleet),
    contextAdapter(sources.fleet),
    diskAdapter(sources.fleet),
    outageAdapter(sources.outage, now),
    attentionAdapter(sources.attention),
  ];
  const defaults = results.flatMap((r) => r.defaults ?? []);
  const rows = results.flatMap((r) => r.rows)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? -1) - (a.since ?? -1) || a.key.localeCompare(b.key));
  const unknown = [...new Set(results.map((r) => r.unavailable).filter(Boolean))];
  return { rows, unknown, defaults };
}

/** `all-clear` (every source answered, no rows) | `alerts` | `unknown` (no rows, a source is down). */
export function chipState(collected) {
  const critical = collected.rows.filter((r) => r.severity === 'critical').length;
  const count = collected.rows.length;
  const unavailable = collected.unknown.length;
  if (count > 0) return { state: 'alerts', count, critical, unavailable };
  if (unavailable > 0) return { state: 'unknown', count: 0, critical: 0, unavailable };
  return { state: 'all-clear', count: 0, critical: 0, unavailable: 0 };
}

export function chipLabel(cs) {
  if (cs.state === 'all-clear') return 'All clear';
  if (cs.state === 'unknown') return 'Alerts unknown';
  return `${cs.count} alert${cs.count === 1 ? '' : 's'}`;
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

/** Red strip text for the open security rows: `{text, more}`; null when none. */
export function bannerText(collected) {
  const sec = collected.rows.filter((r) => r.kind === 'security');
  if (!sec.length) return null;
  const top = sec[0];
  const age = top.since == null ? '' : ` (${fmtAge(top.since)})`;
  return { text: `Security: ${top.title}${age}`, more: sec.length - 1 };
}
