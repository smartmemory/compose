import React, { useEffect, useRef, useState } from 'react';
import {
  axisTicks, causePhrase, clock, etaLabel, fmtDur, isLive, layoutLanes, seatShort, tipText, toMs, when, windowTitle, xOf,
} from './ribbonLayout.js';

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
const CAUSE_TEXT_CLASS = { review: 'w-review', owner: 'w-owner', quota: 'w-quota', gate: 'w-review', unknown: 'idle' };
const GLYPH = { land: '✓', deploy: '▲', deployFail: '▲', decide: '⚖︎' };

const CSS = `
.day-ribbon{--rb-panel:hsl(var(--card,0 0% 100%));--rb-fg:hsl(var(--foreground));--rb-muted:hsl(var(--muted-foreground));--rb-line:hsl(var(--border));
  --rb-grid:hsl(var(--border)/.6);--rb-future:hsl(var(--muted)/.5);--rb-hover:hsl(var(--muted)/.7);--rb-hl:rgba(37,99,201,.22);
  --rb-work:#55667c;--rb-wait:#b88a3f;--rb-wait-bg:#f5ead6;--rb-you:#ad6a3c;--rb-you-bg:#f4e3d6;--rb-quota:#7a6e96;--rb-quota-bg:#e9e5f1;
  --rb-accent:#2563c9;--rb-alert:#c23e36;--rb-gate:#8a6a2e;--rb-gate-bg:#efe6d2;}
.dark .day-ribbon{--rb-hl:rgba(91,155,255,.28);--rb-work:#8c9db4;--rb-wait:#d2a14f;--rb-wait-bg:#33291a;--rb-you:#d68b58;--rb-you-bg:#38261b;
  --rb-quota:#a698cb;--rb-quota-bg:#262236;--rb-accent:#5b9bff;--rb-alert:#ee6a5f;--rb-gate:#c9a35a;--rb-gate-bg:#2d2616;}
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
.day-ribbon .base{stroke:var(--rb-line)}
.day-ribbon .s-work{fill:var(--rb-work)}
.day-ribbon .s-review{fill:url(#rb-hz-review);stroke:var(--rb-wait);stroke-width:.9}
.day-ribbon .s-owner{fill:url(#rb-hz-owner);stroke:var(--rb-you);stroke-width:.9}
.day-ribbon .s-quota{fill:url(#rb-hz-quota);stroke:var(--rb-quota);stroke-width:.9}
.day-ribbon .s-gate{fill:url(#rb-hz-gate);stroke:var(--rb-gate);stroke-width:.9}
.day-ribbon .s-unknown{fill:url(#rb-hz-unknown);stroke:var(--rb-muted);stroke-width:.9}
.day-ribbon .s-norec{fill:transparent;stroke:var(--rb-muted);stroke-width:1;stroke-dasharray:3 2.5}
.day-ribbon .reg-norec{fill:transparent;stroke:var(--rb-muted);stroke-width:1;stroke-dasharray:3 2.5;pointer-events:none}
.day-ribbon .band-hold{fill:url(#rb-hz-gate);stroke:var(--rb-gate);stroke-width:.8;pointer-events:none}
.day-ribbon .band-outage{fill:var(--rb-alert);fill-opacity:.12;stroke:var(--rb-alert);stroke-width:.8;pointer-events:none}
.day-ribbon .handle{fill:var(--rb-line);cursor:pointer} .day-ribbon .handle.hold{fill:var(--rb-gate)} .day-ribbon .handle.outage{fill:var(--rb-alert)}
.day-ribbon .seg:hover{filter:brightness(1.12)}
.day-ribbon .cur{font-size:12px;fill:var(--rb-fg);font-weight:550}
.day-ribbon .cur.w-review{fill:var(--rb-wait)} .day-ribbon .cur.w-owner{fill:var(--rb-you)} .day-ribbon .cur.w-quota{fill:var(--rb-quota)}
.day-ribbon .cur.idle{fill:var(--rb-muted);font-weight:400}
.day-ribbon .nxt,.day-ribbon .eta{font-size:11.5px;fill:var(--rb-muted)}
.day-ribbon .eta .d,.day-ribbon .eta-prev{fill:var(--rb-accent)} .day-ribbon .eta-prev{fill:var(--rb-muted)}
.day-ribbon .empty-t{font-size:12px;fill:var(--rb-muted)}
.day-ribbon .tk-gap{stroke:var(--rb-panel);stroke-width:2.2}
.day-ribbon .tk{font-size:12px;fill:var(--rb-fg)} .day-ribbon .tk.decide{fill:var(--rb-accent);font-size:13px}
.day-ribbon .tk.deployFail{fill:var(--rb-alert)} .day-ribbon .tk.alert{fill:var(--rb-alert);font-size:13px}
.day-ribbon .cl-bg{fill:var(--rb-accent)} .day-ribbon .cl-n{font-size:11px;fill:#fff;font-weight:700}
.day-ribbon .hit{fill:transparent}
.day-ribbon .lane,.day-ribbon .mark,.day-ribbon .idle-row,.day-ribbon .pin,.day-ribbon .band-h{cursor:pointer;outline:none}
.day-ribbon .row-bg{fill:transparent;stroke:transparent}
.day-ribbon .lane:hover .row-bg,.day-ribbon .idle-row:hover .row-bg{fill:var(--rb-hover)}
.day-ribbon .lane:focus-visible .row-bg,.day-ribbon .idle-row:focus-visible .row-bg{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .mark:focus-visible .hit,.day-ribbon .pin:focus-visible .hit,.day-ribbon .band-h:focus-visible .handle{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .idle-t{font-size:12px;fill:var(--rb-muted);font-weight:600}
.day-ribbon .pin-t{font-size:11.5px;fill:var(--rb-muted)} .day-ribbon .pin-t.hot{fill:var(--rb-alert)}
.day-ribbon .pin-g{font-size:12px;fill:var(--rb-accent)} .day-ribbon .pin-t.hot .pin-g{fill:var(--rb-alert)}
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
  const hatch = (id, size, angle, bg, line) => (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform={`rotate(${angle})`}>
      <rect width={size} height={size} style={{ fill: bg }} /><line x1="1" y1="0" x2="1" y2={size} style={{ stroke: line, strokeWidth: 2 }} />
    </pattern>
  );
  return (
    <defs>
      {hatch('rb-hz-review', 5, 45, 'var(--rb-wait-bg)', 'var(--rb-wait)')}
      {hatch('rb-hz-owner', 4, 45, 'var(--rb-you-bg)', 'var(--rb-you)')}
      {hatch('rb-hz-quota', 5, -45, 'var(--rb-quota-bg)', 'var(--rb-quota)')}
      {hatch('rb-hz-gate', 6, 0, 'var(--rb-gate-bg)', 'var(--rb-gate)')}
      {hatch('rb-hz-unknown', 5, 45, 'transparent', 'var(--rb-muted)')}
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

/** The span a lane's current unit sits in at `now` (work or wait), else null. */
function currentSpan(lane, nowMs) {
  return (lane.spans || []).find((s) => s.kind !== 'notRecorded' && toMs(s.start) <= nowMs && toMs(s.end) >= nowMs - 120_000) || null;
}

export default function DayRibbon({
  data, from, to, now, seats = [], alerts = [], idleOpen = false, onIdleToggle, onLaneOpen, onMarkOpen, onPinOpen, onBandOpen,
  flashLane = null,
}) {
  const [tip, setTip] = useState(null);
  const [flashing, setFlashing] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!flashLane) return undefined;
    setFlashing(flashLane);
    timer.current = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(timer.current);
  }, [flashLane]);

  const lanes = data?.lanes || [];
  const live = isLive(from, to, now);
  const nowMs = toMs(now);
  const X = (t) => R.X0 + xOf(t, from, to, TRACK);
  const nx = X(now);
  const inWindow = (t) => toMs(t) >= toMs(from) && toMs(t) <= toMs(to);
  const groups = layoutLanes(lanes, { idleOpen, seats });
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

  // AHEAD row: pins in the window, off-window pins at the right edge, and alerts with no lane.
  const aheadItems = [];
  pins.forEach((p) => {
    if (toMs(p.at) > toMs(to)) aheadItems.push({ pin: p, off: true });
    else if (inWindow(p.at)) aheadItems.push({ pin: p, x: X(p.at) });
  });
  const orphanAlerts = alerts.filter((a) => !alertLane(a) && a.since && inWindow(a.since));
  const lineEnds = [];
  aheadItems.filter((i) => !i.off).sort((a, b) => a.x - b.x).forEach((i) => {
    let line = lineEnds.findIndex((end) => i.x >= end);
    if (line < 0) { line = lineEnds.length; lineEnds.push(0); }
    i.line = line;
    lineEnds[line] = i.x + 12 + i.pin.label.length * 6.4 + 10;
  });
  let offLine = lineEnds.length;
  aheadItems.filter((i) => i.off).forEach((i) => { i.line = offLine; offLine += 1; });
  const hasAhead = aheadItems.length > 0 || orphanAlerts.length > 0;
  const aheadLines = Math.max(1, lineEnds.length + aheadItems.filter((i) => i.off).length);
  const aheadY = lanesEnd + 6;
  const H = hasAhead ? aheadY + 12 + aheadLines * 17 + 8 : lanesEnd + 8;

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
    const sp = live && cur ? currentSpan(lane, nowMs) : null;
    const waiting = sp?.kind === 'wait' ? sp : null;
    const avail = R.X1 - nx;
    const empty = !(lane.spans || []).length && !(lane.marks || []).length && !cur;
    const laneAlerts = alerts.filter((a) => alertLane(a) === lane.lane && a.since && inWindow(a.since));
    const eta = live && cur ? lane.eta : null;
    const onAnswer = waiting?.cause === 'owner';
    const next = live ? (lane.next || []) : [];
    const nextTitles = next.map((n) => n.title || n.id);
    return (
      <g key={`${lane.lane}-${idle ? 'idle' : 'row'}`} className={`lane${idle ? ' lane-idle' : ''}${flashing === lane.lane ? ' rb-flash' : ''}`}
        data-testid={`lane-${lane.lane}`} data-lane={lane.lane} tabIndex={0} role="button" aria-label={`${lane.lane} lane details`}
        onClick={() => onLaneOpen && onLaneOpen(lane)} onKeyDown={activate(() => onLaneOpen && onLaneOpen(lane))}>
        <rect className="row-bg" x="2" y={ry + 1} width={R.W - 4} height={R.RH - 2} rx="5" />
        <text className="lname" x="12" y={ry + 20}>{lane.lane}</text>
        <text className="lseat" x={R.X0 - 10} y={ry + 20} textAnchor="end">{seatShort(lane.seat)}</text>
        <line className="base" x1={R.X0} x2={live ? nx : R.X1} y1={mid} y2={mid} />
        {(lane.spans || []).map((s, i) => {
          const x0 = clampX(X(s.start));
          const x1 = clampX(X(s.end));
          const cls = s.kind === 'work' ? 's-work' : s.kind === 'wait' ? (SPAN_CLASS[s.cause] || 's-unknown') : 's-norec';
          return (
            <rect key={i} className={`seg ${cls}`} data-testid={`span-${s.kind}`} x={f1(x0)} y={ry + 11} width={f1(Math.max(1.5, x1 - x0 - 0.8))} height="10" rx="2"
              data-tip={laneTip(lane, s)} />
          );
        })}
        {empty && (
          <text className="empty-t" data-testid="lane-empty" x={R.X0 + 8} y={ry + 20}>
            {covered ? 'nothing in this window' : 'not recorded in this window'}
          </text>
        )}
        {(lane.marks || []).filter((m) => inWindow(m.at)).map((m, i) => {
          const x = f1(X(m.at));
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
          <text key={`a${i}`} className="tk alert" data-testid="alert-mark" x={f1(X(a.since))} y={ry + 9} textAnchor="middle"
            data-tip={tipText({ kind: 'alert', ...a, now })}>⚠</text>
        ))}
        {live && cur && avail >= 120 && (
          <text className={`cur ${waiting ? (CAUSE_TEXT_CLASS[waiting.cause] || 'idle') : ''}`} data-testid="current" x={nx + 10} y={ry + 20}
            data-tip={tipText({ kind: 'current', ...cur, cause: waiting ? (waiting.cause || 'unknown') : null, now })}>
            {waiting ? `${causePhrase(waiting.cause)} ${fmtDur(nowMs - toMs(cur.since))}` : trunc(cur.title || cur.id, 27)}
          </text>
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
            <text className="eta" data-testid="eta" x={R.X1} y={ry + 20} textAnchor="end"
              data-tip={tipText({ kind: 'eta', p50: eta.p50, asOf: eta.asOf, now })}>
              <tspan className="d">◆</tspan> ETA {inWindow(eta.p50) ? etaLabel(eta.p50, now) : `${etaLabel(eta.p50, now)} ▸`}
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
  const bandH = Math.max(0, lanesEnd - bandY);
  const legend = (
    <div className="legend px-3.5 pb-2 pt-1" data-testid="ribbon-legend">
      <span><Swatch cls="s-work" />working</span>
      <span><Swatch cls="s-review" />waiting</span>
      <span><Swatch cls="s-owner" />waiting on you</span>
      <span><Swatch cls="s-norec" />not recorded</span>
      <span>✓ landed</span><span>▲ deployed</span><span>⚖︎ decided for you</span>
      <span><span style={{ color: 'var(--rb-accent)' }}>│</span> now</span>
    </div>
  );

  return (
    <div className="day-ribbon flex h-full min-h-0 flex-col rounded-xl border border-border bg-card" data-testid="day-ribbon"
      onMouseOver={onOver} onMouseMove={onOver} onMouseOut={() => setTip(null)} onFocus={onFocusIn} onBlur={() => setTip(null)}>
      <style>{CSS}</style>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3.5 pt-2.5">
        <h3 className="m-0 text-[11px] font-bold uppercase tracking-[0.09em] text-muted-foreground" data-testid="ribbon-title">{windowTitle(from, to, now)}</h3>
        <span className="text-[11.5px] text-muted-foreground" data-testid="ribbon-fresh">
          as of {clock(data?.asOf || now)}{data?.coverage?.label ? ` · ${data.coverage.label}` : ''}
        </span>
      </div>
      <svg className="min-h-0 w-full flex-1" viewBox={`0 0 ${R.W} ${H}`} role="img" aria-label={`Day ribbon: one row per lane, ${when(from, now)} to ${when(to, now)}`}>
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
        <text className="ax" x="12" y="14">LANE</text>
        <text className="ax" x={R.X0} y="14">{when(from, now)}</text>
        <text className="ax" x={R.X1} y="14" textAnchor="end">{when(to, now)}</text>

        {rows.map((r, i) => {
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
        })}

        {regions.map((g, i) => {
          if (!(toMs(g.end) > toMs(from) && toMs(g.start) < toMs(to))) return null;
          const x0 = clampX(X(g.start));
          const x1 = clampX(X(g.end));
          const t = tipText({ kind: 'region', ...g });
          return (
            <g key={`r${i}`} data-testid="region-notRecorded">
              <rect className="reg-norec" x={f1(x0)} y={lanesTop} width={f1(Math.max(1.5, x1 - x0))} height={Math.max(0, lanesEnd - lanesTop)} rx="3" />
              <rect className="handle" x={f1(x0)} y={bandY + 12} width={f1(Math.max(1.5, x1 - x0))} height="4" data-tip={t} />
            </g>
          );
        })}

        {bands.map((b, i) => {
          const end = b.end || to;
          if (!(toMs(end) > toMs(from) && toMs(b.start) < toMs(to))) return null;
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
            {aheadItems.map((it, i) => {
              const p = it.pin;
              const ly = aheadY + 14 + it.line * 17;
              const glyph = p.kind === 'seatReset' ? '↻' : '◇';
              const t = tipText({ ...p, now });
              return (
                <g key={`p${i}`} className="pin" data-testid={`pin-${p.kind}`} data-tip={t} tabIndex={0} role="button" aria-label={t.replace('\n', ' ')}
                  onClick={cb(onPinOpen, p)} onKeyDown={activate((e) => onPinOpen && onPinOpen(p, rectOf(e)))}>
                  <rect className="hit" x={it.off ? R.X1 - 12 - p.label.length * 6.4 - 20 : it.x - 4} y={ly - 13} width={it.off ? p.label.length * 6.4 + 32 : p.label.length * 6.4 + 24} height="17" />
                  <text className={`pin-t${p.atGate ? ' hot' : ''}`} x={it.off ? R.X1 : f1(it.x + 3)} y={ly} textAnchor={it.off ? 'end' : 'start'}>
                    <tspan className="pin-g">{glyph}</tspan> {p.label}{it.off ? ' ▸' : ''}
                  </text>
                </g>
              );
            })}
            {orphanAlerts.map((a, i) => (
              <text key={`oa${i}`} className="tk alert" data-testid="alert-mark" x={f1(X(a.since))} y={aheadY + 14} textAnchor="middle" data-tip={tipText({ kind: 'alert', ...a, now })}>⚠</text>
            ))}
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
      {legend}
      {tip && <div className="rb-tip" role="tooltip" data-testid="ribbon-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}
