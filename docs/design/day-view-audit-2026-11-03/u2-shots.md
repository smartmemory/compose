# COMP-DAYVIEW-DESIGN-FIX-1 U2 shots

Before: live cockpit on `9e5299ca` (2026-11-03 15:44). After: live cockpit restarted on compose `8bfd38e6` (2026-11-03 16:48).
Headless system Chrome (Playwright), 1440x900 and 400x860, `http://127.0.0.1:5195/?view=day`, deviceScaleFactor 1. Nothing clicked.
The PNGs are git-ignored (`.gitignore:6 *.png`); they sit beside this file on the machine that took them.

## DOM measures (the shot script reads them from the page)

| Measure | Before (1440) | After (1440) |
|---|---|---|
| svg box / viewBox | 1156x430 in a 1200x475 viewBox | 1156x499 in a 1156x499 viewBox |
| scale (box / viewBox) | 0.905 | 1 |
| lane name font | 12.5px | 13px |
| current-work font | 12px | 13px |
| axis font | 11px | 11px |
| "200h" anywhere | yes | no (1440 and 400) |
| ETA x positions | six, all at 1188 (the right edge) | one at 1142 (in-window diamond), one past the edge |
| phone side gutter (400) | 12px | 16px |

## Which shot proves which `### U2` box (merged.md)

| Box | Shot | What to look at |
|---|---|---|
| 1440: fills its card, 13px text, 11px labels, no scaling | `u2-after-1440-dark.png` | measures above: scale 1, 13px / 11px |
| 1440: no overprinted text, the 2.0 row included | `u2-after-1440-dark.png` | 2.0 row: "checkout must not let the cust... · 1h 14m" then "ETA in 15h", apart; every row right of NOW reads cleanly |
| 1440: in-window ETAs are diamonds at their time, no "200h", no ETA on a waiting lane | `u2-after-1440-dark.png` | ops: blue diamond at its time with the hollow earlier estimate before it; main, hub, setup, trader (waiting) carry no ETA |
| 1440: no RuntimeError or millisecond text, one line per missing source | both 1440 shots | no source line today (no source missing); the one-line rule is in `test/ui/day-view.test.jsx` |
| 1440: AHEAD only right of NOW, plain labels | `u2-after-1440-dark.png` | AHEAD: "4 seats reset", "max", both right of NOW |
| 1440: project chips only where they differ; the window said once as a 24-hour title | `u2-after-1440-dark.png` | "SmartMemory" once per group; cadence, trader, forge carry their own; title "Lanes · yesterday 18:00 to tomorrow 06:00", no end labels on the axis |
| 1440 light: state text and alert chip 4.5:1, the ribbon blue as accent | `u2-after-1440-light.png` | ratios in report-u2 `## Validator` (every text token 5.17:1 or more); NOW line and ETA diamonds in the ribbon blue |
| 400: 16px gutter, status strip not clipped, Now items two lines with dot and right-aligned ETA | `u2-after-400.png` | gutter 16px; two-line items with dot and ETA. **Status strip still clipped** ("blocked • Compose agent..." cut on the left): it is drawn by `HeaderStatus`, outside U2's files |
| Both: during load, axis and lane names with "updating" | not shot | jsdom row `test/ui/day-ribbon.test.jsx` "U2 M15" |
| D-0043 / F4: seat pairs shaded, bars close, a gap in the pair | `u2-after-400.png` | s1..s4 pairs on shaded bands, `↻` before each reset, key "5h · week · pace · resets in", "over pace" under s1 |

## Gaps in these shots
- Both 1440 shots fired before the WHAT line and the Seats block had loaded (grey placeholder bars), so the seat bars are shown only at 400.
- The 400 status strip is still clipped (above).
