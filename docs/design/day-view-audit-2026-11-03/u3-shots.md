# U3 shots: which shot proves which box

COMP-DAYVIEW-DESIGN-FIX-1 U3, 2026-11-03. Live cockpit at `http://127.0.0.1:5195/?view=day`, headless system Chrome, taken by
`u3-shots.cjs` in this folder. The script waits for the WHAT line, a seat meter row and the ribbon (or the phone Now list)
by selector before each shot, never by a sleep, and prints the measurements quoted below. The PNGs are git-ignored and
live beside this file.

- Before: the cockpit serving main `9e4de31b` (17:41 +08:00).
- After: the cockpit restarted from main `e83f0007` (17:46 +08:00).

| Box (merged.md U3 and brief) | Before | After | Shot |
|---|---|---|---|
| 1440: marks are clear shapes at 12 px | 25 text glyphs (`text.tk`), 0 shapes | 0 glyphs, 25 drawn shapes (`[data-shape]`). Legend "landed" and "deployed" are drawn icons | `u3-after-1440-dark.png`, `u3-after-1440-light.png` |
| 1440: the "decided for you" legend item | not in the live window (no decide mark today), before or after | not in the live window. Proven by the test row `AD#16 / DT#17` in `test/ui/dayview-u3.test.jsx` on the fixture's decide mark | test only |
| 1440: one as-of time on screen | two: `as of 17:41` (WHAT) and `as of 17:02 · start stamps on 73% of landings` (ribbon) | one: `as of 17:46` (WHAT). The ribbon shows its own only when its body lags by over 5 min | both 1440 shots |
| 1440: the bottom links read as links | computed color `rgb(148, 163, 184)` dark, `rgb(93, 99, 111)` light, 12 px muted | `rgb(91, 155, 255)` dark, `rgb(37, 99, 201)` light (`--rb-accent`), 13 px | both 1440 shots |
| 400: each Now row has a 12 h strip in the U1 palette | 0 strips for 10 rows | 10 strips for 10 rows | `u3-after-400.png` |
| 400: no sideways scroll | `scrollWidth > innerWidth` false | false | `u3-after-400.png` |
| M14: header strip not clipped at 400 | children start at x = -245, -6, 291 (two cut off the left edge) | x = 12, 65, 291: the counters and pill truncate with an ellipsis, words in the title | `u3-before-400.png` vs `u3-after-400.png` |
| F6: svg excludes a classic scrollbar | box client 1156, border 1156, svg 1156 (macOS overlay scrollbars hide the bug) | the same: not provable in a shot on this Mac. Proven by the `clientWidth` test row | test only |

Not provable in a live shot (no failure was live at the time): the shared source notes (F2, the past-window Now feed, the
partial index) and F4's wording. Each has a DayView-level test row in `test/ui/dayview-u3.test.jsx`.
The dark 1440 after shot shows "Fleet unreadable since 17:46: fleet request timed out after 10s": the fleet poll right
after the restart, drawn by the existing `SourceNote`, not by U3.
