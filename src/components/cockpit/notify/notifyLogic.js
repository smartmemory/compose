/**
 * notifyLogic.js — COMP-COCKPIT-NOTIFY-CHIP-1 (phase 1): pure source adapters behind the header chip, its tray and the
 * security banner. Everything here renders what Compose ALREADY reads (the /api/fleet sm_status panels, cadence's
 * `outage` and `attention` screens) with thresholds that already exist (`fleetLogic.js`: imported, never re-declared).
 *
 * Phase 2 (COMP-NOTIFY-ASKS-1 / HITL-1 post envelope `type ask|alert`, `kind`, `severity`) swaps THIS file's adapters for
 * the envelope; the components only see rows `{key, kind, severity, title, detail, since, sourceLabel, action}`.
 * No React imports. NOTIFY-INBOX-1 reuses `tagOf`.
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

const SM_DOWN = 'sm_status';

/** One sm_status panel -> `{rows, unavailable}`. A reader that is down, a missing panel and a partial read all count as unavailable. */
function panelRows(fleet, name) {
  const panel = smPanel(fleet, name);
  const label = readerUp(fleet, 'sm_status') ? `${SM_DOWN} ${name}` : SM_DOWN;
  if (!panel || panel.value == null) return { rows: null, unavailable: label };
  return { rows: panel.value, unavailable: panel.error != null ? label : null };
}

/** owner queue -> security rows (tag) and overdue ask rows (`red`). A security row is never also listed as an ask. */
export function queueAdapter(fleet) {
  const { rows, unavailable } = panelRows(fleet, 'queue');
  const out = [];
  for (const q of Array.isArray(rows) ? rows : []) {
    const security = tagOf(q?.text) === 'security';
    if (!security && q?.red !== true) continue;
    out.push({
      key: `${security ? 'security' : 'ask'}:${q.id}`,
      kind: security ? 'security' : 'ask-overdue',
      severity: security ? 'critical' : 'warn',
      title: stripTag(q.text),
      detail: security ? `Owner queue, from ${q.by ?? 'unknown'}` : `Owner question overdue, from ${q.by ?? 'unknown'}`,
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

/** cadence attention `alerts` (every wall whose state is not ok) -> seat wall / attention rows. */
export function attentionAdapter(attention) {
  const label = 'cadence attention';
  const v = attention?.value;
  if (attention?.error != null || !v) return { rows: [], unavailable: label };
  const alerts = Array.isArray(v.alerts) ? v.alerts : null;
  if (!alerts) return { rows: [], unavailable: label };
  return {
    rows: alerts.map((a) => ({
      key: `attention:${a.name}`,
      kind: 'attention',
      severity: 'warn',
      title: `${a.name}: ${a.state}`,
      detail: a.why ?? (a.value != null && a.trip != null ? `${a.value} against ${a.trip}` : 'Cadence attention'),
      since: null,
      sourceLabel: label,
      action: 'cadence',
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
  const rows = results.flatMap((r) => r.rows)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? -1) - (a.since ?? -1) || a.key.localeCompare(b.key));
  const unknown = [...new Set(results.map((r) => r.unavailable).filter(Boolean))];
  return { rows, unknown };
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

/** Red strip text for the open security rows: `{text, more}`; null when none. */
export function bannerText(collected) {
  const sec = collected.rows.filter((r) => r.kind === 'security');
  if (!sec.length) return null;
  const top = sec[0];
  const age = top.since == null ? '' : ` (${fmtAge(top.since)})`;
  return { text: `Security: ${top.title}${age}`, more: sec.length - 1 };
}
