/**
 * markCards.js — the words on the card a Day ribbon mark opens (COMP-COCKPIT-RIBBON-MARKS-1).
 *
 * `cardFor(item, {now, lanes, seats})` is pure: it turns one contract item (a mark, pin, band or ETA) into
 * `{kind, tone, icon, title, name, sub, body, id, list, links}`, plus `full` (the body uncut, or null when nothing was cut). Wording is the prototype's (the owner clicked those
 * cards before picking it); times read in the ribbon's relative words ("yesterday 20:50") in the offset of `now`.
 * A link is `{label, action}`; `action.type` is `unit`, `reverse`, `initiative` or `card` (a cluster row opening its own card).
 */
import { asOfClock, clock, etaWord, fmtDur, toMs, when } from '../ribbonLayout.js';

const GLYPH = { land: '✓', deploy: '▲', deployFail: '▲', decide: '⚖︎', seatReset: '↻', expiry: '◇' };
/** A lane that stands for a named initiative offers the way into its Ops view. */
export const LANE_INITIATIVE = { '2.0': '2.0' };

const NAME_MAX = 90;
const BODY_MAX = 280;
const LIST_MAX = 70;
const clamp = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const sentence = (s) => String(s).trim().replace(/[.\s]+$/, '');
/** What a mark is called: its title, else its text cut short (an owner-queue decision has no title), else its unit. */
const titleOf = (m) => m.title || (m.text ? clamp(sentence(m.text), NAME_MAX) : '') || m.label || m.unit || '(untitled)';
/** The decision text for the body: dropped when the name already shows all of it, cut when long. */
const detailOf = (m) => (m.text && (m.title || sentence(m.text).length > NAME_MAX) ? `${clamp(sentence(m.text), BODY_MAX)}.` : '');
/** The same text uncut (U2 MARKS M2: a cut body offers "Show all", so a long decision is never lost to the card). */
const detailFull = (m) => (m.text && (m.title || sentence(m.text).length > NAME_MAX) ? `${sentence(m.text)}.` : '');

/** The lane a mark belongs to: the one whose marks hold the same `at`, `kind` and `unit` (cluster members carry no lane). */
export function laneOf(item, lanes) {
  if (item.lane) return item.lane;
  const hit = (lanes || []).find((l) => (l.marks || []).some((m) => m.at === item.at && m.kind === item.kind && (m.unit ?? null) === (item.unit ?? null)));
  return hit ? hit.lane : null;
}

/** A deploy's `text` is its target, so the thing deployed is the title or the unit, never the text; "on X" is dropped when X is the name. */
const what = (m) => m.title || m.unit || '(untitled)';
const target = (m) => (m.text && m.text !== what(m) ? ` on ${m.text}` : '');
const unitLink = (m) => (m.unit ? [{ label: 'unit page ▸', action: { type: 'unit', id: m.unit } }] : []);

function markCard(m, ctx) {
  const lane = laneOf(m, ctx.lanes);
  const sub = `${lane ? `${lane} lane · ` : ''}${when(m.at, ctx.now)}`;
  const base = { kind: m.kind, tone: m.kind === 'deployFail' ? 'bad' : 'plain', icon: GLYPH[m.kind], sub, id: m.unit || null, list: null };
  switch (m.kind) {
    case 'land': {
      const body = detailOf(m);
      const full = detailFull(m);
      return { ...base, title: 'Landed', name: titleOf(m), body, full: full !== body ? full : null, links: unitLink(m) };
    }
    case 'deploy':
      return { ...base, title: 'Deployed', name: `${what(m)} live${target(m)}`, body: '', links: unitLink(m) };
    case 'deployFail':
      return { ...base, title: 'Deploy failed', name: `${what(m)} did not go live${target(m)}`, body: '', links: unitLink(m) };
    default: {
      const revText = (rv) => (rv ? `${/^reverse\b/i.test(rv) ? '' : 'Reverse: '}${rv}.` : 'Reverse: not recorded.');
      const rev = revText(m.reverse ? clamp(sentence(m.reverse), BODY_MAX) : '');
      // U2-DATA Q1: an owner-queue decision has no unit; Reverse targets its queue id, so the inbox can open that row.
      const target = m.unit || m.queueId || null;
      const links = [...unitLink(m), ...(m.reverse ? [{ label: 'reverse ▸', action: { type: 'reverse', id: target } }] : [])];
      const body = [detailOf(m), rev].filter(Boolean).join(' ');
      const full = [detailFull(m), revText(m.reverse ? sentence(m.reverse) : '')].filter(Boolean).join(' ');
      return { ...base, title: 'Decided for you', name: titleOf(m), body, full: full !== body ? full : null, links };
    }
  }
}

function clusterCard(c, ctx) {
  const items = [...(c.items || [])].sort((a, b) => toMs(b.at) - toMs(a.at));
  return {
    kind: 'cluster', tone: 'plain', icon: '', title: `${c.count} ${items.length && items.every((it) => it.kind === 'seatReset') ? 'resets' : 'events'}`, name: `near ${when(c.at, ctx.now)}`, sub: '', body: '', id: null,
    list: items.map((it) => ({ glyph: GLYPH[it.kind] || '', text: clamp(titleOf(it), LIST_MAX), at: clock(it.at, ctx.now), action: { type: 'card', item: it } })),
    links: [],
  };
}

function pinCard(p, ctx) {
  if (p.kind === 'expiry') {
    return { kind: 'expiry', tone: 'plain', icon: '◇', title: p.label, name: '', sub: '', body: when(p.at, ctx.now), id: null, list: null, links: [] };
  }
  const seat = p.seat || p.label;
  const reading = (ctx.seats || []).find((s) => s.label === p.seat);
  const queued = (ctx.lanes || []).filter((l) => p.seat && l.seat === p.seat && !l.idle).map((l) => l.lane);
  const at = reading && typeof reading.pct === 'number' ? ` It is at ${reading.pct}% now${queued.length ? ` with ${queued.join(', ')} work queued` : ''}.` : '';
  return {
    kind: 'seatReset', tone: p.atGate ? 'warn' : 'plain', icon: '↻', title: `${seat} ${toMs(p.at) > toMs(ctx.now) ? 'resets' : 'reset'} ${clock(p.at, ctx.now)}`, name: '', sub: '',
    body: `${toMs(p.at) > toMs(ctx.now) ? `5h window resets in ${fmtDur(toMs(p.at) - toMs(ctx.now))}` : `5h window reset ${when(p.at, ctx.now)}`}.${at}`, id: null, list: null, links: [],
  };
}

function bandCard(b, ctx) {
  const ongoing = !b.end;
  const dur = fmtDur(toMs(b.end || ctx.now) - toMs(b.start));
  const source = b.source ? `Source: ${b.source}.` : '';
  if (b.kind === 'outage') {
    return { kind: 'outage', tone: 'bad', icon: '', title: `Outage since ${clock(b.start, ctx.now)}`, name: b.label, sub: '', body: `${ongoing ? 'Ongoing' : `Lasted ${dur}`}. ${source}`.trim(), id: null, list: null, links: [] };
  }
  return { kind: 'hold', tone: 'warn', icon: '', title: `Hold: ${b.label}, ${dur}${ongoing ? ' so far' : ''}`, name: '', sub: '', body: `${when(b.start, ctx.now)} to ${ongoing ? 'ongoing' : clock(b.end, ctx.now)}. ${source}`.trim(), id: null, list: null, links: [] };
}

function etaCard(e, ctx) {
  const rows = [`p50 ${etaWord(e.p50, ctx.now)}`];
  if (e.p80) rows.push(`p80 ${etaWord(e.p80, ctx.now)}`);
  const slipped = e.prev && e.prev.p50 && e.prev.p50 !== e.p50;
  const body = [`${rows.join(', ')}. As of ${asOfClock(e.asOf, ctx.now)}.`, slipped ? `Earlier estimate: ${etaWord(e.prev.p50, ctx.now)} (as of ${asOfClock(e.prev.asOf, ctx.now)}).` : ''].filter(Boolean).join(' ');
  const init = LANE_INITIATIVE[e.lane];
  return {
    kind: 'eta', tone: 'plain', icon: '◆', title: 'Expected landing', name: e.lane ? `${e.lane} lane` : '', sub: '', body, id: null, list: null,
    links: init ? [{ label: `How far is ${init} from flipping? ▸`, action: { type: 'initiative', initiative: init } }] : [],
  };
}

/** The card for one item. `item.kind` picks the shape; an unknown kind gets a plain one-line card. */
export function cardFor(item, ctx = {}) {
  const c = { now: ctx.now, lanes: ctx.lanes || [], seats: ctx.seats || [] };
  switch (item?.kind) {
    case 'land': case 'deploy': case 'deployFail': case 'decide': return markCard(item, c);
    case 'cluster': return clusterCard(item, c);
    case 'seatReset': case 'expiry': return pinCard(item, c);
    case 'hold': case 'outage': return bandCard(item, c);
    case 'eta': return etaCard(item, c);
    default: return { kind: 'unknown', tone: 'plain', icon: '', title: titleOf(item || {}), name: '', sub: '', body: '', id: null, list: null, links: [] };
  }
}
