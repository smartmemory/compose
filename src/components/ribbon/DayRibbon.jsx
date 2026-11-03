import React, { useEffect, useRef, useState } from 'react';
import {
  alertTip, axisTicks, clock, etaWord, fmtDur, gapWord, isLive, laneState, layoutLanes, nextResetsLine, RESET_CHAR_PX, resetTicks, seatShort, tipText, toMs, when, windowTitle, xOf,
} from './ribbonLayout.js';
import { CLUSTER_ABOVE_MS, clusterMarks, MIN_DRAG_MS } from './rangeLogic.js';

/**
 * DayRibbon — one row per lane over any window it is given (COMP-COCKPIT-RIBBON-ROWS-1). A pure drawing: it takes the
 * `/api/ribbon` response (`data`) and the window, draws spans, marks, bands, pins and the right-of-now section, and calls a
 * callback for every click. It fetches nothing and owns no range, popover or page state (RIBBON-RANGE-1, -MARKS-1, -LANE-1,
 * -TOP-1). Look and wording follow the owner-picked mock (`cockpit-mock.html`, Option 1).
 */

const R = { W: 1200, X0: 92, X1: 1188, AX: 46, GH: 22, RH: 28 };
const TRACK = R.X1 - R.X0;
const FLASH_MS = 1500;
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const f1 = (n) => Math.round(n * 10) / 10;
const clampX = (x) => Math.min(R.X1, Math.max(R.X0, x));
const SPAN_CLASS = { review: 's-review', owner: 's-owner', quota: 's-quota', gate: 's-gate', unknown: 's-unknown' };
/** The span class of a lane state (laneState's kind, or its wait cause): the swatch before the NOW text and the legend key. */
const STATE_CLASS = { working: 's-work', stale: 's-stale', ...SPAN_CLASS };
const GLYPH = { land: '✓', deploy: '▲', deployFail: '▲', decide: '⚖︎' };
const CSS = `
.day-ribbon{--rb-panel:hsl(var(--card,0 0% 100%));--rb-fg:hsl(var(--foreground));--rb-muted:hsl(var(--muted-foreground));--rb-line:hsl(var(--border));
  --rb-grid:hsl(var(--border)/.6);--rb-future:hsl(var(--muted)/.5);--rb-hover:hsl(var(--muted)/.7);--rb-hl:rgba(37,99,201,.22);
  --rb-you:hsl(var(--needs-you));--rb-work:#0a7e3a;--rb-wait:#d6bd95;--rb-gate:#9da2a7;--rb-gate-bg:#8b9095;
  --rb-quota:#6f45a0;--rb-quota-bg:#9165bf;--rb-accent:#2563c9;--rb-alert:#c23e36;}
.dark .day-ribbon{--rb-hl:rgba(91,155,255,.28);--rb-work:#5bbd74;--rb-wait:#664a1f;--rb-gate:#878d93;--rb-gate-bg:#757b81;
  --rb-quota:#5e3a91;--rb-quota-bg:#714ca6;--rb-accent:#5b9bff;--rb-alert:#ee6a5f;}
.day-ribbon text{font-family:inherit}
.day-ribbon .ax{font-size:11px;fill:var(--rb-muted)}
.day-ribbon .ax-day{font-size:11px;fill:var(--rb-fg);font-weight:600}
.day-ribbon .axl{stroke:var(--rb-line)} .day-ribbon .grid{stroke:var(--rb-grid)}
.day-ribbon .future-bg{fill:var(--rb-future)}
.day-ribbon .now-l{stroke:var(--rb-accent);stroke-width:1.6} .day-ribbon .now-dot{fill:var(--rb-accent)}
.day-ribbon .now-t{fill:var(--rb-accent);font-weight:700;font-size:11.5px}
.day-ribbon .grp{font-size:11px;letter-spacing:.09em;fill:var(--rb-muted);font-weight:700}
.day-ribbon .lname{font-size:12.5px;font-weight:650;fill:var(--rb-fg)}
.day-ribbon .lane-idle .lname{font-weight:500;fill:var(--rb-muted)}
.day-ribbon .lseat{font-size:11px;fill:var(--rb-muted)}
.day-ribbon .lproj{font-size:11px;fill:var(--rb-muted);cursor:pointer;text-decoration:underline dotted}
.day-ribbon .lproj:hover,.day-ribbon .lproj:focus-visible{fill:var(--rb-accent)}
.day-ribbon .base{stroke:var(--rb-line)}
.day-ribbon .s-work{fill:var(--rb-work)}
.day-ribbon .s-stale{fill:var(--rb-work);fill-opacity:.12;stroke:var(--rb-work);stroke-opacity:.8;stroke-width:1;stroke-dasharray:5 3}
.day-ribbon .s-owner{fill:var(--rb-you)}
.day-ribbon .s-review{fill:var(--rb-wait)}
.day-ribbon .s-quota{fill:url(#rb-hz-quota)}
.day-ribbon .s-gate{fill:url(#rb-hz-gate)}
.day-ribbon .s-unknown{fill:url(#rb-hz-unknown);stroke:var(--rb-muted);stroke-opacity:.5;stroke-width:.6}
.day-ribbon .s-norec{fill:transparent;stroke:var(--rb-muted);stroke-width:1;stroke-dasharray:3 2.5}
.day-ribbon .own-q{font-size:11px;font-weight:800;fill:hsl(var(--background));pointer-events:none}
.day-ribbon .own-now{cursor:pointer;outline:none} .day-ribbon .own-now circle{fill:var(--rb-you)}
.day-ribbon .own-now:focus-visible circle{stroke:var(--rb-fg);stroke-width:2}
.day-ribbon .norec-line{font-size:11.5px;color:var(--rb-muted)}
.day-ribbon .band-hold{fill:url(#rb-hz-gate);fill-opacity:.35;stroke:var(--rb-gate);stroke-width:.8;pointer-events:none}
.day-ribbon .band-outage{fill:var(--rb-alert);fill-opacity:.12;stroke:var(--rb-alert);stroke-width:.8;pointer-events:none}
.day-ribbon .handle{fill:var(--rb-line);cursor:pointer} .day-ribbon .handle.hold{fill:var(--rb-gate)} .day-ribbon .handle.outage{fill:var(--rb-alert)}
.day-ribbon .seg:hover{filter:brightness(1.12)}
.day-ribbon .cur{font-size:12px;fill:var(--rb-fg);font-weight:550}
.day-ribbon .cur.stale{fill:var(--rb-muted);font-weight:400}
.day-ribbon .nxt,.day-ribbon .eta{font-size:11.5px;fill:var(--rb-muted)}
.day-ribbon .eta .d,.day-ribbon .eta-prev{fill:var(--rb-accent)} .day-ribbon .eta-prev{fill:var(--rb-muted)}
.day-ribbon .empty-t{font-size:12px;fill:var(--rb-muted)}
.day-ribbon .tk-gap{stroke:var(--rb-panel);stroke-width:2.2}
.day-ribbon .tk{font-size:12px;fill:var(--rb-fg)} .day-ribbon .tk.decide{fill:var(--rb-accent);font-size:13px}
.day-ribbon .tk.deployFail{fill:var(--rb-alert)} .day-ribbon .tk.alert{fill:var(--rb-alert);font-size:13px} .day-ribbon .tk.alert.cleared{fill:var(--rb-muted)}
.day-ribbon .cl-bg{fill:var(--rb-accent)} .day-ribbon .cl-n{font-size:11px;fill:#fff;font-weight:700}
.day-ribbon .hit{fill:transparent}
.day-ribbon .axis-hit{fill:transparent;cursor:crosshair;touch-action:none}
.day-ribbon .zoom-sel{fill:var(--rb-hl);stroke:var(--rb-accent);stroke-width:1;pointer-events:none}

.day-ribbon .lane,.day-ribbon .mark,.day-ribbon .idle-row,.day-ribbon .pin,.day-ribbon .band-h{cursor:pointer;outline:none}
.day-ribbon .row-bg{fill:transparent;stroke:transparent}
.day-ribbon .lane:hover .row-bg,.day-ribbon .idle-row:hover .row-bg{fill:var(--rb-hover)}
.day-ribbon .lane:focus-visible .row-bg,.day-ribbon .idle-row:focus-visible .row-bg{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .mark:focus-visible .hit,.day-ribbon .pin:focus-visible .hit,.day-ribbon .band-h:focus-visible .handle{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .idle-t{font-size:12px;fill:var(--rb-muted);font-weight:600}
.day-ribbon .pin-t{font-size:11.5px;fill:var(--rb-muted)} .day-ribbon .pin-t.hot{fill:var(--rb-alert)}
.day-ribbon .pin-g{font-size:12px;fill:var(--rb-accent)} .day-ribbon .pin-t.hot .pin-g{fill:var(--rb-alert)}
.day-ribbon .rt-l{stroke:var(--rb-accent);stroke-width:1.5} .day-ribbon .rt-t{fill:var(--rb-muted)} .day-ribbon .rt-t.next{fill:var(--rb-fg)}
.day-ribbon .rt-gate .rt-l{stroke:var(--rb-alert)} .day-ribbon .rt-gate .rt-t{fill:var(--rb-alert)}
.day-ribbon .rt-alert .rt-l{stroke:var(--rb-gate)} .day-ribbon .rt-alert .rt-t{fill:var(--rb-gate)}
.day-ribbon .rt-merged .rt-l{stroke-width:2.5}
.day-ribbon .next-resets{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;font-size:11.5px;color:var(--rb-fg)}
.day-ribbon .next-resets .grp{color:var(--rb-muted);letter-spacing:.06em;font-size:11px}
.day-ribbon .next-resets .sep{color:var(--rb-muted)} .day-ribbon .next-resets .nr-alert{color:var(--rb-gate)}
.day-ribbon .legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--rb-muted)}
.day-ribbon .legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.day-ribbon .legend svg{width:22px;height:9px}
.day-ribbon .rb-flash .row-bg{animation:rb-flash ${FLASH_MS}ms ease-in-out 1}
@keyframes rb-flash{0%,100%{fill:transparent}35%{fill:var(--rb-hl)}}
@media (prefers-reduced-motion: reduce){.day-ribbon .rb-flash .row-bg{animation:none;stroke:var(--rb-accent);stroke-width:2}}
.day-ribbon .rb-tip{position:fixed;z-index:60;pointer-events:none;background:hsl(var(--foreground));color:hsl(var(--background));font-size:12px;
  line-height:1.4;padding:6px 9px;border-radius:7px;max-width:280px;white-space:pre-line}
`;

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
  <svg viewBox="0 0 22 9" aria-hidden="true"><rect x="0.5" y="0.5" width="21" height="8" rx="2" className={cls} /></svg>
);

const activate = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
};
const rectOf = (e) => e.currentTarget.getBoundingClientRect();

/** The legend's entries, in reading order: `[key, swatch class or glyph, words]`. Only the keys drawn this render are shown (M9). */
const LEGEND = [
  ['owner', 's-owner', 'waiting on you'], ['work', 's-work', 'working'], ['stale', 's-stale', 'stale (no stamp in 24h)'],
  ['review', 's-review', 'waiting on review'], ['gate', 's-gate', 'waiting on gate'], ['quota', 's-quota', 'waiting on quota'],
  ['unknown', 's-unknown', 'waiting, cause not recorded'], ['norec', 's-norec', 'not recorded'],
  ['hold', 'band-hold', 'launch hold'], ['outage', 'band-outage', 'outage'],
  ['land', '✓', 'landed'], ['deploy', '▲', 'deployed'], ['deployFail', '▲', 'deploy failed'], ['decide', '⚖︎', 'decided for you'],
  ['cluster', '#', 'events grouped (count)'], ['alert', '⚠', 'alert'], ['eta', '◆', 'expected landing'], ['reset', '│', 'seat reset (AHEAD)'],
  ['now', '│', 'now'],
];

export default function DayRibbon({
  data, from, to, now, seats = [], alerts = [], showResets = true, idleOpen = false, onIdleToggle, onLaneOpen, onMarkOpen, onPinOpen, onBandOpen,
  flashLane = null, onAxisSelect, laneProjects = {}, onProjectOpen, onOwnerOpen,
}) {
  const [tip, setTip] = useState(null);
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  dragRef.current = drag;
  const [flashing, setFlashing] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!flashLane) return undefined;
    setFlashing(flashLane);
    timer.current = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(timer.current);
  }, [flashLane]);

  // Press-and-drag on the time axis draws a selection; release over >= 15 min calls onAxisSelect(fromMs, toMs); Esc cancels.
  const svgX = (clientX) => {
    const r = svgRef.current?.getBoundingClientRect();
    return r && r.width ? clampX(((clientX - r.left) / r.width) * R.W) : NaN;
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
  }, [!drag, from, to, onAxisSelect]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // One state per lane at now (S1), and C3: a lane with an open owner wait leads its group.
  const states = new Map(live ? lanes.map((l) => [l.lane, laneState(l, now)]) : []);
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
    rows.push({ type: 'group', y, label: g.label });
    y += R.GH;
    g.rows.forEach((lane) => { rows.push({ type: 'lane', y, lane }); y += R.RH; });
    if (g.idle) {
      rows.push({ type: 'idle', y, idle: g.idle });
      y += R.RH;
      if (g.idle.open) g.idle.lanes.forEach((lane) => { rows.push({ type: 'lane', y, lane, idle: true }); y += R.RH; });
    }
  });
  const lanesTop = R.AX + 6 + R.GH;
  const lanesEnd = y;

  // AHEAD row (RESETS-COMPACT-1): ONE line of reset ticks. Alerts with no lane are not drawn here any more: the range bar's
  // alert chip carries them (`orphanAlerts` in ribbonLayout.js).
  const alertSeats = alerts.filter((a) => a.seat && !a.cleared).map((a) => a.seat);
  const ahead = showResets ? resetTicks(pins, { from, to, now, trackPx: TRACK, alertSeats }) : { ticks: [], off: [] };
  const nextLine = showResets ? nextResetsLine(pins, { now, alertSeats }) : null;
  const offW = (o) => (o.pin.kind === 'expiry' ? o.label.length * RESET_CHAR_PX + 32 : o.label.length * RESET_CHAR_PX + 38);
  let offX = R.X1;
  const offDraw = [...ahead.off].reverse().map((o) => { const w = offW(o); offX -= w; return { ...o, x: offX, w }; }).reverse();
  const hasAhead = ahead.ticks.length > 0 || offDraw.length > 0;
  const aheadY = lanesEnd + 6;
  const H = hasAhead ? aheadY + 12 + 17 + 8 : lanesEnd + 8;

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
  const laneRow = (lane, ry, idle) => {
    const mid = ry + 16;
    const cur = live ? lane.current : null;
    const st = live ? states.get(lane.lane) : null;
    const waiting = st?.kind === 'wait' ? st : null;
    const stale = st?.kind === 'stale';
    const avail = R.X1 - nx;
    const empty = !(lane.spans || []).length && !(lane.marks || []).length && !cur;
    const laneAlerts = alerts.filter((a) => alertLane(a) === lane.lane && a.since && inWindow(a.since));
    if (laneAlerts.length) drawn.add('alert');
    const eta = live && cur && !stale ? lane.eta : null; // S2: a stale unit has no live estimate
    const openEta = (e) => onMarkOpen && onMarkOpen({ kind: 'eta', lane: lane.lane, p50: eta.p50, p80: eta.p80, asOf: eta.asOf, prev: eta.prev }, rectOf(e));
    const onAnswer = waiting?.cause === 'owner';
    if (eta && !onAnswer && eta.p50) drawn.add('eta');
    const stateCls = st ? STATE_CLASS[st.kind === 'wait' ? st.cause : st.kind] || 's-unknown' : null;
    const curText = !st ? null
      : st.kind === 'wait' ? st.phrase
        : st.kind === 'stale' ? `stale ${fmtDur(nowMs - st.since)} · ${trunc(cur.title || cur.id, 9)}`
          : `${trunc(cur.title || cur.id, 14)}${st.since === null ? '' : ` · ${fmtDur(nowMs - st.since)}`}`;
    const next = live ? (lane.next || []) : [];
    const nextTitles = next.map((n) => n.title || n.id);
    const chip = laneProjects[lane.lane] ?? null;
    return (
      <g key={`${lane.lane}-${idle ? 'idle' : 'row'}`} className={`lane${idle ? ' lane-idle' : ''}${flashing === lane.lane ? ' rb-flash' : ''}`}
        data-testid={`lane-${lane.lane}`} data-lane={lane.lane} tabIndex={0} role="button" aria-label={`${lane.lane} lane details`}
        onClick={() => onLaneOpen && onLaneOpen(lane)} onKeyDown={activate(() => onLaneOpen && onLaneOpen(lane))}>
        <rect className="row-bg" x="2" y={ry + 1} width={R.W - 4} height={R.RH - 2} rx="5" />
        {chip ? (
          <>
            <text className="lname" x="12" y={ry + 13}>{lane.lane}</text>
            {/* COMP-COCKPIT-PROJECT-MODEL-1: the project chip opens that project's graph focused on this lane, never the lane drawer. */}
            <text className="lproj" data-testid={`lane-project-${lane.lane}`} x="12" y={ry + 25.5} role="button" tabIndex={0}
              aria-label={`Open the ${chip.label} graph`} data-tip={`Open the ${chip.label} graph, focused on ${lane.lane}`}
              onClick={(e) => { e.stopPropagation(); onProjectOpen && onProjectOpen(chip); }}
              onKeyDown={(e) => { e.stopPropagation(); activate(() => onProjectOpen && onProjectOpen(chip))(e); }}>{chip.label}</text>
          </>
        ) : <text className="lname" x="12" y={ry + 20}>{lane.lane}</text>}
        <text className="lseat" x={R.X0 - 10} y={ry + 20} textAnchor="end">{seatShort(lane.seat)}</text>
        <line className="base" x1={R.X0} x2={live ? nx : R.X1} y1={mid} y2={mid} />
        {(lane.spans || []).map((s, i) => {
          const x0 = clampX(X(s.start));
          const x1 = clampX(X(s.end));
          // S2: the stale current unit's work is a dashed outline, not a live bar.
          const staleWork = stale && s.kind === 'work' && (s.unit == null || s.unit === cur?.id);
          const cls = s.kind === 'work' ? (staleWork ? 's-stale' : 's-work') : s.kind === 'wait' ? (SPAN_CLASS[s.cause] || 's-unknown') : 's-norec';
          const key = s.kind === 'work' ? (staleWork ? 'stale' : 'work') : s.kind === 'wait' ? (SPAN_CLASS[s.cause] ? s.cause : 'unknown') : 'norec';
          drawn.add(key);
          const w = Math.max(1.5, x1 - x0 - 0.8);
          if (key === 'owner') {
            // C1: the one loud state, full row height with a "?" at its start.
            return (
              <g key={i} className="seg" data-testid="span-wait" data-cause="owner" data-tip={laneTip(lane, s) + (s.laneGuess ? '\nno lane named: shown on this row' : '')}>
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
        {(toMs(to) - toMs(from) > CLUSTER_ABOVE_MS ? clusterMarks(lane.marks || [], { from, to }, TRACK) : (lane.marks || [])).filter((m) => inWindow(m.at)).map((m, i) => {
          const x = f1(X(m.at));
          drawn.add(m.kind);
          const tip2 = tipText({ ...m, now });
          return (
            <g key={`m${i}`} className="mark" data-testid={`mark-${m.kind}`} data-tip={tip2} tabIndex={0} role="button" aria-label={tip2.replace('\n', ' ')}
              onClick={(e) => { e.stopPropagation(); onMarkOpen && onMarkOpen(m, rectOf(e)); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onMarkOpen && onMarkOpen(m, rectOf(e)); } }}>
              <rect className="hit" x={x - 7} y={ry} width="14" height={R.RH} />
              {m.kind === 'cluster' ? (
                <>
                  <rect className="cl-bg" x={x - 9} y={ry + 1} width="18" height="13" rx="6.5" />
                  <text className="cl-n" x={x} y={ry + 11.5} textAnchor="middle">{m.count}</text>
                </>
              ) : (
                <>
                  <line className="tk-gap" x1={x} x2={x} y1={ry + 10} y2={ry + 22} />
                  <text className={`tk ${m.kind}`} x={x} y={ry + 9} textAnchor="middle">{GLYPH[m.kind]}</text>
                </>
              )}
            </g>
          );
        })}
        {laneAlerts.map((a, i) => (
          <text key={`a${i}`} className={`tk alert${a.cleared ? ' cleared' : ''}`} data-testid="alert-mark" x={f1(X(a.since))} y={ry + 9} textAnchor="middle"
            data-tip={alertTip(a, now)}>{a.cleared ? '✓⚠' : '⚠'}</text>
        ))}
        {waiting?.cause === 'owner' && (
          // C3: the marker at NOW on the lane that needs the owner; it opens the inbox, like the WHAT line's chip.
          <g className="own-now" data-testid="owner-now" data-queue={waiting.span.queueId ?? ''} tabIndex={0} role="button"
            aria-label={`Needs you: ${waiting.span.title || lane.lane}`} data-tip={`Needs you · ${waiting.span.title || lane.lane}\nclick to open the question`}
            onClick={(e) => { e.stopPropagation(); onOwnerOpen && onOwnerOpen(waiting.span); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOwnerOpen && onOwnerOpen(waiting.span); } }}>
            <circle cx={f1(nx)} cy={mid} r="8" />
            <text className="own-q" x={f1(nx)} y={mid + 4} textAnchor="middle">?</text>
          </g>
        )}
        {st && avail >= 120 && (
          // K3: the state words in ink, with the state's own swatch before them carrying the color.
          <g data-testid="current" data-state={st.kind === 'wait' ? st.cause : st.kind}
            data-tip={tipText({ kind: 'current', ...(cur || { title: st.span?.title, since: st.span?.since }), cause: waiting ? waiting.cause : null, now })}>
            <rect className={`seg ${stateCls}`} x={f1(nx + 12)} y={ry + 11} width="8" height="10" rx="2" />
            <text className={`cur${stale ? ' stale' : ''}`} x={nx + 24} y={ry + 20}>{curText}</text>
          </g>
        )}
        {stale && (
          <text className="eta" data-testid="eta-stale" x={R.X1} y={ry + 20} textAnchor="end" data-tip="No stamp for this unit in 24 hours: no live estimate">no estimate</text>
        )}
        {live && nextTitles.length > 0 && avail >= 300 && (
          <text className="nxt" data-testid="next" x={nx + 186} y={ry + 20} data-tip={tipText({ kind: 'next', titles: nextTitles })}>
            → {trunc(nextTitles[0], 19)}
          </text>
        )}
        {eta && onAnswer && (
          <text className="eta" data-testid="eta-answer" x={R.X1} y={ry + 20} textAnchor="end" data-tip="Waiting on your answer: no landing estimate until it is given">
            <tspan className="d">◆</tspan> on answer
          </text>
        )}
        {eta && !onAnswer && eta.p50 && (
          <>
            {eta.prev && eta.prev.p50 && inWindow(eta.prev.p50) && toMs(eta.prev.p50) > nowMs && (
              <text className="eta-prev" data-testid="eta-prev" x={f1(X(eta.prev.p50))} y={ry + 20} textAnchor="middle"
                data-tip={tipText({ kind: 'prev', p50: eta.prev.p50, asOf: eta.prev.asOf, now })}>◆</text>
            )}
            <text className="eta" data-testid="eta" x={R.X1} y={ry + 20} textAnchor="end" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              aria-label={`Expected landing, ${lane.lane} lane`}
              data-tip={tipText({ kind: 'eta', p50: eta.p50, asOf: eta.asOf, now })}
              onClick={(e) => { e.stopPropagation(); openEta(e); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openEta(e); } }}>
              <tspan className="d">◆</tspan> ETA {etaWord(eta.p50, now)}{Number.isFinite(toMs(eta.p50)) && !inWindow(eta.p50) ? ' ▸' : ''}
            </text>
          </>
        )}
        {eta && eta.noData && (
          <text className="eta" data-testid="eta-none" x={R.X1} y={ry + 20} textAnchor="end" data-tip={tipText({ kind: 'noEta', raw: eta.raw })}>no estimate</text>
        )}
      </g>
    );
  };

  const bandY = lanesTop - 14;
  // Rows are drawn before the legend is built, so the legend lists exactly what this render drew (M9).
  const rowEls = rows.map((r, i) => {
    if (r.type === 'group') return <text key={`g${i}`} className="grp" x="12" y={r.y + 15}>{r.label}</text>;
    if (r.type === 'lane') return laneRow(r.lane, r.y, r.idle);
    return (
      <g key={`i${i}`} className="idle-row" data-testid="idle-row" tabIndex={0} role="button" aria-expanded={r.idle.open}
        onClick={() => onIdleToggle && onIdleToggle()} onKeyDown={activate(() => onIdleToggle && onIdleToggle())}>
        <rect className="row-bg" x="2" y={r.y + 1} width={R.W - 4} height={R.RH - 2} rx="5" />
        <text className="idle-t" x="12" y={r.y + 19}>{r.idle.n} {r.idle.n === 1 ? 'lane' : 'lanes'} idle {r.idle.open ? '▾' : '▸'}</text>
        {!r.idle.open && (
          <text className="ax" x={R.X0 + 20} y={r.y + 19}>{r.idle.names.join(' · ')}{r.idle.seatNote ? `  ${r.idle.seatNote}` : ''}</text>
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
  const gaps = regions.filter((g) => toMs(g.end) > toMs(from) && toMs(g.start) < toMs(to) && !(data?.sourceErrors || {})[String(g.source).split('.')[0]]);
  const legend = (
    <div className="legend px-3.5 pb-2 pt-1" data-testid="ribbon-legend">
      {LEGEND.filter(([k]) => drawn.has(k)).map(([k, mark, words]) => (
        <span key={k} data-key={k}>
          {mark.startsWith('s-') || mark.startsWith('band-') ? <Swatch cls={mark} />
            : <span style={{ color: k === 'now' || k === 'eta' || k === 'decide' || k === 'cluster' || k === 'reset' ? 'var(--rb-accent)' : k === 'deployFail' || k === 'alert' ? 'var(--rb-alert)' : undefined }}>{mark}</span>}
          {words}
        </span>
      ))}
    </div>
  );

  return (
    <div className="day-ribbon flex h-full min-h-0 flex-col rounded-xl border border-border bg-card" data-testid="day-ribbon"
      onMouseOver={onOver} onMouseMove={onOver} onMouseOut={() => setTip(null)} onFocus={onFocusIn} onBlur={() => setTip(null)}>
      <style>{CSS}</style>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3.5 pt-2.5">
        <h3 className="m-0 text-[11px] font-bold uppercase tracking-[0.09em] text-muted-foreground" data-testid="ribbon-title">{windowTitle(from, to, now)}</h3>
        <span className="text-[11.5px] text-muted-foreground" data-testid="ribbon-fresh">
          as of {clock(data?.asOf || now, now)}{data?.coverage?.label ? ` · ${data.coverage.label}` : ''}
        </span>
      </div>
      <svg ref={svgRef} className="min-h-0 w-full flex-1" viewBox={`0 0 ${R.W} ${H}`} role="group" aria-label={`Day ribbon: one row per lane, ${when(from, now)} to ${when(to, now)}`}>
        <Patterns />
        {live && <rect className="future-bg" x={f1(nx)} y={R.AX - 2} width={f1(R.X1 - nx + 8)} height={H - R.AX + 2} />}
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
        <text className="ax" x={R.X0} y="14">{when(from, now)}</text>
        <text className="ax" x={R.X1} y="14" textAnchor="end">{when(to, now)}</text>

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
              const w = t.label.length * RESET_CHAR_PX + 14;
              return (
                <g key={`p${i}`} className={`pin rt rt-${t.tone}${t.count > 1 ? ' rt-merged' : ''}`} data-testid={`pin-${single ? single.kind : 'seatReset'}`} data-tone={t.tone} data-count={t.count} data-tip={t.tip} tabIndex={0} role="button" aria-label={t.tip.replace(/\n/g, ' ')}
                  onClick={cb(onPinOpen, t.count > 1 ? { kind: 'cluster', at: t.items[0].at, count: t.count, items: t.items } : single)}
                  onKeyDown={activate((e) => onPinOpen && onPinOpen(t.count > 1 ? { kind: 'cluster', at: t.items[0].at, count: t.count, items: t.items } : single, rectOf(e)))}>
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
      {nextLine && (
        <div className="next-resets px-3.5 pb-1" data-testid="next-resets">
          <span className="grp">NEXT RESETS</span>
          {nextLine.map((r, i) => (
            <React.Fragment key={r.seat}>
              {i > 0 && <span className="sep" aria-hidden="true"> · </span>}
              <span className={`nr nr-${r.tone}`} data-seat={r.seat}>{r.text}</span>
            </React.Fragment>
          ))}
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
