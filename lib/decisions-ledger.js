/**
 * decisions-ledger.js — COMP-COCKPIT-DECISIONS-1: the ops ledger and owner queue read as decision records.
 *
 * Pure parts (no I/O): `parseLedger` (the line grammar with the 12 h midnight rollover), `classifyEntry` (one line ->
 * decision or not), `buildDecisions` (classify, fold relays into echoes, set status from explicit pointers) and
 * `queueDecisions` (the owner queue, folded last-write-wins). One I/O part: `createLedgerBlame`, the cached
 * `git blame` of the ledger that gives each line its commit and resolves `ledger <sha>` refs to lines.
 *
 * Grammar and measurements: `smart-memory-ops/units/COMP-COCKPIT-DECISIONS-1/design.md` sections 2-5.
 * Two kinds of row:
 *   exact     a line carrying `DECISION D-<id>:` or `supersedes D-<id>` (the s1-chat convention from ledger.md:22704,
 *             D-0001). Status comes from `supersedes D-<id>` only. Never `inferred`.
 *   inferred  every other row: the decider mark is read heuristically (design section 2) and status is set only by a
 *             later line whose `ledger <sha>` / `ledger :<n>` ref resolves to the row's line. A unit ID alone never
 *             sets status; a same-unit later status line is only a `maybe` candidate (design section 3).
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
/** A bare time more than 12 h earlier than the previous entry is the next day (ops decision_dispatch_gate.py's rule, copied as text). */
export const ROLLOVER_MS = 12 * HOUR_MS;
/** A relay folds into an s1-chat row within this distance (design section 3: ±90 min, same day). */
export const RELAY_WINDOW_MS = 90 * MIN_MS;
/** A relay that names the chat's time (`via s1-chat 12:1x`) folds into the chat row within this distance of that time. */
export const VIA_TIME_MS = 10 * MIN_MS;
/** Share of the relay's words (4+ letters) that the chat row also has, for a relay near the chat time it names. */
export const VIA_WORD_OVERLAP = 0.3;
const wordsOf = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9][a-z0-9.-]{3,}/g) ?? []);
export function wordOverlap(a, b) {
  const wa = wordsOf(a); const wb = wordsOf(b);
  if (!wa.size) return 0;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n += 1;
  return n / wa.size;
}
const VIA_TIME_RE = /\bvia (?:s1-chat|sm-chat)[,\s]+(\d\d):(\d)([\dx])\b/;
export const SUMMARY_MAX = 160;

// ------------------------------------------------------------------------------------------------ line grammar

// `- 2026-10-31T05:00:00.123+08:00 who ...` (machine), `- 2026-10-30T09:26Z who:`, `- 2026-10-30 23:1x who:`.
const DATED_RE = /^- (\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d)([\dx])(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)?(?=\s)\s+(.*)$/;
const DASH_RE = /^- (\d\d):(\d)([\dx])(Z|[+-]\d\d:\d\d)?(?=\s)\s+(.*)$/;
const BARE_RE = /^(\d\d):(\d)([\dx])(Z|[+-]\d\d:\d\d)?(?=\s)\s+(.*)$/;
const HEADING_DAY_RE = /^#{1,6}\s.*?(\d{4})-(\d\d)-(\d\d)/;
const WHO_RE = /^([A-Za-z][\w.]*(?:-[\w.]+)*(?:→[\w.-]+)?)(?:\s+\d\d:\d[\dx])?(?:\s+\([^)]{0,120}\))?:\s*/;
const WHO_TOKEN_RE = /^([a-z][\w.]*(?:-[\w.]+)*)\s+(.*)$/;

const pad = (n) => String(n).padStart(2, '0');
const dayOfLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localMs = (day, h, m) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const nextDay = (day) => { const [y, mo, d] = day.split('-').map(Number); return dayOfLocal(new Date(y, mo - 1, d + 1, 12).getTime()); };
function offsetMs(y, mo, d, h, m, tz) {
  if (tz === 'Z') return Date.UTC(y, mo - 1, d, h, m);
  const sign = tz[0] === '-' ? -1 : 1;
  return Date.UTC(y, mo - 1, d, h, m) - sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * MIN_MS;
}

/** `{who, body}`: the writing session and the text after it. A line written as `OWNER (via sm-chat): ...` keeps OWNER in the body. */
export function splitWho(rest) {
  const m = WHO_RE.exec(rest);
  if (m && !/^(?:OWNER|Owner)$/.test(m[1])) return { who: m[1], body: rest.slice(m[0].length) };
  if (/^(?:OWNER|Owner)\b/.test(rest)) {
    const via = /^(?:OWNER|Owner)\s*\(via ([\w.-]+)/.exec(rest);
    return { who: via ? via[1] : 'owner', body: rest };
  }
  const t = WHO_TOKEN_RE.exec(rest);
  if (t) return { who: t[1], body: t[2] };
  return { who: null, body: rest };
}

/**
 * The ledger text -> timed entries `{line, day, ts, masked, who, body, raw}` (line is 1-based). A dated line sets the day;
 * an undated `HH:MM` carries the previous entry's day and moves to the next day when it is more than 12 h earlier
 * than the previous entry (`ledger.md:22290` 03:17 after 23:5x is 11-01). `HH:Mx` reads as `HH:M0`. Times without an
 * offset are local (the ledger is written in the Mac's zone), `Z` / `+hh:mm` are taken as written.
 */
export function parseLedger(text) {
  const out = [];
  let day = null;
  let prevMs = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '');
    if (!raw) continue;
    let ms; let rest; let masked = false;
    let m = DATED_RE.exec(raw);
    if (m) {
      const [, y, mo, d, hh, m1, m2, tz, r] = m;
      masked = m2 === 'x';
      const min = Number(m1) * 10 + (masked ? 0 : Number(m2));
      ms = tz ? offsetMs(+y, +mo, +d, +hh, min, tz) : localMs(`${y}-${mo}-${d}`, +hh, min);
      day = dayOfLocal(ms);
      rest = r;
    } else if ((m = DASH_RE.exec(raw) ?? BARE_RE.exec(raw))) {
      if (!day) continue;
      const [, hh, m1, m2, tz, r] = m;
      masked = m2 === 'x';
      const min = Number(m1) * 10 + (masked ? 0 : Number(m2));
      const at = (dd) => (tz ? offsetMs(...dd.split('-').map(Number), +hh, min, tz) : localMs(dd, +hh, min));
      ms = at(day);
      if (prevMs !== null && ms < prevMs - ROLLOVER_MS) { day = nextDay(day); ms = at(day); }
      day = dayOfLocal(ms);
      rest = r;
    } else {
      const h = HEADING_DAY_RE.exec(raw);
      if (h) { day = `${h[1]}-${h[2]}-${h[3]}`; prevMs = localMs(day, 0, 0); }
      continue;
    }
    prevMs = ms;
    const { who, body } = splitWho(rest);
    out.push({ line: i + 1, day, ts: ms, masked, who, body, raw });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ classifier

/** Writers that are scripts, not sessions: their lines are never decisions (`session_hop` "OWNER 17:2x" is a seat report). */
export const MACHINE_WRITERS = new Set([
  'auto-compact', 'inefficiency-flags', 'chain-auto', 'codex-credits', 'land-runner', 'auto-flush', 'land-auto',
  'cold-session-off', 'ready-idle-act', 'inflight-stall', 'unpark', 'battery-guard', 'spend-guard', 'remote-probe',
  'session_hop', 'resume_all', 'agent-done-close', 'unit_stamps', 'report-triage', 'job-wall-reroute', 'fsevents-watch',
  'outage-watch', 'stage20-switch', 'done-tab-closer', 'batch-review-leadless', 'auto_hop', 'watchdog', 'reboot_prep',
  'UTC', 'CLOUD-MISS', 'STEP',
]);
/** The owner's chat sessions: an `OWNER` line they write is direct; the same mark from anyone else is a relay. */
export const CHAT_WRITERS = new Set(['s1-chat', 'sm-chat', 'owner']);

const OWNER_RE = /(?<![A-Za-z0-9_-])OWNER(?![A-Za-z0-9_-])/g;
const OWNER_LEAD_RE = /^[*_(\s]*(?:(?:CORRECTION|NIGHT|Night)\b[^:]{0,24}?:?\s*)?(?<![A-Za-z0-9_-])OWNER(?![A-Za-z0-9_-])/;
const OWNER_ASK_HEAD_RE = /^[*_(\s]*OWNER\s+(?:QUESTION|Q|ASK|asks?|asked)\b/;
const VIA_RE = /^[^:"']{0,40}?\(?via ([\w.-]+)/;
const ABSENT_RE = /OWNER-ABSENT decisions?\b/;
const DECISION_ID_RE = /\bDECISION (D-\d{3,})\b/;
const SUPERSEDES_ID_RE = /\b(supersedes|reverses|retracts)\s+(D-\d{3,})\b/gi;
const D_REF_RE = /\bD-\d{4,}\b/g;
/** A decision cue after an owner question: an explicit ruling, or `Applied as`. A bare `picks` is not one ("findings -> owner picks"). */
const RULING_WORD_RE = /\b(?:RULING|Ruling|Applied as|SHAPE PICK)\b/;
const RULING_MARK_RE = /(?:^|[\s(;.])((?:Lane-lead|Lead|lead|night-mode lead|my|[a-z][\w.]*-[\w.-]+)\s+rulings?|RULING)(\s+on\s+[^:;]{1,60})?:\s*\S/g;
const ECHO_RE = /\bper\s+(?:[\w.-]+\s+){0,3}rulings?\b|\brulings?\s+(?:were\s+)?(?:applied|routed|relayed|acked|ACKed|adjudicated|noted)\b|\bfiled per\b|\b(?:applied|routed|relayed)\s+(?:the\s+)?[\w.-]+\s+rulings?\b/i;
const ECHO_ON_RE = /\b(?:applied|routed|relayed|acked|agreed|noted)\b/i;
const QUOTE_RE = /"([^"]{2,400})"|“([^”]{2,400})”|(?<![A-Za-z])'([^'\s][^']{0,398}?)'(?![A-Za-z])/;
const UNIT_RE = /(?<![A-Za-z0-9_./-])([A-Z][A-Z0-9]*(?:-[A-Z0-9.]*[A-Z0-9])*-\d+[a-z]?)(?![A-Za-z0-9_-])/g;
const STATUS_WORD_RE = /\b(SUPERSEDED|superseded|supersedes|KILLED|reverses|reversed|withdrawn|WITHDRAWN|retracted|RETRACTED)\b/;
const REF_RES = [
  { re: /\bledger(?:\.md)?\s*:\s*(\d{1,6})\b/g, kind: 'line' },
  { re: /\bledger line\s+(\d{2,6})\b/g, kind: 'line' },
  { re: /\bledger\s+(\d{4,6})\b/g, kind: 'line' },
  { re: /\b(?:ledger\s+(?:ops\s+)?|ops\s+)([0-9a-f]{7,12})\b/g, kind: 'sha' },
];

/** Unit IDs named in `text` (D-ids, dates and times excluded), in order, unique. */
export function unitsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(UNIT_RE)) {
    const u = m[1].replace(/\.+$/, '');
    if (/^D-\d+$/.test(u) || /^\d/.test(u) || !/-/.test(u) || out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

/** Explicit refs in `text`: `[{kind: 'line'|'sha', value}]`. */
export function refsIn(text) {
  const out = [];
  for (const { re, kind } of REF_RES) for (const m of String(text).matchAll(re)) out.push({ kind, value: kind === 'line' ? Number(m[1]) : m[1] });
  return out;
}

/** The first quote in `text`: double, curly or single quotes. A single quote never closes inside a word ("owner's"). */
export function firstQuote(text) {
  const m = QUOTE_RE.exec(String(text));
  return m ? (m[1] ?? m[2] ?? m[3]).trim() : null;
}

const clip = (s, n = SUMMARY_MAX) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The one-line decision: the quote right after the decider mark, else the clause up to the first `->` or `Relayed`. */
export function summaryOf(afterMark) {
  const s = String(afterMark).replace(/^[\s:,]+/, '');
  const q = firstQuote(s);
  if (q && s.indexOf(q) < 60) return clip(q);
  return clip(s.split(/\s(?:->|→)\s|\bRelayed\b|\brelayed to\b/)[0]);
}

const countOwnerMarks = (body) => (body.match(OWNER_RE) || []).length;

/**
 * One entry -> a decision `{decider, by, via, relay, exact, dId, supersedes, summary, units, refs, multi}` or null
 * with `why` (`{decision: null, why}`) for every line left out. `decider` is owner | absent | lane.
 */
export function classifyEntry(entry) {
  const { who, body } = entry;
  if (!who || MACHINE_WRITERS.has(who)) return { decision: null, why: 'machine' };
  const units = unitsIn(body);
  const refs = refsIn(body);
  const ownerMarks = countOwnerMarks(body);
  const supersedes = [...body.matchAll(SUPERSEDES_ID_RE)].map((m) => ({ id: m[2], kind: /^supersedes$/i.test(m[1]) ? 'superseded' : 'reversed' }));
  const viaOf = () => { const v = VIA_RE.exec(body.slice(body.search(OWNER_RE) >= 0 ? body.search(OWNER_RE) : 0)); return v ? v[1] : null; };

  // 1. Marked (exact): `DECISION D-<id>` or `supersedes D-<id>`.
  const did = DECISION_ID_RE.exec(body);
  if (did || supersedes.length) {
    const at = did ? did.index + did[0].length : body.search(SUPERSEDES_ID_RE);
    const isOwner = ownerMarks > 0;
    const via = isOwner ? viaOf() : null;
    return {
      decision: {
        decider: isOwner ? 'owner' : 'lane', by: who, via, relay: false, exact: true, dId: did ? did[1] : null, supersedes,
        summary: summaryOf(body.slice(at).replace(/^[^:]{0,40}:\s*/, '').replace(/^OWNER\b[^:"']{0,60}?(?=["'“:])/, '').replace(/^:\s*/, '')),
        units, refs, multi: false,
      },
    };
  }
  // 2. OWNER-ABSENT decision, with or without the colon.
  const ab = ABSENT_RE.exec(body);
  if (ab) {
    const after = body.slice(ab.index + ab[0].length).replace(/^\s*(?:\([^)]{0,200}\))?\s*:?\s*/, '');
    return { decision: { decider: 'absent', by: who, via: null, relay: false, exact: false, dId: null, supersedes: [], summary: summaryOf(after), units, refs, multi: (body.match(/OWNER-ABSENT decision/g) || []).length > 1 || /OWNER-ABSENT decisions\b/.test(body) } };
  }
  // 3. An echo of a marked decision from another session (`D-0006 applied`, `OWNER D-0004 (sha) relayed`).
  const dRefs = [...new Set(body.match(D_REF_RE) || [])];
  if (dRefs.length && !CHAT_WRITERS.has(who)) return { decision: null, why: 'echo-d', echoOf: dRefs };
  // 4. Owner: the mark opens the body.
  if (OWNER_LEAD_RE.test(body)) {
    if (OWNER_ASK_HEAD_RE.test(body)) return { decision: null, why: 'ask' };
    const at = body.search(OWNER_RE);
    const afterMark = body.slice(at + 5);
    const lead = /^\s*(?:\([^)]{0,120}\))?\s*(?:[\w.-]+\s+){0,3}?(?:on\s+[^:"“']{1,80}?)?:?\s*(?:\([^)]{0,80}\)\s*:?\s*)?["“']/.exec(afterMark);
    if (lead) {
      const q = firstQuote(afterMark.slice(lead[0].length - 1));
      if (q && /\?\s*$/.test(q) && !RULING_WORD_RE.test(body)) return { decision: null, why: 'ask' };
    }
    const via = viaOf();
    const relay = !CHAT_WRITERS.has(who) && via !== null && CHAT_WRITERS.has(via);
    const rest = afterMark.replace(/^\s*(?:\([^)]{0,120}\))?\s*/, '').replace(/^(?:\d\d:\d[\dx]\s*)?(?:\(verbatim\)\s*)?/, '');
    return {
      decision: {
        decider: 'owner', by: who, via, relay, exact: false, dId: null, supersedes: [],
        summary: summaryOf(rest.replace(/^(?:(?:pick|yes|rulings?|addendum|SHAPE PICK)\b\s*(?:\([^)]{0,80}\))?\s*:?|on\s+[^:"“]{1,120}?:)\s*/, '')),
        units, refs, multi: ownerMarks > 1,
      },
    };
  }
  // 5. A lane ruling written by the session that made it.
  if (ECHO_RE.test(body)) return { decision: null, why: 'echo' };
  const self = String(who).split('→')[0];
  for (const m of body.matchAll(RULING_MARK_RE)) {
    const ruler = m[1].replace(/\s+rulings?$/, '');
    if (m[2] && ECHO_ON_RE.test(m[2])) continue;
    const mine = ruler === 'RULING' || /^(?:Lane-lead|Lead|lead|night-mode lead|my)$/.test(ruler) || ruler === self;
    if (!mine) continue;
    const after = body.slice(m.index + m[0].length - 1);
    const marks = [...body.matchAll(RULING_MARK_RE)].length;
    return { decision: { decider: 'lane', by: who, via: null, relay: false, exact: false, dId: null, supersedes: [], summary: summaryOf(after), units, refs, multi: marks > 1 } };
  }
  return { decision: null, why: ownerMarks ? 'owner-mid-line' : 'none' };
}

// ------------------------------------------------------------------------------------------------ the feed

const isoOf = (ms) => new Date(ms).toISOString();

/**
 * Entries -> decision rows, newest last. `blame` (optional) is a `createLedgerBlame` snapshot: `shaAt(line)` and
 * `linesOf(shaPrefix)`. Relays fold into the nearest s1-chat owner row within ±90 min that shares a unit, a quote or
 * an explicit ref; the rest stay as `relay-only` rows. Status: exact from `supersedes D-<id>`, else from a later
 * line whose explicit ref resolves to the row's line and whose clause carries a status word.
 */
export function buildDecisions(entries, { blame = null } = {}) {
  const rows = [];
  const byLine = new Map();
  const byDid = new Map();
  const relays = [];
  const dEchoes = [];
  const pointers = []; // later lines that may set status
  for (const e of entries) {
    const c = classifyEntry(e);
    if (c.echoOf) dEchoes.push({ e, ids: c.echoOf });
    if (STATUS_WORD_RE.test(e.body)) pointers.push(e);
    if (!c.decision) continue;
    const d = c.decision;
    const row = {
      id: d.dId ?? `L${e.line}`, line: e.line, day: e.day, at: isoOf(e.ts), ts: e.ts, masked: e.masked,
      decider: d.decider, by: d.by, via: d.via, exact: d.exact, inferred: !d.exact, dId: d.dId,
      summary: d.summary, text: e.body, units: d.units, refs: d.refs, supersedes: d.supersedes,
      tags: [...(d.multi ? ['multi'] : [])], echoes: [], status: 'standing', statusBy: null, maybe: [],
      commit: null, source: 'ledger', relay: d.relay,
    };
    if (d.relay) { relays.push(row); continue; }
    rows.push(row);
    byLine.set(e.line, row);
    if (d.dId) byDid.set(d.dId, row);
  }

  const linesOfRef = (ref) => {
    if (ref.kind === 'line') return [ref.value];
    return blame ? blame.linesOf(ref.value) : [];
  };

  // Relays -> echoes.
  const chatRows = rows.filter((r) => r.decider === 'owner' && CHAT_WRITERS.has(r.by));
  for (const r of relays) {
    let target = null;
    for (const ref of r.refs) {
      const hit = linesOfRef(ref).map((l) => byLine.get(l)).find((x) => x && x.decider === 'owner');
      if (hit) { target = hit; break; }
    }
    // A relay folds only into a chat row it shares a unit or a quote with: near the chat time it names
    // (`via s1-chat 12:1x`), else within ±90 min of the relay itself. Time alone never links (a 12:2x line about a
    // closed tab is not the 12:1x compose pick).
    const q = firstQuote(r.text);
    const qKey = q ? q.toLowerCase().replace(/\s+/g, ' ').slice(0, 24) : null;
    const shares = (c) => r.units.some((u) => c.units.includes(u)) || (qKey && qKey.length >= 8 && c.text.toLowerCase().replace(/\s+/g, ' ').includes(qKey));
    const nearest = (at, window, match = shares) => {
      let best = null;
      for (const c of chatRows) {
        const dt = Math.abs(c.ts - at);
        if (dt <= window && match(c) && (!best || dt < Math.abs(best.ts - at))) best = c;
      }
      return best;
    };
    const vt = VIA_TIME_RE.exec(r.text);
    if (!target && vt) {
      // The named time is on the relay's day, or the day before when it is later than the relay (a relay after midnight).
      let at = localMs(r.day, +vt[1], Number(vt[2]) * 10 + (vt[3] === 'x' ? 5 : Number(vt[3])));
      if (at > r.ts + VIA_TIME_MS) at -= 24 * HOUR_MS;
      // Near the named time, a relay that words the pick differently (`AUDIT-17/18 = 1a` for `COMP-AUDIT-17/18 = 1a`)
      // still folds when the two share enough words.
      target = nearest(at, VIA_TIME_MS) ?? nearest(at, VIA_TIME_MS, (c) => wordOverlap(r.summary, c.summary) >= VIA_WORD_OVERLAP);
    }
    if (!target) target = nearest(r.ts, RELAY_WINDOW_MS);
    if (target) target.echoes.push({ line: r.line, by: r.by, at: r.at });
    else {
      r.tags.push('relay-only');
      rows.push(r);
      byLine.set(r.line, r);
    }
  }
  for (const { e, ids } of dEchoes) for (const id of ids) {
    const row = byDid.get(id);
    if (row && e.line > row.line) row.echoes.push({ line: e.line, by: e.who, at: isoOf(e.ts) });
  }

  // Status, exact: `supersedes D-<id>`.
  for (const r of rows) for (const s of r.supersedes) {
    const target = byDid.get(s.id);
    if (target && target.line < r.line) { target.status = s.kind; target.statusBy = { line: r.line, id: r.id, exact: true }; }
  }
  // Status, inferred: a later line's explicit ref + a status word in the same clause.
  for (const p of pointers) {
    for (const clause of p.body.split(/;\s|\.\s(?=[A-Z])/)) {
      const w = STATUS_WORD_RE.exec(clause);
      if (!w) continue;
      for (const ref of refsIn(clause)) for (const l of linesOfRef(ref)) {
        const row = byLine.get(l);
        if (!row || row.exact || row.line >= p.line || row.statusBy) continue;
        row.status = /^(?:SUPERSEDED|superseded|supersedes|KILLED)$/.test(w[1]) ? 'superseded' : 'reversed';
        row.statusBy = { line: p.line, id: `L${p.line}`, exact: false };
      }
    }
  }
  // Candidates only: a later same-unit line with a status word (never the status chip).
  const statusByUnit = new Map();
  for (const p of pointers) for (const u of unitsIn(p.body)) {
    if (!statusByUnit.has(u)) statusByUnit.set(u, []);
    statusByUnit.get(u).push(p.line);
  }
  for (const r of rows) {
    if (r.status !== 'standing') continue;
    const later = new Set();
    for (const u of r.units) for (const l of statusByUnit.get(u) ?? []) if (l > r.line) later.add(l);
    r.maybe = [...later].sort((a, b) => a - b).slice(0, 3);
  }
  if (blame) for (const r of rows) r.commit = blame.shaAt(r.line);
  rows.sort((a, b) => a.ts - b.ts || a.line - b.line);
  return rows;
}

const QUEUE_NOT_DECISION_RE = /^(?:stale|resolved)\b|^[a-z][\w.]*-[\w.-]+:|^OWNER \(via cockpit\):\s*resolved:/i;

/**
 * The owner queue (JSONL rows, folded last-write-wins by id) -> rows. A closed row with an owner answer is a `queue`
 * decision; an `APPLIED` row is an `absent` decision posted for review (the ribbon's existing rule). Answers that open
 * `stale:`, `resolved:` or `<session>:`, and `TEST-*` ids, are not owner decisions.
 */
export function queueDecisions(events) {
  const byId = new Map();
  for (const r of events) if (r && typeof r.id === 'string') byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...r });
  const rows = [];
  for (const r of byId.values()) {
    if (/^TEST-/.test(r.id)) continue;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    const answer = typeof r.answer === 'string' ? r.answer.trim() : '';
    const units = unitsIn(`${r.unit ?? ''} ${text} ${answer}`);
    const base = { line: null, masked: false, via: null, exact: false, inferred: true, dId: null, units, refs: [], supersedes: [], echoes: [], status: 'standing', statusBy: null, maybe: [], commit: null, source: 'owner-queue', relay: false, queueId: r.id };
    if (/^APPLIED\b/.test(text) && typeof r.ts === 'number') {
      const rev = /Reverse\s*=\s*([\s\S]+)$/.exec(text);
      const ts = r.ts * 1000;
      rows.push({ ...base, id: `Q:${r.id}:applied`, day: dayOfLocal(ts), at: isoOf(ts), ts, decider: 'absent', by: r.by ?? null, summary: clip(text.replace(/^APPLIED\s*(?:\([^)]{0,120}\))?\s*:?\s*/, '')), text, reverse: rev ? rev[1].trim().slice(0, 300) : null, tags: [] });
      continue;
    }
    if (r.status !== 'closed' || !answer || QUEUE_NOT_DECISION_RE.test(answer)) continue;
    const ts = (typeof r.closed_ts === 'number' ? r.closed_ts : r.ts) * 1000;
    if (!Number.isFinite(ts)) continue;
    rows.push({ ...base, id: `Q:${r.id}`, day: dayOfLocal(ts), at: isoOf(ts), ts, decider: 'queue', by: r.by ?? null, summary: clip(answer), text: `${clip(text, 400)} — ${answer}`, tags: [] });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

// ------------------------------------------------------------------------------------------------ blame cache

const runGit = (args, { maxBuffer = 256 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => {
  execFile('git', args, { maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(new Error(`git ${args.slice(2, 4).join(' ')}: ${String(stderr || err.message).trim().slice(0, 200)}`)) : resolve(stdout)));
});

/** `git blame --porcelain` output -> `Map(finalLine -> sha12)`. */
export function parsePorcelain(out) {
  const map = new Map();
  for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/gm)) map.set(Number(m[2]), m[1].slice(0, 12));
  return map;
}

/**
 * The cached line -> commit map of the ledger at the ops repo's HEAD (design section 5). The cache file holds
 * `{version, head, nlines, commits, idx}`. `snapshot()` never waits: `state` is cold until the first build finishes, and
 * lines past `nlines` (written, not committed) have no commit. `refresh()` starts at most one background update: a new
 * HEAD blames only the new tail (`-L <n+1>,<N>`), and the full blame re-runs only when the diff since the cached head
 * shows deletions.
 */
export function createLedgerBlame({ repo, relPath, cacheFile, git = runGit, now = Date.now, warn = console.warn, info = console.log, checkEveryMs = 60_000 }) {
  let cache = null; // {head, nlines, shas: string[] (index = line - 1)}
  let loaded = false;
  let running = null;
  let lastCheck = -Infinity;
  let lastError = null;
  let byPrefix = null;
  let lastBuild = null; // {kind, ms}

  const index = () => {
    if (byPrefix) return byPrefix;
    byPrefix = new Map();
    cache?.shas.forEach((s, i) => { if (!s) return; if (!byPrefix.has(s)) byPrefix.set(s, []); byPrefix.get(s).push(i + 1); });
    return byPrefix;
  };

  async function load() {
    loaded = true;
    try {
      const doc = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (doc?.version === 1 && Array.isArray(doc.commits) && Array.isArray(doc.idx)) cache = { head: doc.head, nlines: doc.nlines, shas: doc.idx.map((k) => (k < 0 ? null : doc.commits[k])) };
    } catch (e) { if (e?.code !== 'ENOENT') warn(`[decisions] blame cache unreadable, rebuilding: ${e.message}`); }
  }
  async function save() {
    const commits = [];
    const pos = new Map();
    const idx = cache.shas.map((s) => { if (!s) return -1; if (!pos.has(s)) { pos.set(s, commits.length); commits.push(s); } return pos.get(s); });
    const tmp = `${cacheFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, head: cache.head, nlines: cache.nlines, commits, idx }));
    await rename(tmp, cacheFile);
  }
  async function linesAt(head) {
    const out = await git(['-C', repo, 'show', `${head}:${relPath}`]);
    return out.endsWith('\n') ? out.split('\n').length - 1 : out.split('\n').length;
  }
  async function update() {
    if (!loaded) await load();
    const head = (await git(['-C', repo, 'rev-parse', 'HEAD'])).trim();
    if (cache?.head === head) return;
    const n = await linesAt(head);
    const t0 = now();
    let full = !cache;
    if (cache) {
      const stat = (await git(['-C', repo, 'diff', '--numstat', cache.head, head, '--', relPath]).catch(() => 'x\tx')).trim();
      const [, del] = stat ? stat.split('\t') : ['0', '0'];
      full = stat !== '' && del !== '0';
      if (!full && n < cache.nlines) full = true;
    }
    if (full) {
      const map = parsePorcelain(await git(['-C', repo, 'blame', '--porcelain', head, '--', relPath]));
      cache = { head, nlines: n, shas: Array.from({ length: n }, (_, i) => map.get(i + 1) ?? null) };
    } else {
      const shas = cache.shas.slice(0, cache.nlines);
      if (n > cache.nlines) {
        const map = parsePorcelain(await git(['-C', repo, 'blame', '--porcelain', '-L', `${cache.nlines + 1},${n}`, head, '--', relPath]));
        for (let l = cache.nlines + 1; l <= n; l += 1) shas[l - 1] = map.get(l) ?? null;
      }
      cache = { head, nlines: n, shas };
    }
    byPrefix = null;
    lastBuild = { kind: full ? 'full' : 'tail', ms: now() - t0 };
    info(`[decisions] ledger blame ${lastBuild.kind} to ${head.slice(0, 12)} (${n} lines) in ${lastBuild.ms} ms`);
    await save().catch((e) => warn(`[decisions] blame cache not written: ${e.message}`));
  }

  return {
    /** Start a background update when due; returns the running promise (tests await it, the route does not). */
    refresh() {
      if (running) return running;
      if (now() - lastCheck < checkEveryMs) return Promise.resolve();
      lastCheck = now();
      running = update().then(() => { lastError = null; }, (e) => { lastError = String(e?.message ?? e).slice(0, 200); warn(`[decisions] ledger blame failed: ${lastError}`); })
        .finally(() => { running = null; });
      return running;
    },
    snapshot() {
      return {
        state: cache ? (running ? 'updating' : 'warm') : (lastError ? 'failed' : 'cold'),
        head: cache?.head ?? null, nlines: cache?.nlines ?? 0, error: lastError, lastBuild,
        shaAt: (line) => (cache && line <= cache.nlines ? cache.shas[line - 1] ?? null : null),
        linesOf: (prefix) => {
          if (!cache || typeof prefix !== 'string' || prefix.length < 7) return [];
          const p = prefix.toLowerCase().slice(0, 12);
          const out = [];
          for (const [sha, lines] of index()) if (sha.startsWith(p)) out.push(...lines);
          return out;
        },
      };
    },
  };
}
