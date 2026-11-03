# Day view design audit (OWNER 2026-11-03 via s1-chat: "we still [need] a better Day view UI ... dispatch all 4 in parallel then merge the results")

Target: the Compose cockpit Day view (ribbon), live at http://127.0.0.1:5195/?view=day (port 5195, registered to compose, pid is node). Source: `~/reg/my/forge/compose/src/components/ribbon/` (DayView.jsx, DayRibbon.jsx, RangeBar.jsx, lane/, marks/, meter/, now/ incl. DayPhone.jsx and NowDrawer.jsx; ~1572 lines), server feed `server/ribbon-routes.js` (`/api/ribbon`). Context docs: `docs/cockpit.md`, `docs/design/`.

Four auditors run in parallel, one skill each, READ-ONLY (no source edits, no commits, nothing deployed). Each writes ONE report to this folder:
- `impeccable.md`  (skill: impeccable, audit + critique mode: hierarchy, IA, cognitive load, states, spacing, type, color, motion, copy, accessibility, responsive)
- `dataviz.md`     (skill: dataviz: every chart, meter, KPI tile, timeline and ribbon mark: form, palette, legend, axis, tooltip, light/dark)
- `artifact-design.md` (skill: artifact-design fundamentals applied to this screen: type pairing, tokens and both themes, layout/spacing, responsive at 400px)
- `design-taste.md` (skill: design-taste-frontend: house-style no-slop check and art direction, applied as far as it fits an app screen; say plainly where it does not fit)

Method, every auditor: load your skill FIRST. Capture the live screen with the Playwright MCP (mcp__playwright__browser_navigate / browser_take_screenshot / browser_snapshot; resize to 1440x900 and 400x800) and save PNGs into this folder as `<skill>-1440.png` and `<skill>-400.png`. Read the component source. Do NOT start, stop or restart any server; if 5195 is down, say so and audit from source only.

Report format (so the merge can be mechanical):
```
# <skill> audit of the Day view (2026-11-03)
## What the screen is for (2 lines, your reading)
## Findings
| # | Severity (HIGH/MED/LOW) | Area | Finding (what is wrong, where: file:line or element) | Fix (concrete) | Effort (S/M/L) |
## Three things it does well
## One-paragraph direction
```
Severity: HIGH = the owner cannot read the state of the day at a glance / wrong or misleading; MED = slows reading or looks unconsidered; LOW = polish. Max 20 findings. No em dashes, no semicolons in the report. Finish within 40 minutes; small tool output (no full-file dumps into the report).
