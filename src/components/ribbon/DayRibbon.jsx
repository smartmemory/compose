import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  alertTip, axisTicks, clientToSvgX, clock, etaAt, etaWord, fmtDur, gapWord, isLive, laneState, layoutLanes, nextResetsLine, resetTicks, seatShort,
  tipText, toMs, when, windowTitle, xOf,
} from './ribbonLayout.js';
import { clusterMarks, MIN_DRAG_MS } from './rangeLogic.js';
import { fitText, textWidth } from './textFit.js';
import { FLASH_MS, RIBBON_CSS } from './dayRibbonCss.js';
import { MarkIcon, MarkShape, MARK_SHAPES } from './marks/MarkShape.jsx';

/**
 * DayRibbon — one row per lane over any window it is given (COMP-COCKPIT-RIBBON-ROWS-1). A pure drawing: it takes the
 * `/api/ribbon` response (`data`) and the window, draws spans, marks, bands, pins and the right-of-now section, and calls a
 * callback for every click. It fetches nothing and owns no range, popover or page state (RIBBON-RANGE-1, -MARKS-1, -LANE-1,
 * -TOP-1). Look and wording follow the owner-picked mock (`cockpit-mock.html`, Option 1).
 *
 * COMP-DAYVIEW-DESIGN-FIX-1 U2: drawn at true size (M1). The svg's width is its box's measured width and its viewBox the
 * same, so one unit is one CSS px: 13 px text measures 13 px, and every label is cut by its measured width (M2), never by a
 * character count.
 */

/** Width used before the box is measured (and under jsdom, which measures nothing). */
export const DEFAULT_W = 1200;
const GEOM = { X0: 100, RIGHT: 14, AX: 46, GH: 22, RH: 30 };
const PX = { body: 13, label: 11 };
const f1 = (n) => Math.round(n * 10) / 10;
const SPAN_CLASS = { review: 's-review', owner: 's-owner', quota: 's-quota', gate: 's-gate', unknown: 's-unknown' };
/** The span class of a lane state (laneState's kind, or its wait cause): the swatch before the NOW text and the legend key. */
const STATE_CLASS = { working: 's-work', stale: 's-stale', ...SPAN_CLASS };
/** U3 (DV#18, IMP#18): every mark, pin and estimate gets a 24 px hit area, cut at the midpoint to a neighbour on a dense row. */
const HIT_PX = 24;
/** U3 (DV#18): the surface gap between two spans on a row. */
const SPAN_GAP = 2;
/** U3 (DV#17): the WHAT line carries the page's one as-of; the ribbon names its own only when its body lags by more. */
export const ASOF_LAG_MS = 5 * 60_000;

/** `[{x, lo, hi}]` hit bounds for points at `xs` (sorted or not): HIT_PX wide, never past the midpoint to a neighbour. */
export function hitBounds(xs) {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  order.forEach(([x, i], k) => {
    const prev = k > 0 ? order[k - 1][0] : -Infinity;
    const next = k < order.length - 1 ? order[k + 1][0] : Infinity;
    out[i] = { x, lo: Math.max(x - HIT_PX / 2, (prev + x) / 2), hi: Math.min(x + HIT_PX / 2, (x + next) / 2) };
  });
  return out;
}
/** Space kept between the NOW text, the next unit and the right-edge text (M2). */
const GAP = 16;
/** The next unit is drawn only with at least this much room after the NOW text (M2). */
const NEXT_MIN_PX = 60;

/** Hatch patterns and legend swatches share these so the legend can never drift from the bars. */
function Patterns() {
  // U1 (C1, C4): hatching only where it carries meaning. Working, review and owner are flat fills; gate keeps its 0 degree
  // hatch in a neutral, quota its -45 degree one, unknown a sparse 45 degree line (1 in 10: denser reads as the review tan
  // to normal vision, measured). The validator run reads these widths.
  const hatch = (id, size, angle, bg, line, width) => (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform={`rotate(${angle})`}>
      <rect width={size} height={size} style={{ fill: bg }} /><line x1={width / 2} y1="0" x2={width / 2} y2={size} style={{ stroke: line, strokeWidth: width }} />
    </pattern>
  );
  return (
    <defs>
      {hatch('rb-hz-quota', 5, -45, 'var(--rb-quota-bg)', 'var(--rb-quota)', 1)}
      {hatch('rb-hz-gate', 6, 0, 'var(--rb-gate-bg)', 'var(--rb-gate)', 2)}
      {hatch('rb-hz-unknown', 10, 45, 'transparent', 'var(--rb-muted)', 1)}
    </defs>
  );
}

const Swatch = ({ cls }) => (
  <svg className="sw" viewBox="0 0 22 9" aria-hidden="true"><rect x="0.5" y="0.5" width="21" height="8" rx="2" className={cls} /></svg>
);

const activate = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
};
/** Enter/Space on an item inside a lane row: run `fn` and keep the row's own handler out of it. */
const activateInRow = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(e); }
};
const rectOf = (e) => e.currentTarget.getBoundingClientRect();

/** The legend's entries, in reading order: `[key, swatch class or glyph, words]`. Only the keys drawn this render are shown (M9). */
const LEGEND = [
  ['owner', 's-owner', 'waiting on you'], ['work', 's-work', 'working'], ['stale', 's-stale', 'stale (no stamp in 24h)'],
  ['review', 's-review', 'waiting on review'], ['gate', 's-gate', 'waiting on gate'], ['quota', 's-quota', 'waiting on quota'],
  ['unknown', 's-unknown', 'waiting, cause not recorded'], ['norec', 's-norec', 'not recorded'],
  ['hold', 'band-hold', 'launch hold'], ['outage', 'band-outage', 'outage'],
  ['land', 'shape', 'landed'], ['deploy', 'shape', 'deployed'], ['deployFail', 'shape', 'deploy failed'], ['decide', 'shape', 'decided for you'],
  ['cluster', '#', 'events grouped (count)'], ['alert', '⚠', 'alert'], ['eta', '◆', 'expected landing'], ['reset', '│', 'seat reset (AHEAD)'],
  ['now', '│', 'now'],
];

/** A ◆ on the time axis (U2 M3): `cx`, `cy` its centre, `r` its half-size. */
const diamond = (cx, cy, r) => `M${f1(cx)} ${f1(cy - r)}L${f1(cx + r)} ${f1(cy)}L${f1(cx)} ${f1(cy + r)}L${f1(cx - r)} ${f1(cy)}Z`;

/**
 * U2 M6: the project most of a group's lanes belong to, `{chip, n}`, or null when no lane has one. The group header names it
 * once; a lane's own chip is drawn only when it differs.
 */
export function groupProject(lanes, laneProjects) {
  const count = new Map();
  for (const l of lanes || []) {
    const c = laneProjects?.[l.lane];
    if (!c?.project) continue;
    const e = count.get(c.project) || { chip: c, n: 0 };
    e.n += 1;
    count.set(c.project, e);
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0] || null;
}

export default function DayRibbon({
  data, from, to, now, seats = [], alerts = [], showResets = true, idleOpen = false, onIdleToggle, onLaneOpen, onMarkOpen, onPinOpen, onBandOpen,
  flashLane = null, onAxisSelect, laneProjects = {}, onProjectOpen, onOwnerOpen, onTitleClick, onResetsToggle, updating = false,
}) {
  const [tip, setTip] = useState(null);
  const svgRef = useRef(null);
  const boxRef = useRef(null);
  const [W, setW] = useState(DEFAULT_W);
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  dragRef.current = drag;
  const [flashing, setFlashing] = useState(null);
  const timer = useRef(null);

  // M1: the drawing is as wide as its box, so nothing is scaled. jsdom has no layout (width 0): the default stands.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    // U2 review F6: the content box (`clientWidth`), never the scroller's border box, which includes a classic vertical
    // scrollbar and made the svg overflow by its width. jsdom reports 0 for both unless a test mocks one.
    const read = () => { const w = Math.round(el.clientWidth || el.getBoundingClientRect().width); if (w > 0) setW((old) => (old === w ? old : w)); };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!flashLane) return undefined;
    setFlashing(flashLane);
    timer.current = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(timer.current);
  }, [flashLane]);

  const R = { ...GEOM, W, X1: W - GEOM.RIGHT };
  const TRACK = R.X1 - R.X0;
  const clampX = (x) => Math.min(R.X1, Math.max(R.X0, x));
  const sizeRef = useRef({ W, H: 0 });

  // Press-and-drag on the time axis draws a selection; release over >= 15 min calls onAxisSelect(fromMs, toMs); Esc cancels.
  // RANGE M1: the pointer is read through the svg's own box and viewBox (clientToSvgX), never a bare width ratio.
  const svgX = (clientX) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width) return NaN;
    return clampX(clientToSvgX(clientX, r, sizeRef.current.W, sizeRef.current.H || r.height));
  };
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => { const x = svgX(e.clientX); if (!Number.isNaN(x)) setDrag((d) => d && { ...d, b: x }); };
    const up = (e) => {
      const d = dragRef.current;
      const x = svgX(e.clientX);
      setDrag(null);
      if (!d) return;
      const b = Number.isNaN(x) ? d.b : x;
      const f = toMs(from);
      const span = toMs(to) - f;
      const t0 = f + ((Math.min(d.a, b) - R.X0) / TRACK) * span;
      const t1 = f + ((Math.max(d.a, b) - R.X0) / TRACK) * span;
      if (t1 - t0 >= MIN_DRAG_MS && onAxisSelect) onAxisSelect(Math.round(t0), Math.round(t1));
    };
    const key = (e) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
  }, [!drag, from, to, onAxisSelect, W]); // eslint-disable-line react-hooks/exhaustive-deps
  const startDrag = (e) => {
    const x = svgX(e.clientX);
    if (!Number.isNaN(x)) setDrag({ a: x, b: x });
  };

  const lanes = data?.lanes || [];
  const live = isLive(from, to, now);
  const nowMs = toMs(now);
  const X = (t) => R.X0 + xOf(t, from, to, TRACK);
  const nx = X(now);
  const inWindow = (t) => toMs(t) >= toMs(from) && toMs(t) <= toMs(to);
  // One state per lane at now (S1), judged on the feed's own clock (RIBBON-ROWS-1 M2), and C3: an open owner wait leads its group.
  const states = new Map(live && !updating ? lanes.map((l) => [l.lane, laneState(l, now, data?.now)]) : []);
  const ownerAt = (l) => (states.get(l.lane)?.cause === 'owner' ? 0 : 1);
  const groups = layoutLanes(lanes, { idleOpen, seats }).map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => ownerAt(a) - ownerAt(b)) }));
  const drawn = new Set(); // every legend key this render draws (M9)
  const history = data?.history || {};
  const covered = Object.values(history).some((h) => h?.earliest && toMs(h.earliest) <= toMs(from));
  const regions = data?.notRecorded || [];
  const bands = data?.bands || [];
  const pins = data?.pins || [];
  const alertLane = (a) => a.lane ?? a.action?.lane ?? null;

  // ---- vertical layout: one flat list of rows, then a height ----
  const rows = [];
  let y = R.AX + 6;
  groups.forEach((g) => {
    const major = groupProject([...g.rows, ...(g.idle?.lanes || [])], laneProjects);
    rows.push({ type: 'group', y, label: g.label, group: g.group, major: major?.chip || null });
    y += R.GH;
    g.rows.forEach((lane) => { rows.push({ type: 'lane', y, lane, major: major?.chip || null }); y += R.RH; });
    if (g.idle) {
      rows.push({ type: 'idle', y, idle: g.idle });
      y += R.RH;
      if (g.idle.open) g.idle.lanes.forEach((lane) => { rows.push({ type: 'lane', y, lane, idle: true, major: major?.chip || null }); y += R.RH; });
    }
  });
  const lanesTop = R.AX + 6 + R.GH;
  const lanesEnd = y;

  // AHEAD row (RESETS-COMPACT-1): ONE line of reset ticks, only those still to come (U2 M7). Alerts with no lane are not drawn
  // here: the range bar's alert chip carries them (`orphanAlerts` in ribbonLayout.js).
  const alertSeats = alerts.filter((a) => a.seat && !a.cleared).map((a) => a.seat);
  const ahead = showResets && !updating ? resetTicks(pins, { from, to, now, trackPx: TRACK, alertSeats }) : { ticks: [], off: [] };
  const nextLine = showResets && !updating ? nextResetsLine(pins, { now, alertSeats }) : null;
  const offW = (o) => textWidth(`${o.pin.kind === 'seatReset' ? '↻' : '◇'} ${o.label} ▸`, PX.label) + 12;
  let offX = R.X1;
  const offDraw = [...ahead.off].reverse().map((o) => { const w = offW(o); offX -= w; return { ...o, x: offX, w }; }).reverse();
  const hasAhead = ahead.ticks.length > 0 || offDraw.length > 0;
  const aheadY = lanesEnd + 6;
  const H = hasAhead ? aheadY + 12 + 17 + 8 : lanesEnd + 8;
  sizeRef.current = { W, H };

  const ticks = axisTicks(from, to, TRACK);

  // ---- tooltip plumbing: one element, delegated from the root ----
  const showFor = (el, x, y2) => {
    const text = el?.closest?.('[data-tip]')?.getAttribute('data-tip');
    if (!text) { setTip(null); return; }
    setTip({ text, x, y: y2 });
  };
  const onOver = (e) => showFor(e.target, e.clientX + 12, e.clientY + 14);
  const onFocusIn = (e) => {
    const r = e.target.getBoundingClientRect?.();
    showFor(e.target, r ? r.left : 0, r ? r.bottom + 6 : 0);
  };

  const cb = (fn, ...args) => (e) => fn && fn(...args, rectOf(e));

  const laneTip = (lane, s) => tipText({ ...s, lane: lane.lane, now });
  const projectChip = (chip, testid, x, yy, maxPx, tipWords) => {
    const label = fitText(chip.label, maxPx, PX.label);
    if (!label) return null;
    return (
      <text className="lproj" data-testid={testid} x={x} y={yy} role="button" tabIndex={0}
        aria-label={`Open the ${chip.label} graph`} data-tip={tipWords}
        onClick={(e) => { e.stopPropagation(); onProjectOpen && onProjectOpen(chip); }}
        onKeyDown={activateInRow(() => onProjectOpen && onProjectOpen(chip))}>{label}</text>
    );
  };

  const laneRow = (lane, ry, idle, major) => {
    const mid = ry + 16;
    const cur = live && !updating ? lane.current : null;
    const st = live ? states.get(lane.lane) : null;
    const waiting = st?.kind === 'wait' ? st : null;
    const stale = st?.kind === 'stale';
    const empty = !updating && !(lane.spans || []).length && !(lane.marks || []).length && !cur;
    const laneAlerts = alerts.filter((a) => alertLane(a) === lane.lane && a.since && inWindow(a.since));
    if (laneAlerts.length) drawn.add('alert');
    // S2: a stale unit has no live estimate; M3: neither has a lane that is waiting (it lands after the wait, unknown when).
    const eta = live && cur && !stale && !waiting ? lane.eta : null;
    const etaFor = waiting?.cause === 'owner' && cur ? lane.eta : null; // only to say "◆ on answer"
    const openEta = (e) => onMarkOpen && onMarkOpen({ kind: 'eta', lane: lane.lane, p50: eta.p50, p80: eta.p80, asOf: eta.asOf, prev: eta.prev }, rectOf(e));
    const etaMs = eta?.p50 ? etaAt(eta.p50, now) : null;
    const etaIn = etaMs != null && inWindow(etaMs);
    const prevMs = eta?.prev?.p50 ? etaAt(eta.prev.p50, eta.prev.asOf && Number.isFinite(toMs(eta.prev.asOf)) ? eta.prev.asOf : now) : null;
    const prevIn = prevMs != null && inWindow(prevMs);
    const stateCls = st ? STATE_CLASS[st.kind === 'wait' ? st.cause : st.kind] || 's-unknown' : null;
    const next = live && !updating ? (lane.next || []) : [];
    const nextTitles = next.map((n) => n.title || n.id);
    const own = laneProjects[lane.lane] ?? null;
    const chip = own && own.project !== major?.project ? own : null; // M6: only where it differs from the group

    // ---- M2: the right-of-now section, measured. The right-edge words first, then the NOW text fitted before them, then
    // the next unit only when it has room. Nothing is placed by a fixed offset, so nothing can overprint.
    let right = null;
    if (etaFor) right = { id: 'eta-answer', text: '◆ on answer', tip: 'Waiting on your answer: no landing estimate until it is given' };
    else if (stale) right = { id: 'eta-stale', text: 'no estimate', tip: 'No stamp for this unit in 24 hours: no live estimate' };
    else if (eta?.noData) right = { id: 'eta-none', text: 'no estimate', tip: tipText({ kind: 'noEta', raw: eta.raw }) };
    else if (eta?.p50 && !etaIn) {
      const word = etaWord(eta.p50, now);
      right = { id: 'eta', text: `◆ ETA ${word}${etaMs != null ? ' ▸' : ''}`, tip: tipText({ kind: 'eta', p50: eta.p50, asOf: eta.asOf, now }), open: true };
    }
    if (right) right.w = textWidth(right.text, PX.body);
    if (right && (right.id === 'eta' || right.id === 'eta-answer')) drawn.add('eta');
    if (etaIn) drawn.add('eta');
    const textX = nx + 24;
    const rightLimit = right ? R.X1 - right.w - GAP : R.X1;
    let curText = null;
    let curEnd = textX;
    if (st && live) {
      const room = rightLimit - textX;
      const title = cur?.title || cur?.id || '';
      if (st.kind === 'wait') curText = fitText(st.phrase, room, PX.body, 550);
      else if (st.kind === 'stale') {
        const head = `stale ${fmtDur(nowMs - st.since)} · `;
        const t = fitText(title, room - textWidth(head, PX.body), PX.body);
        curText = t ? `${head}${t}` : fitText(head.replace(/ · $/, ''), room, PX.body);
      } else {
        const tail = st.since === null ? '' : ` · ${fmtDur(nowMs - st.since)}`;
        const t = fitText(title, room - textWidth(tail, PX.body, 550), PX.body, 550);
        curText = t ? `${t}${tail}` : fitText(tail.replace(/^ · /, ''), room, PX.body, 550);
      }
      if (curText) curEnd = textX + textWidth(curText, PX.body, st.kind === 'stale' ? 400 : 550);
    }
    const nextX = (curText ? curEnd : textX) + GAP;
    const nextText = live && nextTitles.length && rightLimit - nextX >= NEXT_MIN_PX
      ? fitText(`→ ${nextTitles[0]}`, rightLimit - nextX, PX.body) : '';

    // Lane label column: the seat's short name right-aligned at X0 - 10, the lane name fitted before it.
    const seatTxt = seatShort(lane.seat);
    const nameRoom = R.X0 - 10 - (seatTxt ? textWidth(seatTxt, PX.label) + 6 : 0) - 12;
    const name = fitText(lane.lane, nameRoom, PX.body, 650) || lane.lane.slice(0, 1);

    return (
      <g key={`${lane.lane}-${idle ? 'idle' : 'row'}`} className={`lane${idle ? ' lane-idle' : ''}${flashing === lane.lane ? ' rb-flash' : ''}`}
        data-testid={`lane-${lane.lane}`} data-lane={lane.lane} tabIndex={0} role="button" aria-label={`${lane.lane} lane details`}
        onClick={() => onLaneOpen && onLaneOpen(lane)} onKeyDown={activate(() => onLaneOpen && onLaneOpen(lane))}>
        <rect className="row-bg" x="2" y={ry + 1} width={R.W - 4} height={R.RH - 2} rx="5" />
        {chip ? (
          <>
            <text className="lname" x="12" y={ry + 13}>{name}</text>
            {/* COMP-COCKPIT-PROJECT-MODEL-1: the project chip opens that project's graph focused on this lane, never the lane drawer. */}
            {projectChip(chip, `lane-project-${lane.lane}`, 12, ry + 26, R.X0 - 22, `Open the ${chip.label} graph, focused on ${lane.lane}`)}
          </>
        ) : <text className="lname" x="12" y={ry + 20}>{name}</text>}
        <text className="lseat" x={R.X0 - 10} y={ry + 20} textAnchor="end">{seatTxt}</text>
        <line className="base" x1={R.X0} x2={live ? nx : R.X1} y1={mid} y2={mid} />
        {(lane.spans || []).map((s, i) => {
          const x0 = clampX(X(s.start));
          const x1 = clampX(X(s.end));
          // S2: the stale current unit's work is a dashed outline, not a live bar.
          const staleWork = stale && s.kind === 'work' && (s.unit == null || s.unit === cur?.id);
          const cls = s.kind === 'work' ? (staleWork ? 's-stale' : 's-work') : s.kind === 'wait' ? (SPAN_CLASS[s.cause] || 's-unknown') : 's-norec';
          const key = s.kind === 'work' ? (staleWork ? 'stale' : 'work') : s.kind === 'wait' ? (SPAN_CLASS[s.cause] ? s.cause : 'unknown') : 'norec';
          drawn.add(key);
          const w = Math.max(1.5, x1 - x0 - SPAN_GAP);
          if (key === 'owner') {
            // C1: the one loud state, full row height with a "?" at its start.
            return (
              <g key={i} className="seg" data-testid="span-wait" data-cause="owner" data-queue={s.queueId ?? ''} data-tip={laneTip(lane, s) + (s.laneGuess ? '\nno lane named: shown on this row' : '')}>
                <rect className="s-owner" x={f1(x0)} y={ry + 6} width={f1(w)} height="20" rx="3" />
                {w >= 12 && <text className="own-q" x={f1(x0 + 3)} y={ry + 20}>?</text>}
              </g>
            );
          }
          return (
            <rect key={i} className={`seg ${cls}`} data-testid={`span-${s.kind}`} data-cause={s.kind === 'wait' ? key : undefined} x={f1(x0)} y={ry + 11} width={f1(w)} height="10" rx="2"
              data-tip={laneTip(lane, s) + (staleWork ? '\nstale: no stamp in 24h, no estimate' : '')} />
          );
        })}
        {empty && (
          <text className="empty-t" data-testid="lane-empty" x={R.X0 + 8} y={ry + 20}>
            {covered ? 'nothing in this window' : 'not recorded in this window'}
          </text>
        )}
        {/* M5: marks closer than a glyph's width merge into one count at every window width. */}
        {(() => {
          const shown = clusterMarks(lane.marks || [], { from, to }, TRACK).filter((m) => inWindow(m.at));
          const hits = hitBounds(shown.map((m) => X(m.at)));
          return shown.map((m, i) => {
          const x = f1(X(m.at));
          drawn.add(m.kind);
          const tip2 = tipText({ ...m, now });
          return (
            <g key={`m${i}`} className="mark" data-testid={`mark-${m.kind}`} data-tip={tip2} tabIndex={0} role="button" aria-label={tip2.replace('\n', ' ')}
              onClick={(e) => { e.stopPropagation(); onMarkOpen && onMarkOpen(m, rectOf(e)); }}
              onKeyDown={activateInRow((e) => onMarkOpen && onMarkOpen(m, rectOf(e)))}>
              <rect className="hit" data-testid="mark-hit" x={f1(hits[i].lo)} y={ry} width={f1(hits[i].hi - hits[i].lo)} height={R.RH} />
              {m.kind === 'cluster' ? (
                <>
                  <rect className="cl-bg" x={x - 9} y={ry + 1} width="18" height="13" rx="6.5" />
                  <text className="cl-n" x={x} y={ry + 11.5} textAnchor="middle">{m.count}</text>
                </>
              ) : (
                <>
                  <line className="tk-gap" x1={x} x2={x} y1={ry + 10} y2={ry + 22} />
                  {/* AD#16: a drawn shape, the same at every size and in every font. */}
                  <MarkShape kind={m.kind} cx={x} cy={ry + 5} r={4.5} />
                </>
              )}
            </g>
          );
          });
        })()}
        {laneAlerts.map((a, i) => (
          <text key={`a${i}`} className={`tk alert${a.cleared ? ' cleared' : ''}`} data-testid="alert-mark" x={f1(X(a.since))} y={ry + 9} textAnchor="middle"
            data-tip={alertTip(a, now)}>{a.cleared ? '✓⚠' : '⚠'}</text>
        ))}
        {waiting?.cause === 'owner' && !waiting.askedOn && ( // FU-1: a lane that only mirrors an ask drawn elsewhere has no marker of its own
          // C3: the marker at NOW on the lane that needs the owner; it opens the inbox, like the WHAT line's chip.
          <g className="own-now" data-testid="owner-now" data-queue={waiting.span.queueId ?? ''} tabIndex={0} role="button"
            aria-label={`Needs you: ${waiting.span.title || lane.lane}`} data-tip={`Needs you · ${waiting.span.title || lane.lane}\nclick to open the question`}
            onClick={(e) => { e.stopPropagation(); onOwnerOpen && onOwnerOpen(waiting.span); }}
            onKeyDown={activateInRow(() => onOwnerOpen && onOwnerOpen(waiting.span))}>
            <circle cx={f1(nx)} cy={mid} r="8" />
            <text className="own-q" x={f1(nx)} y={mid + 4} textAnchor="middle">?</text>
          </g>
        )}
        {st && rightLimit - textX >= 0 && (
          // K3: the state words in ink, with the state's own swatch before them carrying the color.
          <g data-testid="current" data-state={st.kind === 'wait' ? st.cause : st.kind}
            data-tip={tipText({ kind: 'current', ...(cur || { title: st.span?.title, since: st.span?.since }), ...(waiting ? { since: waiting.since } : {}), cause: waiting ? waiting.cause : null, now })}>
            <rect className={`seg ${stateCls}`} x={f1(nx + 12)} y={ry + 11} width="8" height="10" rx="2" />
            {curText && <text className={`cur${stale ? ' stale' : ''}`} x={f1(textX)} y={ry + 20}>{curText}</text>}
          </g>
        )}
        {nextText && (
          <text className="nxt" data-testid="next" x={f1(nextX)} y={ry + 20} data-tip={tipText({ kind: 'next', titles: nextTitles })}>{nextText}</text>
        )}
        {right && !right.open && (
          <text className="eta" data-testid={right.id} x={R.X1} y={ry + 20} textAnchor="end" data-tip={right.tip}>
            {right.id === 'eta-answer' ? <><tspan className="d">◆</tspan> on answer</> : right.text}
          </text>
        )}
        {right?.open && (
          <text className="eta" data-testid="eta" data-where="edge" x={R.X1} y={ry + 20} textAnchor="end" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
            aria-label={`Expected landing, ${lane.lane} lane: ${etaWord(eta.p50, now)}`} data-tip={right.tip}
            onClick={(e) => { e.stopPropagation(); openEta(e); }} onKeyDown={activateInRow(openEta)}>
            <tspan className="d">◆</tspan>{right.text.slice(1)}
          </text>
        )}
        {prevIn && (
          // ROWS L1 / RANGE M4: the earlier estimate stays on the axis wherever it falls in the window, missed ones included.
          <g className="eta-pin prev" data-testid="eta-prev" role="button" tabIndex={0} aria-label={`Earlier estimate, ${lane.lane} lane`}
            data-tip={tipText({ kind: 'prev', p50: eta.prev.p50, asOf: eta.prev.asOf, now })}
            onClick={(e) => { e.stopPropagation(); openEta(e); }} onKeyDown={activateInRow(openEta)}>
            <rect className="hit" x={f1(X(prevMs) - HIT_PX / 2)} y={ry} width={HIT_PX} height="13" />
            <path d={diamond(X(prevMs), ry + 6, 4)} />
          </g>
        )}
        {etaIn && (
          // M3: an in-window estimate is a diamond at its time, in the row's top band clear of the bars and the NOW words.
          <g className="eta-pin" data-testid="eta" data-where="axis" role="button" tabIndex={0} aria-label={`Expected landing, ${lane.lane} lane: ${etaWord(eta.p50, now)}`}
            data-tip={tipText({ kind: 'eta', p50: eta.p50, asOf: eta.asOf, now })}
            onClick={(e) => { e.stopPropagation(); openEta(e); }} onKeyDown={activateInRow(openEta)}>
            <rect className="hit" x={f1(X(etaMs) - HIT_PX / 2)} y={ry} width={HIT_PX} height="13" />
            <path d={diamond(X(etaMs), ry + 6, 4.5)} />
          </g>
        )}
      </g>
    );
  };

  const bandY = lanesTop - 14;
  // Rows are drawn before the legend is built, so the legend lists exactly what this render drew (M9).
  const rowEls = rows.map((r, i) => {
    if (r.type === 'group') {
      return (
        <g key={`g${i}`}>
          <text className="grp" x="12" y={r.y + 15}>{r.label}</text>
          {r.major && (
            <text className="grp-proj" data-testid={`group-project-${r.group}`} x={R.X0} y={r.y + 15} role="button" tabIndex={0}
              aria-label={`Open the ${r.major.label} graph`} data-tip={`Open the ${r.major.label} graph`}
              onClick={() => onProjectOpen && onProjectOpen({ ...r.major, lane: null })}
              onKeyDown={activate(() => onProjectOpen && onProjectOpen({ ...r.major, lane: null }))}>{r.major.label}</text>
          )}
        </g>
      );
    }
    if (r.type === 'lane') return laneRow(r.lane, r.y, r.idle, r.major);
    const names = `${r.idle.names.join(' · ')}${r.idle.seatNote ? `  ${r.idle.seatNote}` : ''}`;
    return (
      <g key={`i${i}`} className="idle-row" data-testid="idle-row" tabIndex={0} role="button" aria-expanded={r.idle.open}
        onClick={() => onIdleToggle && onIdleToggle()} onKeyDown={activate(() => onIdleToggle && onIdleToggle())}>
        <rect className="row-bg" x="2" y={r.y + 1} width={R.W - 4} height={R.RH - 2} rx="5" />
        <text className="idle-t" x="12" y={r.y + 19}>{r.idle.n} {r.idle.n === 1 ? 'lane' : 'lanes'} idle {r.idle.open ? '▾' : '▸'}</text>
        {!r.idle.open && (
          <text className="ax" x={R.X0 + 20} y={r.y + 19} data-tip={names}>{fitText(names, R.X1 - R.X0 - 20, PX.label)}</text>
        )}
      </g>
    );
  });
  const shownBands = bands.filter((b) => toMs(b.end || to) > toMs(from) && toMs(b.start) < toMs(to));
  shownBands.forEach((b) => drawn.add(b.kind));
  if (ahead.ticks.length || offDraw.some((o) => o.pin.kind === 'seatReset')) drawn.add('reset');
  if (live) drawn.add('now');
  // C2: a source-level gap (spend, expiry, a history that starts late) is words under the ribbon, never a box over the
  // lanes. A source that failed to read is already listed by the page, so it is not repeated here.
  const gaps = updating ? [] : regions.filter((g) => toMs(g.end) > toMs(from) && toMs(g.start) < toMs(to) && !(data?.sourceErrors || {})[String(g.source).split('.')[0]]);
  const legend = (
    <div className="legend px-3.5 pb-2 pt-1" data-testid="ribbon-legend">
      {LEGEND.filter(([k]) => drawn.has(k)).map(([k, mark, words]) => (
        <span key={k} data-key={k}>
          {mark.startsWith('s-') || mark.startsWith('band-') ? <Swatch cls={mark} />
            : mark === 'shape' && MARK_SHAPES.has(k) ? <MarkIcon kind={k} />
            : <span style={{ color: k === 'now' || k === 'eta' || k === 'decide' || k === 'cluster' || k === 'reset' ? 'var(--rb-accent)' : k === 'deployFail' || k === 'alert' ? 'var(--rb-alert)' : undefined }}>{mark}</span>}
          {words}
        </span>
      ))}
    </div>
  );
  const title = windowTitle(from, to, now);
  const lagging = Number.isFinite(toMs(data?.asOf)) && toMs(now) - toMs(data.asOf) > ASOF_LAG_MS;

  return (
    <div className="day-ribbon flex h-full min-h-0 flex-col rounded-xl border border-border bg-card" data-testid="day-ribbon"
      onMouseOver={onOver} onMouseMove={onOver} onMouseOut={() => setTip(null)} onFocus={onFocusIn} onBlur={() => setTip(null)}>
      <style>{RIBBON_CSS}</style>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3.5 pt-2.5">
        {/* M8: the window is said once, here, in 24-hour words; a click opens the start and end pickers. */}
        <h3 className="m-0 text-[length:var(--type-label)] font-bold uppercase tracking-[0.09em] text-muted-foreground" data-testid="ribbon-title">
          {onTitleClick
            ? <button type="button" className="uppercase tracking-[0.09em] hover:text-foreground hover:underline focus-visible:underline outline-none" data-testid="ribbon-title-button" aria-label={`${title}: pick a start and end`} onClick={onTitleClick}>{title}</button>
            : title}
        </h3>
        <span className="text-[length:var(--type-label)] text-muted-foreground" data-testid="ribbon-fresh" aria-live="polite">
          {updating ? 'updating…' : [lagging ? `lanes as of ${clock(data.asOf, now)}` : null, data?.coverage?.label || null].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="ribbon-box">
        <svg ref={svgRef} className="block" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" data-testid="ribbon-svg"
          aria-label={`Day ribbon: one row per lane, ${when(from, now)} to ${when(to, now)}`}>
          <Patterns />
          {live && <rect className="future-bg" x={f1(nx)} y={R.AX - 2} width={f1(Math.max(0, R.X1 - nx + 8))} height={H - R.AX + 2} />}
          {ticks.map((k) => {
            const x = f1(R.X0 + k.x);
            return (
              <g key={k.t}>
                <line className="grid" x1={x} x2={x} y1={R.AX - 2} y2={lanesEnd} />
                <line className="axl" x1={x} x2={x} y1={R.AX - 7} y2={R.AX - 2} />
                <text className={k.midnight ? 'ax-day' : 'ax'} x={x} y={R.AX - 11} textAnchor="middle">{k.label}</text>
              </g>
            );
          })}
          <line className="axl" x1={R.X0} x2={R.X1} y1={R.AX - 2} y2={R.AX - 2} />
          <rect className="axis-hit" data-testid="axis-drag" x={R.X0} y="18" width={TRACK} height={R.AX - 20} onPointerDown={startDrag} />
          {drag && (
            <rect className="zoom-sel" data-testid="axis-selection" x={f1(Math.min(drag.a, drag.b))} y="18" width={f1(Math.abs(drag.b - drag.a))}
              height={Math.max(0, lanesEnd - 18)} />
          )}
          <text className="ax" x="12" y="14">LANE</text>

          {rowEls}

          {shownBands.map((b, i) => {
            const end = b.end || to;
            const x0 = clampX(X(b.start));
            const x1 = clampX(X(end));
            const t = tipText({ ...b, now });
            const w = f1(Math.max(1.5, x1 - x0));
            return (
              <g key={`b${i}`} data-testid={`band-${b.kind}`}>
                <rect className={`band-${b.kind}`} x={f1(x0)} y={lanesTop} width={w} height={Math.max(0, lanesEnd - lanesTop)} />
                <g className="band-h" data-tip={t} tabIndex={0} role="button" aria-label={t.replace('\n', ' ')}
                  onClick={() => onBandOpen && onBandOpen(b)} onKeyDown={activate(() => onBandOpen && onBandOpen(b))}>
                  <rect className={`handle ${b.kind}`} x={f1(x0)} y={bandY + 8} width={w} height="8" rx="2" />
                </g>
              </g>
            );
          })}

          {hasAhead && (
            <>
              <text className="grp" x="12" y={aheadY + 14}>AHEAD</text>
              {ahead.ticks.map((t, i) => {
                const ly = aheadY + 14;
                const x = R.X0 + t.x;
                const single = t.count === 1 ? t.items[0] : null;
                // U2 review follow-up: measured like every other label (M2), never a character count.
                const w = textWidth(`${single && single.kind === 'expiry' ? '◇ ' : ''}${t.label}`, PX.label) + 9;
                const pin = t.count > 1 ? { kind: 'cluster', at: t.items[0].at, count: t.count, items: t.items } : single;
                return (
                  <g key={`p${i}`} className={`pin rt rt-${t.tone}${t.count > 1 ? ' rt-merged' : ''}`} data-testid={`pin-${single ? single.kind : 'seatReset'}`} data-tone={t.tone} data-count={t.count} data-tip={t.tip} tabIndex={0} role="button" aria-label={t.tip.replace(/\n/g, ' ')}
                    onClick={cb(onPinOpen, pin)} onKeyDown={activate((e) => onPinOpen && onPinOpen(pin, rectOf(e)))}>
                    <rect className="hit" x={f1(x - 3)} y={ly - 13} width={f1(w)} height="17" />
                    <line className="rt-l" x1={f1(x)} x2={f1(x)} y1={ly - 11} y2={ly + 2} />
                    <text className={`pin-t rt-t${t.full ? ' next' : ''}`} x={f1(x + 3)} y={ly}>
                      {single && single.kind === 'expiry' ? <tspan className="pin-g">◇ </tspan> : null}{t.label}
                    </text>
                  </g>
                );
              })}
              {offDraw.map((o, i) => {
                const p = o.pin;
                const ly = aheadY + 14;
                const t = tipText({ ...p, now });
                return (
                  <g key={`o${i}`} className="pin" data-testid={`pin-${p.kind}`} data-tip={t} tabIndex={0} role="button" aria-label={t.replace('\n', ' ')}
                    onClick={cb(onPinOpen, p)} onKeyDown={activate((e) => onPinOpen && onPinOpen(p, rectOf(e)))}>
                    <rect className="hit" x={f1(o.x - 4)} y={ly - 13} width={f1(o.w + 4)} height="17" />
                    <text className={`pin-t${p.atGate ? ' hot' : ''}`} x={R.X1} y={ly} textAnchor="end">
                      <tspan className="pin-g">{p.kind === 'seatReset' ? '↻' : '◇'}</tspan> {o.label} ▸
                    </text>
                  </g>
                );
              })}
            </>
          )}

          {live && (
            <g data-testid="now-line">
              <line className="now-l" x1={f1(nx)} x2={f1(nx)} y1="20" y2={lanesEnd} />
              <circle className="now-dot" cx={f1(nx)} cy="20" r="3" />
              <text className="now-t" x={f1(nx)} y="14" textAnchor="middle">NOW {clock(now)}</text>
            </g>
          )}
        </svg>
      </div>
      {(nextLine || onResetsToggle) && !updating && (
        <div className="next-resets px-3.5 pb-1" data-testid="next-resets">
          <span className="grp">NEXT RESETS</span>
          {(nextLine || []).map((r, i) => (
            <React.Fragment key={r.seat}>
              {i > 0 && <span className="sep" aria-hidden="true"> · </span>}
              <span className={`nr nr-${r.tone}`} data-seat={r.seat}>{r.text}</span>
            </React.Fragment>
          ))}
          {!showResets && <span className="sep">hidden</span>}
          {onResetsToggle && (
            // M8: the resets switch sits with the resets it switches, not in the range bar.
            <label className="resets-toggle" data-testid="ribbon-resets-toggle">
              <input type="checkbox" checked={showResets} onChange={onResetsToggle} /> show resets
            </label>
          )}
        </div>
      )}
      {gaps.length > 0 && (
        <p className="norec-line m-0 px-3.5 pb-1" data-testid="ribbon-gaps">
          Not recorded in this window:{' '}
          {gaps.map((g, i) => (
            <React.Fragment key={`${g.source}-${i}`}>
              {i > 0 && ' · '}
              <span data-testid="region-notRecorded" data-source={g.source} data-tip={tipText({ kind: 'region', ...g })}>
                {gapWord(g.source)}{g.why ? ` (${g.why})` : ''}
              </span>
            </React.Fragment>
          ))}
        </p>
      )}
      {legend}
      {tip && <div className="rb-tip" role="tooltip" data-testid="ribbon-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}
