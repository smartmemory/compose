/**
 * dayRibbonCss.js — the Day ribbon's stylesheet (moved out of DayRibbon.jsx in COMP-DAYVIEW-DESIGN-FIX-1 U2).
 *
 * U2 M11: two sizes only, the type tokens in `src/index.css` (`--type-label` 11 px for caps labels, axis and legend,
 * `--type-body` 13 px for lane names and every word about a lane); numbers in tabular figures. U2 M12: the state colors
 * (`--rb-*`) live in `src/index.css` beside the app tokens, each with a darker text tone where light mode needs 4.5:1.
 */
export const FLASH_MS = 1500;

export const RIBBON_CSS = `
.day-ribbon{--rb-panel:hsl(var(--card,0 0% 100%));--rb-fg:hsl(var(--foreground));--rb-muted:hsl(var(--muted-foreground));--rb-line:hsl(var(--border));
  --rb-grid:hsl(var(--border)/.6);--rb-future:hsl(var(--muted)/.5);--rb-hover:hsl(var(--muted)/.7);--rb-you:hsl(var(--needs-you));
  --rb-label:var(--type-label,11px);--rb-body:var(--type-body,13px);font-variant-numeric:tabular-nums}
.day-ribbon text{font-family:inherit}
.day-ribbon .ax{font-size:var(--rb-label);fill:var(--rb-muted)}
.day-ribbon .ax-day{font-size:var(--rb-label);fill:var(--rb-fg);font-weight:600}
.day-ribbon .axl{stroke:var(--rb-line)} .day-ribbon .grid{stroke:var(--rb-grid)}
.day-ribbon .future-bg{fill:var(--rb-future)}
.day-ribbon .now-l{stroke:var(--rb-accent);stroke-width:1.6} .day-ribbon .now-dot{fill:var(--rb-accent)}
.day-ribbon .now-t{fill:var(--rb-accent);font-weight:700;font-size:var(--rb-label)}
.day-ribbon .grp{font-size:var(--rb-label);letter-spacing:.09em;fill:var(--rb-muted);font-weight:700}
.day-ribbon .grp-proj{font-size:var(--rb-label);fill:var(--rb-muted);cursor:pointer;outline:none}
.day-ribbon .grp-proj:hover,.day-ribbon .grp-proj:focus-visible{fill:var(--rb-accent);text-decoration:underline}
.day-ribbon .lname{font-size:var(--rb-body);font-weight:650;fill:var(--rb-fg)}
.day-ribbon .lane-idle .lname{font-weight:500;fill:var(--rb-muted)}
.day-ribbon .lseat{font-size:var(--rb-label);fill:var(--rb-muted)}
.day-ribbon .lproj{font-size:var(--rb-label);fill:var(--rb-muted);cursor:pointer;text-decoration:underline dotted}
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
.day-ribbon .own-q{font-size:var(--rb-label);font-weight:800;fill:hsl(var(--background));pointer-events:none}
.day-ribbon .own-now{cursor:pointer;outline:none} .day-ribbon .own-now circle{fill:var(--rb-you)}
.day-ribbon .own-now:focus-visible circle{stroke:var(--rb-fg);stroke-width:2}
.day-ribbon .norec-line{font-size:var(--rb-label);color:var(--rb-muted)}
.day-ribbon .band-hold{fill:url(#rb-hz-gate);fill-opacity:.35;stroke:var(--rb-gate);stroke-width:.8;pointer-events:none}
.day-ribbon .band-outage{fill:var(--rb-alert);fill-opacity:.12;stroke:var(--rb-alert);stroke-width:.8;pointer-events:none}
.day-ribbon .handle{fill:var(--rb-line);cursor:pointer} .day-ribbon .handle.hold{fill:var(--rb-gate)} .day-ribbon .handle.outage{fill:var(--rb-alert)}
.day-ribbon .seg:hover{filter:brightness(1.12)}
.day-ribbon .cur{font-size:var(--rb-body);fill:var(--rb-fg);font-weight:550}
.day-ribbon .cur.stale{fill:var(--rb-muted);font-weight:400}
.day-ribbon .nxt,.day-ribbon .eta{font-size:var(--rb-body);fill:var(--rb-muted)}
.day-ribbon .eta .d{fill:var(--rb-accent)}
.day-ribbon .eta-pin{cursor:pointer;outline:none} .day-ribbon .eta-pin path{fill:var(--rb-accent);stroke:var(--rb-panel);stroke-width:1}
.day-ribbon .eta-pin.prev path{fill:var(--rb-panel);stroke:var(--rb-muted);stroke-width:1.2}
.day-ribbon .eta-pin:focus-visible .hit{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .empty-t{font-size:var(--rb-body);fill:var(--rb-muted)}
.day-ribbon .tk-gap{stroke:var(--rb-panel);stroke-width:2.2}
.day-ribbon .tk{font-size:12px;fill:var(--rb-fg)} .day-ribbon .tk.decide{fill:var(--rb-accent);font-size:13px}
.day-ribbon .tk.deployFail{fill:var(--rb-alert)} .day-ribbon .tk.alert{fill:var(--rb-alert);font-size:13px} .day-ribbon .tk.alert.cleared{fill:var(--rb-muted)}
.day-ribbon .cl-bg{fill:var(--rb-accent)} .day-ribbon .cl-n{font-size:var(--rb-label);fill:#fff;font-weight:700}
.day-ribbon .hit{fill:transparent}
.day-ribbon .axis-hit{fill:transparent;cursor:crosshair;touch-action:none}
.day-ribbon .zoom-sel{fill:var(--rb-hl);stroke:var(--rb-accent);stroke-width:1;pointer-events:none}

.day-ribbon .lane,.day-ribbon .mark,.day-ribbon .idle-row,.day-ribbon .pin,.day-ribbon .band-h{cursor:pointer;outline:none}
.day-ribbon .row-bg{fill:transparent;stroke:transparent}
.day-ribbon .lane:hover .row-bg,.day-ribbon .idle-row:hover .row-bg{fill:var(--rb-hover)}
.day-ribbon .lane:focus-visible .row-bg,.day-ribbon .idle-row:focus-visible .row-bg{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .mark:focus-visible .hit,.day-ribbon .pin:focus-visible .hit,.day-ribbon .band-h:focus-visible .handle{stroke:var(--rb-accent);stroke-width:1.5}
.day-ribbon .idle-t{font-size:var(--rb-body);fill:var(--rb-muted);font-weight:600}
.day-ribbon .pin-t{font-size:var(--rb-label);fill:var(--rb-muted)} .day-ribbon .pin-t.hot{fill:var(--rb-alert)}
.day-ribbon .pin-g{fill:var(--rb-accent)} .day-ribbon .pin-t.hot .pin-g{fill:var(--rb-alert)}
.day-ribbon .rt-l{stroke:var(--rb-accent);stroke-width:1.5} .day-ribbon .rt-t{fill:var(--rb-muted)} .day-ribbon .rt-t.next{fill:var(--rb-fg)}
.day-ribbon .rt-gate .rt-l{stroke:var(--rb-alert)} .day-ribbon .rt-gate .rt-t{fill:var(--rb-alert)}
.day-ribbon .rt-alert .rt-l{stroke:var(--rb-gate)} .day-ribbon .rt-alert .rt-t{fill:var(--rb-gate-ink)}
.day-ribbon .rt-merged .rt-l{stroke-width:2.5}
.day-ribbon .next-resets{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;font-size:var(--rb-label);color:var(--rb-fg)}
.day-ribbon .next-resets .grp{color:var(--rb-muted);letter-spacing:.06em}
.day-ribbon .next-resets .sep{color:var(--rb-muted)} .day-ribbon .next-resets .nr-alert{color:var(--rb-gate-ink)}
.day-ribbon .resets-toggle{display:inline-flex;align-items:center;gap:4px;color:var(--rb-muted);margin-left:auto;cursor:pointer}
.day-ribbon .legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:var(--rb-label);color:var(--rb-muted)}
.day-ribbon .legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.day-ribbon .legend svg{width:22px;height:9px}
.day-ribbon .rb-flash .row-bg{animation:rb-flash ${FLASH_MS}ms ease-in-out 1}
@keyframes rb-flash{0%,100%{fill:transparent}35%{fill:var(--rb-hl)}}
@media (prefers-reduced-motion: reduce){.day-ribbon .rb-flash .row-bg{animation:none;stroke:var(--rb-accent);stroke-width:2}}
.day-ribbon .rb-tip{position:fixed;z-index:60;pointer-events:none;background:hsl(var(--foreground));color:hsl(var(--background));font-size:12px;
  line-height:1.4;padding:6px 9px;border-radius:7px;max-width:280px;white-space:pre-line}
`;
