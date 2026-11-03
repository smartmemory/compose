# Day view: merged design audit (2026-11-03)

Sources: `impeccable.md` (IMP), `dataviz.md` (DV), `artifact-design.md` (AD), `design-taste.md` (DT), plus their PNGs. Finding numbers are cited as IMP#1, DV#4 and so on. Line references were re-checked against the current source at merge time (`git log` head for `src/components/ribbon/` is 1879327f). IMP, DV and DT line numbers match the source. Several AD line numbers do not match (AD cites the state tokens at DayRibbon.jsx:21-25, the hatches at :61-62 and the svg at :381, while the source has them at :26-29, :104-107 and :372). This file uses the verified numbers.

## The screen in one paragraph (what it is for, what it does well per the four reports)

The Day view is the owner's five-second read of the fleet: one row per lane over a 36h window, past spans left of a NOW line, the current unit, the next unit and an ETA to its right, an AHEAD row of seat resets, and a seat and money meter below that says whether quota can carry the next few hours. All four auditors agree the form is right (DV "the form is right", DT "the now line is the hinge, a generic ops dashboard would not have it") and that the bones are good: honest unknowns ("not recorded" versus "nothing", a count never shows a false 0, the "start stamps on 85% of landings" coverage note, IMP, DV), one pattern source for bars and legend so they cannot drift (DayRibbon.jsx:95-115, all four), real keyboard and reduced-motion support (IMP, AD), and a phone layout that drops the chart for a readable Now list instead of shrinking it (IMP, AD, DT). The problems are not the visual language. They are state encoding (the one state that needs the owner looks like the routine one), three places where the drawing tells a wrong story, and an SVG that shrinks its own type.

## Consensus HIGH (findings two or more auditors raised, one row each, merged wording, cite which auditors, concrete fix, effort S/M/L)

Rule used: raised by two or more auditors, at least one rated it HIGH, and it meets the brief's HIGH bar (the owner cannot read the state of the day at a glance, or the screen is wrong or misleading).

| # | Finding (merged, with reference) | Auditors | Fix | Effort |
|---|---|---|---|---|
| C1 | "Waiting on you" cannot be told apart from "waiting on review". Dark tokens `--rb-wait:#d2a14f` and `--rb-you:#d68b58` (DayRibbon.jsx:28), light `#b88a3f` and `#ad6a3c` (:26), both 45 degree hatches at 5px vs 4px (:104-105), and `--rb-gate:#c9a35a` is a third amber (:29). Validator: dark ΔE 6.0 normal vision, 3.9 deutan (floor 15), light ΔE 8.7. Legend swatches are equally indistinguishable. | IMP#1, DV#1, AD#2, DT#2 (all HIGH) | Give owner-wait the page's single loud hue (a saturated coral or magenta outside the tan family) as a solid full-height fill with a "?" glyph at its start. Review drops to the quiet treatment in C4. Gate moves to a neutral tone and keeps its 0 degree hatch (:107). Re-run the dataviz validator `--pairs all` on both card surfaces until every pair passes, and check with a CVD simulation. NOW-column state text goes to ink with a small colored glyph before it (DayRibbon.jsx:57, DV#10, see Conflict K3). | S |
| C2 | A dashed "not recorded" box covers the whole lane field for the whole window (`reg-norec`, DayRibbon.jsx:51 and :417). It comes from two source-level regions in `/api/ribbon` (`spend` "no persisted spend series", `expiry` "no reader yet") that describe the meter and resets, not lane activity, yet it uses the exact legend swatch for "not recorded". Read at a glance, none of the day was recorded. | IMP#3, DV#4, DT#1 (HIGH), AD#15 (LOW, same element, untraced) | Never draw a source-level gap over the lane plot. Render each as one plain muted line under the ribbon, or inside the row it belongs to (spend on the meter, expiry on AHEAD). Keep the dashed form only for per-lane `s-norec` spans. | S |
| C3 | The one item that needs the owner is neither drawn nor led. The WHAT line counts "1 waiting on you" from the unit index (now/nowLists.js:84, :133) at the same weight as "72 waiting on review" (cockpit/what/WhatLine.jsx), while the ribbon feed for the same window has zero `owner` spans and zero `decide` marks (DV live count), so no lane can be picked out and the legend's "waiting on you" never appears. The only loud cue is the "1 OWNER QUESTION" pill in the app bar, outside the Day view. | IMP#5, DV#3 (HIGH), AD#2 (part) | Fix the producer first: `server/ribbon-routes.js` emits owner waits from the same index the headline counts (it already reads the owner queue, ribbon-routes.js:68, :83, :157). Add a test that the headline count equals the drawn owner spans. Then lead the screen with it: when above zero, a filled chip in the C1 hue ("1 needs you: <title>") first in the WHAT line that opens the item, the matching lane pinned to the top of its group, and a marker at NOW on that lane. At zero, "Nothing needs you" in muted text. | M |
| C4 | Emphasis is inverted. Working is a low-chroma slate (`--rb-work:#8c9db4`, chroma 0.039, below the floor) that reads as idle, while passive review waits are full-height saturated amber hatches with a stroke (DayRibbon.jsx:45). In the 1440 captures main, hub, setup, trader and most of ops are amber stripes edge to edge, about a third of the plot, so the eye lands on the state nobody can act on. | DV#2 (HIGH), DT#6 (MED) | Working becomes the solid, confident fill. Review becomes a quiet flat low-alpha tan band with no stroke and no hatch, its age printed at NOW. Hatching survives only where it carries meaning (gate). Ships with C1 as one palette change. | M |
| C5 | At 400px the phone meter box is capped at `max-h-[120px] overflow-y-auto` (now/DayPhone.jsx:22). It slices the second row of seat bars in half, and s4 (80%, the hottest seat) and Codex sit behind a nested scroll, so the phone cannot answer "can the seats carry the next hours". | DV#5 (HIGH), IMP#16, AD#13, DT#13 (MED) | Remove the cap and let the collapsed box grow to whole rows. If height must be bounded, show one horizontal 5h bar per seat in a single row with the weekly value in its label (fits in about 110px). See Conflict K8. | S |
| C6 | The headline prints bare question marks at full weight: "? working · 73 waiting on review · ? waiting on you · ? landed since your last visit" (WhatLine.jsx:26, `n === null ? '?' : n`, reason only in `title`), while the cause ("Fleet: unknown", "fleet status unavailable" twice) sits elsewhere. A minute earlier the same line said "1 waiting on you". "? waiting on you" is the one count the owner cannot be left guessing. | DT#3 (HIGH), AD#12 (MED), IMP#19 (LOW) | Keep the never-a-false-0 rule. Replace the bare glyph with the last known value and its age ("1, 4 min ago") in muted tone, or words at the count when there is no prior value ("waiting on you: fleet not reachable, retrying", "landed: no earlier visit recorded"). | S |

Raised HIGH by one auditor inside a consensus group, adjudicated MED here (listed in the MEDIUM table):
- AD#1 (fixed viewBox shrinks type): real and measured (11px labels at about 9.4px), but the state is still readable. It is the enabler for M2, so it leads U2.
- AD#3 (current and next text overprint on the 2.0 row): real, but it affects one lane's title and the tooltip still carries it.

## Single-auditor HIGH (keep or demote with a one-line reason)

| # | Finding | Auditor | Verdict | Fix | Effort |
|---|---|---|---|---|---|
| S1 | Phone and desktop disagree about the same lane. `phoneLines` labels any lane with a `current` unit "working" (now/nowLists.js:129), while the ribbon reads the current span and says "waiting on review 3d 18h" (DayRibbon.jsx:312). Live: main and trader read "working" at 400px (visible in `design-taste-400.png`) and "waiting on review 3d 18h / 9d 22h" at 1440px. | IMP#2 | KEEP. The screen contradicts itself, which is the brief's "wrong or misleading" bar, and the 400 capture confirms it. | One shared `laneState(lane, now)` in ribbonLayout.js, called by both the ribbon text and `phoneLines`. | S |
| S2 | Weeks-old current units are drawn as live work with a fresh ETA. Live: web current since 2026-10-21 (13 days) and bench since 10-27, both a full-width work bar with "ETA in 1h". Working prints no age (only waits get a duration, DayRibbon.jsx:312), so "14 working" overstates real activity. | IMP#4 | KEEP. Stale work shown as live is misleading, and it inflates the headline count. | Print the age on working units ("working 13d"). Past 24h without a stamp, switch the bar to a muted dashed "stale" outline, show "no estimate" instead of an ETA, and exclude it from the working count. | M |

All other single-auditor HIGHs (IMP#5, DV#2, DV#3, DV#5, DT#3) were absorbed into consensus rows C3, C4, C5 and C6. None demoted.

## MEDIUM worth doing (merged, deduped, max 15)

| # | Finding (merged, with reference) | Auditors | Fix | Effort |
|---|---|---|---|---|
| M1 | Fixed `viewBox` 1200 wide (`R.W`, DayRibbon.jsx:14) with default `meet` in a `flex-1` box (:372). At 1440x900 it letterboxes (about 66 to 75px dead each side) and text renders at about 85% (11px labels near 9.4px). The busier the day, the smaller the type. | AD#1 (HIGH, adjudicated MED), IMP#12, DT#8 | ResizeObserver on the container, viewBox width = container width so 1 unit = 1 CSS px, SVG height = computed `H` in px, card scrolls vertically when lanes outgrow it. | M |
| M2 | Current-unit text is truncated at 27 chars at `nx+10` (DayRibbon.jsx:312) and next-unit text sits at a fixed `nx+186` (:318), so long uppercase titles overprint ("SVC-2.0-STAGE-STORAGE-SCOP…" into "→ U0a"). | IMP#6, AD#3 (HIGH, adjudicated MED), DT#4 | Truncate by measured width (`getComputedTextLength`), place next after the measured end plus a gap, drop it when it does not fit. Depends on M1. | S |
| M3 | ETAs: every diamond sits at the right edge `R.X1` whatever its time (DayRibbon.jsx:333-338) on a band with a real time axis, "ETA in 200h" is shown in hours, ETAs show on lanes waiting on review for 9 to 16 days, and the column touches the card edge (12 units from the viewBox edge). | DV#11, DT#5, IMP#7, AD#4, AD#19 (part) | Plot the p50 ◆ at its time when in window (p10-p90 whisker when the data has it), keep right-edge text only for off-window ETAs (the `eta-prev` path at :330 already does in-window placement). Format over 48h as days. Show the wait, not an ETA, on lanes whose current span is a wait (as "◆ on answer" already does, :323). Reserve a gutter for off-window text. | M |
| M4 | Raw system text in the UI: "ceiling unavailable: RuntimeError: timeout after 30s" (meter), "Not drawn: seats is missing (timed out after 30000 ms)" under the ribbon (DayView.jsx:167, :231, via `sourceErrorLines` at :57) while the seat bars draw right below it, and "fleet status unavailable" printed twice. | IMP#10, DV#14, AD#12, DT#11 | One plain, deduplicated line per missing source with the last good read time ("Codex ceiling: last read 10:31, retrying"). Suppress the line for a source that did render, or name exactly what is missing. Exception text goes to the tooltip. | S |
| M5 | Land and deploy glyphs stack into runs ("✓✓✓✓", "▲▲▲") because clustering runs only when the window is longer than `CLUSTER_ABOVE_MS` (DayRibbon.jsx:285, strict `>` against 36h at rangeLogic.js:23), and the default Day window is exactly 36h, so it never clusters. | IMP#14, DV#12 | Cluster by pixel distance (marks closer than about 8 to 10px merge into a count badge) at every window size. | S |
| M6 | A dotted-underlined project chip under every lane name (`.lproj`, DayRibbon.jsx:41, :263), "SmartMemory" on most rows, doubles label height in a 28-unit row so it touches the next lane's name. | IMP#8, AD#5, DT#9, DV#16 (LOW) | Show the project only where it differs from the group majority, or put it on the group header. Keep the click target on hover and focus. | S |
| M7 | AHEAD row draws past resets left of NOW and labels merged ticks "x6", "x4" (`resetTicks`, ribbonLayout.js:330-356, drawn at DayRibbon.jsx:440-460) with no legend entry. | IMP#9, DV#13 | Draw only resets after now. Label merged ticks "3 seats reset" or list seats when two or fewer. Add a legend entry. | S |
| M8 | Range bar and window labels: two `datetime-local` pickers lead (RangeBar.jsx:34-43) in 12-hour locale while everything else is 24-hour, "Resets on" (:53) reads as a status, disabled "Now" looks broken, and the window is stated three to four times (pickers, card title, SVG end labels at DayRibbon.jsx:392-393). | IMP#15, IMP#17, AD#10, AD#11, DT#16 | Presets first, then back and forward. The window as one 24-hour sentence in the card title that opens the pickers on click. Drop the SVG end labels. "Show resets" as a checkbox placed by the AHEAD row. "Live" as an active state instead of a disabled "Now". | M |
| M9 | The legend (DayRibbon.jsx:351-359) omits what is drawn (gate with 10 live spans, unknown with 5, hold and outage bands, cluster badges, the ETA ◆ and ghost ◆, AHEAD ticks) and lists states absent today. | DV#9 | Build the legend from the span and mark kinds present in the current feed, plus fixed entries for ◆ ETA and the reset tick. Ships with C1. | S |
| M10 | Meter: each seat is an unlabeled two-bar pair (5h and weekly, identity by color only), reset countdowns ("1.8h", "4d") read as usage, ok-weekly is green while over-pace is amber (s1 at 52% amber beside s4 at 53% green), the pace tick (CostBars.jsx:51) is unexplained, and the 5h fill is `--primary`, near-black in light (index.css:14) and blue in dark (:54). | DV#6, DV#7, DV#8 | A two-item key ("5h", "week") once per row, "↻" before reset times, one neutral series hue for ok in both windows, amber and red only with an "over pace" word, name the tick "pace", bind fills to chart tokens per theme. Files are in `src/components/cockpit/cost/` and `ribbon/meter/`. | S |
| M11 | Type system: five to six sizes between 9 and 14px half a pixel apart (11, 11.5, 12, 12.5, 13 across DayRibbon.jsx, RangeBar.jsx, DayView.jsx), 43 nodes under 11px, and mono used without a rule with Berkeley Mono first in the stack (tailwind.config.js:73) but not loaded, so a fallback renders. | AD#6, AD#7, DT#7, DT#10, IMP#18 | Three tokens (11px caps labels, 13px body and lane text, 15px WHAT line) plus one display size for the C3 "needs you" figure only. Floor at 11px. Mono for identifiers only (unit IDs, seat and session names), Inter `tabular-nums` for every number. Load the chosen mono or drop Berkeley from the head of the stack. | S |
| M12 | Light theme: neutrals are stock hue-0 greys with no accent (index.css:7-27, AD reading), the ribbon brings a private `--rb-*` palette (DayRibbon.jsx:26-29), and light state text fails contrast (review text `#b88a3f` on white 3.1:1 at about 10px, the alert chip 2.1:1). | AD#8, AD#9 | Move `--rb-*` into index.css beside the app tokens, tint light neutrals toward the slate hue, set light accent and ring to the ribbon blue, split each state color into a fill token and a darker text token in light mode to reach 4.5:1. | M |
| M13 | The ribbon `<svg>` has `role="img"` (DayRibbon.jsx:372) but contains dozens of `role="button"` lanes, marks, pins and ETAs, which `img` makes presentational, so screen readers get one label and none of the controls. | IMP#11 | `role="group"` with the same aria-label, keep per-element roles. | S |
| M14 | Phone list and chrome: each Now line is a run-on sentence with the state buried mid-line, no color, no wait age, ETAs at varying positions, content padding is 12px (`p-3`, DayPhone.jsx:18) under the 16px gutter, and the status strip is clipped at the left ("d · Compose agent: Idle"). | IMP#16, AD#14, AD#19 | Two-line items: state dot in the ribbon colors, lane and state with wait age on line one, ETA right-aligned `tabular-nums`, title on line two. 16px gutter with safe-area insets. Status strip wraps or collapses to the alert count. | S |
| M15 | Loading state is a 550px blank pulsing panel with no words (DayView.jsx:200, label only in `aria-label`), which can last 30s when a source times out. | DT#12 | Draw the axis, lane names and NOW line at once from the last feed, say "updating" in the card header, no pulse. | M |

## Conflicts (where auditors disagree, state both and pick one with a reason)

| # | Topic | Positions | Pick and reason |
|---|---|---|---|
| K1 | How loud review waits stay | IMP#1 and AD#2 keep review as the hatched tan. DV#2 wants a thin baseline or low-alpha band, DT#6 a flat muted tone. | DV and DT. Review is the least actionable state and covers about a third of the plot. A flat low-alpha tan band at full row height keeps the hover target and the hue, and stops competing with owner-wait and working. |
| K2 | Gate color | IMP#1 wants a neutral hatch. DV#1 wants a distinct hue at 135 degrees. | Neutral. Three auditors argue for one loud color, and a fourth warm or bright hue reopens C1. The gate hatch is already 0 degrees (DayRibbon.jsx:107), so angle already separates it from review once the hue is neutral. |
| K3 | Color of owner-state text at NOW | AD#2 wants "your answer" set in the owner color. DV#10 wants all state text in ink with a colored glyph. | DV. Ink text with a glyph also fixes the light-mode contrast failures in M12 and keeps color on marks only. |
| K4 | Bare "?" for unknown counts | IMP praises "a count with no source reads ? and never 0" as a strength. DT#3 rates the bare "?" HIGH. | Both, merged in C6. Keep never-a-false-0, replace the bare glyph with last-known plus age or a word. |
| K5 | What is large in the headline | DT#7 sets all WHAT figures at 28 to 32px. IMP#5 leads with only the owner item. AD#6 sets the WHAT line at 15px. | IMP plus AD. Making "72 waiting on review" huge repeats the inverted emphasis of C4. Only the "needs you" item gets the display size and color, the rest stays at 15px. |
| K6 | The mostly empty future half | IMP#13 shifts the default window to about 18h past and 6h ahead, or replaces the future with a table column. DV#11 and DT#5 put ETA diamonds on the axis to make the future a forecast. | ETAs on the axis (M3), keep the window. Two auditors, smaller change, and a 6h-ahead window would push most ETAs off-window. Revisit IMP#13 after M3 ships. |
| K7 | Mono face | AD#7: mono for identifiers. DT#10: mono for real code only. | AD. Unit IDs and seat names are identifiers and scan better in mono. Both agree numbers move to Inter `tabular-nums`, which is the part that matters. |
| K8 | Phone meter | DV#5: grow to content, or one bar per seat in one row. AD#13 and DT#13: a one-line summary with the grid behind a tap. IMP#16: whole rows or one summary line. | Grow to whole rows (C5). It hides nothing and is the cheapest. The one-line summary drops the seat the owner may care about. |
| K9 | Where the window is edited | AD#10: click the card title. DT#16: a window sentence that opens the inputs. IMP#15: a "Custom…" button. | AD and DT agree in substance: the card title is the 24-hour window sentence and opens the pickers on click (M8). |

## Dropped (LOW or not applicable, one line each, incl. the design-taste items that do not fit an app screen)

- DT#14 tracked uppercase labels (LANES, PRODUCT, AHEAD): the app shell uses the same convention (sidebar "BLOCKED FEATURES", "PROJECTS"), so changing only the Day view makes it inconsistent. App-wide decision or none.
- DT#15 remove borders on the ribbon and meter cards: cards are shared with the rest of the cockpit. Same reason as above.
- DT#17 (part) the 🚀 emoji on the Launch button: app shell, outside `ribbon/`. Note for the shell owner, not this plan.
- DT#7 (part) WHAT figures at 28 to 32px: resolved against it in K5.
- IMP#13 shift the window to 18h past and 6h ahead: deferred by K6.
- AD#15 dashed outline around the lane area: same element as C2, not a separate finding.
- IMP#17 window stated three times: folded into M8.
- AD#17 default theme ignores `prefers-color-scheme` (index.html:2 and :37-43): app shell, and the dark default may be deliberate. Note for the shell owner.
- Design-taste skill rules that do not fit an app screen (DT's own "Where the skill does not fit"): the direction, sector and section-blueprint draw step, `few-pictures`, `no-real-pictures`, `no-footage`, `still-page` and the motion layer, `no-hero`, `first-action`, and the 16 to 20px body size (13px stays the floor for dense rows).
- DT house bans on monospace and tracked caps as hard fails: the skill says they are website taste. Kept only as the M11 face rule.
- The remaining LOWs (DV#17 three clocks, DV#18 hit targets and span gap, DV#19 money popover, AD#16 and DT#17 glyphs, AD#18 link affordance, IMP#18 hit areas, IMP#19 "Moving:" underline, DV#15 phone time strip) are not dropped. They are U3.

## Proposed plan: 3 units in order (U1 = the HIGHs, U2 = the MEDIUMs, U3 = polish), each with scope, files under src/components/ribbon/, acceptance checks (what a 1440 and a 400 screenshot must show), and an effort estimate in hours marked "estimate, no data"

### U1: truthful state at a glance (C1 to C6, S1, S2, plus M9 legend and M13 role because they touch the same lines)

Scope: the new state palette (owner loud and solid, working solid, review quiet, gate neutral), state text in ink with glyphs, legend built from the feed, owner waits emitted by the producer and led in the headline, source-level not-recorded regions off the lane plot, one shared lane-state function, stale working units, the "?" headline copy, the phone meter cap, `role="group"`.

Files: `DayRibbon.jsx` (tokens :26-29, span classes :45-57, patterns :104-107, legend :351-359, svg role :372, not-recorded :410-417, current text :312), `ribbonLayout.js` (new `laneState`), `now/nowLists.js` (:129, use `laneState`), `now/DayPhone.jsx` (:22), `DayView.jsx` (where the not-recorded lines move). Outside `ribbon/`: `server/ribbon-routes.js` (owner spans from the owner queue, the producer fix) and `src/components/cockpit/what/WhatLine.jsx` (:26, the owner chip and last-known values).

Acceptance:
- [ ] 1440: exactly one saturated warm hue on the page, used only for owner-wait, and it is visible both as a lane span and as the first item of the WHAT line when the count is above zero.
- [ ] 1440: working lanes are the most solid fill, review lanes are a quiet flat band with no hatch, and the legend shows only kinds present in the feed.
- [ ] 1440: no dashed box spans the lane field. The spend and expiry gaps appear as plain text outside the plot.
- [ ] 1440: web and bench (or any lane with a current unit older than 24h) show an age and a stale outline, no ETA, and are not counted as working.
- [ ] 400: each Now line shows the same state as its 1440 row (main reads "waiting on review", not "working").
- [ ] 400: every seat bar in the collapsed meter is whole, s4 and Codex visible without an inner scroll.
- [ ] Both: no bare "?" in the WHAT line. Unknown counts show a last-known value with age or a word.
- [ ] Validator passes all state pairs on both card surfaces, and a test asserts the headline owner count equals the drawn owner spans.

Effort: 8 to 12 h (estimate, no data).

### U2: readable at true size (M1 to M8, M10 to M12, M14, M15)

Scope: pixel-true SVG, measured text, ETAs on the time axis, plain error copy, pixel clustering, project chips, AHEAD future-only, range bar reorder and 24-hour window title, meter key and colors, type tokens and face rule, light-theme tokens and contrast, phone list and gutter, loading state.

Files: `DayRibbon.jsx` (:14, :41, :263, :285, :312-343, :372, :392-393, :440-460), `ribbonLayout.js` (`resetTicks` :330-356), `rangeLogic.js` (:23 or retire the window rule for clustering), `RangeBar.jsx` (:34-53), `DayView.jsx` (:57, :167, :200, :231), `meter/RibbonMeterLayer.jsx`, `meter/MeterPopover.jsx`, `now/DayPhone.jsx` (:18), `now/nowLists.js`. Outside `ribbon/`: `src/index.css` (tokens), `tailwind.config.js` (:73), `src/components/cockpit/cost/CostBars.jsx` and `CostMeter.jsx`.

Acceptance:
- [ ] 1440: the ribbon fills its card edge to edge, and lane text measures 13px and labels 11px in DevTools (no scaling).
- [ ] 1440: no overprinted text on any row, the 2.0 row included.
- [ ] 1440: in-window ETAs are diamonds at their time on the axis, no "200h" anywhere (days instead), no ETA on a lane that is waiting.
- [ ] 1440: no RuntimeError or millisecond text on screen, at most one line per missing source.
- [ ] 1440: no stacked glyph runs, AHEAD shows only ticks right of NOW with plain labels.
- [ ] 1440: project chips only where they differ from the group, the window appears once as a 24-hour title.
- [ ] 1440 light: state text and the alert chip reach 4.5:1, and the light theme shows the ribbon blue as its accent.
- [ ] 400: 16px side gutter, status strip not clipped, Now items are two lines with a state dot and right-aligned ETA.
- [ ] Both: during load, the axis and lane names show with an "updating" note instead of a blank panel.

Effort: 10 to 16 h (estimate, no data).

### U3: polish (the LOW list)

Scope: SVG shapes instead of ✓ ▲ ⚖ text glyphs (AD#16, DT#17), 24px hit areas and a 2px span gap (DV#18, IMP#18), one as-of time (DV#17), money popover bars with a peak label and current-hour mark (DV#19), accent links for the two questions at the bottom (AD#18), no underline on "Moving:" (IMP#19), and a 12h state strip beside each phone Now row (DV#15).

Files: `DayRibbon.jsx` (:21 glyphs, :276 span gap, :292 hit widths), `marks/RibbonMarksLayer.jsx`, `meter/MeterPopover.jsx` (:61-64), `DayView.jsx` (:247-248), `now/DayPhone.jsx`. Outside: `src/components/cockpit/what/WhatLine.jsx`.

Acceptance:
- [ ] 1440: the "decided for you" legend item and marks render as clear shapes at 12px, one as-of time on screen, the bottom links read as links.
- [ ] 400: each Now row has a small time strip in the U1 palette, and the page still has no sideways scroll.

Effort: 4 to 6 h (estimate, no data).

## ELI5 TLDR

- All four reviewers agree the day chart is the right idea, the trouble is what it shouts.
- **The one thing that needs you looks almost the same as the routine waiting, and today it is not drawn on the chart at all.**
- Two drawing mistakes tell a false story: a dashed box makes the whole day look unrecorded, and long-stale work is drawn as if it were busy right now.
- The plan is three steps: first make "needs you" the only loud color and fix the false marks, then make the text full size and tidy, then polish.
- The decision: approve the first step so it can be built before the rest.
